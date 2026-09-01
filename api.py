"""
Enhanced Prompt Editor — API routes
All /epe/prompts/* and /epe/ollama/* endpoints.
"""

import os
import uuid
import re
import json
import base64
import logging
import asyncio
import datetime
import zipfile
import io
import shutil
import subprocess
import aiohttp
import socket
import ipaddress
import errno
import struct
import zlib
import time
import functools
import threading

from concurrent.futures import ThreadPoolExecutor as _EpeThreadPool

from urllib.parse import urlparse

from aiohttp import web
from server import PromptServer
import folder_paths


# ── Import idempotency ───────────────────────────────────────────────────────
# `__init__.py` says out loud that the folder may be called anything. A user
# with the registry package AND a git clone imports api.py under TWO module
# names; a ComfyUI-Manager reload re-imports it a third time — measured per
# re-import: ~13 extra OS threads, one unclosed ClientSession, twelve
# duplicate route entries, and one extra on_cleanup + atexit each. The old
# handlers stay reachable through the router forever.
#
# One shared holder in `sys.modules` under a stable key. Any second import
# reuses the pools and the session, and its @routes decorators become no-ops
# — the router already dispatches to the first import's handlers.
import sys as _epe_sys
import types as _epe_types

_EPE_HOLDER_KEY = "_epe_singleton_state_v1"

if _EPE_HOLDER_KEY in _epe_sys.modules:
    _EPE_HOLDER = _epe_sys.modules[_EPE_HOLDER_KEY]
else:
    _EPE_HOLDER = _epe_types.ModuleType(_EPE_HOLDER_KEY)
    _EPE_HOLDER._registered = False
    _epe_sys.modules[_EPE_HOLDER_KEY] = _EPE_HOLDER

_EPE_ALREADY_REGISTERED = bool(getattr(_EPE_HOLDER, "_registered", False))

# Any re-import is by definition a "we are running again" event — clear a
# stale shutdown flag left by a prior lifecycle. Without this, a test
# harness that recreates the app after firing on_cleanup, or any hot-reload
# orchestrator, would inherit the sticky flag and refuse every request
# permanently. In the normal case (process exits after on_cleanup) this
# reset never runs.
_EPE_HOLDER._epe_closing = False


def _epe_singleton(name, factory):
    """Return the holder's copy of `name`, creating with `factory()` the first
    time. Ensures pools and other stateful objects survive a re-import.

    If the parked value is a ThreadPoolExecutor that has already been shut
    down (a full `_epe_on_shutdown` fired before the re-import), rebuild
    it. Without this, a re-import after shutdown would return a dead pool
    and every subsequent submit would fail with "cannot schedule new
    futures after shutdown" — caught by _epe_guard as a 503, so the plugin
    at least degrades gracefully, but the user has no path back short of a
    process restart.
    """
    val = getattr(_EPE_HOLDER, name, None)
    if val is not None:
        # ThreadPoolExecutor's private `_shutdown` flag is what its own
        # `submit` checks. Cheap probe, and the only reliable indicator —
        # there is no public `is_shutdown()` on the class.
        #
        # NOT while closing. `_epe_on_shutdown` shuts these down deliberately;
        # rebuilding one afterwards hands out a fresh pool of live threads on
        # the way to process exit, and nothing will ever stop it.
        if getattr(val, "_shutdown", False):
            if getattr(_EPE_HOLDER, "_epe_closing", False):
                return val
            val = None
    if val is not None:
        return val
    val = factory()
    setattr(_EPE_HOLDER, name, val)
    # Remember every name we have ever handed out, so shutdown can find a
    # REBUILT pool too. _epe_on_shutdown used to iterate the module-level
    # globals, which still point at whatever the first import created.
    _names = getattr(_EPE_HOLDER, "_epe_singleton_names", None)
    if _names is None:
        _names = []
        _EPE_HOLDER._epe_singleton_names = _names
    if name not in _names:
        _names.append(name)
    return val


# ── Request hardening helpers ────────────────────────────────────────────────
# Universal defaults that close abuse paths without breaking normal setups.

_EPE_MAX_IMAGE_B64 = 50_000_000    # ~37 MB binary image
# What an INLINE base64 upload may be. The one above is a ceiling on a
# downloaded file; this is a ceiling on a request body, which aiohttp's
# client_max_size already bounds far below 400 MB — so the old check could
# never fire, and it ran after the body had been read and decoded anyway.
_EPE_MAX_VIDEO_DATA_B64 = 32_000_000
# Frame extraction walks the container. `targets` is built from METADATA, so a
# file that understates itself put every target inside the first hundred frames
# and the loop then decoded the whole remainder for nothing. These two bound
# the walk from both ends: a declared duration past the first is refused, and
# the second is the backstop for a container that declares nothing at all.
_EPE_MAX_VIDEO_SECONDS = 900       # 15 minutes
_EPE_MAX_DECODE_FRAMES = 100_000


def _epe_resolved_ips(host: str):
    """Resolve a hostname to its IPs. Returns [] on failure."""
    try:
        infos = socket.getaddrinfo(host, None)
        return [ipaddress.ip_address(i[4][0]) for i in infos]
    except Exception:
        return []


_EPE_CGNAT_NET = ipaddress.ip_network("100.64.0.0/10")


def _epe_ip_is_private(ip) -> bool:
    # ipaddress classifies CGNAT space (100.64.0.0/10 — Tailscale, carrier
    # NAT) under none of the flags below, so it slipped past both the
    # pre-check and the connect-time guard. Unwrap IPv4-mapped IPv6 first:
    # the stdlib reports ::ffff:127.0.0.1 and ::ffff:192.168.0.1 as
    # loopback/private, but ::ffff:100.64.0.1 as nothing at all — so an
    # AAAA record was a way around a version-4-only test.
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    # Multicast and IPv6 site-local are classified by none of the flags
    # below, so 239.255.255.250, 224.0.0.1, ff02::1 and fec0::1 all read as
    # PUBLIC and passed the media check. TCP does not reach a multicast group,
    # so nothing exploitable follows today — but this is a guard that is
    # otherwise exhaustive, and the moment anything here speaks UDP it would
    # not be.
    return (ip.is_private or ip.is_loopback or ip.is_link_local
            or ip.is_reserved or ip.is_unspecified or ip.is_multicast
            or getattr(ip, "is_site_local", False)
            or (ip.version == 4 and ip in _EPE_CGNAT_NET))


def _epe_ip_is_local_network(ip) -> bool:
    """An address Ollama could plausibly be on: loopback or a private LAN.

    An ALLOW-list, deliberately separate from _epe_ip_is_private, which is a
    deny-list for the media routes. One predicate was serving both policies at
    opposite polarity, so widening the deny-list — as the multicast fix did —
    silently widened what this accepts too.
    """
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    # Never these, whatever else they test as: `::` and `0.0.0.0` are both
    # is_private, and a multicast group is not a host.
    if ip.is_multicast or ip.is_unspecified:
        return False
    # The ALLOW conditions come first, and is_reserved is NOT among the
    # exclusions, because `ipaddress.ip_address("::1").is_reserved` is True.
    # Testing it first rejected IPv6 loopback — so on any dual-stack machine,
    # where `localhost` resolves to 127.0.0.1 AND ::1 and the caller requires
    # all() of them, the default http://localhost:11434 answered
    # "must point to localhost or a private-network address".
    return bool(ip.is_loopback or ip.is_private
                or (ip.version == 4 and ip in _EPE_CGNAT_NET))


# ── The Ollama destination allow-list ────────────────────────────────────
#
# Loopback needs no configuration. Anything else must be named explicitly, by
# someone with access to the machine, in the environment or in ComfyUI's user
# directory — never over HTTP, because a list a caller can add itself to is not
# a list.
_EPE_ALLOW_ENV = "EPE_OLLAMA_ALLOWED_HOSTS"
_EPE_DEFAULT_OLLAMA_PORT = 11434

# Cached after the first consult. `None` means "not read yet"; the lock stops
# two concurrent requests both seeding the file.
_EPE_ALLOW_CACHE = None
_EPE_ALLOW_LOCK = threading.Lock()

_EPE_CONFIG_README = (
    "Ollama running on another machine? Add each one as host:port in "
    "ollamaAllowedHosts below, then restart ComfyUI. "
    "Example: [\"192.168.1.50:11434\"]. "
    "Leave the list empty to allow only this computer. "
    "EPE never writes to this file again once it exists, so your edits are safe. "
    "Any key EPE does not recognise is ignored, so notes can live here too."
)


def _epe_config_path():
    """<ComfyUI user dir>/epe/config.json, or None if it cannot be located.

    NOT the node's own folder: `custom_nodes/EPE/` is replaced on every update,
    so a user's allow-list would silently vanish and present as "EPE stopped
    seeing my Ollama". The user directory is what survives an update.
    """
    try:
        base = folder_paths.get_user_directory()
        if not base:
            return None
        return os.path.join(base, "epe", "config.json")
    except Exception:
        return None


def _epe_norm_hostport(text, default_port=_EPE_DEFAULT_OLLAMA_PORT):
    """'HOST:PORT' -> 'host:port', or '' if it is not one.

    Accepts a bare host (the default Ollama port is assumed) and bracketed
    IPv6. Rejects anything carrying a scheme, path, credentials or query: an
    entry is a destination, not a URL, and quietly accepting a URL-shaped entry
    would mean the user thinks they listed something they did not.
    """
    try:
        s = str(text or "").strip().lower()
    except Exception:
        return ""
    if not s or "/" in s or "@" in s or "?" in s or "#" in s or "\\" in s:
        return ""
    host = s
    port = default_port
    if s.startswith("["):                       # [::1]:11434
        end = s.find("]")
        if end < 0:
            return ""
        host = s[1:end]
        rest = s[end + 1:]
        if rest:
            if not rest.startswith(":"):
                return ""
            port = rest[1:]
    elif s.count(":") == 1:                     # host:port
        host, port = s.split(":", 1)
    elif s.count(":") > 1:                      # bare IPv6, no brackets
        host = s
    if not host:
        return ""
    try:
        port = int(port)
    except Exception:
        return ""
    if not (0 < port < 65536):
        return ""
    return "%s:%d" % (host, port)


def _epe_seed_config(path):
    """Write the starter config if — and only if — it is not already there.

    Never at import: an `os.makedirs` against a dead mount blocks the whole
    ComfyUI start, which is why this is reached from the first consult and not
    from module scope. Failure is logged and ignored; loopback still works.
    """
    try:
        if os.path.exists(path):
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # x mode: if another process won the race between the exists() above
        # and here, theirs stands and ours raises rather than overwriting it.
        with io.open(path, "x", encoding="utf-8") as fh:
            json.dump({"_readme": _EPE_CONFIG_README,
                       "ollamaAllowedHosts": []}, fh, indent=2)
        logger.info("EPE: wrote starter config to %s", path)
    except FileExistsError:
        pass
    except Exception as exc:                                    # noqa: BLE001
        logger.info("EPE: could not write starter config to %s (%s) — "
                    "Ollama on this machine still works", path, exc)


def _epe_read_allowed_hosts():
    """The allow-list, as a set of 'host:port'. Loopback is not in it — that is
    handled by the address check and needs no configuration.

    NEVER FAILS OPEN. A malformed file, an unreadable directory or a garbage
    env var all leave the list EMPTY, which means loopback-only. It must not be
    possible to widen the allow-list by corrupting the file.
    """
    out = set()
    raw = ""
    try:
        raw = os.environ.get(_EPE_ALLOW_ENV, "") or ""
    except Exception:
        raw = ""
    for part in raw.replace(";", ",").split(","):
        hp = _epe_norm_hostport(part)
        if hp:
            out.add(hp)

    path = _epe_config_path()
    if path:
        _epe_seed_config(path)
        try:
            with io.open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                entries = data.get("ollamaAllowedHosts")
                # A string is a common hand-edit ("192.168.1.50:11434" instead
                # of a list). Accept it rather than silently ignoring the only
                # line the user wrote.
                if isinstance(entries, str):
                    entries = [entries]
                if isinstance(entries, list):
                    for e in entries:
                        hp = _epe_norm_hostport(e)
                        if hp:
                            out.add(hp)
                        elif e not in (None, ""):
                            logger.warning(
                                "EPE: ignoring unusable ollamaAllowedHosts entry %r "
                                "in %s — expected \"host:port\"", e, path)
            else:
                logger.warning("EPE: %s is not a JSON object — ignoring it", path)
        except FileNotFoundError:
            pass
        except Exception as exc:                                # noqa: BLE001
            logger.warning("EPE: could not read %s (%s) — allowing only this "
                           "machine", path, exc)
    return frozenset(out)


def _epe_allowed_ollama_hosts():
    global _EPE_ALLOW_CACHE
    if _EPE_ALLOW_CACHE is not None:
        return _EPE_ALLOW_CACHE
    with _EPE_ALLOW_LOCK:
        if _EPE_ALLOW_CACHE is None:
            _EPE_ALLOW_CACHE = _epe_read_allowed_hosts()
    return _EPE_ALLOW_CACHE


def _epe_allow_hint():
    """What to tell a user whose host was refused. Names the file AND the env
    var, because which one they will reach for depends on how they launch."""
    path = _epe_config_path() or "<ComfyUI>/user/epe/config.json"
    return ("EPE only reaches Ollama on this computer by default. To allow "
            "another machine, add it as \"host:port\" to ollamaAllowedHosts in "
            "%s (or set %s), then restart ComfyUI." % (path, _EPE_ALLOW_ENV))


def _epe_check_ollama_url(url: str) -> str:
    """Ollama must live on localhost, or on a host the machine's owner has
    explicitly allowed. Returns '' if OK, else an error message."""
    try:
        from urllib.parse import urlparse
        u = urlparse(url)
        if u.scheme not in ("http", "https"):
            return "ollamaUrl must be http(s)"
        ips = _epe_resolved_ips(u.hostname or "")
        if not ips:
            return "ollamaUrl host did not resolve"
        # NOT the media predicate negated. That one is a deny-list and has
        # been widened twice; every widening makes something newly ACCEPTABLE
        # here, which is the opposite of what was wanted — multicast became a
        # valid ollamaUrl target the moment it was added there.
        if not all(_epe_ip_is_local_network(ip) for ip in ips):
            return "ollamaUrl must point to localhost or a private-network address"
        # Link-local is 169.254.0.0/16 -- "private" by the test above, but it
        # is also where cloud metadata lives (169.254.169.254) and it is never
        # a real Ollama host.
        if any(ip.is_link_local for ip in ips):
            return "ollamaUrl must not point to a link-local address"
        # THE ALLOW-LIST. Everything above is a deny-list by range and lets any
        # LAN host through; this is the part that names destinations.
        #
        # Loopback needs no entry — it is this machine, which the caller can
        # already reach directly. Anything else must have been listed by
        # someone with access to the machine.
        #
        # NOTE THE ORDER: the range checks above still ran. The allow-list only
        # ever NARROWS — listing a public host does not buy a public fetch.
        if all(ip.is_loopback for ip in ips):
            return ""
        hostport = _epe_norm_hostport(
            "[%s]:%s" % (u.hostname, u.port) if (u.hostname or "").count(":") > 1
            else "%s:%s" % (u.hostname, u.port or _EPE_DEFAULT_OLLAMA_PORT))
        if hostport and hostport in _epe_allowed_ollama_hosts():
            return ""
        return _epe_allow_hint()
    except Exception:
        return "Invalid ollamaUrl"


def _epe_check_media_url(url: str) -> str:
    """Client-supplied media URLs the server will fetch must be public
    http(s) — never internal services or cloud metadata endpoints.
    Returns '' if OK, else an error message."""
    try:
        from urllib.parse import urlparse
        u = urlparse(url)
        if u.scheme not in ("http", "https"):
            return "URL must be http(s)"
        ips = _epe_resolved_ips(u.hostname or "")
        if not ips:
            return "URL host did not resolve"
        if any(_epe_ip_is_private(ip) for ip in ips):
            return "URL resolves to a private/internal address"
        return ""
    except Exception:
        return "Invalid URL"


# ---- Redirect-safe fetching ------------------------------------------------
# _epe_check_media_url validates the URL it is handed, but aiohttp follows
# redirects silently and the hops are never re-checked. A public host answering
# 302 -> http://127.0.0.1:8188/... therefore walked straight past the check.
# _epe_safe_get follows redirects by hand and re-validates every hop.

class _EpeUrlRejected(Exception):
    """A URL, or a redirect it pointed at, failed the media-URL check."""


class _epe_safe_get:
    """session.get() that re-validates each redirect. Same async-with usage."""

    def __init__(self, session, url, max_hops=5, **kwargs):
        self._session = session
        # `params` is folded into the URL here rather than carried in kwargs.
        # A redirect target arrives with its own query string already attached,
        # and handing aiohttp both a query and `params` is not a merge — yarl
        # replaces the query outright — so hop 2 would have re-applied hop 1's
        # parameters to a URL that never asked for them.
        _params = kwargs.pop("params", None)
        if _params:
            from urllib.parse import urlencode, urlsplit, urlunsplit
            _p = urlsplit(url)
            _q = urlencode(list(_params.items()) if hasattr(_params, "items")
                           else list(_params), doseq=True)
            url = urlunsplit((_p.scheme, _p.netloc, _p.path,
                              (_p.query + "&" + _q) if _p.query else _q,
                              _p.fragment))
        self._url = url
        self._max_hops = max_hops
        self._kwargs = kwargs
        self._resp = None

    async def __aenter__(self):
        # `async with` calls __aexit__ only if __aenter__ RETURNS. If it
        # raises — including CancelledError, which the workflow search's
        # wait_for(gather(...)) delivers to five gating lookups on every
        # timeout — __aexit__ never runs, whatever self._resp holds. So the
        # cleanup has to live here.
        try:
            return await self._enter()
        except BaseException:
            _r, self._resp = self._resp, None
            if _r is not None:
                try:
                    await _epe_finish_response(_r, drain=False)
                except BaseException:
                    try:
                        _r.close()
                    except Exception:
                        pass
            raise

    async def _enter(self):
        from urllib.parse import urljoin
        url = self._url
        loop = asyncio.get_running_loop()
        # One budget for the whole chain. Passing the caller's timeout
        # into every hop multiplied the intended ceiling by max_hops, so
        # five slow redirects held a handler and a connection — and, on
        # the video routes, a reserved filename — for ten minutes.
        _t = self._kwargs.get("timeout")
        _total = getattr(_t, "total", None) if _t is not None else None
        _chain_deadline = (loop.time() + _total) if _total else None
        for _hop in range(self._max_hops):
            # _epe_check_media_url resolves DNS synchronously. Called inline it
            # would stall ComfyUI's entire event loop once per hop, so hand it
            # to a thread — ours, and inside the budget. A nameserver that
            # simply never answers can hold getaddrinfo for tens of seconds,
            # which used to blow straight through the route's own ceiling.
            if _chain_deadline is None:
                err = await _epe_dns_check(_epe_check_media_url, url)
            else:
                _dns_left = _chain_deadline - loop.time()
                if _dns_left <= 0:
                    raise asyncio.TimeoutError("redirect chain exceeded the timeout")
                err = await _epe_dns_check(_epe_check_media_url, url, _dns_left)
            if err:
                raise _EpeUrlRejected(err)
            # Assigned the instant it exists, on BOTH branches. It used to be
            # set only after the whole redirect walk finished, so a task
            # cancelled in between — which the workflow search's
            # wait_for(gather(...)) does to five gating lookups on every
            # timeout — never reached __aexit__, and neither release() nor
            # close() ran. CancelledError is a BaseException, so the caller's
            # `except Exception` could not have caught it either.
            if _chain_deadline is None:
                resp = await self._session.get(url, allow_redirects=False, **self._kwargs)
                self._resp = resp
            else:
                _left = _chain_deadline - loop.time()
                if _left <= 0:
                    raise asyncio.TimeoutError("redirect chain exceeded the timeout")
                # Hand aiohttp what is LEFT of the budget, not the whole of
                # it again. Its own timeout machinery does the enforcing;
                # the other fields are carried across unchanged.
                _hop_kwargs = dict(self._kwargs)
                _hop_kwargs["timeout"] = aiohttp.ClientTimeout(
                    total=_left,
                    connect=getattr(_t, "connect", None),
                    sock_connect=getattr(_t, "sock_connect", None),
                    sock_read=getattr(_t, "sock_read", None))
                resp = await self._session.get(url, allow_redirects=False, **_hop_kwargs)
                self._resp = resp
            if resp.status in (301, 302, 303, 307, 308):
                loc = resp.headers.get("Location") or ""
                # Finished here, so __aexit__ must not finish it a second time.
                self._resp = None
                await _epe_finish_response(resp)
                if not loc:
                    raise _EpeUrlRejected("redirect with no Location")
                url = urljoin(url, loc)
                continue
            self._resp = resp
            return resp
        raise _EpeUrlRejected("too many redirects")

    async def __aexit__(self, exc_type, exc, tb):
        if self._resp is not None:
            await _epe_finish_response(self._resp, drain=(exc_type is None))
        return False


# A redirect body is normally empty and a media body is normally fully read by
# the caller, so most of these connections could go straight back to the pool.
_EPE_DRAIN_LIMIT = 64 * 1024


async def _epe_finish_response(resp, drain=True):
    """Return a response's connection to the pool if that is safe, else close.

    `close()` tears the socket down. Every media fetch and every redirect hop
    called it, so the same two or three hosts were re-handshaked (TCP + TLS)
    for every image the browser panel loaded.

    `release()` is only valid once the body is fully consumed — handing back a
    connection with bytes still in flight poisons it for whoever gets it next,
    which shows up as a mangled reply on an unrelated request. So the body is
    drained up to a small ceiling, and the connection is only released when
    `content.at_eof()` confirms there is nothing left. Anything else, including
    any error while draining, falls back to the old close().
    """
    _cancelled = None
    try:
        # BaseException, not Exception: a CancelledError delivered while
        # draining used to skip the close() fallback below and orphan the
        # connection — which is precisely the case this helper exists for.
        if drain and resp.content is not None and not resp.content.at_eof():
            read = 0
            async for _chunk in resp.content.iter_chunked(8192):
                read += len(_chunk)
                if read > _EPE_DRAIN_LIMIT:
                    break
        if resp.content is not None and resp.content.at_eof():
            resp.release()
            return
    except asyncio.CancelledError as _c:
        # Caught so the close below still runs, then RE-RAISED. Swallowing it
        # returned normally to a caller that had been cancelled: the redirect
        # loop in _enter went on to the next hop, so a workflow search whose
        # wait_for timed out left a task still following redirects and holding
        # a connection — defeating the timeout that cancelled it.
        _cancelled = _c
    except BaseException:
        pass
    try:
        resp.close()
    except Exception:
        pass
    if _cancelled is not None:
        raise _cancelled


def _epe_normalize_ollama_url(url: str) -> str:
    """Drop params, query and fragment from a user-supplied Ollama base URL.

    Endpoints are built by concatenation -- f"{base}/api/generate" -- so a base
    ending in '#' or '?x=' swallowed the suffix and let the request land on an
    arbitrary path of a private host. Keeping the path preserves reverse-proxy
    setups such as http://box:8080/ollama; dropping the rest closes the hole.
    """
    # `(url or "")` absorbs only FALSY wrong types — the `or {}` idiom the
    # coercion helpers exist to replace. `{"ollamaUrl": 1}` reached .strip()
    # here, OUTSIDE the try below, and escaped five handlers as a 500 while
    # every neighbouring field answered 400.
    raw = _epe_s(url).strip()
    try:
        from urllib.parse import urlparse, urlunparse
        u = urlparse(raw)
        if not u.scheme or not u.netloc:
            return raw.rstrip("/")
        # Reconstruct netloc from hostname + port only. `u.netloc` preserves
        # `user:pass@` — the SSRF guards use `u.hostname` and don't see it,
        # but the eventual `f"{base}/api/generate"` sends those credentials
        # as HTTP Basic Auth to Ollama, which will log them. Ollama does
        # not use auth, so this is always garbage the user pasted in by
        # mistake. Stripping is safe and prevents a credential leak into
        # whichever machine's log file the server writes to.
        #
        # IPv6: u.hostname strips the brackets from [::1] and returns "::1".
        # Reassembling as "::1:11434" is ambiguous (three colons) and every
        # HTTP client and re-parse will reject it. Put the brackets back
        # when the hostname contains a colon.
        _host = u.hostname or ""
        if ":" in _host:
            _host = "[" + _host + "]"
        _netloc = _host
        if u.port is not None:
            _netloc = "{0}:{1}".format(_host, u.port)
        return urlunparse((u.scheme, _netloc, u.path, "", "", "")).rstrip("/")
    except Exception:
        return raw.rstrip("/")


# ── Civitai download gating ──────────────────────────────────────────────────
# A creator can require downloaders to be logged in. That flag is exposed ONLY
# on /api/v1/model-versions/mini/{id} — not on /models or /model-versions — and
# without it there is no way to know a workflow is unreachable until the
# download already failed. Cached for the process lifetime: a creator's choice
# does not change mid-session, and search pages repeat heavily while scrolling.
_EPE_REQAUTH_CACHE = {}
_EPE_REQAUTH_MAX    = 5000 # entries; cleared wholesale past this, never unbounded
_EPE_REQAUTH_SEM    = None # bounds concurrent lookups; built on first use
_EPE_WF_MAX_ROUNDS  = 4    # upstream pages to walk per request while filtering
_EPE_WF_MIN_RESULTS = 8    # stop once this many openly-downloadable ones found
_EPE_WF_BUDGET_S    = 25   # wall-clock ceiling for one search, whatever upstream does
_EPE_REQAUTH_TIMEOUT = 6   # per gating lookup
_EPE_MAX_QUERY_CHARS = 512 # of a client-supplied search query
_EPE_MAX_QUERY_TERMS = 16  # each of which becomes one compiled regex


async def _epe_version_requires_auth(session, version_id) -> bool:
    """True when this model version needs a logged-in account to download."""
    key = str(version_id or "")
    if not key:
        return False
    if key in _EPE_REQAUTH_CACHE:
        return _EPE_REQAUTH_CACHE[key]
    global _EPE_REQAUTH_SEM
    if _EPE_REQAUTH_SEM is None:
        # A page of 20 results would otherwise open 20 sockets to one host at
        # once, four rounds deep — enough to get rate-limited, which makes the
        # check fail open and put gated cards back in the list.
        _EPE_REQAUTH_SEM = asyncio.Semaphore(5)
    try:
        async with _EPE_REQAUTH_SEM, _epe_safe_get(
            session,
            f"https://civitai.com/api/v1/model-versions/mini/{key}",
            headers={"Accept": "application/json",
                     "User-Agent": "ComfyUI-Enhanced-Prompt-Editor"},
            timeout=aiohttp.ClientTimeout(total=_EPE_REQAUTH_TIMEOUT),
        ) as r:
            if r.status != 200:
                return False          # unknown — let the download decide
            d = await _epe_json_capped(r)
            if not isinstance(d, dict):
                return False          # empty/odd body — let the download decide
    except Exception:
        return False                  # never let this check break a search
    gated = bool(d.get("requireAuth")) or bool(d.get("checkPermission"))
    if len(_EPE_REQAUTH_CACHE) >= _EPE_REQAUTH_MAX:
        _EPE_REQAUTH_CACHE.clear()
    _EPE_REQAUTH_CACHE[key] = gated
    return gated


# ── Bounded reads ────────────────────────────────────────────────────────────
# Nothing here trusts Content-Length: aiohttp decompresses transparently, so a
# small gzip response can expand without limit. Count what is actually handed
# to us and stop.
_EPE_MAX_FETCH_BYTES = 64 * 1024 * 1024    # images / workflow files, into RAM
# json.loads is one C call and holds the GIL, so the pool does NOT protect the
# event loop from a large document — a 16 MB JSON freezes it 0.7 s, a 32 MB
# one 2.4 s. Every real EPE JSON reply (Civitai/Genur search pages, Ollama
# check, workflow detail) is well under 1 MB; 4 MB is 4x realistic headroom
# and caps the worst freeze at ~0.2 s. A page that legitimately needs more
# would already be pathological and should be rejected.
_EPE_MAX_JSON_BYTES  = 8  * 1024 * 1024    # decompressed JSON from a public host
# 8 MB, not 4. This and _EPE_MAX_UPSTREAM_ITEMS guard different things — parse
# time, and the outbound gating requests one page can turn into — and at 4 MB
# the byte cap fired FIRST, so the item cap could never run and round 32's
# contract ("an oversized page is trimmed and still answers 200") became "413,
# and the whole search is discarded".
#
# 4 MB was chosen to hold a json.loads to ~0.2 s. The decode runs in _EPE_POOL,
# so what that bounds is GIL-holding rather than a direct loop stall, and 8 MB
# puts the worst case near 0.4 s while leaving a measured live Civitai page
# (1.05 MB, 55 KB per item) 7.6x of headroom. Still 4x tighter than the 32 MB
# this was before round 46.
_EPE_MAX_VIDEO_BYTES = 512 * 1024 * 1024   # videos, streamed to disk


_EPE_MAX_A1111_SETTINGS = 4000       # a settings line is never near this long


def _epe_looks_like_settings(s):
    """Is this line an A1111 "Key: value, Key: value" settings line?

    The pattern this replaces —

        r'^[A-Za-z][A-Za-z0-9 ]*:\s*[^,]+(,\s*[A-Za-z][A-Za-z0-9 ]*:\s*[^,]+)+$'

    — backtracks EXPONENTIALLY when the match fails, because `\s*` is followed
    by `[^,]+` and a space is a member of both, so each repetition of the group
    can be split two ways. Measured: 14 repeats 0.004s, 18 repeats 0.072s,
    22 repeats 1.128s — 4x per two repeats, so ~250 bytes is minutes and ~320
    bytes is months.

    That input is the last line of a PNG `parameters` chunk, i.e. bytes a
    stranger chose, and this runs in the shared four-worker pool that also
    serves every video write. A C-level regex match cannot be cancelled, so
    once it starts the only way out is restarting ComfyUI.

    This accepts exactly the same strings, in one linear pass: every
    comma-separated part must be `Key: value`, Key matching
    [A-Za-z][A-Za-z0-9 ]*, value non-empty, and there must be at least two
    parts. Differential-fuzzed against the old pattern.
    """
    if not s or len(s) > _EPE_MAX_A1111_SETTINGS:
        return False
    parts = s.split(',')
    if len(parts) < 2:
        return False
    for part in parts:
        c = part.find(':')
        if c <= 0:
            return False
        k = part[:c].strip()
        # NOT stripped: the old `\s*[^,]+` accepts a value that is only a
        # space, and rejecting one here would not merely lose the settings —
        # an unrecognised settings line stays in the body.
        v = part[c + 1:]
        if not k or not v:
            return False
        if not k[0].isascii() or not k[0].isalpha():
            return False
        for ch in k:
            if not (ch == ' ' or (ch.isascii() and ch.isalnum())):
                return False
    return True


def _epe_strip_think(s, _open="<think>", _close="</think>"):
    """Remove <think>...</think> spans in ONE linear pass.

    `re.sub(r"<think>.*?</think>", "", s, flags=re.DOTALL)` is QUADRATIC when
    the tags are unbalanced: `.*?` rescans to the end of the string from every
    opening tag. Measured: 7 KB 0.035s, 14 KB 0.144s, 28 KB 0.547s,
    56 KB 2.208s — 4x per doubling. This runs on ComfyUI's own event loop over
    an Ollama reply whose size nothing caps, so 224 KB is ~34 seconds with the
    entire UI and job queue frozen.

    str.find is linear and cannot backtrack. Accepts exactly what the regex
    accepted, including leaving an unclosed opener (and everything after it)
    in place, which is what the non-greedy pattern did.
    """
    if not s or _open not in s:
        return s
    out = []
    i, n = 0, len(s)
    while i < n:
        a = s.find(_open, i)
        if a < 0:
            out.append(s[i:])
            break
        b = s.find(_close, a + len(_open))
        if b < 0:
            # No closer: the non-greedy pattern matched nothing from here, so
            # the opener and the rest of the string survive untouched.
            out.append(s[i:])
            break
        out.append(s[i:a])
        i = b + len(_close)
    return "".join(out)


def _epe_first_think_body(s, _open="<think>", _close="</think>"):
    """Body of the FIRST complete <think> span, or "".

    Stands in for `re.search(r"<think>(.*?)</think>", ...)`, which has the same
    quadratic shape as the sub above. First, not last — that is what re.search
    did, and this is a fallback for a degenerate reply, not a place to change
    behaviour.
    """
    if not s:
        return ""
    a = s.find(_open)
    if a < 0:
        return ""
    b = s.find(_close, a + len(_open))
    if b < 0:
        return ""
    return s[a + len(_open):b]


_EPE_MAX_HTML_STRIP = 200_000        # chars considered; the callers keep <= 1000


def _epe_strip_tags(s, repl=" ", limit=_EPE_MAX_HTML_STRIP):
    """Remove <...> spans in ONE linear pass, with a hard input ceiling.

    The obvious `re.sub(r'<[^>]+>', ...)` is quadratic on input full of '<':
    the engine tries `[^>]+` from every '<' and walks to the end of the string
    each time. Measured here — 10 KB of '<' 0.05s, 20 KB 0.18s, 40 KB 0.71s,
    80 KB 2.86s — and this runs on ComfyUI's event loop over descriptions that
    a stranger on Civitai wrote. A 500 KB description is minutes of frozen UI.

    str.find is linear and cannot backtrack. The ceiling matters as much as
    the algorithm: every caller truncates to 1000 chars straight afterwards,
    so there is nothing to gain from scanning megabytes.
    """
    if not s:
        return ""
    if len(s) > limit:
        s = s[:limit]
    out = []
    i, n = 0, len(s)
    while i < n:
        lt = s.find("<", i)
        if lt < 0:
            out.append(s[i:])
            break
        out.append(s[i:lt])
        gt = s.find(">", lt + 1)
        if gt < 0:
            # Unclosed '<' — it is literal text, not a tag.
            out.append(s[lt:])
            break
        out.append(repl)
        i = gt + 1
    return "".join(out)


_EPE_SIG_MAX_SOURCE = 4096       # chars of a prompt that can reach the sig
_EPE_SIG_LEN = 120               # unchanged: the signature length itself
_EPE_DEDUP_MAX_COMPARISONS = 20_000
_EPE_SEARCH_MAX_ITEMS_PER_PAGE = 500


class _EpeSigDedupe:
    """Near-duplicate prompt filter. Same answers as the O(n²) scan it
    replaces, without the O(n²).

    The old form was, inline in the search handler:

        if any(_similar(sig, s) for s in seen_sigs): continue
        seen_sigs.append(sig)

    with `_similar` doing `set(a.split()), set(b.split())` on every call — so
    each new item re-split every signature kept so far. Measured on pairwise
    dissimilar prompts, which is exactly what "kept" means: 400 items 0.131 s,
    800 0.527 s, 1600 2.101 s, 3200 8.606 s. Clean ×4 per doubling, inline on
    ComfyUI's event loop, over however many items the upstream page held.

    The index is exact, not a heuristic. Similarity here is

        |a ∩ b| / max(|a|, |b|) >= 0.75

    so a pair that passes must satisfy |a ∩ b| >= 0.75·max >= 0.75 > 0 — it
    must share at least one word. Comparing only against signatures that share
    a word therefore cannot miss a duplicate the full scan would have found.
    Word sets are built once, when a signature is admitted, instead of on every
    comparison.

    The budget covers what the index cannot: thousands of items that all carry
    one common word and are otherwise distinct, where the candidate set is
    everything. Past the budget deduplication stops — items are kept rather
    than compared — and the log says so. Spending the event loop is the worse
    failure.
    """

    __slots__ = ("_sets", "_index", "_budget", "_exhausted")

    def __init__(self, budget=_EPE_DEDUP_MAX_COMPARISONS):
        self._sets = []          # word set per admitted signature
        self._index = {}         # word -> [indices into _sets]
        self._budget = budget
        self._exhausted = False

    @staticmethod
    def signature(text):
        """Fuzzy signature: lowercase, strip lora/embedding tags, collapse
           whitespace, take the first 120 chars of meaningful words.

        Only the first _EPE_SIG_MAX_SOURCE characters are scanned. The old
        version ran three regex passes over the whole prompt and then threw
        all but 120 characters away; prompts arrive from upstream with no
        length limit anywhere in the chain.
        """
        if not text:
            return ""
        if len(text) > _EPE_SIG_MAX_SOURCE:
            text = text[:_EPE_SIG_MAX_SOURCE]
        t = _epe_strip_tags(text.lower(), '')
        t = re.sub(r'[()\[\]{}:0-9._\-]+', ' ', t)
        t = re.sub(r'\s+', ' ', t).strip()
        return t[:_EPE_SIG_LEN]

    def add(self, sig, threshold=0.75):
        """True if `sig` is new — and it is remembered. False if it duplicates
        something already admitted."""
        words = set(sig.split())
        if not words:
            # Unchanged behaviour: `_similar` returned False whenever either
            # side was empty, so an empty signature never matched anything and
            # was always kept.
            return True
        cands = set()
        for w in words:
            ids = self._index.get(w)
            if ids:
                cands.update(ids)
        if cands and not self._exhausted:
            n = len(words)
            for i in cands:
                if self._budget <= 0:
                    self._exhausted = True
                    logger.warning(
                        "epe dedupe: comparison budget exhausted after %d "
                        "signatures; the rest of this page is not deduplicated",
                        len(self._sets))
                    break
                self._budget -= 1
                other = self._sets[i]
                if len(words & other) / max(n, len(other)) >= threshold:
                    return False
        idx = len(self._sets)
        self._sets.append(words)
        for w in words:
            self._index.setdefault(w, []).append(idx)
        return True


# ── Upstream shape coercions ────────────────────────────────────────────────
# The `or {}` / `or []` idiom these replace only absorbs the FALSY wrong types.
# `"metadata": "none"` and `"meta": "n/a"` are truthy, sail through it, and
# raise AttributeError on the next .get() — out of the handler, as a bare 500.
# _epe_json_capped also returns None for a 200 with an empty body, which is the
# single most common shape nobody guarded against.

def _epe_page_number(raw):
    """A page number from the request body, or None.

    `int(raw)` is O(n^2) on CPython 3.10 and older, so `{"page": "9"*1600000}`
    — a 1.6 MB body — was 15.3 s of frozen event loop with the GIL held and no
    way to cancel it. 3.11's int_max_str_digits turns that into a fast
    ValueError, so the exposure is version-gated rather than gone.
    """
    if isinstance(raw, bool):
        return None
    try:
        if isinstance(raw, int):
            n = raw
        elif isinstance(raw, float):
            # `1e999` is plain valid JSON and decodes to inf; `NaN` likewise.
            # int() raises OverflowError and ValueError on those, and both
            # escaped to the handler's 500 tail.
            n = int(raw)
        elif isinstance(raw, str):
            s = raw.strip()
            # No real page number is longer than this, and the length check
            # runs before the conversion — which is the whole point.
            if not s or len(s) > 9:
                return None
            # isascii, because str.isdigit() is True for '²' and a dozen
            # other characters int() will not take; and at most one sign,
            # because '+-5'.lstrip('+-').isdigit() is also True.
            body = s[1:] if s[:1] in "+-" else s
            if not body.isascii() or not body.isdigit():
                return None
            n = int(s)
        else:
            return None
    except (ValueError, OverflowError):
        return None
    return n if 1 <= n <= 100000 else None


async def _epe_json_object(request):
    """The request body as a dict, or None.

    Two failure shapes, one answer. request.json() raises json.JSONDecodeError
    for a body that is not JSON at all, and returns whatever it decoded
    otherwise — so `[]`, `"hi"`, `3` and `null` reached the first `body.get()`
    and raised AttributeError. Both landed in the handler's generic tail as
    HTTP 500 "Internal error — see the ComfyUI server log", with a traceback in
    the log, for a request that was simply malformed.

    ONLY ValueError is absorbed. json.JSONDecodeError and UnicodeDecodeError
    are both ValueError, and both mean "these bytes are not a JSON document" —
    which is the caller's problem and belongs in a 400. Anything else raised
    while reading the request is a real failure and is left to propagate, so
    the handler's own tail still reports it as the 500 it is rather than
    blaming the user for a bug on this side.
    """
    try:
        body = await request.json()
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


def _epe_d(v):
    """A dict, or an empty one."""
    return v if isinstance(v, dict) else {}


def _epe_l(v):
    """A list, or an empty one."""
    return v if isinstance(v, list) else []


def _epe_s(v):
    """A str, or "". Deliberately NOT str(v): a numeric "url" is not a URL and
    a list of description blocks is not a description — turning them into
    "12345" or "['a', 'b']" would put nonsense on screen instead of nothing."""
    return v if isinstance(v, str) else ""


def _epe_upstream_reason(exc, what="The service"):
    """(safe message, HTTP status) for a failure talking to somebody else.

    Nothing derived from the exception's text reaches the caller. See the
    header of this patch for what used to: hosts, ports, OS error strings and
    absolute server paths, rendered in the browser.
    """
    if isinstance(exc, _EpeUrlRejected):
        # Our own wording, about a URL the caller supplied.
        return str(exc), 400
    if isinstance(exc, _EpeTooLarge):
        # Our own wording, and specifically a 413 — not a 500 or a 502.
        return str(exc), 413
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return f"{what} took too long to respond.", 504
    return f"{what} could not be reached.", 502


def _epe_upstream_error(where, exc, what="The service"):
    """_epe_upstream_reason as a response, with the detail logged instead."""
    logger.warning("%s: %s: %s", where, type(exc).__name__, exc)
    msg, status = _epe_upstream_reason(exc, what)
    return web.json_response({"error": msg}, status=status)


_EPE_NEG_MARK = "negative prompt:"


def _epe_find_negative_marker(body):
    """Index of the line that opens the A1111 negative prompt, or -1.

    Replaces ``re.search(r'^\\s*Negative prompt:\\s*', body, M | I)``. Under
    MULTILINE, ``^`` is a valid start at every newline and ``\\s`` matches
    ``\\n``, so on a body of N newlines the engine restarted a full whitespace
    walk at each of N line starts: 2,000 newlines 0.017 s, 4,000 0.069 s,
    8,000 0.290 s, 16,000 1.177 s, 32,000 4.498 s — clean x4 per doubling.

    That input is a PNG text chunk somebody else wrote, inflated to as much as
    _EPE_PNG_MAX_TEXT_BYTES before it arrives, and `sre` holds the GIL for the
    whole match — so this stopped the entire ComfyUI process, uncancellably,
    from a 15 KB file. It is the same shape round 16 removed from the
    settings-line check one statement below, and the JavaScript side carried
    the same line; this was the last member of that family.

    Same answer. The regex can only match where the marker is preceded, back
    to some line start, by nothing but whitespace — which is exactly "the
    first line whose content starts with the marker". The two differ only in
    how far back into a preceding run of blank lines the index sits, and the
    caller strips the half it keeps, so that is invisible.
    Differential-fuzzed over 200,000 assembled inputs: the raw index differs on
    6% and the caller's result on none.
    """
    n = len(body)
    p = 0
    while True:
        # Intra-line whitespace only. Python's MULTILINE ``^`` starts a line
        # after ``\\n`` and nothing else, but ``\\s`` covers ``\\r`` and the
        # rest, so those are stepped over without ending the line.
        i = p
        while i < n and body[i] != "\n" and body[i].isspace():
            i += 1
        if body[i:i + len(_EPE_NEG_MARK)].lower() == _EPE_NEG_MARK:
            return p
        nl = body.find("\n", p)
        if nl < 0:
            return -1
        p = nl + 1


def _epe_message_content(data):
    """content of an Ollama /api/chat reply, or "".

    `data.get("message", {}).get("content", "").strip()` assumed three things
    at once: that the body decoded to a dict, that "message" is a dict, and
    that "content" is a str. _epe_json_capped returns None for an empty body
    and whatever type the JSON was otherwise, so an Ollama that answers 200
    with `null`, a list, or `{"message": "text"}` raised AttributeError out of
    the handler as a generic 500.
    """
    if not isinstance(data, dict):
        return ""
    msg = data.get("message")
    if not isinstance(msg, dict):
        return ""
    content = msg.get("content")
    return content.strip() if isinstance(content, str) else ""


class _EpeAvMissing(Exception):
    """PyAV is not installed — video decode is unavailable."""


class _EpeTooLarge(Exception):
    """A remote response exceeded the byte budget for its route."""


async def _epe_read_capped(resp, limit=_EPE_MAX_FETCH_BYTES):
    """resp.read() with a ceiling. Raises _EpeTooLarge past the limit."""
    chunks, total = [], 0
    async for chunk in resp.content.iter_chunked(65536):
        total += len(chunk)
        if total > limit:
            raise _EpeTooLarge(f"remote response exceeded {limit // (1024*1024)} MB")
        chunks.append(chunk)
    return b"".join(chunks)


_EPE_MAX_TEXT_DIAG = 64 * 1024       # diagnostic text only — see below


async def _epe_text_capped(resp, limit=_EPE_MAX_TEXT_DIAG):
    """resp.text() with a ceiling.

    Same reasoning as _epe_json_capped: aiohttp decompresses transparently and
    these sessions ask for gzip, so a small reply on the wire can inflate to
    gigabytes in memory. Every caller of this only wants the first couple of
    hundred characters for a log line or an error message, and one of them was
    measured turning a 1.17 MB gzipped 503 body into 1,200 MB resident and
    14.6 seconds of frozen event loop.

    TRUNCATES, and does not raise. Every caller here wants a short string for
    a log line or an error message, so turning an oversized error body into a
    second error would replace a useful diagnostic with a useless one. Reading
    stops at the limit; the rest of the body is simply never pulled off the
    socket.
    """
    chunks, total = [], 0
    async for chunk in resp.content.iter_chunked(8192):
        chunks.append(chunk)
        total += len(chunk)
        if total >= limit:
            break
    raw = b"".join(chunks)[:limit]
    if not raw:
        return ""
    try:
        enc = resp.get_encoding() or "utf-8"
    except Exception:
        enc = "utf-8"
    return raw.decode(enc, "replace")


async def _epe_json_capped(resp, limit=_EPE_MAX_JSON_BYTES):
    """resp.json() with a ceiling, for JSON from a PUBLIC host.

    aiohttp decompresses transparently and these sessions ask for gzip, so a
    few-MB reply can inflate to gigabytes inside resp.json() — decoded on the
    event loop, in ComfyUI's own process. The download paths were capped from
    the start; the JSON paths were not. json.loads runs in the pool for the
    same reason: a large document is real CPU time on the loop.
    """
    raw = await _epe_read_capped(resp, limit)
    if not raw:
        return None

    def _decode(_b=raw):
        # utf-8 decode AND json.loads: both are real CPU time on a 32 MB
        # document, and moving only the parse left the decode on the loop.
        return json.loads(_b.decode("utf-8", "replace"))

    try:
        # The buffer goes in a HOLDER the coroutine can empty, not straight
        # into the closure.
        #
        # ThreadPoolExecutor's work queue is a SimpleQueue and is unbounded,
        # and Future.cancel() only marks the future — it does not drop the
        # queued _WorkItem or its references. So a client that disconnects
        # while its decode is queued behind a long job leaves up to 32 MB
        # pinned until a worker gets to it. Measured: six abandoned
        # extract-workflow requests held 250 MB after every client had gone,
        # released only when four wedged video decodes finished.
        _hold = [raw]

        def _decode_held():
            _b = _hold.pop() if _hold else b""
            return json.loads(_b.decode("utf-8", "replace"))

        try:
            return await asyncio.get_running_loop().run_in_executor(
                _EPE_POOL, _decode_held)
        finally:
            # Runs on cancellation too, which is the whole point.
            del _hold[:]
    except RecursionError:
        # A subclass of RuntimeError, and NOT a shutdown: deeply nested input
        # (a few KB of "[" is enough). Re-running it inline would block the
        # loop and fail the same way, so refuse it here.
        raise _EpeTooLarge("remote JSON is nested too deeply")
    except RuntimeError:
        # Pool shutting down — decode inline rather than fail the request.
        return _decode()


async def _epe_stream_to_file(resp, path, limit=_EPE_MAX_VIDEO_BYTES):
    """Stream to disk with a ceiling; removes the partial file if exceeded.

    The open, every write and the close run in EPE's FILESYSTEM pool: up to
    512 MB written with plain f.write() on the event loop stalled every other
    request for the duration of each disk flush, and this directory can be a
    network share where those calls block for the mount timeout. They used to
    go to _EPE_POOL, whose four workers also serve JSON decoding, workflow
    parsing, base64 encoding and every frame extraction.
    """
    loop = asyncio.get_running_loop()
    total = 0
    # The open happens INSIDE the try below, not out here.
    #
    # It used to sit before the cleanup helpers, and a cancellation landing on
    # that single await created the file with nobody left to remove it: the
    # helpers are never reached, the callers' `except Exception` does not
    # catch CancelledError (it is a BaseException), and _epe_sweep_unstarted
    # guards a different try entirely. Measured with a slow open and a cancel
    # at 0.25s — a zero-byte .mp4 left behind in ComfyUI's input directory,
    # which is also the user's own image library.
    #
    # The helpers therefore read `f` from this scope rather than binding it as
    # a default argument, so they work whether or not the open completed.
    f = None
    _open_fut = None
    # Tracks the LAST write future submitted to _EPE_FS_POOL. On a cancelled
    # await, the future the coroutine was awaiting may still be running in a
    # pool worker — `_cleanup_retry`, submitted to the same pool, can pick a
    # different worker and race the write on the same handle. Waiting for
    # this future to settle inside `_cleanup_retry` serializes the two.
    # A threading.Event, NOT the asyncio.Future this used to hold.
    #
    # `loop.run_in_executor` returns an asyncio.Future, whose `.result()` takes
    # no `timeout` keyword — so `_lw.result(timeout=5.0)` raised TypeError
    # straight into the `except Exception: pass` below and the wait never
    # happened. (Correcting the call would not have helped either:
    # `_cleanup_retry` runs on a POOL thread, and asyncio.Future is not
    # thread-safe.) Reproduced: the handle was closed 300 ms before the write
    # landed on it.
    #
    # Set means "no write outstanding".
    _write_done = threading.Event()
    _write_done.set()

    def _write_chunk(_c):
        try:
            return f.write(_c)
        finally:
            _write_done.set()

    # Defined at FUNCTION scope, not inside the except below: the final-close
    # handler at the end of this function also needs them, and defining them
    # in a block that had not run raised UnboundLocalError there — losing the
    # cancellation and leaking the very file this is here to remove.
    def _cleanup_retry(_p=path):
        # Pool-side: wait for any in-flight write to settle FIRST, then
        # close, then ride out a transient Windows lock. threading.Event.wait
        # is safe to call from any thread and is what makes this a real
        # serialisation rather than a swallowed TypeError.
        _write_done.wait(5.0)
        try:
            if f is not None:
                f.close()
        except Exception:
            pass
        for _try in range(5):
            try:
                os.remove(_p)
                break
            except FileNotFoundError:
                break
            except OSError:
                time.sleep(0.2)
        else:
            logger.warning(f"epe: could not remove partial file {_p}")

    def _cleanup(_p=path):
        # Loop-side: one immediate attempt — the file was just closed, so
        # this normally succeeds and the partial is gone before the error
        # reaches the caller. A lock means retrying with sleeps, which
        # must not happen on the event loop; that escalates to the pool.
        #
        # Deliberately does NOT wait on `_write_done`. This helper only
        # runs when `_EPE_FS_POOL.submit(_cleanup_retry, ...)` refused with
        # RuntimeError — i.e., the pool is already shut down, so by
        # construction no live pool worker can still be running the write.
        # There is nothing to serialize against. A `.result()` here would
        # only introduce a needless event-loop stall.
        try:
            if f is not None:
                f.close()
        except Exception:
            pass
        try:
            os.remove(_p)
        except FileNotFoundError:
            pass
        except OSError:
            try:
                _EPE_FS_POOL.submit(_cleanup_retry, _p)
            except RuntimeError:
                logger.warning(f"epe: could not remove partial file {_p}")

    def _reap_open(_fut, _p=path):
        """Clean up an open that finished AFTER we were cancelled.

        run_in_executor cannot stop a thread that has already begun, so a
        cancellation landing on the open leaves it running and the file
        appears a moment later — after the handler below has already looked
        for it and found nothing. (_cleanup_retry gives up the instant
        os.remove reports no such file, which is right for every other case
        and exactly wrong for this one.) Hence the shield: the future stays
        alive and uncancelled so this can reap whatever it produces.
        """
        try:
            h = _fut.result()
        except BaseException:
            return                      # the open failed: nothing was created
        try:
            h.close()
        except Exception:
            pass
        try:
            _EPE_FS_POOL.submit(_cleanup_retry, _p)
        except RuntimeError:
            try:
                os.remove(_p)
            except OSError:
                pass

    try:
        _open_fut = loop.run_in_executor(_EPE_FS_POOL, open, path, "wb")
        f = await asyncio.shield(_open_fut)
        async for chunk in resp.content.iter_chunked(65536):
            total += len(chunk)
            if total > limit:
                raise _EpeTooLarge(f"download exceeded {limit // (1024*1024)} MB")
            _write_done.clear()
            try:
                _wfut = loop.run_in_executor(_EPE_FS_POOL, _write_chunk, chunk)
            except BaseException:
                # The submit itself was refused (pool shut down), so nothing
                # is running and nothing should wait five seconds for it.
                _write_done.set()
                raise
            # Cancellation lands HERE, with the worker possibly mid-write —
            # which is the case the Event exists for: `_write_chunk`'s finally
            # sets it when the write really is done.
            await _wfut
    except BaseException as _exc:
        # Any failure, not just too-large: a timeout or reset used to leave the
        # partial .mp4 behind, and ComfyUI's input directory here is the
        # user's own image folder. Only a CANCELLED await can leave work
        # still in flight in the pool — there, close and remove must happen in
        # the pool too (Windows refuses to unlink an open file; the retry loop
        # rides that out). Every other failure has no write outstanding, so
        # cleaning up right here keeps the contract that the partial file is
        # gone by the time the error reaches the caller.
        if isinstance(_exc, asyncio.CancelledError):
            if f is None and _open_fut is not None:
                # Cancelled ON the open — hand it to the reaper above.
                _open_fut.add_done_callback(_reap_open)
            else:
                # A cancelled await may have left a write in flight in the
                # pool; close and remove must happen there too. A pool already
                # shutting down has nothing in flight — clean up here instead.
                try:
                    _EPE_FS_POOL.submit(_cleanup_retry)
                except RuntimeError:
                    _cleanup()
        else:
            _cleanup()
        raise
    try:
        await loop.run_in_executor(_EPE_FS_POOL, f.close)
    except BaseException:
        # Cancellation landing exactly on the final close used to leave the
        # completed file behind with its handle open.
        try:
            _EPE_FS_POOL.submit(_cleanup_retry)
        except RuntimeError:
            _cleanup()
        raise
    return total


# ── DNS rebinding ────────────────────────────────────────────────────────────
from aiohttp.abc import AbstractResolver as _EpeAbstractResolver


class _EpeGuardedResolver(_EpeAbstractResolver):
    """Refuses to hand aiohttp an address pointing inside the network.

    Checking the hostname before the request and then letting aiohttp resolve it
    independently leaves a window: a short-TTL name can answer public for the
    check and loopback for the connection. Validating here closes the window,
    because this IS the lookup the connection uses.
    """

    # No inner resolver instance: aiohttp never closes a resolver it was
    # handed (so one per session leaked), and ThreadedResolver binds the
    # running loop at construction, which a shared instance would hold for
    # the process lifetime. Going through the current loop avoids both.
    async def resolve(self, host, port=0, family=socket.AF_INET):
        loop = asyncio.get_running_loop()
        # loop.getaddrinfo dispatches to asyncio's DEFAULT executor — the
        # pool this module deliberately moved its DNS work off. Do the
        # lookup in EPE's own DNS pool instead.
        infos = await _epe_getaddrinfo_gated(host, port, family)
        out = []
        for fam, _type, proto, _canon, sockaddr in infos:
            ip_str = sockaddr[0]
            try:
                ip = ipaddress.ip_address(ip_str)
            except ValueError:
                raise OSError(errno.EHOSTUNREACH,
                              f"unresolvable address for {host}")
            if _epe_ip_is_private(ip):
                # errno matters: a bare OSError has strerror=None and aiohttp
                # renders the reason as a literal "[None]".
                raise OSError(errno.EHOSTUNREACH,
                              f"blocked private address {ip_str} for {host}")
            out.append({"hostname": host, "host": ip_str, "port": sockaddr[1],
                        "family": fam, "proto": proto,
                        "flags": socket.AI_NUMERICHOST})
        return out

    async def close(self):
        return None


# One shared instance. aiohttp sets _resolver_owner=False for a resolver it was
# handed, so it never closes it — building one per session leaked an object per
# request, and would leak c-ares sockets outright if aiodns were installed. The
# resolver is stateless, so sharing it is both safe and the fix.
_EPE_RESOLVER = None


def _epe_guarded_session(limit_per_host=6, **kwargs):
    """ClientSession for client-supplied URLs: DNS validated at connect time,
    and a per-host connection ceiling (aiohttp's default is unlimited).

    The ceiling is a parameter because the shared session carries a search
    page fetch and up to five concurrent gating lookups (_EPE_REQAUTH_SEM)
    at once — six connections against a ceiling of six, with nothing left
    for a second panel. Modest headroom, not a blank cheque: civitai.com
    answers 429 to a flood and the retry backoff makes that worse.
    """
    global _EPE_RESOLVER
    if _EPE_RESOLVER is None:
        _EPE_RESOLVER = _EpeGuardedResolver()
    return aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(resolver=_EPE_RESOLVER,
                                       limit_per_host=limit_per_host),
        **kwargs)


class _EpeOllamaResolver(_EpeAbstractResolver):
    """The mirror image of _EpeGuardedResolver, for the Ollama base URL.

    Ollama is expected on loopback or the user's own network, so here it is a
    PUBLIC address that gets refused. _epe_check_ollama_url runs before the
    request and aiohttp then resolved the name again at connect time, leaving
    exactly the rebinding window the media routes closed: a short-TTL name
    answers 127.0.0.1 for the check and an attacker's address for the
    connection, and the user's prompt is POSTed to it.

    Literal IPs never reach a resolver — aiohttp short-circuits those — but the
    pre-check already covers them.
    """

    async def resolve(self, host, port=0, family=socket.AF_INET):
        loop = asyncio.get_running_loop()
        # loop.getaddrinfo dispatches to asyncio's DEFAULT executor — the
        # pool this module deliberately moved its DNS work off. Do the
        # lookup in EPE's own DNS pool instead.
        infos = await _epe_getaddrinfo_gated(host, port, family)
        out = []
        for fam, _type, proto, _canon, sockaddr in infos:
            ip_str = sockaddr[0]
            try:
                ip = ipaddress.ip_address(ip_str)
            except ValueError:
                raise OSError(errno.EHOSTUNREACH,
                              f"unresolvable address for {host}")
            # Same two rules as _epe_check_ollama_url: local only, and never
            # link-local (169.254.169.254 is cloud metadata, not Ollama).
            if not _epe_ip_is_local_network(ip) or ip.is_link_local:
                raise OSError(errno.EHOSTUNREACH,
                              f"blocked non-local address {ip_str} for {host}")
            out.append({"hostname": host, "host": ip_str, "port": sockaddr[1],
                        "family": fam, "proto": proto,
                        "flags": socket.AI_NUMERICHOST})
        return out

    async def close(self):
        return None


_EPE_OLLAMA_RESOLVER = None


def _epe_ollama_session(**kwargs):
    """ClientSession for the user's Ollama base URL: refuses at connect time to
    reach anything outside loopback / the private network."""
    global _EPE_OLLAMA_RESOLVER
    if _EPE_OLLAMA_RESOLVER is None:
        _EPE_OLLAMA_RESOLVER = _EpeOllamaResolver()
    return aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(resolver=_EPE_OLLAMA_RESOLVER,
                                       limit_per_host=6),
        **kwargs)


logger = logging.getLogger("EPE")

# EPE's own thread pools. Every run_in_executor call here used to go to the
# loop's DEFAULT pool, which is the one ComfyUI runs its own blocking work in.
# Two of them, because the work is not alike: socket.getaddrinfo cannot be
# cancelled and can sit for the OS resolver timeout, so a handful of hostile
# hostnames sharing a pool with the video decodes wedged every EPE route —
# including the localhost Ollama check, whose first statement is a name check.
# Parked on _EPE_HOLDER so a re-import (registry + clone, or manager reload)
# reuses these instead of piling on ~13 more OS threads each time.
_EPE_DNS_POOL  = _epe_singleton(
    "_EPE_DNS_POOL",
    lambda: _EpeThreadPool(max_workers=16, thread_name_prefix="epe-dns"))
_EPE_POOL      = _epe_singleton(
    "_EPE_POOL",
    lambda: _EpeThreadPool(max_workers=4, thread_name_prefix="epe-work"))
# A third, for filesystem calls against the user's image directory. That
# directory can be a network share, where mkdir/unlink block for the mount
# timeout and cannot be cancelled. It does not belong in _EPE_POOL (four
# wedged workers stop every download and decode) and it does not belong in
# _EPE_DNS_POOL either, which is the executor behind every connect-time
# getaddrinfo — wedging that stops every route in the plugin, not just these.
_EPE_FS_POOL   = _epe_singleton(
    "_EPE_FS_POOL",
    lambda: _EpeThreadPool(max_workers=4, thread_name_prefix="epe-fs"))

# ---- Bounded name checks ---------------------------------------------------
# Splitting the pools above stopped a hostile hostname wedging the video
# decodes and the filesystem writes. It did not stop it wedging the DNS pool
# itself. socket.getaddrinfo cannot be cancelled: a name whose nameserver
# silently drops packets holds its worker for the OS resolver timeout — tens of
# seconds — whatever the caller does. Sixteen such names filled all sixteen
# workers and every EPE route stopped, INCLUDING the localhost Ollama check,
# whose first statement is a name check that the OS cache would have answered
# in microseconds. Only _epe_safe_get bounded its own wait; the other eleven
# call sites had no timeout at all, so they queued behind a wedge that was
# never going to clear.
#
# Two halves, and both are needed:
#   * asyncio.wait_for frees the CALLER. It cannot free the worker, so on its
#     own it leaves the pool exactly as full one request later.
#   * the in-flight gate is what stops the next request queueing behind threads
#     that are not coming back.
#
# Both kinds of lookup count against the same total, and the connect-time one
# is allowed a HIGHER ceiling than the pre-checks. That is what makes "the
# checks cannot starve the connections they just approved" true rather than
# merely intended: three slots exist that a pre-check can never occupy, and
# one worker of the sixteen is never handed out at all.
#
# The first version of this gated only the pre-checks and left a comment
# claiming the reserve existed. It did not: _EpeGuardedResolver.resolve and
# _EpeOllamaResolver.resolve submitted getaddrinfo to this pool with no
# timeout and no gate, so a hostname that answers once and then blackholes
# filled all sixteen workers through the CONNECTOR while the counter read
# zero. aiohttp's ClientTimeout does not help — it cancels the await, and
# getaddrinfo keeps the worker, which is the premise this pool split rests on.
_EPE_DNS_TIMEOUT      = 8.0   # seconds one name lookup may take
_EPE_DNS_MAX_INFLIGHT = 12    # ceiling for the PRE-CHECKS
_EPE_DNS_MAX_CONNECT  = 15    # ceiling for CONNECT-TIME lookups
_EPE_DNS_INFLIGHT     = 0     # currently inside getaddrinfo, both kinds


async def _epe_dns_check(fn, url, timeout=_EPE_DNS_TIMEOUT):
    """Run a URL name-check in the DNS pool, bounded and gated.

    Returns the check's own message — '' when the URL is acceptable — or a
    rejection message when the pool is saturated. Raises asyncio.TimeoutError
    past `timeout`, so a caller holding a chain budget can report a timeout as
    a timeout rather than as a rejected URL.
    """
    global _EPE_DNS_INFLIGHT
    if _EPE_DNS_INFLIGHT >= _EPE_DNS_MAX_INFLIGHT:
        # Fail CLOSED, and now. Running the check inline instead would be the
        # event-loop stall this pool exists to prevent, and queueing for a
        # worker is how one bad hostname took the whole plugin down.
        return ("name resolution is busy — one or more hosts are not "
                "responding; try again in a moment")
    loop = asyncio.get_running_loop()
    # Increment BEFORE submitting the future. Otherwise a submit failure —
    # or a done-callback that runs synchronously (unusual but permitted by
    # asyncio) — could fire `_release` and drive the counter negative.
    _EPE_DNS_INFLIGHT += 1

    def _release(_f):
        global _EPE_DNS_INFLIGHT
        _EPE_DNS_INFLIGHT -= 1

    try:
        fut = loop.run_in_executor(_EPE_DNS_POOL, fn, url)
        fut.add_done_callback(_release)
    except Exception:
        _EPE_DNS_INFLIGHT -= 1
        raise
    # shield, so the timeout cancels the WAIT and not the future. Cancelling
    # the future would fire _release at once while the worker is still stuck
    # inside getaddrinfo, and the gate would stop counting a thread it still
    # holds — which is the whole bug, reintroduced by the fix for it.
    return await asyncio.wait_for(asyncio.shield(fut), timeout)


async def _epe_getaddrinfo_gated(host, port, family):
    """socket.getaddrinfo in the DNS pool, bounded and gated.

    The connect-time twin of _epe_dns_check, for the two resolvers. Raises
    OSError(EHOSTUNREACH) — which is what aiohttp's connector expects — when
    the pool is saturated or the lookup outlives its budget.
    """
    global _EPE_DNS_INFLIGHT
    if _EPE_DNS_INFLIGHT >= _EPE_DNS_MAX_CONNECT:
        raise OSError(errno.EHOSTUNREACH,
                      f"name resolution is busy; refusing to look up {host}")
    loop = asyncio.get_running_loop()
    # Increment BEFORE submitting — same reason as _epe_dns_check above.
    _EPE_DNS_INFLIGHT += 1

    def _release(_f):
        global _EPE_DNS_INFLIGHT
        _EPE_DNS_INFLIGHT -= 1
        # getaddrinfo raises for an unknown host, and on the timeout path
        # below nobody is left awaiting this future. Retrieve it here so it
        # does not surface as "exception was never retrieved".
        if not _f.cancelled():
            try:
                _f.exception()
            except Exception:
                pass

    try:
        fut = loop.run_in_executor(
            _EPE_DNS_POOL,
            functools.partial(socket.getaddrinfo, host, port, family=family,
                              type=socket.SOCK_STREAM,
                              flags=socket.AI_ADDRCONFIG))
        fut.add_done_callback(_release)
    except Exception:
        _EPE_DNS_INFLIGHT -= 1
        raise
    try:
        # shield, for the same reason _epe_dns_check does: the timeout must
        # cancel the WAIT, not the future, or _release fires while the worker
        # is still stuck inside getaddrinfo and the gate stops counting a
        # thread it still holds.
        return await asyncio.wait_for(asyncio.shield(fut), _EPE_DNS_TIMEOUT)
    except asyncio.TimeoutError:
        raise OSError(errno.EHOSTUNREACH,
                      f"name resolution for {host} timed out")


async def _epe_dns_check_msg(fn, url, timeout=_EPE_DNS_TIMEOUT):
    """_epe_dns_check with the timeout expressed as a rejection message.

    Every handler below wants one string it can put in a 400; only
    _epe_safe_get, which owns a redirect-chain budget, needs to tell the two
    apart.
    """
    try:
        return await _epe_dns_check(fn, url, timeout)
    except asyncio.TimeoutError:
        return "URL host did not resolve in time"


_EPE_TMP_SUBDIR = "epe_tmp"
# The EXACT shape of every name this module stages, and the only shape the
# sweep will unlink. Built at three sites, all of the form
# f"epe_{kind}_{uuid.uuid4().hex[:12]}.mp4" — see the video, frame and
# video-file routes.
#
# The sweep used to match `name.startswith(("epe_v2p_", "epe_frame_",
# "epe_vf_"))`. The input directory is the user's own image library — on this
# install it is the folder every render is saved into — so a photo named
# `epe_frame_beach_2019.jpg` was unlinked at import, with no recycle bin, no
# log line and no way to tell what had happened. A prefix is not proof of
# authorship; a 12-hex uuid and a fixed extension are close enough to it.
# \Z, not $. Python's `$` also matches immediately before a trailing
# newline, and a POSIX filename may contain one — so "epe_v2p_<hex>.mp4\n",
# a file this module never wrote, matched and was deleted. Its basename then
# went into logger.info unescaped, putting a raw newline in ComfyUI's log.
_EPE_STAGED_NAME_RE = re.compile(r"^epe_(?:v2p|frame|vf)_[0-9a-f]{12}\.mp4\Z")


def _epe_tmp_dir():
    """The per-plugin scratch directory inside ComfyUI's input directory.

    Every staged video (epe_v2p_, epe_frame_, epe_vf_) is written here rather
    than into the input directory root. Two things follow from that: an
    unremovable orphan is confined to a folder EPE owns and can sweep on the
    next import, and the orphan does not appear in ComfyUI's LoadImage picker
    (which scans the input directory root, not this subdirectory).

    The directory is created on demand by each handler's existing
    `os.makedirs` — no import-time filesystem touch, so a dead mount here
    cannot delay ComfyUI startup.
    """
    return os.path.join(folder_paths.get_input_directory(), _EPE_TMP_SUBDIR)


def _epe_is_reparse_point(path):
    """True for a symlink OR a Windows junction/mount point.

    `os.path.islink` is not enough on Windows: CPython sets S_IFLNK only for
    IO_REPARSE_TAG_SYMLINK, and a junction (`mklink /J`) carries
    IO_REPARSE_TAG_MOUNT_POINT — which is exactly why 3.12 had to add
    `os.path.isjunction`. `os.path.isdir` and `os.listdir` both follow a
    junction, so without this an `epe_tmp` junction pointed at a photo folder
    would have been enumerated and swept.

    st_file_attributes exists only on Windows; FILE_ATTRIBUTE_REPARSE_POINT
    is 0x400 and is spelled out rather than imported so this keeps working on
    a Python without `stat.FILE_ATTRIBUTE_REPARSE_POINT`.
    """
    try:
        if os.path.islink(path):
            return True
        _attrs = getattr(os.lstat(path), "st_file_attributes", None)
        return bool(_attrs is not None and (_attrs & 0x400))
    except (FileNotFoundError, NotADirectoryError):
        # Simply not there. `epe_tmp/` is created on demand, so this is the
        # ordinary state of a fresh install — and answering True made the
        # sweep log "epe_tmp is a link, remove it if unintentional" about a
        # directory that has never existed. Nothing to refuse.
        return False
    except OSError:
        # Present but unreadable: not provably ours, so off-limits.
        return True


def _epe_sweep_tmp_dir():
    """Delete every file left in epe_tmp/ from a previous run.

    Runs at import time. Anything here is by definition orphaned — the
    request that wrote it is not running now. The 5-retry unlink in
    `_epe_run_then_unlink` is the best-effort path for the *running* case;
    this sweep is what catches the AV/Windows edge — an anti-virus handle
    lingering past the last retry, a hard crash, a `SIGKILL` — that the
    retry loop cannot cover.

    Old-style orphans in the input directory root (from pre-1.0.20 builds
    that staged there directly) are also swept, one release long.

    ONLY names matching `_EPE_STAGED_NAME_RE` are ever unlinked — the full
    `epe_<kind>_<12 hex>.mp4` shape this module writes, not a bare prefix —
    and only when the path is a real file rather than a link. The input
    directory is the user's image library; a sweep that runs at import,
    deletes without asking and logs nothing is the last place to be
    approximate about which files are ours.
    """
    try:
        input_dir = folder_paths.get_input_directory()
    except Exception:
        return
    _removed = []

    def _sweep_one(directory, name):
        """Unlink `name` in `directory` only if EPE can prove it wrote it."""
        # Name shape first — cheapest, and the only authorship evidence there
        # is.
        if not _EPE_STAGED_NAME_RE.match(name):
            return
        path = os.path.join(directory, name)
        try:
            # NOT a link. os.remove would only drop the link itself, but a
            # name that matches the staged shape and is a link is not
            # something this module created, so leave it entirely alone.
            if _epe_is_reparse_point(path) or not os.path.isfile(path):
                return
            os.remove(path)
            _removed.append(path)
        except OSError as _e:
            # Deliberately logged. The retry loop in _epe_run_then_unlink
            # already warns when it cannot delete a file it owns; this path,
            # which is the one that can touch a file it does NOT own, used to
            # be the silent one. That asymmetry was backwards.
            logger.debug(f"epe sweep: could not remove {path}: {_e}")

    # Root of the input directory — pre-1.0.20 orphans only, one release long.
    try:
        for name in os.listdir(input_dir):
            _sweep_one(input_dir, name)
    except OSError as _e:
        logger.debug(f"epe sweep: could not list input dir: {_e}")

    # epe_tmp/ — EPE's own staging folder.
    tmp_dir = os.path.join(input_dir, _EPE_TMP_SUBDIR)
    # A symlink or a Windows junction here is followed by both os.path.isdir
    # and os.listdir, and os.remove on the joined child then deletes the REAL
    # file behind it. An `epe_tmp` link pointing at a photo folder emptied
    # that folder. Refuse rather than walk into it.
    if _epe_is_reparse_point(tmp_dir):
        logger.warning(
            f"epe sweep: {tmp_dir} is a link — not sweeping it. "
            f"Remove the link if this is not intentional.")
    elif os.path.isdir(tmp_dir):
        try:
            for name in os.listdir(tmp_dir):
                # Name-checked here too. "Everything in here is orphaned by
                # construction" is only true if EPE made the folder; a user
                # who happens to have one keeps their files.
                _sweep_one(tmp_dir, name)
        except OSError as _e:
            logger.debug(f"epe sweep: could not list {tmp_dir}: {_e}")

        # And then take the folder itself, if the sweep emptied it.
        #
        # The input directory is the user's own image library — on this install
        # it is the folder every render is saved into — so an empty `epe_tmp/`
        # sat there for ever, in a place they browse. It is created on demand by
        # each handler's os.makedirs, so removing it costs nothing but a mkdir
        # on the next staged video.
        #
        # os.rmdir IS the safety property, not a check before it: it refuses a
        # non-empty directory outright. So a folder holding anything at all —
        # a file that failed the name check, a file the user put there, a file
        # a live request is writing right now — survives untouched, and the
        # OSError is the ordinary case rather than an error worth a log line
        # above debug. Nothing here can reach a file, only an empty directory.
        try:
            os.rmdir(tmp_dir)
            logger.debug(f"epe sweep: removed empty {tmp_dir}")
        except OSError:
            pass

    if _removed:
        logger.info(f"EPE: swept {len(_removed)} orphaned staged file(s): "
                    + ", ".join(os.path.basename(p) for p in _removed[:8])
                    + ("…" if len(_removed) > 8 else ""))


def _epe_sweep_unstarted(path, claim):
    """Delete `path` ONLY if the worker that owns it never started.

    An earlier version of this submitted the delete to the worker pool and
    argued that FIFO ordering placed it behind any running worker. That is
    wrong — FIFO governs which task is DEQUEUED next, and with four workers a
    task submitted after a running one is picked up immediately by a free
    thread. Measured: the sweep ran while the worker still held the file open.

    So the sweep no longer guesses. `claim` is set by the worker as its very
    first action; if it is unset, the job was almost certainly cancelled while
    still queued, the callable never ran, and nothing else will ever remove the
    download. That is the only case this exists for.

    The honest limit: a pool work item is marked RUNNING just before it calls
    the function, so there is a sliver — no await, no GIL-release point — in
    which the claim is unset while a worker is about to open the file. The
    large window is closed (asyncio always attempts the executor future's
    cancel before the handler resumes to read the claim), and a reproduction
    hit the sliver 0 times in 400 attempts. If it ever did land there, the
    request is already cancelled, `_epe_run_then_unlink`'s own finally still
    unlinks, and the worst case is a decode that returns no frames. Not
    "provably unheld" — narrow, bounded and harmless.
    """
    if claim.is_set():
        return                       # the worker owns it and deletes it itself
    def _rm(_p=path):
        try:
            os.remove(_p)
        except FileNotFoundError:
            pass
        except OSError as _e:
            logger.warning(f"epe: could not remove staged file {_p}: {_e}")
    try:
        _EPE_FS_POOL.submit(_rm)
    except RuntimeError:
        # Pool down. The file is unheld (claim unset), but a blocking unlink
        # on a dead mount must still not run on the event loop, so this is
        # deliberately left to the OS rather than done here.
        logger.warning(f"epe: pool down, leaving staged file {path}")


def _epe_run_then_unlink(fn, path, claim=None):
    """Run fn(path), then delete `path` — in this thread, before returning.

    The delete has to happen in the same thread that used the file. Doing it in
    the request handler's `finally` races the worker: on a client disconnect
    the handler unwinds immediately while the worker still holds the file open,
    which fails outright on Windows and, on POSIX, unlinks a file the worker is
    still writing.

    `claim` is set first thing, so the handler can tell whether this ever ran.
    """
    if claim is not None:
        claim.set()
    try:
        return fn(path)
    finally:
        for _try in range(5):
            try:
                os.remove(path)
                break
            except FileNotFoundError:
                break
            except OSError:
                if _try < 4:
                    time.sleep(0.2)
        else:
            logger.warning(f"epe: could not remove staged file {path}")


# ── Cross-site request forgery ───────────────────────────────────────────────
# request.json() ignores Content-Type, so a plain `fetch(..., {method:"POST",
# headers:{"Content-Type":"text/plain"}, body:"{...}"})` from any page the user
# visits reaches these routes with no preflight and no consent. The attacker
# cannot READ the reply — same-origin policy still applies — but every one of
# these routes is worth triggering for its side effect alone.
_EPE_ALLOWED_ORIGINS = set(
    o.strip().rstrip("/").lower()
    for o in (os.environ.get("EPE_ALLOWED_ORIGINS") or "").split(",")
    if o.strip()
)


def _epe_same_origin(request) -> bool:
    """True if this request plausibly came from the ComfyUI page itself."""
    # Not every caller is an HTTP request: ComfyUI and the in-process test
    # harnesses invoke these handlers directly with a stand-in that has no
    # headers. There is no cross-site risk from a caller already inside the
    # process, and a guard that 500s its own callers is not a guard.
    headers = getattr(request, "headers", None)
    if headers is None:
        return True

    # Sec-Fetch-Site is set by the browser and cannot be forged by page script.
    # Present and "cross-site" is decisive; the other values are all fine.
    sfs = (headers.get("Sec-Fetch-Site") or "").lower()
    if sfs == "cross-site":
        return False

    origin = headers.get("Origin")
    if not origin:
        # No Origin at all: a same-origin navigation, curl, or a non-browser
        # client. Browsers send Origin on every cross-origin request including
        # simple POSTs, so absence is not the attack shape.
        return True

    origin_l = origin.rstrip("/").lower()
    if origin_l in _EPE_ALLOWED_ORIGINS:
        return True
    try:
        o = urlparse(origin)
    except Exception:
        return False
    if o.scheme not in ("http", "https"):
        return False

    host = (headers.get("Host") or "").lower()
    if host and o.netloc.lower() == host:
        return True

    # No hostname-only fallback. request.url is built from the same Host
    # header compared above, so a "proxy rewrote Host" rescue was impossible
    # here — the only thing a hostname-only compare did was drop the PORT,
    # letting any other local web app (localhost:3000 et al.) reach these
    # routes: Sec-Fetch-Site is "same-site" between ports, not "cross-site".
    # Proxy setups belong in EPE_ALLOWED_ORIGINS.
    return False


def _epe_guard(handler):
    """Refuse cross-site calls. Applied under @routes.post so the wrapper is
    what gets registered."""
    @functools.wraps(handler)
    async def _wrapped(request):
        # BEFORE the handler, because after it is too late: every handler
        # wraps its body in `except Exception` and returns a 500, so the
        # RuntimeError branch below — added to surface a shutdown as a 503 —
        # could never be reached. A request arriving during shutdown got an
        # opaque "Internal error — see the ComfyUI server log" instead.
        if getattr(_EPE_HOLDER, "_epe_closing", False):
            return web.json_response(
                {"error": "EPE is shutting down — retry after ComfyUI restarts"},
                status=503)
        if not _epe_same_origin(request):
            logger.warning(
                "EPE: refused a cross-site request to %s from origin %r",
                getattr(request, "path", "?"),
                getattr(getattr(request, "headers", None), "get", lambda _k: None)("Origin"))
            return web.json_response(
                {"error": "Cross-origin request refused"}, status=403)
        # Shutdown signal from _get_session or any pool submit: surface as
        # 503 with the message. Otherwise the broad Exception catch in each
        # handler swallows it into an opaque 500 and the client sees
        # "Internal error — see the ComfyUI server log" during a graceful
        # shutdown, which is neither internal nor an error.
        try:
            return await handler(request)
        except RuntimeError as _re:
            _msg = str(_re) or "service unavailable"
            if "shutting down" in _msg.lower() or "cannot schedule new futures" in _msg.lower():
                return web.json_response({"error": _msg}, status=503)
            raise
    return _wrapped


# On the FIRST import: use the real routes table. On any subsequent import
# (registry + clone, ComfyUI-Manager reload) use a no-op stand-in — the
# routes are already registered from the first import and the router
# already dispatches to that copy's handlers. Redefining them here would
# just add twelve duplicate entries.
if _EPE_ALREADY_REGISTERED:
    class _EpeNoOpRoutes:
        def _noop(_self, _path):
            def _dec(_fn):
                return _fn
            return _dec
        post = _noop
        get  = _noop
    routes = _EpeNoOpRoutes()
else:
    routes = PromptServer.instance.routes


# ── Shared HTTP helpers ───────────────────────────────────────────────────────
#
# A single module-level aiohttp session is reused across requests to avoid
# per-call TCP + TLS handshake cost. The session is created lazily on first use
# because PromptServer already has an event loop running by the time routes are
# invoked.
#
# `_post_json_with_retries` adds exponential backoff on the error classes that
# actually benefit from retrying: timeouts and 429/502/503/504 transient server
# responses. Everything else (400, 401, 403, etc.) is a caller bug or an API
# shape change and is returned immediately so the handler can log and react.

_RETRY_STATUSES = {429, 502, 503, 504}


def _get_session() -> aiohttp.ClientSession:
    """Return a lazily-created shared aiohttp session.

    Parked on `_EPE_HOLDER` so a second import does not create — and never
    close — its own session. Each new session brings a keep-alive socket pool
    that stays open until GC.

    After `_epe_on_shutdown` fires, the `_epe_closing` flag on the holder
    prevents any late request from lazily building a REPLACEMENT session
    that would then never be closed (aiohttp warns "Unclosed client
    session" and its keep-alive sockets survive until GC).
    """
    if getattr(_EPE_HOLDER, "_epe_closing", False):
        raise RuntimeError("EPE shutting down — cannot create a new HTTP session")
    session = getattr(_EPE_HOLDER, "_shared_session", None)
    if session is None or session.closed:
        # Guarded like the media sessions: these all target public hosts,
        # so a hostile answer pointing inside the network is never right.
        session = _epe_guarded_session(
            limit_per_host=12,
            headers={"Accept-Encoding": "gzip, deflate"},
        )
        _EPE_HOLDER._shared_session = session
    return session


@routes.post("/epe/prompts/search")
@_epe_guard
async def epe_prompts_search(request):
    """
    Search Civitai for image or video prompts.

    Uses the public REST API (GET /api/v1/images). Civitai's Terms of Service
    §11.4 prohibits automated access "except through interfaces we expressly
    provide for automated access, such as our public API" — this route is that
    interface. No API key is required for public reads.

    Two server-side behaviours are worked around here:

      * withMeta=true is what makes the API return the "meta" object at all;
        without it there is no prompt to read. It is an include flag, not a
        filter — items with "meta": null still come back — so prompt-bearing
        items are additionally selected locally.
      * The top-level "baseModel" field is always null, so it cannot be used
        for local filtering; the baseModels request parameter is passed
        through and relied on for that.

    /api/v1/images also has no free-text query parameter. When a query is
    supplied we walk the cursor, matching against prompt text locally, up to
    SEARCH_MAX_PAGES pages so a term with no matches can't run away.

    Returns a flat list of {id, imageUrl, videoUrl, mediaType, isPng, name,
    prompt, steps, cfg, sampler, seed} plus metadata.nextCursor for paging.
    """
    try:
        body        = await _epe_json_object(request)
        if body is None:
            # Not JSON, or JSON that is not an object. See
            # _epe_json_object: both used to be a 500 with a
            # traceback in the ComfyUI log.
            return web.json_response(
                {"error": "request body must be a JSON object"}, status=400)
        query       = _epe_s(body.get("query")).strip()
        sort        = _epe_s(body.get("sort")) or "Most Reactions"
        # NOT `or "Month"`: the UI sends "" for its All Time chip — see
        # PERIOD_MAP just below, which has an entry for exactly that — and
        # `or` swallowed it, so All Time silently became Month.
        _period_raw = body.get("period")
        period      = _period_raw if isinstance(_period_raw, str) else "Month"
        nsfw        = body.get("nsfw", False)
        page    = _epe_page_number(body.get("page", 1))
        if page is None:
            return web.json_response({"error": "page must be a number"}, status=400)
        # Coerced like every other body field: it is appended to page_params
        # and goes through urlencode(doseq=True), which iterates a dict's KEYS
        # and a list's ELEMENTS — the shape the Genur `sort` fix called out.
        cursor      = _epe_s(body.get("cursor")) or None
        media_type  = _epe_s(body.get("mediaType")) or "image"
        base_models = body.get("baseModels", [])

        API_URL   = "https://civitai.com/api/v1/images"
        FETCH_LIMIT     = 100      # API max is 200; 100 keeps responses quick
        ITEMS_PER_PAGE  = 20
        SEARCH_MAX_PAGES = 6       # only used when a query is supplied

        # sort/period pass through to the API, which accepts these verbatim.
        VALID_SORT = {"Most Reactions", "Most Comments", "Most Collected",
                      "Newest", "Oldest"}
        sort_val = sort if sort in VALID_SORT else "Most Reactions"

        # The API has no 6Month bucket; widen to Year rather than silently
        # dropping the filter.
        # The UI sends "" for its All Time chip. The API has no 6Month bucket,
        # so that chip was dropped from the UI; the mapping stays as a guard for
        # older saved state.
        PERIOD_MAP = {"": "AllTime", "AllTime": "AllTime", "Day": "Day",
                      "Week": "Week", "Month": "Month", "6Month": "Year",
                      "Year": "Year"}
        period_val = PERIOD_MAP.get(period, "AllTime")

        # aiohttp needs a list of pairs (not a dict) so baseModels can repeat.
        params = [
            ("limit",  str(FETCH_LIMIT)),
            ("sort",   sort_val),
            ("period", period_val),
            ("type",   "video" if media_type == "video" else "image"),
            ("nsfw",   "X" if nsfw else "None"),
            # Required: without this the response carries no "meta" object,
            # so every item looks prompt-less and gets dropped below.
            ("withMeta", "true"),
        ]
        if isinstance(base_models, list) and base_models:
            for m in [str(x).strip() for x in base_models if str(x).strip()][:40]:
                params.append(("baseModels", m))

        headers = {
            "Accept":     "application/json",
            "User-Agent": "ComfyUI-Enhanced-Prompt-Editor",
        }

        def _thumb(u):
            """Civitai image URLs carry a transform segment; swap the
               full-size one for a width-capped thumbnail."""
            u = _epe_s(u)
            if not u or not u.startswith("http"):
                return u
            return u.replace("/original=true/", "/width=450/")

        def _norm(item):
            """Map one API item to EPE's flat shape, or None if it carries
               no prompt (meta is absent on a large share of items).

            Every field is coerced. `"meta": "n/a"` is truthy, so `or {}` let
            it through to .get(); a numeric "url" or "prompt" reached
            .startswith()/.strip(). Any of those raised out of the handler and
            cost the WHOLE page of results, not just the bad item.
            """
            meta = _epe_d(item.get("meta"))
            prompt = _epe_s(meta.get("prompt")).strip()
            if not prompt:
                return None
            url_val = _epe_s(item.get("url"))
            is_video = _epe_s(item.get("type")) == "video"
            return {
                "id":        str(item.get("id", "")),
                "imageUrl":  _thumb(url_val),
                "videoUrl":  url_val if is_video else "",
                "mediaType": "video" if is_video else "image",
                "isPng":     url_val.lower().endswith(".png"),
                "name":      _epe_s(item.get("username")),
                "prompt":    prompt,
                "steps":     str(meta.get("steps")    or meta.get("Steps")    or ""),
                "cfg":       str(meta.get("cfgScale") or meta.get("cfg_scale") or ""),
                "sampler":   str(meta.get("sampler")  or meta.get("Sampler")  or ""),
                "seed":      str(meta.get("seed")     or meta.get("Seed")     or ""),
            }

        # Local relevance test, standing in for the query parameter the API
        # does not provide. Every whitespace-separated term must appear in the
        # prompt at a word start — a plain substring test matches "elf" inside
        # "herself"/"shelf" and floods the results with noise. Anchoring only
        # the start still allows plurals and derived forms ("cyborg" matches
        # "cyborgs", "elf" matches "elven").
        # Bounded before anything is compiled. `query` arrives in the request
        # body with no length limit, and each term became an re.compile on the
        # event loop before the first await: measured, 150,000 terms (a ~1 MB
        # body) froze ComfyUI's queue, websocket and UI for 2.70 s, 500,000
        # for 9.30 s, and held a compiled pattern object per term. _matches is
        # an all(), so a search with more than a handful of required terms
        # returns nothing anyway — the extra terms only ever cost.
        terms = [t for t in query[:_EPE_MAX_QUERY_CHARS].lower().split() if t]
        if len(terms) > _EPE_MAX_QUERY_TERMS:
            terms = terms[:_EPE_MAX_QUERY_TERMS]
        term_res = [re.compile(r"\b" + re.escape(t)) for t in terms]

        def _matches(prompt_text):
            if not term_res:
                return True
            low = prompt_text.lower()
            return all(r.search(low) for r in term_res)

        # Was two closures and a growing list scanned with `any(...)` — an
        # O(n²) pass on the event loop that cost 8.6 s for 3,200 items. Same
        # answers, word-indexed and budgeted; see _EpeSigDedupe.
        _dedupe = _EpeSigDedupe()

        items_out  = []
        next_cursor = cursor
        pages_walked = 0
        scanned = 0
        max_pages = SEARCH_MAX_PAGES if terms else 1

        session = _get_session()
        while pages_walked < max_pages and len(items_out) < ITEMS_PER_PAGE:
            page_params = list(params)
            if next_cursor:
                page_params.append(("cursor", next_cursor))

            try:
                async with _epe_safe_get(
                    session, API_URL, params=page_params, headers=headers,
                    timeout=aiohttp.ClientTimeout(total=30)
                ) as resp:
                    if resp.status != 200:
                        if items_out:
                            break
                        return web.json_response(
                            {"error": f"Civitai search failed ({resp.status})"},
                            status=502,
                        )
                    data = await _epe_json_capped(resp)
            except asyncio.TimeoutError:
                if items_out:
                    break
                return web.json_response(
                    {"error": "Civitai search timed out, please try again"},
                    status=504,
                )

            if not isinstance(data, dict):
                # A 200 with an empty or non-object body. Stop walking, but
                # keep whatever earlier pages already produced rather than
                # turning an upstream hiccup into a 500.
                logger.warning("epe_prompts_search: empty upstream body")
                break
            raw_items   = data.get("items") or []
            # Upstream shape is not ours to trust. A string here would iterate
            # CHARACTERS into _norm and raise AttributeError out of the handler
            # as a bare 500; a dict would iterate its keys.
            if not isinstance(raw_items, list):
                logger.warning("epe_prompts_search: upstream 'items' was %s, "
                               "not a list", type(raw_items).__name__)
                raw_items = []
            if len(raw_items) > _EPE_SEARCH_MAX_ITEMS_PER_PAGE:
                # `limit` asks for 100 and the ceiling above the JSON read is
                # 32 MB decompressed, which is tens of thousands of items —
                # every one of them normalised and signed on the event loop.
                logger.warning("epe_prompts_search: upstream page held %d "
                               "items; considering the first %d",
                               len(raw_items), _EPE_SEARCH_MAX_ITEMS_PER_PAGE)
                raw_items = raw_items[:_EPE_SEARCH_MAX_ITEMS_PER_PAGE]
            _meta = data.get("metadata")
            next_cursor = (_meta.get("nextCursor") if isinstance(_meta, dict) else None) or None
            pages_walked += 1
            scanned += len(raw_items)

            # Consume the WHOLE fetched page. nextCursor points past all
            # FETCH_LIMIT items just scanned, so stopping at ITEMS_PER_PAGE
            # mid-page made the client's next request skip everything left on
            # this page — roughly 80% of matches were unreachable. The while
            # condition above still stops FETCHING once enough are kept; a
            # response may simply carry more than ITEMS_PER_PAGE items.
            for raw in raw_items:
                if not isinstance(raw, dict):
                    continue
                norm = _norm(raw)
                if not norm or not _matches(norm["prompt"]):
                    continue
                if not _dedupe.add(_EpeSigDedupe.signature(norm["prompt"])):
                    continue
                items_out.append(norm)

            if not next_cursor:
                break

        has_more = bool(next_cursor)
        logger.info(
            f"epe_prompts_search {media_type} '{query}' page={page}: "
            f"{len(items_out)} kept from {scanned} scanned over "
            f"{pages_walked} page(s), hasMore={has_more}"
        )

        return web.json_response({
            "items":    items_out,
            "metadata": {
                "hasMore":    has_more,
                "page":       page,
                "nextCursor": next_cursor,
                "scanned":    scanned,
            },
        })

    except (_EpeUrlRejected, _EpeTooLarge, aiohttp.ClientError,
            asyncio.TimeoutError) as e:
        # The loop catches asyncio.TimeoutError only. ClientConnectorError,
        # ClientOSError and ServerDisconnectedError — civitai.com refusing the
        # connection, DNS failing, TLS resetting — fell through to the generic
        # handler below and the browser was told HTTP 500.
        return _epe_upstream_error("epe_prompts_search", e, "Civitai")
    except Exception as e:
        logger.error(f"Error in epe_prompts_search: {e}", exc_info=True)
        return web.json_response({"error": "Internal error — see the ComfyUI server log"}, status=500)


# ─────────────────────────────────────────────────────────────────────────────
# Genur.art prompt search
# ─────────────────────────────────────────────────────────────────────────────

@routes.post("/epe/prompts/search-genur")
@_epe_guard
async def epe_prompts_search_genur(request):
    """
    Search Genur.art for image prompts by topic.
    GET https://genur.art/api/search?q=...&sort=top&page=...
    Returns same shape as /epe/prompts/search: { items, metadata }
    """
    try:
        body       = await _epe_json_object(request)
        if body is None:
            return web.json_response(
                {"error": "request body must be a JSON object"}, status=400)
        query      = _epe_s(body.get("query")).strip()
        page   = _epe_page_number(body.get("page", 1))
        if page is None:
            return web.json_response({"error": "page must be a number"}, status=400)
        # Allow-listed, like the Civitai twin. Forwarded verbatim it reached
        # genur.art as whatever the caller sent — and a dict or a list came
        # out of urlencode(doseq=True) as its KEYS or ELEMENTS, so the request
        # went out with parameters nobody wrote.
        _sort_raw  = _epe_s(body.get("sort")) or "popular"
        sort       = _sort_raw if _sort_raw in ("popular", "newest", "oldest", "relevant") else "popular"
        base_models = body.get("baseModels", [])

        # Empty query is a valid browse request — Genur returns its ranked feed.
        # Genur's search API filters by a single base model (the `base_model`
        # query param); it ignores repeated/comma values, so we send just the
        # first selected model.
        url = "https://genur.art/api/search"
        params = {"q": query, "sort": sort, "page": page}
        if isinstance(base_models, list) and base_models:
            first = str(base_models[0]).strip()
            if first:
                params["base_model"] = first
        headers = {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
        }

        data = None
        for _attempt in range(2):
            try:
                async with _epe_guarded_session() as session:
                    async with _epe_safe_get(
                        session, url, params=params, headers=headers,
                        timeout=aiohttp.ClientTimeout(total=30)
                    ) as resp:
                        if resp.status != 200:
                            err = await _epe_text_capped(resp)
                            logger.warning(f"epe_prompts_search_genur {resp.status}: {err[:200]}")
                            return web.json_response({"error": f"Genur.art search failed ({resp.status})"}, status=502)
                        data = await _epe_json_capped(resp)
                break
            except asyncio.TimeoutError:
                logger.warning(f"epe_prompts_search_genur timeout (attempt {_attempt+1}/2)")
                if _attempt == 1:
                    return web.json_response({"error": "Genur.art search timed out, please try again"}, status=504)
                await asyncio.sleep(1)

        if data is None:
            return web.json_response({"error": "Genur.art search failed"}, status=502)

        if not isinstance(data, dict):
            return web.json_response(
                {"error": "Genur.art returned an unreadable response"}, status=502)
        results = data.get("results")
        if not isinstance(results, list):
            results = []
        # Bounded like the request's own `page` — this is an upstream value,
        # _epe_json_capped allows megabytes of it, and int() is O(n^2) on
        # CPython 3.10 and older — but with its OWN ceiling. Routing it
        # through _epe_page_number capped it at 100000 and turned anything
        # past that into None, which `or 1` then read as "one page": a broad
        # query whose upstream reports more than 100000 pages stopped loading
        # after page one.
        total_pages = _epe_upstream_count(data.get("totalPages", 1)) or 1

        if len(results) > _EPE_MAX_UPSTREAM_ITEMS:
            logger.warning("epe_prompts_search_genur: upstream page had %d "
                           "results — using the first %d",
                           len(results), _EPE_MAX_UPSTREAM_ITEMS)
            results = results[:_EPE_MAX_UPSTREAM_ITEMS]

        items_out = []
        for item in results:
            # `results` is type-checked above; its MEMBERS were not. A null or
            # a bare string in the list reached .get() and threw the whole page
            # away as a 500. Genur also returns `"url": null` and numeric ids,
            # and a key that is present with a non-string value never takes the
            # "" default — so .lower() got a None.
            if not isinstance(item, dict):
                continue
            if item.get("is_nsfw", False):
                continue
            prompt = _epe_s(item.get("prompt"))
            if not prompt:
                continue
            item_type = _epe_s(item.get("type")) or "image"  # Genur returns "image" or "video"
            item_url  = _epe_s(item.get("url"))
            is_png    = item_url.lower().endswith(".png") or (".png" in item_url.lower().split("?")[0])
            items_out.append({
                "id":        str(item.get("id", "")),
                "imageUrl":  item_url if item_type != "video" else "",
                "videoUrl":  item_url if item_type == "video" else "",
                "mediaType": item_type,
                "isPng":     is_png,
                "name":      _epe_s(item.get("username")),
                "prompt":    prompt,
                "model":     _epe_s(item.get("base_model")),
                "tags":      _epe_l(item.get("tags")),
                "steps":     "",
                "cfg":       "",
                "sampler":   "",
                "seed":      "",
            })

        has_more = page < total_pages
        logger.info(f"epe_prompts_search_genur '{query}' page={page}: {len(items_out)} items, hasMore={has_more}")

        return web.json_response({
            "items":    items_out,
            "metadata": {"hasMore": has_more, "page": page},
        })

    except (_EpeUrlRejected, _EpeTooLarge, aiohttp.ClientError,
            asyncio.TimeoutError) as e:
        # As above: only asyncio.TimeoutError had a handler, so genur.art being
        # down was reported as a ComfyUI 500.
        return _epe_upstream_error("epe_prompts_search_genur", e, "Genur.art")
    except Exception as e:
        logger.error(f"Error in epe_prompts_search_genur: {e}", exc_info=True)
        return web.json_response({"error": "Internal error — see the ComfyUI server log"}, status=500)


# What one upstream page may contribute, whatever it claims to hold.
# /epe/prompts/search has bounded its page at ITEMS_PER_PAGE since it was
# written; the Genur and workflow handlers bounded nothing, and the only
# ceiling left was _epe_json_capped's byte budget — tens of thousands of small
# objects. In the workflow handler each survivor also becomes one outbound
# gating request to civitai.com, so an oversized page turned into a flood that
# earns a 429 — which makes the gating check fail open and puts login-gated
# cards back in the list.
_EPE_MAX_UPSTREAM_ITEMS = 200

_EPE_WF_JSON_MAX = 4 * 1024 * 1024    # decompressed workflow ceiling
# Was 16 MB. A json.loads of a 16 MB workflow held the loop 0.7 s per call and
# was reachable via a raw-JSON downloadUrl (client-supplied). A complex
# workflow with hundreds of nodes is still comfortably under 1 MB; 4 MB is
# ample headroom and caps the worst-case freeze at ~0.2 s.
# A workflow export is a handful of files. Four thousand is already absurd for
# one, and well under the point where the central directory costs anything.
_EPE_ZIP_MAX_MEMBERS = 4096


def _epe_zip_entry_count(data):
    """Declared member count from the End Of Central Directory record, or -1.

    zipfile.ZipFile()'s CONSTRUCTOR parses the whole central directory and
    builds one ZipInfo per member, before any caller-side ceiling can apply.
    Measured on archives whose members are all empty:

        declared members   archive    ZipFile() alone   peak RSS added
           65,000           6.2 MB       0.33 s            8.6 MB
          260,000          25  MB        1.36 s           22.4 MB
          700,000          67  MB        4.44 s           73.6 MB

    downloadUrl is client-supplied and the download ceiling is 64 MB, so the
    bottom row is one request, and the parse is C-level: the GIL is held for
    most of those seconds, so "it runs in the pool" is not a mitigation. The
    count is a 16-bit field twelve bytes into the EOCD record, which sits
    within 22 + 65535 bytes of the end, so it is read off a buffer already in
    memory in constant time — 26 microseconds on that same 67 MB archive.
    -1 means "no EOCD" — left to zipfile, which reports the corruption with a
    better message than anything invented here.

    NOTE: this count is NOT what bounds the constructor — see
    _epe_zip_cd_size, which is. It is kept because it is free and because it
    gives an honest archive a better error message.
    """
    n = len(data)
    if n < 22:
        return -1
    i = data.rfind(b"PK\x05\x06", max(0, n - (22 + 65535)))
    if i < 0 or i + 22 > n:
        return -1
    return int.from_bytes(data[i + 10:i + 12], "little")


# A central-directory file header is 46 bytes before its variable-length name,
# so this is a hard upper bound on how many records the constructor can build.
_EPE_ZIP_CD_MIN_RECORD = 46


def _epe_zip_cd_bounds(data):
    """(size_cd, is_zip64) — the loop bound zipfile will really use, or -1.

    THIRD REWRITE, and the previous two were both provably evadable. Read
    CPython's `_RealGetContents` before touching this:

        concat    = endrec[_ECD_LOCATION] - size_cd - offset_cd
        start_dir = offset_cd + concat            # == LOCATION - size_cd
        fp.seek(start_dir); data = fp.read(size_cd)
        total = 0
        while total < size_cd: ...                # one ZipInfo per record

    `offset_cd` CANCELS. It appears on both sides and contributes nothing to
    where the walk starts or how far it runs; only `size_cd` bounds the loop.
    So round 40's span — `EOCD_position - offset_cd` — measured a quantity
    zipfile never consults, and an archive that simply wrote a different
    `offset_cd` walked straight past it. Measured on the shipped round-40
    build: a 5.5 MB archive of 60,000 members with `offset_cd` set to
    0xFFFFFFFF (span -1, and -1 is not > the ceiling) or to `EOCD - 46`
    (span 46) was ACCEPTED, and ZipFile then built all 60,001 ZipInfo
    objects. Scaled to the 64 MB fetch ceiling that is ~1.4 million objects
    and ~54 seconds with the GIL held.

    `size_cd` is a field an attacker writes, but understating it does not
    help: the walk is then short and lands mid-record, and zipfile raises
    BadZipFile. The ONE way it lied was the Zip64 overwrite — `_EndRecData64`
    replaces `endrec[_ECD_SIZE]` with the 64-bit dirsize unconditionally —
    and that is refused outright by the flag returned here.

    is_zip64 is exact, not a heuristic: `_EndRecData64` seeks to
    `EOCD_position - 20` and requires the `PK\x06\x07` signature there, so
    the locator is at that offset or CPython does not use it either.
    """
    n = len(data)
    if n < 22:
        return -1, False
    i = data.rfind(b"PK\x05\x06", max(0, n - (22 + 65535)))
    if i < 0 or i + 22 > n:
        return -1, False
    is_zip64 = i >= 20 and data[i - 20:i - 16] == b"PK\x06\x07"
    return int.from_bytes(data[i + 12:i + 16], "little"), is_zip64


def _epe_upstream_count(raw, ceiling=1_000_000_000):
    """A count an UPSTREAM reported, bounded but not narrowed.

    Same shape as _epe_page_number — the length guard runs before the
    conversion, so a megabyte-long digit string never reaches int() — but with
    a ceiling that fits a page count rather than a page number, and no lower
    bound beyond zero.
    """
    if isinstance(raw, bool):
        return None
    try:
        if isinstance(raw, int):
            n = raw
        elif isinstance(raw, float):
            n = int(raw)                    # inf / nan raise, caught below
        elif isinstance(raw, str):
            s = raw.strip()
            if not s or len(s) > 12:
                return None
            body = s[1:] if s[:1] in "+-" else s
            if not body.isascii() or not body.isdigit():
                return None
            n = int(s)
        else:
            return None
    except (ValueError, OverflowError):
        return None
    if n < 0:
        return None
    return n if n <= ceiling else ceiling


def _epe_parse_workflow_bytes(file_bytes):
    """Decode a downloaded workflow — ZIP member or raw JSON — size-bounded.

    Both branches used to run inline with no ceiling, so a 1.5 MB archive that
    expands to 1.5 GB froze ComfyUI for seventeen seconds and the MemoryError
    was swallowed as a parse failure. downloadUrl is client-supplied, so
    neither the archive nor its members can be trusted.
    """
    if file_bytes[:4] == b'PK\x03\x04':
        # Zip64 FIRST, because its presence is what makes every field in the
        # classic record unusable as a bound — CPython overwrites them from
        # the Zip64 record without looking. Python writes a Zip64 trailer only
        # past 65,535 entries or 4 GB, so a workflow export is never one.
        _cd_size, _is_zip64 = _epe_zip_cd_bounds(file_bytes)
        _cd_max = _EPE_ZIP_MAX_MEMBERS * _EPE_ZIP_CD_MIN_RECORD
        if _is_zip64:
            raise _EpeTooLarge("workflow archive is Zip64; too large to open")
        # Then `size_cd`, which with Zip64 refused is exactly the number of
        # bytes zipfile's constructor walks, one ZipInfo per 46-byte record.
        if _cd_size > _cd_max:
            raise _EpeTooLarge(
                f"workflow archive's directory is larger than "
                f"{_cd_max // 1024} KB")
        # And a bound that does not read a declared field at all. Every record
        # zipfile builds needs a literal PK\x01\x02 at its own position or the
        # constructor raises, so this is a hard ceiling on the work no header
        # can misstate — which is the property the last three attempts each
        # turned out to lack. Measured: 24 ms on a 64 MB body, in a pool
        # worker, once per download.
        if file_bytes.count(b"PK\x01\x02") > _EPE_ZIP_MAX_MEMBERS:
            raise _EpeTooLarge(
                f"workflow archive holds more than "
                f"{_EPE_ZIP_MAX_MEMBERS} directory records")
        _members = _epe_zip_entry_count(file_bytes)
        # 0xFFFF in that 16-bit field means "the real number is in the Zip64
        # record". Refusing is both cheaper than chasing the Zip64 locator and
        # correct: 65,535 members is two orders of magnitude past anything a
        # workflow export contains.
        if _members >= 0xFFFF or _members > _EPE_ZIP_MAX_MEMBERS:
            raise _EpeTooLarge(
                f"workflow archive declares more than "
                f"{_EPE_ZIP_MAX_MEMBERS} entries")
        with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
            names = [n for n in zf.namelist() if n.endswith('.json')]
            if not names:
                return None
            # Rank, then VERIFY. Sorting on "workflow appears in the path" was
            # not enough: in an archive where every member lives under
            # workflows/ the term matches all of them and the tie-break becomes
            # "shortest path wins", which picked config.json over the graph.
            def _rank(n):
                base = n.rsplit('/', 1)[-1].lower()
                return (0 if 'workflow' in base else 1,
                        -zf.getinfo(n).file_size)
            names.sort(key=_rank)
            first_dict = None
            # ONE budget across every candidate, not one each.
            #
            # `names[:8]` with a 16 MB per-member ceiling meant an archive
            # could buy 128 MB of json.loads from a download the 64 MB fetch
            # cap was happy with — and because ZIP compresses JSON so well,
            # from a *tiny* one. Measured: a 131 KB archive of eight 16 MB
            # members froze the event loop for 3.45 s, and a 24 MB one for
            # 7.86 s with a single contiguous 1.48 s gap.
            #
            # Running in _EPE_POOL does not help. json.loads is one C call and
            # holds the GIL for its whole duration, so unlike the Python-level
            # parsers in this file it stalls ComfyUI outright rather than just
            # costing throughput.
            _json_budget = _EPE_WF_JSON_MAX
            # Why did we stop looking? Empty means "we examined every
            # candidate and none of them was a graph" — the only case in which
            # falling back to `first_dict` is an honest answer. Anything else
            # means a candidate the user may have been asking for was never
            # read, and returning something lesser in its place is the
            # silently-wrong-workflow failure this whole block exists to stop.
            _refused = ""
            # names[:8] is itself a refusal. _rank sorts 'workflow'-named
            # members first and then by DESCENDING size, so an archive with
            # eight metadata blobs larger than the graph ranks the graph out
            # of the window entirely — nothing is over-size, no budget is
            # touched, and a decoy was returned with HTTP 200 and nodeCount 0.
            # The frontend caches that object, so Load Workflow put the
            # metadata blob on the user's canvas.
            if len(names) > 8:
                _refused = ("the archive has more JSON files than can be "
                            "examined (%d)" % len(names))
            for _name in names[:8]:
                info = zf.getinfo(_name)
                if info.file_size > _EPE_WF_JSON_MAX:
                    _refused = ("a workflow entry exceeded %d MB"
                                % (_EPE_WF_JSON_MAX // (1024 * 1024)))
                    continue
                if _json_budget <= 0:
                    # The remaining candidates are unexamined, and one of
                    # them may be the graph.
                    _refused = ("the archive's JSON exceeded the %d MB parse "
                                "budget" % (_EPE_WF_JSON_MAX // (1024 * 1024)))
                    break
                # The read is inside the try as well: an encrypted member
                # raises RuntimeError, an unsupported method raises
                # NotImplementedError, a bad CRC raises BadZipFile — and any
                # of those escaping the loop threw away a perfectly good
                # workflow sitting one candidate further down.
                _cap = min(_json_budget, _EPE_WF_JSON_MAX)
                try:
                    with zf.open(info) as fh:
                        raw = fh.read(_cap + 1)
                    # file_size is what the archive claims; this is what it
                    # delivered. Charged either way — a member that overruns
                    # what is left has still cost the read.
                    _json_budget -= len(raw)
                    if len(raw) > _cap:
                        # Not necessarily an over-size entry: `_cap` is what
                        # is LEFT of the shared budget, so a perfectly ordinary
                        # member can overrun it. Saying "entry exceeded 4 MB"
                        # here told the user to shrink something already
                        # inside the limit.
                        _refused = ("the archive's JSON exceeded the %d MB "
                                    "parse budget"
                                    % (_EPE_WF_JSON_MAX // (1024 * 1024)))
                        continue
                    _obj = json.loads(raw.decode('utf-8', errors='replace'))
                except Exception as _e:
                    logger.warning(
                        f"epe workflow archive: skipping {_name}: {_e}")
                    continue
                if not isinstance(_obj, dict):
                    continue
                # A ComfyUI graph has one of these; a manifest or a config
                # does not. This is a PREFERENCE, not a filter — some
                # legitimate exports wrap the graph — so a dict without them
                # is held back and only used if nothing better turns up.
                if 'nodes' in _obj or 'last_node_id' in _obj:
                    return _obj
                if first_dict is None:
                    first_dict = _obj
            # A graph would already have returned above — the return is
            # INSIDE the loop, so a graph found within budget can never be
            # pre-empted by the refusal below.
            #
            # Reaching here with `_refused` set means a candidate that might
            # have been the graph was never examined AND something lesser
            # parsed: a settings blob, a manifest, or the `workflow_api.json`
            # that Civitai packs ship beside the real graph. Returning that
            # was worse than returning nothing — the handler read `nodes` off
            # it, got [], and answered 200 with nodeCount 0 and no error, so
            # the user got a DIFFERENT workflow than the one they clicked with
            # no indication anything was wrong, and the frontend then cached
            # it behind the Load Workflow button.
            #
            # Refuse instead, and say which of the three reasons it was.
            if _refused:
                raise _EpeTooLarge(_refused)
            if first_dict is not None:
                return first_dict
            # Backstop, currently unreachable — and deliberately kept.
            #
            # Reaching here needs `_refused` empty, which since the
            # `len(names) > 8` guard means every member WAS examined, which
            # means an over-size one would already have set `_refused`.
            # Instrumented over 6,000 randomised archives: entered zero times.
            # It stays because it is the only thing standing between a future
            # change to the refusal bookkeeping and a silent 200 with the
            # wrong workflow, which is the failure this whole block exists to
            # prevent.
            if any(zf.getinfo(n).file_size > _EPE_WF_JSON_MAX for n in names):
                raise _EpeTooLarge(
                    f"workflow entry exceeded {_EPE_WF_JSON_MAX // (1024 * 1024)} MB")
            return None
    if len(file_bytes) > _EPE_WF_JSON_MAX:
        raise _EpeTooLarge(
            f"workflow file exceeded {_EPE_WF_JSON_MAX // (1024 * 1024)} MB")
    _obj = json.loads(file_bytes.decode('utf-8', errors='replace'))
    return _obj if isinstance(_obj, dict) else None


# ─────────────────────────────────────────────────────────────────────────────
# Workflow extraction — reads ComfyUI workflow from a PNG tEXt chunk
# ─────────────────────────────────────────────────────────────────────────────

_EPE_PNG_MAX_CHUNKS      = 4096              # a real PNG has a handful
# One warning per image, not one per chunk. A crafted PNG can carry thousands
# of failing chunks, and each used to write a line into ComfyUI's own log.
_EPE_PNG_MAX_TEXT_BYTES  = 16 * 1024 * 1024  # decompressed ceiling per chunk
# ...and across ALL of them. A per-chunk ceiling bounds nothing on its own:
# every chunk is kept in `chunks`, so 4096 of them multiply it by 4096.
_EPE_PNG_MAX_TOTAL_BYTES = 32 * 1024 * 1024


def _epe_inflate_capped(data, limit=_EPE_PNG_MAX_TEXT_BYTES):
    """zlib.decompress with an output ceiling.

    A zTXt chunk is attacker-controlled: two megabytes of compressed zeros
    expand to two gigabytes, which is tens of seconds of frozen event loop and,
    with a larger chunk, an out-of-memory kill of the whole ComfyUI process.
    decompressobj stops at the ceiling instead of finding out afterwards.
    """
    if limit <= 0:
        raise _EpeTooLarge("PNG text budget exhausted")
    d = zlib.decompressobj()
    out = d.decompress(data, limit + 1)
    if len(out) > limit or d.unconsumed_tail:
        raise _EpeTooLarge(
            f"compressed PNG text chunk exceeded its {limit} byte allowance")
    if not d.eof:
        # zlib.decompress raised on a truncated stream; decompressobj does
        # not. Returning the partial inflate handed the client half a
        # workflow and called it whole. ValueError, not _EpeTooLarge:
        # the callers map that to 413, and this is not a size problem.
        raise ValueError("compressed PNG text chunk is truncated")
    return out


def _parse_png_workflow(img_bytes):
    """
    Parse PNG tEXt/iTXt/zTXt chunks and return the workflow and prompt dicts.
    Returns (workflow_json_or_None, prompt_str_or_None).
    """
    if img_bytes[:8] != b'\x89PNG\r\n\x1a\n':
        return None, None
    chunks = {}
    pos = 8
    total = len(img_bytes)
    text_total = 0
    _png_over_warned = False
    # Bounded walk. The old `while` had no ceiling, so a response that is not
    # really a PNG — 64 MB of zero padding behind a valid signature — parsed as
    # millions of zero-length chunks. Blocking CPU either way, hence the
    # executor at the call site.
    for _n in range(_EPE_PNG_MAX_CHUNKS):
        if pos > total - 12:
            break
        try:
            length  = struct.unpack('>I', img_bytes[pos:pos+4])[0]
            ctype_b = img_bytes[pos+4:pos+8]
            # A chunk type is four ASCII letters. Anything else means we have
            # lost sync with the stream, and walking on from there is exactly
            # how the zero-padding case turned into millions of iterations.
            if not ctype_b.isalpha():
                break
            if length > total - pos:
                break
            ctype = ctype_b.decode('ascii', errors='replace')
            cdata = img_bytes[pos+8:pos+8+length]
            if ctype in ('tEXt', 'iTXt', 'zTXt') and b'\x00' in cdata:
                null_pos  = cdata.index(b'\x00')
                key       = cdata[:null_pos].decode('utf-8', errors='replace')
                val_raw   = cdata[null_pos+1:]
                # Charged in BYTES, taken before the decode. len() on the
                # decoded str counts CHARACTERS, so a chunk of astral
                # characters charged a quarter of what it actually held and
                # the real ceiling was four times the stated one.
                _bytes_in = 0
                if ctype == 'zTXt' and len(val_raw) > 1:
                    _room = min(_EPE_PNG_MAX_TEXT_BYTES,
                                _EPE_PNG_MAX_TOTAL_BYTES - text_total)
                    try:
                        _raw = _epe_inflate_capped(val_raw[1:], _room)
                        _bytes_in = len(_raw)
                        val = _raw.decode('utf-8', errors='replace')
                    except (_EpeTooLarge, ValueError) as _e:
                        # CHARGED, and logged once.
                        #
                        # _bytes_in was set only from a successful inflate, so
                        # a chunk that tripped the per-chunk ceiling advanced
                        # `text_total` by nothing and the total-budget break
                        # below could never fire — the walk ran all 4096
                        # chunks. Measured: a 64 MB PNG of zlib bombs inflated
                        # 60 GB, held a pool worker for 48 s and wrote 325 KB
                        # of log, against a stated 32 MB total budget.
                        _bytes_in = _room
                        if not _png_over_warned:
                            _png_over_warned = True
                            logger.warning(f"_parse_png_workflow: {_e}")
                        val = ''
                    except Exception: val = ''
                elif ctype == 'iTXt':
                    try:
                        # Clamped BEFORE the decode, the same way zTXt already
                        # is. These two branches took the whole chunk, kept it,
                        # and only then charged the total — so one uncompressed
                        # chunk sized just under the image pushed the retained
                        # bytes to the ceiling PLUS a whole chunk, which at the
                        # 64 MB fetch limit is twice what the constant claims.
                        _room = max(0, _EPE_PNG_MAX_TOTAL_BYTES - text_total)
                        # rfind, not split. `split` builds one list element
                        # per NUL in the WHOLE chunk before the slice can bound
                        # anything: measured, a 64 MB chunk of NULs made
                        # 64,000,001 elements, 0.76 s and +423 MB in a pool
                        # worker — which is what the clamp was added to stop.
                        _sep = val_raw.rfind(b'\x00')
                        _raw = (val_raw[_sep + 1:] if _sep >= 0 else val_raw)[:_room]
                        _bytes_in = len(_raw)
                        val = _raw.decode('utf-8', errors='replace')
                    except Exception: val = ''
                else:
                    _room = max(0, _EPE_PNG_MAX_TOTAL_BYTES - text_total)
                    _raw = val_raw[:_room]
                    _bytes_in = len(_raw)
                    val = _raw.decode('utf-8', errors='replace')
                chunks[key] = val
                text_total += _bytes_in
                # `>= `, not `> `. Every branch now clamps to the remaining
                # room, so `text_total` can reach the budget exactly but never
                # pass it — and the strict test became unreachable, leaving the
                # walk to run on to _EPE_PNG_MAX_CHUNKS storing '' for every
                # chunk after the budget was spent.
                if text_total >= _EPE_PNG_MAX_TOTAL_BYTES:
                    logger.warning(
                        "_parse_png_workflow: text chunks exceeded the total budget")
                    break
            pos += 12 + length
            if ctype == 'IEND':
                break
        except Exception:
            break
    workflow_str = chunks.get('workflow') or chunks.get('Workflow') or ''
    prompt_str   = chunks.get('prompt')   or chunks.get('Prompt')   or ''
    workflow = None
    if workflow_str:
        try: workflow = json.loads(workflow_str)
        except Exception: pass

    # A1111 / Forge / Fooocus and most SD web UIs write no ComfyUI chunks at
    # all — everything goes into one plain-text `parameters` chunk. Without
    # this, those images came back with no prompt even though the prompt was
    # right there in the file.
    if not prompt_str:
        params = chunks.get('parameters') or chunks.get('Parameters') or ''
        if params:
            prompt_str = _epe_a1111_positive(params)

    return workflow, (prompt_str or None)


def _epe_a1111_positive(text):
    """Pull the positive prompt out of an A1111-family `parameters` blob.

    The blob is:

        <positive prompt, may span lines>
        Negative prompt: <negative, may span lines>
        Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, Size: 512x512, ...

    Only the last line is the settings line, and only when it actually looks
    like one — a prompt may contain a colon, so a repeated "Key: value,"
    shape is required rather than merely the presence of a colon.
    """
    if not text:
        return ''
    # NO split(). This blob is a PNG text chunk inflated to
    # _EPE_PNG_MAX_TEXT_BYTES (16 MB) before it reaches here, and 16 MB of
    # newlines became a sixteen-million-element list — measured, a valid
    # 16,386-byte PNG cost 1.52 s of a pool worker and +160 MB resident.
    # Everything below needs two indices: where the last non-blank line
    # starts, and where the negative marker is.
    body = text.replace('\r\n', '\n')
    # Trailing blank lines first — plenty of tools end the chunk with a
    # newline, and with one present the last line is "" and the settings line
    # is never recognised. (The JavaScript side had the same bug; there it
    # also glued the settings onto the negative prompt.)
    #
    # ONE C-level scan, not one Python iteration per blank line. rstrip finds
    # the last non-whitespace character; the region to keep ends at the end of
    # the LINE that character is on — which is where the next newline is, so
    # any trailing spaces on that line survive exactly as they did before.
    _k = len(body.rstrip())
    if _k == 0:
        end = 0
    else:
        _nl = body.find('\n', _k)
        end = len(body) if _nl < 0 else _nl
    if end > 0:
        ls = body.rfind('\n', 0, end) + 1
        if _epe_looks_like_settings(body[ls:end].strip()):
            end = ls - 1 if ls > 0 else 0
    body = body[:end]
    neg = _epe_find_negative_marker(body)
    positive = body[:neg] if neg != -1 else body
    return positive.strip()


@routes.post("/epe/prompts/extract-workflow")
@_epe_guard
async def epe_prompts_extract_workflow(request):
    """
    Fetch a Civitai/Genur image at its original URL and extract the embedded
    ComfyUI workflow JSON from PNG metadata.
    POST body: { "imageUrl": "<url>" }
    Returns: { "workflow": {...}, "hasWorkflow": bool, "source": "civitai"|"genur" }
    """
    try:
        body      = await _epe_json_object(request)
        if body is None:
            return web.json_response(
                {"error": "request body must be a JSON object"}, status=400)
        image_url = _epe_s(body.get("imageUrl")).strip()
        if not image_url:
            return web.json_response({"error": "Missing imageUrl"}, status=400)
        _m_err = await _epe_dns_check_msg(_epe_check_media_url, image_url)
        if _m_err:
            return web.json_response({"error": _m_err}, status=400)

        # Ensure we request the original (metadata-preserving) URL
        _host = (urlparse(image_url).hostname or "").lower()
        if _host == "civitai.com" or _host.endswith(".civitai.com"):
            # Strip any existing suffix and append original=true
            base = image_url.split("/width=")[0].split("/original=")[0].rstrip("/")
            fetch_url = base + "/original=true"
            source = "civitai"
        else:
            fetch_url = image_url
            source = "genur"

        # Ask for 1 MB: PNG text chunks live before the image data, but
        # large (subgraph-heavy) workflows can exceed 128 KB and a
        # truncated chunk parses silently as "no workflow". Range is a
        # request, not a limit — a server may ignore it and answer 200
        # with the lot, so the real ceiling is _epe_read_capped.
        headers = {"User-Agent": "Mozilla/5.0", "Accept": "image/*,*/*", "Range": "bytes=0-1048575"}
        img_bytes = None
        for _attempt in range(2):
            try:
                async with _epe_guarded_session() as session:
                    async with _epe_safe_get(
                        session, fetch_url, headers=headers,
                        timeout=aiohttp.ClientTimeout(total=10)
                    ) as resp:
                        if resp.status not in (200, 206):
                            return web.json_response({"error": f"Image fetch failed ({resp.status})"}, status=502)
                        img_bytes = await _epe_read_capped(resp)
                break
            except _EpeUrlRejected as _e:
                return web.json_response({"error": str(_e)}, status=400)
            except _EpeTooLarge as _e:
                return web.json_response({"error": str(_e)}, status=413)
            except asyncio.TimeoutError:
                if _attempt == 1:
                    return web.json_response({"error": "Image fetch timed out"}, status=504)
                await asyncio.sleep(1)

        if not img_bytes:
            return web.json_response({"error": "Image fetch failed"}, status=502)

        # Off the loop: even bounded, this is CPU work on up to 64 MB, and
        # it shares the loop with the user's image generation.
        workflow, prompt_str = await asyncio.get_running_loop().run_in_executor(
            _EPE_POOL, _parse_png_workflow, img_bytes)
        workflow_format = "graph" if workflow is not None else None

        # Fallback: images saved via ComfyUI's "Save (API format)" carry only a
        # 'prompt' chunk holding the API-format graph. Modern ComfyUI frontends
        # can load that directly, so surface it when no 'workflow' chunk exists.
        if workflow is None and prompt_str:
            try:
                # In the POOL, like the parse two lines above and for the same
                # reason: prompt_str is up to _EPE_PNG_MAX_TEXT_BYTES of a
                # stranger's JSON, and a PNG with no `workflow` chunk steers
                # straight into this branch — which was the one place the
                # executor hop the handler paid for did not apply.
                api_wf = await asyncio.get_running_loop().run_in_executor(
                    _EPE_POOL, json.loads, prompt_str)
                if isinstance(api_wf, dict) and any(
                    isinstance(v, dict) and "class_type" in v for v in api_wf.values()
                ):
                    workflow = api_wf
                    workflow_format = "api"
            except Exception:
                pass

        has_workflow = workflow is not None

        logger.info(
            f"epe_prompts_extract_workflow {source} has_workflow={has_workflow} "
            f"format={workflow_format} url={fetch_url[-60:]}"
        )
        return web.json_response({
            "hasWorkflow":    has_workflow,
            "workflow":       workflow,
            "workflowFormat": workflow_format,
            "source":         source,
        })

    except (aiohttp.ClientError, asyncio.TimeoutError, _EpeTooLarge,
            _EpeUrlRejected, OSError) as e:
        # The image host being unreachable is not a bug in this plugin. The
        # fetch loop catches only _EpeUrlRejected, _EpeTooLarge and
        # asyncio.TimeoutError, so a connection reset landed here and the
        # browser was told HTTP 500.
        return _epe_upstream_error("epe_prompts_extract_workflow", e, "The image host")
    except Exception as e:
        logger.error(f"Error in epe_prompts_extract_workflow: {e}", exc_info=True)
        return web.json_response({"error": "Internal error — see the ComfyUI server log"}, status=500)


# ─────────────────────────────────────────────────────────────────────────────
# Workflow search — Civitai ComfyUI workflows
# ─────────────────────────────────────────────────────────────────────────────

@routes.post("/epe/prompts/search-workflows")
@_epe_guard
async def epe_prompts_search_workflows(request):
    """
    Search Civitai for ComfyUI workflows (type=Workflows).
    POST body: { "query": str, "page": int, "source": "all"|"civitai" }
    Returns: { items: [{id, source, title, description, coverUrl, nodeCount, customNodes, hasWorkflow}], metadata }
    """
    try:
        body   = await _epe_json_object(request)
        if body is None:
            return web.json_response(
                {"error": "request body must be a JSON object"}, status=400)
        query  = _epe_s(body.get("query")).strip()
        page = _epe_page_number(body.get("page", 1))
        if page is None:
            return web.json_response({"error": "page must be a number"}, status=400)
        source = body.get("source", "all")  # "all" | "civitai"
        # Civitai pages relevance-ranked results by opaque cursor, not by
        # page number. Empty on the first request of a search.
        cursor = str(body.get("cursor") or "").strip()

        IMAGE_CDN = "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA"
        items_out = []
        next_cursor = ""
        upstream_err = ""
        # The status that goes with it. Every round that fails now records one,
        # so a total failure can be reported as 502/504/413 instead of the
        # HTTP 200 that made a Civitai outage indistinguishable from an empty
        # catalogue.
        upstream_status = 502
        upstream_more = False

        # ── Civitai workflows via the public REST API ─────────────────────
        # /api/v1/models does support a free-text `query` parameter, so unlike
        # the image feed this is a straight swap off Meilisearch.
        if source in ("all", "civitai"):
            API_URL = "https://civitai.com/api/v1/models"
            civ_headers = {
                "Accept":     "application/json",
                "User-Agent": "ComfyUI-Enhanced-Prompt-Editor",
            }

            def _wf_params(cur):
                # Sending `query` and `page` together is a hard 400 from Civitai:
                # a query switches the endpoint to relevance ranking, which is
                # cursor-paged only. Browse by page, search by cursor.
                p = [("types", "Workflows"), ("limit", "20"), ("nsfw", "false")]
                if query:
                    p.append(("query", query))
                    if cur:
                        p.append(("cursor", cur))
                else:
                    p.append(("page", str(page)))
                    p.append(("sort", "Highest Rated"))
                return p

            def _wf_map(hit):
                # Total by construction. Every line here used to assume a
                # shape: "modelVersions" an array of objects, "images" an array
                # of objects, "files" an array of objects, "description" a
                # string. `"modelVersions": "v1"` indexed a CHARACTER; a list
                # of plain image URLs raised AttributeError; `"files": "none"`
                # iterated its letters. This function is called from a
                # comprehension that sits OUTSIDE the round's try, so any of
                # those threw away every workflow collected in earlier rounds
                # as well.
                hit   = _epe_d(hit)
                _mvs  = _epe_l(hit.get("modelVersions"))
                mv    = _epe_d(_mvs[0]) if _mvs else {}
                imgs  = _epe_l(mv.get("images"))
                files = _epe_l(mv.get("files"))
                cover_url = ""
                if imgs:
                    raw_url = _epe_s(_epe_d(imgs[0]).get("url"))
                    if raw_url:
                        cover_url = (
                            raw_url if raw_url.startswith("http")
                            else f"{IMAGE_CDN}/{raw_url}/width=450"
                        )
                wf_file = next(
                    (f for f in files
                     if isinstance(f, dict) and f.get("type") in ("Model", "Archive")),
                    None,
                )
                download_url = _epe_s(_epe_d(wf_file).get("downloadUrl"))
                # Truncated FIRST. _epe_strip_tags' own docstring says
                # "every caller truncates to 1000 chars straight afterwards,
                # so there is nothing to gain from scanning megabytes" — and
                # then this passed it up to 200,000, ran six more full-string
                # entity replacements over the result, and truncated at the
                # end. Measured: 0.37 s of blocked event loop for one page of
                # 80 items with 200 KB descriptions.
                desc = _epe_strip_tags(_epe_s(hit.get("description"))[:4000])
                for ent, ch in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                                ("&quot;", '"'), ("&#39;", "'"), ("&nbsp;", " ")]:
                    desc = desc.replace(ent, ch)
                return {
                    "id":          str(hit.get("id", "")),
                    "source":      "civitai",
                    "title":       _epe_s(hit.get("name")),
                    "description": " ".join(desc.split())[:1000],
                    "coverUrl":    cover_url,
                    "nodeCount":   0,
                    "customNodes": [],
                    "downloadUrl": download_url,
                    "versionId":   str(mv.get("id", "")),
                    "hasWorkflow": bool(download_url),
                }

            # Most current workflows require the downloader to be logged in, and
            # those can never load here — so drop them rather than offer a card
            # that always fails. A whole upstream page is often gated, which
            # would look like the end of the results, so a QUERY keeps walking
            # cursors until enough open ones are found (bounded, so one search
            # cannot turn into an unbounded crawl). Browsing cannot walk here,
            # because the client owns the page number: it gets an empty page
            # with hasMore set, and the client asks for the next one.
            session = _get_session()
            cur = cursor
            _deadline = asyncio.get_running_loop().time() + _EPE_WF_BUDGET_S
            for _round in range(_EPE_WF_MAX_ROUNDS):
                if asyncio.get_running_loop().time() > _deadline:
                    logger.info("epe_prompts_search_workflows: time budget reached")
                    break
                try:
                    async with _epe_safe_get(
                        session, API_URL, params=_wf_params(cur),
                        headers=civ_headers,
                        timeout=aiohttp.ClientTimeout(total=20)
                    ) as resp:
                        if resp.status != 200:
                            upstream_err = f"Civitai returned HTTP {resp.status}"
                            logger.warning(
                                f"epe_prompts_search_workflows upstream {resp.status}")
                            break
                        civ_data = await _epe_json_capped(resp)
                        if not isinstance(civ_data, dict):
                            # A 200 with an empty body is an upstream hiccup,
                            # not a reason to 500 and throw away the results
                            # already collected — but it is still an error,
                            # and reporting it as an empty result set makes a
                            # Civitai blip read as "no workflows exist".
                            upstream_err = "empty response from Civitai"
                            logger.warning(
                                "epe_prompts_search_workflows: empty upstream body")
                            break
                except Exception as e:
                    # Was `str(e) or e.__class__.__name__`, handed to the
                    # browser verbatim below: aiohttp's connector errors carry
                    # the host, the port and the OS error text, the SSRF guard
                    # names the resolved private address, and an exception with
                    # an empty message contributed a bare Python class name.
                    upstream_err, upstream_status = _epe_upstream_reason(e, "Civitai")
                    logger.warning("epe_prompts_search_workflows civitai error: %s: %s",
                                   type(e).__name__, e)
                    # One page being too big is not a reason to throw away the
                    # pages that already came back. `items_out` is returned
                    # below with the error attached, which the client already
                    # renders as "Some results unavailable: …" over the cards
                    # it did get; only an EMPTY result set turns into a status
                    # code. Round 46 lost this by tightening the byte cap
                    # until the first page tripped it.
                    if isinstance(e, _EpeTooLarge) and items_out:
                        upstream_status = 200
                    break

                hits = civ_data.get("items") or []
                if not isinstance(hits, list):
                    # A non-list "items" would blow up in _wf_map below, which
                    # sits outside this round's try.
                    hits = []
                if len(hits) > _EPE_MAX_UPSTREAM_ITEMS:
                    # Bounded BEFORE _wf_map, so the mapping, the gather and
                    # the outbound gating requests all inherit it. `upstream_more`
                    # below is `len(hits) >= 20`, which a 200-item trim leaves
                    # true — so a trimmed page still reads as "there is more"
                    # and the cursor keeps walking.
                    logger.warning("epe_prompts_search_workflows: upstream page "
                                   "had %d items — using the first %d",
                                   len(hits), _EPE_MAX_UPSTREAM_ITEMS)
                    hits = hits[:_EPE_MAX_UPSTREAM_ITEMS]
                upstream_more = len(hits) >= 20
                # Advance before the empty check. Breaking with `cur` still
                # pointing at the page just consumed handed the client a cursor
                # it had already walked, alongside hasMore=True.
                # `"metadata": "none"` is truthy, so `or {}` did not catch it
                # and .get() raised — here, AFTER the round's own try, so the
                # results already collected went with it.
                cur = str(_epe_d(civ_data.get("metadata")).get("nextCursor") or "")
                if not hits:
                    break

                # Per item. _wf_map is total now, but this comprehension sits
                # outside the round's try, so anything that escapes it still
                # discards every workflow collected so far — belt and braces on
                # the one line where the cost of a surprise is the whole page.
                mapped = []
                for _h in hits:
                    try:
                        _m = _wf_map(_h)
                    except Exception as _e:
                        logger.warning("epe_prompts_search_workflows: skipping a "
                                       "malformed item: %s: %s", type(_e).__name__, _e)
                        continue
                    if _m.get("downloadUrl"):
                        mapped.append(_m)
                # The fan-out is the slow part, so checking the clock only at the
                # top of the round could not bound anything. Give it whatever is
                # left; on timeout every lookup reads as unknown, which fails
                # open exactly as an individual failure already does.
                _left = _deadline - asyncio.get_running_loop().time()
                try:
                    flags = await asyncio.wait_for(asyncio.gather(
                        *[_epe_version_requires_auth(session, m["versionId"])
                          for m in mapped],
                        return_exceptions=True,
                    ), timeout=max(1.0, _left))
                except asyncio.TimeoutError:
                    logger.warning("epe_prompts_search_workflows: gating lookups timed out")
                    flags = [None] * len(mapped)
                kept = sum(1 for m, g in zip(mapped, flags) if g is not True)
                items_out.extend(m for m, g in zip(mapped, flags) if g is not True)
                logger.info(
                    f"epe_prompts_search_workflows round {_round}: "
                    f"{len(hits)} upstream, {kept} open, {len(mapped) - kept} login-gated")

                if len(items_out) >= _EPE_WF_MIN_RESULTS:
                    break
                # Only the query path can walk on: it pages by cursor, which the
                # client round-trips. Browse pages by number and the client owns
                # that number, so walking here silently re-served pages it had
                # already consumed.
                if not query or not cur:
                    break
            next_cursor = cur if query else ""

        # An upstream failure is not an empty catalogue. Returning [] for both
        # made a Civitai hiccup read as "no workflows exist".
        if not items_out and upstream_err:
            # With a status. This returned 200, so a client that checks the
            # status code could not tell an outright Civitai outage from a
            # catalogue with nothing in it.
            return web.json_response({
                "items": [], "error": upstream_err,
                "metadata": {"hasMore": False, "page": page, "nextCursor": ""},
            }, status=upstream_status)
        # With a query the cursor is the only signal that more exist. When
        # browsing, ask whether the UPSTREAM page was full — counting the
        # post-filter survivors would call it quits early now that gated
        # items are dropped.
        has_more = bool(next_cursor) if query else upstream_more
        logger.info(f"epe_prompts_search_workflows '{query}' page={page}: {len(items_out)} total items")
        payload = {
            "items":    items_out,
            "metadata": {"hasMore": has_more, "page": page,
                         "nextCursor": next_cursor},
        }
        # A partial failure is still a failure. Reporting it only when the
        # list came back empty left the client unable to tell a short list
        # caused by an error from one that is simply short.
        if upstream_err:
            payload["error"] = upstream_err
        return web.json_response(payload)

    except Exception as e:
        logger.error(f"Error in epe_prompts_search_workflows: {e}", exc_info=True)
        return web.json_response({"error": "Internal error — see the ComfyUI server log"}, status=500)


# ─────────────────────────────────────────────────────────────────────────────
# Workflow detail — download full ComfyUI JSON for a workflow item
# ─────────────────────────────────────────────────────────────────────────────

@routes.post("/epe/prompts/workflow-detail")
@_epe_guard
async def epe_prompts_workflow_detail(request):
    """
    Fetch the full ComfyUI workflow JSON for a workflow item.
    POST body: { "id": str, "source": "civitai", "downloadUrl": str, "versionId": str }
    Returns: { "workflow": {...}, "customNodes": [...], "nodeCount": int }
    """
    try:
        body         = await _epe_json_object(request)
        if body is None:
            return web.json_response(
                {"error": "request body must be a JSON object"}, status=400)
        item_id      = _epe_s(body.get("id")).strip()
        source       = _epe_s(body.get("source")).strip()
        download_url = _epe_s(body.get("downloadUrl")).strip()
        version_id   = _epe_s(body.get("versionId")).strip()

        if not item_id or not source:
            return web.json_response({"error": "Missing id or source"}, status=400)

        # Civitai returns a 307 to an HTML login page for browser-like User
        # -Agents and a clean 401 for everything else. Ask for the 401.
        headers = {"User-Agent": "ComfyUI-Enhanced-Prompt-Editor/1.0",
                   "Accept": "*/*"}

        # ── Civitai: download ZIP or JSON file ───────────────────────────
        if source == "civitai":
            # Both ids are interpolated into Civitai API URL paths below —
            # digits only, so a crafted value cannot reshape the request path.
            if item_id and not item_id.isdigit():
                return web.json_response({"error": "Invalid id"}, status=400)
            if version_id and not version_id.isdigit():
                return web.json_response({"error": "Invalid versionId"}, status=400)
            raw_desc = ""  # will be populated from the models API if available

            def _strip_html(s):
                s = _epe_strip_tags(s[:4000])
                for ent, ch in [("&amp;","&"),("&lt;","<"),("&gt;",">"),("&quot;",'"'),("&#39;","'"),("&nbsp;"," ")]:
                    s = s.replace(ent, ch)
                return ' '.join(s.split())[:1000]

            if not download_url:
                # Try version ID first, then fall back to model ID -> latest version
                if version_id:
                    civ_url = f"https://civitai.com/api/v1/model-versions/{version_id}"
                elif item_id:
                    civ_url = f"https://civitai.com/api/v1/models/{item_id}"
                else:
                    return web.json_response({"error": "No download URL available"}, status=400)
                async with _epe_guarded_session() as session:
                    async with _epe_safe_get(
                        session, civ_url, headers=headers,
                        timeout=aiohttp.ClientTimeout(total=15)) as resp:
                        if resp.status == 200:
                            mv_data = await _epe_json_capped(resp)
                            # /models/{id} returns modelVersions[]; /model-versions/{id} returns files[] directly
                            if isinstance(mv_data, dict) and "modelVersions" in mv_data:
                                raw_desc = _strip_html(_epe_s(mv_data.get("description")))
                                # `"modelVersions": {...}` raised KeyError: 0 and
                                # `"modelVersions": "v1"` indexed a character.
                                _mvs = _epe_l(mv_data.get("modelVersions"))
                                mv_data = _mvs[0] if _mvs else {}
                            # The isinstance guard above only covered the
                            # modelVersions branch, so a 200 with an EMPTY BODY
                            # — _epe_json_capped returns None — reached .get()
                            # here and 500'd.
                            files = _epe_l(_epe_d(mv_data).get("files"))
                            wf_file = next((f for f in files
                                            if isinstance(f, dict)
                                            and f.get("type") in ("Model","Archive")), None)
                            download_url = _epe_s(_epe_d(wf_file).get("downloadUrl"))
                if not download_url:
                    return web.json_response({"error": "Could not resolve download URL"}, status=404)

            # Fetch description separately if we still don't have one (had downloadUrl from search)
            if not raw_desc and item_id:
                try:
                    async with _epe_guarded_session() as session:
                        async with _epe_safe_get(
                            session,
                            f"https://civitai.com/api/v1/models/{item_id}",
                            headers=headers, timeout=aiohttp.ClientTimeout(total=10)
                        ) as resp:
                            if resp.status == 200:
                                m = await _epe_json_capped(resp)
                                if isinstance(m, dict):
                                    raw_desc = _strip_html(_epe_s(m.get("description")))
                except Exception as _e:
                    logger.warning(
                        f"epe_prompts_workflow_detail: description fetch failed: {_e}")
            # Download the file. download_url arrives in the request body (or
            # is resolved from the Civitai API above); this handler was the one
            # fetching route that never checked it, making it a straight SSRF.
            _d_err = await _epe_dns_check_msg(_epe_check_media_url, download_url)
            if _d_err:
                return web.json_response({"error": _d_err}, status=400)
            async with _epe_guarded_session() as session:
                async with _epe_safe_get(
                    session, download_url, headers=headers,
                    timeout=aiohttp.ClientTimeout(total=60)
                ) as resp:
                    if resp.status in (401, 403):
                        return web.json_response({
                            "error": "Login required on Civitai to download this workflow",
                            "civitaiUrl": (f"https://civitai.com/models/{item_id}"
                                           if item_id else ""),
                            "description": raw_desc,
                        }, status=403)
                    if resp.status != 200:
                        return web.json_response({"error": f"Download failed ({resp.status})"}, status=502)
                    file_bytes = await _epe_read_capped(resp)
            # Civitai gates most workflow downloads behind an account now:
            # the download URL 307s to an HTML page rather than the file.
            # Detect that and say so, instead of failing as a parse error.
            _head = file_bytes[:512].lstrip().lower()
            if _head.startswith(b"<!doctype html") or _head.startswith(b"<html"):
                return web.json_response({
                    "error": "Login required on Civitai to download this workflow",
                    "civitaiUrl": (f"https://civitai.com/models/{item_id}"
                                   if item_id else ""),
                    "description": raw_desc,
                }, status=403)
            # Extract workflow JSON — could be a ZIP or raw JSON
            workflow = None
            try:
                workflow = await asyncio.get_running_loop().run_in_executor(
                    _EPE_POOL, _epe_parse_workflow_bytes, file_bytes)
            except _EpeTooLarge as e:
                return web.json_response(
                    {"error": str(e), "description": raw_desc}, status=413)
            except Exception as e:
                logger.warning(f"epe_prompts_workflow_detail civitai parse error: {e}")
            # Check if the "file" is actually an error response (e.g. auth required)
            if isinstance(workflow, dict) and workflow.get("error"):
                msg = workflow.get("message") or workflow.get("error") or "Download failed"
                return web.json_response({"error": msg, "description": raw_desc}, status=403)
            if not workflow:
                return web.json_response({"error": "Could not parse workflow from downloaded file"}, status=422)
            # The downloaded workflow is a stranger's file. _epe_parse_workflow_bytes
            # only checks that the TOP LEVEL is a dict, so `"nodes": 42` reached
            # len() and raised TypeError as a 500.
            nodes = _epe_l(workflow.get("nodes"))
            # Detect custom nodes — any type not in known builtins is potentially custom
            node_count = len(nodes)
            logger.info(f"epe_prompts_workflow_detail civitai id={item_id} nodes={node_count}")
            return web.json_response({
                "workflow":     workflow,
                "customNodes":  [],  # Civitai doesn't provide a pre-parsed list
                "nodeCount":    node_count,
                "description":  raw_desc,
            })

        return web.json_response({"error": f"Unknown source: {source}"}, status=400)

    except (_EpeUrlRejected, _EpeTooLarge, aiohttp.ClientError,
            asyncio.TimeoutError) as e:
        # Same three mappings as everywhere else: 400 for a rejected URL, 413
        # for oversize, 504/502 for slow or unreachable. Neither the
        # model-versions lookup nor the file download had a handler of its own,
        # so both reported civitai.com being down as HTTP 500.
        return _epe_upstream_error("epe_prompts_workflow_detail", e, "Civitai")
    except Exception as e:
        logger.error(f"Error in epe_prompts_workflow_detail: {e}", exc_info=True)
        return web.json_response({"error": "Internal error — see the ComfyUI server log"}, status=500)



# ── Ollama integration for Vid2Prompt and Image2Prompt ────────────────────────

_OLLAMA_KNOWN_MODELS = [
    {"name": "qwen3.5:4b",  "diskGb": 3.4,  "label": "Qwen3.5 4B"},
    {"name": "qwen3.5:9b",  "diskGb": 6.6,  "label": "Qwen3.5 9B"},
    {"name": "qwen3.5:27b", "diskGb": 17.0, "label": "Qwen3.5 27B"},
]

# ═══════════════════════════════════════════════════════════════════════════════
# AESTHETIC POOL — rotates per call to give the LLM diverse, committed aesthetic
# references without collapsing onto a fixed menu every generation.
#
# MUST stay in sync with _EPE_AESTHETIC_POOL in epe_node.js. The client-side
# prompts (expand/variations/invert/img2img) and server-side prompts (image
# caption, video caption) each pick a random subset from this pool per call, so
# the pool's total size becomes the creative breadth of the node over time.
#
# Each entry is a concrete, named aesthetic tradition with enough specificity
# that a language model will recognize it.
# ═══════════════════════════════════════════════════════════════════════════════
_EPE_AESTHETIC_POOL = {
    "photographic": [
        "Kodak Portra 400 color negative, soft skin tones, forgiving highlight rolloff",
        "Kodak Portra 160 with cooler shadows and smooth grain",
        "Kodak Portra 800 for low-light portraiture with characteristic magenta shadows",
        "Kodak Ektar 100, highly saturated fine-grain color for landscape",
        "Kodak Gold 200, warm consumer-grade nostalgia",
        "Kodak UltraMax 400 with punchy saturated color",
        "Kodak ColorPlus 200 with muted vintage palette",
        "Kodachrome slide film, deep blues and reds, mid-century magazine look",
        "Kodak Vision3 500T cinema stock, warm-cool split color science",
        "Fujifilm Pro 400H, cooler greens and pastel skin tones",
        "Fuji Velvia 50, hyper-saturated landscape slide film",
        "Fuji Superia 400 with pronounced green shift",
        "Fuji Acros 100 black and white, smooth mid-tones",
        "CineStill 800T, halation-bloom around highlights, tungsten-balanced",
        "CineStill 50D daylight cinema stock with clean grain",
        "CineStill BwXX (Eastman Double-X), Schindler's List / Raging Bull look",
        "Kodak Tri-X 400, gritty documentary grain, deep blacks",
        "Kodak T-MAX 400, clean fine-grain portrait black and white",
        "Kodak T-MAX 3200 pushed, heavy grain for low-light reportage",
        "Ilford HP5 Plus 400, medium-contrast documentary monochrome",
        "Ilford Delta 3200 pushed for available-light night work",
        "Ilford FP4 Plus 125, crisp medium-speed mid-century b&w look",
        "Harman Phoenix stylized color film with shifted palette",
        "LomoChrome Metropolis, muted cinematic desaturated color",
        "LomoChrome Purple with shifted foliage to magenta",
        "LomoChrome Turquoise with cool tonal shift",
        "Agfa Vista 400 with warm natural tones",
        "Agfa Ultra 50, intensely saturated vintage color",
        "Cross-processed Ektachrome, E-6 in C-41, pushed contrast and shifted hue",
        "Bleach-bypass processing, silver retention, desaturated with crushed shadows",
        "Expired film aesthetic, color shifts, light leaks, unpredictable grain",
        "Autochrome early-1900s color, potato-starch mosaic texture, pastel muted hues",
        "Large-format 4x5 view camera, tilt-shift, slow shallow depth",
        "Hasselblad medium format 80mm f/2.8 square frame, rich tonality",
        "Mamiya 7 medium format rangefinder, sharp and quiet",
        "Pentax 67 medium format with creamy bokeh",
        "Leica M rangefinder 35mm, street documentary distance",
        "Leica summilux 50mm wide open, natural bokeh and micro-contrast",
        "Polaroid SX-70 instant with characteristic border and faded color",
        "Holga 120N plastic lens, vignetting, center sharpness, toy-camera softness",
        "Direct-flash fashion editorial with hard shadow and flat foreground",
        "Phone-camera snapshot with digital noise and auto-HDR flatness",
        "Anamorphic lens flare with horizontal blue streaks, 2.39:1 compression",
        "Tilt-shift miniaturization effect with selective plane of focus",
        "Wet-plate collodion with period-correct tonal range and imperfections",
        "Early daguerreotype plate, silvery high-key monochrome with frame edge",
    ],
    "painting": [
        "Mughal miniature manuscript technique in the Akbar atelier mode, fine brush on paper, intricate ornamental border, flat layered picture space, gold leaf accents and mineral pigments",
        "Mughal Hamzanama technique with dense narrative picture space, fine vermilion linework, tight overlapping compositional layers",
        "Rajput painting in the Kishangarh mode with flat mineral color, stylized elongated proportions, decorative border framing",
        "Pahari painting from the Kangra school with soft contour linework, pastel mineral washes, rolling green landscape backdrop",
        "Persian Safavid miniature, flat perspective, layered architecture, detailed textiles",
        "Ottoman miniature with calligraphic borders and jewel-bright pigments",
        "Tanjore painting with gold leaf and gemstone inlay, raised gesso relief",
        "Ajanta cave fresco style, earth pigments, curving female figures in tribhanga pose",
        "Bengal School watercolor technique in the Abanindranath Tagore manner, soft wet-on-wet wash, muted earth-tone palette, delicate outline",
        "Jamini Roy folk-art flat color with bold black outline",
        "Chinese gongbi meticulous court painting, fine line on silk, mineral pigment",
        "Chinese xieyi freehand ink wash, energetic brush, expressive landscape",
        "Song Dynasty landscape scroll, misty mountains, tiny travelers, blank-space composition",
        "Tang Dynasty court painting of elegant figures on silk",
        "Dunhuang Mogao cave mural, Buddhist iconography, earth-red and lapis",
        "Japanese Yamato-e style with gently sloping hills and decorative clouds",
        "Heian emaki handscroll composition, rooftop-removed interior view",
        "Sumi-e Zen ink wash, minimal brushstrokes, unmarked rice paper",
        "Japanese nihonga with mineral pigments and gold leaf ground",
        "Tibetan thangka technique with rigid symmetrical composition, flat mineral pigment in vermilion and turquoise, halo of gold flame pattern, fine-line detail",
        "Korean minhwa folk painting with flat stylized tigers or scholar's stationery",
        "Ethiopian Orthodox icon painting technique with flat frontal picture space, large-eyed stylized proportion, red-and-gold palette, fine linework on primed panel",
        "Ndebele painting technique with bold black-outlined geometric blocks, flat saturated color, architectural surface application",
        "Aboriginal Australian dot-painting technique with dense dotted pigment application, radial and linear patterning, earth-pigment palette",
        "Navajo sand-painting technique with symmetrical radial composition, earth-pigment color laid on flat ground, bold geometric shape",
        "Haida formline drawing technique with ovoid and U-shape building blocks, bold red-and-black two-color palette, interlocking positive/negative shape",
        "Mexican muralist style in the tradition of Rivera, Orozco, Siqueiros, monumental figures and social narrative",
        "Huichol yarn-on-beeswax technique with tight parallel yarn lines, saturated psychedelic color, bold flat symmetric patterning",
        "Dutch Golden Age chiaroscuro, Rembrandt-tradition portraiture, deep shadow, warm key light",
        "Vermeer-style Dutch interior with cool north-window light and precise still-life objects",
        "Baroque tenebrism in the Caravaggio manner, theatrical spotlighting from offscreen",
        "Pre-Raphaelite oil with botanical precision and saturated jewel tones",
        "Tonalist oil sketch, narrow value range, earth pigments, atmospheric haze",
        "Hudson River School landscape with luminous sky and sublime scale",
        "Impressionist plein air in the tradition of Monet, broken color, dappled light",
        "Post-impressionist impasto with thick palette-knife strokes",
        "Sorolla Spanish luminism, beach light, loose confident brushwork",
        "Fauvist flat areas of non-naturalistic color, Matisse tradition",
        "Cubist faceted-plane analysis in Picasso/Braque mode, muted palette",
        "Surrealist dreamscape with uncanny scale shifts in the Dalí or Magritte mode",
        "Abstract Expressionist action painting, gestural drips, large scale",
        "Nabi decorative flatness, Bonnard/Vuillard patterning",
        "Hopper-style American realism, stark shadows, isolated figures in empty architecture",
        "Frida Kahlo painting technique with flat folk-tradition figuration, saturated primary palette, symbolic still-life elements arranged around the subject",
        "Wifredo Lam painting technique in the Afro-Cuban modernist mode, cubist-influenced faceted forms, muted jungle-green and ochre palette",
        "Byzantine icon with gold ground, stylized elongated figures, flat hierarchic space",
        "Russian iconography in the Andrei Rublev tradition, soft tempera, luminous flesh tones",
    ],
    "illustration": [
        "Ukiyo-e woodblock technique in the Hokusai manner with bold black keyblock outline, flat areas of mineral pigment, Prussian blue accent, decorative compositional rhythm",
        "Ukiyo-e print technique in the Utamaro manner with elongated stylized proportion, richly patterned flat color areas, delicate keyblock linework",
        "Ukiyo-e print technique in the Hiroshige manner with stylized atmospheric color blocks, graded sky wash, rhythmic linear pattern",
        "Shin-hanga 20th-century Japanese print with Western perspective and moody lighting",
        "Sōsaku-hanga creative print, sole-artist carving, expressive gouge marks",
        "Chinese Suzhou woodblock print, Ming-Qing era, hand-colored bright pigments",
        "Ten Bamboo Studio multi-color block-printed album of flowers and birds",
        "Mianzhu folk New Year woodblock with bold auspicious figures",
        "Dürer-style Renaissance woodcut technique with dense cross-hatch, fine keyblock linework, high tonal contrast from pure white to deep black",
        "Chiaroscuro woodcut in the Ugo da Carpi manner, tonal color-block registration",
        "Edmund Evans color wood-block book illustration, Walter Crane/Kate Greenaway lineage",
        "Art Nouveau poster in the Mucha tradition, ornamental linework and muted flat color",
        "Art Deco poster in the Cassandre manner, streamlined geometry, airbrushed gradient",
        "Risograph print with registration offset, limited spot colors, grainy fill",
        "Silkscreen/screenprint with flat inks and halftone dot fills",
        "Linocut with confident knife-mark texture and bold contrast",
        "Ligne claire comic inking in the Hergé/Tintin tradition, even line weight, flat color",
        "Moebius European bande dessinée with intricate line and surreal landscape",
        "Gekiga adult Japanese comic with heavy hatching and noir mood",
        "Shoujo manga with decorative screentones, large eyes, floral backgrounds",
        "Seinen noir manga with dense crosshatch and hard shadow",
        "1960s children's book gouache in the Richard Scarry or Mary Blair mode",
        "1970s pulp paperback cover painting, airbrushed detail, saturated drama",
        "Push Pin Studios illustration in the Milton Glaser mode, flat color, psychedelic lettering",
        "1960s psychedelic concert poster, swirling organic lettering, vibrating complementary colors",
        "Polish poster school, expressive painterly illustration with surreal metaphor",
        "Cuban ICAIC film poster, flat silkscreen color, folk-political imagery",
        "Soviet propaganda poster in the Rodchenko mode, diagonal photomontage, red and black",
        "Saul Bass film-title graphic, cut-paper silhouette with bold color",
        "Emory Douglas-style political newspaper rendering with stark high-contrast black-and-white linework, bold flat color accent, poster-scale simplified silhouette",
        "Indian Rangoli floor design with symmetric geometric pattern in pigmented powder",
        "Islamic geometric zellij tile pattern, interlocking stars and polygons",
        "Persian manuscript border illumination with arabesque vine and gold",
        "Ethiopian magic scroll with stylized figures and talismanic lettering",
        "Papel picado cut-paper rendering with crisp silhouette cutouts, flat saturated color, lace-like perforation pattern",
        "Posada-style engraving rendering with crisp black linework, flat color fills, dense newspaper-era mark-making",
        "Soviet Constructivist book cover by Rodchenko with diagonal type and photomontage",
        "Scratchboard illustration with fine white lines on black background",
        "Pen-and-ink stippled editorial illustration in the Wall Street Journal hedcut style",
        "Watercolor children's book in the Beatrix Potter manner, soft washes, delicate contour",
    ],
    "animation": [
        "Studio Ghibli hand-painted watercolor backgrounds with detailed nature and pastel palette",
        "Studio Ghibli-adjacent Takahata Princess Kaguya soft-watercolor storybook mode",
        "Cartoon Saloon-style 2D rendering with geometric interlacing pattern decoration, flat saturated color fills, bold simplified silhouette",
        "Cartoon Saloon Wolfwalkers-style rendering with loose charcoal-drawn linework, hand-inked flat color fills, rough-paper paper texture",
        "Laika stop-motion with 3D-printed facial replacement, painterly miniature sets",
        "Aardman Animations British clay stop-motion in the Wallace and Gromit tradition",
        "Henry Selick dark puppet stop-motion with gothic miniature architecture",
        "Jan Švankmajer Czech stop-motion with found-object collage and uncanny texture",
        "Quay Brothers stop-motion in dusty amber light with decayed materials",
        "Pixar photoreal CGI with rich subsurface scattering and emotional lighting",
        "DreamWorks 3D animation with exaggerated character shapes and cinematic lighting",
        "Spider-Verse-style 2D/3D hybrid rendering with halftone dot patterns, chromatic aberration offsets, comic-panel linework and onomatopoeia flourishes",
        "Arcane painterly 3D with visible brushstroke texture and hand-painted look over 3D geometry",
        "Late-80s/early-90s Disney-era hand-drawn 2D rendering with clean keyblock outline, painted cel-style flat color, soft painted backgrounds",
        "Eyvind Earle-style rendering with flat decorative tapestry-like color areas, sharp geometric foliage silhouettes, gothic-arch compositional rhythm",
        "Richard Linklater rotoscope animation over live-action reference",
        "Ralph Bakshi rotoscoped fantasy with painterly gouache backgrounds",
        "Toei anime in the Dragon Ball / Sailor Moon mode, flat cel shading, high-contrast action",
        "Studio Trigger anime with saturated colors, bold linework, exaggerated action",
        "MAPPA / Ufotable compositing with painted-in rim light and particle VFX",
        "Satoshi Kon anime with grounded adult realism and unsettling editing",
        "Makoto Shinkai anime with hyper-detailed lit backgrounds and god-ray atmosphere",
        "Masaaki Yuasa fluid hand-drawn anime with loose proportion and surreal transformation",
        "UPA mid-century flat limited animation in the 1950s Gerald McBoing-Boing style",
        "Fleischer rubber-hose 1930s black-and-white cartoon with bouncy physicality",
        "Marvel/DC comic panel coloring with Ben-Day dots and bold ink outline",
        "Frank Miller-style comic rendering with high-contrast pure-black silhouettes, sparse spot-red accents, heavy negative space",
        "Watercolor indie comic in the David Mack Kabuki manner, loose painterly pages",
        "Mignola-style comic rendering with heavy black shadow shapes defining form, flat color held within the shapes, angular geometric poses",
        "French/Belgian bande dessinée album page, structured panel grid, precise color",
        "Cartoon Network Adventure Time loose wobbly-outline 2D with pastel backgrounds",
        "Rick and Morty style wobbly outline with oversized features and deadpan color",
        "Love Death and Robots anthology-range, photoreal to stylized 2D",
        "French Ernest et Célestine watercolor-outline storybook 2D",
        "Flow / Latvian 3D animation with minimalist painterly surfaces",
    ],
    "cinematography": [
        "Roger Deakins natural-source lighting with controlled shadow and innovative color, Blade Runner 2049 sulfur-haze and silver-winter register",
        "Roger Deakins sepia monochromatic grade in the Shawshank / Assassination of Jesse James mode",
        "Emmanuel Lubezki floating long takes with wide-angle lens and natural light, Tree of Life / Revenant mode",
        "Christopher Doyle smushy subjectivism and neon sadness, Wong Kar-wai handheld layered clutter",
        "Christopher Doyle step-printing blur and saturated mirror-surface reflection in the Chungking Express mode",
        "Vittorio Storaro Technicolor-inspired color theory with expressive key-hue staging, Apocalypse Now / Last Emperor",
        "Gordon Willis low-key chiaroscuro, overhead practical key light, Godfather Prince of Darkness mode",
        "John Alcott candlelit Barry Lyndon with period lens and no-electric sources, diffusion filters",
        "John Alcott / Kubrick one-point symmetry with wide-angle framing, Shining and 2001 mode",
        "Hoyte van Hoytema practical effects with large-format IMAX detail, Interstellar / Dunkirk",
        "Darius Khondji deep-dish paintbox saturation in the Se7en / City of Lost Children mode",
        "Robert Richardson halo backlighting bouncing off subject's face",
        "Bradford Young warm naturalism and soft underexposure in Selma / Arrival",
        "Greig Fraser desaturated cool-neutral with heavy atmosphere, Dune / Batman mode",
        "Chung Chung-hoon punchy saturated color with elegant camera movement, Park Chan-wook collaboration",
        "Sayombhu Mukdeeprom natural tropical light with Weerasethakul / Guadagnino grounded texture",
        "Janusz Kamiński warm period grading with harsh backlit windows, Spielberg collaboration",
        "Rodrigo Prieto handheld documentary urgency with practical-light realism",
        "Bill Pope wire-fu bluish steel Matrix world with green digital cast",
        "Conrad Hall backlit hair and golden-hour warm low-angle, American Beauty mode",
        "Néstor Almendros natural magic-hour light in the Days of Heaven mode",
        "Michael Ballhaus Scorsese tracking shots with warm saloon-tungsten practical light",
        "Vilmos Zsigmond flashed-negative muted pastel, McCabe & Mrs. Miller mode",
        "Storaro/Bertolucci theatrical color-coded interior, Conformist mode",
        "Eric Gautier French handheld naturalism with pastel grading",
        "Jordan Cronenweth Blade Runner 1982 smoke-and-neon chiaroscuro",
        "Anamorphic 2.39:1 with characteristic oval bokeh and horizontal lens flare",
        "Academy 1.37:1 locked-off classical framing",
        "Handheld vérité with motion-blur and rolling-shutter skew",
        "Steadicam floating follow through architectural space",
        "Dogme 95 handheld available-light grit with no artificial sources",
        "Neo-noir wet-street sodium-vapor reflection with rain haze",
        "Giallo saturated magenta-and-teal Dario Argento horror lighting",
        "Technicolor three-strip vivid primary color, Wizard of Oz / Singin' in the Rain mode",
    ],
    "graphic_design": [
        "Bauhaus geometric primary-color poster, sans-serif Futura/Kabel, asymmetric composition",
        "Russian Constructivist poster in the Rodchenko/Lissitzky mode, red-and-black diagonal photomontage",
        "Suprematist flat geometric composition in the Malevich mode, pure shape and primary color",
        "De Stijl red-yellow-blue grid with heavy black rules in the Mondrian manner",
        "Swiss International Typographic Style with Akzidenz-Grotesk/Helvetica on a tight grid, flush-left ragged right",
        "Memphis Group 1981 Sottsass playful eclectic with zigzags, squiggles, and terrazzo speckle",
        "Wolfgang Weingart Swiss Punk / New Wave typography with layered type and disrupted grid",
        "Push Pin Studios illustration-led design in the Milton Glaser / Seymour Chwast manner",
        "Art Nouveau Mucha poster with arched frame and ornamental flowing hair",
        "Art Deco Cassandre streamlined transportation poster, airbrush gradients, geometric type",
        "Italian Futurist typography with explosive word-lines in the Marinetti mode",
        "Dada photomontage with cut-paper fragmentation and ransom-note type",
        "Wiener Werkstätte geometric patterns with black-and-white grid motifs",
        "Brutalist graphic design with raw exposed elements, crude oversized type, asymmetric layout",
        "Cuban ICAIC film poster in the Niko / Reboiro / Azcuy tradition, silkscreen flat color, political metaphor",
        "Polish poster school, painterly surreal metaphor, hand-painted title type",
        "Grapus French collective poster with collaged political graphic energy",
        "Japanese graphic design in the Ikko Tanaka / Yusaku Kamekura mode, flat bold graphic with geometric face",
        "Chinese graphic design blending Western modernism with calligraphic ink",
        "Vignelli modernist American corporate identity in the NYC Subway / Helvetica tradition",
        "Tibor Kalman editorial irony with juxtaposition, Colors magazine mode",
        "Saul Bass cut-paper title sequence with bold silhouette and limited palette",
        "Paula Scher bold typographic Public Theater poster with colossal wood-type blocks",
        "Barbara Kruger declarative red-box-and-Futura-Bold Extended overlay on black-and-white photo",
        "David Carson Ray Gun magazine chaotic grid with overlapping type and disruptive layout",
        "Vaughan Oliver 4AD album cover with experimental photography and impressionistic type",
        "Peter Saville Factory Records minimalism with austere typography and restrained color",
    ],
    "digital_3d": [
        "Octane photoreal CGI with global illumination, chrome reflections, and physical-material accuracy",
        "Arnold ray-traced render with subsurface skin scattering and studio HDRI lighting",
        "Unreal Engine 5 real-time render with Lumen GI, Nanite detail, slight cinematic bloom",
        "V-Ray architectural render with cool neutral GI and sharp glass reflections",
        "Blender Cycles photoreal product render with studio softbox lighting",
        "Matte concept painting in the Syd Mead / Feng Zhu tradition, soft edges, atmospheric perspective",
        "Low-poly flat-shaded 3D with faceted geometry and pastel gradient sky",
        "Cel-shaded 3D with hand-inked outline and flat anime-style fill",
        "Arcane-style painterly 3D with hand-painted texture over 3D geometry, visible brushstrokes",
        "Gorillaz-style 2D-on-3D compositing with flat graphic character on photoreal background",
        "Voxel art with cubic block construction in the MagicaVoxel aesthetic",
        "Pixel art in a specific era — 8-bit NES palette, 16-bit Super Famicom, or 32-bit CPS-2 arcade",
        "Generative algorithmic art with code-driven geometric iteration",
        "Point-cloud LIDAR scan with dotted surface reconstruction",
        "Wireframe schematic with transparent surfaces and vector-grid background",
        "Clay render with uniform neutral matte material showing pure form and light",
        "Photogrammetry scan with real-world texture and slight mesh artifacts",
        "ASCII art character-grid rendering of the scene",
        "Retro CRT vaporwave aesthetic with scanlines, chromatic aberration, and glitch offset",
        "Houdini FX rigid-body destruction with volumetric dust and debris",
        "RenderMan Pixar-style physical render with soft shadows and bounce light",
        "Cinema 4D product visualization with gradient-infinity backdrop and rim light",
        "Glitched digital corruption with datamoshed color blocks and scan errors",
        "Early CGI 1990s aesthetic with gouraud-shaded low-detail models and reflective chrome",
        "Isometric 3D illustration with flat color, long shadow, and Monument Valley depth",
        "Risograph-over-3D with grainy two-tone finish applied to rendered geometry",
    ],
    "lighting": [
        "Rembrandt key lighting with triangular light on the far cheek and deep shadow on the near side",
        "Clamshell beauty lighting, twin sources from above and below, minimal shadow, even skin",
        "Split lighting with one side in full light and the other in full shadow",
        "Rim-lit silhouette with bright edge outline against a dark surround",
        "Chiaroscuro Caravaggio key light from upper-left with rapidly falling shadow",
        "Golden hour warm low-angle with long shadows and hazy backlight",
        "Blue hour cool ambient twilight, practical lights beginning to glow",
        "Overcast diffused sky as giant softbox, shadowless, slightly cool",
        "Sodium-vapor streetlight, amber-orange cast, high-color-temperature sky fill",
        "Mercury-vapor industrial light, greenish cool color",
        "Tungsten practical lamp in the frame as motivated warm key",
        "Fluorescent office light with green cast and hard overhead shadow",
        "Neon signage as key light with saturated magenta or cyan on face",
        "Candlelight only in the Barry Lyndon Alcott mode, warm flicker from below frame",
        "Firelight with warm flickering rim and dancing shadow",
        "Moonlight cool directional key with deep star-dotted sky",
        "Volumetric god-rays cutting through dusty air or mist",
        "Underwater caustics with wavering light patterns on subject",
        "Stage spotlight with hard circular pool of light and falloff darkness",
        "Window light with lace-curtain dappled pattern",
        "Bioluminescent underlight from below in cool cyan or green",
        "Thunderstorm strobing flash with momentary high-contrast reveal",
        "Snow-bounce fill, soft high-key with blue shadow tones",
        "Dappled forest light with sharp beams between leaves",
        "Sunrise rim-backlight with flare halos and lens ghosting",
        "High-noon hard overhead with deep self-shadow and bleached highlights",
        "Neon-wet-street reflection off rain-soaked asphalt",
        "Incandescent bare-bulb single-source hard shadow with warm spill",
    ],
    "color": [
        "Split-toning with teal shadows and amber highlights, Hollywood-blockbuster orange-and-teal grade",
        "Kodak Vision3 warm-cool cinema color science with natural skin tones",
        "Cross-processed E-6-in-C-41 with shifted shadow hues and boosted contrast",
        "Bleach-bypass desaturation with retained silver and crushed shadows",
        "Muted Wes Anderson-adjacent palette of dusty pink, mustard, and sage",
        "Oversaturated Kodachrome vintage slide palette with deep reds and blues",
        "Monochrome silver-gelatin print tonal range with full black to paper white",
        "Duotone print with two-color spot palette, e.g. black and Pantone red",
        "Risograph two-color overprint with visible registration offset and grainy fill",
        "Night scene in deep cyan and magenta neon contrast",
        "Earth-pigment palette with ochre, umber, raw sienna, and lead white",
        "Fauvist non-naturalistic saturated flat planes, green faces and orange trees",
        "Hopper palette of muted warm lamp-yellow against deep cool shadow",
        "Early technicolor three-strip vivid primaries with rich ruby reds",
        "Instagram filter-era muted teal-olive with faded blacks",
        "High-contrast grayscale with no mid-tones, Sin City aesthetic",
        "Pastel dream palette of soft pink, lavender, cream, and baby blue",
        "Autumnal warm palette with burnt orange, mustard yellow, deep maroon",
        "Arctic cool palette with white, ice blue, slate, and frost",
        "Desaturated wartime documentary palette with slight green shift",
        "Nan Goldin flash-saturated snapshot palette with red-eye and warm indoor mix",
        "Indian textile-inspired palette of saffron, indigo, vermilion, gold",
        "Japanese shibui restrained palette with muted earth tones and subtle accent",
        "Pantone-perfect graphic-design flat spot colors with no gradient",
    ],
}

# Placeholder tokens that prompts can use to inject rotated examples.
# At build-time, each placeholder is replaced with a random subset (default 4)
# from the corresponding pool category, joined like "A; B; C; D".
_EPE_AESTHETIC_PLACEHOLDERS = {
    "{{PHOTO_EXAMPLES}}":        "photographic",
    "{{PAINTING_EXAMPLES}}":     "painting",
    "{{ILLUSTRATION_EXAMPLES}}": "illustration",
    "{{ANIMATION_EXAMPLES}}":    "animation",
    "{{CINEMA_EXAMPLES}}":       "cinematography",
    "{{GRAPHIC_EXAMPLES}}":      "graphic_design",
    "{{DIGITAL_EXAMPLES}}":      "digital_3d",
    "{{LIGHTING_EXAMPLES}}":     "lighting",
    "{{COLOR_EXAMPLES}}":        "color",
}



# ── Style pool rules (mirrors _EPE_STYLE_POOL_RULES in epe_node.js) ───────────
# exclude: tradition categories whose menu lines are removed for this style.
# lighting / color: dedicated pools replacing the global ones.
_EPE_STYLE_POOL_RULES = {
    "midjourney": {
        "exclude": ["photographic", "graphic_design", "animation"],
        "lighting": [
            "volumetric god rays breaking through mist",
            "dramatic chiaroscuro with deep luminous shadow",
            "golden-hour rim light with atmospheric haze",
            "bioluminescent glow against dusk",
            "shafts of dusty light in a dark interior",
        ],
        "color": [
            "deeply saturated jewel tones with rich shadow color",
            "teal-and-gold complementary grade",
            "iridescent highlights over moody desaturated midtones",
            "ember-warm palette against cool atmospheric depth",
            "luminous pastels dissolving into darkness",
        ],
        "tone": "Favor painterly, atmospheric, dramatically lit vocabulary — more beautiful than reality.",
    },
    "dalle": {
        "exclude": ["photographic", "cinematography"],
        "lighting": [
            "soft directional key with gentle wraparound fill",
            "even friendly daylight, shadows soft and open",
            "warm lamplight with clean ambient bounce",
            "bright overcast with no hard edges",
            "cheerful morning sun through a window",
        ],
        "color": [
            "vibrant but harmonious palette, no clashing hues",
            "warm inviting tones with clean white breathing room",
            "candy-bright accents over soft neutrals",
            "storybook palette of friendly saturated primaries",
            "gentle pastel wash with one bold accent color",
        ],
        "tone": "Favor clean, friendly, illustration-leaning vocabulary with uncluttered staging.",
    },
    "gemini": {
        "exclude": ["painting", "illustration", "animation", "graphic_design", "digital_3d"],
        "lighting": [
            "natural available daylight, unmodified",
            "soft overcast with true-to-life shadow falloff",
            "window light with realistic ambient bounce",
            "open shade, even and neutral",
            "late-afternoon sun at a believable angle",
        ],
        "color": [
            "neutral true-to-life color, no visible grade",
            "accurate white balance with natural saturation",
            "documentary-neutral palette, faithful skin tones",
            "as-shot color with mild contrast",
            "clean daylight color rendition",
        ],
        "tone": "Favor clean photographic realism with natural light and neutral color.",
    },
    "meta": {
        "exclude": ["painting", "illustration", "animation", "graphic_design"],
        "lighting": [
            "golden-hour glow with soft directional warmth",
            "magic-hour backlight with gentle halation",
            "warm window light with dreamy falloff",
            "soft key with amber practicals in the background",
            "hazy late sun with gentle lens bloom",
        ],
        "color": [
            "warm moderate saturation with soft contrast",
            "honeyed golden palette with natural skin tones",
            "gentle warm grade, slightly lifted blacks",
            "sun-washed tones with creamy highlights",
            "amber-and-teal but restrained, grounded",
        ],
        "tone": "Favor cinematic-but-grounded vocabulary with warm golden light and natural texture.",
    },
    "photorealistic": {
        "exclude": ["painting", "illustration", "animation", "graphic_design", "digital_3d", "cinematography"],
        "lighting": [
            "Rembrandt key with soft fill, catchlight in the eyes",
            "single large softbox at 45 degrees, gentle falloff",
            "hard direct sunlight with crisp true shadows",
            "north-window light, painterly but real",
            "three-point studio setup with subtle rim separation",
        ],
        "color": [
            "faithful film-stock color, Portra-like skin rendition",
            "neutral grade with true blacks and unclipped highlights",
            "natural daylight balance, realistic saturation",
            "subtle warm bias, accurate fabric and skin tones",
            "clean colorimetric accuracy, no stylized grade",
        ],
        "tone": "Favor real-equipment photographic vocabulary: lens, aperture, film stock, lighting setup, true texture.",
    },
    "cinematic": {
        "exclude": ["painting", "illustration", "animation", "graphic_design", "digital_3d"],
        "lighting": [
            "motivated practicals with low-key falloff",
            "sodium-vapor streetlight against blue dusk",
            "hard slash of light through venetian blinds",
            "soft toplight with negative fill, moody contrast",
            "backlit smoke with anamorphic flare",
        ],
        "color": [
            "teal-orange complementary grade",
            "blue-graded night with warm practical accents",
            "bleach-bypass desaturation with hard contrast",
            "desaturated naturals, filmic contrast curve",
            "monochrome-leaning grade with one saturated accent",
        ],
        "tone": "Favor film grammar: anamorphic character, graded palettes, motivated light, intentional framing.",
    },
    "anime": {
        "exclude": ["photographic", "painting", "graphic_design", "digital_3d", "cinematography"],
        "lighting": [
            "cel-style two-tone shadow shapes with hard terminator",
            "gradient dusk sky glow behind the subject",
            "lens bloom off highlights, anime-style flare",
            "god rays through clouds in flat graded bands",
            "rim light drawn as a clean bright edge line",
        ],
        "color": [
            "flat cel color with saturated fills and clean edges",
            "Shinkai-style luminous sky gradients",
            "Ghibli-warm naturals with painterly background softness",
            "high-key pastel palette with pop accents",
            "dramatic seinen palette, desaturated with blood-red accent",
        ],
        "tone": "Favor anime vocabulary: cel shading, clean line work, expressive design, studio references where apt.",
    },
    "conceptArt": {
        "exclude": ["photographic", "graphic_design", "animation"],
        "lighting": [
            "mood-first atmospheric light, forms dissolving in haze",
            "single strong value read: dark silhouette against glowing sky",
            "bounce light blocked in loose planes",
            "rim-lit silhouette with unfinished edges",
            "overcast value study, local color suppressed",
        ],
        "color": [
            "limited three-color palette, value-first",
            "muted earth gamut with one saturated focal note",
            "gouache-like opaque color with visible strokes",
            "desaturated blues and grays with warm story accent",
            "monochromatic underpainting peeking through",
        ],
        "tone": "Favor concept-art vocabulary: loose brushwork, strong silhouette, mood-board energy, unfinished edges.",
    },
}

def _epe_style_rules(style):
    """The pool rules for a style id, or None.

    `_EPE_STYLE_POOL_RULES.get(style)` raises TypeError: unhashable type on a
    list or a dict, and `style` arrives in the request body — the browser sends
    whatever `epe_style.style` held in node.properties, which rides inside
    workflow files that are shared, hand-edited and written by other builds.
    One such file turned every caption on that node into HTTP 500.

    "default" and the empty string mean "no style", the same as before.
    """
    if not isinstance(style, str) or style == "default":
        return None
    return _EPE_STYLE_POOL_RULES.get(style)


def _epe_apply_aesthetic_rotation(text: str, per_category: int = 4,
                                  style: str = None, keep: set = None) -> str:
    """
    Substitute every ``{{CATEGORY_EXAMPLES}}`` token in ``text`` with a freshly-
    picked random subset from the corresponding pool category. Safe to call on
    strings with no placeholders — returns unchanged.

    style: optional style id from _EPE_STYLE_POOL_RULES — excluded tradition
    categories have their menu lines removed; dedicated lighting/color pools
    replace the global ones.
    keep: categories never excluded regardless of style (e.g. cinematography
    for the video builder, where it is the only tradition menu).
    """
    import random
    if not isinstance(text, str) or not text:
        return text
    n = max(1, min(10, per_category or 4))
    rules = _epe_style_rules(style)
    keep = keep or set()
    out = text
    for token, category in _EPE_AESTHETIC_PLACEHOLDERS.items():
        if token not in out:
            continue
        if rules and category in rules.get("exclude", []) and category not in keep:
            out = "\n".join(l for l in out.split("\n") if token not in l)
            continue
        pool = _EPE_AESTHETIC_POOL.get(category, [])
        if rules and category == "lighting" and rules.get("lighting"):
            pool = rules["lighting"]
        if rules and category == "color" and rules.get("color"):
            pool = rules["color"]
        if pool:
            picks = random.sample(pool, min(n, len(pool)))
            replacement = "; ".join(picks)
        else:
            replacement = "(aesthetic examples unavailable)"
        out = out.replace(token, replacement)
    return out


def _epe_style_slider_addendum(style: str = None, length_slider=None, focus_slider=None,
                               style_override=False) -> str:
    """Build the style tone line + safe slider modifiers appended to vision prompts."""
    parts = []
    rules = _epe_style_rules(style)
    if rules and rules.get("tone"):
        parts.append("STYLE VOCABULARY: " + rules["tone"])
    if style_override and rules:
        parts.append(
            "AESTHETIC OVERRIDE — write the output prompt AS IF the scene were "
            "rendered in the style target above, replacing the source's actual "
            "rendering style, medium, lighting, and global color grade with the "
            "style target's. Keep faithful: subjects, counts, poses, actions, "
            "scene layout, and named objects with their identity colors — a red "
            "bicycle stays red, expressed in the target style's idiom.")
    try:
        ln = int(length_slider) if length_slider is not None else 50
    # OverflowError too: `1e999` is plain valid JSON, decodes to inf, and
    # int(inf) raises it — straight out to the handler's 500 tail. The same
    # class round 41 fixed for page numbers, missed here.
    except (TypeError, ValueError, OverflowError):
        ln = 50
    if ln <= 25:
        parts.append("WORD COUNT OVERRIDE — this replaces any word-count target above: keep the output terse, roughly 50-100 words.")
    elif ln <= 49:
        parts.append("WORD COUNT OVERRIDE — this replaces any word-count target above: around 100-160 words.")
    elif ln >= 76:
        parts.append("WORD COUNT OVERRIDE — this replaces any word-count target above: richly detailed, 260-300 words.")
    elif ln >= 51:
        parts.append("WORD COUNT OVERRIDE — this replaces any word-count target above: expansive, around 200-260 words.")
    try:
        fc = int(focus_slider) if focus_slider is not None else 50
    except (TypeError, ValueError, OverflowError):
        fc = 50
    if fc <= 30:
        parts.append("Cover the full scene, including background and atmosphere, not just the main subject.")
    elif fc >= 70:
        parts.append("Stay tightly focused on the main subject; keep background description brief.")
    return "\n".join(parts)


# ── Video caption template ────────────────────────────────────────────────────
# Contains {{CINEMA_EXAMPLES}}, {{LIGHTING_EXAMPLES}}, {{COLOR_EXAMPLES}} which
# are substituted with a fresh random subset by _build_video_system_prompt().
_OLLAMA_VID_SYSTEM_PROMPT_TEMPLATE = (
    "You write video generation prompts for modern video diffusion models "
    "(Wan 2.2, Hunyuan Video, CogVideoX, LTX, and similar). You are shown "
    "evenly-spaced frames from a short clip. Describe only what is actually "
    "visible. Do not invent elements you cannot see. Infer motion from how "
    "subjects shift between frames; if something is still, say so.\n\n"
    "VISIBLE-SUBJECT FIDELITY — hard rule. Describe the actual subject(s) "
    "visible. Do not substitute similar-looking things, do not upgrade to "
    "sound evocative, and do not let a cinematographic tradition you "
    "recognize pull the subject toward that tradition's typical content. If "
    "frames show an elephant, say elephant. If frames show three people, say "
    "three. The tradition is the HOW, not the WHAT.\n\n"
    "IMMERSIVE VISUAL DETAIL — describe every visible noun with concrete "
    "detail. Observed \"woman\" → age range visible, eye color, hair, "
    "expression, posture, clothing. DO NOT invent ethnicity, religion, or "
    "identity-defining traits not visibly clear. Observed \"lawn\" → "
    "edging, color, mow pattern, condition. Surfaces get active behavior: "
    "what does the material do under the observed light. The tradition you "
    "name isn't just a label — its vocabulary describes the scene.\n\n"
    "Identify the specific cinematographic tradition visible. Rotating "
    "anchors (match against, or name a similar one):\n"
    "  {{CINEMA_EXAMPLES}}\n\n"
    "Name the likely camera/lens behavior (shallow focus, wide-angle, macro, "
    "long-lens compression, anamorphic flare).\n\n"
    "ENCODER RULES — written for diffusion text encoders:\n"
    "- The FIRST sentence names the subject and the rendering tradition.\n"
    "- Direct declarative description only. Never \"The scene captures\" or "
    "\"creating a sense of.\"\n"
    "- State what IS there. Never describe by absence — \"no harsh shadows\" "
    "becomes \"soft diffuse shadows.\"\n"
    "- Place elements spatially: \"to her left,\" \"lower foreground.\"\n"
    "- Text visible in the frames stays in \"double quotes\" verbatim.\n\n"
    "Write one flowing paragraph of 170-190 words covering, in order:\n"
    "1. Cinematographic tradition and camera behavior — named style, "
    "framing, movement inferred from frame shifts.\n"
    "2. Subjects — actual subjects with immersive detail, what each is, "
    "how constructed, clothing, expression.\n"
    "3. Composition — placement, foreground/midground/background, depth.\n"
    "4. Motion — each moving element's direction, speed, quality. Trajectory "
    "across the clip. For still elements, say so.\n"
    "5. Environment — interior/exterior, ground, atmospheric effects, "
    "background.\n"
    "6. Lighting — direction, hardness, color, named behavior. Anchors "
    "(rotating): {{LIGHTING_EXAMPLES}}.\n"
    "7. Color treatment — dominant/secondary colors, specific grade. "
    "Anchors (rotating): {{COLOR_EXAMPLES}}.\n\n"
    "Replace empty quality words. \"Beautiful,\" \"detailed,\" \"intricate,\" "
    "\"stunning,\" \"masterpiece,\" \"4k/8k,\" \"award-winning\" → replace "
    "with a concrete quality or specific detail, or delete.\n\n"
    "Plain descriptive prose. No keyword lists, no parentheses weighting, "
    "no markdown. Describe only what you can see.\n\n"
    "Output ONLY the prompt paragraph. No preamble, no labels, no "
    "<think> tags."
)


# ── Image caption template ────────────────────────────────────────────────────
# Contains the full 7 aesthetic-category placeholders. Substituted at call-time
# by _build_image_system_prompt().
_OLLAMA_IMG_SYSTEM_PROMPT_TEMPLATE = (
    "You write image generation prompts for modern open-weight diffusion "
    "models (Flux 2, Qwen-Image, Z-Image, and similar). Describe only what "
    "is actually visible in the image. Do not invent or add elements not "
    "present. But describe with enough aesthetic specificity that the "
    "resulting prompt could recreate the look.\n\n"
    "VISIBLE-SUBJECT FIDELITY — hard rule. Describe the actual subject(s). "
    "Do not substitute similar-looking things, do not upgrade to sound "
    "evocative, and do not let an aesthetic tradition you recognize pull "
    "the subject toward that tradition's typical content. If the image "
    "shows an elephant, say elephant. If three people are visible, say "
    "three. The tradition is the HOW, not the WHAT.\n\n"
    "IMMERSIVE VISUAL DETAIL — describe every visible noun with concrete "
    "detail. Observed \"woman\" → age range visible, eye color, hair, "
    "expression, posture, fabric and cut of clothing, what her hands are "
    "doing. DO NOT invent ethnicity, religion, or identity-defining traits "
    "not visibly clear. Observed \"lawn\" → edging, color, mow pattern, "
    "condition. Observed \"window\" → pane type, what's on the sill, "
    "light quality. Surfaces get active behavior: what does the material "
    "do under the observed light.\n\n"
    "Identify the specific tradition visible. If it looks like film "
    "photography, name plausible film stock and lens behavior. If a "
    "painting, name the likely medium and tradition. Rotating anchors:\n"
    "  • photographic: {{PHOTO_EXAMPLES}}\n"
    "  • painting: {{PAINTING_EXAMPLES}}\n"
    "  • illustration/print: {{ILLUSTRATION_EXAMPLES}}\n"
    "  • graphic-design/poster: {{GRAPHIC_EXAMPLES}}\n"
    "  • cinematography: {{CINEMA_EXAMPLES}}\n"
    "  • animation/comic: {{ANIMATION_EXAMPLES}}\n"
    "  • digital/3D: {{DIGITAL_EXAMPLES}}\n\n"
    "ENCODER RULES — written for diffusion text encoders:\n"
    "- The FIRST sentence names the subject and the rendering tradition.\n"
    "- Direct declarative description only. Never \"The scene captures\" or "
    "\"creating a sense of.\"\n"
    "- State what IS there. Never describe by absence — \"no harsh shadows\" "
    "becomes \"soft diffuse shadows.\"\n"
    "- Place elements spatially: \"to her left,\" \"lower foreground.\"\n"
    "- Text visible in the image stays in \"double quotes\" verbatim.\n\n"
    "Cover in one flowing paragraph of 170-190 words: rendering tradition "
    "and medium; the actual subject(s) with immersive detail; composition; "
    "environment; lighting — anchors: {{LIGHTING_EXAMPLES}}; color treatment "
    "— anchors: {{COLOR_EXAMPLES}}; surface texture behavior.\n\n"
    "Replace empty quality words. \"Beautiful,\" \"detailed,\" \"intricate,\" "
    "\"stunning,\" \"masterpiece,\" \"4k/8k,\" \"award-winning\" → replace "
    "with a concrete quality or specific detail, or delete.\n\n"
    "Plain descriptive prose. No keyword lists, no parentheses weighting, "
    "no markdown. Describe only what is in the image.\n\n"
    "Output ONLY the prompt paragraph. No preamble, no labels, no "
    "<think> tags."
)


def _build_video_system_prompt(style: str = None, length_slider=None, focus_slider=None,
                               style_override=False) -> str:
    """Assemble the video caption system prompt with a fresh random subset of
    aesthetic examples for this call. Call once per request, not at import.
    Cinematography is protected from style exclusion — it is the only
    tradition menu in the video template."""
    out = _epe_apply_aesthetic_rotation(
        _OLLAMA_VID_SYSTEM_PROMPT_TEMPLATE, style=style, keep={"cinematography"})
    extra = _epe_style_slider_addendum(style, length_slider, focus_slider, style_override)
    return out + ("\n\n" + extra if extra else "")


def _build_image_system_prompt(style: str = None, length_slider=None, focus_slider=None,
                               style_override=False) -> str:
    """Assemble the image caption system prompt with a fresh random subset of
    aesthetic examples for this call. Call once per request, not at import."""
    out = _epe_apply_aesthetic_rotation(_OLLAMA_IMG_SYSTEM_PROMPT_TEMPLATE, style=style)
    extra = _epe_style_slider_addendum(style, length_slider, focus_slider, style_override)
    return out + ("\n\n" + extra if extra else "")



def _epe_url_is_loopback(url: str) -> bool:
    """True only if the URL host is localhost / a loopback IP — i.e. Ollama
    would be on THIS machine, so it is safe for us to try to start it."""
    try:
        from urllib.parse import urlparse
        host = (urlparse(url).hostname or "").strip()
        if host in ("localhost",):
            return True
        return ipaddress.ip_address(host).is_loopback
    except Exception:
        return False


# Handles of the servers we launched. `start_new_session=True` changes the
# SESSION, not the parent — `ollama serve` stays a child of the ComfyUI
# process — so a launch that exits immediately (the usual case: the port is
# already bound) leaves an unreaped entry in the process table for as long as
# ComfyUI runs. One per click of "check Ollama".
_EPE_SPAWNED = []
# One launch at a time, and not again for a while. There was no lock, no
# in-flight de-duplication and no cooldown, so N concurrent /epe/ollama/check
# requests all reached Popen and forked the ComfyUI process — which holds the
# CUDA context and the model weights — N times, with all but one failing to
# bind the port and exiting. The lock also protects _EPE_SPAWNED itself, which
# _epe_reap_spawned REBOUND rather than mutated: two pool threads racing there
# dropped each other's handles before anything had poll()ed them.
_EPE_SPAWN_LOCK     = threading.Lock()
_EPE_SPAWN_COOLDOWN = 30.0    # seconds
_EPE_SPAWN_LAST     = 0.0     # monotonic — last SUCCESSFUL launch
_EPE_SPAWN_FAILED_AT = 0.0    # monotonic — last launch that could not fork

# In-flight auto-start dedupe. Two rapid /epe/ollama/check requests both
# found "not running", both spawned once (protected by _EPE_SPAWN_LOCK +
# cooldown above), but then each spun their own 15 s poll loop looking
# for the port to come up. The second is redundant — the first will do
# the polling. Key: normalized ollama_url → asyncio.Event set when the
# primary handler finishes waiting.
_EPE_AUTOSTART_INFLIGHT = _epe_singleton("_EPE_AUTOSTART_INFLIGHT", dict)


def _epe_reap_spawned():
    """poll() every server we launched, dropping the ones that have exited.

    poll() is what performs the wait, so calling it is the reaping. Kept small
    and never awaited: this runs in the same executor call as the launch."""
    live = []
    for p in list(_EPE_SPAWNED):
        try:
            if p.poll() is None:
                live.append(p)
        except Exception:
            pass
    # In place. Rebinding the name let a concurrent launcher append to the
    # list object this call is about to replace, so its handle vanished
    # unreaped. Callers hold _EPE_SPAWN_LOCK.
    _EPE_SPAWNED[:] = live


def _epe_try_start_ollama(ollama_url: str):
    """Attempt to start a local Ollama server. Returns a reason string:
    'spawned' on success launching the process, or a failure reason that the
    frontend turns into a targeted message. Never starts a remote Ollama."""
    global _EPE_SPAWN_LAST, _EPE_SPAWN_FAILED_AT
    if not _epe_url_is_loopback(ollama_url):
        return "remote"                 # not our machine — can't start it
    exe = shutil.which("ollama")
    if not exe:
        return "not_on_path"            # binary not found for this process
    # Serialised and rate-limited. There was no lock, no in-flight
    # de-duplication and no cooldown, so N concurrent /epe/ollama/check
    # requests all reached Popen and forked the ComfyUI process — which holds
    # the CUDA context and the model weights — N times, with all but one
    # failing to bind the port and exiting. A caller that finds one already
    # coming up is told "spawned", which is true, and waits for that one.
    with _EPE_SPAWN_LOCK:
        _epe_reap_spawned()
        if _EPE_SPAWNED:
            return "spawned"            # one we launched is still running
        _now = time.monotonic()
        if _now - _EPE_SPAWN_LAST < _EPE_SPAWN_COOLDOWN:
            return "spawned"            # one was launched moments ago
        # A FAILED launch is rate-limited too, on its own stamp. Reporting it
        # as "spawned" was the round-40 bug — the frontend showed "starting
        # Ollama…" and the poll loop waited fifteen seconds for a server that
        # was never started — but stamping nothing at all removed the rate
        # limit entirely on that path: a binary present on PATH but not
        # executable made every single /epe/ollama/check re-attempt the
        # fork/exec, once per poll, for as long as the panel was open.
        if _now - _EPE_SPAWN_FAILED_AT < _EPE_SPAWN_COOLDOWN:
            return "spawn_failed"       # one failed moments ago; same answer
        _r = _epe_popen_ollama(exe)
        if _r == "spawned":
            _EPE_SPAWN_LAST = _now
        else:
            _EPE_SPAWN_FAILED_AT = _now
        return _r


def _epe_popen_ollama(exe):
    """The launch itself. The caller holds _EPE_SPAWN_LOCK."""
    try:
        kwargs = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
        if os.name == "nt":
            # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP so it outlives us
            kwargs["creationflags"] = 0x00000008 | 0x00000200
        else:
            kwargs["start_new_session"] = True   # detach from ComfyUI on POSIX
        _proc = subprocess.Popen([exe, "serve"], **kwargs)
        # Held so a later call can poll() it. Bounded: the list only ever
        # holds servers that are still running, and there is at most one real
        # Ollama per machine.
        _EPE_SPAWNED.append(_proc)
        if len(_EPE_SPAWNED) > 32:
            del _EPE_SPAWNED[:-32]
        return "spawned"
    except Exception as e:
        logger.warning(f"EPE: could not launch 'ollama serve': {e}")
        return "spawn_failed"


async def _epe_probe_ollama(ollama_url: str):
    """Return (running: bool, installedModels: [str]). Generous timeout so a
    cold start / model-loading server isn't misread as 'not running'."""
    try:
        async with _epe_ollama_session() as session:
            async with session.get(
                f"{ollama_url}/api/tags",
                allow_redirects=False,
                timeout=aiohttp.ClientTimeout(total=12),
            ) as resp:
                if resp.status == 200:
                    data = await _epe_json_capped(resp)
                    if not isinstance(data, dict):
                        return False, []
                    # `{"models": "none"}` iterated CHARACTERS and
                    # `{"models": ["qwen"]}` iterated STRINGS; either way
                    # `m.get` raised AttributeError into the bare `except`
                    # below, so a server that IS running reported as down —
                    # and epe_ollama_check then forked `ollama serve` and
                    # spent its poll loop proving the same thing 24 times.
                    # ollamaUrl is client-supplied and any private address is
                    # accepted, so this shape is not hypothetical.
                    models = [_epe_s(_epe_d(m).get("name")) or
                              _epe_s(_epe_d(m).get("model"))
                              for m in _epe_l(data.get("models"))]
                    return True, [n for n in models if n]
    except Exception:
        pass
    return False, []


@routes.post("/epe/ollama/check")
@_epe_guard
async def epe_ollama_check(request):
    """
    Check if Ollama is running and which known models are installed. If it is
    not reachable and it lives on this machine, try to start it automatically
    (spawn `ollama serve`) and wait for it to come up.
    Returns: { running, ollamaUrl, installedModels, knownModels, autoStart }
      autoStart: null | 'spawned' | 'not_on_path' | 'remote' | 'spawn_failed'
                 | 'already_starting'  (another check is mid-spawn for this URL)
    """
    try:
        body = await _epe_json_object(request)
        if body is None:
            return web.json_response(
                {"error": "request body must be a JSON object"}, status=400)
        ollama_url = _epe_normalize_ollama_url(body.get("ollamaUrl", "http://localhost:11434"))
        _u_err = await _epe_dns_check_msg(_epe_check_ollama_url, ollama_url)
        if _u_err:
            return web.json_response({"error": _u_err}, status=400)

        # Reap any zombie ollama we spawned earlier. `_epe_reap_spawned` was
        # previously called only when `running` was false (via
        # `_epe_try_start_ollama`), so a spawn that exited immediately
        # followed by the user starting ollama by hand left a <defunct>
        # child until process shutdown. Running it here catches both cases.
        #
        # NON-BLOCKING, because this runs on ComfyUI's event loop.
        # _epe_try_start_ollama holds this same lock in a pool thread across
        # subprocess.Popen(..., start_new_session=True) — and start_new_session
        # disables CPython's posix_spawn fast path, so that is a real fork() of
        # the ComfyUI process with its CUDA context and model weights resident.
        # A blocking acquire here stopped the whole loop — websockets, /prompt,
        # queue updates, every other node — for the duration: 1.66 s measured
        # with two EPE nodes checking at once.
        #
        # Skipping is free. The holder is _epe_try_start_ollama, which reaps
        # on its own way through, and the atexit hook reaps whatever is left.
        if _EPE_SPAWN_LOCK.acquire(blocking=False):
            try:
                _epe_reap_spawned()
            except Exception:
                pass
            finally:
                _EPE_SPAWN_LOCK.release()

        running, installed = await _epe_probe_ollama(ollama_url)

        auto_start = None
        if not running:
            # Dedupe against a concurrent /epe/ollama/check that already
            # started the auto-start dance for the same URL. Without this,
            # a second click while the first is still in its 15 s poll loop
            # burns its own 15 s waiting on the same port.
            _inflight = _EPE_AUTOSTART_INFLIGHT.get(ollama_url)
            if _inflight is not None:
                try:
                    # 18 s = 15 s primary poll + a little probe headroom.
                    await asyncio.wait_for(_inflight.wait(), timeout=18.0)
                except asyncio.TimeoutError:
                    pass
                running, installed = await _epe_probe_ollama(ollama_url)
                # The PRIMARY's outcome, if it left one. "already_starting"
                # means "someone is spawning it, wait" — which is a lie when
                # the primary's real answer was `not_on_path` (Ollama is not
                # installed) or `spawn_failed`. Two nodes open on a machine
                # without Ollama used to give one of them correct install
                # instructions and the other "wait a few seconds", for up to
                # 18 s — past the frontend's own 20 s abort.
                _primary = getattr(_inflight, "_epe_outcome", None)
                if _primary in ("not_on_path", "spawn_failed"):
                    auto_start = _primary
                else:
                    auto_start = "already_starting"
            else:
                _done = asyncio.Event()
                _EPE_AUTOSTART_INFLIGHT[ollama_url] = _done
                try:
                    # shutil.which walks PATH and Popen forks: both are blocking,
                    # and both were running on the event loop that ComfyUI uses to
                    # execute the graph.
                    auto_start = await asyncio.get_running_loop().run_in_executor(
                        _EPE_POOL, _epe_try_start_ollama, ollama_url)
                    # Published on the Event itself, which is the object every
                    # deduped waiter already holds. Set before the poll loop,
                    # so a waiter that wakes on the timeout rather than on
                    # `_done` still sees it.
                    try:
                        _done._epe_outcome = auto_start
                    except Exception:
                        pass
                    if auto_start == "spawned":
                        # A WALL CLOCK, not a fixed iteration count. Each probe has
                        # its own 12 s ceiling, so twenty-four of them against a port
                        # that accepts and then stalls held this handler — and a
                        # connection per iteration — for about five minutes.
                        _wait_until = asyncio.get_running_loop().time() + 15.0
                        while asyncio.get_running_loop().time() < _wait_until:
                            await asyncio.sleep(0.5)
                            running, installed = await _epe_probe_ollama(ollama_url)
                            if running:
                                break
                finally:
                    # Wake any deduped waiter and drop the slot BEFORE any
                    # return path. A crashed primary must not permanently
                    # pin future auto-starts on this URL.
                    _EPE_AUTOSTART_INFLIGHT.pop(ollama_url, None)
                    _done.set()

        logger.info(f"EPE: ollama check running={running} autoStart={auto_start} "
                    f"models={len(installed)}")
        # Version in the response so a bug report always carries it,
        # without asking the reporter to paste startup logs. See __init__.py
        # for the discovery order (importlib.metadata → pyproject fallback).
        try:
            from . import EPE_VERSION as _epe_version
        except Exception:
            _epe_version = "unknown"
        return web.json_response({
            "running":         running,
            "ollamaUrl":       ollama_url,
            "installedModels": installed,
            "knownModels":     _OLLAMA_KNOWN_MODELS,
            "autoStart":       auto_start,
            "epeVersion":      _epe_version,
        })

    except Exception as e:
        logger.error(f"Error in epe_ollama_check: {e}", exc_info=True)
        return web.json_response({"error": "Internal error — see the ComfyUI server log"}, status=500)


@routes.post("/epe/ollama/generate")
@_epe_guard
async def epe_ollama_generate_proxy(request):
    """
    Server-side proxy for Ollama's /api/generate (text features). Browsers can
    only call Ollama directly from localhost origins — any other origin gets a
    CORS 403. Backend-to-Ollama requests carry no Origin, so routing through
    here works regardless of how ComfyUI is accessed, with no OLLAMA_ORIGINS.
    Body: the normal Ollama generate payload plus "ollamaUrl".
    Streams Ollama's NDJSON response back unchanged.
    """
    try:
        body = await _epe_json_object(request)
        if body is None:
            return web.json_response(
                {"error": "request body must be a JSON object"}, status=400)
        ollama_url = _epe_normalize_ollama_url(body.pop("ollamaUrl", "") or "http://localhost:11434")
        _u_err = await _epe_dns_check_msg(_epe_check_ollama_url, ollama_url)
        if _u_err:
            return web.json_response({"error": _u_err}, status=400)

        timeout = aiohttp.ClientTimeout(total=600, sock_read=300)
        async with _epe_ollama_session(timeout=timeout) as session:
            async with session.post(f"{ollama_url}/api/generate", json=body,
                                    allow_redirects=False) as upstream:
                if upstream.status != 200:
                    text = await _epe_text_capped(upstream)
                    logger.warning("epe_ollama_generate proxy: Ollama HTTP %s: %s",
                                   upstream.status, text[:400])
                    # 502, not Ollama's own status: a 500 from Ollama was
                    # arriving at the browser as a 500 attributed to ComfyUI.
                    # Ollama's own `error` string is worth keeping — "model 'x'
                    # not found" is the message the user needs — but the raw
                    # body is not, and it is bounded here either way.
                    _msg = "Ollama returned HTTP %d" % upstream.status
                    try:
                        _j = json.loads(text)
                        if isinstance(_j, dict) and isinstance(_j.get("error"), str):
                            _msg = _j["error"][:300]
                    except Exception:
                        pass
                    return web.json_response({"error": _msg}, status=502)
                resp = web.StreamResponse()
                resp.headers["Content-Type"] = upstream.headers.get(
                    "Content-Type", "application/x-ndjson")
                await resp.prepare(request)
                # Past prepare() the response is committed: the status line and
                # headers are on the wire and part of the body may be too.
                # Returning a web.json_response from here — which is what the
                # handler's outer `except Exception` did — hands aiohttp a
                # SECOND response for the same request, and the stream never
                # gets its terminating chunk. The browser's fetch promise then
                # never settles: the editor sits in "streaming" with the
                # textarea read-only until the page is reloaded.
                #
                # The old catch tuple missed the two failures that actually
                # happen. `aiohttp.ClientPayloadError` (Ollama dies mid-body,
                # e.g. OOM-killed or restarted) and `asyncio.TimeoutError`
                # (sock_read=300 on a stalled generate) are neither
                # ConnectionError nor CancelledError.
                try:
                    async for chunk in upstream.content.iter_any():
                        await resp.write(chunk)
                except (ConnectionResetError, ConnectionError, asyncio.CancelledError):
                    # Browser aborted (user cancel) — stop pulling from Ollama.
                    # The socket is already gone; there is nothing to finish.
                    return resp
                except Exception as _exc:
                    logger.warning(
                        "epe_ollama_generate proxy: upstream stream ended "
                        "early (%s: %s)", type(_exc).__name__, _exc)
                    # An NDJSON line in the shape the frontend already handles,
                    # so the editor leaves streaming state and shows the reason.
                    try:
                        await resp.write(json.dumps(
                            {"error": "Ollama stopped responding mid-reply"}
                        ).encode() + b"\n")
                    except Exception:
                        pass
                try:
                    await resp.write_eof()
                except (ConnectionResetError, ConnectionError):
                    pass
                return resp

    except aiohttp.ClientConnectorError:
        return web.json_response(
            {"error": "Could not reach Ollama — is it running?"}, status=502)
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        # A stalled Ollama (the 600 s / 300 s ceilings) raises TimeoutError,
        # and a socket that dies before the response raises ClientOSError or
        # ServerDisconnectedError — none of them ClientConnectorError, so all
        # three reached the generic handler as HTTP 500.
        return _epe_upstream_error("epe_ollama_generate proxy", e, "Ollama")
    except Exception as e:
        logger.error(f"Error in epe_ollama_generate proxy: {e}", exc_info=True)
        return web.json_response({"error": "Internal error — see the ComfyUI server log"}, status=500)


@routes.post("/epe/ollama/pull")
@_epe_guard
async def epe_ollama_pull(request):
    """
    Pull an Ollama model. Streams progress back as newline-delimited JSON.
    POST body: { "modelName": "qwen3-vl:8b", "ollamaUrl": "http://localhost:11434" }
    """
    try:
        body = await _epe_json_object(request)
        if body is None:
            return web.json_response(
                {"error": "request body must be a JSON object"}, status=400)
        model_name = _epe_s(body.get("modelName")).strip()
        # A registry-qualified reference (host/user/model) tells Ollama to fetch
        # from somewhere else entirely, so only a plain name:tag is accepted.
        if model_name and not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(:[A-Za-z0-9._-]{1,63})?$", model_name):
            return web.json_response(
                {"error": "modelName must be a plain name or name:tag"}, status=400)
        ollama_url = _epe_normalize_ollama_url(body.get("ollamaUrl", "http://localhost:11434"))
        _u_err = await _epe_dns_check_msg(_epe_check_ollama_url, ollama_url)
        if _u_err:
            return web.json_response({"error": _u_err}, status=400)

        if not model_name:
            return web.json_response({"error": "Missing modelName"}, status=400)

        response = web.StreamResponse()
        response.headers["Content-Type"] = "application/x-ndjson"
        await response.prepare(request)

        try:
            async with _epe_ollama_session() as session:
                async with session.post(
                    f"{ollama_url}/api/pull",
                    json={"name": model_name, "stream": True},
                    # Fifteen minutes, not an hour: long enough for a large
                    # model on a slow link, short enough that a stuck pull
                    # does not hold a streaming response open all afternoon.
                    # No total ceiling at all. The plugin's own model list includes
                    # 17 GB pulls, which a 900s total killed mid-transfer on
                    # ordinary links. sock_read catches a STUCK pull instead —
                    # a healthy pull streams progress lines continuously.
                    allow_redirects=False,
                    timeout=aiohttp.ClientTimeout(total=None, sock_connect=30,
                                                  sock_read=300),
                ) as resp:
                    if resp.status != 200:
                        # This branch did not exist: the body was streamed to
                        # the browser as pull progress whatever the status was,
                        # so an error page arrived as NDJSON garbage. With
                        # allow_redirects=False above, a 3xx lands here too
                        # rather than being followed with the request re-sent.
                        _t = await _epe_text_capped(resp)
                        logger.warning("epe_ollama_pull: Ollama HTTP %s: %s",
                                       resp.status, _t[:200])
                        await response.write(json.dumps(
                            {"error": "Ollama returned HTTP %d" % resp.status}
                        ).encode() + b"\n")
                    else:
                        async for line in resp.content:
                            line = line.strip()
                            if line:
                                await response.write(line + b"\n")
        except (ConnectionResetError, ConnectionError, asyncio.CancelledError):
            # The BROWSER went away, not Ollama. Writing an error line into a
            # dead transport raises again, and that second raise escaped to
            # the outer handler, which returned a web.json_response for a
            # request whose StreamResponse was already prepared — a second
            # response over a chunked body already on the wire. It also read
            # as "Ollama could not be reached" in the log, sending anyone
            # debugging a proxy to look in the wrong place.
            return response
        except Exception as e:
            # `str(e)` here streamed "Cannot connect to host 192.168.1.50:11434
            # ssl:default [Connect call failed …]" straight into the browser's
            # NDJSON — the Ollama host, its port and the OS error text.
            logger.warning("epe_ollama_pull: %s: %s", type(e).__name__, e)
            _msg, _ = _epe_upstream_reason(e, "Ollama")
            try:
                await response.write(
                    json.dumps({"error": _msg}).encode() + b"\n"
                )
            except (ConnectionResetError, ConnectionError):
                return response

        try:
            await response.write_eof()
        except (ConnectionResetError, ConnectionError):
            pass
        return response

    except Exception as e:
        logger.error(f"Error in epe_ollama_pull: {e}", exc_info=True)
        # Past prepare() the response is committed. Handing aiohttp a second
        # one for the same request is what left the browser's fetch promise
        # unsettled, with the editor stuck in "streaming" until a reload. The
        # generate proxy has carried this reasoning since round 14; its twin
        # here did not.
        try:
            if response.prepared:
                return response
        except Exception:
            pass
        return web.json_response({"error": "Internal error — see the ComfyUI server log"}, status=500)


@routes.post("/epe/ollama/generate-image")
@_epe_guard
async def epe_ollama_generate_image(request):
    """
    Generate an image prompt from a URL using Ollama.
    POST body: { "imageUrl": str, "ollamaModel": str, "ollamaUrl": str }
    Returns: { "prompt": str }
    """
    try:
        body = await _epe_json_object(request)
        if body is None:
            return web.json_response(
                {"error": "request body must be a JSON object"}, status=400)
        image_url  = _epe_s(body.get("imageUrl")).strip()
        model_name = _epe_s(body.get("ollamaModel")).strip()
        ollama_url = _epe_normalize_ollama_url(body.get("ollamaUrl", "http://localhost:11434"))
        _u_err = await _epe_dns_check_msg(_epe_check_ollama_url, ollama_url)
        if _u_err:
            return web.json_response({"error": _u_err}, status=400)

        if not image_url:
            return web.json_response({"error": "Missing imageUrl"}, status=400)
        if not model_name:
            return web.json_response({"error": "Missing ollamaModel"}, status=400)

        # Handle base64 data URLs (from EPE toolbar file upload) or remote URLs
        img_b64 = ""
        if image_url.startswith("data:"):
            # data:image/...;base64,<data>
            try:
                img_b64 = image_url.split(",", 1)[1]
            except IndexError:
                return web.json_response({"error": "Invalid data URL"}, status=400)
            if len(img_b64) > _EPE_MAX_IMAGE_B64:
                return web.json_response({"error": "Image too large"}, status=413)
        else:
            _m_err = await _epe_dns_check_msg(_epe_check_media_url, image_url)
            if _m_err:
                return web.json_response({"error": _m_err}, status=400)
            # Download and base64-encode the image
            try:
                async with _epe_guarded_session() as session:
                    async with _epe_safe_get(
                        session, image_url,
                        headers={"User-Agent": "Mozilla/5.0"},
                        timeout=aiohttp.ClientTimeout(total=60),
                    ) as resp:
                        if resp.status != 200:
                            return web.json_response(
                                {"error": f"Image download failed (HTTP {resp.status})"}, status=502
                            )
                        img_bytes = await _epe_read_capped(resp)
                        # Up to 64 MB — encode in the pool, not on the loop.
                        img_b64 = await asyncio.get_running_loop().run_in_executor(
                            _EPE_POOL,
                            lambda: base64.b64encode(img_bytes).decode())
            except Exception as e:
                # Was f"Image download error: {e}" — the image host, its port
                # and the OS error text, in the browser. Oversize is a 413.
                return _epe_upstream_error("epe_ollama_generate_image",
                                           e, "The image host")

        # Build Ollama message with image
        payload = {
            "model":   model_name,
            "messages": [{
                "role":    "user",
                "content": _build_image_system_prompt(body.get("style"), body.get("lengthSlider"), body.get("focusSlider"), bool(body.get("styleOverride"))),
                "images":  [img_b64],
            }],
            "stream":  False,
            "options": {"temperature": 0.5, "num_ctx": 8192},
            "think":   False,
        }

        result = ""
        try:
            async with _epe_ollama_session() as session:
                async with session.post(
                    f"{ollama_url}/api/chat",
                    json=payload,
                    allow_redirects=False,
                    timeout=aiohttp.ClientTimeout(total=300),
                ) as resp:
                    if resp.status != 200:
                        return web.json_response(
                            {"error": f"Ollama returned HTTP {resp.status}"}, status=502
                        )
                    data   = await _epe_json_capped(resp)
                    result = _epe_message_content(data)
        except Exception as e:
            # Was f"Ollama request error: {e}" — host, port and OS error text
            # in the browser. A reply past the 32 MB JSON cap is a 413.
            return _epe_upstream_error("epe_ollama_generate_image", e, "Ollama")

        # Strip <think> blocks — if nothing remains, fall back to the first
        # block's content. Linear scanners: the regexes these replace are
        # quadratic on unbalanced tags and ran on the event loop.
        stripped = _epe_strip_think(result).strip()
        if not stripped:
            stripped = _epe_first_think_body(result).strip()
        result = stripped

        if not result:
            return web.json_response({"error": "Ollama returned empty response"}, status=502)

        logger.info(f"epe_ollama_generate_image: success ({len(result)} chars)")
        return web.json_response({"prompt": result})

    except Exception as e:
        logger.error(f"Error in epe_ollama_generate_image: {e}", exc_info=True)
        return web.json_response({"error": "Internal error — see the ComfyUI server log"}, status=500)


@routes.post("/epe/ollama/generate-video")
@_epe_guard
async def epe_ollama_generate_video(request):
    """
    Generate a video prompt from a video URL using Ollama (frames as images).
    POST body: { "videoUrl": str, "ollamaModel": str, "ollamaUrl": str, "numFrames": int }
    Returns: { "prompt": str }
    """
    try:
        body       = await _epe_json_object(request)
        if body is None:
            return web.json_response(
                {"error": "request body must be a JSON object"}, status=400)
        video_url  = _epe_s(body.get("videoUrl")).strip()
        if video_url.startswith("data:"):
            # Not an exemption — a refusal. This route has no data: branch, so
            # the URL went on to _epe_safe_get and came back "URL must be
            # http(s)": safe, but by accident, and phrased as though a remote
            # host had been rejected. /epe/ollama/generate-video-file is the
            # route that takes inline video.
            return web.json_response(
                {"error": "a data: URL is not accepted here — use "
                          "/epe/ollama/generate-video-file"}, status=400)
        if video_url:
            _m_err = await _epe_dns_check_msg(_epe_check_media_url, video_url)
            if _m_err:
                return web.json_response({"error": _m_err}, status=400)
        model_name = _epe_s(body.get("ollamaModel")).strip()
        ollama_url = _epe_normalize_ollama_url(body.get("ollamaUrl", "http://localhost:11434"))
        _u_err = await _epe_dns_check_msg(_epe_check_ollama_url, ollama_url)
        if _u_err:
            return web.json_response({"error": _u_err}, status=400)

        if not video_url:
            return web.json_response({"error": "Missing videoUrl"}, status=400)
        if not model_name:
            return web.json_response({"error": "Missing ollamaModel"}, status=400)

        # Download video into EPE's own scratch dir — see _epe_tmp_dir().
        # An orphan that resists the 5-retry unlink stays confined to a
        # folder we sweep on import, and does not appear in LoadImage.
        tmp_dir      = _epe_tmp_dir()
        # The filesystem pool: a makedirs against a dead mount blocks for the
        # mount timeout and cannot be cancelled, so it is kept away from both
        # the video workers and the DNS workers.
        await asyncio.get_running_loop().run_in_executor(
            _EPE_FS_POOL, functools.partial(os.makedirs, tmp_dir, exist_ok=True))
        vid_filename = f"epe_v2p_{uuid.uuid4().hex[:12]}.mp4"
        vid_path     = os.path.join(tmp_dir, vid_filename)

        try:
            async with _epe_guarded_session() as session:
                async with _epe_safe_get(
                    session, video_url,
                    headers={"User-Agent": "Mozilla/5.0"},
                    timeout=aiohttp.ClientTimeout(total=120),
                ) as resp:
                    if resp.status != 200:
                        return web.json_response(
                            {"error": f"Video download failed (HTTP {resp.status})"}, status=502
                        )
                    await _epe_stream_to_file(resp, vid_path)
        except Exception as e:
            # Was f"Video download error: {e}". A write that fails mid-stream
            # renders "[Errno 28] No space left on device:
            # '<ComfyUI input dir>/epe_v2p_….mp4'" in the browser — a server
            # path — and a video past the 512 MB cap is a 413, not a 502.
            return _epe_upstream_error("epe_ollama_generate_video",
                                       e, "The video host")

        # Extract frames — tiered frame count based on duration, evenly spread
        def _extract_frames(path):
            try:
                import av
                import io as _io
            except ImportError:
                raise _EpeAvMissing(
                    "PyAV (av) is not installed on the ComfyUI server — "
                    "install it to enable video prompts")

            def _calc_num_frames(duration_secs):
                """
                Tiered frame count based on duration, with minimums for short clips:
                  < 6s   : 2fps, minimum 15
                  5–10s  : 2fps, minimum 20
                  10–20s : 2fps, minimum 20
                  20–60s : 2fps capped at 40
                  60–120s: linear interpolation 40→80
                  >120s  : 80
                All frames evenly distributed across full clip duration.
                """
                if duration_secs <= 0:
                    return 10
                fps2 = int(duration_secs * 2)
                if duration_secs < 6:
                    return max(fps2, 15)
                elif duration_secs <= 10:
                    return max(fps2, 20)
                elif duration_secs <= 20:
                    return max(fps2, 20)
                elif duration_secs <= 60:
                    return min(fps2, 40)
                elif duration_secs <= 120:
                    t = (duration_secs - 60) / 60.0
                    return int(40 + t * (80 - 40))
                else:
                    return 80

            frames_b64 = []
            container = None
            try:
                container    = av.open(path)
                # `.video[0]` on a file with no video stream raises
                # IndexError, which the except below turns into "frame
                # extraction error" while leaving the container OPEN. On
                # Windows an open handle makes the os.remove in
                # _epe_run_then_unlink fail, the retry loop burns 5 x 0.2s in
                # a pool worker, and the downloaded video then stays in the
                # user's image directory permanently.
                if not container.streams.video:
                    raise _EpeAvMissing("the file contains no video stream")
                stream       = container.streams.video[0]
                total_frames = stream.frames or 0
                fps          = float(stream.average_rate or 25)
                duration_secs = 0.0
                if stream.duration and stream.time_base:
                    duration_secs = float(stream.duration * stream.time_base)
                elif total_frames > 0 and fps > 0:
                    duration_secs = total_frames / fps
                if total_frames <= 0:
                    total_frames = int(duration_secs * fps) or 100

                if duration_secs > _EPE_MAX_VIDEO_SECONDS:
                    raise _EpeAvMissing(
                        "the video is longer than %d minutes — trim it first"
                        % (_EPE_MAX_VIDEO_SECONDS // 60))
                n    = _calc_num_frames(duration_secs)
                # Build evenly distributed target frame indices across full duration
                targets = set(int(i * total_frames / n) for i in range(n))

                # Past the last target there is nothing left to collect, so
                # keep decoding and you are burning a pool worker for nothing.
                # A container that understates its length puts every target
                # inside the first hundred frames; without this the loop then
                # walked the rest of the file — hours of it, at 512 MB of low
                # bitrate — in a worker that a disconnecting client cannot
                # stop and that holds the staged file from being unlinked.
                _last_target = max(targets) if targets else 0
                idx = 0
                for frame in container.decode(video=0):
                    if len(frames_b64) >= n or idx > _last_target:
                        break
                    if idx >= _EPE_MAX_DECODE_FRAMES:
                        logger.warning(
                            "epe: frame walk hit the %d-frame ceiling",
                            _EPE_MAX_DECODE_FRAMES)
                        break
                    if idx in targets:
                        img = frame.to_image()
                        w, h = img.size
                        if w > 512:
                            img = img.resize((512, int(h * 512 / w)))
                        buf = _io.BytesIO()
                        img.save(buf, format="JPEG", quality=85)
                        frames_b64.append(base64.b64encode(buf.getvalue()).decode())
                    idx += 1
            except _EpeAvMissing:
                # Raised with a message worth showing — "the file contains no
                # video stream", "longer than 15 minutes". The catch-all below
                # swallowed it and the 422 said only "Could not extract frames
                # from video", so the specific text never reached anyone.
                raise
            except Exception as e:
                logger.warning(f"epe_ollama_generate_video: frame extraction error: {e}")
            finally:
                # ALWAYS, not only on the happy path. See the note above the
                # stream check: a container left open makes the staged file
                # unremovable on Windows.
                if container is not None:
                    try:
                        container.close()
                    except Exception:
                        pass
            return frames_b64

        _claim = threading.Event()
        try:
            frames_b64 = await asyncio.get_running_loop().run_in_executor(
                _EPE_POOL, _epe_run_then_unlink, _extract_frames, vid_path, _claim)
        except _EpeAvMissing as e:
            return web.json_response({"error": str(e)}, status=422)
        finally:
            # Only when the worker never started. _epe_run_then_unlink deletes
            # the file itself whenever it runs, but it does not run at all if
            # the executor job was still queued when the client disconnected —
            # and then the whole download sat in the user's image folder.
            _epe_sweep_unstarted(vid_path, _claim)

        if not frames_b64:
            return web.json_response({"error": "Could not extract frames from video"}, status=422)

        logger.info(f"epe_ollama_generate_video: {len(frames_b64)} frames extracted, model={model_name}, num_ctx={max(16384, len(frames_b64) * 1200)}")

        # Build Ollama message — frames in images array, prompt as content text
        frame_labels = "\n".join([f"[Frame {i+1} of {len(frames_b64)}]" for i in range(len(frames_b64))])
        content_text = f"These are {len(frames_b64)} evenly-spaced frames from a video clip:\n{frame_labels}\n\n{_build_video_system_prompt(body.get('style'), body.get('lengthSlider'), body.get('focusSlider'), bool(body.get('styleOverride')))}"

        payload = {
            "model":   model_name,
            "messages": [{
                "role":    "user",
                "content": content_text,
                "images":  frames_b64,
            }],
            "stream":  False,
            "options": {"temperature": 0.3, "num_ctx": max(16384, len(frames_b64) * 1200)},
            "think":   False,
        }

        result = ""
        try:
            async with _epe_ollama_session() as session:
                async with session.post(
                    f"{ollama_url}/api/chat",
                    json=payload,
                    allow_redirects=False,
                    timeout=aiohttp.ClientTimeout(total=300),
                ) as resp:
                    if resp.status != 200:
                        err_body = await _epe_text_capped(resp)
                        logger.warning(f"epe_ollama_generate_video: Ollama HTTP {resp.status}: {err_body[:200]}")
                        return web.json_response(
                            {"error": f"Ollama returned HTTP {resp.status}"}, status=502
                        )
                    data   = await _epe_json_capped(resp)
                    result = _epe_message_content(data)
                    logger.info(f"epe_ollama_generate_video: Ollama raw response length={len(result)}, done_reason={(data or {}).get('done_reason') if isinstance(data, dict) else None}, done={(data or {}).get('done') if isinstance(data, dict) else None}")
        except Exception as e:
            return _epe_upstream_error("epe_ollama_generate_video", e, "Ollama")

        # Strip <think> blocks — if nothing remains, fall back to the first
        # block's content. Linear scanners: the regexes these replace are
        # quadratic on unbalanced tags and ran on the event loop.
        stripped = _epe_strip_think(result).strip()
        if not stripped:
            # Model output was entirely inside think tags.
            stripped = _epe_first_think_body(result).strip()
        result = stripped

        if not result:
            return web.json_response({"error": "Ollama returned empty response"}, status=502)

        logger.info(f"epe_ollama_generate_video: success ({len(result)} chars)")
        return web.json_response({"prompt": result})

    except Exception as e:
        logger.error(f"Error in epe_ollama_generate_video: {e}", exc_info=True)
        return web.json_response({"error": "Internal error — see the ComfyUI server log"}, status=500)


@routes.post("/epe/ollama/extract-frame")
@_epe_guard
async def epe_ollama_extract_frame(request):
    """
    Extract the first frame from a video URL and return it as a base64 JPEG.
    POST body: { "videoUrl": str }
    Returns: { "frameB64": str }  (base64 JPEG, no data URL prefix)
    """
    try:
        body      = await _epe_json_object(request)
        if body is None:
            return web.json_response(
                {"error": "request body must be a JSON object"}, status=400)
        video_url = _epe_s(body.get("videoUrl")).strip()
        if video_url.startswith("data:"):
            # Not an exemption — a refusal. This route has no data: branch, so
            # the URL went on to _epe_safe_get and came back "URL must be
            # http(s)": safe, but by accident, and phrased as though a remote
            # host had been rejected. /epe/ollama/generate-video-file is the
            # route that takes inline video.
            return web.json_response(
                {"error": "a data: URL is not accepted here — use "
                          "/epe/ollama/generate-video-file"}, status=400)
        if video_url:
            _m_err = await _epe_dns_check_msg(_epe_check_media_url, video_url)
            if _m_err:
                return web.json_response({"error": _m_err}, status=400)

        if not video_url:
            return web.json_response({"error": "Missing videoUrl"}, status=400)

        # Download video into EPE's own scratch dir — see _epe_tmp_dir().
        tmp_dir      = _epe_tmp_dir()
        # The filesystem pool: a makedirs against a dead mount blocks for the
        # mount timeout and cannot be cancelled, so it is kept away from both
        # the video workers and the DNS workers.
        await asyncio.get_running_loop().run_in_executor(
            _EPE_FS_POOL, functools.partial(os.makedirs, tmp_dir, exist_ok=True))
        vid_filename = f"epe_frame_{uuid.uuid4().hex[:12]}.mp4"
        vid_path     = os.path.join(tmp_dir, vid_filename)

        try:
            async with _epe_guarded_session() as session:
                async with _epe_safe_get(
                    session, video_url,
                    headers={"User-Agent": "Mozilla/5.0"},
                    timeout=aiohttp.ClientTimeout(total=120),
                ) as resp:
                    if resp.status != 200:
                        return web.json_response(
                            {"error": f"Video download failed (HTTP {resp.status})"}, status=502
                        )
                    await _epe_stream_to_file(resp, vid_path)
        except Exception as e:
            # Same as the video route above: server paths and OS error text
            # were being rendered in the browser, and oversize is a 413.
            return _epe_upstream_error("epe_ollama_extract_frame",
                                       e, "The video host")

        def _get_first_frame(path):
            try:
                import av
                import io as _io
            except ImportError:
                raise _EpeAvMissing(
                    "PyAV (av) is not installed on the ComfyUI server — "
                    "install it to enable video prompts")
            container = None
            try:
                container = av.open(path)
                for frame in container.decode(video=0):
                    img = frame.to_image()
                    w, h = img.size
                    if w > 512:
                        img = img.resize((512, int(h * 512 / w)))
                    buf = _io.BytesIO()
                    img.save(buf, format="JPEG", quality=85)
                    return base64.b64encode(buf.getvalue()).decode()
            except Exception as e:
                logger.warning(f"epe_ollama_extract_frame: error: {e}")
            finally:
                # The two close() calls this replaces covered the success
                # paths only, so any decode error left the handle open — and
                # on Windows that makes the staged file unremovable, so it
                # stays in the user's image directory for good.
                if container is not None:
                    try:
                        container.close()
                    except Exception:
                        pass
            return None

        _claim = threading.Event()
        try:
            frame_b64 = await asyncio.get_running_loop().run_in_executor(
                _EPE_POOL, _epe_run_then_unlink, _get_first_frame, vid_path, _claim)
        except _EpeAvMissing as e:
            return web.json_response({"error": str(e)}, status=422)
        finally:
            _epe_sweep_unstarted(vid_path, _claim)   # see generate-video above

        if not frame_b64:
            return web.json_response({"error": "Could not extract frame from video"}, status=422)

        return web.json_response({"frameB64": frame_b64})

    except Exception as e:
        logger.error(f"Error in epe_ollama_extract_frame: {e}", exc_info=True)
        return web.json_response({"error": "Internal error — see the ComfyUI server log"}, status=500)


@routes.post("/epe/ollama/generate-video-file")
@_epe_guard
async def epe_ollama_generate_video_file(request):
    """
    Generate a video prompt from a base64-encoded local video file.
    POST body: { "videoData": "data:video/...;base64,...", "ollamaModel": str, "ollamaUrl": str }
    Returns: { "prompt": str }
    """
    try:
        body       = await _epe_json_object(request)
        if body is None:
            return web.json_response(
                {"error": "request body must be a JSON object"}, status=400)
        video_data = _epe_s(body.get("videoData")).strip()
        # 400 MB was unreachable: ComfyUI's client_max_size refuses the
        # request long before that, and request.json() has already read and
        # decoded the whole body on the event loop by the time this runs. This
        # ceiling can actually fire, and it is what the route can really
        # handle — 32 MB of base64 is a ~24 MB clip.
        if len(video_data) > _EPE_MAX_VIDEO_DATA_B64:
            return web.json_response({"error": "Video too large"}, status=413)
        model_name = _epe_s(body.get("ollamaModel")).strip()
        ollama_url = _epe_normalize_ollama_url(body.get("ollamaUrl", "http://localhost:11434"))
        _u_err = await _epe_dns_check_msg(_epe_check_ollama_url, ollama_url)
        if _u_err:
            return web.json_response({"error": _u_err}, status=400)

        if not video_data:
            return web.json_response({"error": "Missing videoData"}, status=400)
        if not model_name:
            return web.json_response({"error": "Missing ollamaModel"}, status=400)

        # Decode and write off the event loop. ~300 MB of base64 is most of
        # a second to decode and as long again to write, and this route was
        # the one video path the streaming rewrite missed. The cleanup
        # matters more than the timing: ComfyUI's input directory is the
        # user's own image folder, and a write that failed partway used to
        # leave the fragment sitting in it.
        # Staging in EPE's own scratch dir — see _epe_tmp_dir().
        tmp_dir      = _epe_tmp_dir()
        # The filesystem pool: a makedirs against a dead mount blocks for the
        # mount timeout and cannot be cancelled, so it is kept away from both
        # the video workers and the DNS workers.
        await asyncio.get_running_loop().run_in_executor(
            _EPE_FS_POOL, functools.partial(os.makedirs, tmp_dir, exist_ok=True))
        vid_filename = f"epe_vf_{uuid.uuid4().hex[:12]}.mp4"
        vid_path     = os.path.join(tmp_dir, vid_filename)

        def _decode_and_write():
            _header, _b64 = video_data.split(",", 1)
            _bytes = base64.b64decode(_b64)
            if len(_bytes) > _EPE_MAX_VIDEO_BYTES:
                raise _EpeTooLarge(
                    f"video exceeded {_EPE_MAX_VIDEO_BYTES // (1024 * 1024)} MB")
            with open(vid_path, "wb") as f:
                f.write(_bytes)

        # Extract frames using same tiered logic as generate-video
        def _extract_frames_local(path):
            try:
                import av
                import io as _io
            except ImportError:
                raise _EpeAvMissing(
                    "PyAV (av) is not installed on the ComfyUI server — "
                    "install it to enable video prompts")

            def _calc_num_frames(duration_secs):
                if duration_secs <= 0:
                    return 10
                fps2 = int(duration_secs * 2)
                if duration_secs < 6:
                    return max(fps2, 15)
                elif duration_secs <= 10:
                    return max(fps2, 20)
                elif duration_secs <= 20:
                    return max(fps2, 20)
                elif duration_secs <= 60:
                    return min(fps2, 40)
                elif duration_secs <= 120:
                    t = (duration_secs - 60) / 60.0
                    return int(40 + t * (80 - 40))
                else:
                    return 80

            frames_b64 = []
            container = None
            try:
                container    = av.open(path)
                # `.video[0]` on a file with no video stream raises
                # IndexError, which the except below turns into "frame
                # extraction error" while leaving the container OPEN. On
                # Windows an open handle makes the os.remove in
                # _epe_run_then_unlink fail, the retry loop burns 5 x 0.2s in
                # a pool worker, and the downloaded video then stays in the
                # user's image directory permanently.
                if not container.streams.video:
                    raise _EpeAvMissing("the file contains no video stream")
                stream       = container.streams.video[0]
                total_frames = stream.frames or 0
                fps          = float(stream.average_rate or 25)
                duration_secs = 0.0
                if stream.duration and stream.time_base:
                    duration_secs = float(stream.duration * stream.time_base)
                elif total_frames > 0 and fps > 0:
                    duration_secs = total_frames / fps
                if total_frames <= 0:
                    total_frames = int(duration_secs * fps) or 100

                if duration_secs > _EPE_MAX_VIDEO_SECONDS:
                    raise _EpeAvMissing(
                        "the video is longer than %d minutes — trim it first"
                        % (_EPE_MAX_VIDEO_SECONDS // 60))
                n       = _calc_num_frames(duration_secs)
                targets = set(int(i * total_frames / n) for i in range(n))

                # Past the last target there is nothing left to collect, so
                # keep decoding and you are burning a pool worker for nothing.
                # A container that understates its length puts every target
                # inside the first hundred frames; without this the loop then
                # walked the rest of the file — hours of it, at 512 MB of low
                # bitrate — in a worker that a disconnecting client cannot
                # stop and that holds the staged file from being unlinked.
                _last_target = max(targets) if targets else 0
                idx = 0
                for frame in container.decode(video=0):
                    if len(frames_b64) >= n or idx > _last_target:
                        break
                    if idx >= _EPE_MAX_DECODE_FRAMES:
                        logger.warning(
                            "epe: frame walk hit the %d-frame ceiling",
                            _EPE_MAX_DECODE_FRAMES)
                        break
                    if idx in targets:
                        img = frame.to_image()
                        w, h = img.size
                        if w > 512:
                            img = img.resize((512, int(h * 512 / w)))
                        buf = _io.BytesIO()
                        img.save(buf, format="JPEG", quality=85)
                        frames_b64.append(base64.b64encode(buf.getvalue()).decode())
                    idx += 1
            except _EpeAvMissing:
                raise
            except Exception as e:
                logger.warning(f"epe_ollama_generate_video_file: frame extraction error: {e}")
            finally:
                if container is not None:
                    try:
                        container.close()
                    except Exception:
                        pass
            return frames_b64

        def _write_extract_unlink(_path):
            # ONE job: the file is created, used and deleted without the
            # request coroutine ever being responsible for it. A client
            # disconnect raises CancelledError — a BaseException, which the
            # handler's except clauses never caught — and the worker thread
            # cannot be stopped, so anything the handler tried to clean up
            # afterwards was cleaning up a file the worker had not written
            # yet. Ownership belongs here.
            _decode_and_write()
            return _extract_frames_local(_path)

        try:
            frames_b64 = await asyncio.get_running_loop().run_in_executor(
                _EPE_POOL, _epe_run_then_unlink, _write_extract_unlink, vid_path)
        except _EpeTooLarge as e:
            return web.json_response({"error": str(e)}, status=413)
        except _EpeAvMissing as e:
            return web.json_response({"error": str(e)}, status=422)
        except (ValueError, TypeError, base64.binascii.Error) as e:
            # Not str(e). The messages are benign today, but PyAV's
            # InvalidDataError subclasses ValueError and carries the absolute
            # staged path — and _epe_upstream_reason's docstring states the
            # policy every other handler follows: nothing derived from an
            # exception's text reaches the caller.
            logger.warning("epe_ollama_generate_video_file: bad videoData: %s: %s",
                           type(e).__name__, e)
            return web.json_response({"error": "Invalid video data"}, status=400)
        # No sweep here, unlike the other two video routes. There the HANDLER
        # downloads the file before handing it over, so a job cancelled while
        # still queued leaves a file nobody will remove. Here the WORKER
        # creates it (_decode_and_write runs inside _write_extract_unlink), so
        # a job cancelled while queued wrote nothing at all — and any job that
        # did start is cleaned up by _epe_run_then_unlink's own finally.

        if not frames_b64:
            return web.json_response({"error": "Could not extract frames from video"}, status=422)

        frame_labels = "\n".join([f"[Frame {i+1} of {len(frames_b64)}]" for i in range(len(frames_b64))])
        content_text = f"These are {len(frames_b64)} evenly-spaced frames from a video clip:\n{frame_labels}\n\n{_build_video_system_prompt(body.get('style'), body.get('lengthSlider'), body.get('focusSlider'), bool(body.get('styleOverride')))}"

        payload = {
            "model":   model_name,
            "messages": [{
                "role":    "user",
                "content": content_text,
                "images":  frames_b64,
            }],
            "stream":  False,
            "think":   False,
            "options": {"temperature": 0.3, "num_ctx": max(16384, len(frames_b64) * 1200)},
        }

        result = ""
        try:
            async with _epe_ollama_session() as session:
                async with session.post(
                    f"{ollama_url}/api/chat",
                    json=payload,
                    allow_redirects=False,
                    timeout=aiohttp.ClientTimeout(total=300),
                ) as resp:
                    if resp.status != 200:
                        return web.json_response({"error": f"Ollama returned HTTP {resp.status}"}, status=502)
                    data   = await _epe_json_capped(resp)
                    result = _epe_message_content(data)
        except Exception as e:
            return _epe_upstream_error("epe_ollama_generate_video_file", e, "Ollama")

        # Linear scanners — see _epe_strip_think.
        stripped = _epe_strip_think(result).strip()
        if not stripped:
            stripped = _epe_first_think_body(result).strip()
        result = stripped

        if not result:
            return web.json_response({"error": "Ollama returned empty response"}, status=502)

        logger.info(f"epe_ollama_generate_video_file: success ({len(result)} chars)")
        return web.json_response({"prompt": result})

    except Exception as e:
        logger.error(f"Error in epe_ollama_generate_video_file: {e}", exc_info=True)
        return web.json_response({"error": "Internal error — see the ComfyUI server log"}, status=500)


def _epe_live_pools():
    """Every pool this process actually holds, rebuilt ones included.

    `_epe_on_shutdown` and the atexit hook used to iterate the module-level
    names, which still point at whatever the FIRST import created — so a pool
    that `_epe_singleton` rebuilt after an earlier shutdown was never stopped,
    and the one that got stopped was one nobody was using.
    """
    _pools = []
    for _n in list(getattr(_EPE_HOLDER, "_epe_singleton_names", ())):
        _p = getattr(_EPE_HOLDER, _n, None)
        if _p is not None and hasattr(_p, "shutdown") and _p not in _pools:
            _pools.append(_p)
    for _p in (_EPE_DNS_POOL, _EPE_POOL, _EPE_FS_POOL):
        if _p not in _pools:
            _pools.append(_p)
    return _pools


async def _epe_on_shutdown(_app=None):
    """Server shutdown: close the shared ClientSession (silences aiohttp's
    'Unclosed client session' on every exit) and stop EPE's thread pools so
    queued work is dropped rather than run against a dying interpreter. A
    lookup already stuck inside the OS resolver cannot be cancelled — but
    with cancel_futures=True nothing new starts behind it.
    """
    # Set the closing flag FIRST so any request that races the shutdown
    # cannot lazily build a replacement session that never gets closed.
    _EPE_HOLDER._epe_closing = True
    s = getattr(_EPE_HOLDER, "_shared_session", None)
    _EPE_HOLDER._shared_session = None
    if s is not None and not s.closed:
        try:
            await s.close()
        except Exception:
            pass
    # From the HOLDER, not from the module globals — see _epe_live_pools.
    for _pool in _epe_live_pools():
        try:
            _pool.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass


def _epe_reap_at_exit():
    """Poll anything still in _EPE_SPAWNED so it is not left <defunct>.

    _epe_reap_spawned runs only from _epe_try_start_ollama, i.e. only on the
    NEXT auto-start attempt — which only happens when Ollama is found not
    running. A spawn that exits immediately (the usual case: the port is
    already bound) and is then followed by the user starting Ollama by hand is
    never polled again, and stays a zombie for the life of the process.
    """
    try:
        with _EPE_SPAWN_LOCK:
            _epe_reap_spawned()
    except Exception:
        pass


def _epe_atexit_cleanup():
    """Last resort: stop the pools so a stuck DNS thread cannot hold the
    interpreter open. ComfyUI exits on KeyboardInterrupt without ever calling
    runner.cleanup(), so neither aiohttp signal below is guaranteed to fire —
    this one does. The pools ONLY: closing the aiohttp session is an await and
    there is no running loop at atexit, so it cannot happen here.

    And be honest about the pools too. CPython runs
    threading._shutdown — which JOINS every non-daemon pool worker — BEFORE
    it calls the atexit hooks, so by the time this runs the join has already
    finished. Measured: with one DNS worker wedged for 15 s, this hook fires
    at +14.70 s and finds the pool already shut down. `shutdown(wait=False,
    cancel_futures=True)` drops QUEUED items, which is worth doing; it cannot
    shorten a getaddrinfo already in flight. Making that true would mean not
    using a ThreadPoolExecutor for uncancellable DNS at all."""
    _epe_reap_at_exit()
    # From the HOLDER, not from the module globals — see _epe_live_pools.
    for _pool in _epe_live_pools():
        try:
            _pool.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass


if not _EPE_ALREADY_REGISTERED:
    # Sweep any orphaned staged videos from the last run. Only on the FIRST
    # import — a re-import (registry + clone, or ComfyUI-Manager reload) may
    # happen while a live request is writing epe_tmp/epe_v2p_*.mp4, and an
    # unconditional sweep would unlink a file the request still holds open.
    try:
        _epe_sweep_tmp_dir()
    except Exception as _e:
        logger.warning(f"epe: import-time video-scratch sweep failed: {_e}")
    try:
        # on_cleanup ONLY. The note above is right that aiohttp fires
        # on_shutdown before draining in-flight handlers — and then
        # registered the session-closing, pool-stopping callback on it
        # anyway, arguing idempotence. Idempotence is not the property that
        # matters here; ORDERING is. Firing early gives every in-flight
        # handler "Session is closed" and "cannot schedule new futures after
        # shutdown", and _epe_stream_to_file's cleanup then takes its "pool
        # down, leaving staged file" branch — so a partial .mp4 stays in
        # the user's image directory for good, which is the outcome the
        # 140 lines around it exist to prevent. atexit is still what
        # actually runs under stock ComfyUI.
        PromptServer.instance.app.on_cleanup.append(_epe_on_shutdown)
    except Exception:
        logger.warning("epe: could not register shutdown cleanup")

    try:
        import atexit as _epe_atexit
        _epe_atexit.register(_epe_atexit_cleanup)
    except Exception:
        pass

    # Mark registration complete. A second import (registry + clone, or a
    # ComfyUI-Manager reload) will see this and skip route decoration,
    # on_cleanup, and atexit — reusing the pools and session from the
    # first import instead.
    _EPE_HOLDER._registered = True
    logger.info("EPE API routes registered")
else:
    logger.info("EPE api.py re-imported — reusing pools/session from first import (no duplicate routes)")

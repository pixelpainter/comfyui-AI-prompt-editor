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
import aiohttp
import socket
import ipaddress

from aiohttp import web
from server import PromptServer
import folder_paths


# ── Request hardening helpers ────────────────────────────────────────────────
# Universal defaults that close abuse paths without breaking normal setups.

_EPE_MAX_IMAGE_B64 = 50_000_000    # ~37 MB binary image
_EPE_MAX_VIDEO_B64 = 400_000_000   # ~300 MB binary video


def _epe_resolved_ips(host: str):
    """Resolve a hostname to its IPs. Returns [] on failure."""
    try:
        infos = socket.getaddrinfo(host, None)
        return [ipaddress.ip_address(i[4][0]) for i in infos]
    except Exception:
        return []


def _epe_ip_is_private(ip) -> bool:
    return (ip.is_private or ip.is_loopback or ip.is_link_local
            or ip.is_reserved or ip.is_unspecified)


def _epe_check_ollama_url(url: str) -> str:
    """Ollama must live on localhost or the user's private network.
    Returns '' if OK, else an error message."""
    try:
        from urllib.parse import urlparse
        u = urlparse(url)
        if u.scheme not in ("http", "https"):
            return "ollamaUrl must be http(s)"
        ips = _epe_resolved_ips(u.hostname or "")
        if not ips:
            return "ollamaUrl host did not resolve"
        if not all(_epe_ip_is_private(ip) for ip in ips):
            return "ollamaUrl must point to localhost or a private-network address"
        return ""
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


logger = logging.getLogger("EPE")

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
_shared_session: "aiohttp.ClientSession | None" = None


def _get_session() -> aiohttp.ClientSession:
    """Return a lazily-created module-level aiohttp session."""
    global _shared_session
    if _shared_session is None or _shared_session.closed:
        _shared_session = aiohttp.ClientSession(
            headers={"Accept-Encoding": "gzip, deflate"},
        )
    return _shared_session


async def _post_json_with_retries(
    url: str,
    *,
    json_body: dict,
    headers: dict | None = None,
    timeout_total: float = 30.0,
    max_attempts: int = 3,
    label: str = "request",
):
    """
    POST ``json_body`` to ``url`` and return the decoded JSON response.

    Retries on network timeouts and on HTTP 429/502/503/504 with exponential
    backoff (0.5s, 1s, 2s). On non-retryable error status codes, returns the
    (status, text) so the caller can log the response body and fail cleanly.

    Returns one of:
      ("ok",     <decoded json>)
      ("status", <int status>, <response text (truncated)>)
      ("error",  <str error message>)
    """
    session = _get_session()
    backoff = 0.5
    last_err = None

    for attempt in range(1, max_attempts + 1):
        try:
            async with session.post(
                url,
                json=json_body,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=timeout_total),
            ) as resp:
                if resp.status == 200:
                    try:
                        data = await resp.json(content_type=None)
                    except Exception as e:
                        body_preview = (await resp.text())[:500]
                        logger.warning(
                            f"{label}: 200 but JSON decode failed ({e}); body head: {body_preview!r}"
                        )
                        return ("error", f"Invalid JSON response: {e}")
                    return ("ok", data)

                if resp.status in _RETRY_STATUSES and attempt < max_attempts:
                    err_text = (await resp.text())[:300]
                    logger.info(
                        f"{label}: status {resp.status} (attempt {attempt}/{max_attempts}), retrying in {backoff}s; body head: {err_text!r}"
                    )
                    await asyncio.sleep(backoff)
                    backoff *= 2
                    continue

                # Non-retryable status or final attempt
                err_text = (await resp.text())[:500]
                logger.warning(
                    f"{label}: non-retryable status {resp.status} on attempt {attempt}; body head: {err_text!r}"
                )
                return ("status", resp.status, err_text)

        except asyncio.TimeoutError:
            last_err = "timeout"
            logger.info(
                f"{label}: timeout (attempt {attempt}/{max_attempts}, timeout={timeout_total}s)"
            )
            if attempt < max_attempts:
                await asyncio.sleep(backoff)
                backoff *= 2
                continue
        except aiohttp.ClientError as e:
            last_err = f"client error: {e}"
            logger.info(f"{label}: {last_err} (attempt {attempt}/{max_attempts})")
            if attempt < max_attempts:
                await asyncio.sleep(backoff)
                backoff *= 2
                continue

    return ("error", last_err or "request failed")


@routes.post("/epe/prompts/search")
async def epe_prompts_search(request):
    """
    Search CivitAI for image or video prompts by topic.
    mediaType="image" (default): Meilisearch images_v6 index.
    mediaType="video": Civitai REST API /v1/images?type=video.
    Returns a flat list of {id, imageUrl, videoUrl, mediaType, name, prompt, steps, cfg, sampler, seed}.
    """
    try:
        body       = await request.json()
        query      = body.get("query", "").strip()
        sort       = body.get("sort", "Most Reactions")
        period     = body.get("period", "Month")
        nsfw       = body.get("nsfw", False)
        page       = int(body.get("page", 1))
        media_type = body.get("mediaType", "image")

        MEILI_URL = "https://search-new.civitai.com/multi-search"
        MEILI_KEY = "8c46eb2508e21db1e9828a97968d91ab1ca1caa5f70a00e88a2ba1e286603b61"
        IMAGE_CDN = "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA"

        if not query:
            return web.json_response({"items": [], "metadata": {"hasMore": False}})

        # Shared sort/period config used by both image and video branches
        sort_map = {
            "Most Reactions":  "stats.reactionCountAllTime:desc",
            "Most Collected":  "stats.collectedCountAllTime:desc",
            "Newest":          "createdAt:desc",
        }
        sort_expr = sort_map.get(sort, "stats.reactionCountAllTime:desc")

        period_ms_map = {
            "Day":      86400    * 1000,
            "Week":     604800   * 1000,
            "Month":    2592000  * 1000,
            "6Month":   15552000 * 1000,
            "Year":     31536000 * 1000,
        }
        period_filter = None
        if period in period_ms_map:
            now_ms    = int(datetime.datetime.utcnow().timestamp() * 1000)
            cutoff_ms = now_ms - period_ms_map[period]
            period_filter = f"createdAtUnix >= {cutoff_ms}"

        nsfw_filter = "(nsfwLevel != 32)" if nsfw else "(nsfwLevel = 1)"

        headers = {
            "Authorization":   f"Bearer {MEILI_KEY}",
            "Content-Type":    "application/json",
            "Origin":          "https://civitai.com",
            "Referer":         "https://civitai.com/",
        }

        # ── VIDEO branch — images_v6 with (type = video) filter ──────────
        if media_type == "video":
            filters = ["(type = video)", nsfw_filter]
            if period_filter:
                filters.append(period_filter)

            fetch_limit = 40
            offset = (page - 1) * fetch_limit

            meili_body = {
                "queries": [{
                    "q":                     query,
                    "indexUid":              "images_v6",
                    "attributesToHighlight": [],
                    "highlightPreTag":       "__ais-highlight__",
                    "highlightPostTag":      "__/ais-highlight__",
                    "limit":                 fetch_limit,
                    "offset":                offset,
                    "filter":                filters,
                    "sort":                  [sort_expr],
                }]
            }

            result = await _post_json_with_retries(
                MEILI_URL,
                json_body=meili_body,
                headers=headers,
                timeout_total=30.0,
                label="civitai video search",
            )
            if result[0] == "status":
                return web.json_response({"error": f"Video search failed ({result[1]})"}, status=502)
            if result[0] == "error":
                return web.json_response({"error": "Video search failed"}, status=504)
            data = result[1]

            results    = data.get("results", [])
            hits       = results[0].get("hits", [])              if results else []
            total_hits = results[0].get("estimatedTotalHits", 0) if results else 0

            items_out = []
            for hit in hits:
                url_val   = hit.get("url", "")
                video_url = f"{IMAGE_CDN}/{url_val}/original=true" if url_val and not url_val.startswith("http") else url_val
                thumb_url = f"{IMAGE_CDN}/{url_val}/width=450"     if url_val and not url_val.startswith("http") else url_val
                prompt = hit.get("prompt", "")
                if not prompt:
                    continue
                meta = hit.get("metadata") or {}
                items_out.append({
                    "id":        str(hit.get("id", "")),
                    "imageUrl":  thumb_url,
                    "videoUrl":  video_url,
                    "mediaType": "video",
                    "isPng":     False,
                    "name":      (hit.get("user") or {}).get("username", "") or hit.get("username", ""),
                    "prompt":    prompt,
                    "steps":     str(meta.get("steps")    or meta.get("Steps")    or ""),
                    "cfg":       str(meta.get("cfgScale") or meta.get("cfg_scale") or ""),
                    "sampler":   str(meta.get("sampler")  or meta.get("Sampler")  or ""),
                    "seed":      str(meta.get("seed")     or meta.get("Seed")     or ""),
                })

            has_more = (offset + fetch_limit) < total_hits
            server_ms = (data.get("results", [{}])[0] or {}).get("processingTimeMs")
            logger.info(
                f"epe_prompts_search video '{query}' page={page}: "
                f"{len(items_out)} items, ~{total_hits} total, server={server_ms}ms"
            )
            return web.json_response({
                "items":    items_out,
                "metadata": {"hasMore": has_more, "page": page},
            })

        # ── IMAGE branch — images_v6 with (type != video) filter ──────────
        #
        # Adding (type != video) narrows Meilisearch's candidate set
        # substantially (video is a small fraction of images_v6) and speeds
        # up server-side processing by ~30%. We fetch 40 then dedup down to
        # 20 — empirically only ~30 hits are needed to clear dedup.

        filters = ["(type != video)", nsfw_filter]
        if period_filter:
            filters.append(period_filter)

        fetch_limit = 40
        offset = (page - 1) * fetch_limit
        images_per_page = 20

        meili_body = {
            "queries": [{
                "q":                     query,
                "indexUid":              "images_v6",
                "attributesToHighlight": [],
                "highlightPreTag":       "__ais-highlight__",
                "highlightPostTag":      "__/ais-highlight__",
                "limit":                 fetch_limit,
                "offset":                offset,
                "filter":                filters,
                "sort":                  [sort_expr],
            }]
        }

        result = await _post_json_with_retries(
            MEILI_URL,
            json_body=meili_body,
            headers=headers,
            timeout_total=30.0,
            label="civitai image search",
        )
        if result[0] == "status":
            return web.json_response({"error": f"Search failed ({result[1]})"}, status=502)
        if result[0] == "error":
            return web.json_response({"error": "Search timed out, please try again"}, status=504)
        data = result[1]

        results    = data.get("results", [])
        hits       = results[0].get("hits", [])              if results else []
        total_hits = results[0].get("estimatedTotalHits", 0) if results else 0
        server_ms  = results[0].get("processingTimeMs")      if results else None

        def _prompt_sig(text):
            """Fuzzy signature: lowercase, strip lora/embedding tags, collapse whitespace,
               take first 120 chars of meaningful words for comparison."""
            t = text.lower()
            t = re.sub(r'<[^>]+>', '', t)          # strip <lora:...> etc
            t = re.sub(r'[()\[\]{}:0-9._\-]+', ' ', t)  # strip weights/punctuation
            t = re.sub(r'\s+', ' ', t).strip()
            return t[:120]

        def _similar(a, b, threshold=0.75):
            """Returns True if two prompt signatures share >= threshold of their words."""
            wa = set(a.split())
            wb = set(b.split())
            if not wa or not wb:
                return False
            overlap = len(wa & wb) / max(len(wa), len(wb))
            return overlap >= threshold

        images_out = []
        seen_sigs  = []

        for hit in hits:
            if len(images_out) >= images_per_page:
                break

            prompt = hit.get("prompt", "")
            if not prompt:
                continue

            sig = _prompt_sig(prompt)
            if any(_similar(sig, s) for s in seen_sigs):
                continue
            seen_sigs.append(sig)

            meta = hit.get("metadata") or {}

            url_val = hit.get("url", "")
            if url_val and not url_val.startswith("http"):
                image_url = f"{IMAGE_CDN}/{url_val}/width=450"
            else:
                image_url = url_val

            # Detect PNG vs JPEG from the URL or mimeType field so JS can skip probing JPEGs
            mime   = (hit.get("mimeType") or hit.get("mime_type") or "").lower()
            is_png = mime == "image/png" or url_val.lower().endswith(".png")

            user = hit.get("user") or {}
            images_out.append({
                "id":        hit.get("id", ""),
                "imageUrl":  image_url,
                "videoUrl":  "",
                "mediaType": "image",
                "isPng":     is_png,
                "name":      user.get("username", "") or hit.get("name", ""),
                "prompt":    prompt,
                "steps":     meta.get("steps")    or meta.get("Steps")    or "",
                "cfg":       meta.get("cfgScale") or meta.get("cfg_scale") or meta.get("CfgScale") or "",
                "sampler":   meta.get("sampler")  or meta.get("Sampler")  or "",
                "seed":      meta.get("seed")     or meta.get("Seed")     or "",
            })

        has_more = (offset + fetch_limit) < total_hits
        logger.info(
            f"epe_prompts_search image '{query}' page={page}: "
            f"{len(images_out)}/{len(hits)} hits kept, server={server_ms}ms, hasMore={has_more}"
        )

        return web.json_response({
            "items":    images_out,
            "metadata": {"hasMore": has_more, "page": page},
        })

    except Exception as e:
        logger.error(f"Error in epe_prompts_search: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


# ─────────────────────────────────────────────────────────────────────────────
# Genur.art prompt search
# ─────────────────────────────────────────────────────────────────────────────

@routes.post("/epe/prompts/search-genur")
async def epe_prompts_search_genur(request):
    """
    Search Genur.art for image prompts by topic.
    GET https://genur.art/api/search?q=...&sort=top&page=...
    Returns same shape as /epe/prompts/search: { items, metadata }
    """
    try:
        body       = await request.json()
        query      = body.get("query", "").strip()
        page       = int(body.get("page", 1))
        sort       = body.get("sort", "popular")     # "popular" | "newest" | "oldest" | "relevant"

        if not query:
            return web.json_response({"items": [], "metadata": {"hasMore": False, "page": page}})

        url = "https://genur.art/api/search"
        params = {"q": query, "sort": sort, "page": page}
        headers = {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
        }

        data = None
        for _attempt in range(2):
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        url, params=params, headers=headers,
                        timeout=aiohttp.ClientTimeout(total=30)
                    ) as resp:
                        if resp.status != 200:
                            err = await resp.text()
                            logger.warning(f"epe_prompts_search_genur {resp.status}: {err[:200]}")
                            return web.json_response({"error": f"Genur.art search failed ({resp.status})"}, status=502)
                        data = await resp.json(content_type=None)
                break
            except asyncio.TimeoutError:
                logger.warning(f"epe_prompts_search_genur timeout (attempt {_attempt+1}/2)")
                if _attempt == 1:
                    return web.json_response({"error": "Genur.art search timed out, please try again"}, status=504)
                await asyncio.sleep(1)

        if data is None:
            return web.json_response({"error": "Genur.art search failed"}, status=502)

        results     = data.get("results", [])
        total_pages = int(data.get("totalPages", 1))

        items_out = []
        for item in results:
            if item.get("is_nsfw", False):
                continue
            prompt = item.get("prompt", "")
            if not prompt:
                continue
            item_type = item.get("type", "image")  # Genur returns "image" or "video"
            item_url  = item.get("url", "")
            is_png    = item_url.lower().endswith(".png") or (".png" in item_url.lower().split("?")[0])
            items_out.append({
                "id":        item.get("id", ""),
                "imageUrl":  item_url if item_type != "video" else "",
                "videoUrl":  item_url if item_type == "video" else "",
                "mediaType": item_type,
                "isPng":     is_png,
                "name":      item.get("username", ""),
                "prompt":    prompt,
                "model":     item.get("base_model", ""),
                "tags":      item.get("tags", []),
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

    except Exception as e:
        logger.error(f"Error in epe_prompts_search_genur: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


# ─────────────────────────────────────────────────────────────────────────────
# SeaArt prompt search + detail
# ─────────────────────────────────────────────────────────────────────────────

@routes.post("/epe/prompts/search-seaart")
async def epe_prompts_search_seaart(request):
    """
    Search SeaArt for image prompts by topic.
    POST https://www.seaart.ai/api/v1/square/v3/search/list
    Returns { items, metadata } — prompt is null (fetched lazily on click).
    mediaType="image" (default): obj_type=4. mediaType="video": obj_type=15.
    """
    try:
        body       = await request.json()
        query      = body.get("query", "").strip()
        page       = int(body.get("page", 1))
        order      = body.get("sort", "hot")   # "hot" | "new"
        media_type = body.get("mediaType", "image")
        # obj_type=4 = image posts, obj_type=15 = video posts
        obj_type   = 15 if media_type == "video" else 4

        if not query:
            return web.json_response({"items": [], "metadata": {"hasMore": False, "page": page}})

        url = "https://www.seaart.ai/api/v1/square/v3/search/list"
        # Browser-like headers — SeaArt's edge has grown stricter over time and
        # bare ``Mozilla/5.0`` without Origin/Referer is more likely to be rejected.
        headers = {
            "Content-Type":    "application/json",
            "Accept":          "application/json",
            "Origin":          "https://www.seaart.ai",
            "Referer":         "https://www.seaart.ai/",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        }
        payload = {
            "order_by":  order,
            "scene":     "square",
            "obj_name":  query,
            "obj_type":  obj_type,
            "page":      page,
            "page_size": 35,
            "offset":    0,
            "ss":        0,
        }

        result = await _post_json_with_retries(
            url,
            json_body=payload,
            headers=headers,
            timeout_total=30.0,
            label="seaart search",
        )
        if result[0] == "status":
            return web.json_response({"error": f"SeaArt search failed ({result[1]})"}, status=502)
        if result[0] == "error":
            return web.json_response({"error": "SeaArt search failed"}, status=504)
        data = result[1]

        # Defensive shape check — log once if the envelope changes rather than
        # 502-ing silently, so future breakage is diagnosable from the log.
        status_obj  = data.get("status") or {}
        status_code = status_obj.get("code")
        if status_code != 10000:
            msg = status_obj.get("msg", "Unknown error")
            logger.warning(
                f"seaart search API error: code={status_code} msg={msg!r} "
                f"top-level keys={list(data.keys())}"
            )
            return web.json_response({"error": f"SeaArt API error: {msg}"}, status=502)

        api_data  = data.get("data") or {}
        raw_items = api_data.get("items") or []
        has_more  = bool(api_data.get("has_more", False))

        def _as_int(v, default=0):
            """Tolerant int cast — handles None, strings, floats without raising."""
            try:
                return int(v)
            except (TypeError, ValueError):
                return default

        items_out    = []
        filtered_nsfw = 0
        filtered_nocover = 0
        filtered_noid    = 0

        for item in raw_items:
            # NSFW filter — only ``nsfw_level`` and ``c_nsfw_level`` reflect
            # content safety. The ``nsfw`` field (observed value: 2 on every
            # benign result) is a category/content-type tag, not a safety
            # level, so it must NOT be part of the filter.
            if _as_int(item.get("nsfw_level")) > 0 or _as_int(item.get("c_nsfw_level")) > 0:
                filtered_nsfw += 1
                continue

            cover = item.get("cover") or {}
            cover_url = cover.get("url", "") if isinstance(cover, dict) else ""
            stream = item.get("stream") or {}
            # Video items carry stream.url3 as the actual video URL
            video_url = (stream.get("url3", "") or stream.get("url", "")) if isinstance(stream, dict) else ""
            is_video  = bool(item.get("is_video_has_audio")) or media_type == "video"

            # Portfolio items (sub_obj_type=1) have a child list — the actual artwork
            # ID needed for detail lookup is child[0].id, not the portfolio id
            children   = item.get("child") or []
            artwork_id = children[0].get("id", "") if children else item.get("id", "")

            if not artwork_id:
                filtered_noid += 1
                continue
            if not is_video and not cover_url:
                filtered_nocover += 1
                continue

            items_out.append({
                "id":        item.get("id", ""),
                "artworkId": artwork_id,
                "imageUrl":  cover_url if not is_video else "",
                "videoUrl":  video_url if is_video else "",
                "mediaType": "video" if is_video else "image",
                "name":      (item.get("author") or {}).get("name", ""),
                "prompt":    None,
                "steps":     "",
                "cfg":       "",
                "sampler":   "",
                "seed":      "",
            })

        # Defensive warning: if the API returned rows but our filter dropped
        # them all, something in the upstream schema likely changed again.
        if raw_items and not items_out:
            sample = raw_items[0]
            logger.warning(
                f"seaart search returned {len(raw_items)} items but all were filtered "
                f"(nsfw={filtered_nsfw} no_id={filtered_noid} no_cover={filtered_nocover}). "
                f"Sample keys: {list(sample.keys())[:20]} "
                f"Sample nsfw fields: nsfw={sample.get('nsfw')} "
                f"nsfw_level={sample.get('nsfw_level')} c_nsfw_level={sample.get('c_nsfw_level')}"
            )

        logger.info(
            f"epe_prompts_search_seaart '{query}' page={page}: "
            f"{len(items_out)}/{len(raw_items)} items kept, hasMore={has_more}"
        )

        return web.json_response({
            "items":    items_out,
            "metadata": {"hasMore": has_more, "page": page},
        })

    except Exception as e:
        logger.error(f"Error in epe_prompts_search_seaart: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/epe/prompts/seaart-detail")
async def epe_prompts_seaart_detail(request):
    """
    Fetch full prompt + metadata for a single SeaArt post.
    POST body: { "id": "<postId>", "mediaType": "image"|"video" }
    Tries post/v2/detail first (image posts); falls back to artwork/detail (video posts).
    Returns: { prompt, negativePrompt, model, steps, cfg, seed, imageUrl, videoUrl, mediaType }
    """
    try:
        body       = await request.json()
        post_id    = body.get("id", "").strip()
        # artworkId is the child artwork ID for portfolio items — use it if provided
        artwork_id = body.get("artworkId", "").strip() or post_id
        media_type = body.get("mediaType", "image")

        if not post_id:
            return web.json_response({"error": "Missing id"}, status=400)

        headers = {
            "Content-Type": "application/json",
            "Accept":       "application/json",
            "User-Agent":   "Mozilla/5.0",
        }

        async def _fetch_detail(url, payload):
            for _attempt in range(2):
                try:
                    async with aiohttp.ClientSession() as session:
                        async with session.post(
                            url, json=payload, headers=headers,
                            timeout=aiohttp.ClientTimeout(total=15)
                        ) as resp:
                            if resp.status != 200:
                                return None, resp.status
                            return await resp.json(content_type=None), 200
                except asyncio.TimeoutError:
                    if _attempt == 1:
                        return None, 504
                    await asyncio.sleep(0.5)
            return None, 0

        data = None

        # If artwork_id differs from post_id it's a portfolio — go straight to artwork/detail
        # which works for individual artwork IDs. Only use post/v2/detail for non-portfolio images.
        if media_type != "video" and artwork_id == post_id:
            data_v2, status_v2 = await _fetch_detail(
                "https://www.seaart.ai/api/v1/post/v2/detail", {"id": post_id}
            )
            if data_v2 and data_v2.get("status", {}).get("code") == 10000:
                data = data_v2
                data_format = "v2"

        if data is None:
            data_art, status_art = await _fetch_detail(
                "https://www.seaart.ai/api/v1/artwork/detail", {"id": artwork_id}
            )
            if data_art and data_art.get("status", {}).get("code") == 10000:
                data = data_art
                data_format = "artwork"
            elif data_art and data_art.get("status", {}).get("code") == 10621:
                return web.json_response(
                    {"error": "This post is private or restricted on SeaArt"},
                    status=403
                )
            else:
                # Last resort: try post/v2/detail with the artwork_id
                data_v2b, _ = await _fetch_detail(
                    "https://www.seaart.ai/api/v1/post/v2/detail", {"id": artwork_id}
                )
                if data_v2b and data_v2b.get("status", {}).get("code") == 10000:
                    data = data_v2b
                    data_format = "v2"
                else:
                    return web.json_response(
                        {"error": "SeaArt detail fetch failed (tried all endpoints)"},
                        status=502
                    )

        # ── Parse v2 format (image posts) ────────────────────────────────
        if data_format == "v2":
            items = (data.get("data") or {}).get("list", [])
            if not items:
                return web.json_response({"error": "No detail data returned"}, status=404)
            first   = items[0]
            meta    = first.get("meta") or {}
            banner  = first.get("banner") or {}
            return web.json_response({
                "prompt":         meta.get("prompt", "")          or "",
                "negativePrompt": meta.get("extra_prompt", "")    or "",
                "model":          first.get("model_name", "")     or "",
                "steps":          str(meta.get("steps", 0) or ""),
                "cfg":            str(meta.get("guidance_scale", 0) or ""),
                "seed":           str(meta.get("seed", 0) or ""),
                "sampler":        "",
                "imageUrl":       banner.get("url", "")           or "",
                "videoUrl":       "",
                "mediaType":      "image",
            })

        # ── Parse artwork format (video posts) ───────────────────────────
        art     = data.get("data") or {}
        meta    = art.get("meta") or {}
        banner  = art.get("banner") or {}
        # banner.url is the mp4 for video posts; banner.cover_url may be a thumbnail
        banner_url  = banner.get("url", "") or ""
        cover_url   = banner.get("cover_url", "") or ""
        is_video    = art.get("is_video_has_audio") or (media_type == "video")
        # Detect video by file extension or explicit flag
        if not is_video and banner_url.endswith(".mp4"):
            is_video = True
        video_url = banner_url if is_video else ""
        image_url = cover_url  if is_video else banner_url
        return web.json_response({
            "prompt":         meta.get("prompt", "")        or "",
            "negativePrompt": meta.get("extra_prompt", "")  or "",
            "model":          art.get("model_name", "")     or "",
            "steps":          str(meta.get("steps", 0) or ""),
            "cfg":            str(meta.get("guidance_scale", 0) or ""),
            "seed":           str(meta.get("seed", 0) or ""),
            "sampler":        "",
            "imageUrl":       image_url,
            "videoUrl":       video_url,
            "mediaType":      "video" if is_video else "image",
        })

    except Exception as e:
        logger.error(f"Error in epe_prompts_seaart_detail: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)




# ─────────────────────────────────────────────────────────────────────────────
# Workflow extraction — reads ComfyUI workflow from a PNG tEXt chunk
# ─────────────────────────────────────────────────────────────────────────────

def _parse_png_workflow(img_bytes):
    """
    Parse PNG tEXt/iTXt/zTXt chunks and return the workflow and prompt dicts.
    Returns (workflow_json_or_None, prompt_str_or_None).
    """
    if img_bytes[:8] != b'\x89PNG\r\n\x1a\n':
        return None, None
    chunks = {}
    pos = 8
    while pos < len(img_bytes) - 12:
        try:
            length = struct.unpack('>I', img_bytes[pos:pos+4])[0]
            ctype  = img_bytes[pos+4:pos+8].decode('ascii', errors='replace')
            cdata  = img_bytes[pos+8:pos+8+length]
            if ctype in ('tEXt', 'iTXt', 'zTXt') and b'\x00' in cdata:
                null_pos  = cdata.index(b'\x00')
                key       = cdata[:null_pos].decode('utf-8', errors='replace')
                val_raw   = cdata[null_pos+1:]
                if ctype == 'zTXt' and len(val_raw) > 1:
                    try: val = zlib.decompress(val_raw[1:]).decode('utf-8', errors='replace')
                    except Exception: val = ''
                elif ctype == 'iTXt':
                    try: val = val_raw.split(b'\x00')[-1].decode('utf-8', errors='replace')
                    except Exception: val = ''
                else:
                    val = val_raw.decode('utf-8', errors='replace')
                chunks[key] = val
            pos += 12 + length
        except Exception:
            break
    workflow_str = chunks.get('workflow') or chunks.get('Workflow') or ''
    prompt_str   = chunks.get('prompt')   or chunks.get('Prompt')   or ''
    workflow = None
    if workflow_str:
        try: workflow = json.loads(workflow_str)
        except Exception: pass
    return workflow, (prompt_str or None)


@routes.post("/epe/prompts/extract-workflow")
async def epe_prompts_extract_workflow(request):
    """
    Fetch a Civitai/Genur image at its original URL and extract the embedded
    ComfyUI workflow JSON from PNG metadata.
    POST body: { "imageUrl": "<url>" }
    Returns: { "workflow": {...}, "hasWorkflow": bool, "source": "civitai"|"genur" }
    """
    try:
        body      = await request.json()
        image_url = body.get("imageUrl", "").strip()
        if not image_url:
            return web.json_response({"error": "Missing imageUrl"}, status=400)
        _m_err = _epe_check_media_url(image_url)
        if _m_err:
            return web.json_response({"error": _m_err}, status=400)

        # Ensure we request the original (metadata-preserving) URL
        if "civitai.com" in image_url or "civitai.com" in image_url:
            # Strip any existing suffix and append original=true
            base = image_url.split("/width=")[0].split("/original=")[0].rstrip("/")
            fetch_url = base + "/original=true"
            source = "civitai"
        else:
            fetch_url = image_url
            source = "genur"

        headers = {"User-Agent": "Mozilla/5.0", "Accept": "image/*,*/*", "Range": "bytes=0-131071"}
        img_bytes = None
        for _attempt in range(2):
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        fetch_url, headers=headers,
                        timeout=aiohttp.ClientTimeout(total=10)
                    ) as resp:
                        if resp.status not in (200, 206):
                            return web.json_response({"error": f"Image fetch failed ({resp.status})"}, status=502)
                        img_bytes = await resp.read()
                break
            except asyncio.TimeoutError:
                if _attempt == 1:
                    return web.json_response({"error": "Image fetch timed out"}, status=504)
                await asyncio.sleep(1)

        if not img_bytes:
            return web.json_response({"error": "Image fetch failed"}, status=502)

        workflow, _ = _parse_png_workflow(img_bytes)
        has_workflow = workflow is not None

        logger.info(f"epe_prompts_extract_workflow {source} has_workflow={has_workflow} url={fetch_url[-60:]}")
        return web.json_response({
            "hasWorkflow": has_workflow,
            "workflow":    workflow,
            "source":      source,
        })

    except Exception as e:
        logger.error(f"Error in epe_prompts_extract_workflow: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


# ─────────────────────────────────────────────────────────────────────────────
# Workflow search — unified Civitai + SeaArt ComfyUI templates
# ─────────────────────────────────────────────────────────────────────────────

@routes.post("/epe/prompts/search-workflows")
async def epe_prompts_search_workflows(request):
    """
    Search Civitai (type=Workflows) and SeaArt ComfyUI templates simultaneously.
    POST body: { "query": str, "page": int, "source": "all"|"civitai"|"seaart" }
    Returns: { items: [{id, source, title, description, coverUrl, nodeCount, customNodes, hasWorkflow}], metadata }
    """
    try:
        body   = await request.json()
        query  = body.get("query", "").strip()
        page   = int(body.get("page", 1))
        source = body.get("source", "all")  # "all" | "civitai" | "seaart"

        IMAGE_CDN = "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA"
        items_out = []

        # ── Civitai workflows via Meilisearch (models_v9, type=Workflows) ──
        if source in ("all", "civitai"):
            MEILI_URL = "https://search-new.civitai.com/multi-search"
            MEILI_KEY = "8c46eb2508e21db1e9828a97968d91ab1ca1caa5f70a00e88a2ba1e286603b61"
            fetch_limit = 20
            offset = (page - 1) * fetch_limit
            meili_body = {
                "queries": [{
                    "q":            query or "",
                    "indexUid":     "models_v9",
                    "attributesToHighlight": [],
                    "highlightPreTag":  "__ais-highlight__",
                    "highlightPostTag": "__/ais-highlight__",
                    "limit":  fetch_limit,
                    "offset": offset,
                    "filter": ["type = Workflows", "nsfwLevel = 1"],
                    "sort":   ["rank:desc"] if not query else [],
                }]
            }
            civ_headers = {
                "Authorization": f"Bearer {MEILI_KEY}",
                "Content-Type":  "application/json",
                "Origin":        "https://civitai.com",
                "Referer":       "https://civitai.com/",
            }
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.post(
                        MEILI_URL, json=meili_body, headers=civ_headers,
                        timeout=aiohttp.ClientTimeout(total=20)
                    ) as resp:
                        if resp.status == 200:
                            meili_data = await resp.json(content_type=None)
                            results = meili_data.get("results", [])
                            hits = results[0].get("hits", []) if results else []
                            for hit in hits:
                                mv = ((hit.get("modelVersions") or [{}])[0])
                                imgs  = mv.get("images", []) or hit.get("images", []) or []
                                files = mv.get("files", [])
                                cover_url = ""
                                if imgs:
                                    raw_url = imgs[0].get("url", "")
                                    cover_url = raw_url if raw_url.startswith("http") else f"{IMAGE_CDN}/{raw_url}/width=450"
                                wf_file = next((f for f in files if f.get("type") in ("Model", "Archive")), None)
                                download_url = (wf_file or {}).get("downloadUrl", "")
                                items_out.append({
                                    "id":          str(hit.get("id", "")),
                                    "source":      "civitai",
                                    "title":       hit.get("name", ""),
                                    "description": re.sub(r'<[^>]+>', ' ', (hit.get("description") or "")).replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'").replace("&nbsp;", " ").replace("\n", " ").strip()[:1000],
                                    "coverUrl":    cover_url,
                                    "nodeCount":   0,
                                    "customNodes": [],
                                    "downloadUrl": download_url,
                                    "versionId":   str(mv.get("id", "")),
                                    "hasWorkflow": bool(download_url),
                                })
            except Exception as e:
                logger.warning(f"epe_prompts_search_workflows civitai error: {e}")

        # ── SeaArt ComfyUI templates ──────────────────────────────────────
        # SeaArt requires a query — without one it returns completely unfiltered content
        if source in ("all", "seaart") and query:
            sea_payload = {
                "page":      page,
                "page_size": 20,
                "order_by":  "hot",
            }
            if query:
                sea_payload["keyword"] = query
            sea_headers = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "Mozilla/5.0"}
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.post(
                        "https://www.seaart.ai/api/v1/square/v3/comfy_ui",
                        json=sea_payload, headers=sea_headers,
                        timeout=aiohttp.ClientTimeout(total=20)
                    ) as resp:
                        if resp.status == 200:
                            sea_data = await resp.json(content_type=None)
                            for item in (sea_data.get("data", {}).get("items") or []):
                                if int(item.get("nsfw_level", 0)) > 0 or int(item.get("c_nsfw_level", 0)) > 0:
                                    continue
                                cover = item.get("cover") or {}
                                cover_url = cover.get("url", "") if isinstance(cover, dict) else ""
                                stat = item.get("stat") or {}
                                items_out.append({
                                    "id":          item.get("id", ""),
                                    "source":      "seaart",
                                    "title":       item.get("title", "") or item.get("description", ""),
                                    "description": (item.get("description") or "")[:1000],
                                    "coverUrl":    cover_url,
                                    "nodeCount":   0,
                                    "customNodes": [],
                                    "downloadUrl": "",
                                    "versionId":   "",
                                    "hasWorkflow": True,
                                    "runCount":    stat.get("num_of_task", 0),
                                    "downloads":   stat.get("num_of_download", 0),
                                })
            except Exception as e:
                logger.warning(f"epe_prompts_search_workflows seaart error: {e}")

        has_more = len(items_out) >= 20
        logger.info(f"epe_prompts_search_workflows '{query}' page={page}: {len(items_out)} total items")
        return web.json_response({
            "items":    items_out,
            "metadata": {"hasMore": has_more, "page": page},
        })

    except Exception as e:
        logger.error(f"Error in epe_prompts_search_workflows: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


# ─────────────────────────────────────────────────────────────────────────────
# Workflow detail — download full ComfyUI JSON for a workflow item
# ─────────────────────────────────────────────────────────────────────────────

@routes.post("/epe/prompts/workflow-detail")
async def epe_prompts_workflow_detail(request):
    """
    Fetch the full ComfyUI workflow JSON for a workflow item.
    POST body: { "id": str, "source": "civitai"|"seaart", "downloadUrl": str, "versionId": str }
    Returns: { "workflow": {...}, "customNodes": [...], "nodeCount": int }
    """
    try:
        body         = await request.json()
        item_id      = body.get("id", "").strip()
        source       = body.get("source", "").strip()
        download_url = body.get("downloadUrl", "").strip()
        version_id   = body.get("versionId", "").strip()

        if not item_id or not source:
            return web.json_response({"error": "Missing id or source"}, status=400)

        headers = {"User-Agent": "Mozilla/5.0", "Accept": "*/*"}

        # ── SeaArt: use template detail API ──────────────────────────────
        if source == "seaart":
            sea_headers = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "Mozilla/5.0"}
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    "https://www.seaart.ai/api/v1/creativity/square/template/detail",
                    json={"template_id": item_id}, headers=sea_headers,
                    timeout=aiohttp.ClientTimeout(total=20)
                ) as resp:
                    if resp.status != 200:
                        return web.json_response({"error": f"SeaArt template fetch failed ({resp.status})"}, status=502)
                    data = await resp.json(content_type=None)
            if (data.get("status") or {}).get("code") != 10000:
                msg = (data.get("status") or {}).get("msg", "Unknown error")
                return web.json_response({"error": f"SeaArt API error: {msg}"}, status=502)
            template = data.get("data") or {}
            preview_data = template.get("preview_data") or ""
            node_group   = template.get("node_group") or []
            workflow = None
            if preview_data:
                try: workflow = json.loads(preview_data) if isinstance(preview_data, str) else preview_data
                except Exception: pass
            custom_nodes = []
            for group in node_group:
                pkg = group.get("package_name", "") or ""
                nodes = [n.get("value", "") for n in (group.get("nodes") or [])]
                if pkg:
                    custom_nodes.append({"package": pkg, "nodes": nodes})
            node_count = template.get("node_num") or (len(workflow.get("nodes", [])) if workflow else 0)
            # Extract full description from 'content' (HTML) or fall back to 'desc'
            sea_desc = ""
            raw_content = template.get("content") or template.get("desc") or ""
            if raw_content:
                sea_desc = re.sub(r'<[^>]+>', ' ', raw_content)
                for ent, ch in [("&amp;","&"),("&lt;","<"),("&gt;",">"),("&quot;",'"'),("&#39;","'"),("&nbsp;"," ")]:
                    sea_desc = sea_desc.replace(ent, ch)
                sea_desc = ' '.join(sea_desc.split())[:2000]
            logger.info(f"epe_prompts_workflow_detail seaart id={item_id} nodes={node_count}")
            return web.json_response({
                "workflow":     workflow,
                "customNodes":  custom_nodes,
                "nodeCount":    node_count,
                "description":  sea_desc,
            })

        # ── Civitai: download ZIP or JSON file ───────────────────────────
        if source == "civitai":
            raw_desc = ""  # will be populated from the models API if available

            def _strip_html(s):
                s = re.sub(r'<[^>]+>', ' ', s or "")
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
                async with aiohttp.ClientSession() as session:
                    async with session.get(civ_url, headers=headers, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                        if resp.status == 200:
                            mv_data = await resp.json(content_type=None)
                            # /models/{id} returns modelVersions[]; /model-versions/{id} returns files[] directly
                            if "modelVersions" in mv_data:
                                raw_desc = _strip_html(mv_data.get("description") or "")
                                mv_data = (mv_data.get("modelVersions") or [{}])[0]
                            files = mv_data.get("files") or []
                            wf_file = next((f for f in files if f.get("type") in ("Model","Archive")), None)
                            download_url = (wf_file or {}).get("downloadUrl", "")
                if not download_url:
                    return web.json_response({"error": "Could not resolve download URL"}, status=404)

            # Fetch description separately if we still don't have one (had downloadUrl from search)
            if not raw_desc and item_id:
                try:
                    async with aiohttp.ClientSession() as session:
                        async with session.get(
                            f"https://civitai.com/api/v1/models/{item_id}",
                            headers=headers, timeout=aiohttp.ClientTimeout(total=10)
                        ) as resp:
                            if resp.status == 200:
                                m = await resp.json(content_type=None)
                                raw_desc = _strip_html(m.get("description") or "")
                except Exception:
                    pass
            # Download the file
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    download_url, headers=headers,
                    timeout=aiohttp.ClientTimeout(total=60)
                ) as resp:
                    if resp.status != 200:
                        return web.json_response({"error": f"Download failed ({resp.status})"}, status=502)
                    file_bytes = await resp.read()
            # Extract workflow JSON — could be a ZIP or raw JSON
            workflow = None
            if file_bytes[:4] == b'PK\x03\x04':  # ZIP magic
                try:
                    with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
                        json_names = [n for n in zf.namelist() if n.endswith('.json')]
                        if json_names:
                            workflow = json.loads(zf.read(json_names[0]))
                except Exception as e:
                    logger.warning(f"epe_prompts_workflow_detail civitai ZIP error: {e}")
            else:
                try:
                    workflow = json.loads(file_bytes.decode('utf-8', errors='replace'))
                except Exception as e:
                    logger.warning(f"epe_prompts_workflow_detail civitai JSON parse error: {e}")
            # Check if the "file" is actually an error response (e.g. auth required)
            if isinstance(workflow, dict) and workflow.get("error"):
                msg = workflow.get("message") or workflow.get("error") or "Download failed"
                return web.json_response({"error": msg, "description": raw_desc}, status=403)
            if not workflow:
                return web.json_response({"error": "Could not parse workflow from downloaded file"}, status=422)
            nodes = workflow.get("nodes") or []
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

    except Exception as e:
        logger.error(f"Error in epe_prompts_workflow_detail: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)



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
    rules = _EPE_STYLE_POOL_RULES.get(style) if style and style != "default" else None
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
    rules = _EPE_STYLE_POOL_RULES.get(style) if style and style != "default" else None
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
    except (TypeError, ValueError):
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
    except (TypeError, ValueError):
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



@routes.post("/epe/ollama/check")
async def epe_ollama_check(request):
    """
    Check if Ollama is running and which known models are installed.
    Returns: { running, ollamaUrl, installedModels: [str], knownModels: [...] }
    """
    try:
        body = await request.json()
        ollama_url = body.get("ollamaUrl", "http://localhost:11434").rstrip("/")
        _u_err = _epe_check_ollama_url(ollama_url)
        if _u_err:
            return web.json_response({"error": _u_err}, status=400)

        installed = []
        running = False
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{ollama_url}/api/tags",
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as resp:
                    if resp.status == 200:
                        running = True
                        data = await resp.json()
                        installed = [
                            m.get("name") or m.get("model", "")
                            for m in data.get("models", [])
                        ]
                        installed = [n for n in installed if n]
        except Exception:
            pass

        return web.json_response({
            "running":         running,
            "ollamaUrl":       ollama_url,
            "installedModels": installed,
            "knownModels":     _OLLAMA_KNOWN_MODELS,
        })

    except Exception as e:
        logger.error(f"Error in epe_ollama_check: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/epe/ollama/pull")
async def epe_ollama_pull(request):
    """
    Pull an Ollama model. Streams progress back as newline-delimited JSON.
    POST body: { "modelName": "qwen3-vl:8b", "ollamaUrl": "http://localhost:11434" }
    """
    try:
        body = await request.json()
        model_name = body.get("modelName", "").strip()
        ollama_url = body.get("ollamaUrl", "http://localhost:11434").rstrip("/")
        _u_err = _epe_check_ollama_url(ollama_url)
        if _u_err:
            return web.json_response({"error": _u_err}, status=400)

        if not model_name:
            return web.json_response({"error": "Missing modelName"}, status=400)

        response = web.StreamResponse()
        response.headers["Content-Type"] = "application/x-ndjson"
        await response.prepare(request)

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{ollama_url}/api/pull",
                    json={"name": model_name, "stream": True},
                    timeout=aiohttp.ClientTimeout(total=3600),
                ) as resp:
                    async for line in resp.content:
                        line = line.strip()
                        if line:
                            await response.write(line + b"\n")
        except Exception as e:
            await response.write(
                json.dumps({"error": str(e)}).encode() + b"\n"
            )

        await response.write_eof()
        return response

    except Exception as e:
        logger.error(f"Error in epe_ollama_pull: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/epe/ollama/generate-image")
async def epe_ollama_generate_image(request):
    """
    Generate an image prompt from a URL using Ollama.
    POST body: { "imageUrl": str, "ollamaModel": str, "ollamaUrl": str }
    Returns: { "prompt": str }
    """
    try:
        body = await request.json()
        image_url  = body.get("imageUrl", "").strip()
        model_name = body.get("ollamaModel", "").strip()
        ollama_url = body.get("ollamaUrl", "http://localhost:11434").rstrip("/")
        _u_err = _epe_check_ollama_url(ollama_url)
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
            _m_err = _epe_check_media_url(image_url)
            if _m_err:
                return web.json_response({"error": _m_err}, status=400)
            # Download and base64-encode the image
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        image_url,
                        headers={"User-Agent": "Mozilla/5.0"},
                        timeout=aiohttp.ClientTimeout(total=60),
                    ) as resp:
                        if resp.status != 200:
                            return web.json_response(
                                {"error": f"Image download failed (HTTP {resp.status})"}, status=502
                            )
                        img_bytes = await resp.read()
                        img_b64 = base64.b64encode(img_bytes).decode()
            except Exception as e:
                return web.json_response({"error": f"Image download error: {e}"}, status=502)

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
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{ollama_url}/api/chat",
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=300),
                ) as resp:
                    if resp.status != 200:
                        return web.json_response(
                            {"error": f"Ollama returned HTTP {resp.status}"}, status=502
                        )
                    data   = await resp.json()
                    result = data.get("message", {}).get("content", "").strip()
        except Exception as e:
            return web.json_response({"error": f"Ollama request error: {e}"}, status=502)

        # Strip <think> blocks — if nothing remains, extract content from last think block
        stripped = re.sub(r"<think>.*?</think>", "", result, flags=re.DOTALL).strip()
        if not stripped:
            think_match = re.search(r"<think>(.*?)</think>", result, flags=re.DOTALL)
            stripped = think_match.group(1).strip() if think_match else ""
        result = stripped

        if not result:
            return web.json_response({"error": "Ollama returned empty response"}, status=502)

        logger.info(f"epe_ollama_generate_image: success ({len(result)} chars)")
        return web.json_response({"prompt": result})

    except Exception as e:
        logger.error(f"Error in epe_ollama_generate_image: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/epe/ollama/generate-video")
async def epe_ollama_generate_video(request):
    """
    Generate a video prompt from a video URL using Ollama (frames as images).
    POST body: { "videoUrl": str, "ollamaModel": str, "ollamaUrl": str, "numFrames": int }
    Returns: { "prompt": str }
    """
    try:
        body       = await request.json()
        video_url  = body.get("videoUrl", "").strip()
        if video_url and not video_url.startswith("data:"):
            _m_err = _epe_check_media_url(video_url)
            if _m_err:
                return web.json_response({"error": _m_err}, status=400)
        model_name = body.get("ollamaModel", "").strip()
        ollama_url = body.get("ollamaUrl", "http://localhost:11434").rstrip("/")
        _u_err = _epe_check_ollama_url(ollama_url)
        if _u_err:
            return web.json_response({"error": _u_err}, status=400)

        if not video_url:
            return web.json_response({"error": "Missing videoUrl"}, status=400)
        if not model_name:
            return web.json_response({"error": "Missing ollamaModel"}, status=400)

        # Download video
        input_dir    = folder_paths.get_input_directory()
        os.makedirs(input_dir, exist_ok=True)
        vid_filename = f"epe_v2p_{uuid.uuid4().hex[:12]}.mp4"
        vid_path     = os.path.join(input_dir, vid_filename)

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    video_url,
                    headers={"User-Agent": "Mozilla/5.0"},
                    timeout=aiohttp.ClientTimeout(total=120),
                ) as resp:
                    if resp.status != 200:
                        return web.json_response(
                            {"error": f"Video download failed (HTTP {resp.status})"}, status=502
                        )
                    with open(vid_path, "wb") as f:
                        async for chunk in resp.content.iter_chunked(65536):
                            f.write(chunk)
        except Exception as e:
            return web.json_response({"error": f"Video download error: {e}"}, status=502)

        # Extract frames — tiered frame count based on duration, evenly spread
        def _extract_frames(path):
            import av, io as _io

            def _calc_num_frames(duration_secs):
                """
                Tiered frame count based on duration, with minimums for short clips:
                  < 5s   : 2fps, minimum 10
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
            try:
                container    = av.open(path)
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

                n    = _calc_num_frames(duration_secs)
                step = max(1, total_frames // n)
                # Build evenly distributed target frame indices across full duration
                targets = set(int(i * total_frames / n) for i in range(n))

                idx = 0
                for frame in container.decode(video=0):
                    if idx in targets and len(frames_b64) < n:
                        img = frame.to_image()
                        w, h = img.size
                        if w > 512:
                            img = img.resize((512, int(h * 512 / w)))
                        buf = _io.BytesIO()
                        img.save(buf, format="JPEG", quality=85)
                        frames_b64.append(base64.b64encode(buf.getvalue()).decode())
                    idx += 1
                container.close()
            except Exception as e:
                logger.warning(f"epe_ollama_generate_video: frame extraction error: {e}")
            return frames_b64

        loop       = __import__("asyncio").get_event_loop()
        frames_b64 = await loop.run_in_executor(None, _extract_frames, vid_path)

        try: os.remove(vid_path)
        except Exception: pass

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
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{ollama_url}/api/chat",
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=300),
                ) as resp:
                    if resp.status != 200:
                        err_body = await resp.text()
                        logger.warning(f"epe_ollama_generate_video: Ollama HTTP {resp.status}: {err_body[:200]}")
                        return web.json_response(
                            {"error": f"Ollama returned HTTP {resp.status}"}, status=502
                        )
                    data   = await resp.json()
                    result = data.get("message", {}).get("content", "").strip()
                    logger.info(f"epe_ollama_generate_video: Ollama raw response length={len(result)}, done_reason={data.get('done_reason')}, done={data.get('done')}")
        except Exception as e:
            logger.error(f"epe_ollama_generate_video: Ollama request error: {e}")
            return web.json_response({"error": f"Ollama request error: {e}"}, status=502)

        # Strip <think> blocks — if nothing remains, extract content from last think block
        stripped = re.sub(r"<think>.*?</think>", "", result, flags=re.DOTALL).strip()
        if not stripped:
            # Model output was entirely inside think tags — extract the last block's content
            think_match = re.search(r"<think>(.*?)</think>", result, flags=re.DOTALL)
            stripped = think_match.group(1).strip() if think_match else ""
        result = stripped

        if not result:
            return web.json_response({"error": "Ollama returned empty response"}, status=502)

        logger.info(f"epe_ollama_generate_video: success ({len(result)} chars)")
        return web.json_response({"prompt": result})

    except Exception as e:
        logger.error(f"Error in epe_ollama_generate_video: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/epe/ollama/extract-frame")
async def epe_ollama_extract_frame(request):
    """
    Extract the first frame from a video URL and return it as a base64 JPEG.
    POST body: { "videoUrl": str }
    Returns: { "frameB64": str }  (base64 JPEG, no data URL prefix)
    """
    try:
        body      = await request.json()
        video_url = body.get("videoUrl", "").strip()
        if video_url and not video_url.startswith("data:"):
            _m_err = _epe_check_media_url(video_url)
            if _m_err:
                return web.json_response({"error": _m_err}, status=400)

        if not video_url:
            return web.json_response({"error": "Missing videoUrl"}, status=400)

        # Download video
        input_dir    = folder_paths.get_input_directory()
        os.makedirs(input_dir, exist_ok=True)
        vid_filename = f"epe_frame_{uuid.uuid4().hex[:12]}.mp4"
        vid_path     = os.path.join(input_dir, vid_filename)

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    video_url,
                    headers={"User-Agent": "Mozilla/5.0"},
                    timeout=aiohttp.ClientTimeout(total=120),
                ) as resp:
                    if resp.status != 200:
                        return web.json_response(
                            {"error": f"Video download failed (HTTP {resp.status})"}, status=502
                        )
                    with open(vid_path, "wb") as f:
                        async for chunk in resp.content.iter_chunked(65536):
                            f.write(chunk)
        except Exception as e:
            return web.json_response({"error": f"Video download error: {e}"}, status=502)

        def _get_first_frame(path):
            import av, io as _io
            try:
                container = av.open(path)
                for frame in container.decode(video=0):
                    img = frame.to_image()
                    w, h = img.size
                    if w > 512:
                        img = img.resize((512, int(h * 512 / w)))
                    buf = _io.BytesIO()
                    img.save(buf, format="JPEG", quality=85)
                    container.close()
                    return base64.b64encode(buf.getvalue()).decode()
                container.close()
            except Exception as e:
                logger.warning(f"epe_ollama_extract_frame: error: {e}")
            return None

        loop     = __import__("asyncio").get_event_loop()
        frame_b64 = await loop.run_in_executor(None, _get_first_frame, vid_path)

        try: os.remove(vid_path)
        except Exception: pass

        if not frame_b64:
            return web.json_response({"error": "Could not extract frame from video"}, status=422)

        return web.json_response({"frameB64": frame_b64})

    except Exception as e:
        logger.error(f"Error in epe_ollama_extract_frame: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/epe/ollama/generate-video-file")
async def epe_ollama_generate_video_file(request):
    """
    Generate a video prompt from a base64-encoded local video file.
    POST body: { "videoData": "data:video/...;base64,...", "ollamaModel": str, "ollamaUrl": str }
    Returns: { "prompt": str }
    """
    try:
        body       = await request.json()
        video_data = body.get("videoData", "").strip()
        if len(video_data) > _EPE_MAX_VIDEO_B64:
            return web.json_response({"error": "Video too large"}, status=413)
        model_name = body.get("ollamaModel", "").strip()
        ollama_url = body.get("ollamaUrl", "http://localhost:11434").rstrip("/")
        _u_err = _epe_check_ollama_url(ollama_url)
        if _u_err:
            return web.json_response({"error": _u_err}, status=400)

        if not video_data:
            return web.json_response({"error": "Missing videoData"}, status=400)
        if not model_name:
            return web.json_response({"error": "Missing ollamaModel"}, status=400)

        # Decode base64 data URL
        try:
            header, b64 = video_data.split(",", 1)
            vid_bytes = base64.b64decode(b64)
        except Exception as e:
            return web.json_response({"error": f"Invalid video data: {e}"}, status=400)

        # Write to temp file
        input_dir    = folder_paths.get_input_directory()
        os.makedirs(input_dir, exist_ok=True)
        vid_filename = f"epe_vf_{uuid.uuid4().hex[:12]}.mp4"
        vid_path     = os.path.join(input_dir, vid_filename)
        with open(vid_path, "wb") as f:
            f.write(vid_bytes)

        # Extract frames using same tiered logic as generate-video
        def _extract_frames_local(path):
            import av, io as _io

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
            try:
                container    = av.open(path)
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

                n       = _calc_num_frames(duration_secs)
                targets = set(int(i * total_frames / n) for i in range(n))

                idx = 0
                for frame in container.decode(video=0):
                    if idx in targets and len(frames_b64) < n:
                        img = frame.to_image()
                        w, h = img.size
                        if w > 512:
                            img = img.resize((512, int(h * 512 / w)))
                        buf = _io.BytesIO()
                        img.save(buf, format="JPEG", quality=85)
                        frames_b64.append(base64.b64encode(buf.getvalue()).decode())
                    idx += 1
                container.close()
            except Exception as e:
                logger.warning(f"epe_ollama_generate_video_file: frame extraction error: {e}")
            return frames_b64

        loop       = __import__("asyncio").get_event_loop()
        frames_b64 = await loop.run_in_executor(None, _extract_frames_local, vid_path)

        try: os.remove(vid_path)
        except Exception: pass

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
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{ollama_url}/api/chat",
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=300),
                ) as resp:
                    if resp.status != 200:
                        return web.json_response({"error": f"Ollama returned HTTP {resp.status}"}, status=502)
                    data   = await resp.json()
                    result = data.get("message", {}).get("content", "").strip()
        except Exception as e:
            return web.json_response({"error": f"Ollama request error: {e}"}, status=502)

        stripped = re.sub(r"<think>.*?</think>", "", result, flags=re.DOTALL).strip()
        if not stripped:
            think_match = re.search(r"<think>(.*?)</think>", result, flags=re.DOTALL)
            stripped = think_match.group(1).strip() if think_match else ""
        result = stripped

        if not result:
            return web.json_response({"error": "Ollama returned empty response"}, status=502)

        logger.info(f"epe_ollama_generate_video_file: success ({len(result)} chars)")
        return web.json_response({"prompt": result})

    except Exception as e:
        logger.error(f"Error in epe_ollama_generate_video_file: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


logger.info("EPE API routes registered")

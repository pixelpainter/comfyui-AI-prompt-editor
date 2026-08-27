#!/usr/bin/env python3
"""
build_help.py — Generate HELP.md from the in-app help in epe_node.js.

The in-app Help panel is the single source of truth. Its topics live in the
_EPE_HELP_TOPICS array in epe_node.js as small HTML strings. This script reads
that array, converts the HTML to Markdown, and writes HELP.md so the docs stay
in sync with the app.

Usage:
    python build_help.py            # writes HELP.md next to this script
    python build_help.py --check    # exit 1 if HELP.md is out of date

Edit help text in epe_node.js, then re-run this to regenerate HELP.md.
"""

import re
import sys
import html
from pathlib import Path

HERE = Path(__file__).parent
# epe_node.js moved into js/ — keep the old flat location working so the script
# can still be run from inside an older snapshot in backup/.
JS_PATH = HERE / "js" / "epe_node.js"
if not JS_PATH.exists():
    JS_PATH = HERE / "epe_node.js"
MD_PATH = HERE / "HELP.md"


def extract_topics(js_text):
    """Pull [{label, html}] out of the _EPE_HELP_TOPICS array.

    Returns [] when the array is not there. JS_PATH falls back to the old flat
    layout so this can be run from inside a backup/ snapshot, and a snapshot
    from before the help panel existed — or a truncated file — used to die on
    str.index with `ValueError: substring not found` and a traceback. main()
    already prints a usable message for an empty result.
    """
    start = js_text.find("_EPE_HELP_TOPICS = [")
    if start < 0:
        return []
    # Walk brackets to find the matching close of the array.
    i = js_text.index("[", start)
    depth = 0
    end = i
    for j in range(i, len(js_text)):
        c = js_text[j]
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                end = j
                break
    array_src = js_text[i : end + 1]

    topics = []
    # Each topic: label: "..."  then html: <concatenated strings>
    # Trailing comma is now OPTIONAL — Prettier with `trailingComma: "none"`,
    # or a hand-edit dropping the comma on the last topic, previously caused
    # the regex to skip the last topic silently. build_md then produced a
    # HELP.md missing one section and --check reported it as up to date on
    # the very next run.
    # EITHER quote style for the label. A single-quoted one used to be
    # skipped outright — and the count guard below could not see it, because
    # the guard's pattern was a sub-pattern of this one. A hand-edit or
    # Prettier with `singleQuote: true` deleted a whole help section from the
    # shipped HELP.md, silently, and `--check` then called the file current.
    for m in re.finditer(
            r"label:\s*(?:\"([^\"]+)\"|'([^']+)')\s*,\s*html:\s*(.*?)\n\s*\}(?:,|\s*\])",
            array_src, re.DOTALL):
        label = m.group(1) if m.group(1) is not None else m.group(2)
        html_block = m.group(3)
        # Join the quoted string fragments ( '...' + '...' ) into one string.
        parts = re.findall(r"'((?:[^'\\]|\\.)*)'", html_block)
        raw = "".join(parts)
        # Unescape JS string escapes we care about.
        raw = raw.replace("\\'", "'").replace('\\"', '"')
        topics.append((label, raw))
    return topics


def _empty_body_labels(topics):
    """Topics that parsed but carry no text.

    The fragment scan above only reads SINGLE-quoted runs, so an `html:`
    written as a template literal or a double-quoted string yields "" — and
    the topic is emitted as a bare `## Heading` with nothing under it. Both
    the old count guard and `--check` were blind to that: the topic count is
    right, the file is byte-stable, and the section is empty. Measured on a
    mutated copy of the shipped epe_node.js.
    """
    return [lbl for lbl, raw in topics if not raw.strip()]


def _count_expected_topics(js_text):
    """How many topic objects the array literal contains — counted STRUCTURALLY.

    This must not share a pattern with `extract_topics`, and the previous
    version did: it counted `label:\\s*"[^"]+"`, which is a strict prefix
    sub-pattern of the parse regex. Any input that broke the label half broke
    both identically, `parsed == counted` held, and the guard stayed silent on
    the exact failure it was added to catch.

    So: no `label:` here at all. Walk the array literal counting `{` that open
    at depth 1 — one per topic object — while skipping over string and
    template literals (and their escapes) and both comment forms, so a brace
    or a quote inside help text cannot move the count.
    """
    start = js_text.find("_EPE_HELP_TOPICS = [")
    if start < 0:
        return 0
    i = js_text.index("[", start)
    depth = 0          # bracket/brace nesting relative to the array
    topics = 0
    j = i
    n = len(js_text)
    while j < n:
        c = js_text[j]
        # ── skip a string / template literal whole ──────────────────────
        if c in "\"'`":
            quote = c
            j += 1
            while j < n:
                if js_text[j] == "\\":
                    j += 2
                    continue
                if js_text[j] == quote:
                    break
                j += 1
            j += 1
            continue
        # ── skip comments ───────────────────────────────────────────────
        if c == "/" and j + 1 < n and js_text[j + 1] == "/":
            k = js_text.find("\n", j)
            j = n if k < 0 else k + 1
            continue
        if c == "/" and j + 1 < n and js_text[j + 1] == "*":
            k = js_text.find("*/", j + 2)
            j = n if k < 0 else k + 2
            continue
        # ── structure ───────────────────────────────────────────────────
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                break
        elif c == "{":
            if depth == 1:
                topics += 1
            depth += 1
        elif c == "}":
            depth -= 1
        j += 1
    return topics


def html_to_md(s):
    """Convert the small subset of HTML used in help strings to Markdown."""
    # Drop the styled Tip container's wrapper but keep its text as a blockquote.
    # First, mark tip divs (they have background styling) for blockquote treatment.
    def tip_repl(m):
        inner = m.group(1)
        inner = strip_inline(inner)
        return "\n\n> " + inner.strip() + "\n"
    s = re.sub(r'<div style="margin-top:10px;[^"]*">(.*?)</div>', tip_repl, s, flags=re.DOTALL)

    # Lists
    def ul_repl(m):
        items = re.findall(r"<li>(.*?)</li>", m.group(1), re.DOTALL)
        return "\n" + "\n".join("- " + strip_inline(it).strip() for it in items) + "\n"
    s = re.sub(r"<ul[^>]*>(.*?)</ul>", ul_repl, s, flags=re.DOTALL)

    # Remaining wrapper divs -> a line break. They are block elements, so two
    # stacked divs are two paragraphs; dropping them outright ran the last
    # sentence of one straight into the first word of the next.
    s = re.sub(r"</?div[^>]*>", "\n", s)

    # Line breaks
    s = s.replace("<br><br>", "\n\n").replace("<br>", "  \n")

    s = strip_inline(s)

    # Collapse 3+ newlines
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def strip_inline(s):
    """Bold, emphasis, and entity cleanup."""
    s = re.sub(r"<b[^>]*>(.*?)</b>", r"**\1**", s, flags=re.DOTALL)
    s = re.sub(r"<em[^>]*>(.*?)</em>", r"*\1*", s, flags=re.DOTALL)
    s = re.sub(r"<span[^>]*>(.*?)</span>", r"\1", s, flags=re.DOTALL)
    s = re.sub(r"<[^>]+>", "", s)          # any stray tags
    s = html.unescape(s)
    return s


def build_md(topics):
    out = ["# EPE — In-App Help",
           ""]
    # Table of contents
    out.append("## Contents")
    out.append("")
    for label, _ in topics:
        anchor = label.lower().replace(" ", "-")
        out.append(f"- [{label}](#{anchor})")
    out.append("")
    # Sections
    for label, raw in topics:
        out.append(f"## {label}")
        out.append("")
        out.append(html_to_md(raw))
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def main():
    try:
        js = JS_PATH.read_text(encoding="utf-8")
    except OSError as e:
        print(f"ERROR: cannot read {JS_PATH}: {e}", file=sys.stderr)
        return 1
    topics = extract_topics(js)
    if not topics:
        print(f"ERROR: no help topics found in {JS_PATH} — is this an EPE "
              f"epe_node.js?", file=sys.stderr)
        return 1
    _expected = _count_expected_topics(js)
    if _expected and _expected != len(topics):
        print(f"ERROR: parsed {len(topics)} topics but the array literal "
              f"contains {_expected} objects. The regex is skipping entries — "
              f"please check trailing commas / label quoting in "
              f"_EPE_HELP_TOPICS.", file=sys.stderr)
        return 1
    # A topic that parsed but has no text is a silent hole in the shipped
    # help: the heading is emitted, the body is empty, the topic count is
    # right and --check calls the file current forever.
    _empty = _empty_body_labels(topics)
    if _empty:
        print("ERROR: these topics parsed with an EMPTY body: "
              + ", ".join(_empty)
              + ". `html:` must be single-quoted fragments — a template "
                "literal or a double-quoted string reads as no text at all.",
              file=sys.stderr)
        return 1
    md = build_md(topics)

    # Newlines are pinned to LF on BOTH sides, and --check compares the bytes
    # on disk rather than a universal-newlines translation of them.
    #
    # Path.write_text() defaults to newline=None, which translates "\n" to
    # os.linesep — so this script produced CRLF on Windows and LF on Linux, and
    # rewrote the whole file whichever platform it ran on second.
    # Path.read_text() defaults to newline=None too, which translates the other
    # way, so --check normalised the difference away and could never see it.
    # The result was a file that flips wholesale between contributors while the
    # check reports everything is fine.
    if "--check" in sys.argv:
        current = ""
        if MD_PATH.exists():
            with MD_PATH.open("r", encoding="utf-8", newline="") as f:
                current = f.read()
        if current != md:
            print("HELP.md is OUT OF DATE — run: python build_help.py")
            return 1
        print("HELP.md is up to date.")
        return 0

    with MD_PATH.open("w", encoding="utf-8", newline="\n") as f:
        f.write(md)
    print(f"Wrote {MD_PATH} ({len(topics)} topics).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

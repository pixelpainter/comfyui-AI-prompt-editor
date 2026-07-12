#!/usr/bin/env python3
"""
build_help.py — Generate HELP.md from the in-app help in epe_node.js.

The in-app Help panel is the single source of truth. Its topics live in the
_EPE_HELP_TOPICS array in epe_node.js as small HTML strings. This script reads
that array, converts the HTML to Markdown, and writes HELP.md so the docs stay
in sync with the app.

Usage:
    python build_help.py            # writes HELP.md next to epe_node.js
    python build_help.py --check    # exit 1 if HELP.md is out of date

Edit help text in epe_node.js, then re-run this to regenerate HELP.md.
"""

import re
import sys
import html
from pathlib import Path

HERE = Path(__file__).parent
JS_PATH = HERE / "epe_node.js"
MD_PATH = HERE / "HELP.md"


def extract_topics(js_text):
    """Pull [{label, html}] out of the _EPE_HELP_TOPICS array."""
    start = js_text.index("_EPE_HELP_TOPICS = [")
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
    for m in re.finditer(r"label:\s*\"([^\"]+)\"\s*,\s*html:\s*(.*?)\n\s*\},",
                          array_src, re.DOTALL):
        label = m.group(1)
        html_block = m.group(2)
        # Join the quoted string fragments ( '...' + '...' ) into one string.
        parts = re.findall(r"'((?:[^'\\]|\\.)*)'", html_block)
        raw = "".join(parts)
        # Unescape JS string escapes we care about.
        raw = raw.replace("\\'", "'").replace('\\"', '"')
        topics.append((label, raw))
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

    # Remaining wrapper divs -> nothing
    s = re.sub(r"</?div[^>]*>", "", s)

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
    js = JS_PATH.read_text(encoding="utf-8")
    topics = extract_topics(js)
    if not topics:
        print("ERROR: no help topics found", file=sys.stderr)
        return 1
    md = build_md(topics)

    if "--check" in sys.argv:
        current = MD_PATH.read_text(encoding="utf-8") if MD_PATH.exists() else ""
        if current != md:
            print("HELP.md is OUT OF DATE — run: python build_help.py")
            return 1
        print("HELP.md is up to date.")
        return 0

    MD_PATH.write_text(md, encoding="utf-8")
    print(f"Wrote {MD_PATH} ({len(topics)} topics).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

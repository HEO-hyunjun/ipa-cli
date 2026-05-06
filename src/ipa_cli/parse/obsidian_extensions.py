"""Obsidian-flavored markdown extraction over parsed tokens.

Wikilinks, embeds, and callouts aren't in CommonMark, so we don't extend
the parser — we post-process. ``parse/links.py`` already handles raw
regex extraction over body strings; this module operates on the token
stream so callers can ignore links inside fenced code blocks.

Callouts (``> [!note] ...``) are recognized by inspecting the first
inline child of a blockquote.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from markdown_it.token import Token

WIKILINK_RE = re.compile(r"(?<!!)\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]")
EMBED_RE = re.compile(r"!\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]")
CALLOUT_RE = re.compile(r"^\[!(?P<kind>[\w-]+)\][+-]?\s*(?P<title>.*)$", re.IGNORECASE)


def extract_wikilinks_from_tokens(tokens: list["Token"]) -> list[str]:
    """Wikilink targets ([[Target]]) outside fenced code, in order."""
    out: list[str] = []
    for tok in tokens:
        if tok.type != "inline" or not tok.content:
            continue
        for m in WIKILINK_RE.finditer(tok.content):
            out.append(m.group(1).strip())
    return out


def extract_embeds_from_tokens(tokens: list["Token"]) -> list[str]:
    """Embed targets (![[Target]]) outside fenced code, in order."""
    out: list[str] = []
    for tok in tokens:
        if tok.type != "inline" or not tok.content:
            continue
        for m in EMBED_RE.finditer(tok.content):
            out.append(m.group(1).strip())
    return out


@dataclass(frozen=True)
class Callout:
    kind: str
    title: str
    line: int


def extract_callouts(tokens: list["Token"]) -> list[Callout]:
    """Return Obsidian callouts opened by ``> [!kind] title``."""
    out: list[Callout] = []
    in_quote = False
    quote_line = -1
    for tok in tokens:
        if tok.type == "blockquote_open":
            in_quote = True
            quote_line = tok.map[0] if tok.map else -1
            continue
        if tok.type == "blockquote_close":
            in_quote = False
            continue
        if in_quote and tok.type == "inline" and tok.content:
            first_line = tok.content.splitlines()[0] if tok.content else ""
            m = CALLOUT_RE.match(first_line)
            if m:
                out.append(
                    Callout(
                        kind=m.group("kind").lower(),
                        title=m.group("title").strip(),
                        line=quote_line,
                    )
                )
            in_quote = False  # only inspect the first inline child
    return out

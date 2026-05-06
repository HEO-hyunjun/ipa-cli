"""Wikilink and ref-target extraction helpers.

Lightweight regex parsing kept here so rules don't reach into the parse
internals or duplicate patterns. P5 will replace this with markdown-it-py
AST traversal; the function signatures stay stable across that swap.

Mirrors 1차 ``vault_parser`` regexes:

- ``WIKILINK_RE`` matches ``[[name]]`` or ``[[name|alias]]`` but not
  ``![[...]]`` embeds (negative lookbehind).
- ``EMBED_RE`` matches ``![[...]]`` (kept for completeness; rules ignore
  embeds when checking link targets).
"""

from __future__ import annotations

import re

WIKILINK_RE = re.compile(r"(?<!!)\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]")
EMBED_RE = re.compile(r"!\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]")
_REF_INNER_RE = re.compile(r"\[\[([^\]|]+)")


def extract_wikilinks(body: str) -> list[str]:
    """Extract unique wikilink targets from a note body, embeds excluded."""
    return list(dict.fromkeys(WIKILINK_RE.findall(body)))


def extract_embeds(body: str) -> list[str]:
    """Extract unique embed targets (``![[...]]``) from a note body."""
    return list(dict.fromkeys(EMBED_RE.findall(body)))


def extract_ref_targets(refs_values: list[str]) -> list[str]:
    """Extract note names from frontmatter ref entries.

    Frontmatter usually stores refs as ``"[[name]]"`` strings. Bare names
    (no brackets) are accepted as-is.
    """
    out: list[str] = []
    for raw in refs_values:
        if not raw:
            continue
        text = str(raw).strip()
        match = _REF_INNER_RE.search(text)
        if match:
            out.append(match.group(1).strip())
        elif text:
            out.append(text)
    return list(dict.fromkeys(out))

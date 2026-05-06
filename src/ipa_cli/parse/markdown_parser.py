"""markdown-it-py wrapper for parse level 3.

Levels:
  1. raw body string (cheap)
  2. frontmatter dict + body string (default — vault_loader)
  3. AST tokens via markdown-it-py (this module — lazy)

The wrapper is intentionally thin: it returns the raw token list and a
small set of structural extractors (headings, code fences, inline plain
text). Obsidian-specific extraction (wikilinks, embeds, callouts) lives
in ``obsidian_extensions.py`` because it post-processes raw text rather
than markdown structure.

Why a singleton parser:
  ``MarkdownIt('commonmark')`` is cheap to construct but caching the
  instance avoids re-running configuration in tight per-note loops.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import TYPE_CHECKING

from markdown_it import MarkdownIt

if TYPE_CHECKING:
    from markdown_it.token import Token


@lru_cache(maxsize=1)
def _parser() -> MarkdownIt:
    return MarkdownIt("commonmark")


def parse_markdown(body: str) -> list["Token"]:
    """Return markdown-it tokens for ``body``."""
    return _parser().parse(body)


@dataclass(frozen=True)
class Heading:
    level: int
    text: str
    line: int


def extract_headings(tokens: list["Token"]) -> list[Heading]:
    """Return ``(level, text, line)`` tuples for every heading."""
    out: list[Heading] = []
    for i, tok in enumerate(tokens):
        if tok.type != "heading_open":
            continue
        level = int(tok.tag[1])
        next_tok = tokens[i + 1] if i + 1 < len(tokens) else None
        text = (
            next_tok.content if next_tok and next_tok.type == "inline" else ""
        ).strip()
        line = tok.map[0] if tok.map else -1
        out.append(Heading(level=level, text=text, line=line))
    return out


@dataclass(frozen=True)
class CodeFence:
    info: str
    content: str
    line: int


def extract_code_fences(tokens: list["Token"]) -> list[CodeFence]:
    """Return fenced code blocks (``info`` is the language tag)."""
    out: list[CodeFence] = []
    for tok in tokens:
        if tok.type != "fence":
            continue
        line = tok.map[0] if tok.map else -1
        out.append(CodeFence(info=tok.info or "", content=tok.content, line=line))
    return out


def extract_inline_text(tokens: list["Token"]) -> str:
    """Concatenate all inline text — used for tokenization channels.

    Skips fenced/code-block content because those rarely contribute to
    semantic search and inflate the BM25 vocabulary.
    """
    parts: list[str] = []
    for tok in tokens:
        if tok.type == "inline" and tok.content:
            parts.append(tok.content)
    return "\n".join(parts)

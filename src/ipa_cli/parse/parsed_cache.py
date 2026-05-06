"""Persistent cache for parse level 3 (markdown-it AST tokens).

Build motivation: parse level 3 is lazy per-Note, but the same notes are
parsed across CLI invocations. Caching the token list keyed by body
SHA-1 lets a fresh process skip the parser entirely for unchanged notes.

Layout: a single pickle file ``parsed_index.pkl`` under ``cache_dir``
holding a ``{note_id: (body_sha1, tokens)}`` dict. Bumping
``CACHE_VERSION`` invalidates older files.

Why per-cache_dir (and thus per-profile): different profiles can mount
different vault paths and even different mappings; sharing parsed AST
across them risks crossing those boundaries.
"""

from __future__ import annotations

import hashlib
import pickle
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from markdown_it.token import Token

    from ipa_cli.parse.note_model import Note

CACHE_VERSION = 1
CACHE_FILENAME = "parsed_index.pkl"


def _body_sha1(body: str) -> str:
    return hashlib.sha1(body.encode("utf-8")).hexdigest()


def _cache_path(cache_dir: Path) -> Path:
    return cache_dir / CACHE_FILENAME


def load_parsed_cache(cache_dir: Path) -> dict[str, tuple[str, list["Token"]]]:
    """Return cached ``note_id → (body_sha1, tokens)``. Empty on miss."""
    p = _cache_path(cache_dir)
    if not p.is_file():
        return {}
    try:
        with p.open("rb") as f:
            payload = pickle.load(f)
    except (OSError, pickle.UnpicklingError, EOFError):
        return {}
    if not isinstance(payload, dict):
        return {}
    if payload.get("version") != CACHE_VERSION:
        return {}
    entries = payload.get("entries")
    if not isinstance(entries, dict):
        return {}
    return entries


def save_parsed_cache(
    cache_dir: Path, entries: dict[str, tuple[str, list["Token"]]]
) -> None:
    """Atomically write ``entries`` under ``cache_dir/parsed_index.pkl``."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    final = _cache_path(cache_dir)
    tmp = final.with_suffix(".pkl.tmp")
    payload = {"version": CACHE_VERSION, "entries": entries}
    with tmp.open("wb") as f:
        pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)
    tmp.replace(final)


def prime_notes_with_cache(notes: list["Note"], cache_dir: Path) -> int:
    """Populate ``Note._body_ast`` from disk cache, return hit count.

    Notes whose body hash matches the cache entry skip parsing. The
    caller can later hand the (possibly extended) cache back via
    ``persist_after_parse``.
    """
    entries = load_parsed_cache(cache_dir)
    if not entries:
        return 0
    hits = 0
    for n in notes:
        cached = entries.get(n.id)
        if cached is None:
            continue
        body_hash, tokens = cached
        if body_hash != _body_sha1(n.body):
            continue
        n._body_ast = tokens
        hits += 1
    return hits


def persist_after_parse(notes: list["Note"], cache_dir: Path) -> int:
    """Write current ``Note._body_ast`` (built or cached) back to disk.

    Notes whose AST was never accessed (``_body_ast is None``) are
    skipped — caching un-parsed notes would defeat the lazy property.
    Returns the number of entries persisted.
    """
    entries: dict[str, tuple[str, list]] = {}
    for n in notes:
        if n._body_ast is None:
            continue
        entries[n.id] = (_body_sha1(n.body), n._body_ast)
    if not entries:
        return 0
    save_parsed_cache(cache_dir, entries)
    return len(entries)

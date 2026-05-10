"""P5 parsed result cache (markdown-it tokens on disk)."""

from __future__ import annotations

from pathlib import Path

from ipa_cli.parse.note_model import Note
from ipa_cli.parse.parsed_cache import (
    load_parsed_cache,
    persist_after_parse,
    prime_notes_with_cache,
)


def _note(nid: str, body: str) -> Note:
    return Note(id=nid, path=Path(f"/tmp/{nid}.md"), body=body, frontmatter={})


def test_persist_then_load_roundtrip(tmp_path: Path) -> None:
    n = _note("alpha", "# Title\n\nbody")
    _ = n.body_ast  # force parse
    written = persist_after_parse([n], tmp_path)
    assert written == 1

    cached = load_parsed_cache(tmp_path)
    assert "alpha" in cached
    body_hash, tokens = cached["alpha"]
    assert any(t.type == "heading_open" for t in tokens)
    assert body_hash  # non-empty SHA1


def test_prime_skips_when_body_changed(tmp_path: Path) -> None:
    """Cache entry's body_sha1 must match current body or it's bypassed."""
    original = _note("alpha", "old body")
    _ = original.body_ast
    persist_after_parse([original], tmp_path)

    # Same id, different body content — cache must be ignored.
    fresh = _note("alpha", "new body keyword")
    hits = prime_notes_with_cache([fresh], tmp_path)
    assert hits == 0
    assert fresh._body_ast is None  # not primed
    # parsing still works on demand
    _ = fresh.body_ast
    assert fresh._body_ast is not None


def test_prime_uses_cache_when_body_matches(tmp_path: Path) -> None:
    n1 = _note("alpha", "stable body content")
    _ = n1.body_ast
    persist_after_parse([n1], tmp_path)

    n2 = _note("alpha", "stable body content")
    hits = prime_notes_with_cache([n2], tmp_path)
    assert hits == 1
    assert n2._body_ast is not None  # primed without parsing


def test_persist_skips_un_parsed_notes(tmp_path: Path) -> None:
    n = _note("alpha", "body")
    # body_ast never accessed — should be skipped
    written = persist_after_parse([n], tmp_path)
    assert written == 0
    assert load_parsed_cache(tmp_path) == {}


def test_load_handles_missing_or_corrupt_file(tmp_path: Path) -> None:
    # Missing file → empty cache, no exception.
    assert load_parsed_cache(tmp_path) == {}

    # Corrupt file → empty cache, no exception.
    cache_file = tmp_path / "parsed_index.pkl"
    cache_file.write_bytes(b"not a pickle")
    assert load_parsed_cache(tmp_path) == {}

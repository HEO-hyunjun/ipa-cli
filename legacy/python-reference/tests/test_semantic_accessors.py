"""Note semantic accessor tests.

Goal: same Note data + two different Mapping configurations should
return the same semantic values. This is the heart of P2 — vault key
naming differences are absorbed by Mapping, leaving rules unaware.
"""

from __future__ import annotations

from pathlib import Path

from ipa_cli.api import Mapping
from ipa_cli.parse.note_model import Note


def test_default_mapping_reads_standard_keys() -> None:
    note = Note(
        id="x",
        path=Path("/tmp/x.md"),
        body="",
        frontmatter={
            "type": "note",
            "ref": ["[[A]]", "[[B]]"],
            "tags": ["alpha", "beta"],
            "date_created": "2026-05-06",
            "date_modified": "2026-05-07",
            "aliases": ["x-alias"],
        },
    )
    m = Mapping()
    assert note.note_type(m) == "note"
    assert note.refs(m) == ["[[A]]", "[[B]]"]
    assert note.tags(m) == ["alpha", "beta"]
    assert note.created_at(m) == "2026-05-06"
    assert note.updated_at(m) == "2026-05-07"
    assert note.aliases(m) == ["x-alias"]


def test_test_vault_mapping_reads_alternative_keys() -> None:
    note = Note(
        id="x",
        path=Path("/tmp/x.md"),
        body="",
        frontmatter={
            "kind": "note",
            "parents": ["[[A]]"],
            "tags": ["alpha"],
            "created": "2026-05-06",
            "updated": "2026-05-07",
            "aliases": "alpha-alias",  # str (will be normalized)
        },
    )
    m = Mapping(
        note_type="kind",
        refs="parents",
        created_at="created",
        updated_at="updated",
    )
    assert note.note_type(m) == "note"
    assert note.refs(m) == ["[[A]]"]
    assert note.tags(m) == ["alpha"]
    assert note.created_at(m) == "2026-05-06"
    assert note.updated_at(m) == "2026-05-07"
    assert note.aliases(m) == ["alpha-alias"]


def test_same_data_same_semantic_under_two_mappings() -> None:
    """P2 acceptance: a rule reading via Mapping returns identical
    semantic values regardless of which vault's keys are used."""
    a = Note(
        id="a",
        path=Path("/tmp/a.md"),
        body="",
        frontmatter={"type": "index", "ref": "[[Root]]"},
    )
    b = Note(
        id="b",
        path=Path("/tmp/b.md"),
        body="",
        frontmatter={"kind": "index", "parents": "[[Root]]"},
    )
    default_m = Mapping()
    test_vault_m = Mapping(note_type="kind", refs="parents")

    assert a.note_type(default_m) == b.note_type(test_vault_m) == "index"
    assert a.refs(default_m) == b.refs(test_vault_m) == ["[[Root]]"]


def test_missing_field_returns_none_or_empty_list() -> None:
    note = Note(id="x", path=Path("/tmp/x.md"), body="", frontmatter={})
    m = Mapping()
    assert note.note_type(m) is None
    assert note.refs(m) == []
    assert note.tags(m) == []
    assert note.created_at(m) is None
    assert note.aliases(m) == []


def test_aliases_skipped_when_mapping_disables_it() -> None:
    note = Note(
        id="x",
        path=Path("/tmp/x.md"),
        body="",
        frontmatter={"aliases": ["one", "two"]},
    )
    m = Mapping(aliases=None)
    assert note.aliases(m) == []


def test_str_value_normalizes_to_single_item_list() -> None:
    note = Note(
        id="x",
        path=Path("/tmp/x.md"),
        body="",
        frontmatter={"ref": "[[A]]", "tags": "single"},
    )
    m = Mapping()
    assert note.refs(m) == ["[[A]]"]
    assert note.tags(m) == ["single"]

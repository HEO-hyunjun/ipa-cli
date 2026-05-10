"""Vault loader tests.

Synthetic tests use ``tmp_path`` for determinism. The integration test
points at ``ipa-test-vault`` and is skipped when the fixture is missing
so this suite still runs on machines without the test vault checkout.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ipa_cli.api import Mapping
from ipa_cli.parse.vault_loader import load_notes, parse_frontmatter

IPA_TEST_VAULT = Path("/Users/heohyeonjun/sync/projects/ipa-test-vault")


# --- parse_frontmatter ----------------------------------------------------


def test_parse_frontmatter_extracts_block() -> None:
    text = "---\ntype: note\ntags: [a, b]\n---\nbody line"
    fm, body = parse_frontmatter(text)
    assert fm == {"type": "note", "tags": ["a", "b"]}
    assert body == "body line"


def test_parse_frontmatter_no_block_returns_empty() -> None:
    text = "no frontmatter here\n---\nfake closer"
    fm, body = parse_frontmatter(text)
    assert fm == {}
    assert body == text


def test_parse_frontmatter_broken_yaml_recovers() -> None:
    text = "---\ntype: : : invalid\n---\nbody"
    fm, body = parse_frontmatter(text)
    assert fm == {}
    assert body == "body"


# --- load_notes synthetic -------------------------------------------------


def _write_note(path: Path, fm: str, body: str = "x") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\n{fm}---\n{body}", encoding="utf-8")


def test_load_notes_scans_only_mapped_folders(tmp_path: Path) -> None:
    _write_note(tmp_path / "00 Inbox" / "a.md", "type: note\n")
    _write_note(tmp_path / "01 Project" / "b.md", "type: note\n")
    _write_note(tmp_path / "02 Archive" / "c.md", "type: note\n")
    # Should NOT be scanned:
    _write_note(tmp_path / "90 Settings" / "skill.md", "type: note\n")
    _write_note(tmp_path / "99 Fixtures" / "fix.md", "type: note\n")
    _write_note(tmp_path / "README.md", "type: note\n")  # vault root

    notes = load_notes(tmp_path, Mapping())
    ids = {n.id for n in notes}
    assert ids == {"a", "b", "c"}


def test_load_notes_skips_dot_dirs_and_files(tmp_path: Path) -> None:
    _write_note(tmp_path / "00 Inbox" / ".hidden.md", "type: note\n")
    _write_note(tmp_path / "00 Inbox" / ".obsidian" / "x.md", "type: note\n")
    _write_note(tmp_path / "00 Inbox" / "kept.md", "type: note\n")

    notes = load_notes(tmp_path, Mapping())
    ids = {n.id for n in notes}
    assert ids == {"kept"}


def test_load_notes_uses_mapping_folders(tmp_path: Path) -> None:
    _write_note(tmp_path / "Inbox" / "a.md", "kind: note\n")
    _write_note(tmp_path / "Projects" / "b.md", "kind: note\n")
    _write_note(tmp_path / "00 Inbox" / "z.md", "kind: note\n")  # not mapped

    m = Mapping(
        note_type="kind",
        inbox_dir="Inbox",
        project_dir="Projects",
        archive_dir="Archive",
    )
    notes = load_notes(tmp_path, m)
    ids = {n.id for n in notes}
    assert ids == {"a", "b"}


def test_load_notes_empty_folder_field_opts_out(tmp_path: Path) -> None:
    _write_note(tmp_path / "00 Inbox" / "a.md", "type: note\n")
    _write_note(tmp_path / "01 Project" / "b.md", "type: note\n")
    _write_note(tmp_path / "02 Archive" / "c.md", "type: note\n")

    m = Mapping(project_dir="")  # opt project state out
    notes = load_notes(tmp_path, m)
    ids = {n.id for n in notes}
    assert ids == {"a", "c"}


def test_load_notes_recovers_from_broken_yaml(tmp_path: Path) -> None:
    bad = tmp_path / "00 Inbox" / "bad.md"
    bad.parent.mkdir(parents=True, exist_ok=True)
    bad.write_text("---\ninvalid: : :\n---\nbody", encoding="utf-8")

    notes = load_notes(tmp_path, Mapping())
    assert len(notes) == 1
    assert notes[0].id == "bad"
    assert notes[0].frontmatter == {}
    assert "body" in notes[0].body


# --- ipa-test-vault integration ------------------------------------------


@pytest.mark.skipif(
    not IPA_TEST_VAULT.exists(),
    reason="ipa-test-vault is not present at the expected path",
)
def test_load_notes_scans_ipa_test_vault() -> None:
    test_vault_mapping = Mapping(
        note_type="kind",
        refs="parents",
        created_at="created",
        updated_at="updated",
    )
    notes = load_notes(IPA_TEST_VAULT, test_vault_mapping)
    assert len(notes) >= 10
    ids = {n.id for n in notes}
    # known notes from 02 Archive
    assert "🔖 커피" in ids
    # 90 Settings and 99 Fixtures are not in IPA folders → excluded
    assert "IPA Test Vault Convention" not in ids
    assert "Bad Project Note" not in ids


@pytest.mark.skipif(
    not IPA_TEST_VAULT.exists(),
    reason="ipa-test-vault is not present at the expected path",
)
def test_ipa_test_vault_notes_expose_kind_via_mapping() -> None:
    test_vault_mapping = Mapping(
        note_type="kind",
        refs="parents",
        created_at="created",
        updated_at="updated",
    )
    notes = load_notes(IPA_TEST_VAULT, test_vault_mapping)
    typed = [
        (n.id, n.note_type(test_vault_mapping))
        for n in notes
        if n.note_type(test_vault_mapping) is not None
    ]
    # at least most notes should expose a kind through the mapping
    assert len(typed) >= 10
    kinds = {kind for _, kind in typed}
    assert "note" in kinds or "index" in kinds

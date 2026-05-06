"""Builtin rule tests + ipa-test-vault integration with mapping.

Synthetic tests verify rule logic in isolation. The integration test
exercises the P3 promise: same rules + correct mapping = false-positive
free run on the test vault.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ipa_cli.api import (
    Convention,
    FormatContext,
    Issue,
    Mapping,
    Severity,
    Span,
    ValidationContext,
)
from ipa_cli.builtins.conventions.default_convention import default_convention
from ipa_cli.builtins.conventions.rules import (
    FrontmatterRequiredFieldsRule,
    IndexTitlePrefixRule,
    InvalidTypeRule,
    LocationByTypeRule,
    MissingRefRule,
    NoH1Rule,
    RootTitlePrefixRule,
    RootTitleSuffixRule,
)
from ipa_cli.parse.note_model import Note
from ipa_cli.parse.vault_loader import load_notes
from ipa_cli.runtime.validator_engine import run_validator

IPA_TEST_VAULT = Path("/Users/heohyeonjun/sync/projects/ipa-test-vault")


def _ctx(vault: Path, mapping: Mapping) -> ValidationContext:
    return ValidationContext(vault_path=vault, notes=[], mapping=mapping)


# --- FrontmatterRequiredFieldsRule ---------------------------------------


def test_frontmatter_required_default_mapping_flags_missing(tmp_path: Path) -> None:
    rule = FrontmatterRequiredFieldsRule()
    note = Note(id="x", path=tmp_path / "x.md", body="", frontmatter={})
    issues = rule.check(_ctx(tmp_path, Mapping()), note)
    codes = {i.code for i in issues}
    assert codes == {rule.code}
    # 3 semantic fields → 3 issues
    assert len(issues) == 3
    assert all(i.severity == Severity.WARN for i in issues)


def test_frontmatter_required_passes_with_full_default_keys(tmp_path: Path) -> None:
    rule = FrontmatterRequiredFieldsRule()
    note = Note(
        id="x",
        path=tmp_path / "x.md",
        body="",
        frontmatter={
            "type": "note",
            "date_created": "2026-05-06",
            "date_modified": "2026-05-06",
        },
    )
    issues = rule.check(_ctx(tmp_path, Mapping()), note)
    assert issues == []


def test_frontmatter_required_uses_mapping_keys(tmp_path: Path) -> None:
    """Same note shape but with test-vault keys + matching mapping = no issues."""
    rule = FrontmatterRequiredFieldsRule()
    note = Note(
        id="x",
        path=tmp_path / "x.md",
        body="",
        frontmatter={
            "kind": "note",
            "created": "2026-05-06",
            "updated": "2026-05-06",
        },
    )
    m = Mapping(
        note_type="kind",
        created_at="created",
        updated_at="updated",
    )
    assert rule.check(_ctx(tmp_path, m), note) == []


def test_frontmatter_empty_string_counts_as_missing(tmp_path: Path) -> None:
    rule = FrontmatterRequiredFieldsRule()
    note = Note(
        id="x",
        path=tmp_path / "x.md",
        body="",
        frontmatter={
            "type": "   ",
            "date_created": "2026-05-06",
            "date_modified": "2026-05-06",
        },
    )
    issues = rule.check(_ctx(tmp_path, Mapping()), note)
    assert len(issues) == 1
    assert "note_type" in issues[0].message


# --- NoH1Rule ------------------------------------------------------------


def test_no_h1_flags_h1_in_body(tmp_path: Path) -> None:
    rule = NoH1Rule()
    note = Note(
        id="x",
        path=tmp_path / "x.md",
        body="# Heading\n## Sub\nbody",
        frontmatter={},
    )
    issues = rule.check(_ctx(tmp_path, Mapping()), note)
    assert len(issues) == 1
    assert issues[0].span is not None
    assert issues[0].span.start_line == 1
    assert issues[0].severity == Severity.INFO


def test_no_h1_skips_inside_code_fence(tmp_path: Path) -> None:
    rule = NoH1Rule()
    note = Note(
        id="x",
        path=tmp_path / "x.md",
        body="text\n```\n# not a heading\n```\nmore",
        frontmatter={},
    )
    assert rule.check(_ctx(tmp_path, Mapping()), note) == []


def test_no_h1_does_not_flag_h2(tmp_path: Path) -> None:
    rule = NoH1Rule()
    note = Note(
        id="x",
        path=tmp_path / "x.md",
        body="## Heading\nbody",
        frontmatter={},
    )
    assert rule.check(_ctx(tmp_path, Mapping()), note) == []


def test_no_h1_handles_tilde_fence(tmp_path: Path) -> None:
    rule = NoH1Rule()
    note = Note(
        id="x",
        path=tmp_path / "x.md",
        body="~~~\n# not real\n~~~\n# real",
        frontmatter={},
    )
    issues = rule.check(_ctx(tmp_path, Mapping()), note)
    assert len(issues) == 1
    assert issues[0].span.start_line == 4


# --- NoH1Rule.fix --------------------------------------------------------


def _format_ctx(vault: Path, mapping: Mapping, notes: list[Note]) -> FormatContext:
    return FormatContext(vault_path=vault, notes=notes, mapping=mapping)


def test_no_h1_fix_returns_h2_patch(tmp_path: Path) -> None:
    rule = NoH1Rule()
    note = Note(
        id="x",
        path=tmp_path / "x.md",
        body="# Heading\nbody",
        frontmatter={},
    )
    issues = rule.check(_ctx(tmp_path, Mapping()), note)
    assert len(issues) == 1
    patches = rule.fix(_format_ctx(tmp_path, Mapping(), [note]), issues[0])
    assert patches is not None
    assert len(patches) == 1
    assert patches[0].replacement == "## Heading"
    assert patches[0].span.start_line == 1


def test_no_h1_fix_returns_none_when_span_missing(tmp_path: Path) -> None:
    rule = NoH1Rule()
    note = Note(id="x", path=tmp_path / "x.md", body="# H", frontmatter={})
    bogus = Issue(
        code=rule.code,
        severity=rule.severity,
        note_id=note.id,
        message="x",
        span=None,
    )
    assert rule.fix(_format_ctx(tmp_path, Mapping(), [note]), bogus) is None


def test_no_h1_fix_returns_none_when_note_missing(tmp_path: Path) -> None:
    rule = NoH1Rule()
    issue = Issue(
        code=rule.code,
        severity=rule.severity,
        note_id="ghost",
        message="x",
        span=Span(1, 1, 1, 4),
    )
    assert rule.fix(_format_ctx(tmp_path, Mapping(), []), issue) is None


# --- InvalidTypeRule (P003) ----------------------------------------------


def test_invalid_type_rule_flags_unknown_type(tmp_path: Path) -> None:
    rule = InvalidTypeRule()
    note = Note(
        id="x",
        path=tmp_path / "x.md",
        body="",
        frontmatter={"type": "draft"},
    )
    issues = rule.check(_ctx(tmp_path, Mapping()), note)
    assert len(issues) == 1
    assert issues[0].severity == Severity.ERROR
    assert "draft" in issues[0].message


def test_invalid_type_rule_passes_for_valid_types(tmp_path: Path) -> None:
    rule = InvalidTypeRule()
    for value in ("note", "index", "root"):
        note = Note(
            id="x",
            path=tmp_path / "x.md",
            body="",
            frontmatter={"type": value},
        )
        assert rule.check(_ctx(tmp_path, Mapping()), note) == []


def test_invalid_type_rule_skips_when_missing(tmp_path: Path) -> None:
    """Empty / missing type is P001's territory, not P003."""
    rule = InvalidTypeRule()
    note = Note(id="x", path=tmp_path / "x.md", body="", frontmatter={})
    assert rule.check(_ctx(tmp_path, Mapping()), note) == []


def test_invalid_type_rule_uses_mapping(tmp_path: Path) -> None:
    rule = InvalidTypeRule()
    note = Note(
        id="x",
        path=tmp_path / "x.md",
        body="",
        frontmatter={"kind": "draft"},
    )
    m = Mapping(note_type="kind")
    issues = rule.check(_ctx(tmp_path, m), note)
    assert len(issues) == 1


# --- MissingRefRule (P004) -----------------------------------------------


def test_missing_ref_flags_note_without_ref(tmp_path: Path) -> None:
    rule = MissingRefRule()
    note = Note(
        id="x",
        path=tmp_path / "x.md",
        body="",
        frontmatter={"type": "note"},
    )
    issues = rule.check(_ctx(tmp_path, Mapping()), note)
    assert len(issues) == 1
    assert "note" in issues[0].message


def test_missing_ref_flags_index_without_ref(tmp_path: Path) -> None:
    rule = MissingRefRule()
    note = Note(
        id="x",
        path=tmp_path / "x.md",
        body="",
        frontmatter={"type": "index", "ref": []},
    )
    assert len(rule.check(_ctx(tmp_path, Mapping()), note)) == 1


def test_missing_ref_passes_when_ref_present(tmp_path: Path) -> None:
    rule = MissingRefRule()
    note = Note(
        id="x",
        path=tmp_path / "x.md",
        body="",
        frontmatter={"type": "note", "ref": ["[[A]]"]},
    )
    assert rule.check(_ctx(tmp_path, Mapping()), note) == []


def test_missing_ref_skips_root(tmp_path: Path) -> None:
    rule = MissingRefRule()
    note = Note(
        id="x",
        path=tmp_path / "x.md",
        body="",
        frontmatter={"type": "root"},
    )
    assert rule.check(_ctx(tmp_path, Mapping()), note) == []


# --- Title rules (T001 / T002 / T003) ------------------------------------


def test_root_title_prefix_flags_missing_emoji(tmp_path: Path) -> None:
    rule = RootTitlePrefixRule()
    note = Note(
        id="My Project Root",
        path=tmp_path / "My Project Root.md",
        body="",
        frontmatter={"type": "root"},
    )
    assert len(rule.check(_ctx(tmp_path, Mapping()), note)) == 1


def test_root_title_prefix_passes_with_emoji(tmp_path: Path) -> None:
    rule = RootTitlePrefixRule()
    note = Note(
        id="🏷️ My Project Root",
        path=tmp_path / "🏷️ My Project Root.md",
        body="",
        frontmatter={"type": "root"},
    )
    assert rule.check(_ctx(tmp_path, Mapping()), note) == []


def test_root_title_prefix_skips_non_root(tmp_path: Path) -> None:
    rule = RootTitlePrefixRule()
    note = Note(
        id="some note",
        path=tmp_path / "some note.md",
        body="",
        frontmatter={"type": "note"},
    )
    assert rule.check(_ctx(tmp_path, Mapping()), note) == []


def test_root_title_suffix_flags_missing_root_word(tmp_path: Path) -> None:
    rule = RootTitleSuffixRule()
    note = Note(
        id="🏷️ Archive Index",
        path=tmp_path / "🏷️ Archive Index.md",
        body="",
        frontmatter={"type": "root"},
    )
    assert len(rule.check(_ctx(tmp_path, Mapping()), note)) == 1


def test_root_title_suffix_passes_with_root_word(tmp_path: Path) -> None:
    rule = RootTitleSuffixRule()
    note = Note(
        id="🏷️ My Project Root",
        path=tmp_path / "x.md",
        body="",
        frontmatter={"type": "root"},
    )
    assert rule.check(_ctx(tmp_path, Mapping()), note) == []


def test_index_title_prefix_flags_missing(tmp_path: Path) -> None:
    rule = IndexTitlePrefixRule()
    note = Note(
        id="My Topic",
        path=tmp_path / "My Topic.md",
        body="",
        frontmatter={"type": "index"},
    )
    assert len(rule.check(_ctx(tmp_path, Mapping()), note)) == 1


def test_index_title_prefix_passes(tmp_path: Path) -> None:
    rule = IndexTitlePrefixRule()
    note = Note(
        id="🔖 My Topic",
        path=tmp_path / "🔖 My Topic.md",
        body="",
        frontmatter={"type": "index"},
    )
    assert rule.check(_ctx(tmp_path, Mapping()), note) == []


# --- LocationByTypeRule (L001) -------------------------------------------


def test_location_note_in_inbox_passes(tmp_path: Path) -> None:
    rule = LocationByTypeRule()
    note_path = tmp_path / "00 Inbox" / "draft.md"
    note_path.parent.mkdir(parents=True, exist_ok=True)
    note_path.touch()
    note = Note(
        id="draft",
        path=note_path,
        body="",
        frontmatter={"type": "note"},
    )
    ctx = ValidationContext(vault_path=tmp_path, notes=[note], mapping=Mapping())
    assert rule.check(ctx, note) == []


def test_location_index_in_inbox_flagged(tmp_path: Path) -> None:
    rule = LocationByTypeRule()
    note_path = tmp_path / "00 Inbox" / "🔖 wrong.md"
    note_path.parent.mkdir(parents=True, exist_ok=True)
    note_path.touch()
    note = Note(
        id="🔖 wrong",
        path=note_path,
        body="",
        frontmatter={"type": "index"},
    )
    ctx = ValidationContext(vault_path=tmp_path, notes=[note], mapping=Mapping())
    issues = rule.check(ctx, note)
    assert len(issues) == 1
    assert "00 Inbox" in issues[0].message


def test_location_with_custom_folder_mapping(tmp_path: Path) -> None:
    rule = LocationByTypeRule()
    note_path = tmp_path / "Inbox" / "x.md"
    note_path.parent.mkdir(parents=True, exist_ok=True)
    note_path.touch()
    note = Note(
        id="x",
        path=note_path,
        body="",
        frontmatter={"kind": "note"},
    )
    m = Mapping(note_type="kind", inbox_dir="Inbox", project_dir="P", archive_dir="A")
    ctx = ValidationContext(vault_path=tmp_path, notes=[note], mapping=m)
    assert rule.check(ctx, note) == []


# --- ipa-test-vault integration ------------------------------------------


@pytest.mark.skipif(
    not IPA_TEST_VAULT.exists(),
    reason="ipa-test-vault is not present at the expected path",
)
def test_ipa_test_vault_with_correct_mapping_has_few_issues() -> None:
    """P3 acceptance: real vault + matching mapping = no false positives."""
    mapping = Mapping(
        note_type="kind",
        refs="parents",
        created_at="created",
        updated_at="updated",
    )
    notes = load_notes(IPA_TEST_VAULT, mapping)
    convention = default_convention()
    issues = run_validator(notes, mapping, convention, vault_path=IPA_TEST_VAULT)

    # Most notes pass. Genuine missing-field violations are allowed but
    # there should be no NoH1 noise (test vault doesn't use H1 in body).
    h1_issues = [i for i in issues if i.code == "ipa.heading.no_h1"]
    assert h1_issues == [], f"H1 false positives: {h1_issues}"

    fm_issues = [i for i in issues if i.code == "ipa.frontmatter.required_field"]
    # Allow a small number of genuinely incomplete notes; explosion would
    # signal mapping isn't being applied.
    assert len(fm_issues) < 20, (
        f"too many frontmatter issues ({len(fm_issues)}) — mapping likely not flowing"
    )


@pytest.mark.skipif(
    not IPA_TEST_VAULT.exists(),
    reason="ipa-test-vault is not present at the expected path",
)
def test_ipa_test_vault_with_default_mapping_explodes() -> None:
    """The same vault + wrong mapping = lots of false positives.

    This is the inverse of the above and proves the mapping layer is
    actually doing the absorption.
    """
    mapping = Mapping()  # 1차-style keys, won't match test vault
    notes = load_notes(IPA_TEST_VAULT, mapping)
    convention = default_convention()
    issues = run_validator(notes, mapping, convention, vault_path=IPA_TEST_VAULT)
    fm_issues = [i for i in issues if i.code == "ipa.frontmatter.required_field"]
    assert len(fm_issues) >= 50, (
        "expected mapping mismatch to cause widespread frontmatter false positives"
    )

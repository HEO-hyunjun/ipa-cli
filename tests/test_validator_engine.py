"""Validator engine tests — scope dispatch, filters, opt-in safety."""

from __future__ import annotations

from pathlib import Path
from typing import ClassVar

import pytest

from ipa_cli.api import (
    BaseConventionRule,
    Convention,
    Issue,
    Mapping,
    Severity,
)
from ipa_cli.parse.note_model import Note
from ipa_cli.runtime.validator_engine import (
    run_validator,
    scope_allows_rule,
    skipped_rules,
)


# --- helpers --------------------------------------------------------------


class _AlwaysFail(BaseConventionRule):
    """Per-note rule that always emits one issue."""

    code: ClassVar[str] = "test.always_fail"
    severity: ClassVar[Severity] = Severity.WARN

    def check(self, ctx, note):
        return [
            Issue(
                code=self.code,
                severity=self.severity,
                note_id=note.id,
                message="fail",
            )
        ]


class _FolderRule(BaseConventionRule):
    code: ClassVar[str] = "test.folder_rule"
    severity: ClassVar[Severity] = Severity.INFO
    default_scope: ClassVar[str] = "folder"

    def check_folder(self, ctx):
        return [
            Issue(
                code=self.code,
                severity=self.severity,
                note_id="<folder>",
                message="folder check",
            )
        ]


class _VaultRule(BaseConventionRule):
    code: ClassVar[str] = "test.vault_rule"
    severity: ClassVar[Severity] = Severity.INFO
    default_scope: ClassVar[str] = "vault"

    def check_vault(self, ctx):
        return [
            Issue(
                code=self.code,
                severity=self.severity,
                note_id="<vault>",
                message="vault check",
            )
        ]


def _note(name: str, path: Path) -> Note:
    return Note(id=name, path=path, body="", frontmatter={})


# --- scope_allows_rule matrix --------------------------------------------


@pytest.mark.parametrize(
    "cli, rule, expected",
    [
        ("note", "note", True),
        ("note", "folder", False),
        ("note", "vault", False),
        ("folder", "note", True),
        ("folder", "folder", True),
        ("folder", "vault", False),
        ("vault", "note", True),
        ("vault", "folder", True),
        ("vault", "vault", True),
    ],
)
def test_scope_allows_rule_matrix(cli, rule, expected) -> None:
    assert scope_allows_rule(cli, rule) is expected


# --- run_validator behavior ----------------------------------------------


def test_per_note_rule_runs_under_all_scopes(tmp_path: Path) -> None:
    notes = [_note("a", tmp_path / "a.md"), _note("b", tmp_path / "b.md")]
    convention = Convention(rules=[_AlwaysFail()])

    for cli_scope in ("note", "folder", "vault"):
        issues = run_validator(
            notes, Mapping(), convention, vault_path=tmp_path, scope=cli_scope
        )
        assert len(issues) == 2
        assert {i.note_id for i in issues} == {"a", "b"}


def test_folder_rule_blocked_under_note_scope(tmp_path: Path) -> None:
    convention = Convention(rules=[_FolderRule()])
    issues = run_validator([], Mapping(), convention, vault_path=tmp_path, scope="note")
    assert issues == []
    skipped = skipped_rules("note", convention)
    assert len(skipped) == 1
    assert skipped[0].code == "test.folder_rule"


def test_folder_rule_runs_under_folder_scope(tmp_path: Path) -> None:
    convention = Convention(rules=[_FolderRule()])
    issues = run_validator(
        [],
        Mapping(),
        convention,
        vault_path=tmp_path,
        scope="folder",
        folder=tmp_path,
    )
    assert len(issues) == 1
    assert issues[0].code == "test.folder_rule"


def test_vault_rule_only_under_vault_scope(tmp_path: Path) -> None:
    convention = Convention(rules=[_VaultRule()])
    for cli in ("note", "folder"):
        issues = run_validator(
            [],
            Mapping(),
            convention,
            vault_path=tmp_path,
            scope=cli,
            folder=tmp_path if cli == "folder" else None,
        )
        assert issues == [], f"scope={cli} should skip vault rule"
    issues = run_validator(
        [], Mapping(), convention, vault_path=tmp_path, scope="vault"
    )
    assert len(issues) == 1


def test_target_note_id_filters_per_note_rule(tmp_path: Path) -> None:
    notes = [_note("a", tmp_path / "a.md"), _note("b", tmp_path / "b.md")]
    convention = Convention(rules=[_AlwaysFail()])
    issues = run_validator(
        notes, Mapping(), convention, vault_path=tmp_path, target_note_id="a"
    )
    assert [i.note_id for i in issues] == ["a"]


def test_folder_filter_excludes_outside_notes(tmp_path: Path) -> None:
    inside = tmp_path / "00 Inbox"
    inside.mkdir()
    outside = tmp_path / "02 Archive"
    outside.mkdir()
    inside_md = inside / "a.md"
    inside_md.touch()
    outside_md = outside / "b.md"
    outside_md.touch()

    notes = [
        Note(id="a", path=inside_md, body="", frontmatter={}),
        Note(id="b", path=outside_md, body="", frontmatter={}),
    ]
    convention = Convention(rules=[_AlwaysFail()])
    issues = run_validator(
        notes,
        Mapping(),
        convention,
        vault_path=tmp_path,
        scope="folder",
        folder=inside,
    )
    assert [i.note_id for i in issues] == ["a"]


def test_empty_convention_returns_no_issues(tmp_path: Path) -> None:
    notes = [_note("a", tmp_path / "a.md")]
    convention = Convention(rules=[])
    issues = run_validator(notes, Mapping(), convention, vault_path=tmp_path)
    assert issues == []

"""Formatter engine tests — plan, conflict detection, apply roundtrip."""

from __future__ import annotations

from pathlib import Path
from typing import ClassVar

import pytest

from ipa_cli.api import (
    BaseConventionRule,
    Convention,
    Issue,
    Mapping,
    Patch,
    Severity,
    Span,
)
from ipa_cli.builtins.conventions.default_convention import default_convention
from ipa_cli.parse.note_model import Note
from ipa_cli.parse.vault_loader import load_notes
from ipa_cli.runtime.formatter_engine import apply, plan
from ipa_cli.runtime.validator_engine import run_validator


class _UppercaseLineRule(BaseConventionRule):
    """Synthetic rule: every line gets flagged + fix uppercases the whole line."""

    code: ClassVar[str] = "test.upper_line"
    severity: ClassVar[Severity] = Severity.INFO

    def check(self, ctx, note):
        issues: list[Issue] = []
        for idx, line in enumerate(note.body.splitlines(), start=1):
            if line and line != line.upper():
                issues.append(
                    Issue(
                        code=self.code,
                        severity=self.severity,
                        note_id=note.id,
                        message="not upper",
                        span=Span(idx, 1, idx, len(line) + 1),
                    )
                )
        return issues

    def fix(self, ctx, issue):
        if issue.span is None:
            return None
        note = next((n for n in ctx.notes if n.id == issue.note_id), None)
        if note is None:
            return None
        body_lines = note.body.splitlines()
        idx = issue.span.start_line - 1
        if idx < 0 or idx >= len(body_lines):
            return None
        line = body_lines[idx]
        return [Patch(note_id=issue.note_id, span=issue.span, replacement=line.upper())]


def _write_note(tmp_path: Path, name: str, body: str, fm: str = "type: note\n") -> Path:
    path = tmp_path / "00 Inbox" / f"{name}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\n{fm}---\n{body}", encoding="utf-8")
    return path


# --- plan -----------------------------------------------------------------


def test_plan_collects_patches_per_note(tmp_path: Path) -> None:
    _write_note(tmp_path, "a", "hello\nworld\n")
    _write_note(tmp_path, "b", "BIG\n")
    notes = load_notes(tmp_path, Mapping())
    convention = Convention(rules=[_UppercaseLineRule()])
    issues = run_validator(notes, Mapping(), convention, vault_path=tmp_path)
    plan_result = plan(issues, convention, Mapping(), notes, tmp_path)

    assert "a" in plan_result.plans_by_note
    assert "b" not in plan_result.plans_by_note
    np = plan_result.plans_by_note["a"]
    assert len(np.patches) == 2
    assert plan_result.total_patches == 2
    assert plan_result.total_conflicts == 0


def test_plan_skips_issue_without_matching_rule(tmp_path: Path) -> None:
    _write_note(tmp_path, "a", "hello\n")
    notes = load_notes(tmp_path, Mapping())
    convention = Convention(rules=[])  # no rules → no fix dispatch
    foreign_issue = Issue(
        code="ipa.unknown",
        severity=Severity.INFO,
        note_id="a",
        message="x",
        span=Span(1, 1, 1, 6),
    )
    plan_result = plan([foreign_issue], convention, Mapping(), notes, tmp_path)
    assert plan_result.total_patches == 0


def test_plan_detects_overlapping_patches(tmp_path: Path) -> None:
    """Two rules emitting different replacements for the same line."""
    _write_note(tmp_path, "a", "hello\n")
    notes = load_notes(tmp_path, Mapping())

    class _RuleA(BaseConventionRule):
        code: ClassVar[str] = "test.a"
        severity: ClassVar[Severity] = Severity.INFO

        def check(self, ctx, note):
            return [
                Issue(
                    code=self.code,
                    severity=self.severity,
                    note_id=note.id,
                    message="x",
                    span=Span(1, 1, 1, 6),
                )
            ]

        def fix(self, ctx, issue):
            return [Patch(note_id="a", span=issue.span, replacement="AAA")]

    class _RuleB(BaseConventionRule):
        code: ClassVar[str] = "test.b"
        severity: ClassVar[Severity] = Severity.INFO

        def check(self, ctx, note):
            return [
                Issue(
                    code=self.code,
                    severity=self.severity,
                    note_id=note.id,
                    message="x",
                    span=Span(1, 1, 1, 6),
                )
            ]

        def fix(self, ctx, issue):
            return [Patch(note_id="a", span=issue.span, replacement="BBB")]

    convention = Convention(rules=[_RuleA(), _RuleB()])
    issues = run_validator(notes, Mapping(), convention, vault_path=tmp_path)
    plan_result = plan(issues, convention, Mapping(), notes, tmp_path)
    np = plan_result.plans_by_note["a"]
    assert len(np.patches) == 1  # first wins
    assert len(np.conflicts) == 1


# --- apply ----------------------------------------------------------------


def test_apply_writes_changes_back(tmp_path: Path) -> None:
    path = _write_note(tmp_path, "a", "hello\nworld\n")
    notes = load_notes(tmp_path, Mapping())
    convention = Convention(rules=[_UppercaseLineRule()])
    issues = run_validator(notes, Mapping(), convention, vault_path=tmp_path)
    plan_result = plan(issues, convention, Mapping(), notes, tmp_path)
    apply_result = apply(plan_result)

    assert apply_result.errors == []
    assert "a" in apply_result.updated_notes
    new_text = path.read_text(encoding="utf-8")
    assert new_text.startswith("---\ntype: note\n---\n"), "frontmatter preserved"
    assert "HELLO" in new_text
    assert "WORLD" in new_text


def test_apply_preserves_frontmatter_verbatim(tmp_path: Path) -> None:
    path = _write_note(
        tmp_path,
        "a",
        "lower\n",
        fm="type: note\n# trailing comment in frontmatter\n",
    )
    notes = load_notes(tmp_path, Mapping())
    convention = Convention(rules=[_UppercaseLineRule()])
    issues = run_validator(notes, Mapping(), convention, vault_path=tmp_path)
    plan_result = plan(issues, convention, Mapping(), notes, tmp_path)
    apply(plan_result)

    new_text = path.read_text(encoding="utf-8")
    assert "# trailing comment in frontmatter" in new_text
    assert new_text.split("---\n", 2)[2].strip() == "LOWER"


def test_apply_skipped_for_note_with_only_conflicts(tmp_path: Path) -> None:
    """If all patches for a note collide, accepted list ends up empty
    after the first wins; apply still reads/writes that note (with the
    surviving patch). To verify *no patches* path: zero issues."""
    _write_note(tmp_path, "a", "ALREADY UPPER\n")
    notes = load_notes(tmp_path, Mapping())
    convention = Convention(rules=[_UppercaseLineRule()])
    issues = run_validator(notes, Mapping(), convention, vault_path=tmp_path)
    assert issues == []
    plan_result = plan(issues, convention, Mapping(), notes, tmp_path)
    apply_result = apply(plan_result)
    assert apply_result.updated_notes == []


def test_apply_invalid_span_reports_error(tmp_path: Path) -> None:
    _write_note(tmp_path, "a", "short\n")
    notes = load_notes(tmp_path, Mapping())

    class _BadRule(BaseConventionRule):
        code: ClassVar[str] = "test.bad"
        severity: ClassVar[Severity] = Severity.INFO

        def check(self, ctx, note):
            return [
                Issue(
                    code=self.code,
                    severity=self.severity,
                    note_id=note.id,
                    message="x",
                    span=Span(99, 1, 99, 5),  # out of range
                )
            ]

        def fix(self, ctx, issue):
            return [Patch(note_id="a", span=issue.span, replacement="X")]

    convention = Convention(rules=[_BadRule()])
    issues = run_validator(notes, Mapping(), convention, vault_path=tmp_path)
    plan_result = plan(issues, convention, Mapping(), notes, tmp_path)
    apply_result = apply(plan_result)
    assert apply_result.updated_notes == []
    assert len(apply_result.errors) == 1
    assert "out of body range" in apply_result.errors[0][1]


# --- builtin NoH1 fix end-to-end -----------------------------------------


def test_no_h1_rule_apply_demotes_h1_to_h2(tmp_path: Path) -> None:
    path = _write_note(tmp_path, "a", "# Heading\nbody\n")
    notes = load_notes(tmp_path, Mapping())
    convention = default_convention()
    issues = run_validator(notes, Mapping(), convention, vault_path=tmp_path)
    h1_issues = [i for i in issues if i.code == "ipa.heading.no_h1"]
    assert len(h1_issues) == 1

    plan_result = plan(issues, convention, Mapping(), notes, tmp_path)
    apply_result = apply(plan_result)
    assert apply_result.errors == []
    new_text = path.read_text(encoding="utf-8")
    body = new_text.split("---\n", 2)[2]
    assert body.splitlines()[0] == "## Heading"


def test_no_h1_rule_apply_idempotent(tmp_path: Path) -> None:
    """Run plan/apply twice. Second pass should have no work."""
    _write_note(tmp_path, "a", "# Heading\nbody\n")
    convention = default_convention()

    for run_idx in range(2):
        notes = load_notes(tmp_path, Mapping())
        issues = run_validator(notes, Mapping(), convention, vault_path=tmp_path)
        plan_result = plan(issues, convention, Mapping(), notes, tmp_path)
        apply(plan_result)

    notes = load_notes(tmp_path, Mapping())
    h1_issues = [
        i
        for i in run_validator(notes, Mapping(), convention, vault_path=tmp_path)
        if i.code == "ipa.heading.no_h1"
    ]
    assert h1_issues == []

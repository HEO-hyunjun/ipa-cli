"""Formatter engine — patch planning, conflict detection, execute.

Flow:
1. ``plan(issues, convention, mapping, notes, vault_path)`` walks the
   issues, dispatches each to the originating rule's ``fix`` method, and
   collects ``Patch`` candidates per note.
2. Span overlaps within the same note are flagged as conflicts and
   excluded from the apply set. The user sees them in the plan output.
3. ``apply(plan_result)`` re-reads each affected ``.md`` file, splits the
   frontmatter from the body (frontmatter is preserved verbatim), applies
   non-conflicting patches in reverse line/col order so coordinates don't
   shift, and writes the result back.

Patches use *body-relative* line numbers — line 1 of ``Span`` is the
first line of the body, not of the file. Rules generate spans by
iterating ``note.body``, so this contract is uniform with how
``BaseConventionRule.check`` already operates.

Single-line patches only for now (start_line == end_line). Multi-line
patches will land alongside the markdown-it-py parser in P5.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from ipa_cli.api.base_rules import Issue, Patch
from ipa_cli.api.context import FormatContext

if TYPE_CHECKING:
    from ipa_cli.api.base_rules import BaseConventionRule
    from ipa_cli.api.conventions import Convention
    from ipa_cli.api.mappings import Mapping
    from ipa_cli.parse.note_model import Note


@dataclass
class NotePlan:
    note_id: str
    path: Path
    patches: list[Patch] = field(default_factory=list)
    conflicts: list[tuple[Patch, Patch]] = field(default_factory=list)


@dataclass
class PlanResult:
    plans_by_note: dict[str, NotePlan] = field(default_factory=dict)

    @property
    def total_patches(self) -> int:
        return sum(len(p.patches) for p in self.plans_by_note.values())

    @property
    def total_conflicts(self) -> int:
        return sum(len(p.conflicts) for p in self.plans_by_note.values())


@dataclass
class ApplyResult:
    updated_notes: list[str] = field(default_factory=list)
    errors: list[tuple[str, str]] = field(default_factory=list)


def plan(
    issues: list[Issue],
    convention: "Convention",
    mapping: "Mapping",
    notes: list["Note"],
    vault_path: Path,
) -> PlanResult:
    """Run rule.fix per issue and collect non-conflicting patches per note."""
    rules_by_code: dict[str, BaseConventionRule] = {r.code: r for r in convention.rules}
    notes_by_id: dict[str, Note] = {n.id: n for n in notes}
    ctx = FormatContext(vault_path=vault_path, notes=notes, mapping=mapping)

    drafts: dict[str, list[Patch]] = {}
    for issue in issues:
        rule = rules_by_code.get(issue.code)
        if rule is None:
            continue
        patches = rule.fix(ctx, issue)
        if not patches:
            continue
        for patch in patches:
            drafts.setdefault(patch.note_id, []).append(patch)

    result = PlanResult()
    for note_id, raw_patches in drafts.items():
        note = notes_by_id.get(note_id)
        if note is None:
            continue
        accepted, conflicts = _resolve_conflicts(raw_patches)
        result.plans_by_note[note_id] = NotePlan(
            note_id=note_id,
            path=note.path,
            patches=accepted,
            conflicts=conflicts,
        )
    return result


def _resolve_conflicts(
    patches: list[Patch],
) -> tuple[list[Patch], list[tuple[Patch, Patch]]]:
    """Pairwise overlap check (single-line spans).

    Patches that overlap any earlier accepted patch are dropped; both
    members of each conflicting pair are reported so the user can
    disambiguate manually.
    """
    accepted: list[Patch] = []
    conflicts: list[tuple[Patch, Patch]] = []
    for patch in patches:
        clash = next(
            (existing for existing in accepted if _overlap(existing.span, patch.span)),
            None,
        )
        if clash is not None:
            conflicts.append((clash, patch))
        else:
            accepted.append(patch)
    return accepted, conflicts


def _overlap(a, b) -> bool:
    if a.start_line != b.start_line or a.end_line != b.end_line:
        # Multi-line patches not supported in P3b; treat any line overlap
        # between differently-shaped spans as a conflict to be safe.
        return not (a.end_line < b.start_line or b.end_line < a.start_line)
    # Same single-line range.
    return not (a.end_col <= b.start_col or b.end_col <= a.start_col)


def apply(plan_result: PlanResult) -> ApplyResult:
    """Apply accepted patches to disk. Frontmatter is preserved verbatim."""
    result = ApplyResult()
    for note_id, np in plan_result.plans_by_note.items():
        if not np.patches:
            continue
        try:
            text = np.path.read_text(encoding="utf-8")
        except OSError as exc:
            result.errors.append((note_id, f"read failed: {exc}"))
            continue
        try:
            new_text = _apply_to_text(text, np.patches)
        except ValueError as exc:
            result.errors.append((note_id, str(exc)))
            continue
        try:
            np.path.write_text(new_text, encoding="utf-8")
        except OSError as exc:
            result.errors.append((note_id, f"write failed: {exc}"))
            continue
        result.updated_notes.append(note_id)
    return result


def _split_frontmatter(text: str) -> tuple[str, str]:
    """Return (frontmatter_block_with_fences, body). Empty frontmatter ok."""
    if not text.startswith("---"):
        return "", text
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip("\r\n") != "---":
        return "", text
    for i in range(1, len(lines)):
        if lines[i].rstrip("\r\n") == "---":
            head = "".join(lines[: i + 1])
            body = "".join(lines[i + 1 :])
            return head, body
    return "", text


def _apply_to_text(original: str, patches: list[Patch]) -> str:
    head, body = _split_frontmatter(original)

    # Sort patches by (start_line, start_col) descending so earlier
    # replacements don't shift later coordinates.
    ordered = sorted(
        patches,
        key=lambda p: (p.span.start_line, p.span.start_col),
        reverse=True,
    )

    body_lines = body.splitlines(keepends=True)
    for patch in ordered:
        span = patch.span
        if span.start_line != span.end_line:
            raise ValueError(
                f"multi-line patch not supported yet (note {patch.note_id})"
            )
        line_idx = span.start_line - 1
        if line_idx < 0 or line_idx >= len(body_lines):
            raise ValueError(
                f"patch line {span.start_line} out of body range (0..{len(body_lines)})"
            )
        original_line = body_lines[line_idx]
        # Preserve trailing newline (keepends gives us '\n' or '' on last line).
        trailing = ""
        line_text = original_line
        if line_text.endswith("\r\n"):
            trailing = "\r\n"
            line_text = line_text[:-2]
        elif line_text.endswith("\n"):
            trailing = "\n"
            line_text = line_text[:-1]
        start = span.start_col - 1
        end = span.end_col - 1
        if start < 0 or end > len(line_text) + 1 or start > end:
            raise ValueError(
                f"patch span {span} invalid for line of length {len(line_text)}"
            )
        # Replace [start, end) with replacement text.
        new_line_text = line_text[:start] + patch.replacement + line_text[end:]
        body_lines[line_idx] = new_line_text + trailing

    return head + "".join(body_lines)

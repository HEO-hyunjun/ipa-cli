"""Reproduce 1차 ``ipa validator`` output on the 2차 service stack.

Decision #4 of the migration plan keeps the 1차 stdout shape (one row
per issue, ``[fixable]`` marker, ``Found N issues (M fixable)`` summary)
while routing the actual checks through ``runtime.validator_engine``.
``--select`` / ``--ignore`` still accept legacy codes (``P001`` /
category prefixes); they are translated to 2차 codes before the engine
runs.

The 1차 ↔ 2차 code mapping lives in ``docs/legacy-validator-rule-map.md``
— update both when adding a rule.
"""

from __future__ import annotations

from pathlib import Path

from ipa_cli.api.base_rules import Issue as NewIssue
from ipa_cli.api.conventions import Convention
from ipa_cli.api.mappings import Mapping
from ipa_cli.builtins.conventions.default_convention import default_convention
from ipa_cli.parse.note_model import Note
from ipa_cli.parse.vault_loader import load_notes
from ipa_cli.runtime.formatter_engine import apply as apply_plan
from ipa_cli.runtime.formatter_engine import plan as build_plan
from ipa_cli.runtime.validator_engine import run_validator

# 2차 code → 1차 code (see docs/legacy-validator-rule-map.md).
NEW_TO_LEGACY: dict[str, str] = {
    "ipa.frontmatter.required_field": "P001",
    "ipa.frontmatter.date_format": "P002",
    "ipa.frontmatter.invalid_type": "P003",
    "ipa.frontmatter.missing_ref": "P004",
    "ipa.title.root_prefix_missing": "T001",
    "ipa.title.root_suffix_missing": "T002",
    "ipa.title.index_prefix_missing": "T003",
    "ipa.location.type_mismatch": "L001",
    "ipa.link.ref_target_missing": "K001",
    "ipa.link.wikilink_target_missing": "K002",
    "ipa.root_folder.duplicate": "R001",
    "ipa.root_folder.missing": "R002",
    "ipa.heading.no_h1": "H001",
}

LEGACY_TO_NEW: dict[str, str] = {v: k for k, v in NEW_TO_LEGACY.items()}

# Codes whose 1차 output displays ``[fixable]``. See
# docs/legacy-validator-rule-map.md for the rationale.
LEGACY_FIXABLE_CODES: frozenset[str] = frozenset({"P001", "P003", "H001"})

CATEGORY_PREFIXES: tuple[str, ...] = ("P", "T", "L", "K", "R", "H")


def _parse_filter(value: str | None) -> set[str] | None:
    """Translate a ``--select`` / ``--ignore`` token list into the 2차 code
    set the engine should keep. ``None`` means "no filter applied"."""
    if not value:
        return None
    legacy_codes: set[str] = set()
    for raw in value.split(","):
        tok = raw.strip().upper()
        if tok in CATEGORY_PREFIXES:
            legacy_codes |= {c for c in LEGACY_TO_NEW if c.startswith(tok)}
        elif tok in LEGACY_TO_NEW:
            legacy_codes.add(tok)
    if not legacy_codes:
        return None
    return {LEGACY_TO_NEW[c] for c in legacy_codes}


def _filtered_convention(allow: set[str] | None, deny: set[str] | None) -> Convention:
    rules = list(default_convention().rules)
    if allow is not None:
        rules = [r for r in rules if r.code in allow]
    if deny is not None:
        rules = [r for r in rules if r.code not in deny]
    return Convention(name="legacy.view", rules=rules)


def _rel_path(path: Path, vault: Path) -> str:
    try:
        return str(path.resolve().relative_to(vault.resolve()))
    except ValueError:
        return str(path)


def _render_report(issues: list[NewIssue], notes: list[Note], vault: Path) -> str:
    """Produce the 1차 ``format_report_text`` shape from new-style issues."""
    id_to_path = {n.id: n.path for n in notes}
    by_file: dict[str, list[tuple[str, str, bool]]] = {}
    fixable_count = 0
    total = 0

    for issue in issues:
        legacy_code = NEW_TO_LEGACY.get(issue.code, issue.code)
        path = id_to_path.get(issue.note_id)
        rel = _rel_path(path, vault) if path else issue.note_id
        fixable = legacy_code in LEGACY_FIXABLE_CODES
        by_file.setdefault(rel, []).append((legacy_code, issue.message, fixable))
        if fixable:
            fixable_count += 1
        total += 1

    lines: list[str] = []
    for filepath in sorted(by_file.keys()):
        lines.append(filepath)
        for code, msg, fixable in by_file[filepath]:
            marker = " [fixable]" if fixable else ""
            lines.append(f"  {code} {msg}{marker}")
        lines.append("")

    lines.append(f"Found {total} issues ({fixable_count} fixable)")
    return "\n".join(lines)


def _render_fix(
    notes: list[Note],
    mapping: Mapping,
    convention: Convention,
    vault: Path,
    target_note_id: str | None,
    dry_run: bool,
) -> str:
    """Run ``formatter_engine`` and emit a 1차-style summary."""
    issues = run_validator(
        notes,
        mapping,
        convention,
        vault_path=vault,
        scope="vault",
        target_note_id=target_note_id,
    )
    plan_result = build_plan(
        issues=issues,
        convention=convention,
        mapping=mapping,
        notes=notes,
        vault_path=vault,
    )

    rows: list[tuple[str, str]] = []
    for note_plan in plan_result.plans_by_note.values():
        for patch in note_plan.patches:
            summary = (
                patch.replacement.splitlines()[0] if patch.replacement else "(blank)"
            )
            rows.append((note_plan.note_id, summary[:60]))

    mode = "DRY RUN" if dry_run else "APPLIED"
    lines = [f"=== Auto Fix ({mode}) ==="]
    if not rows:
        lines.append("  No fixes needed.")
        return "\n".join(lines)

    if not dry_run:
        apply_plan(plan_result)

    for note_id, desc in rows:
        lines.append(f"  [{note_id}] {desc}")
    lines.append(f"\nTotal fixes: {len(rows)}")
    return "\n".join(lines)


def render_validator(
    vault_path: Path,
    *,
    note: str | None = None,
    select: str | None = None,
    ignore: str | None = None,
    fix: bool = False,
    dry_run: bool = False,
    mapping: Mapping | None = None,
) -> str:
    """Top-level entrypoint used by ``ipa validator`` (S4)."""
    if mapping is None:
        mapping = Mapping()
    vault = vault_path.expanduser()
    notes = load_notes(vault, mapping)

    allow = _parse_filter(select)
    deny = _parse_filter(ignore)
    convention = _filtered_convention(allow, deny)

    if fix:
        return _render_fix(notes, mapping, convention, vault, note, dry_run)

    issues = run_validator(
        notes,
        mapping,
        convention,
        vault_path=vault,
        scope="vault",
        target_note_id=note,
    )
    return _render_report(issues, notes, vault)

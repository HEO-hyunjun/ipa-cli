"""Validator engine — dispatch convention rules over notes by scope.

Scope opt-in is enforced here, not in rules. A rule declares the
broadest scope it expects to be invoked at via ``default_scope``; the
CLI passes its own ``scope``. The engine only runs rules whose
``default_scope`` is reachable from the CLI scope:

  CLI scope  | runs rules with default_scope ∈
  ---------- | -------------------------------
  note       | {note}
  folder     | {note, folder}
  vault      | {note, folder, vault}

Per-note rules iterate notes (optionally filtered by ``folder`` /
``target_note_id``). Folder/vault rules call their dedicated method
once per scope.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from ipa_cli.api.base_rules import Issue, Scope
from ipa_cli.api.context import ValidationContext

if TYPE_CHECKING:
    from ipa_cli.api.base_rules import BaseConventionRule
    from ipa_cli.api.conventions import Convention
    from ipa_cli.api.mappings import Mapping
    from ipa_cli.parse.note_model import Note


SCOPE_ORDER: dict[Scope, int] = {"note": 1, "folder": 2, "vault": 3}


def scope_allows_rule(cli_scope: Scope, rule_scope: Scope) -> bool:
    """True when a rule of ``rule_scope`` may run under ``cli_scope``."""
    return SCOPE_ORDER[cli_scope] >= SCOPE_ORDER[rule_scope]


def _note_in_folder(note: "Note", folder: Path) -> bool:
    folder_resolved = folder.resolve()
    try:
        note.path.resolve().relative_to(folder_resolved)
    except ValueError:
        return False
    return True


def run_validator(
    notes: list["Note"],
    mapping: "Mapping",
    convention: "Convention",
    *,
    vault_path: Path,
    scope: Scope = "note",
    folder: Path | None = None,
    target_note_id: str | None = None,
) -> list[Issue]:
    """Run applicable rules and return collected issues."""
    ctx = ValidationContext(
        vault_path=vault_path,
        notes=notes,
        mapping=mapping,
        folder=folder,
    )

    issues: list[Issue] = []
    for rule in convention.rules:
        rule_scope: Scope = rule.default_scope
        if not scope_allows_rule(scope, rule_scope):
            continue
        if rule_scope == "vault":
            issues.extend(rule.check_vault(ctx))
        elif rule_scope == "folder":
            issues.extend(rule.check_folder(ctx))
        else:
            issues.extend(_run_per_note(rule, ctx, notes, folder, target_note_id))
    return issues


def _run_per_note(
    rule: "BaseConventionRule",
    ctx: ValidationContext,
    notes: list["Note"],
    folder: Path | None,
    target_note_id: str | None,
) -> list[Issue]:
    out: list[Issue] = []
    for note in notes:
        if target_note_id is not None and note.id != target_note_id:
            continue
        if folder is not None and not _note_in_folder(note, folder):
            continue
        out.extend(rule.check(ctx, note))
    return out


def skipped_rules(
    cli_scope: Scope, convention: "Convention"
) -> list["BaseConventionRule"]:
    """Rules that won't run under ``cli_scope`` (informational; for ``--summary``)."""
    return [
        r for r in convention.rules if not scope_allows_rule(cli_scope, r.default_scope)
    ]

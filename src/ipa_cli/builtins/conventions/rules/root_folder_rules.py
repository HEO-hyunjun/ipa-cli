"""Root / folder correspondence rules.

IPA convention: each top-level subfolder under ``project_dir`` carries
exactly one root note as a direct child. ``DuplicateRootRule`` (R001)
catches the "more than one" case; ``MissingRootRule`` (R002) catches
the "none" case. Archive lives by relaxed rules and isn't checked.

Vault scope because both rules need to walk the filesystem and the
loaded note set together.

Mirrors 1차 R001 / R002.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar

from ipa_cli.api.base_rules import BaseConventionRule, Issue, Scope, Severity

if TYPE_CHECKING:
    from pathlib import Path

    from ipa_cli.api.context import ValidationContext
    from ipa_cli.parse.note_model import Note


def _project_root_path(ctx: "ValidationContext") -> "Path | None":
    if not ctx.mapping.project_dir:
        return None
    project = ctx.vault_path / ctx.mapping.project_dir
    return project if project.is_dir() else None


def _roots_under_project(
    notes: "list[Note]", ctx: "ValidationContext", project_path: "Path"
) -> "dict[Path, list[Note]]":
    """Group root-typed notes by their immediate parent folder.

    Notes outside ``project_path`` are ignored.
    """
    grouped: dict[Path, list[Note]] = {}
    project_resolved = project_path.resolve()
    for note in notes:
        if note.note_type(ctx.mapping) != "root":
            continue
        try:
            note.path.resolve().relative_to(project_resolved)
        except ValueError:
            continue
        grouped.setdefault(note.path.parent, []).append(note)
    return grouped


class DuplicateRootRule(BaseConventionRule):
    """Flag folders that contain more than one root note.

    Mirrors 1차 R001. The first root in a folder is treated as canonical;
    subsequent roots are reported.
    """

    code: ClassVar[str] = "ipa.root_folder.duplicate"
    severity: ClassVar[Severity] = Severity.WARN
    default_scope: ClassVar[Scope] = "vault"

    def check_vault(self, ctx: "ValidationContext") -> list[Issue]:
        project = _project_root_path(ctx)
        if project is None:
            return []
        grouped = _roots_under_project(ctx.notes, ctx, project)
        issues: list[Issue] = []
        for folder, roots in grouped.items():
            if len(roots) <= 1:
                continue
            for extra in roots[1:]:
                issues.append(
                    Issue(
                        code=self.code,
                        severity=self.severity,
                        note_id=extra.id,
                        message=(
                            f"duplicate root in folder {folder.name!r} "
                            f"(canonical: {roots[0].id!r})"
                        ),
                    )
                )
        return issues


class MissingRootRule(BaseConventionRule):
    """Flag top-level project subfolders that have no direct-child root.

    Mirrors 1차 R002. The folder name is used as the issue's note id —
    the issue isn't really about a single note, but the engine's note_id
    field needs a stable identifier and the folder name is the best
    available handle.
    """

    code: ClassVar[str] = "ipa.root_folder.missing"
    severity: ClassVar[Severity] = Severity.WARN
    default_scope: ClassVar[Scope] = "vault"

    def check_vault(self, ctx: "ValidationContext") -> list[Issue]:
        project = _project_root_path(ctx)
        if project is None:
            return []
        grouped = _roots_under_project(ctx.notes, ctx, project)
        with_root = {folder for folder in grouped if grouped[folder]}

        issues: list[Issue] = []
        for entry in sorted(project.iterdir()):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            if entry not in with_root:
                issues.append(
                    Issue(
                        code=self.code,
                        severity=self.severity,
                        note_id=entry.name,
                        message=f"project folder {entry.name!r} has no root note",
                    )
                )
        return issues

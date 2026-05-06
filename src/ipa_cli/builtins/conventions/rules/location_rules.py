"""Location convention rules.

IPA convention pairs note ``type`` with allowed top-level folders:

- ``note`` → ``inbox`` or ``archive``
- ``index`` → ``project`` or ``archive``
- ``root`` → ``project`` or ``archive``

Folders are read from the active ``Mapping`` (``inbox_dir`` /
``project_dir`` / ``archive_dir``) so vaults using non-standard folder
names can re-bind without rewriting rule code.

Mirrors 1차 L001.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar

from ipa_cli.api.base_rules import BaseConventionRule, Issue, Severity

if TYPE_CHECKING:
    from ipa_cli.api.context import ValidationContext
    from ipa_cli.parse.note_model import Note


class LocationByTypeRule(BaseConventionRule):
    code: ClassVar[str] = "ipa.location.type_mismatch"
    severity: ClassVar[Severity] = Severity.WARN

    def check(self, ctx: "ValidationContext", note: "Note") -> list[Issue]:
        nt = note.note_type(ctx.mapping)
        if nt is None or nt == "":
            return []

        try:
            rel = note.path.relative_to(ctx.vault_path)
        except ValueError:
            return []
        if not rel.parts:
            return []
        top = rel.parts[0]

        m = ctx.mapping
        if nt == "note":
            allowed = {d for d in (m.inbox_dir, m.archive_dir) if d}
        elif nt == "index":
            allowed = {d for d in (m.project_dir, m.archive_dir) if d}
        elif nt == "root":
            allowed = {d for d in (m.project_dir, m.archive_dir) if d}
        else:
            return []

        if not allowed:
            return []
        if top not in allowed:
            return [
                Issue(
                    code=self.code,
                    severity=self.severity,
                    note_id=note.id,
                    message=(f"type={nt} note in {top!r} (allowed: {sorted(allowed)})"),
                )
            ]
        return []

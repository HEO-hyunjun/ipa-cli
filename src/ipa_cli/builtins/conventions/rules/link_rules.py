"""Link target convention rules.

These rules walk all loaded notes once (vault scope) to detect dangling
``ref`` and body wikilink targets. The lookup is a single pass over
``ctx.notes``; building a name index per-rule is cheap relative to the
filesystem walk for attachments (only K002 needs that).

Mirrors 1차 K001 / K002:
- K001 → ``RefLinkTargetRule`` (frontmatter ref points to a missing note)
- K002 → ``WikilinkTargetRule`` (body ``[[...]]`` points to a missing
  note and isn't a known attachment)
"""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar

from ipa_cli.api.base_rules import BaseConventionRule, Issue, Scope, Severity
from ipa_cli.parse.attachments import build_attachment_index
from ipa_cli.parse.links import extract_ref_targets, extract_wikilinks

if TYPE_CHECKING:
    from ipa_cli.api.context import ValidationContext
    from ipa_cli.parse.note_model import Note


def _build_note_id_set(notes: "list[Note]") -> set[str]:
    return {n.id for n in notes}


def _strip_anchor(target: str) -> str:
    """``[[Note#Section]]`` resolves against ``Note``."""
    return target.split("#", 1)[0].strip()


class RefLinkTargetRule(BaseConventionRule):
    """Flag frontmatter ref entries that don't point to a known note.

    Mirrors 1차 K001.
    """

    code: ClassVar[str] = "ipa.link.ref_target_missing"
    severity: ClassVar[Severity] = Severity.WARN
    default_scope: ClassVar[Scope] = "vault"

    def check_vault(self, ctx: "ValidationContext") -> list[Issue]:
        known = _build_note_id_set(ctx.notes)
        issues: list[Issue] = []
        for note in ctx.notes:
            for target in extract_ref_targets(note.refs(ctx.mapping)):
                resolved = _strip_anchor(target)
                if resolved and resolved not in known:
                    issues.append(
                        Issue(
                            code=self.code,
                            severity=self.severity,
                            note_id=note.id,
                            message=f"ref target missing: {target!r}",
                        )
                    )
        return issues


class WikilinkTargetRule(BaseConventionRule):
    """Flag body wikilinks that don't resolve to a note or known attachment.

    Mirrors 1차 K002. Embeds (``![[...]]``) are intentionally ignored
    here — they're images/PDFs and validated against the attachment
    index too lazily for these short body scans.
    """

    code: ClassVar[str] = "ipa.link.wikilink_target_missing"
    severity: ClassVar[Severity] = Severity.WARN
    default_scope: ClassVar[Scope] = "vault"

    def check_vault(self, ctx: "ValidationContext") -> list[Issue]:
        known = _build_note_id_set(ctx.notes)
        attachments = build_attachment_index(ctx.vault_path)
        issues: list[Issue] = []
        for note in ctx.notes:
            for target in extract_wikilinks(note.body):
                resolved = _strip_anchor(target)
                if not resolved:
                    continue
                if resolved in known or resolved in attachments:
                    continue
                issues.append(
                    Issue(
                        code=self.code,
                        severity=self.severity,
                        note_id=note.id,
                        message=f"wikilink target missing: {target!r}",
                    )
                )
        return issues

"""Frontmatter convention rules.

Mirrors 1차's P001 ("required field missing") but reads through the
active ``Mapping`` so vault-specific frontmatter key naming is absorbed:
the rule does not know whether the vault uses ``type`` or ``kind``, only
that the mapped key must exist and be non-empty.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar

from ipa_cli.api.base_rules import BaseConventionRule, Issue, Severity

if TYPE_CHECKING:
    from ipa_cli.api.context import ValidationContext
    from ipa_cli.parse.note_model import Note


# Semantic field names whose absence we flag. Each maps to a real
# frontmatter key via the active Mapping at check time.
REQUIRED_SEMANTIC_FIELDS: tuple[str, ...] = (
    "note_type",
    "created_at",
    "updated_at",
)


class FrontmatterRequiredFieldsRule(BaseConventionRule):
    """Flag notes missing required semantic frontmatter fields."""

    code: ClassVar[str] = "ipa.frontmatter.required_field"
    severity: ClassVar[Severity] = Severity.WARN

    def check(self, ctx: "ValidationContext", note: "Note") -> list[Issue]:
        issues: list[Issue] = []
        for sem_field in REQUIRED_SEMANTIC_FIELDS:
            key = getattr(ctx.mapping, sem_field, None)
            if not key:
                continue
            value = note.frontmatter.get(key)
            if value is None or (isinstance(value, str) and not value.strip()):
                issues.append(
                    Issue(
                        code=self.code,
                        severity=self.severity,
                        note_id=note.id,
                        message=(
                            f"missing required frontmatter field "
                            f"{sem_field!r} (mapped to key {key!r})"
                        ),
                    )
                )
        return issues

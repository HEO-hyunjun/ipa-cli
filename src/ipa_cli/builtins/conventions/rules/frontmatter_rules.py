"""Frontmatter convention rules.

Each rule reads through the active ``Mapping`` so vault-specific
frontmatter key naming is absorbed: rules don't know whether the vault
uses ``type`` or ``kind``, only that the mapped key carries the IPA
semantic concept.

Rules ported from 1차 vault_validator:
- P001 → ``FrontmatterRequiredFieldsRule``
- P002 → ``DateFormatRule``
- P003 → ``InvalidTypeRule``
- P004 → ``MissingRefRule``
"""

from __future__ import annotations

import re
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

# Allowed values for the ``note_type`` semantic field. These are part of
# IPA's conceptual model (root / index / note triad) and so are not
# Mapping-configurable.
VALID_NOTE_TYPES: frozenset[str] = frozenset({"note", "index", "root"})


class FrontmatterRequiredFieldsRule(BaseConventionRule):
    """Flag notes missing required semantic frontmatter fields.

    Mirrors 1차 P001.
    """

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


class InvalidTypeRule(BaseConventionRule):
    """Flag notes whose ``note_type`` is not one of {note, index, root}.

    Mirrors 1차 P003. Empty / missing types are P001's responsibility.
    """

    code: ClassVar[str] = "ipa.frontmatter.invalid_type"
    severity: ClassVar[Severity] = Severity.ERROR

    def check(self, ctx: "ValidationContext", note: "Note") -> list[Issue]:
        nt = note.note_type(ctx.mapping)
        if nt is None or nt == "":
            return []
        if nt not in VALID_NOTE_TYPES:
            return [
                Issue(
                    code=self.code,
                    severity=self.severity,
                    note_id=note.id,
                    message=(
                        f"invalid note_type {nt!r} (allowed: "
                        f"{sorted(VALID_NOTE_TYPES)})"
                    ),
                )
            ]
        return []


class MissingRefRule(BaseConventionRule):
    """Flag note/index notes that have no ref link.

    Mirrors 1차 P004. Roots may legitimately have no ref.
    """

    code: ClassVar[str] = "ipa.frontmatter.missing_ref"
    severity: ClassVar[Severity] = Severity.WARN

    def check(self, ctx: "ValidationContext", note: "Note") -> list[Issue]:
        nt = note.note_type(ctx.mapping)
        if nt not in {"note", "index"}:
            return []
        if not note.refs(ctx.mapping):
            return [
                Issue(
                    code=self.code,
                    severity=self.severity,
                    note_id=note.id,
                    message=f"type={nt} note has no ref link",
                )
            ]
        return []


# Semantic fields whose values are date-like and subject to P002. We
# intentionally only check these two — ``aliases`` / ``tags`` aren't
# dates and ``note_type`` is enum-checked by P003.
_DATE_SEMANTIC_FIELDS: tuple[str, ...] = ("created_at", "updated_at")


class DateFormatRule(BaseConventionRule):
    """Flag created_at / updated_at values that don't match ``mapping.date_pattern``.

    Mirrors 1차 P002. Opt-in: when ``mapping.date_pattern`` is ``None``
    the rule is a no-op so vaults without a fixed date convention don't
    drown in warnings. Empty / missing values are P001's responsibility.
    """

    code: ClassVar[str] = "ipa.frontmatter.date_format"
    severity: ClassVar[Severity] = Severity.WARN

    def check(self, ctx: "ValidationContext", note: "Note") -> list[Issue]:
        pattern = ctx.mapping.date_pattern
        if not pattern:
            return []
        try:
            compiled = re.compile(pattern)
        except re.error:
            return []

        issues: list[Issue] = []
        for sem_field in _DATE_SEMANTIC_FIELDS:
            key = getattr(ctx.mapping, sem_field, None)
            if not key:
                continue
            value = note.frontmatter.get(key)
            if value is None:
                continue
            text = str(value).strip()
            if not text:
                continue
            if not compiled.match(text):
                issues.append(
                    Issue(
                        code=self.code,
                        severity=self.severity,
                        note_id=note.id,
                        message=(
                            f"{sem_field} (key {key!r}) value {text!r} "
                            f"does not match pattern {pattern!r}"
                        ),
                    )
                )
        return issues

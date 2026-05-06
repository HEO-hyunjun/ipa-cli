"""Title convention rules.

The IPA convention encodes a note's role in its filename:

- root: starts with ``🏷️``, ends with ``Root``
- index: starts with ``🔖``
- note: no required prefix

These rules are the runtime equivalent of 1차 T001/T002/T003 and read
the note's type via the active ``Mapping``. The check is on
``note.id`` (which is the NFC-normalized stem from ``vault_loader``).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar

from ipa_cli.api.base_rules import BaseConventionRule, Issue, Severity

if TYPE_CHECKING:
    from ipa_cli.api.context import ValidationContext
    from ipa_cli.parse.note_model import Note


ROOT_PREFIX = "🏷️"
ROOT_SUFFIX = "Root"
INDEX_PREFIX = "🔖"


class RootTitlePrefixRule(BaseConventionRule):
    """Mirrors 1차 T001."""

    code: ClassVar[str] = "ipa.title.root_prefix_missing"
    severity: ClassVar[Severity] = Severity.WARN

    def check(self, ctx: "ValidationContext", note: "Note") -> list[Issue]:
        if note.note_type(ctx.mapping) != "root":
            return []
        if not note.id.startswith(ROOT_PREFIX):
            return [
                Issue(
                    code=self.code,
                    severity=self.severity,
                    note_id=note.id,
                    message=(f"root note name must start with {ROOT_PREFIX!r}"),
                )
            ]
        return []


class RootTitleSuffixRule(BaseConventionRule):
    """Mirrors 1차 T002."""

    code: ClassVar[str] = "ipa.title.root_suffix_missing"
    severity: ClassVar[Severity] = Severity.WARN

    def check(self, ctx: "ValidationContext", note: "Note") -> list[Issue]:
        if note.note_type(ctx.mapping) != "root":
            return []
        if not note.id.endswith(ROOT_SUFFIX):
            return [
                Issue(
                    code=self.code,
                    severity=self.severity,
                    note_id=note.id,
                    message=f"root note name must end with {ROOT_SUFFIX!r}",
                )
            ]
        return []


class IndexTitlePrefixRule(BaseConventionRule):
    """Mirrors 1차 T003."""

    code: ClassVar[str] = "ipa.title.index_prefix_missing"
    severity: ClassVar[Severity] = Severity.WARN

    def check(self, ctx: "ValidationContext", note: "Note") -> list[Issue]:
        if note.note_type(ctx.mapping) != "index":
            return []
        if not note.id.startswith(INDEX_PREFIX):
            return [
                Issue(
                    code=self.code,
                    severity=self.severity,
                    note_id=note.id,
                    message=(f"index note name must start with {INDEX_PREFIX!r}"),
                )
            ]
        return []

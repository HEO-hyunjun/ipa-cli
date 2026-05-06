"""Base class and data types for convention rules.

A rule is a single class that detects (`check`) and optionally fixes (`fix`)
one kind of issue in vault notes. There is no separate formatter class — the
rule that defines an issue is the one that knows how to fix it.

Scope opt-in: a rule declares ``default_scope`` to indicate the broadest
unit it expects to be invoked at. CLI scope must reach that level for the
rule to run. Wider scope rules never run silently under narrow scope
commands.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, ClassVar, Literal

if TYPE_CHECKING:
    from ipa_cli.api.context import FormatContext, ValidationContext
    from ipa_cli.parse.note_model import Note

NoteId = str

Scope = Literal["note", "folder", "vault"]


class Severity(StrEnum):
    INFO = "info"
    WARN = "warn"
    ERROR = "error"


@dataclass(frozen=True)
class Span:
    """File range. line/column 1-indexed, end exclusive."""

    start_line: int
    start_col: int
    end_line: int
    end_col: int


@dataclass(frozen=True)
class Issue:
    code: str
    severity: Severity
    note_id: NoteId
    message: str
    span: Span | None = None


@dataclass(frozen=True)
class Patch:
    """Replace the content of ``span`` with ``replacement``."""

    note_id: NoteId
    span: Span
    replacement: str


class BaseConventionRule:
    """A single rule that detects and optionally fixes one issue type.

    Subclasses MUST set ``code`` and ``severity`` ClassVars. They override
    one of ``check`` / ``check_folder`` / ``check_vault`` (matching their
    declared ``default_scope``) and optionally ``fix``.
    """

    code: ClassVar[str]
    severity: ClassVar[Severity]
    requires_parse_level: ClassVar[int] = 1
    default_scope: ClassVar[Scope] = "note"

    def check(self, ctx: "ValidationContext", note: "Note") -> list[Issue]:
        """Per-note check. Required for rules with default_scope='note'."""
        return []

    def check_folder(self, ctx: "ValidationContext") -> list[Issue]:
        """Cross-note check within a folder. Override for default_scope='folder'."""
        return []

    def check_vault(self, ctx: "ValidationContext") -> list[Issue]:
        """Cross-note check across the whole vault. Override for default_scope='vault'."""
        return []

    def fix(self, ctx: "FormatContext", issue: Issue) -> list[Patch] | None:
        """Optional autofix. Return None when the rule cannot or does not fix."""
        return None

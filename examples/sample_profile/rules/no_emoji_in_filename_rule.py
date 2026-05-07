"""Sample custom rule — flag notes whose filename starts with an emoji.

This is a per-note rule (default_scope='note'). It demonstrates:
- declaring ``code`` and ``severity`` as ClassVars
- reading the note id (which is the NFC-normalized filename stem)
- producing an ``Issue`` with no ``span`` (whole-note level diagnostic)

Real IPA index notes (``🔖 Topic``) and root notes (``🏷️ Domain``) start
with emojis on purpose, so the rule excludes those by inspecting the
note's ``type`` frontmatter via the active ``Mapping``. Anything else
that starts with an emoji is flagged.
"""

from __future__ import annotations

import unicodedata
from typing import TYPE_CHECKING, ClassVar

from ipa_cli.api.base_rules import BaseConventionRule, Issue, Severity

if TYPE_CHECKING:
    from ipa_cli.api.context import ValidationContext
    from ipa_cli.parse.note_model import Note


def _starts_with_emoji(text: str) -> bool:
    if not text:
        return False
    first = text[0]
    return unicodedata.category(first).startswith("So") or first in {"🔖", "🏷"}


class NoEmojiInFilenameRule(BaseConventionRule):
    code: ClassVar[str] = "sample.no_emoji_in_filename"
    severity: ClassVar[Severity] = Severity.INFO
    default_scope: ClassVar[str] = "note"

    def check(self, ctx: "ValidationContext", note: "Note") -> list[Issue]:
        # Index/root notes legitimately start with emoji prefixes.
        ntype = note.note_type(ctx.mapping)
        if ntype in {"index", "root"}:
            return []
        if not _starts_with_emoji(note.id):
            return []
        return [
            Issue(
                code=self.code,
                severity=self.severity,
                note_id=note.id,
                message="filename starts with an emoji — only index/root notes should",
            )
        ]

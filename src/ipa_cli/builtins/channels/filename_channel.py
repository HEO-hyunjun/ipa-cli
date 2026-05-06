"""Filename channel — high-confidence note id matching.

Covers steps 1~4 of 1차 ``fuzzy_find_note``: exact, case-insensitive,
substring, and no-space matching against ``note.id``. All matches score
1.0 — graded fuzzy (jamo trigram overlap, SequenceMatcher fallback)
arrives in P4 iter3 once BM25 / jamo helpers are ported.

Aliases (when the active mapping exposes them) are evaluated alongside
the id so plugin authors can rebind the alias semantic without
rewriting this channel.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, ClassVar

from ipa_cli.api.base_channels import BaseSearchChannel

if TYPE_CHECKING:
    from ipa_cli.api.base_channels import Query, SetupContext

# Strip the IPA emoji prefixes ('🏷️', '🔖') so 'ipa-cli' matches '🔖 ipa-cli'.
_EMOJI_PREFIX_RE = re.compile(r"^(?:🏷️?|🔖)\s*")


def _normalize(name: str) -> str:
    return _EMOJI_PREFIX_RE.sub("", name).lower()


class FilenameMatchChannel(BaseSearchChannel):
    name: ClassVar[str] = "filename"
    description: ClassVar[str] = (
        "Exact / case-insensitive / substring / no-space match on note.id"
    )
    default_weight: ClassVar[float] = 0.2

    def search(self, ctx: "SetupContext", query: "Query") -> dict[str, float]:
        q = query.raw
        if not q:
            return {}
        ql = q.lower()
        qns = ql.replace(" ", "")
        scores: dict[str, float] = {}
        for note in ctx.notes:
            nid = note.id
            nl = nid.lower()
            stripped = _normalize(nid)
            if (
                nid == q
                or nl == ql
                or ql in nl
                or ql in stripped
                or (qns and qns in nl.replace(" ", ""))
            ):
                scores[nid] = 1.0
        return scores

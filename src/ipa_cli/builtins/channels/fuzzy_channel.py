"""Fuzzy channel — graded jamo trigram overlap + SequenceMatcher fallback.

Picks up where ``FilenameMatchChannel`` leaves off. The filename
channel handles steps 1~4 of 1차 ``fuzzy_find_note`` (exact /
case-insensitive / substring / no-space — all 1.0). This channel
covers step 5 (graded jamo trigram overlap, ≥0.4 → score) and step 6
(SequenceMatcher fallback, ≥0.55 → score) so the two channels combine
without double-scoring exact matches.

Aliases participate alongside ``note.id`` via ``mapping.aliases``: the
best score across (id, alias_1, alias_2, …) wins per note.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import TYPE_CHECKING, ClassVar

from ipa_cli.api.base_channels import BaseSearchChannel
from ipa_cli.parse.bm25 import jamo_trigrams

if TYPE_CHECKING:
    from ipa_cli.api.base_channels import Query, SetupContext

_EMOJI_PREFIX_RE = re.compile(r"^(?:🏷️?|🔖)\s*")
JAMO_THRESHOLD = 0.4
FALLBACK_THRESHOLD = 0.55


def _strip_emoji(name: str) -> str:
    return _EMOJI_PREFIX_RE.sub("", name)


def _is_exact_grade(name: str, q: str, q_lower: str, q_nospace: str) -> bool:
    """Step 1~4 of 1차 fuzzy_find_note — owned by FilenameMatchChannel."""
    if name == q:
        return True
    nl = name.lower()
    if nl == q_lower:
        return True
    if q_lower in nl:
        return True
    s = _strip_emoji(name)
    if s != name and q_lower in s.lower():
        return True
    if q_nospace and q_nospace in nl.replace(" ", ""):
        return True
    return False


class FuzzyChannel(BaseSearchChannel):
    name: ClassVar[str] = "fuzzy"
    description: ClassVar[str] = (
        "Graded jamo trigram overlap (>=0.4) + SequenceMatcher fallback "
        "(>=0.55) on note.id and aliases"
    )
    default_weight: ClassVar[float] = 0.268

    def search(self, ctx: "SetupContext", query: "Query") -> dict[str, float]:
        q = query.raw
        if not q:
            return {}
        q_lower = q.lower()
        q_nospace = q_lower.replace(" ", "")
        q_tri = set(jamo_trigrams(q))

        scores: dict[str, float] = {}
        fallback: dict[str, float] = {}
        mapping = ctx.mapping

        for note in ctx.notes:
            names = [note.id, *note.aliases(mapping)]

            # Skip names FilenameMatchChannel already counts as 1.0.
            if any(_is_exact_grade(n, q, q_lower, q_nospace) for n in names):
                continue

            if q_tri:
                best = 0.0
                for n in names:
                    f_tri = set(jamo_trigrams(_strip_emoji(n)))
                    if not f_tri:
                        continue
                    overlap = len(q_tri & f_tri) / len(q_tri)
                    if overlap > best:
                        best = overlap
                if best >= JAMO_THRESHOLD:
                    scores[note.id] = best
                    continue

            # Latin-only / pure ascii queries can't form trigrams (NFD
            # only changes Korean), so they fall through to a
            # SequenceMatcher pass.
            if not q_tri:
                ratio = 0.0
                for n in names:
                    r = SequenceMatcher(None, q_lower, n.lower()).ratio()
                    s = _strip_emoji(n)
                    if s != n:
                        r = max(r, SequenceMatcher(None, q_lower, s.lower()).ratio())
                    if r > ratio:
                        ratio = r
                if ratio >= FALLBACK_THRESHOLD:
                    fallback[note.id] = ratio

        return scores if scores else fallback

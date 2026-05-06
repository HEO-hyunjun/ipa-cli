"""Filename-partial channel — fractional token match on note.id.

Mirrors 1차 ``search_by_filename_partial``. Where
``SequenceMatchChannel`` is binary (all-or-nothing), this channel
softens the cliff: if 1 of 2 query tokens lands in the note id, score
is 0.5. The signal smooths the hard boundary between fuzzy hits and
no hits at all.

Single-token queries are skipped — they degenerate into substring
matching, which ``FilenameMatchChannel`` already covers.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar

from ipa_cli.api.base_channels import BaseSearchChannel
from ipa_cli.builtins.channels.sequence_channel import _normalize_id, _tokenize

if TYPE_CHECKING:
    from ipa_cli.api.base_channels import Query, SetupContext


class FilenamePartialChannel(BaseSearchChannel):
    name: ClassVar[str] = "filename_partial"
    description: ClassVar[str] = (
        "Partial token match on normalized note.id, score = matched / total"
    )
    default_weight: ClassVar[float] = 0.150

    def search(self, ctx: "SetupContext", query: "Query") -> dict[str, float]:
        tokens = _tokenize(query.raw)
        if len(tokens) < 2:
            return {}
        total = len(tokens)
        scores: dict[str, float] = {}
        for note in ctx.notes:
            normalized = _normalize_id(note.id)
            matched = sum(1 for t in tokens if t in normalized)
            if 0 < matched < total:
                scores[note.id] = matched / total
        return scores

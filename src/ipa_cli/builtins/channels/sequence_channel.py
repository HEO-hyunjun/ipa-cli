"""Sequence-match channel — all query tokens land in note.id.

Mirrors 1차 ``search_by_sequence``. Complements ``FilenameMatchChannel``
which treats the query as a single substring: a query like
``"agent rag"`` doesn't substring-hit ``"RAG Agent Notes"``, but the
two tokens individually appear, so this channel registers a 1.0 hit.

The id is normalized: emoji prefix stripped, non-word characters
collapsed to single spaces, lowercased. Token-1 queries are skipped —
they're equivalent to ``FilenameMatchChannel``'s substring case.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, ClassVar

from ipa_cli.api.base_channels import BaseSearchChannel
from ipa_cli.builtins.channels.weights import DEFAULT_CHANNEL_WEIGHTS

if TYPE_CHECKING:
    from ipa_cli.api.base_channels import Query, SetupContext

_EMOJI_PREFIX_RE = re.compile(r"^(?:🏷️?|🔖)\s*")
_NON_WORD_RE = re.compile(r"[^\w가-힣]+", re.UNICODE)


def _normalize_id(name: str) -> str:
    stripped = _EMOJI_PREFIX_RE.sub("", name)
    return _NON_WORD_RE.sub(" ", stripped).lower()


def _tokenize(query: str) -> list[str]:
    return [t for t in query.lower().split() if t]


class SequenceMatchChannel(BaseSearchChannel):
    name: ClassVar[str] = "sequence_match"
    description: ClassVar[str] = (
        "All query tokens appear in normalized note.id or aliases, score 1.0"
    )
    default_weight: ClassVar[float] = DEFAULT_CHANNEL_WEIGHTS[name]

    def search(self, ctx: "SetupContext", query: "Query") -> dict[str, float]:
        tokens = _tokenize(query.raw)
        if not tokens:
            return {}
        scores: dict[str, float] = {}
        for note in ctx.notes:
            names = [note.id, *note.aliases(ctx.mapping)]
            if any(all(t in _normalize_id(name) for t in tokens) for name in names):
                scores[note.id] = 1.0
        return scores

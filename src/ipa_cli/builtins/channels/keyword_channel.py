"""Keyword channel — token AND match against note id and body.

Mirrors 1차 ``search_by_keyword_scored``. The score is the ratio of
query tokens that appear anywhere in (note id + body) lowercased. A note
with no matched tokens does not appear in the channel output.

The channel intentionally avoids any setup work — tokenization is per
query and per note. P5 will move tokenization into ``SetupContext.tokens``
once the parse layer materializes that artifact.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar

from ipa_cli.api.base_channels import BaseSearchChannel
from ipa_cli.builtins.channels.weights import DEFAULT_CHANNEL_WEIGHTS

if TYPE_CHECKING:
    from ipa_cli.api.base_channels import Query, SetupContext


def _tokenize(text: str) -> list[str]:
    return [t for t in text.lower().split() if t]


class KeywordChannel(BaseSearchChannel):
    name: ClassVar[str] = "keyword"
    description: ClassVar[str] = (
        "Token AND match against note id + aliases + body, score = matched/total tokens"
    )
    default_weight: ClassVar[float] = DEFAULT_CHANNEL_WEIGHTS[name]

    def search(self, ctx: "SetupContext", query: "Query") -> dict[str, float]:
        tokens = _tokenize(query.raw)
        if not tokens:
            return {}
        scores: dict[str, float] = {}
        for note in ctx.notes:
            haystack = " ".join(
                [note.id, *note.aliases(ctx.mapping), note.body]
            ).lower()
            matched = sum(1 for t in tokens if t in haystack)
            if matched > 0:
                scores[note.id] = matched / len(tokens)
        return scores

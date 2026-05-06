"""Body-match channel — BM25-trigram scoring on note bodies.

Mirrors 1차's ``body_match`` channel. The query is tokenized with the
same ``jamo_trigrams`` used to build the corpus, fed through
``BM25Index.score_all``, and the resulting raw scores are max-normalized
into [0, 1] so the channel composes cleanly with weight-1 channels.

The artifact lives on ``SetupContext.bm25_artifact`` (cached_property)
so this channel and ``ChildBodyMatchChannel`` share one build.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar

from ipa_cli.api.base_channels import BaseSearchChannel
from ipa_cli.parse.bm25 import jamo_trigrams

if TYPE_CHECKING:
    from ipa_cli.api.base_channels import Query, SetupContext


class BodyMatchChannel(BaseSearchChannel):
    name: ClassVar[str] = "body_match"
    description: ClassVar[str] = (
        "BM25 over jamo trigrams of (note.id + body), max-normalized to [0,1]"
    )
    default_weight: ClassVar[float] = 0.363

    def search(self, ctx: "SetupContext", query: "Query") -> dict[str, float]:
        q_tokens = jamo_trigrams(query.raw)
        if not q_tokens:
            return {}
        artifact = ctx.bm25_artifact
        idx = artifact.index
        if idx.n_docs == 0:
            return {}
        raw_scores = idx.score_all(q_tokens)
        max_raw = max(raw_scores, default=0.0)
        if max_raw <= 0.0:
            return {}
        out: dict[str, float] = {}
        for doc_idx, raw in enumerate(raw_scores):
            if raw <= 0.0:
                continue
            doc_id = idx.doc_ids[doc_idx]
            out[doc_id] = raw / max_raw
        return out

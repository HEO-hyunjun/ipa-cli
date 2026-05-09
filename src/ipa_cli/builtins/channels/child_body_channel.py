"""Child-body channel — propagate BM25 score from children to index/root.

Mirrors 1차's ``child_body_match``. An index/root note often has a near
empty body (it's a hub), so its own BM25 score under-represents its
relevance. This channel solves that by letting any child's body match
flow up to the parent: the parent's score is the max raw BM25 score
across notes that ref it.

Vault-aware: type identification and ref extraction both go through the
active ``Mapping`` so vaults using non-standard frontmatter keys still
get the propagation. ``parse.links.extract_ref_targets`` strips the
``[[...]]`` wrapper on each ref entry.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar

from ipa_cli.api.base_channels import BaseSearchChannel
from ipa_cli.builtins.channels.weights import DEFAULT_CHANNEL_WEIGHTS
from ipa_cli.parse.bm25 import jamo_trigrams
from ipa_cli.parse.links import extract_ref_targets

if TYPE_CHECKING:
    from ipa_cli.api.base_channels import Query, SetupContext


_INDEX_TYPES: frozenset[str] = frozenset({"index", "root"})


class ChildBodyMatchChannel(BaseSearchChannel):
    name: ClassVar[str] = "child_body_match"
    description: ClassVar[str] = (
        "Index/root inherits the max raw BM25 score across notes that ref it"
    )
    default_weight: ClassVar[float] = DEFAULT_CHANNEL_WEIGHTS[name]

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

        mapping = ctx.mapping
        notes_by_id = {n.id: n for n in ctx.notes}
        index_ids = {n.id for n in ctx.notes if n.note_type(mapping) in _INDEX_TYPES}
        if not index_ids:
            return {}

        # For each non-index child, find which of its refs are indexes
        # and accumulate the max raw score per index.
        index_max: dict[str, float] = {}
        for child in ctx.notes:
            if child.id in index_ids:
                continue
            child_idx = artifact.doc_id_to_idx.get(child.id)
            if child_idx is None:
                continue
            raw = raw_scores[child_idx]
            if raw <= 0.0:
                continue
            for target in extract_ref_targets(child.refs(mapping)):
                if target in index_ids and raw > index_max.get(target, 0.0):
                    index_max[target] = raw

        out: dict[str, float] = {}
        for parent_id, raw in index_max.items():
            if parent_id not in notes_by_id:
                continue
            out[parent_id] = raw / max_raw
        return out

"""Related channel — graph-neighbor expansion from filename seeds.

1차 ``find_related`` was wired into ``unified_search`` and read top-K
candidates from prior channels. Channels in 2차 don't see each other's
output, so this channel re-derives its seeds: any note whose id
exact-grade matches the query (the same matching FilenameMatchChannel
uses) is treated as a seed, and its graph neighbors get raw points.

Scoring per seed (matches 1차 ``find_related``):

- common ref targets: +3
- shared tags (per tag): +1
- wikilink edge (seed→neighbor or neighbor→seed): +2

Raw scores are max-normalized to [0, 1] so the channel composes
cleanly. The "same Root" branch from 1차 is not yet ported — root
discovery requires a graph walk that's better placed in
``SetupContext.ref_graph`` (P5).
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, ClassVar

from ipa_cli.api.base_channels import BaseSearchChannel
from ipa_cli.parse.links import extract_ref_targets, extract_wikilinks

if TYPE_CHECKING:
    from ipa_cli.api.base_channels import Query, SetupContext
    from ipa_cli.parse.note_model import Note

_EMOJI_PREFIX_RE = re.compile(r"^(?:🏷️?|🔖)\s*")


def _strip_emoji(name: str) -> str:
    return _EMOJI_PREFIX_RE.sub("", name)


def _is_seed(note_id: str, q: str) -> bool:
    if not q:
        return False
    if note_id == q:
        return True
    nl = note_id.lower()
    ql = q.lower()
    if nl == ql or ql in nl:
        return True
    s = _strip_emoji(note_id).lower()
    if ql in s:
        return True
    qns = ql.replace(" ", "")
    if qns and qns in nl.replace(" ", ""):
        return True
    return False


def _related_raw(seed: "Note", other: "Note", mapping) -> float:
    points = 0.0
    seed_refs = set(extract_ref_targets(seed.refs(mapping)))
    other_refs = set(extract_ref_targets(other.refs(mapping)))
    if seed_refs & other_refs:
        points += 3.0

    seed_tags = set(seed.tags(mapping))
    other_tags = set(other.tags(mapping))
    common_tags = seed_tags & other_tags
    points += float(len(common_tags))

    seed_wls = set(extract_wikilinks(seed.body))
    other_wls = set(extract_wikilinks(other.body))
    if other.id in seed_wls or seed.id in other_wls:
        points += 2.0

    return points


class RelatedChannel(BaseSearchChannel):
    name: ClassVar[str] = "related"
    description: ClassVar[str] = (
        "Graph-neighbor expansion (common refs / tags / wikilink edges) "
        "from filename-matched seeds, max-normalized"
    )
    default_weight: ClassVar[float] = 0.032

    def search(self, ctx: "SetupContext", query: "Query") -> dict[str, float]:
        q = query.raw
        if not q:
            return {}
        seeds = [n for n in ctx.notes if _is_seed(n.id, q)]
        if not seeds:
            return {}

        mapping = ctx.mapping
        seed_ids = {s.id for s in seeds}

        raw: dict[str, float] = {}
        for seed in seeds:
            for other in ctx.notes:
                if other.id in seed_ids:
                    continue
                pts = _related_raw(seed, other, mapping)
                if pts > raw.get(other.id, 0.0):
                    raw[other.id] = pts

        if not raw:
            return {}
        max_raw = max(raw.values())
        if max_raw <= 0.0:
            return {}
        return {nid: pts / max_raw for nid, pts in raw.items()}

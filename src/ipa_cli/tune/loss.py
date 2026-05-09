"""Loss + per-case evaluation built on the ``SearchEngine``.

Engine-based tune trials must reuse a single ``SearchEngine`` instance —
the engine's ``setup()`` runs once before the trial loop and each trial
only varies ``weights`` / ``threshold`` / ``cap``.

Multi-query handling: a case with ``queries=[q1, q2]`` runs
``engine.search(qN, weights)`` for each query and sums per-note scores.
Threshold and cap apply to the summed list (cap enforced after the
threshold cut). The penalty model:

    loss = regression_miss × REGRESSION_MISS_PENALTY
         + scenario_miss × SCENARIO_MISS_PENALTY
         + avg_rank

Target matching: testsets reference notes by filename
(``target_filename`` / ``target_filenames``). ``Note.id`` is the
NFC-normalized stem, which matches what testsets ship.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ipa_cli.api.base_channels import Query

from .eval_set import topn_for_mode

if TYPE_CHECKING:
    from ipa_cli.runtime.search_engine import SearchEngine

QueryScoreCache = dict[str, dict[str, dict[str, float]]]

REGRESSION_MISS_PENALTY = 100
SCENARIO_MISS_PENALTY = 50


@dataclass(frozen=True)
class Metrics:
    reg_hit: int
    reg_miss: int
    scn_hit: int
    scn_miss: int
    avg_rank: float


@dataclass(frozen=True)
class _Ranked:
    """Internal: ``(note_id, score)`` after threshold + cap pruning."""

    note_id: str
    score: float


def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def _multi_search(
    engine: "SearchEngine",
    queries: list[str],
    weights: dict[str, float] | None,
    threshold: float,
    cap: int,
    query_score_cache: QueryScoreCache | None = None,
) -> list[_Ranked]:
    """Sum per-query Hit scores → threshold filter → cap.

    ``weights`` can omit channels (they fall back to ``default_weight``).
    Ordering after threshold is by descending summed score.
    """
    combined: dict[str, float] = {}
    for q in queries:
        if not q:
            continue
        if query_score_cache is not None and q in query_score_cache:
            _accumulate_channel_scores(
                engine, query_score_cache[q], weights, combined
            )
        else:
            hits = engine.search(Query(raw=q), weights=weights)
            for h in hits:
                combined[h.note_id] = combined.get(h.note_id, 0.0) + h.score
    ranked = [
        _Ranked(note_id=nid, score=s) for nid, s in combined.items() if s >= threshold
    ]
    ranked.sort(key=lambda r: r.score, reverse=True)
    return ranked[:cap]


def _accumulate_channel_scores(
    engine: "SearchEngine",
    channel_scores: dict[str, dict[str, float]],
    weights: dict[str, float] | None,
    combined: dict[str, float],
) -> None:
    """Apply trial weights to cached raw channel scores."""
    weight_map = dict(weights or {})
    channels_by_name = {channel.name: channel for channel in engine.channels}
    for channel_name, scores in channel_scores.items():
        channel = channels_by_name.get(channel_name)
        if channel is None:
            continue
        weight = weight_map.get(channel_name, channel.default_weight)
        if weight == 0:
            continue
        for note_id, raw in scores.items():
            combined[note_id] = combined.get(note_id, 0.0) + raw * weight


def build_query_score_cache(
    engine: "SearchEngine",
    regression_cases: list[dict[str, Any]],
    scenario_cases: list[dict[str, Any]],
) -> QueryScoreCache:
    """Precompute raw per-channel scores once per unique testset query."""
    engine.setup()
    seen: set[str] = set()
    queries: list[str] = []
    for case in [*regression_cases, *scenario_cases]:
        for raw in case.get("queries") or []:
            if raw and raw not in seen:
                seen.add(raw)
                queries.append(raw)
    return {raw: engine.score_channels(Query(raw=raw)) for raw in queries}


def evaluate_regression(
    case: dict[str, Any],
    engine: "SearchEngine",
    weights: dict[str, float] | None,
    threshold: float,
    cap: int,
    query_score_cache: QueryScoreCache | None = None,
) -> tuple[bool, int | None]:
    """Return ``(hit, rank)`` for a regression case via ``engine.search``."""
    target = nfc(str(case["target_filename"]))
    ranked = _multi_search(
        engine, case["queries"], weights, threshold, cap, query_score_cache
    )
    for i, r in enumerate(ranked, 1):
        if nfc(r.note_id) == target:
            return True, i
    return False, None


def evaluate_scenario(
    case: dict[str, Any],
    engine: "SearchEngine",
    weights: dict[str, float] | None,
    threshold: float,
    cap: int,
    query_score_cache: QueryScoreCache | None = None,
) -> tuple[bool, int | None]:
    """Return ``(hit, best_rank)`` for a scenario case.

    Hit rule: at least ``recall_threshold`` of the case's targets show
    up within the top-N (where N = ``topn_for_mode(recall_mode)``) of
    the threshold/cap-pruned list. ``best_rank`` is the lowest rank
    among matched targets.
    """
    queries = case.get("queries") or []
    if not queries:
        return False, None
    n_top = topn_for_mode(case.get("recall_mode", "top10"))
    ranked = _multi_search(
        engine, queries, weights, threshold, cap, query_score_cache
    )[:n_top]
    topn_ids = [nfc(r.note_id) for r in ranked]

    raw_targets = case.get("target_filenames") or [case.get("target_filename")]
    targets = [nfc(str(t)) for t in raw_targets if t]
    recall_threshold = int(case.get("recall_threshold", 1))

    matched = [t for t in targets if t in topn_ids]
    if len(matched) < recall_threshold:
        return False, None
    best_rank = min(topn_ids.index(t) + 1 for t in matched)
    return True, best_rank


def compute_loss(
    engine: "SearchEngine",
    regression_cases: list[dict[str, Any]],
    scenario_cases: list[dict[str, Any]],
    weights: dict[str, float] | None,
    threshold: float,
    cap: int,
    query_score_cache: QueryScoreCache | None = None,
) -> tuple[float, Metrics]:
    """Engine-based total loss + ``Metrics``. Engine must be ``setup()``-ed."""
    reg_miss = 0
    scn_miss = 0
    ranks: list[int] = []
    for c in regression_cases:
        hit, rank = evaluate_regression(
            c, engine, weights, threshold, cap, query_score_cache
        )
        if hit and rank is not None:
            ranks.append(rank)
        else:
            reg_miss += 1
    for c in scenario_cases:
        hit, rank = evaluate_scenario(
            c, engine, weights, threshold, cap, query_score_cache
        )
        if hit and rank is not None:
            ranks.append(rank)
        else:
            scn_miss += 1

    avg_rank = sum(ranks) / len(ranks) if ranks else 99.0
    loss = (
        reg_miss * REGRESSION_MISS_PENALTY + scn_miss * SCENARIO_MISS_PENALTY + avg_rank
    )
    return loss, Metrics(
        reg_hit=len(regression_cases) - reg_miss,
        reg_miss=reg_miss,
        scn_hit=len(scenario_cases) - scn_miss,
        scn_miss=scn_miss,
        avg_rank=avg_rank,
    )

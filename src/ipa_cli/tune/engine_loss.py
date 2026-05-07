"""Loss + per-case evaluation built on the 2차 ``SearchEngine``.

This is the G7 counterpart to the legacy ``loss.py`` (which leans on
1차 ``vault_search.multi_search`` + module globals). Engine-based tune
trials must reuse a single ``SearchEngine`` instance — the engine's
``setup()`` runs once before the trial loop, and each trial only
varies ``weights`` / ``threshold`` / ``cap``.

Multi-query handling: 1차 ``multi_search`` summed scores across queries.
We mirror that behavior so loss curves remain comparable: for a case
with ``queries=[q1, q2]`` we run ``engine.search(qN, weights)`` for
each query, then sum per-note-id scores. Threshold and cap apply to
the summed list (cap is enforced after threshold cut, like 1차).

Target matching: testsets reference notes by filename (``target_filename``
/ ``target_filenames``). 2차 ``Note.id`` is the NFC-normalized stem of
the markdown file, which equals 1차 ``Note.filename`` for the IPA vault
shape. Cases written for 1차 should keep working without rewrites.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ipa_cli.api.base_channels import Query

from .eval_set import topn_for_mode
from .loss import REGRESSION_MISS_PENALTY, SCENARIO_MISS_PENALTY, Metrics

if TYPE_CHECKING:
    from ipa_cli.runtime.search_engine import SearchEngine


@dataclass(frozen=True)
class _Ranked:
    """Internal: ``(note_id, score)`` after threshold + cap pruning."""

    note_id: str
    score: float


def _nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def _multi_search(
    engine: "SearchEngine",
    queries: list[str],
    weights: dict[str, float] | None,
    threshold: float,
    cap: int,
) -> list[_Ranked]:
    """Sum per-query Hit scores → threshold filter → cap.

    ``weights`` can omit channels (they fall back to ``default_weight``).
    Ordering after threshold is by descending summed score.
    """
    combined: dict[str, float] = {}
    for q in queries:
        if not q:
            continue
        hits = engine.search(Query(raw=q), weights=weights)
        for h in hits:
            combined[h.note_id] = combined.get(h.note_id, 0.0) + h.score
    ranked = [
        _Ranked(note_id=nid, score=s) for nid, s in combined.items() if s >= threshold
    ]
    ranked.sort(key=lambda r: r.score, reverse=True)
    return ranked[:cap]


def evaluate_regression_v2(
    case: dict[str, Any],
    engine: "SearchEngine",
    weights: dict[str, float] | None,
    threshold: float,
    cap: int,
) -> tuple[bool, int | None]:
    """Return ``(hit, rank)`` for a regression case via ``engine.search``."""
    target = _nfc(str(case["target_filename"]))
    ranked = _multi_search(engine, case["queries"], weights, threshold, cap)
    for i, r in enumerate(ranked, 1):
        if _nfc(r.note_id) == target:
            return True, i
    return False, None


def evaluate_scenario_v2(
    case: dict[str, Any],
    engine: "SearchEngine",
    weights: dict[str, float] | None,
    threshold: float,
    cap: int,
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
    ranked = _multi_search(engine, queries, weights, threshold, cap)[:n_top]
    topn_ids = [_nfc(r.note_id) for r in ranked]

    raw_targets = case.get("target_filenames") or [case.get("target_filename")]
    targets = [_nfc(str(t)) for t in raw_targets if t]
    recall_threshold = int(case.get("recall_threshold", 1))

    matched = [t for t in targets if t in topn_ids]
    if len(matched) < recall_threshold:
        return False, None
    best_rank = min(topn_ids.index(t) + 1 for t in matched)
    return True, best_rank


def compute_loss_v2(
    engine: "SearchEngine",
    regression_cases: list[dict[str, Any]],
    scenario_cases: list[dict[str, Any]],
    weights: dict[str, float] | None,
    threshold: float,
    cap: int,
) -> tuple[float, Metrics]:
    """Engine-based total loss + ``Metrics``. Engine must be ``setup()``-ed."""
    reg_miss = 0
    scn_miss = 0
    ranks: list[int] = []
    for c in regression_cases:
        hit, rank = evaluate_regression_v2(c, engine, weights, threshold, cap)
        if hit and rank is not None:
            ranks.append(rank)
        else:
            reg_miss += 1
    for c in scenario_cases:
        hit, rank = evaluate_scenario_v2(c, engine, weights, threshold, cap)
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

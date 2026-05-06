"""Loss + per-case evaluation with threshold and cap applied.

loss = regression_miss × 100 + scenario_miss × 50 + avg_rank

Threshold and cap are applied AFTER `multi_search` produces ranked
results: items with score < threshold are dropped, then the list is
truncated to `cap`. A higher threshold or smaller cap can therefore
turn a former hit into a miss, which is exactly the trade-off the
tuner has to navigate.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ipa_cli.core.vault_search import multi_search

from .eval_set import topn_for_mode

REGRESSION_MISS_PENALTY = 100
SCENARIO_MISS_PENALTY = 50


@dataclass(frozen=True)
class Metrics:
    reg_hit: int
    reg_miss: int
    scn_hit: int
    scn_miss: int
    avg_rank: float


def _filter_truncate(results, threshold: float, cap: int):
    out = []
    for n, score, reasons in results:
        if score < threshold:
            continue
        out.append((n, score, reasons))
        if len(out) >= cap:
            break
    return out


def evaluate_regression(
    case: dict[str, Any], notes, idx, threshold: float, cap: int
) -> tuple[bool, int | None]:
    """Return (hit, rank) for a regression case."""
    fetch = max(cap, 10) * 3  # over-fetch so threshold/cap can prune
    results = multi_search(case["queries"], notes, idx, max_results=fetch)
    truncated = _filter_truncate(results, threshold, cap)
    target = case["target_filename"]
    for i, (n, _, _) in enumerate(truncated, 1):
        if n.filename == target:
            return True, i
    return False, None


def evaluate_scenario(
    case: dict[str, Any], notes, idx, threshold: float, cap: int
) -> tuple[bool, int | None]:
    n_top = topn_for_mode(case.get("recall_mode", "top10"))
    queries = case["queries"]
    if not queries:
        return False, None
    fetch = max(cap, n_top, 10) * 3
    results = multi_search(queries, notes, idx, max_results=fetch)
    truncated = _filter_truncate(results, threshold, cap)[:n_top]
    topn = [n.filename for n, _, _ in truncated]

    targets = case.get("target_filenames") or [case.get("target_filename")]
    targets = [t for t in targets if t]
    recall_threshold = case.get("recall_threshold", 1)

    matched = [t for t in targets if t in topn]
    if len(matched) < recall_threshold:
        return False, None
    best_rank = min(topn.index(t) + 1 for t in matched)
    return True, best_rank


def compute_loss(
    notes,
    idx,
    regression_cases: list[dict[str, Any]],
    scenario_cases: list[dict[str, Any]],
    threshold: float,
    cap: int,
) -> tuple[float, Metrics]:
    reg_miss = 0
    scn_miss = 0
    ranks: list[int] = []
    for c in regression_cases:
        hit, rank = evaluate_regression(c, notes, idx, threshold, cap)
        if hit and rank is not None:
            ranks.append(rank)
        else:
            reg_miss += 1
    for c in scenario_cases:
        hit, rank = evaluate_scenario(c, notes, idx, threshold, cap)
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

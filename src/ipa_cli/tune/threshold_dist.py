"""Threshold distribution analysis over the 2차 ``SearchEngine``.

Runs the testset against the *current* weights, collects the score of
the right answer in each case (the score we must keep above threshold)
and the scores of the noise that comes with it (what we'd like to cut),
then summarises the percentile distributions and simulates a handful
of candidate threshold values.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ipa_cli.api.base_channels import Query

from .eval_set import topn_for_mode

CANDIDATES = (0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50)


def _percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * p / 100
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)


@dataclass(frozen=True)
class Distribution:
    count: int
    minimum: float
    p05: float
    p25: float
    median: float
    p75: float
    p95: float
    maximum: float


@dataclass(frozen=True)
class CandidateRow:
    x: float
    cut_hit: int
    cut_noise: int
    avg_after: float
    risky_ids: list[str]


@dataclass
class AnalysisResult:
    correct_dist: Distribution | None
    noise_dist: Distribution | None
    candidates: list[CandidateRow] = field(default_factory=list)
    n_cases: int = 0
    n_hit_cases: int = 0
    n_miss_cases: int = 0


def _summarize(values: list[float]) -> Distribution | None:
    if not values:
        return None
    s = sorted(values)
    return Distribution(
        count=len(s),
        minimum=s[0],
        p05=_percentile(s, 5),
        p25=_percentile(s, 25),
        median=_percentile(s, 50),
        p75=_percentile(s, 75),
        p95=_percentile(s, 95),
        maximum=s[-1],
    )


def analyze_threshold(
    engine,
    testset: dict[str, Any],
    *,
    weights: dict[str, float] | None = None,
    top_n: int = 10,
) -> AnalysisResult:
    """Threshold distribution analysis over the 2차 ``SearchEngine``."""
    correct_scores: list[float] = []
    noise_scores: list[float] = []
    case_results: list[tuple[str, float | None, list[float]]] = []
    miss_cases = 0

    def _collect(case_id, queries, targets, n_top=10):
        nonlocal miss_cases
        combined: dict[str, float] = {}
        for q in queries:
            if not q:
                continue
            for hit in engine.search(Query(raw=q), weights=weights):
                combined[hit.note_id] = combined.get(hit.note_id, 0.0) + hit.score
        topn = sorted(combined.items(), key=lambda x: x[1], reverse=True)[:n_top]
        target_score: float | None = None
        for note_id, score in topn:
            if note_id in targets:
                if target_score is None or score > target_score:
                    target_score = score
        noise = [score for note_id, score in topn if note_id not in targets]
        if target_score is not None:
            correct_scores.append(target_score)
            noise_scores.extend(noise)
        else:
            miss_cases += 1
        case_results.append((case_id, target_score, [s for _, s in topn]))

    for c in testset.get("cases", []):
        _collect(c["id"], c["queries"], {c["target_filename"]}, top_n)
    for c in testset.get("scenario_cases", []) or []:
        qs = c.get("queries") or []
        if not qs:
            continue
        targets = set(c.get("target_filenames") or [c.get("target_filename")])
        n_top = topn_for_mode(c.get("recall_mode", "top10"))
        _collect(c["id"], qs, targets, max(n_top, top_n))

    rows: list[CandidateRow] = []
    n_cases = len(case_results)
    for x in CANDIDATES:
        cut_hit = sum(1 for s in correct_scores if s < x)
        cut_noise = sum(1 for s in noise_scores if s < x)
        avg_after = sum(
            sum(1 for s in topn if s >= x) for _, _, topn in case_results
        ) / max(n_cases, 1)
        risky = [
            cid
            for cid, ts_score, _ in case_results
            if ts_score is not None and ts_score < x
        ]
        rows.append(
            CandidateRow(
                x=x,
                cut_hit=cut_hit,
                cut_noise=cut_noise,
                avg_after=avg_after,
                risky_ids=risky,
            )
        )

    return AnalysisResult(
        correct_dist=_summarize(correct_scores),
        noise_dist=_summarize(noise_scores),
        candidates=rows,
        n_cases=n_cases,
        n_hit_cases=len(correct_scores),
        n_miss_cases=miss_cases,
    )

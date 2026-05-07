"""tune/loss.py tests — SearchEngine-driven evaluation."""

from __future__ import annotations

from pathlib import Path
from typing import ClassVar

from ipa_cli.api.base_channels import BaseSearchChannel, SetupContext
from ipa_cli.parse.note_model import Note
from ipa_cli.runtime.search_engine import SearchEngine
from ipa_cli.tune.loss import (
    compute_loss,
    evaluate_regression,
    evaluate_scenario,
)


class _FixedScoreChannel(BaseSearchChannel):
    """Channel that returns hard-coded per-(query, note) scores.

    Lets us write deterministic loss tests without depending on real
    BM25 / fuzzy heuristics.
    """

    name: ClassVar[str] = "fixed"
    description: ClassVar[str] = "fixed score for (query, note) pairs"
    default_weight: ClassVar[float] = 1.0

    def __init__(self, table: dict[tuple[str, str], float]) -> None:
        # table: {(query, note_id): raw_score}
        self.table = table

    def search(self, ctx, query):
        return {
            note_id: score
            for (q, note_id), score in self.table.items()
            if q == query.raw
        }


def _note(nid: str) -> Note:
    return Note(id=nid, path=Path(f"/tmp/{nid}.md"), body="", frontmatter={})


def _engine(notes: list[Note], channel: BaseSearchChannel) -> SearchEngine:
    ctx = SetupContext(notes=notes, vault_path=Path("/tmp"), cache_dir=Path("/tmp"))
    return SearchEngine(channels=[channel], ctx=ctx)


def test_regression_hit_at_rank_1() -> None:
    notes = [_note("Alpha"), _note("Beta")]
    ch = _FixedScoreChannel({("q1", "Alpha"): 1.0, ("q1", "Beta"): 0.5})
    engine = _engine(notes, ch)
    case = {"queries": ["q1"], "target_filename": "Alpha"}
    hit, rank = evaluate_regression(case, engine, weights=None, threshold=0.0, cap=10)
    assert hit is True
    assert rank == 1


def test_regression_miss_when_target_below_threshold() -> None:
    notes = [_note("Alpha"), _note("Beta")]
    ch = _FixedScoreChannel({("q1", "Alpha"): 0.05, ("q1", "Beta"): 0.5})
    engine = _engine(notes, ch)
    case = {"queries": ["q1"], "target_filename": "Alpha"}
    # threshold=0.10 prunes Alpha.
    hit, _ = evaluate_regression(case, engine, None, threshold=0.10, cap=10)
    assert hit is False


def test_regression_miss_when_target_below_cap() -> None:
    notes = [_note(f"N{i}") for i in range(5)]
    table = {("q1", f"N{i}"): 1.0 - 0.1 * i for i in range(5)}
    ch = _FixedScoreChannel(table)
    engine = _engine(notes, ch)
    case = {"queries": ["q1"], "target_filename": "N4"}  # last in rank
    hit, _ = evaluate_regression(case, engine, None, threshold=0.0, cap=2)
    assert hit is False


def test_multi_query_sums_per_note_scores() -> None:
    """1차 multi_search parity: case.queries scores sum across queries."""
    notes = [_note("Alpha"), _note("Beta")]
    table = {
        ("q1", "Alpha"): 0.4,
        ("q2", "Alpha"): 0.4,  # sum = 0.8 → wins
        ("q1", "Beta"): 0.6,
        ("q2", "Beta"): 0.0,  # sum = 0.6
    }
    ch = _FixedScoreChannel(table)
    engine = _engine(notes, ch)
    case = {"queries": ["q1", "q2"], "target_filename": "Alpha"}
    hit, rank = evaluate_regression(case, engine, None, threshold=0.0, cap=10)
    assert hit is True
    assert rank == 1


def test_scenario_recall_threshold_requires_min_targets() -> None:
    notes = [_note(n) for n in ("A", "B", "C")]
    ch = _FixedScoreChannel({("q", "A"): 1.0, ("q", "B"): 0.9, ("q", "C"): 0.8})
    engine = _engine(notes, ch)
    case = {
        "queries": ["q"],
        "target_filenames": ["A", "B", "Z"],  # Z is not in vault
        "recall_mode": "top10",
        "recall_threshold": 2,
    }
    hit, rank = evaluate_scenario(case, engine, None, threshold=0.0, cap=10)
    assert hit is True
    assert rank == 1  # best matched rank

    # Now require 3 of {A,B,Z}: only A and B available → miss.
    case_strict = {**case, "recall_threshold": 3}
    hit2, _ = evaluate_scenario(case_strict, engine, None, 0.0, 10)
    assert hit2 is False


def test_scenario_top_n_limits_visibility() -> None:
    notes = [_note(n) for n in ("A", "B", "C", "D", "E", "F")]
    table = {
        ("q", n): 1.0 - i * 0.1 for i, n in enumerate(["A", "B", "C", "D", "E", "F"])
    }
    ch = _FixedScoreChannel(table)
    engine = _engine(notes, ch)
    # E ranks 5th overall but recall_mode=top1 only inspects rank 1.
    case = {
        "queries": ["q"],
        "target_filenames": ["E"],
        "recall_mode": "top1",
        "recall_threshold": 1,
    }
    hit, _ = evaluate_scenario(case, engine, None, 0.0, 10)
    assert hit is False


def test_compute_loss_aggregates_misses_with_penalties() -> None:
    notes = [_note("A"), _note("B")]
    ch = _FixedScoreChannel({("q1", "A"): 1.0, ("q2", "B"): 1.0})
    engine = _engine(notes, ch)
    regression = [
        {"queries": ["q1"], "target_filename": "A"},  # hit rank 1
        {"queries": ["q3"], "target_filename": "A"},  # miss (no scores)
    ]
    scenario = [
        {
            "queries": ["q2"],
            "target_filenames": ["B"],
            "recall_mode": "top10",
            "recall_threshold": 1,
        },  # hit rank 1
    ]
    loss, m = compute_loss(engine, regression, scenario, None, 0.0, 10)
    # 1 reg miss × 100 + 0 scn miss × 50 + avg_rank(1.0)
    assert m.reg_hit == 1
    assert m.reg_miss == 1
    assert m.scn_hit == 1
    assert m.avg_rank == 1.0
    assert loss == 100 + 1.0


def test_weights_change_alters_ordering() -> None:
    """Trial varying weights must affect search ordering — core G7 invariant."""

    class C1(BaseSearchChannel):
        name: ClassVar[str] = "ch1"
        description: ClassVar[str] = ""
        default_weight: ClassVar[float] = 1.0

        def search(self, ctx, query):
            return {"A": 1.0, "B": 0.0}

    class C2(BaseSearchChannel):
        name: ClassVar[str] = "ch2"
        description: ClassVar[str] = ""
        default_weight: ClassVar[float] = 1.0

        def search(self, ctx, query):
            return {"A": 0.0, "B": 1.0}

    notes = [_note("A"), _note("B")]
    ctx = SetupContext(notes=notes, vault_path=Path("/tmp"), cache_dir=Path("/tmp"))
    engine = SearchEngine(channels=[C1(), C2()], ctx=ctx)
    case = {"queries": ["x"], "target_filename": "A"}

    # Boost ch1 → A wins.
    hit_a, rank_a = evaluate_regression(
        case, engine, weights={"ch1": 1.0, "ch2": 0.0}, threshold=0.0, cap=10
    )
    assert hit_a is True and rank_a == 1

    # Boost ch2 → A drops.
    case_b = {"queries": ["x"], "target_filename": "B"}
    hit_b, rank_b = evaluate_regression(
        case_b, engine, weights={"ch1": 0.0, "ch2": 1.0}, threshold=0.0, cap=10
    )
    assert hit_b is True and rank_b == 1

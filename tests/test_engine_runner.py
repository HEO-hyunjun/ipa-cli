"""G7 engine_runner tests — Optuna trials reuse a single SearchEngine.setup."""

from __future__ import annotations

from pathlib import Path
from typing import ClassVar

from ipa_cli.api.base_channels import BaseSearchChannel, SetupContext
from ipa_cli.parse.note_model import Note
from ipa_cli.runtime.search_engine import SearchEngine
from ipa_cli.tune.engine_runner import run_engine_study


class _CountingChannel(BaseSearchChannel):
    """Channel that records every ``setup`` call so tests can assert
    setup runs exactly once across an N-trial study (the G7 invariant)."""

    name: ClassVar[str] = "counting"
    description: ClassVar[str] = ""
    default_weight: ClassVar[float] = 1.0

    def __init__(self) -> None:
        self.setup_calls = 0
        self.search_calls = 0

    def setup(self, ctx) -> None:
        self.setup_calls += 1

    def search(self, ctx, query):
        self.search_calls += 1
        return {n.id: 1.0 for n in ctx.notes}


def _note(nid: str) -> Note:
    return Note(id=nid, path=Path(f"/tmp/{nid}.md"), body="", frontmatter={})


def _build_engine(channel: BaseSearchChannel, notes: list[Note] | None = None):
    notes = notes or [_note("A"), _note("B")]
    ctx = SetupContext(notes=notes, vault_path=Path("/tmp"), cache_dir=Path("/tmp"))
    return SearchEngine(channels=[channel], ctx=ctx)


def test_setup_runs_once_across_trials() -> None:
    ch = _CountingChannel()
    engine = _build_engine(ch)
    regression = [{"queries": ["q"], "target_filename": "A"}]

    n_trials = 20
    run_engine_study(
        engine,
        regression,
        scenario_cases=[],
        n_trials=n_trials,
        tune_threshold=False,
        tune_cap=False,
        seed=1,
    )
    # The whole point of G7: setup runs exactly once even though
    # n_trials × |regression| trial-objective evaluations happened.
    assert ch.setup_calls == 1
    assert ch.search_calls > 0


def test_setup_not_re_run_when_caller_already_setup() -> None:
    ch = _CountingChannel()
    engine = _build_engine(ch)
    engine.setup()
    assert ch.setup_calls == 1

    run_engine_study(
        engine,
        regression_cases=[{"queries": ["q"], "target_filename": "A"}],
        scenario_cases=[],
        n_trials=5,
        tune_threshold=False,
        tune_cap=False,
        seed=1,
    )
    # Idempotent setup — still 1 even though run_engine_study calls it.
    assert ch.setup_calls == 1


def test_studyresult_shape_unchanged() -> None:
    ch = _CountingChannel()
    engine = _build_engine(ch)
    result = run_engine_study(
        engine,
        regression_cases=[{"queries": ["q"], "target_filename": "A"}],
        scenario_cases=[],
        n_trials=5,
        tune_threshold=True,
        tune_cap=True,
        seed=1,
    )
    # Same dataclass that legacy runner produces — main.py keeps working.
    assert result.n_trials == 5
    assert result.study_name == "ipa-tune-engine"
    assert "counting" in result.best_weights
    assert result.best_metrics.reg_hit == 1
    # threshold/cap got tuned
    assert isinstance(result.best_threshold, float)
    assert isinstance(result.best_cap, int)


def test_only_keys_restricts_tuning_surface() -> None:
    """``only_keys`` should keep weights for unlisted channels at default."""

    class C1(_CountingChannel):
        name: ClassVar[str] = "c1"

    class C2(_CountingChannel):
        name: ClassVar[str] = "c2"

    notes = [_note("A"), _note("B")]
    ctx = SetupContext(notes=notes, vault_path=Path("/tmp"), cache_dir=Path("/tmp"))
    c1, c2 = C1(), C2()
    engine = SearchEngine(channels=[c1, c2], ctx=ctx)

    result = run_engine_study(
        engine,
        regression_cases=[{"queries": ["q"], "target_filename": "A"}],
        scenario_cases=[],
        n_trials=5,
        only_keys=["c1"],
        tune_threshold=False,
        tune_cap=False,
        seed=1,
    )
    assert "c1" in result.best_weights
    assert "c2" not in result.best_weights  # not tuned


def test_fixed_weights_override_trial_suggestions() -> None:
    """``fixed_weights`` skips the trial.suggest_float for those keys."""
    ch = _CountingChannel()
    engine = _build_engine(ch)
    result = run_engine_study(
        engine,
        regression_cases=[{"queries": ["q"], "target_filename": "A"}],
        scenario_cases=[],
        n_trials=5,
        fixed_weights={"counting": 0.42},
        tune_threshold=False,
        tune_cap=False,
        seed=1,
    )
    assert result.best_weights["counting"] == 0.42


def test_persistent_study_dir_creates_db_file(tmp_path: Path) -> None:
    ch = _CountingChannel()
    engine = _build_engine(ch)
    run_engine_study(
        engine,
        regression_cases=[{"queries": ["q"], "target_filename": "A"}],
        scenario_cases=[],
        n_trials=3,
        study_dir=tmp_path,
        tune_threshold=False,
        tune_cap=False,
        seed=1,
    )
    assert (tmp_path / "optuna_engine.db").is_file()

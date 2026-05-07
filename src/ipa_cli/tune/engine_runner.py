"""Optuna TPE study driven by the 2차 ``SearchEngine``.

G7 deliverable. The legacy ``runner.py`` mutates 1차 ``vault_search``
globals between trials and re-runs ``multi_search`` from scratch each
time. This runner instead:

  - takes a pre-built ``SearchEngine`` instance from the caller
  - calls ``engine.setup()`` exactly once (here, before the trial loop)
  - in each trial, only varies ``weights`` / ``threshold`` / ``cap``
    and feeds them to ``engine.search`` — no global mutation, no
    re-indexing

That way trial cost is dominated by per-channel scoring (already lazy
inside the engine) instead of the BM25 build that 1차 paid every call.

The returned ``StudyResult`` shape is identical to the legacy runner so
``main.py`` and downstream code (e.g. ``_apply_best_to_config``) keep
working untouched.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

import optuna
from optuna.samplers import TPESampler

from .engine_loss import compute_loss_v2
from .runner import CAP_RANGE, THRESHOLD_RANGE, WEIGHT_RANGE, StudyResult

if TYPE_CHECKING:
    from ipa_cli.runtime.search_engine import SearchEngine


def _resolve_channel_keys(engine: "SearchEngine", only: list[str] | None) -> list[str]:
    """Tunable channel names — taken from the engine, not a global registry."""
    keys = [c.name for c in engine.channels]
    if only:
        wanted = set(only)
        keys = [k for k in keys if k in wanted]
    return keys


def run_engine_study(
    engine: "SearchEngine",
    regression_cases: list[dict[str, Any]],
    scenario_cases: list[dict[str, Any]],
    n_trials: int = 200,
    tune_threshold: bool = True,
    tune_cap: bool = True,
    fixed_weights: dict[str, float] | None = None,
    only_keys: list[str] | None = None,
    fixed_threshold: float = 0.30,
    fixed_cap: int = 10,
    study_dir: Path | None = None,
    study_name: str = "ipa-tune-engine",
    seed: int = 42,
    on_trial: Any = None,
) -> StudyResult:
    """Run a TPE study using ``engine`` as the only search backend.

    The caller is responsible for building ``engine`` with the desired
    notes/cache_dir and (optionally) calling ``engine.setup()`` ahead of
    time. This function will call ``setup()`` once if it hasn't been
    done yet — never inside the trial loop.
    """
    fixed = dict(fixed_weights or {})
    keys = [k for k in _resolve_channel_keys(engine, only_keys) if k not in fixed]

    # Engine setup must happen exactly once — that's the whole point of G7.
    # ``SearchEngine.setup`` is idempotent (``_setup_done`` flag), so
    # calling it here is safe even if the caller already did.
    engine.setup()

    if study_dir is None:
        storage_url = "sqlite:///:memory:"
    else:
        study_dir.mkdir(parents=True, exist_ok=True)
        storage_url = f"sqlite:///{study_dir / 'optuna_engine.db'}"

    sampler = TPESampler(seed=seed, n_startup_trials=min(30, n_trials // 4 or 1))
    study = optuna.create_study(
        direction="minimize",
        sampler=sampler,
        study_name=study_name,
        storage=storage_url,
        load_if_exists=True,
    )

    def objective(trial: optuna.Trial) -> float:
        w = dict(fixed)
        for k in keys:
            w[k] = trial.suggest_float(k, *WEIGHT_RANGE)
        threshold = (
            trial.suggest_float("threshold", *THRESHOLD_RANGE)
            if tune_threshold
            else fixed_threshold
        )
        cap = trial.suggest_int("cap", *CAP_RANGE) if tune_cap else fixed_cap
        loss, _ = compute_loss_v2(
            engine, regression_cases, scenario_cases, w, threshold, cap
        )
        return loss

    for i in range(n_trials):
        trial = study.ask()
        try:
            loss = objective(trial)
        except Exception:
            study.tell(trial, state=optuna.trial.TrialState.FAIL)
            continue
        study.tell(trial, loss)
        if on_trial is not None:
            on_trial(i, loss, study.best_value)

    best_params = dict(study.best_params)
    best_threshold = best_params.pop("threshold", fixed_threshold)
    best_cap = int(best_params.pop("cap", fixed_cap))
    best_weights = dict(fixed)
    best_weights.update({k: float(best_params[k]) for k in keys if k in best_params})

    # Recompute metrics with the best params so callers can show
    # reg/scn hit numbers without re-running the trial loop.
    _, best_metrics = compute_loss_v2(
        engine,
        regression_cases,
        scenario_cases,
        best_weights,
        best_threshold,
        best_cap,
    )

    return StudyResult(
        best_loss=study.best_value,
        best_metrics=best_metrics,
        best_weights=best_weights,
        best_threshold=best_threshold,
        best_cap=best_cap,
        n_trials=n_trials,
        study_name=study_name,
        storage_url=storage_url,
    )

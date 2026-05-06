"""Optuna TPE driver for `ipa tune`.

Discovers tunable channels from the plugin registry, optimizes
weights + threshold + cap simultaneously against the testset loss.
Persists the study in `~/.cache/ipa/{profile}/optuna.db` so resuming
is free.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import optuna
from optuna.samplers import TPESampler

from ipa_cli.core import vault_search
from ipa_cli.plugins import get_channels

from .loss import Metrics, compute_loss

THRESHOLD_RANGE = (0.05, 0.55)
CAP_RANGE = (5, 30)
WEIGHT_RANGE = (0.0, 0.40)


@dataclass(frozen=True)
class StudyResult:
    best_loss: float
    best_metrics: Metrics
    best_weights: dict[str, float]
    best_threshold: float
    best_cap: int
    n_trials: int
    study_name: str
    storage_url: str


def _resolve_channel_keys(only: list[str] | None) -> list[str]:
    """Channels to tune — registry-driven."""
    keys = list(get_channels().keys())
    if only:
        wanted = set(only)
        keys = [k for k in keys if k in wanted]
    return keys


def run_study(
    notes,
    idx,
    regression_cases: list[dict[str, Any]],
    scenario_cases: list[dict[str, Any]],
    n_trials: int = 200,
    tune_threshold: bool = True,
    tune_cap: bool = True,
    fixed_weights: dict[str, float] | None = None,
    only_keys: list[str] | None = None,
    fixed_threshold: float = 0.30,
    fixed_cap: int = 15,
    study_dir: Path | None = None,
    study_name: str = "ipa-tune",
    seed: int = 42,
    on_trial: Any = None,
) -> StudyResult:
    """Run Optuna TPE study; return best params + metrics."""
    fixed = dict(fixed_weights or {})
    keys = [k for k in _resolve_channel_keys(only_keys) if k not in fixed]

    if study_dir is None:
        storage_url = "sqlite:///:memory:"
    else:
        study_dir.mkdir(parents=True, exist_ok=True)
        storage_url = f"sqlite:///{study_dir / 'optuna.db'}"

    sampler = TPESampler(seed=seed, n_startup_trials=min(30, n_trials // 4 or 1))
    study = optuna.create_study(
        direction="minimize",
        sampler=sampler,
        study_name=study_name,
        storage=storage_url,
        load_if_exists=True,
    )

    base_w = dict(vault_search._CHANNEL_WEIGHTS)

    def objective(trial: optuna.Trial) -> float:
        w = dict(fixed)
        for k in keys:
            w[k] = trial.suggest_float(k, *WEIGHT_RANGE)
        # Keep all original keys in vault_search's global, even if not tuned
        merged = dict(base_w)
        merged.update(w)
        vault_search._CHANNEL_WEIGHTS.update(merged)
        threshold = (
            trial.suggest_float("threshold", *THRESHOLD_RANGE)
            if tune_threshold
            else fixed_threshold
        )
        cap = trial.suggest_int("cap", *CAP_RANGE) if tune_cap else fixed_cap
        loss, _ = compute_loss(
            notes, idx, regression_cases, scenario_cases, threshold, cap
        )
        return loss

    try:
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
    finally:
        # Always restore the global weights on exit so other commands are unaffected.
        vault_search._CHANNEL_WEIGHTS.clear()
        vault_search._CHANNEL_WEIGHTS.update(base_w)

    best_params = dict(study.best_params)
    best_threshold = best_params.pop("threshold", fixed_threshold)
    best_cap = int(best_params.pop("cap", fixed_cap))
    best_weights = dict(fixed)
    best_weights.update({k: float(best_params[k]) for k in keys if k in best_params})

    # Recompute metrics with best params
    merged = dict(base_w)
    merged.update(best_weights)
    vault_search._CHANNEL_WEIGHTS.update(merged)
    try:
        _, m = compute_loss(
            notes,
            idx,
            regression_cases,
            scenario_cases,
            best_threshold,
            best_cap,
        )
    finally:
        vault_search._CHANNEL_WEIGHTS.clear()
        vault_search._CHANNEL_WEIGHTS.update(base_w)

    return StudyResult(
        best_loss=study.best_value,
        best_metrics=m,
        best_weights=best_weights,
        best_threshold=best_threshold,
        best_cap=best_cap,
        n_trials=n_trials,
        study_name=study_name,
        storage_url=storage_url,
    )

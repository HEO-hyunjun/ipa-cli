"""Tests for ipa tune (loss + testset loading)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ipa_cli.tune import (
    default_testset_path,
    load_testset,
)
from ipa_cli.tune.loss import (
    REGRESSION_MISS_PENALTY,
    SCENARIO_MISS_PENALTY,
    Metrics,
)


def _fake_testset(tmp_path: Path) -> Path:
    p = tmp_path / "testset.json"
    p.write_text(
        json.dumps(
            {
                "version": "v1",
                "exclude_filenames": ["evaluation_artifact"],
                "cases": [
                    {
                        "id": "R1",
                        "queries": ["q1"],
                        "target_filename": "Note A",
                        "baseline_rank": 1,
                    }
                ],
                "scenario_cases": [
                    {
                        "id": "S1",
                        "queries": ["q2"],
                        "target_filenames": ["Note B"],
                        "recall_mode": "top10",
                        "recall_threshold": 1,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return p


def test_load_testset_explicit_path(tmp_path: Path) -> None:
    p = _fake_testset(tmp_path)
    ts = load_testset(p)
    assert ts["version"] == "v1"
    assert len(ts["cases"]) == 1
    assert ts["cases"][0]["target_filename"] == "Note A"
    assert ts["scenario_cases"][0]["recall_threshold"] == 1


def test_load_testset_missing_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_testset(tmp_path / "nope.json")


def test_load_testset_invalid_shape(tmp_path: Path) -> None:
    p = tmp_path / "bad.json"
    p.write_text(json.dumps({"version": "v1"}), encoding="utf-8")
    with pytest.raises(ValueError, match="missing 'cases'"):
        load_testset(p)


def test_default_testset_path_returns_none_when_absent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("IPA_TESTSET", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.chdir(tmp_path)
    assert default_testset_path() is None


def test_default_testset_path_picks_env_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = _fake_testset(tmp_path)
    monkeypatch.setenv("IPA_TESTSET", str(target))
    assert default_testset_path() == target


def test_loss_penalty_constants() -> None:
    """Penalties match the design contract documented in IPA CLI 구축 계획."""
    assert REGRESSION_MISS_PENALTY == 100
    assert SCENARIO_MISS_PENALTY == 50


def test_metrics_dataclass_is_immutable() -> None:
    m = Metrics(reg_hit=20, reg_miss=4, scn_hit=28, scn_miss=2, avg_rank=1.7)
    with pytest.raises(Exception):
        m.reg_hit = 0  # type: ignore[misc]

"""P6 — ipa tune list/use CLI 동작.

run/eval/analyze는 testset + Optuna가 필요해 별도 e2e 영역이며 여기서는 다루지 않는다.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from typer.testing import CliRunner

from ipa_cli.main import _study_fingerprint, app
from ipa_cli.tune import TuneResult, save_result


@pytest.fixture
def isolated_xdg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg-config"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))
    monkeypatch.setenv("IPA_PROFILE", "personal")
    monkeypatch.delenv("IPA_VAULT_PATH", raising=False)
    return tmp_path / "xdg-config"


def _seed_config(isolated_xdg: Path, profile: str = "personal") -> Path:
    vault = isolated_xdg.parent / "vault"
    profile_yaml = isolated_xdg / "ipa" / "profile.yaml"
    profile_yaml.parent.mkdir(parents=True, exist_ok=True)
    profile_yaml.write_text(
        yaml.safe_dump(
            {"profiles": {profile: {"vault_path": str(vault), "default": True}}}
        ),
        encoding="utf-8",
    )
    return vault


def _result(threshold: float = 0.30) -> TuneResult:
    return TuneResult(
        threshold=threshold,
        max_results=10,
        weights={"fuzzy": 0.2},
        study={"n_trials": 100, "best_loss": 20.0, "saved_at": "2026-05-07T03:00:00"},
    )


def test_tune_list_shows_history_with_active_marker(isolated_xdg: Path) -> None:
    vault = _seed_config(isolated_xdg)
    save_result(
        "personal",
        _result(),
        filename="2026-05-04T09-12-44.json",
        vault_path=vault,
    )
    save_result(
        "personal",
        _result(),
        filename="2026-05-06T21-30-00.json",
        vault_path=vault,
    )
    (vault / ".ipa" / "config.yaml").write_text(
        yaml.safe_dump(
            {"weights": {"file": ".ipa/tune/results/2026-05-06T21-30-00.json"}}
        ),
        encoding="utf-8",
    )

    result = CliRunner().invoke(app, ["tune", "list"])
    assert result.exit_code == 0, result.stdout
    assert "2026-05-06T21-30-00.json" in result.stdout
    assert "2026-05-04T09-12-44.json" in result.stdout
    assert "★" in result.stdout  # active marker shown for the latter


def test_tune_list_handles_empty_profile(isolated_xdg: Path) -> None:
    _seed_config(isolated_xdg)
    result = CliRunner().invoke(app, ["tune", "list"])
    assert result.exit_code == 0, result.stdout
    assert "no tune results" in result.stdout


def test_tune_use_flips_active_pointer(isolated_xdg: Path) -> None:
    vault = _seed_config(isolated_xdg)
    save_result(
        "personal",
        _result(threshold=0.20),
        filename="alpha.json",
        vault_path=vault,
    )
    save_result(
        "personal",
        _result(threshold=0.40),
        filename="beta.json",
        vault_path=vault,
    )

    result = CliRunner().invoke(app, ["tune", "use", "beta.json"])
    assert result.exit_code == 0, result.stdout
    assert "switched" in result.stdout

    after = yaml.safe_load((vault / ".ipa" / "config.yaml").read_text(encoding="utf-8"))
    assert after["weights"]["file"] == ".ipa/tune/results/beta.json"


def test_tune_use_rejects_unknown_filename(isolated_xdg: Path) -> None:
    vault = _seed_config(isolated_xdg)
    save_result("personal", _result(), filename="alpha.json", vault_path=vault)

    result = CliRunner().invoke(app, ["tune", "use", "missing.json"])
    assert result.exit_code != 0


def test_tune_use_appends_json_suffix_implicitly(isolated_xdg: Path) -> None:
    vault = _seed_config(isolated_xdg)
    save_result("personal", _result(), filename="alpha.json", vault_path=vault)

    result = CliRunner().invoke(app, ["tune", "use", "alpha"])
    assert result.exit_code == 0, result.stdout
    after = yaml.safe_load((vault / ".ipa" / "config.yaml").read_text(encoding="utf-8"))
    assert after["weights"]["file"] == ".ipa/tune/results/alpha.json"


# --- _study_fingerprint -----------------------------------------------------


def _fp(**overrides) -> str:
    """Convenience builder with sane defaults for fingerprint tests."""
    base = dict(
        regression_cases=[{"id": "r1", "queries": ["q"], "target_filename": "A"}],
        scenario_cases=[],
        channel_names=["body_match", "fuzzy"],
        only_keys=None,
        fixed_weights={},
        tune_threshold=True,
        tune_cap=True,
        fixed_threshold=0.30,
        fixed_cap=10,
    )
    base.update(overrides)
    return _study_fingerprint(**base)


def test_study_fingerprint_stable_for_identical_inputs() -> None:
    assert _fp() == _fp()


def test_study_fingerprint_changes_with_regression_testset() -> None:
    other = [{"id": "r2", "queries": ["other"], "target_filename": "B"}]
    assert _fp() != _fp(regression_cases=other)


def test_study_fingerprint_changes_with_scenario_testset() -> None:
    scn = [
        {
            "id": "s1",
            "queries": ["q"],
            "target_filenames": ["A"],
            "recall_mode": "top10",
        }
    ]
    assert _fp() != _fp(scenario_cases=scn)


def test_study_fingerprint_changes_with_channel_set() -> None:
    assert _fp() != _fp(channel_names=["body_match"])


def test_study_fingerprint_changes_with_only_keys_and_fixed_weights() -> None:
    assert _fp() != _fp(only_keys=["body_match"])
    assert _fp() != _fp(fixed_weights={"body_match": 0.42})


def test_study_fingerprint_changes_with_tune_flags_and_fixed_values() -> None:
    assert _fp() != _fp(tune_threshold=False)
    assert _fp() != _fp(tune_cap=False)
    # When tune_threshold=False, fixed_threshold becomes part of the
    # fingerprint so different fixed values stay isolated.
    a = _fp(tune_threshold=False, fixed_threshold=0.20)
    b = _fp(tune_threshold=False, fixed_threshold=0.40)
    assert a != b


def test_study_fingerprint_stable_across_orderings() -> None:
    """Channel name list / case list ordering is normalised internally."""
    a = _fp(channel_names=["fuzzy", "body_match"])
    b = _fp(channel_names=["body_match", "fuzzy"])
    assert a == b
    cases_a = [
        {"id": "r1", "queries": ["q1"], "target_filename": "A"},
        {"id": "r2", "queries": ["q2"], "target_filename": "B"},
    ]
    assert _fp(regression_cases=cases_a) == _fp(
        regression_cases=list(reversed(cases_a))
    )

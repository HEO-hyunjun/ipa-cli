"""P6 — ipa tune list/use CLI 동작.

run/eval/analyze는 testset + Optuna가 필요해 별도 e2e 영역이며 여기서는 다루지 않는다.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from typer.testing import CliRunner

from ipa_cli.main import app
from ipa_cli.tune import TuneResult, save_result


@pytest.fixture
def isolated_xdg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg-config"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))
    monkeypatch.delenv("IPA_PROFILE", raising=False)
    monkeypatch.delenv("IPA_VAULT_PATH", raising=False)
    return tmp_path / "xdg-config"


def _seed_config(isolated_xdg: Path, profile: str = "personal") -> Path:
    cfg = isolated_xdg / "ipa" / "config.yaml"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(
        yaml.safe_dump(
            {
                "default_profile": profile,
                "profiles": {profile: {"vault_path": "/tmp/v"}},
            }
        ),
        encoding="utf-8",
    )
    return cfg


def _result(threshold: float = 0.30) -> TuneResult:
    return TuneResult(
        threshold=threshold,
        max_results=10,
        weights={"fuzzy": 0.2},
        study={"n_trials": 100, "best_loss": 20.0, "saved_at": "2026-05-07T03:00:00"},
    )


def test_tune_list_shows_history_with_active_marker(isolated_xdg: Path) -> None:
    cfg = _seed_config(isolated_xdg)
    save_result("personal", _result(), filename="2026-05-04T09-12-44.json")
    save_result("personal", _result(), filename="2026-05-06T21-30-00.json")
    cfg.write_text(
        yaml.safe_dump(
            {
                "default_profile": "personal",
                "profiles": {
                    "personal": {
                        "vault_path": "/tmp/v",
                        "tune": {"result_file": "2026-05-06T21-30-00.json"},
                    }
                },
            }
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
    cfg = _seed_config(isolated_xdg)
    save_result("personal", _result(threshold=0.20), filename="alpha.json")
    save_result("personal", _result(threshold=0.40), filename="beta.json")

    result = CliRunner().invoke(app, ["tune", "use", "beta.json"])
    assert result.exit_code == 0, result.stdout
    assert "switched" in result.stdout

    after = yaml.safe_load(cfg.read_text(encoding="utf-8"))
    assert after["profiles"]["personal"]["tune"]["result_file"] == "beta.json"


def test_tune_use_rejects_unknown_filename(isolated_xdg: Path) -> None:
    _seed_config(isolated_xdg)
    save_result("personal", _result(), filename="alpha.json")

    result = CliRunner().invoke(app, ["tune", "use", "missing.json"])
    assert result.exit_code != 0


def test_tune_use_appends_json_suffix_implicitly(isolated_xdg: Path) -> None:
    cfg = _seed_config(isolated_xdg)
    save_result("personal", _result(), filename="alpha.json")

    result = CliRunner().invoke(app, ["tune", "use", "alpha"])
    assert result.exit_code == 0, result.stdout
    after = yaml.safe_load(cfg.read_text(encoding="utf-8"))
    assert after["profiles"]["personal"]["tune"]["result_file"] == "alpha.json"

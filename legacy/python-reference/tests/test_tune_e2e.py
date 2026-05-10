"""G7 e2e — tune run end-to-end on a tmp vault.

Closes the loop:
  1. tmp vault with two real notes
  2. tmp testset with one regression case targeting one of them
  3. ipa tune --trials 5 → tune/results/{ts}.json
  4. ipa tune --apply --trials 5 → tune/results/{ts}.json + pointer
  5. ipa engine search picks up the new weights via config loader
  6. ipa tune list shows the result with the active marker
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml
from typer.testing import CliRunner

from ipa_cli.main import app


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    inbox = tmp_path / "00 Inbox"
    inbox.mkdir()
    (inbox / "Alpha Note.md").write_text(
        "---\ntype: note\nref:\n  - '[[Beta Note]]'\n---\nalpha keyword body\n",
        encoding="utf-8",
    )
    (inbox / "Beta Note.md").write_text(
        "---\ntype: note\n---\nbeta keyword body\n",
        encoding="utf-8",
    )
    return tmp_path


@pytest.fixture
def isolated_xdg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    cfg = tmp_path / "xdg-config"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))
    monkeypatch.setenv("IPA_PROFILE", "tunee2e")
    monkeypatch.delenv("IPA_VAULT_PATH", raising=False)
    monkeypatch.delenv("IPA_TESTSET", raising=False)
    return cfg


def _seed_config(isolated_xdg: Path, vault: Path, profile: str = "tunee2e") -> Path:
    profile_yaml = isolated_xdg / "ipa" / "profile.yaml"
    profile_yaml.parent.mkdir(parents=True, exist_ok=True)
    profile_yaml.write_text(
        yaml.safe_dump(
            {"profiles": {profile: {"vault_path": str(vault), "default": True}}}
        ),
        encoding="utf-8",
    )
    return profile_yaml


def _write_testset(tmp_path: Path) -> Path:
    p = tmp_path / "testset.json"
    p.write_text(
        json.dumps(
            {
                "version": "v1",
                "cases": [
                    {
                        "id": "R1",
                        "queries": ["alpha"],
                        "target_filename": "Alpha Note",
                    },
                ],
                "scenario_cases": [],
            }
        ),
        encoding="utf-8",
    )
    return p


def test_tune_run_apply_then_engine_search_uses_new_weights(
    vault: Path, isolated_xdg: Path, tmp_path: Path
) -> None:
    _seed_config(isolated_xdg, vault)
    testset = _write_testset(tmp_path)

    runner = CliRunner()
    # 5 trials is enough for Optuna to land on something — we don't
    # care about quality, only that the round-trip is closed.
    result = runner.invoke(
        app,
        [
            "tune",
            "--trials",
            "5",
            "--apply",
            "--testset",
            str(testset),
            "--no-persist",
        ],
    )
    assert result.exit_code == 0, result.stdout
    assert "applied" in result.stdout
    assert "iter 1/5" in result.stdout
    assert "last=" in result.stdout
    assert "avg=" in result.stdout
    assert "eta=" in result.stdout

    # Pointer flipped in vault-local config.yaml.
    vault_cfg = vault / ".ipa" / "config.yaml"
    after = yaml.safe_load(vault_cfg.read_text(encoding="utf-8"))
    pointer_path = after["weights"]["file"]
    pointer = Path(pointer_path).name
    assert pointer.endswith(".json")

    # tune/results/{ts}.json exists and has the expected keys.
    result_path = vault / ".ipa" / "tune" / "results" / pointer
    payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert "threshold" in payload
    assert "max_results" in payload
    assert isinstance(payload.get("weights"), dict)
    assert "study" in payload

    # tune list shows the new result with the ★ active marker.
    listed = runner.invoke(app, ["tune", "list"])
    assert listed.exit_code == 0, listed.stdout
    assert pointer in listed.stdout
    assert "★" in listed.stdout

    # engine search runs and picks up the new weights via config loader
    # (priority: tune_result > yaml). We don't assert ranking shape —
    # just that it doesn't crash and returns at least one hit.
    searched = runner.invoke(app, ["engine", "search", "alpha"])
    assert searched.exit_code == 0, searched.stdout
    assert "Alpha Note" in searched.stdout


def test_tune_run_saves_result_without_applying(
    vault: Path, isolated_xdg: Path, tmp_path: Path
) -> None:
    _seed_config(isolated_xdg, vault)
    testset = _write_testset(tmp_path)

    result = CliRunner().invoke(
        app,
        [
            "tune",
            "--trials",
            "5",
            "--testset",
            str(testset),
            "--no-persist",
        ],
    )

    assert result.exit_code == 0, result.stdout
    assert "saved" in result.stdout
    assert "activate: ipa tune use" in result.stdout
    assert "iter 1/5" in result.stdout
    assert "loss=" in result.stdout
    assert "best=" in result.stdout

    result_dir = vault / ".ipa" / "tune" / "results"
    saved = list(result_dir.glob("*.json"))
    assert len(saved) == 1
    payload = json.loads(saved[0].read_text(encoding="utf-8"))
    assert "threshold" in payload
    assert "max_results" in payload
    assert isinstance(payload.get("weights"), dict)
    assert payload["study"]["optimizer"] == "optuna-tpe"
    assert "storage_url" not in payload["study"]

    config_yaml = vault / ".ipa" / "config.yaml"
    if config_yaml.exists():
        data = yaml.safe_load(config_yaml.read_text(encoding="utf-8")) or {}
        assert "weights" not in data or "file" not in (data.get("weights") or {})

    listed = CliRunner().invoke(app, ["tune", "list"])
    assert listed.exit_code == 0, listed.stdout
    assert saved[0].name in listed.stdout
    assert "★" not in listed.stdout


def test_tune_eval_runs_through_engine(
    vault: Path, isolated_xdg: Path, tmp_path: Path
) -> None:
    """tune eval reports baseline metrics via the 2차 SearchEngine path."""
    _seed_config(isolated_xdg, vault)
    testset = _write_testset(tmp_path)

    result = CliRunner().invoke(app, ["tune", "eval", "--testset", str(testset)])
    assert result.exit_code == 0, result.stdout
    assert "baseline" in result.stdout
    # Single regression case → reg hit is "1/1" or "0/1"; just ensure
    # the row is present so we know the engine path executed.
    assert "reg hit" in result.stdout

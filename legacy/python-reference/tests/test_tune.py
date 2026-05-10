"""Tests for ipa tune (loss + testset loading)."""

from __future__ import annotations

import json
import unicodedata
from pathlib import Path
from types import SimpleNamespace

import pytest

from ipa_cli.main import _filter_excluded
from ipa_cli.tune import (
    default_testset_path,
    load_testset,
)
from ipa_cli.tune.loss import (
    REGRESSION_MISS_PENALTY,
    SCENARIO_MISS_PENALTY,
    Metrics,
    nfc,
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


def test_default_testset_path_picks_vault_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("IPA_TESTSET", raising=False)
    vault = tmp_path / "vault"
    (vault / ".ipa" / "tune" / "testsets").mkdir(parents=True)
    target = _fake_testset(vault / ".ipa" / "tune" / "testsets")
    cfg = vault / ".ipa" / "config.yaml"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(
        "test:\n  file: .ipa/tune/testsets/testset.json\n",
        encoding="utf-8",
    )
    assert default_testset_path(vault_path=vault) == target


def test_load_testset_name_resolves_under_vault(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    (vault / ".ipa" / "tune" / "testsets").mkdir(parents=True)
    _fake_testset(vault / ".ipa" / "tune" / "testsets")
    ts = load_testset("testset", vault_path=vault)
    assert ts["version"] == "v1"


def test_loss_penalty_constants() -> None:
    """Penalties match the design contract documented in IPA CLI 구축 계획."""
    assert REGRESSION_MISS_PENALTY == 100
    assert SCENARIO_MISS_PENALTY == 50


def test_metrics_dataclass_is_immutable() -> None:
    m = Metrics(reg_hit=20, reg_miss=4, scn_hit=28, scn_miss=2, avg_rank=1.7)
    with pytest.raises(Exception):
        m.reg_hit = 0  # type: ignore[misc]


# --- NFC normalisation -----------------------------------------------------


def test_nfc_normalises_decomposed_hangul() -> None:
    nfd = unicodedata.normalize("NFD", "포레스트")
    assert nfd != "포레스트"  # sanity: NFD form is genuinely different bytes
    assert nfc(nfd) == "포레스트"
    assert nfc("ascii-only") == "ascii-only"


def test_filter_excluded_matches_across_nfd_and_nfc() -> None:
    """``_filter_excluded`` must cope with NFD-encoded testset filenames
    even when ``Note.id`` is NFC (the contract loss.py already follows)."""
    name = "포레스트"
    nfd_name = unicodedata.normalize("NFD", name)
    nfc_name = unicodedata.normalize("NFC", name)

    # Exclude listed in NFD form, note.id in NFC form → must still match.
    notes = [SimpleNamespace(id=nfc_name), SimpleNamespace(id="other")]
    kept = _filter_excluded(notes, [nfd_name])
    assert [n.id for n in kept] == ["other"]

    # Reverse direction — note.id in NFD, exclude in NFC.
    notes_nfd = [SimpleNamespace(id=nfd_name), SimpleNamespace(id="other")]
    kept2 = _filter_excluded(notes_nfd, [nfc_name])
    assert [n.id for n in kept2] == ["other"]


def test_filter_excluded_no_op_for_empty_list() -> None:
    notes = [SimpleNamespace(id="A"), SimpleNamespace(id="B")]
    assert _filter_excluded(notes, None) is notes
    assert _filter_excluded(notes, []) is notes

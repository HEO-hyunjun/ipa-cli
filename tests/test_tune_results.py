"""P6 — immutable tune results + active pointer round-trip."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest
import yaml

from ipa_cli.tune import (
    TuneResult,
    list_results,
    load_result,
    read_active_result_filename,
    resolve_active_result,
    results_dir,
    save_result,
    timestamp_filename,
    write_active_result_filename,
)


@pytest.fixture
def isolated_xdg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    cfg = tmp_path / "xdg-config"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg))
    return cfg


def _make_result(threshold: float = 0.31) -> TuneResult:
    return TuneResult(
        threshold=threshold,
        max_results=8,
        weights={"body_match": 0.30, "fuzzy": 0.18},
        study={"n_trials": 1000, "best_loss": 14.2, "saved_at": "2026-05-06T20:00:00"},
    )


def test_save_and_load_roundtrip(isolated_xdg: Path) -> None:
    profile = "personal"
    saved_path = save_result(profile, _make_result(), filename="custom.json")
    assert saved_path.is_file()
    assert saved_path.parent == results_dir(profile)

    loaded = load_result(profile, "custom.json")
    assert loaded.threshold == 0.31
    assert loaded.max_results == 8
    assert loaded.weights == {"body_match": 0.30, "fuzzy": 0.18}
    assert loaded.study["n_trials"] == 1000


def test_save_uses_timestamp_filename_when_omitted(isolated_xdg: Path) -> None:
    import re

    saved_path = save_result("p", _make_result())
    assert saved_path.suffix == ".json"
    # Shape: YYYY-MM-DDTHH-MM-SS.json
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json", saved_path.name)


def test_save_refuses_to_overwrite(isolated_xdg: Path) -> None:
    save_result("p", _make_result(), filename="dup.json")
    with pytest.raises(FileExistsError):
        save_result("p", _make_result(), filename="dup.json")


def test_load_missing_raises(isolated_xdg: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_result("p", "nope.json")


def test_list_results_newest_first_with_ad_hoc_after(isolated_xdg: Path) -> None:
    save_result("p", _make_result(), filename="2026-05-04T09-12-44.json")
    save_result("p", _make_result(), filename="2026-05-06T21-30-00.json")
    save_result("p", _make_result(), filename="experiment_a.json")
    assert list_results("p") == [
        "2026-05-06T21-30-00.json",  # newest timestamp first
        "2026-05-04T09-12-44.json",
        "experiment_a.json",  # ad-hoc after history
    ]


def test_list_results_empty_for_unseen_profile(isolated_xdg: Path) -> None:
    assert list_results("never_used") == []


def test_active_pointer_read_write_round_trip(isolated_xdg: Path) -> None:
    cfg = isolated_xdg / "ipa" / "config.yaml"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(
        yaml.safe_dump(
            {
                "default_profile": "p",
                "profiles": {"p": {"vault_path": "/tmp/v"}},
            }
        ),
        encoding="utf-8",
    )
    assert read_active_result_filename("p", cfg) is None

    write_active_result_filename("p", "2026-05-06T21-30-00.json", cfg)
    assert read_active_result_filename("p", cfg) == "2026-05-06T21-30-00.json"

    # other keys preserved
    data = yaml.safe_load(cfg.read_text(encoding="utf-8"))
    assert data["profiles"]["p"]["vault_path"] == "/tmp/v"


def test_active_pointer_preserves_yaml_comments(isolated_xdg: Path) -> None:
    """ruamel round-trip — comments must survive write_active_result_filename."""
    cfg = isolated_xdg / "ipa" / "config.yaml"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(
        "# top-level comment\n"
        "default_profile: p\n"
        "profiles:\n"
        "  p:\n"
        "    vault_path: /tmp/v  # inline\n",
        encoding="utf-8",
    )
    write_active_result_filename("p", "2026-05-06T21-30-00.json", cfg)
    text = cfg.read_text(encoding="utf-8")
    assert "# top-level comment" in text
    assert "# inline" in text
    assert "result_file" in text


def test_resolve_active_falls_back_to_none_when_file_missing(
    isolated_xdg: Path,
) -> None:
    cfg = isolated_xdg / "ipa" / "config.yaml"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(
        yaml.safe_dump(
            {
                "default_profile": "p",
                "profiles": {"p": {"tune": {"result_file": "missing.json"}}},
            }
        ),
        encoding="utf-8",
    )
    # Pointer is set but file doesn't exist → resolve returns None (caller warns).
    assert resolve_active_result("p", cfg) is None


def test_resolve_active_returns_loaded_result(isolated_xdg: Path) -> None:
    save_result("p", _make_result(threshold=0.42), filename="active.json")
    cfg = isolated_xdg / "ipa" / "config.yaml"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(
        yaml.safe_dump(
            {
                "default_profile": "p",
                "profiles": {"p": {"tune": {"result_file": "active.json"}}},
            }
        ),
        encoding="utf-8",
    )
    resolved = resolve_active_result("p", cfg)
    assert resolved is not None
    assert resolved.threshold == 0.42


def test_timestamp_filename_uses_utc_no_colons() -> None:
    fixed = datetime(2026, 5, 7, 3, 12, 44, tzinfo=timezone.utc)
    name = timestamp_filename(fixed)
    assert name == "2026-05-07T03-12-44.json"
    assert ":" not in name  # filesystem-safe

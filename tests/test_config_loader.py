"""Settings loader tests for the 2차 profile workspace contract."""

from __future__ import annotations

from pathlib import Path

import pytest

from ipa_cli.config.defaults import DEFAULT_THRESHOLD, DEFAULT_WEIGHTS
from ipa_cli.config.loader import list_profiles, load_settings, set_default_profile


@pytest.fixture
def isolated_xdg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    for key in list(__import__("os").environ.keys()):
        if key.startswith("IPA_"):
            monkeypatch.delenv(key, raising=False)
    root = tmp_path / "xdg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(root))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    return root


def _write_yaml(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path


def _profile_yaml(root: Path, name: str, body: str) -> Path:
    return _write_yaml(root / "ipa" / "profiles" / name / "profile.yaml", body)


def test_no_profile_selection_fails(isolated_xdg: Path) -> None:
    with pytest.raises(ValueError, match="No IPA profile selected"):
        load_settings(dotenv_path=isolated_xdg / "ipa" / ".env")


def test_profile_yaml_overrides_defaults(isolated_xdg: Path) -> None:
    _profile_yaml(
        isolated_xdg,
        "work",
        """
vault_path: /tmp/work-vault
search:
  threshold: 0.25
  weights:
    fuzzy: 0.5
""",
    )
    s = load_settings(profile="work", dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.profile == "work"
    assert s.vault_path == Path("/tmp/work-vault")
    assert s.search.threshold == 0.25
    assert s.search.weights["fuzzy"] == 0.5
    assert s.search.weights["body_match"] == DEFAULT_WEIGHTS["body_match"]
    assert s.source_map["vault_path"] == "profile.yaml"


def test_env_overrides_profile_yaml(
    isolated_xdg: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _profile_yaml(
        isolated_xdg,
        "personal",
        """
vault_path: /from/profile
search:
  threshold: 0.25
""",
    )
    monkeypatch.setenv("IPA_VAULT_PATH", "/from/env")
    monkeypatch.setenv("IPA_SEARCH_THRESHOLD", "0.42")
    monkeypatch.setenv("IPA_SEARCH_WEIGHTS_FUZZY", "0.99")
    s = load_settings(profile="personal", dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.vault_path == Path("/from/env")
    assert s.search.threshold == 0.42
    assert s.search.weights["fuzzy"] == 0.99
    assert s.source_map["vault_path"] == "env"
    assert s.source_map["search.threshold"] == "env"


def test_dotenv_loaded_when_process_env_missing(isolated_xdg: Path) -> None:
    env_file = isolated_xdg / "ipa" / ".env"
    env_file.parent.mkdir(parents=True)
    env_file.write_text("IPA_VAULT_PATH=/from/dotenv\n", encoding="utf-8")
    s = load_settings(profile="p", dotenv_path=env_file)
    assert s.vault_path == Path("/from/dotenv")


def test_cli_vault_uses_adhoc_profile_and_beats_env(
    isolated_xdg: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("IPA_VAULT_PATH", "/from/env")
    s = load_settings(vault="/from/cli", dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.profile == "adhoc"
    assert s.vault_path == Path("/from/cli")
    assert s.source_map["vault_path"] == "cli"


def test_cli_vault_overrides_dotipa_profile(isolated_xdg: Path, tmp_path: Path) -> None:
    """``--vault`` alone is an explicit ad-hoc run — it must skip
    ``.ipa-profile`` so the ad-hoc vault isn't mixed with another
    profile's search.py / convention.py / tune pointer / cache."""
    _profile_yaml(isolated_xdg, "project", "vault_path: /from/profile\n")
    project_dir = tmp_path / "repo"
    project_dir.mkdir()
    (project_dir / ".ipa-profile").write_text("project\n", encoding="utf-8")
    s = load_settings(
        vault="/from/cli",
        cwd=project_dir,
        dotenv_path=isolated_xdg / "ipa" / ".env",
    )
    assert s.profile == "adhoc"
    assert s.vault_path == Path("/from/cli")
    assert s.source_map["profile"] == "cli-vault"


def test_cli_vault_overrides_ipa_profile_env(
    isolated_xdg: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same isolation rule applies when ``IPA_PROFILE`` is set in env."""
    _profile_yaml(isolated_xdg, "envprof", "vault_path: /from/env-profile\n")
    monkeypatch.setenv("IPA_PROFILE", "envprof")
    s = load_settings(vault="/from/cli", dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.profile == "adhoc"
    assert s.vault_path == Path("/from/cli")
    assert s.source_map["profile"] == "cli-vault"


def test_cli_profile_with_cli_vault_keeps_profile(
    isolated_xdg: Path, tmp_path: Path
) -> None:
    """When both ``--profile`` and ``--vault`` are passed the explicit
    profile wins — only ``vault_path`` is overridden."""
    _profile_yaml(isolated_xdg, "work", "vault_path: /from/profile\n")
    project_dir = tmp_path / "repo"
    project_dir.mkdir()
    (project_dir / ".ipa-profile").write_text("other\n", encoding="utf-8")
    s = load_settings(
        profile="work",
        vault="/from/cli",
        cwd=project_dir,
        dotenv_path=isolated_xdg / "ipa" / ".env",
    )
    assert s.profile == "work"
    assert s.vault_path == Path("/from/cli")
    assert s.source_map["profile"] == "cli"
    assert s.source_map["vault_path"] == "cli"


def test_dotipa_profile_beats_env(
    isolated_xdg: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _profile_yaml(isolated_xdg, "project", "vault_path: /project\n")
    _profile_yaml(isolated_xdg, "envprof", "vault_path: /env\n")
    project_dir = tmp_path / "repo"
    project_dir.mkdir()
    (project_dir / ".ipa-profile").write_text("project\n", encoding="utf-8")
    monkeypatch.setenv("IPA_PROFILE", "envprof")
    s = load_settings(cwd=project_dir, dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.profile == "project"
    assert s.vault_path == Path("/project")
    assert s.source_map["profile"] == ".ipa-profile"


def test_ipa_profile_env_selects_profile(
    isolated_xdg: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _profile_yaml(isolated_xdg, "work", "vault_path: /work\n")
    monkeypatch.setenv("IPA_PROFILE", "work")
    s = load_settings(dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.profile == "work"
    assert s.vault_path == Path("/work")


def test_var_interpolation_in_profile_yaml(
    isolated_xdg: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _profile_yaml(isolated_xdg, "work", "vault_path: ${WORK_VAULT_PATH}\n")
    monkeypatch.setenv("WORK_VAULT_PATH", "/expanded/work")
    s = load_settings(profile="work", dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.vault_path == Path("/expanded/work")


def test_profile_cache_dir_lives_inside_workspace(isolated_xdg: Path) -> None:
    s = load_settings(profile="work", dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.profile_dir == isolated_xdg / "ipa" / "profiles" / "work"
    assert s.cache_dir == s.profile_dir / ".cache"


def test_set_default_profile_writes_dotipa(isolated_xdg: Path, tmp_path: Path) -> None:
    cfg = tmp_path / "repo" / "placeholder.yaml"
    cfg.parent.mkdir()
    set_default_profile("work", config_path=cfg)
    assert (cfg.parent / ".ipa-profile").read_text(encoding="utf-8") == "work\n"


def test_list_profiles_reads_workspace_dirs(isolated_xdg: Path) -> None:
    _profile_yaml(isolated_xdg, "b", "vault_path: /b\n")
    _profile_yaml(isolated_xdg, "a", "vault_path: /a\n")
    names, active = list_profiles()
    assert names == ["a", "b"]
    assert active is None


def test_active_tune_result_overrides_profile_yaml_search(
    isolated_xdg: Path,
) -> None:
    _profile_yaml(
        isolated_xdg,
        "work",
        """
vault_path: /tmp/work-vault
search:
  threshold: 0.99
tune:
  result_file: active.json
""",
    )

    from ipa_cli.tune import TuneResult, save_result

    save_result(
        "work",
        TuneResult(
            threshold=0.31,
            max_results=8,
            weights={"fuzzy": 0.18, "body_match": 0.30},
            study={"n_trials": 1000, "best_loss": 14.2},
        ),
        filename="active.json",
    )

    s = load_settings(profile="work", dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.search.threshold == 0.31
    assert s.search.max_results == 8
    assert s.search.weights["fuzzy"] == 0.18
    assert s.search.weights["body_match"] == 0.30
    assert s.source_map["search.threshold"] == "tune_result"


def test_env_overrides_active_tune_result(
    isolated_xdg: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _profile_yaml(isolated_xdg, "work", "tune:\n  result_file: active.json\n")

    from ipa_cli.tune import TuneResult, save_result

    save_result(
        "work",
        TuneResult(threshold=0.31, max_results=8, weights={"fuzzy": 0.18}),
        filename="active.json",
    )
    monkeypatch.setenv("IPA_SEARCH_THRESHOLD", "0.77")
    s = load_settings(profile="work", dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.search.threshold == 0.77
    assert s.source_map["search.threshold"] == "env"


def test_active_tune_result_missing_file_falls_back_to_profile_yaml(
    isolated_xdg: Path,
) -> None:
    _profile_yaml(
        isolated_xdg,
        "work",
        """
search:
  threshold: 0.42
tune:
  result_file: never-existed.json
""",
    )
    s = load_settings(profile="work", dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.search.threshold == 0.42
    assert s.search.weights == DEFAULT_WEIGHTS
    assert s.search.threshold != DEFAULT_THRESHOLD

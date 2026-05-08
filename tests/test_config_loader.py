"""Settings loader tests for profile registry + vault-local config."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from ipa_cli.config.defaults import DEFAULT_THRESHOLD, DEFAULT_WEIGHTS
from ipa_cli.config.loader import list_profiles, load_settings, set_default_profile
from ipa_cli.tune import TuneResult, save_result


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


def _profile_registry(root: Path, body: str) -> Path:
    return _write_yaml(root / "ipa" / "profile.yaml", body)


def _legacy_profile_yaml(root: Path, name: str, body: str) -> Path:
    return _write_yaml(root / "ipa" / "profiles" / name / "profile.yaml", body)


def _vault_config(vault: Path, body: str) -> Path:
    return _write_yaml(vault / ".ipa" / "config.yaml", body)


def test_no_profile_selection_fails_without_default(isolated_xdg: Path) -> None:
    _profile_registry(
        isolated_xdg,
        """
profiles:
  work:
    vault_path: /tmp/work-vault
""",
    )
    with pytest.raises(ValueError, match="No IPA profile selected"):
        load_settings(dotenv_path=isolated_xdg / "ipa" / ".env")


def test_default_profile_fallback_reads_registry(isolated_xdg: Path) -> None:
    _profile_registry(
        isolated_xdg,
        """
profiles:
  work:
    vault_path: /tmp/work-vault
    default: true
    search:
      threshold: 0.25
      weights:
        fuzzy: 0.5
""",
    )
    s = load_settings(dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.profile == "work"
    assert s.source_map["profile"] == "profile.yaml.default"
    assert s.vault_path == Path("/tmp/work-vault")
    assert s.cache_dir == Path("/tmp/work-vault/.ipa/cache/search")
    assert s.search.threshold == 0.25
    assert s.search.weights["fuzzy"] == 0.5
    assert s.search.weights["body_match"] == DEFAULT_WEIGHTS["body_match"]
    assert s.source_map["vault_path"] == "profile.yaml"


def test_explicit_profile_reads_registry(isolated_xdg: Path) -> None:
    _profile_registry(
        isolated_xdg,
        """
profiles:
  work:
    vault_path: /work
  personal:
    vault_path: /personal
""",
    )
    s = load_settings(profile="personal", dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.profile == "personal"
    assert s.vault_path == Path("/personal")


def test_env_overrides_profile_registry(
    isolated_xdg: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _profile_registry(
        isolated_xdg,
        """
profiles:
  personal:
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
    _profile_registry(
        isolated_xdg,
        "profiles:\n  project:\n    vault_path: /from/profile\n",
    )
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
    _profile_registry(
        isolated_xdg,
        "profiles:\n  envprof:\n    vault_path: /from/env-profile\n",
    )
    monkeypatch.setenv("IPA_PROFILE", "envprof")
    s = load_settings(vault="/from/cli", dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.profile == "adhoc"
    assert s.vault_path == Path("/from/cli")
    assert s.source_map["profile"] == "cli-vault"


def test_cli_profile_with_cli_vault_keeps_profile(
    isolated_xdg: Path, tmp_path: Path
) -> None:
    _profile_registry(
        isolated_xdg,
        "profiles:\n  work:\n    vault_path: /from/profile\n",
    )
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


def test_dotipa_profile_beats_env_and_default(
    isolated_xdg: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _profile_registry(
        isolated_xdg,
        """
profiles:
  project:
    vault_path: /project
  envprof:
    vault_path: /env
  defaulted:
    vault_path: /default
    default: true
""",
    )
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
    _profile_registry(isolated_xdg, "profiles:\n  work:\n    vault_path: /work\n")
    monkeypatch.setenv("IPA_PROFILE", "work")
    s = load_settings(dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.profile == "work"
    assert s.vault_path == Path("/work")


def test_var_interpolation_in_profile_registry(
    isolated_xdg: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _profile_registry(
        isolated_xdg,
        "profiles:\n  work:\n    vault_path: ${WORK_VAULT_PATH}\n",
    )
    monkeypatch.setenv("WORK_VAULT_PATH", "/expanded/work")
    s = load_settings(profile="work", dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.vault_path == Path("/expanded/work")


def test_legacy_profile_workspace_still_supported(isolated_xdg: Path) -> None:
    _legacy_profile_yaml(isolated_xdg, "work", "vault_path: /legacy\n")
    s = load_settings(profile="work", dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.profile_dir == isolated_xdg / "ipa" / "profiles" / "work"
    assert s.vault_path == Path("/legacy")
    assert s.cache_dir == Path("/legacy/.ipa/cache/search")
    assert s.source_map["vault_path"] == "profile_workspace"


def test_set_default_profile_updates_profile_yaml(isolated_xdg: Path) -> None:
    cfg = _profile_registry(
        isolated_xdg,
        """
profiles:
  work:
    vault_path: /work
  personal:
    vault_path: /personal
    default: true
""",
    )
    set_default_profile("work", config_path=cfg)
    data = yaml.safe_load(cfg.read_text(encoding="utf-8"))
    assert data["profiles"]["work"]["default"] is True
    assert data["profiles"]["personal"]["default"] is False


def test_list_profiles_reads_profile_yaml_registry(isolated_xdg: Path) -> None:
    _profile_registry(
        isolated_xdg,
        """
profiles:
  b:
    vault_path: /b
  a:
    vault_path: /a
    default: true
""",
    )
    names, active = list_profiles()
    assert names == ["a", "b"]
    assert active == "a"


def test_vault_config_exposes_test_and_weight_targets(isolated_xdg: Path) -> None:
    vault = isolated_xdg / "vault"
    testset = vault / ".ipa" / "tune" / "testsets" / "default.json"
    testset.parent.mkdir(parents=True)
    testset.write_text('{"cases": []}', encoding="utf-8")
    _profile_registry(
        isolated_xdg,
        f"""
profiles:
  work:
    vault_path: {vault}
    default: true
""",
    )
    _vault_config(
        vault,
        """
test:
  file: .ipa/tune/testsets/default.json
weights:
  file: .ipa/tune/results/active.json
""",
    )
    save_result(
        "work",
        TuneResult(
            threshold=0.31,
            max_results=8,
            weights={"fuzzy": 0.18, "body_match": 0.30},
            study={"n_trials": 1000, "best_loss": 14.2},
        ),
        filename="active.json",
        vault_path=vault,
    )

    s = load_settings(dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.testset_path == testset
    assert s.weight_result_path == vault / ".ipa" / "tune" / "results" / "active.json"
    assert s.search.threshold == 0.31
    assert s.search.max_results == 8
    assert s.search.weights["fuzzy"] == 0.18
    assert s.search.weights["body_match"] == 0.30
    assert s.source_map["search.threshold"] == "weights.file"


def test_env_overrides_vault_weight_result(
    isolated_xdg: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = isolated_xdg / "vault"
    _profile_registry(
        isolated_xdg,
        f"profiles:\n  work:\n    vault_path: {vault}\n    default: true\n",
    )
    _vault_config(vault, "weights:\n  file: active.json\n")
    save_result(
        "work",
        TuneResult(threshold=0.31, max_results=8, weights={"fuzzy": 0.18}),
        filename="active.json",
        vault_path=vault,
    )
    monkeypatch.setenv("IPA_SEARCH_THRESHOLD", "0.77")
    s = load_settings(dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.search.threshold == 0.77
    assert s.source_map["search.threshold"] == "env"


def test_missing_vault_weight_file_falls_back_to_registry_search(
    isolated_xdg: Path,
) -> None:
    vault = isolated_xdg / "vault"
    _profile_registry(
        isolated_xdg,
        f"""
profiles:
  work:
    vault_path: {vault}
    default: true
    search:
      threshold: 0.42
""",
    )
    _vault_config(vault, "weights:\n  file: missing.json\n")
    s = load_settings(dotenv_path=isolated_xdg / "ipa" / ".env")
    assert s.search.threshold == 0.42
    assert s.search.weights == DEFAULT_WEIGHTS
    assert s.search.threshold != DEFAULT_THRESHOLD
    assert "weights.file.warning" in s.source_map

"""Tests for config loader priority and resolution.

Priority (highest wins): CLI > env > .env > yaml > defaults.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ipa_cli.config.defaults import DEFAULT_THRESHOLD, DEFAULT_WEIGHTS
from ipa_cli.config.loader import list_profiles, load_settings, set_default_profile


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in list(__import__("os").environ.keys()):
        if key.startswith("IPA_"):
            monkeypatch.delenv(key, raising=False)


def _write_yaml(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path


def test_defaults_when_no_yaml_no_env(tmp_path: Path, clean_env: None) -> None:
    s = load_settings(
        config_path=tmp_path / "config.yaml",
        dotenv_path=tmp_path / ".env",
    )
    assert s.profile == "personal"
    assert s.vault_path == Path()
    assert s.search.threshold == DEFAULT_THRESHOLD
    assert s.search.weights == DEFAULT_WEIGHTS
    assert s.source_map["search.threshold"] == "default"


def test_yaml_overrides_defaults(tmp_path: Path, clean_env: None) -> None:
    cfg = _write_yaml(
        tmp_path / "config.yaml",
        """
default_profile: work
profiles:
  work:
    vault_path: /tmp/work-vault
    search:
      threshold: 0.25
      weights:
        fuzzy: 0.5
""",
    )
    s = load_settings(config_path=cfg, dotenv_path=tmp_path / ".env")
    assert s.profile == "work"
    assert s.vault_path == Path("/tmp/work-vault")
    assert s.search.threshold == 0.25
    assert s.search.weights["fuzzy"] == 0.5
    # unspecified weight should fall back to default
    assert s.search.weights["body_match"] == DEFAULT_WEIGHTS["body_match"]
    assert s.source_map["vault_path"] == "yaml"
    assert s.source_map["search.threshold"] == "yaml"


def test_env_overrides_yaml(
    tmp_path: Path, clean_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = _write_yaml(
        tmp_path / "config.yaml",
        """
default_profile: personal
profiles:
  personal:
    vault_path: /from/yaml
    search:
      threshold: 0.25
""",
    )
    monkeypatch.setenv("IPA_VAULT_PATH", "/from/env")
    monkeypatch.setenv("IPA_SEARCH_THRESHOLD", "0.42")
    monkeypatch.setenv("IPA_SEARCH_WEIGHTS_FUZZY", "0.99")
    s = load_settings(config_path=cfg, dotenv_path=tmp_path / ".env")
    assert s.vault_path == Path("/from/env")
    assert s.search.threshold == 0.42
    assert s.search.weights["fuzzy"] == 0.99
    assert s.source_map["vault_path"] == "env"
    assert s.source_map["search.threshold"] == "env"
    assert s.source_map["search.weights.fuzzy"] == "env"


def test_dotenv_loaded_when_process_env_missing(
    tmp_path: Path, clean_env: None
) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("IPA_VAULT_PATH=/from/dotenv\n", encoding="utf-8")
    s = load_settings(config_path=tmp_path / "config.yaml", dotenv_path=env_file)
    assert s.vault_path == Path("/from/dotenv")


def test_cli_override_beats_env(
    tmp_path: Path, clean_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("IPA_VAULT_PATH", "/from/env")
    s = load_settings(
        vault="/from/cli",
        config_path=tmp_path / "config.yaml",
        dotenv_path=tmp_path / ".env",
    )
    assert s.vault_path == Path("/from/cli")
    assert s.source_map["vault_path"] == "cli"


def test_profile_arg_overrides_default(tmp_path: Path, clean_env: None) -> None:
    cfg = _write_yaml(
        tmp_path / "config.yaml",
        """
default_profile: personal
profiles:
  personal:
    vault_path: /personal
  work:
    vault_path: /work
""",
    )
    s = load_settings(profile="work", config_path=cfg, dotenv_path=tmp_path / ".env")
    assert s.profile == "work"
    assert s.vault_path == Path("/work")


def test_ipa_profile_env_selects_profile(
    tmp_path: Path, clean_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = _write_yaml(
        tmp_path / "config.yaml",
        """
default_profile: personal
profiles:
  personal:
    vault_path: /personal
  work:
    vault_path: /work
""",
    )
    monkeypatch.setenv("IPA_PROFILE", "work")
    s = load_settings(config_path=cfg, dotenv_path=tmp_path / ".env")
    assert s.profile == "work"
    assert s.vault_path == Path("/work")


def test_var_interpolation_in_yaml(
    tmp_path: Path, clean_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = _write_yaml(
        tmp_path / "config.yaml",
        """
default_profile: work
profiles:
  work:
    vault_path: ${WORK_VAULT_PATH}
""",
    )
    monkeypatch.setenv("WORK_VAULT_PATH", "/expanded/work")
    s = load_settings(config_path=cfg, dotenv_path=tmp_path / ".env")
    assert s.vault_path == Path("/expanded/work")


def test_per_profile_cache_dir(tmp_path: Path, clean_env: None) -> None:
    s_personal = load_settings(
        profile="personal",
        config_path=tmp_path / "c.yaml",
        dotenv_path=tmp_path / ".env",
    )
    s_work = load_settings(
        profile="work",
        config_path=tmp_path / "c.yaml",
        dotenv_path=tmp_path / ".env",
    )
    assert s_personal.cache_dir != s_work.cache_dir
    assert s_personal.cache_dir.name == "personal"
    assert s_work.cache_dir.name == "work"


def test_set_default_profile_round_trip(tmp_path: Path, clean_env: None) -> None:
    cfg = tmp_path / "config.yaml"
    set_default_profile("work", config_path=cfg)
    names, default = list_profiles(cfg)
    assert default == "work"
    assert "work" in names

    s = load_settings(config_path=cfg, dotenv_path=tmp_path / ".env")
    assert s.profile == "work"

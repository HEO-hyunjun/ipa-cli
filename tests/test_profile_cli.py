"""CLI tests for profile commands."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from typer.testing import CliRunner

from ipa_cli.main import app


@pytest.fixture
def isolated_xdg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    for key in list(__import__("os").environ.keys()):
        if key.startswith("IPA_"):
            monkeypatch.delenv(key, raising=False)
    root = tmp_path / "xdg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(root))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    return root


def test_profile_current_prints_profile_and_vault_path(isolated_xdg: Path) -> None:
    vault = isolated_xdg.parent / "vault"
    cfg = isolated_xdg / "ipa" / "profile.yaml"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(
        yaml.safe_dump(
            {
                "profiles": {
                    "work": {
                        "vault_path": str(vault),
                        "default": True,
                    }
                }
            }
        ),
        encoding="utf-8",
    )

    result = CliRunner().invoke(app, ["profile", "current"])

    assert result.exit_code == 0, result.stdout
    assert result.stdout == f"profile: work\nvault_path: {vault}\n"

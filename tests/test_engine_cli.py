"""CLI tests for `ipa engine` group (P4 iter4)."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from typer.testing import CliRunner

from ipa_cli.main import app


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    """Build a tiny vault: 00 Inbox / 01 Project layout with two notes."""
    inbox = tmp_path / "00 Inbox"
    project = tmp_path / "01 Project" / "Topic"
    inbox.mkdir(parents=True)
    project.mkdir(parents=True)

    (inbox / "alpha note.md").write_text(
        "---\ntype: note\nref:\n  - '[[🏷️ Topic Root]]'\n---\nalpha body keyword\n",
        encoding="utf-8",
    )
    (project / "🏷️ Topic Root.md").write_text(
        "---\ntype: root\n---\nproject root body\n", encoding="utf-8"
    )
    return tmp_path


@pytest.fixture
def isolated_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point XDG_CONFIG_HOME and XDG_CACHE_HOME at tmp so we don't touch
    the user's config or cache directories."""
    cfg_root = tmp_path / "xdg"
    cache_root = tmp_path / "xdg-cache"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg_root))
    monkeypatch.setenv("XDG_CACHE_HOME", str(cache_root))
    monkeypatch.delenv("IPA_PROFILE", raising=False)
    monkeypatch.delenv("IPA_VAULT_PATH", raising=False)
    return cfg_root


def test_engine_channels_lists_default_set(vault: Path, isolated_config: Path) -> None:
    runner = CliRunner()
    result = runner.invoke(app, ["--vault", str(vault), "engine", "channels"])
    assert result.exit_code == 0, result.stdout
    out = result.stdout
    # All 9 default channels should appear by name.
    for name in [
        "fuzzy",
        "keyword",
        "filename",
        "sequence_match",
        "filename_partial",
        "body_match",
        "child_body_match",
        "related",
        "project",
    ]:
        assert name in out, f"channel {name!r} not in output:\n{out}"


def test_engine_search_returns_hits(vault: Path, isolated_config: Path) -> None:
    runner = CliRunner()
    result = runner.invoke(app, ["--vault", str(vault), "engine", "search", "alpha"])
    assert result.exit_code == 0, result.stdout
    assert "alpha note" in result.stdout


def test_engine_search_only_filters_channels(
    vault: Path, isolated_config: Path
) -> None:
    runner = CliRunner()
    result = runner.invoke(
        app,
        [
            "--vault",
            str(vault),
            "engine",
            "search",
            "alpha",
            "--only",
            "filename",
        ],
    )
    assert result.exit_code == 0, result.stdout
    assert "channels[/bold] 1" in result.stdout or "channels 1" in result.stdout


def test_engine_search_only_unknown_channel_errors(
    vault: Path, isolated_config: Path
) -> None:
    runner = CliRunner()
    result = runner.invoke(
        app,
        ["--vault", str(vault), "engine", "search", "x", "--only", "nope"],
    )
    assert result.exit_code != 0


def test_engine_search_explain_shows_raw_scores(
    vault: Path, isolated_config: Path
) -> None:
    runner = CliRunner()
    result = runner.invoke(
        app,
        ["--vault", str(vault), "engine", "search", "alpha", "--explain"],
    )
    assert result.exit_code == 0, result.stdout
    assert "raw=" in result.stdout


def test_engine_search_weight_override(vault: Path, isolated_config: Path) -> None:
    runner = CliRunner()
    result = runner.invoke(
        app,
        [
            "--vault",
            str(vault),
            "engine",
            "search",
            "alpha",
            "--weight",
            "filename=2.0",
        ],
    )
    assert result.exit_code == 0, result.stdout


def test_engine_search_invalid_weight_format_errors(
    vault: Path, isolated_config: Path
) -> None:
    runner = CliRunner()
    result = runner.invoke(
        app,
        [
            "--vault",
            str(vault),
            "engine",
            "search",
            "alpha",
            "--weight",
            "no_equals_sign",
        ],
    )
    assert result.exit_code != 0


def test_engine_search_max_caps_results(vault: Path, isolated_config: Path) -> None:
    runner = CliRunner()
    result = runner.invoke(
        app,
        ["--vault", str(vault), "engine", "search", "body", "--max", "1"],
    )
    assert result.exit_code == 0, result.stdout


def test_engine_persists_parsed_cache_when_channel_uses_ast(
    vault: Path, isolated_config: Path
) -> None:
    """A profile whose search.py touches Note.body_ast triggers cache persist."""
    profile_dir = isolated_config / "ipa" / "profiles" / "ast-channel"
    profile_dir.mkdir(parents=True)
    (profile_dir / "search.py").write_text(
        """from typing import ClassVar
from ipa_cli.api.base_channels import BaseSearchChannel


class AstChannel(BaseSearchChannel):
    name: ClassVar[str] = "ast_probe"
    description: ClassVar[str] = "touches body_ast to trigger parse"
    default_weight: ClassVar[float] = 1.0

    def search(self, ctx, query):
        # Force body_ast build for every note.
        return {n.id: float(len(n.headings)) for n in ctx.notes}


channels = [AstChannel()]
""",
        encoding="utf-8",
    )
    (profile_dir / "profile.yaml").write_text(
        yaml.safe_dump({"vault_path": str(vault)}), encoding="utf-8"
    )

    runner = CliRunner()
    result = runner.invoke(
        app, ["--profile", "ast-channel", "engine", "search", "alpha"]
    )
    assert result.exit_code == 0, result.stdout

    # Cache lives inside the profile workspace.
    cache_files = list((profile_dir / ".cache").rglob("parsed_index.pkl"))
    assert cache_files, (
        "parsed_index.pkl should be written when a channel touches body_ast"
    )


def test_engine_uses_profile_search_py(
    vault: Path, isolated_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Custom profile's search.py overrides the default channel set."""
    profile_dir = isolated_config / "ipa" / "profiles" / "test-engine"
    profile_dir.mkdir(parents=True)
    (profile_dir / "search.py").write_text(
        """from typing import ClassVar
from ipa_cli.api.base_channels import BaseSearchChannel


class StubChannel(BaseSearchChannel):
    name: ClassVar[str] = "stub_only"
    description: ClassVar[str] = "test stub"
    default_weight: ClassVar[float] = 1.0

    def search(self, ctx, query):
        return {n.id: 1.0 for n in ctx.notes}


channels = [StubChannel()]
""",
        encoding="utf-8",
    )
    (profile_dir / "profile.yaml").write_text(
        yaml.safe_dump({"vault_path": str(vault)}), encoding="utf-8"
    )

    runner = CliRunner()
    result = runner.invoke(app, ["--profile", "test-engine", "engine", "channels"])
    assert result.exit_code == 0, result.stdout
    assert "stub_only" in result.stdout
    # The default 9 channels must NOT appear when search.py replaces them.
    assert "fuzzy" not in result.stdout.lower()

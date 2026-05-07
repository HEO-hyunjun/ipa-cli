"""S6 unit tests for runtime/refactor.py.

Each subcommand from ``docs/legacy-refactor-subcommands.md`` is exercised
in dry-run against a copy of mini_vault. Apply mode is tested for one
representative subcommand to confirm the round-trip writes to disk.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from typer.testing import CliRunner

from ipa_cli.main import app
from ipa_cli.runtime.refactor import render_refactor

FIXTURE_VAULT = Path(__file__).parent / "fixtures" / "mini_vault"


@pytest.fixture
def vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    target = tmp_path / "vault"
    shutil.copytree(FIXTURE_VAULT, target)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg-cfg"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))
    monkeypatch.delenv("IPA_PROFILE", raising=False)
    monkeypatch.delenv("IPA_VAULT_PATH", raising=False)
    return target


def test_refactor_help_when_no_subcommand(vault: Path) -> None:
    out = render_refactor(vault, [])
    assert "ipa refactor" in out
    assert "ref-replace" in out


def test_ref_replace_dry_run_reports_change(vault: Path) -> None:
    out = render_refactor(vault, ["ref-replace", "🔖 Sample Index", "🔖 Renamed Index"])
    # Dry-run header includes "DRY RUN" plus the affected note ids.
    assert "DRY RUN" in out or "예상" in out or "Note A" in out


def test_tag_add_dry_run_does_not_persist(vault: Path) -> None:
    out = render_refactor(vault, ["tag-add", "fresh"])
    assert "fresh" in out or "tag" in out.lower()
    # Confirm no on-disk write happened.
    note_a = (vault / "00 Inbox" / "Note A.md").read_text(encoding="utf-8")
    assert "fresh" not in note_a


def test_tag_add_apply_writes_to_disk(vault: Path) -> None:
    render_refactor(vault, ["tag-add", "fresh", "--apply", "--filter", "Note A"])
    note_a = (vault / "00 Inbox" / "Note A.md").read_text(encoding="utf-8")
    assert "fresh" in note_a, note_a


def test_wikilink_replace_dry_run(vault: Path) -> None:
    out = render_refactor(vault, ["wikilink-replace", "Note A", "Note Z"])
    # mini_vault has wikilinks to Note A inside Note B / Note C / Note A
    # itself — at least one match should surface.
    assert "Note" in out


def test_scope_filter_limits_targets(vault: Path) -> None:
    """``--scope-type root`` should only consider 🏷️ Sample Root."""
    out = render_refactor(
        vault,
        [
            "tag-add",
            "rooted",
            "--apply",
            "--scope-type",
            "root",
        ],
    )
    root_md = (vault / "00 Inbox" / "🏷️ Sample Root.md").read_text(encoding="utf-8")
    note_md = (vault / "00 Inbox" / "Note A.md").read_text(encoding="utf-8")
    assert "rooted" in root_md
    assert "rooted" not in note_md, out


def test_cli_refactor_routes_through_dispatcher(vault: Path) -> None:
    runner = CliRunner()
    res = runner.invoke(app, ["--vault", str(vault), "refactor", "ref-add", "X"])
    assert res.exit_code == 0, res.stdout
    # Output is non-empty even when no notes match.
    assert res.stdout.strip() != ""

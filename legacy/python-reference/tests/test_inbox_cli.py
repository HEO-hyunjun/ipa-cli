"""CLI tests for `ipa inbox add` and top-level `ipa add`."""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from ipa_cli.main import app


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    (tmp_path / "00 Inbox").mkdir(parents=True)
    (tmp_path / "02 Archive").mkdir(parents=True)
    return tmp_path


@pytest.fixture(autouse=True)
def isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg-config"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))
    monkeypatch.delenv("IPA_PROFILE", raising=False)
    monkeypatch.delenv("IPA_VAULT_PATH", raising=False)


def test_inbox_add_formats_and_moves_file(vault: Path, tmp_path: Path) -> None:
    src = tmp_path / "draft.md"
    src.write_text("# Draft\n\nbody\n", encoding="utf-8")

    result = CliRunner().invoke(
        app,
        [
            "--vault",
            str(vault),
            "inbox",
            "add",
            str(src),
            "--title",
            "New Note",
            "--ref",
            "🔖 ipa-cli",
            "--tag",
            "design_doc",
        ],
    )

    assert result.exit_code == 0, result.stdout
    assert not src.exists()
    dest = vault / "00 Inbox" / "New Note.md"
    assert dest.is_file()
    text = dest.read_text(encoding="utf-8")
    assert "date_created:" in text
    assert "date_modified:" in text
    assert "obsidianUIMode: preview" in text
    assert "type: note" in text
    assert '[[🔖 ipa-cli]]' in text
    assert "design_doc" in text
    assert "# Draft" in text
    assert "00 Inbox/New Note.md" in result.stdout


def test_top_level_add_alias_uses_inbox_add(vault: Path, tmp_path: Path) -> None:
    src = tmp_path / "alias.md"
    src.write_text("body\n", encoding="utf-8")

    result = CliRunner().invoke(
        app,
        ["--vault", str(vault), "add", str(src), "--title", "Alias Note"],
    )

    assert result.exit_code == 0, result.stdout
    assert not src.exists()
    assert (vault / "00 Inbox" / "Alias Note.md").is_file()


def test_inbox_add_reports_path_when_vault_is_symlink(tmp_path: Path) -> None:
    actual_vault = tmp_path / "actual-vault"
    (actual_vault / "00 Inbox").mkdir(parents=True)
    link_vault = tmp_path / "vault-link"
    try:
        link_vault.symlink_to(actual_vault, target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"symlink unavailable: {exc}")

    src = tmp_path / "symlink.md"
    src.write_text("body\n", encoding="utf-8")

    result = CliRunner().invoke(
        app,
        ["--vault", str(link_vault), "inbox", "add", str(src), "--title", "Symlink Note"],
    )

    assert result.exit_code == 0, result.stdout
    assert not src.exists()
    assert (actual_vault / "00 Inbox" / "Symlink Note.md").is_file()
    assert "00 Inbox/Symlink Note.md" in result.stdout


def test_inbox_add_fails_on_destination_collision(vault: Path, tmp_path: Path) -> None:
    src = tmp_path / "Draft.md"
    src.write_text("new body\n", encoding="utf-8")
    (vault / "00 Inbox" / "Draft.md").write_text("existing\n", encoding="utf-8")

    result = CliRunner().invoke(app, ["--vault", str(vault), "inbox", "add", str(src)])

    assert result.exit_code != 0
    assert "E_INBOX_DEST_EXISTS" in result.stdout
    assert src.exists(), "source is preserved when move fails"
    assert (vault / "00 Inbox" / "Draft.md").read_text(encoding="utf-8") == "existing\n"


def test_inbox_add_fails_on_vault_wide_basename_collision(
    vault: Path, tmp_path: Path
) -> None:
    src = tmp_path / "Draft.md"
    src.write_text("new body\n", encoding="utf-8")
    (vault / "02 Archive" / "Draft.md").write_text("archive existing\n", encoding="utf-8")

    result = CliRunner().invoke(app, ["--vault", str(vault), "inbox", "add", str(src)])

    assert result.exit_code != 0
    assert "E_INBOX_DEST_EXISTS" in result.stdout
    assert src.exists(), "source is preserved when move fails"
    assert not (vault / "00 Inbox" / "Draft.md").exists()

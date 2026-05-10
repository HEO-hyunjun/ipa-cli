"""CLI tests for tune search log, replay, pruning, and query packs."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from typer.testing import CliRunner

from ipa_cli.main import app


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    inbox = tmp_path / "00 Inbox"
    inbox.mkdir(parents=True)
    (inbox / "alpha note.md").write_text(
        "---\ntype: note\n---\nalpha body keyword\n", encoding="utf-8"
    )
    log_dir = tmp_path / ".ipa" / "tune" / "logs"
    log_dir.mkdir(parents=True)
    (log_dir / "search-events.jsonl").write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "schema_version": 1,
                        "event_id": "old-event",
                        "created_at": "2000-01-01T00:00:00+00:00",
                        "actor": "codex",
                        "turn_id": "turn-old",
                        "user_query": "오래된 질문",
                        "agent_search_query": "old query",
                        "queries": ["old query"],
                        "results": [],
                    },
                    ensure_ascii=False,
                ),
                json.dumps(
                    {
                        "schema_version": 1,
                        "event_id": "search-alpha",
                        "created_at": datetime.now(timezone.utc).isoformat(),
                        "actor": "codex",
                        "turn_id": "turn-new",
                        "user_query": "알파 노트 찾아줘",
                        "agent_search_query": "alpha",
                        "queries": ["alpha"],
                        "results": [
                            {
                                "rank": 1,
                                "note": "00 Inbox/alpha note.md",
                                "title": "alpha note",
                                "total_score": 1.0,
                                "channel_scores": {"keyword": 1.0},
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    return tmp_path


@pytest.fixture(autouse=True)
def isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg-config"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))
    monkeypatch.delenv("IPA_PROFILE", raising=False)
    monkeypatch.delenv("IPA_VAULT_PATH", raising=False)


def test_tune_log_list_show_and_sample(vault: Path) -> None:
    runner = CliRunner()

    listed = runner.invoke(app, ["--vault", str(vault), "tune", "log", "list"])
    shown = runner.invoke(
        app, ["--vault", str(vault), "tune", "log", "show", "search-alpha"]
    )
    sampled = runner.invoke(
        app,
        [
            "--vault",
            str(vault),
            "tune",
            "log",
            "sample",
            "--limit",
            "1",
            "--strategy",
            "recent",
            "--format",
            "markdown",
        ],
    )

    assert listed.exit_code == 0, listed.stdout
    assert "search-alpha" in listed.stdout
    assert shown.exit_code == 0, shown.stdout
    assert "알파 노트 찾아줘" in shown.stdout
    assert "alpha note" in shown.stdout
    assert sampled.exit_code == 0, sampled.stdout
    assert "User query" in sampled.stdout
    assert "AI search query" in sampled.stdout


def test_tune_log_prune_dry_run_and_apply(vault: Path) -> None:
    runner = CliRunner()

    dry = runner.invoke(
        app,
        [
            "--vault",
            str(vault),
            "tune",
            "log",
            "prune",
            "--older-than",
            "30d",
            "--dry-run",
        ],
    )
    assert dry.exit_code == 0, dry.stdout
    assert "old-event" in dry.stdout

    applied = runner.invoke(
        app,
        ["--vault", str(vault), "tune", "log", "prune", "--older-than", "30d"],
    )
    assert applied.exit_code == 0, applied.stdout

    lines = (
        vault / ".ipa" / "tune" / "logs" / "search-events.jsonl"
    ).read_text(encoding="utf-8")
    assert "old-event" not in lines
    assert "search-alpha" in lines


def test_tune_replay_event_uses_current_search_engine(vault: Path) -> None:
    result = CliRunner().invoke(
        app, ["--vault", str(vault), "tune", "replay", "search-alpha"]
    )

    assert result.exit_code == 0, result.stdout
    assert "current rank" in result.stdout
    assert "alpha note" in result.stdout


def test_tune_pack_create_add_eval(vault: Path) -> None:
    runner = CliRunner()

    created = runner.invoke(app, ["--vault", str(vault), "tune", "pack", "create", "core"])
    added = runner.invoke(
        app,
        [
            "--vault",
            str(vault),
            "tune",
            "pack",
            "add",
            "core",
            "--event",
            "search-alpha",
            "--target",
            "alpha note",
        ],
    )
    evaluated = runner.invoke(
        app, ["--vault", str(vault), "tune", "pack", "eval", "core"]
    )

    assert created.exit_code == 0, created.stdout
    assert added.exit_code == 0, added.stdout
    assert evaluated.exit_code == 0, evaluated.stdout
    assert "1/1" in evaluated.stdout

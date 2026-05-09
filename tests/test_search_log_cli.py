"""Search event log tests for AI-agent search calls."""

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
        "---\n"
        "type: note\n"
        "ref:\n"
        "  - '[[🔖 Sample Index]]'\n"
        "---\n"
        "alpha body keyword\n",
        encoding="utf-8",
    )
    return tmp_path


@pytest.fixture(autouse=True)
def isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg-config"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))
    monkeypatch.delenv("IPA_PROFILE", raising=False)
    monkeypatch.delenv("IPA_VAULT_PATH", raising=False)
    monkeypatch.delenv("IPA_SEARCH_LOG", raising=False)
    monkeypatch.delenv("IPA_SEARCH_ACTOR", raising=False)
    monkeypatch.delenv("IPA_SEARCH_CONTEXT_AUTO", raising=False)
    monkeypatch.delenv("IPA_SEARCH_CONTEXT_DIR", raising=False)
    return tmp_path


def _events(vault: Path) -> list[dict]:
    path = vault / ".ipa" / "tune" / "logs" / "search-events.jsonl"
    assert path.is_file()
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _write_context(root: Path, *, actor: str = "codex", ttl: int = 1800) -> Path:
    path = root / actor / "current.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "agent": actor,
                "turn_id": "turn-1",
                "created_at": datetime.now(timezone.utc).isoformat(),
                "ttl_seconds": ttl,
                "user_query": "사용자가 원래 물어본 질문",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return path


def test_ipa_search_logs_agent_query_with_turn_context(
    vault: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    context_dir = tmp_path / "search-context"
    context_file = _write_context(context_dir)
    monkeypatch.setenv("IPA_SEARCH_LOG", "1")
    monkeypatch.setenv("IPA_SEARCH_ACTOR", "codex")
    monkeypatch.setenv("IPA_SEARCH_CONTEXT_AUTO", "1")
    monkeypatch.setenv("IPA_SEARCH_CONTEXT_DIR", str(context_dir))

    runner = CliRunner()
    first = runner.invoke(app, ["--vault", str(vault), "search", "alpha"])
    second = runner.invoke(app, ["--vault", str(vault), "search", "keyword"])

    assert first.exit_code == 0, first.stdout
    assert second.exit_code == 0, second.stdout
    assert context_file.exists(), "turn context is reused within the same turn"

    events = _events(vault)
    assert len(events) == 2
    assert {event["turn_id"] for event in events} == {"turn-1"}
    assert events[0]["actor"] == "codex"
    assert events[0]["user_query"] == "사용자가 원래 물어본 질문"
    assert events[0]["agent_search_query"] == "alpha"
    assert events[0]["queries"] == ["alpha"]
    assert events[0]["results"][0]["title"] == "alpha note"
    assert events[0]["results"][0]["note"] == "00 Inbox/alpha note.md"
    assert events[0]["results"][0]["channel_scores"]


def test_ipa_search_ignores_expired_turn_context(
    vault: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    context_dir = tmp_path / "search-context"
    path = context_dir / "codex" / "current.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "agent": "codex",
                "turn_id": "expired",
                "created_at": "2000-01-01T00:00:00+00:00",
                "ttl_seconds": 1,
                "user_query": "오래된 질문",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("IPA_SEARCH_LOG", "1")
    monkeypatch.setenv("IPA_SEARCH_ACTOR", "codex")
    monkeypatch.setenv("IPA_SEARCH_CONTEXT_AUTO", "1")
    monkeypatch.setenv("IPA_SEARCH_CONTEXT_DIR", str(context_dir))

    result = CliRunner().invoke(app, ["--vault", str(vault), "search", "alpha"])

    assert result.exit_code == 0, result.stdout
    event = _events(vault)[0]
    assert event["turn_id"] is None
    assert event["user_query"] is None


def test_ipa_search_without_logging_env_does_not_create_log(vault: Path) -> None:
    result = CliRunner().invoke(app, ["--vault", str(vault), "search", "alpha"])

    assert result.exit_code == 0, result.stdout
    assert not (vault / ".ipa" / "tune" / "logs" / "search-events.jsonl").exists()

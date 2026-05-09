"""Search event logging helpers for AI-agent `ipa search` calls."""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ipa_cli import __version__

_TRUE_VALUES = {"1", "true", "yes", "on"}
_DURATION_RE = re.compile(r"^(\d+)([dhm])$")


def truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in _TRUE_VALUES


def log_path(vault_path: Path) -> Path:
    return vault_path / ".ipa" / "tune" / "logs" / "search-events.jsonl"


def querypack_dir(vault_path: Path) -> Path:
    return vault_path / ".ipa" / "tune" / "querypacks"


def drafts_dir(vault_path: Path) -> Path:
    return vault_path / ".ipa" / "tune" / "testsets" / "drafts"


def read_events(vault_path: Path) -> list[dict[str, Any]]:
    path = log_path(vault_path)
    if not path.is_file():
        return []
    events: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        payload = json.loads(line)
        if isinstance(payload, dict):
            events.append(payload)
    return events


def write_events(vault_path: Path, events: list[dict[str, Any]]) -> None:
    path = log_path(vault_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events)
    path.write_text(text, encoding="utf-8")


def find_event(vault_path: Path, event_id: str) -> dict[str, Any]:
    for event in read_events(vault_path):
        if event.get("event_id") == event_id:
            return event
    raise KeyError(event_id)


def append_event(vault_path: Path, event: dict[str, Any]) -> None:
    path = log_path(vault_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())


def should_log_search(*, explicit: bool = False) -> bool:
    return explicit or truthy(os.environ.get("IPA_SEARCH_LOG"))


def load_turn_context(
    *,
    actor: str | None = None,
    context_path: Path | None = None,
    default_ttl_seconds: int = 1800,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    if context_path is None and not truthy(os.environ.get("IPA_SEARCH_CONTEXT_AUTO")):
        return None

    actor = actor or os.environ.get("IPA_SEARCH_ACTOR") or "agent"
    if context_path is None:
        root = Path(
            os.environ.get("IPA_SEARCH_CONTEXT_DIR", "~/.cache/ipa/search-context")
        ).expanduser()
        candidates = [root / actor / "current.json", root / "current.json"]
    else:
        candidates = [context_path.expanduser()]

    path = next((p for p in candidates if p.is_file()), None)
    if path is None:
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None

    created_at = _parse_datetime(data.get("created_at"))
    ttl = int(data.get("ttl_seconds") or default_ttl_seconds)
    if created_at is not None:
        current = now or datetime.now(timezone.utc)
        if current - created_at > timedelta(seconds=ttl):
            return None
    return data


def build_event(
    *,
    settings,
    queries: list[str],
    threshold: float,
    max_results: int,
    show_all: bool,
    reasons: bool,
    hits,
    notes,
    cut_count: int,
    actor: str | None,
    context: dict[str, Any] | None,
) -> dict[str, Any]:
    created = datetime.now(timezone.utc)
    notes_by_id = {n.id: n for n in notes}
    agent_query = " + ".join(queries)
    event_id = f"search_{created.strftime('%Y%m%d_%H%M%S_%f')}"
    return {
        "schema_version": 1,
        "event_id": event_id,
        "created_at": created.isoformat(),
        "profile": settings.profile,
        "actor": actor or os.environ.get("IPA_SEARCH_ACTOR") or "agent",
        "turn_id": (context or {}).get("turn_id"),
        "user_query": (context or {}).get("user_query"),
        "agent_search_query": agent_query,
        "queries": list(queries),
        "options": {
            "threshold": threshold,
            "max_results": max_results,
            "show_all": show_all,
            "reasons": reasons,
            "cut_count": cut_count,
        },
        "engine": {
            "core_version": __version__,
            "weights": dict(settings.search.weights),
        },
        "results": [
            _event_result(hit, notes_by_id.get(hit.note_id), settings.vault_path)
            for hit in hits
        ],
    }


def _event_result(hit, note, vault_path: Path) -> dict[str, Any]:
    rel = None
    if note is not None:
        try:
            rel = str(note.path.relative_to(vault_path))
        except ValueError:
            rel = str(note.path)
    channel_scores = {}
    channel_raw = {}
    for ch_name, payload in (hit.explanations or {}).items():
        channel_scores[ch_name] = float(
            payload.get("weighted", payload.get("raw", 0.0)) or 0.0
        )
        channel_raw[ch_name] = float(payload.get("raw", 0.0) or 0.0)
    return {
        "rank": 0,  # filled below for stable JSON shape
        "note": rel or hit.note_id,
        "title": hit.note_id,
        "total_score": float(hit.score),
        "channel_scores": channel_scores,
        "channel_raw": channel_raw,
    }


def finalize_result_ranks(event: dict[str, Any]) -> dict[str, Any]:
    for idx, result in enumerate(event.get("results") or [], start=1):
        if isinstance(result, dict):
            result["rank"] = idx
    return event


def event_to_markdown(event: dict[str, Any]) -> str:
    lines = [
        f"## {event.get('event_id')}",
        "",
        "User query:",
        str(event.get("user_query") or ""),
        "",
        "AI search query:",
        str(event.get("agent_search_query") or ""),
        "",
        "Top results:",
    ]
    for item in event.get("results") or []:
        channels = item.get("channel_scores") or {}
        channel_text = ", ".join(
            f"{name} {value:.2f}" for name, value in sorted(channels.items())
        )
        lines.append(
            f"{item.get('rank')}. {item.get('title')} "
            f"(score: {float(item.get('total_score') or 0.0):.2f})"
        )
        if channel_text:
            lines.append(f"   channels: {channel_text}")
    lines.extend(
        [
            "",
            "Label:",
            "- 실제 타겟 노트:",
            "- AI 쿼리가 사용자 의도를 잘 반영했는가:",
            "- 실패 유형:",
        ]
    )
    return "\n".join(lines)


def sample_events(
    events: list[dict[str, Any]],
    *,
    strategy: str,
    limit: int,
) -> list[dict[str, Any]]:
    if strategy == "recent":
        ordered = sorted(events, key=lambda e: str(e.get("created_at") or ""), reverse=True)
        return ordered[:limit]
    if strategy == "repeated":
        counts: dict[str, int] = {}
        for event in events:
            key = str(event.get("user_query") or event.get("agent_search_query") or "")
            counts[key] = counts.get(key, 0) + 1
        return sorted(
            events,
            key=lambda e: counts.get(str(e.get("user_query") or e.get("agent_search_query") or ""), 0),
            reverse=True,
        )[:limit]
    if strategy == "low-confidence":
        return sorted(events, key=_score_gap)[:limit]
    # diverse/default: first event per user/agent query, newest first.
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for event in sample_events(events, strategy="recent", limit=len(events)):
        key = str(event.get("user_query") or event.get("agent_search_query") or "")
        if key in seen:
            continue
        seen.add(key)
        out.append(event)
        if len(out) >= limit:
            break
    return out


def _score_gap(event: dict[str, Any]) -> float:
    results = event.get("results") or []
    if len(results) < 2:
        return 999.0
    first = float(results[0].get("total_score") or 0.0)
    second = float(results[1].get("total_score") or 0.0)
    return abs(first - second)


def parse_duration(raw: str) -> timedelta:
    m = _DURATION_RE.match(raw.strip())
    if not m:
        raise ValueError("duration must look like 30d, 12h, or 10m")
    value = int(m.group(1))
    unit = m.group(2)
    if unit == "d":
        return timedelta(days=value)
    if unit == "h":
        return timedelta(hours=value)
    return timedelta(minutes=value)


def prune_events(
    events: list[dict[str, Any]],
    *,
    older_than: str,
    now: datetime | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cutoff = (now or datetime.now(timezone.utc)) - parse_duration(older_than)
    kept: list[dict[str, Any]] = []
    removed: list[dict[str, Any]] = []
    for event in events:
        created = _parse_datetime(event.get("created_at"))
        if created is not None and created < cutoff:
            removed.append(event)
        else:
            kept.append(event)
    return kept, removed


def _parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)

"""Inbox file intake: format a local file as an IPA Inbox note and move it."""

from __future__ import annotations

import os
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml

_BAD_FILENAME_CHARS = re.compile(r'[\\/:*?"<>|]')


class InboxAddError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


@dataclass(frozen=True)
class InboxAddResult:
    destination: Path
    rendered: str
    moved: bool


def add_file_to_inbox(
    source: Path,
    *,
    vault_path: Path,
    title: str | None = None,
    refs: list[str] | None = None,
    tags: list[str] | None = None,
    dry_run: bool = False,
) -> InboxAddResult:
    source = source.expanduser().resolve()
    vault_path = vault_path.expanduser().resolve()
    if not source.is_file():
        raise InboxAddError("E_INBOX_SOURCE_MISSING", f"source file not found: {source}")

    note_title = _clean_title(title or source.stem)
    destination = vault_path / "00 Inbox" / f"{note_title}.md"
    _ensure_no_collision(vault_path, destination, source)

    original = source.read_text(encoding="utf-8")
    rendered = format_inbox_note(
        original,
        refs=refs or [],
        tags=tags or [],
        now=datetime.now().strftime("%Y/%m/%d (%a) %H:%M:%S"),
    )
    if dry_run:
        return InboxAddResult(destination=destination, rendered=rendered, moved=False)

    destination.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(destination, flags, 0o644)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(rendered)
            f.flush()
            os.fsync(f.fileno())
    except Exception:
        try:
            destination.unlink(missing_ok=True)
        finally:
            raise

    source.unlink()
    return InboxAddResult(destination=destination, rendered=rendered, moved=True)


def format_inbox_note(
    text: str,
    *,
    refs: list[str],
    tags: list[str],
    now: str,
) -> str:
    existing_fm, body = _split_frontmatter(text)
    frontmatter: dict[str, Any] = {}
    if existing_fm:
        loaded = yaml.safe_load(existing_fm) or {}
        if isinstance(loaded, dict):
            frontmatter.update(loaded)

    frontmatter["date_created"] = frontmatter.get("date_created") or now
    frontmatter["date_modified"] = now
    frontmatter["ref"] = _merge_list(frontmatter.get("ref"), [_wikilink(r) for r in refs])
    frontmatter["obsidianUIMode"] = "preview"
    frontmatter["tags"] = _merge_list(frontmatter.get("tags"), tags)
    frontmatter["type"] = "note"

    dumped = yaml.safe_dump(
        frontmatter,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
    )
    if body and not body.endswith("\n"):
        body += "\n"
    return f"---\n{dumped}---\n{body}"


def _split_frontmatter(text: str) -> tuple[str, str]:
    if not text.startswith("---"):
        return "", text
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return "", text
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            fm = "".join(lines[1:idx])
            body = "".join(lines[idx + 1 :])
            return fm, body
    return "", text


def _merge_list(existing: Any, additions: list[str]) -> list[str]:
    out: list[str] = []
    for value in _as_list(existing) + [a for a in additions if a]:
        if value not in out:
            out.append(value)
    return out


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple)):
        return [str(v) for v in value if v is not None]
    return [str(value)]


def _wikilink(value: str) -> str:
    value = value.strip()
    if value.startswith("[[") and value.endswith("]]"):
        return value
    return f"[[{value}]]"


def _clean_title(raw: str) -> str:
    cleaned = _BAD_FILENAME_CHARS.sub("", raw).strip()
    if not cleaned:
        cleaned = f"Untitled {uuid.uuid4().hex[:8]}"
    return cleaned


def _ensure_no_collision(vault_path: Path, destination: Path, source: Path) -> None:
    wanted = destination.name.casefold()
    for existing in vault_path.rglob("*.md"):
        try:
            if existing.resolve() == source:
                continue
        except OSError:
            pass
        if existing.name.casefold() == wanted:
            raise InboxAddError(
                "E_INBOX_DEST_EXISTS",
                f"note filename already exists in vault: {existing}",
            )

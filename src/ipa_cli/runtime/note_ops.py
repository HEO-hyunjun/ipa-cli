"""Safe rename and move operations for vault notes."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from ipa_cli.api.mappings import Mapping
from ipa_cli.parse.note_model import Note
from ipa_cli.parse.vault_loader import load_notes


@dataclass(frozen=True)
class NoteOperationError(RuntimeError):
    message: str


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def plan_rename(vault_path: Path, mapping: Mapping, old: str, new: str) -> dict:
    vault = vault_path.expanduser().resolve()
    notes = load_notes(vault, mapping)
    source = _find_note(notes, old)
    _ensure_no_basename_collision(vault, f"{new}.md", ignore=source.path)
    dest = source.path.with_name(f"{new}.md")
    return {
        "version": 1,
        "kind": "rename",
        "old": old,
        "new": new,
        "file": {
            "from": source.path.relative_to(vault).as_posix(),
            "to": dest.relative_to(vault).as_posix(),
            "sha256": sha256_file(source.path),
        },
        "content_changes": _content_changes(vault, notes, mapping, old, new),
    }


def apply_rename(vault_path: Path, plan: dict) -> dict:
    vault = vault_path.expanduser().resolve()
    errors: list[dict] = []
    file_change = plan["file"]
    src = vault / file_change["from"]
    dest = vault / file_change["to"]
    if not src.is_file():
        errors.append({"path": file_change["from"], "error": "missing"})
    elif sha256_file(src) != file_change["sha256"]:
        errors.append({"path": file_change["from"], "error": "hash_changed"})
    elif dest.exists():
        errors.append({"path": file_change["to"], "error": "destination_exists"})
    if errors:
        return {"applied": [], "errors": errors}
    _apply_content_changes(vault, plan.get("content_changes") or [], errors)
    if errors:
        return {"applied": [], "errors": errors}
    dest.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dest)
    _invalidate_cache(vault)
    return {"applied": [file_change["from"], file_change["to"]], "errors": []}


def plan_move(vault_path: Path, mapping: Mapping, note_id: str, target_folder: str) -> dict:
    vault = vault_path.expanduser().resolve()
    notes = load_notes(vault, mapping)
    source = _find_note(notes, note_id)
    dest_folder = Path(target_folder)
    if dest_folder.is_absolute():
        dest_dir = dest_folder
    else:
        dest_dir = vault / dest_folder
    dest = dest_dir / source.path.name
    _ensure_no_basename_collision(vault, source.path.name, ignore=source.path)
    return {
        "version": 1,
        "kind": "move",
        "note": note_id,
        "file": {
            "from": source.path.relative_to(vault).as_posix(),
            "to": dest.relative_to(vault).as_posix(),
            "sha256": sha256_file(source.path),
        },
        "content_changes": [],
    }


def apply_move(vault_path: Path, plan: dict) -> dict:
    vault = vault_path.expanduser().resolve()
    errors: list[dict] = []
    file_change = plan["file"]
    src = vault / file_change["from"]
    dest = vault / file_change["to"]
    if not src.is_file():
        errors.append({"path": file_change["from"], "error": "missing"})
    elif sha256_file(src) != file_change["sha256"]:
        errors.append({"path": file_change["from"], "error": "hash_changed"})
    elif dest.exists():
        errors.append({"path": file_change["to"], "error": "destination_exists"})
    if errors:
        return {"applied": [], "errors": errors}
    dest.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dest)
    _invalidate_cache(vault)
    return {"applied": [file_change["from"], file_change["to"]], "errors": []}


def render_plan_or_result(payload: dict, *, json_output: bool = False) -> str:
    if json_output:
        return json.dumps(payload, ensure_ascii=False, indent=2)
    if "file" in payload:
        lines = [f"{payload['kind']}: {payload['file']['from']} -> {payload['file']['to']}"]
        lines.append(f"content_changes: {len(payload.get('content_changes') or [])}")
        return "\n".join(lines)
    lines = [f"applied: {len(payload.get('applied') or [])}"]
    for error in payload.get("errors") or []:
        lines.append(f"error {error['path']}: {error['error']}")
    return "\n".join(lines)


def _find_note(notes: list[Note], note_id: str) -> Note:
    for note in notes:
        if note.id == note_id:
            return note
    raise NoteOperationError(f"note not found: {note_id}")


def _ensure_no_basename_collision(
    vault_path: Path,
    basename: str,
    *,
    ignore: Path,
) -> None:
    wanted = basename.casefold()
    for path in vault_path.rglob("*.md"):
        if path.resolve() == ignore.resolve():
            continue
        if path.name.casefold() == wanted:
            raise NoteOperationError(f"basename collision: {path}")


def _content_changes(
    vault_path: Path,
    notes: list[Note],
    mapping: Mapping,
    old: str,
    new: str,
) -> list[dict]:
    changes: list[dict] = []
    for note in notes:
        text = note.path.read_text(encoding="utf-8")
        rewritten = _rewrite_text(text, mapping, old, new)
        if rewritten == text:
            continue
        changes.append(
            {
                "note": note.id,
                "path": note.path.relative_to(vault_path).as_posix(),
                "sha256": sha256_file(note.path),
                "new_text": rewritten,
            }
        )
    return changes


def _apply_content_changes(vault_path: Path, changes: list[dict], errors: list[dict]) -> None:
    for change in changes:
        path = vault_path / change["path"]
        if not path.is_file():
            errors.append({"path": change["path"], "error": "missing"})
            continue
        if sha256_file(path) != change["sha256"]:
            errors.append({"path": change["path"], "error": "hash_changed"})
            continue
        path.write_text(change["new_text"], encoding="utf-8")


def _rewrite_text(text: str, mapping: Mapping, old: str, new: str) -> str:
    fm_text, body, has_fm = _split_frontmatter(text)
    body_new = body.replace(f"[[{old}]]", f"[[{new}]]")
    body_new = re.sub(rf"\[\[{re.escape(old)}\|", f"[[{new}|", body_new)
    fm_changed = False
    if has_fm:
        try:
            fm = yaml.safe_load(fm_text) or {}
        except yaml.YAMLError:
            fm = {}
        if isinstance(fm, dict):
            rewritten = _rewrite_frontmatter(dict(fm), mapping, old, new)
            if rewritten != fm:
                fm_changed = True
                fm_text = yaml.safe_dump(
                    rewritten,
                    allow_unicode=True,
                    sort_keys=False,
                    default_flow_style=False,
                )
    if not fm_changed and body_new == body:
        return text
    if has_fm:
        return f"---\n{fm_text}---\n{body_new}"
    return body_new


def _rewrite_frontmatter(fm: dict[str, Any], mapping: Mapping, old: str, new: str) -> dict[str, Any]:
    for key in (mapping.refs, mapping.aliases):
        if not key or key not in fm:
            continue
        fm[key] = _rewrite_value(fm[key], old, new)
    return fm


def _rewrite_value(value: Any, old: str, new: str) -> Any:
    if isinstance(value, str):
        return value.replace(f"[[{old}]]", f"[[{new}]]")
    if isinstance(value, list):
        return [_rewrite_value(item, old, new) for item in value]
    return value


def _split_frontmatter(text: str) -> tuple[str, str, bool]:
    if not text.startswith("---"):
        return "", text, False
    lines = text.splitlines(keepends=True)
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            return "".join(lines[1:idx]), "".join(lines[idx + 1 :]), True
    return "", text, False


def _invalidate_cache(vault_path: Path) -> None:
    for rel in (".ipa/cache/manifest.json", ".ipa/cache/files.jsonl", ".ipa/cache/graph.json"):
        try:
            (vault_path / rel).unlink()
        except FileNotFoundError:
            pass

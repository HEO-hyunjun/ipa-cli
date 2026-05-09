"""Wikilink suggestion, plan, and apply helpers."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from ipa_cli.api.mappings import Mapping
from ipa_cli.parse.links import extract_ref_targets
from ipa_cli.parse.note_model import Note
from ipa_cli.parse.vault_loader import load_notes


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def suggest_links(
    vault_path: Path,
    mapping: Mapping,
    *,
    note_id: str | None = None,
    scope: str = "vault",
) -> list[dict]:
    vault = vault_path.expanduser().resolve()
    notes = load_notes(vault, mapping)
    targets = _target_notes(notes, mapping, note_id=note_id, scope=scope)
    suggestions: list[dict] = []
    for note in targets:
        linked = set(note.wikilinks)
        for other in notes:
            if other.id == note.id or other.id in linked:
                continue
            if f"[[{other.id}]]" in note.body:
                continue
            reason = _suggest_reason(note, other, mapping)
            if reason is None:
                continue
            if _plain_mention(note.body, other.id):
                suggestions.append(
                    {
                        "note": note.id,
                        "target": other.id,
                        "reason": reason,
                        "path": note.path.relative_to(vault).as_posix(),
                    }
                )
    return suggestions


def build_link_plan(
    vault_path: Path,
    mapping: Mapping,
    *,
    note_id: str | None = None,
    scope: str = "vault",
    output: Path | None = None,
) -> dict:
    vault = vault_path.expanduser().resolve()
    notes = load_notes(vault, mapping)
    notes_by_id = {note.id: note for note in notes}
    changes = []
    for item in suggest_links(vault, mapping, note_id=note_id, scope=scope):
        note = notes_by_id[item["note"]]
        target = item["target"]
        new_body = _replace_first_plain_mention(note.body, target)
        if new_body == note.body:
            continue
        changes.append(
            {
                "note": note.id,
                "target": target,
                "path": note.path.relative_to(vault).as_posix(),
                "sha256": file_hash(note.path),
                "old_text": note.body,
                "new_text": new_body,
                "reason": item["reason"],
            }
        )
    plan = {
        "version": 1,
        "kind": "link",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "changes": changes,
    }
    if output is not None:
        target = output if output.is_absolute() else vault / output
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    return plan


def apply_link_plan(vault_path: Path, plan_path: Path) -> dict:
    vault = vault_path.expanduser().resolve()
    path = plan_path if plan_path.is_absolute() else vault / plan_path
    plan = json.loads(path.read_text(encoding="utf-8"))
    applied: list[str] = []
    errors: list[dict] = []
    for change in plan.get("changes") or []:
        note_path = vault / change["path"]
        if not note_path.is_file():
            errors.append({"path": change["path"], "error": "missing"})
            continue
        if file_hash(note_path) != change.get("sha256"):
            errors.append({"path": change["path"], "error": "hash_changed"})
            continue
        original = note_path.read_text(encoding="utf-8")
        head, _body = _split_frontmatter(original)
        note_path.write_text(head + change["new_text"], encoding="utf-8")
        applied.append(change["path"])
    return {"applied": applied, "errors": errors}


def render_link_payload(payload: dict | list, *, json_output: bool = False) -> str:
    if json_output:
        return json.dumps(payload, ensure_ascii=False, indent=2)
    if isinstance(payload, list):
        if not payload:
            return "no suggestions"
        return "\n".join(
            f"{item['note']} -> [[{item['target']}]] ({item['reason']})"
            for item in payload
        )
    lines = [f"kind: {payload.get('kind', 'link')}", f"changes: {len(payload.get('changes') or [])}"]
    for change in payload.get("changes") or []:
        lines.append(f"- {change['path']}: [[{change['target']}]] ({change['reason']})")
    if payload.get("errors"):
        lines.append(f"errors: {len(payload['errors'])}")
    if payload.get("applied"):
        lines.append(f"applied: {len(payload['applied'])}")
    return "\n".join(lines)


def _target_notes(
    notes: list[Note],
    mapping: Mapping,
    *,
    note_id: str | None,
    scope: str,
) -> list[Note]:
    if note_id is not None:
        return [note for note in notes if note.id == note_id]
    if scope == "inbox":
        return [note for note in notes if f"/{mapping.inbox_dir}/" in f"/{note.path.as_posix()}"]
    return notes


def _suggest_reason(note: Note, other: Note, mapping: Mapping) -> str | None:
    note_refs = set(extract_ref_targets(note.refs(mapping)))
    other_refs = set(extract_ref_targets(other.refs(mapping)))
    if note_refs and note_refs.intersection(other_refs):
        return "same-ref"
    if set(note.tags(mapping)).intersection(other.tags(mapping)):
        return "tag-overlap"
    aliases = set(other.aliases(mapping))
    if any(_plain_mention(note.body, alias) for alias in aliases):
        return "alias-mention"
    if _plain_mention(note.body, other.id):
        return "title-mention"
    return None


def _plain_mention(body: str, title: str) -> bool:
    if not title:
        return False
    if f"[[{title}]]" in body:
        return False
    return re.search(rf"(?<!\[\[){re.escape(title)}(?!\]\])", body) is not None


def _replace_first_plain_mention(body: str, title: str) -> str:
    pattern = re.compile(rf"(?<!\[\[){re.escape(title)}(?!\]\])")
    return pattern.sub(f"[[{title}]]", body, count=1)


def _split_frontmatter(text: str) -> tuple[str, str]:
    if not text.startswith("---"):
        return "", text
    lines = text.splitlines(keepends=True)
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            return "".join(lines[: idx + 1]), "".join(lines[idx + 1 :])
    return "", text

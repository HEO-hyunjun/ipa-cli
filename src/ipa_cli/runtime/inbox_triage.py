"""Inbox triage recommendations and optional apply."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from ipa_cli.api.mappings import Mapping
from ipa_cli.parse.links import extract_ref_targets
from ipa_cli.parse.note_model import Note
from ipa_cli.parse.vault_loader import load_notes


def triage_inbox(
    vault_path: Path,
    mapping: Mapping,
    *,
    note_id: str | None = None,
) -> list[dict]:
    vault = vault_path.expanduser().resolve()
    notes = load_notes(vault, mapping)
    inbox_prefix = f"/{mapping.inbox_dir}/"
    inbox_notes = [
        note
        for note in notes
        if inbox_prefix in f"/{note.path.relative_to(vault).as_posix()}/"
        and (note_id is None or note.id == note_id)
    ]
    all_notes = {note.id: note for note in notes}
    out = []
    for note in inbox_notes:
        refs = extract_ref_targets(note.refs(mapping))
        tags = note.tags(mapping)
        issues = []
        if not note.note_type(mapping):
            issues.append("missing type")
        if not refs:
            issues.append("missing ref")
        related = [ref for ref in refs if ref in all_notes]
        target_folder = mapping.archive_dir if refs and not issues else mapping.inbox_dir
        out.append(
            {
                "note": note.id,
                "path": note.path.relative_to(vault).as_posix(),
                "ref_candidates": refs,
                "tag_candidates": tags,
                "target_folder": target_folder,
                "related_notes": related,
                "validator_issues": issues,
                "applyable": target_folder != mapping.inbox_dir and not issues,
            }
        )
    return out


def apply_triage(vault_path: Path, mapping: Mapping, recommendations: list[dict]) -> dict:
    vault = vault_path.expanduser().resolve()
    moved: list[str] = []
    errors: list[dict] = []
    for item in recommendations:
        if not item.get("applyable"):
            continue
        src = vault / item["path"]
        dest = vault / item["target_folder"] / src.name
        if not src.is_file():
            errors.append({"note": item["note"], "error": "missing"})
            continue
        if dest.exists():
            errors.append({"note": item["note"], "error": "destination_exists"})
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dest))
        moved.append(dest.relative_to(vault).as_posix())
    return {"moved": moved, "errors": errors}


def render_triage(payload, *, json_output: bool = False) -> str:
    if json_output:
        return json.dumps(payload, ensure_ascii=False, indent=2)
    if isinstance(payload, dict):
        lines = [f"moved: {len(payload.get('moved') or [])}"]
        for error in payload.get("errors") or []:
            lines.append(f"error {error['note']}: {error['error']}")
        return "\n".join(lines)
    if not payload:
        return "no inbox notes"
    lines = []
    for item in payload:
        marker = "applyable" if item["applyable"] else "needs-input"
        lines.append(
            f"{item['note']} -> {item['target_folder']} [{marker}] "
            f"refs={item['ref_candidates']} issues={item['validator_issues']}"
        )
    return "\n".join(lines)

"""Vault-local portable cache management."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ipa_cli.api.base_channels import SetupContext
from ipa_cli.api.mappings import Mapping
from ipa_cli.parse.links import extract_ref_targets
from ipa_cli.parse.note_model import Note
from ipa_cli.parse.vault_loader import load_notes


def cache_root(vault_path: Path) -> Path:
    return vault_path.expanduser().resolve() / ".ipa" / "cache"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rebuild_cache(vault_path: Path, mapping: Mapping) -> dict:
    vault = vault_path.expanduser().resolve()
    root = cache_root(vault)
    root.mkdir(parents=True, exist_ok=True)
    notes = load_notes(vault, mapping)
    files = [_file_record(note, vault) for note in notes]
    graph = _graph_record(notes, mapping)
    manifest = {
        "version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "files": len(files),
        "graph_nodes": len(graph["edges"]),
    }
    (root / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (root / "files.jsonl").write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in files),
        encoding="utf-8",
    )
    (root / "graph.json").write_text(
        json.dumps(graph, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {
        "manifest": manifest,
        "files": len(files),
        "graph_nodes": len(graph["edges"]),
    }


def cache_status(vault_path: Path, mapping: Mapping) -> dict:
    vault = vault_path.expanduser().resolve()
    root = cache_root(vault)
    notes = load_notes(vault, mapping)
    manifest = _read_json(root / "manifest.json")
    stale = _stale_records(vault, notes)
    return {
        "root": ".ipa/cache",
        "manifest_exists": (root / "manifest.json").is_file(),
        "files_exists": (root / "files.jsonl").is_file(),
        "graph_exists": (root / "graph.json").is_file(),
        "manifest": manifest,
        "notes": len(notes),
        "stale": stale,
    }


def cache_doctor(vault_path: Path, mapping: Mapping) -> dict:
    vault = vault_path.expanduser().resolve()
    status = cache_status(vault, mapping)
    issues: list[dict] = []
    for key in ("manifest_exists", "files_exists", "graph_exists"):
        if not status[key]:
            issues.append(
                {"code": f"cache.{key}.missing", "severity": "warn", "message": key}
            )
    needle = str(vault)
    for path in cache_root(vault).rglob("*"):
        if not path.is_file() or path.suffix not in {".json", ".jsonl"}:
            continue
        try:
            if needle in path.read_text(encoding="utf-8"):
                issues.append(
                    {
                        "code": "cache.absolute_path",
                        "severity": "error",
                        "message": "cache contains an absolute vault path",
                        "path": path.relative_to(vault).as_posix(),
                    }
                )
        except UnicodeDecodeError:
            continue
    return {"status": "error" if any(i["severity"] == "error" for i in issues) else "ok", "issues": issues, **status}


def cache_clean_stale(vault_path: Path, mapping: Mapping) -> dict:
    vault = vault_path.expanduser().resolve()
    status = cache_status(vault, mapping)
    if not status["stale"]:
        return {"removed": 0, "stale": []}
    rebuild_cache(vault, mapping)
    return {"removed": len(status["stale"]), "stale": status["stale"]}


def inspect_note_cache(vault_path: Path, mapping: Mapping, note_id: str) -> dict:
    vault = vault_path.expanduser().resolve()
    notes = load_notes(vault, mapping)
    for note in notes:
        if note.id == note_id:
            return _file_record(note, vault)
    raise KeyError(note_id)


def render_cache(data: dict, *, json_output: bool = False) -> str:
    if json_output:
        return json.dumps(data, ensure_ascii=False, indent=2)
    lines = []
    for key, value in data.items():
        if key == "files" and isinstance(value, list):
            lines.append(f"files: {len(value)}")
        elif key == "graph":
            lines.append(f"graph_nodes: {len(value.get('edges', {}))}")
        else:
            lines.append(f"{key}: {value}")
    return "\n".join(lines)


def _file_record(note: Note, vault_path: Path) -> dict:
    rel = note.path.relative_to(vault_path).as_posix()
    return {
        "note": note.id,
        "path": rel,
        "sha256": sha256_file(note.path),
        "size": note.path.stat().st_size,
        "mtime_ns": note.path.stat().st_mtime_ns,
    }


def _graph_record(notes: list[Note], mapping: Mapping) -> dict:
    ids = {note.id for note in notes}
    edges: dict[str, list[str]] = {}
    for note in notes:
        targets = set(extract_ref_targets(note.refs(mapping)))
        targets.update(note.wikilinks)
        edges[note.id] = sorted(t for t in targets if t in ids and t != note.id)
    return {"version": 1, "edges": edges}


def _read_json(path: Path) -> Any:
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _read_files_jsonl(path: Path) -> dict[str, dict]:
    if not path.is_file():
        return {}
    out: dict[str, dict] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        out[str(record.get("path"))] = record
    return out


def _stale_records(vault_path: Path, notes: list[Note]) -> list[dict]:
    root = cache_root(vault_path)
    cached = _read_files_jsonl(root / "files.jsonl")
    stale: list[dict] = []
    current_paths = set()
    for note in notes:
        rel = note.path.relative_to(vault_path).as_posix()
        current_paths.add(rel)
        old = cached.get(rel)
        current_hash = sha256_file(note.path)
        if old is None:
            stale.append({"path": rel, "reason": "missing"})
        elif old.get("sha256") != current_hash:
            stale.append({"path": rel, "reason": "hash_changed"})
    for rel in sorted(set(cached) - current_paths):
        stale.append({"path": rel, "reason": "deleted"})
    return stale

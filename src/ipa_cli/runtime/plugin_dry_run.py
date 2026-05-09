"""Dry-run user plugins without writing vault files."""

from __future__ import annotations

import difflib
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

from ipa_cli.api.base_channels import BaseSearchChannel, Query, SetupContext
from ipa_cli.api.base_rules import BaseConventionRule
from ipa_cli.api.context import FormatContext, ValidationContext
from ipa_cli.api.mappings import Mapping
from ipa_cli.parse.note_model import Note
from ipa_cli.parse.vault_loader import load_notes
from ipa_cli.runtime.search_engine import SearchEngine


def list_plugins(vault_path: Path) -> dict:
    root = vault_path / ".ipa" / "plugins"
    entries = []
    for kind in ("search", "lint", "formatter"):
        folder = root / kind
        for path in sorted(folder.glob("*.py")) if folder.is_dir() else []:
            if path.name.startswith("_") or path.name == "__init__.py":
                continue
            entries.append({"kind": kind, "path": path.relative_to(vault_path).as_posix()})
    return {"plugins": entries}


def plugin_doctor(vault_path: Path) -> dict:
    issues: list[dict] = []
    plugins = list_plugins(vault_path)["plugins"]
    for item in plugins:
        report = validate_plugin(vault_path / item["path"], kind=item["kind"])
        issues.extend(report["issues"])
    return {
        "plugins": plugins,
        "issues": issues,
        "status": "error" if any(i["severity"] == "error" for i in issues) else "ok",
    }


def validate_plugin(path: Path, *, kind: str | None = None) -> dict:
    issues: list[dict] = []
    try:
        module = _load_module(path)
        _plugin_payload(path, module, kind=kind)
    except Exception as exc:
        issues.append(
            {
                "code": "plugin.load_failed",
                "severity": "error",
                "path": path.as_posix(),
                "message": str(exc),
            }
        )
    return {"path": path.as_posix(), "kind": kind or _guess_kind(path), "issues": issues}


def dry_run_search(vault_path: Path, mapping: Mapping, path: Path, query: str) -> dict:
    module = _load_module(_resolve(vault_path, path))
    channels = _read_channels(_resolve(vault_path, path), module)
    notes = load_notes(vault_path, mapping)
    ctx = SetupContext(
        notes=notes,
        vault_path=vault_path,
        cache_dir=vault_path / ".ipa" / "cache" / "search",
        mapping=mapping,
    )
    engine = SearchEngine(channels, ctx)
    hits = engine.search(Query(raw=query), threshold=0.0, cap=10)
    return {
        "kind": "search",
        "plugin": path.as_posix(),
        "query": query,
        "results": [{"note": hit.note_id, "score": hit.score} for hit in hits],
    }


def dry_run_lint(vault_path: Path, mapping: Mapping, path: Path, note_id: str) -> dict:
    plugin_path = _resolve(vault_path, path)
    module = _load_module(plugin_path)
    rules = _read_rules(plugin_path, module)
    notes = load_notes(vault_path, mapping)
    note = _find_note(notes, note_id)
    ctx = ValidationContext(vault_path=vault_path, notes=notes, mapping=mapping)
    issues = []
    for rule in rules:
        issues.extend(rule.check(ctx, note))
    return {
        "kind": "lint",
        "plugin": path.as_posix(),
        "note": note_id,
        "issues": [
            {
                "code": issue.code,
                "severity": issue.severity.value,
                "note": issue.note_id,
                "message": issue.message,
            }
            for issue in issues
        ],
    }


def dry_run_formatter(vault_path: Path, mapping: Mapping, path: Path, note_id: str) -> dict:
    plugin_path = _resolve(vault_path, path)
    module = _load_module(plugin_path)
    rules = _read_rules(plugin_path, module)
    notes = load_notes(vault_path, mapping)
    note = _find_note(notes, note_id)
    vctx = ValidationContext(vault_path=vault_path, notes=notes, mapping=mapping)
    fctx = FormatContext(vault_path=vault_path, notes=notes, mapping=mapping)
    patches = []
    for rule in rules:
        for issue in rule.check(vctx, note):
            for patch in rule.fix(fctx, issue) or []:
                patches.append(patch)
    original = note.path.read_text(encoding="utf-8")
    try:
        from ipa_cli.runtime.formatter_engine import _apply_to_text

        preview = _apply_to_text(original, patches)
    except Exception:
        preview = original
    patch_rows = [
        {
            "note": p.note_id,
            "line": p.span.start_line,
            "start_col": p.span.start_col,
            "end_col": p.span.end_col,
            "replacement": p.replacement,
        }
        for p in patches
    ]
    return {
        "kind": "formatter",
        "plugin": path.as_posix(),
        "note": note_id,
        "patches": patch_rows,
        "diff": list(
            difflib.unified_diff(
                original.splitlines(),
                preview.splitlines(),
                fromfile=note.path.name,
                tofile=f"{note.path.name}.dry-run",
                lineterm="",
            )
        ),
    }


def render_plugin(payload: dict, *, json_output: bool = False) -> str:
    if json_output:
        return json.dumps(payload, ensure_ascii=False, indent=2)
    if "plugins" in payload:
        lines = [f"plugins: {len(payload['plugins'])}"]
        for item in payload["plugins"]:
            lines.append(f"- {item['kind']} {item['path']}")
        if payload.get("issues"):
            lines.append(f"issues: {len(payload['issues'])}")
        return "\n".join(lines)
    if "results" in payload:
        return "\n".join(f"{r['note']} {r['score']:.4f}" for r in payload["results"]) or "no results"
    if "issues" in payload:
        return "\n".join(f"{i['severity']} {i['code']}: {i['message']}" for i in payload["issues"]) or "no issues"
    if "patches" in payload:
        return "\n".join(f"L{p['line']} -> {p['replacement']!r}" for p in payload["patches"]) or "no patches"
    return json.dumps(payload, ensure_ascii=False, indent=2)


def _resolve(vault_path: Path, path: Path) -> Path:
    return path if path.is_absolute() else vault_path / path


def _load_module(path: Path):
    spec = importlib.util.spec_from_file_location(_module_name(path), path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(spec.name, None)
        raise
    return module


def _module_name(path: Path) -> str:
    digest = hashlib.sha1(str(path.resolve()).encode("utf-8")).hexdigest()[:12]
    return f"_ipa_plugin_dry_run_{path.stem}_{digest}"


def _guess_kind(path: Path) -> str:
    parts = set(path.parts)
    if "search" in parts:
        return "search"
    if "formatter" in parts:
        return "formatter"
    return "lint"


def _plugin_payload(path: Path, module, *, kind: str | None) -> Any:
    kind = kind or _guess_kind(path)
    if kind == "search":
        return _read_channels(path, module)
    return _read_rules(path, module)


def _read_channels(path: Path, module) -> list[BaseSearchChannel]:
    channels = getattr(module, "channels", None)
    if not isinstance(channels, list) or not all(isinstance(c, BaseSearchChannel) for c in channels):
        raise TypeError(f"{path}: expected channels = [BaseSearchChannel(...)]")
    return list(channels)


def _read_rules(path: Path, module) -> list[BaseConventionRule]:
    rules = getattr(module, "rules", None)
    if not isinstance(rules, list) or not all(isinstance(r, BaseConventionRule) for r in rules):
        raise TypeError(f"{path}: expected rules = [BaseConventionRule(...)]")
    return list(rules)


def _find_note(notes: list[Note], note_id: str) -> Note:
    for note in notes:
        if note.id == note_id:
            return note
    raise KeyError(note_id)

"""Operational doctor checks for vault/profile state."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

import yaml

from ipa_cli.api.base_channels import SetupContext
from ipa_cli.api.mappings import Mapping
from ipa_cli.parse.links import extract_ref_targets
from ipa_cli.parse.note_model import Note
from ipa_cli.parse.vault_loader import load_notes
from ipa_cli.runtime.convention_loader import load_convention
from ipa_cli.runtime.mapping_loader import load_mapping
from ipa_cli.runtime.search_loader import load_search_channels


def _rel(path: Path, vault_path: Path) -> str:
    try:
        return path.resolve().relative_to(vault_path.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _issue(code: str, severity: str, message: str, path: str | None = None) -> dict:
    out = {"code": code, "severity": severity, "message": message}
    if path:
        out["path"] = path
    return out


def build_doctor_report(
    settings: Any,
    *,
    fix_dirs: bool = False,
    check: str | None = None,
) -> dict:
    """Return a structured health report for the active vault."""
    vault_path = settings.vault_path.expanduser()
    issues: list[dict] = []
    checks: dict[str, Any] = {
        "profile": settings.profile,
        "vault_path": str(settings.vault_path),
        "profile_dir": str(settings.profile_dir),
        "vault_config": str(settings.vault_config_path),
    }

    if settings.vault_path == Path() or not vault_path.exists():
        issues.append(
            _issue(
                "doctor.vault.missing",
                "error",
                "vault path is missing or does not exist",
                str(settings.vault_path),
            )
        )
        return _finalize(checks, issues)
    if not vault_path.is_dir():
        issues.append(
            _issue("doctor.vault.not_dir", "error", "vault path is not a directory")
        )
        return _finalize(checks, issues)

    required_dirs = [
        Path(".ipa"),
        Path(".ipa/cache"),
        Path(".ipa/tune"),
        Path(".ipa/plugins"),
    ]
    for rel in required_dirs:
        path = vault_path / rel
        if not path.is_dir():
            if fix_dirs:
                path.mkdir(parents=True, exist_ok=True)
            else:
                issues.append(
                    _issue(
                        "doctor.dir.missing",
                        "warn",
                        f"required directory is missing: {rel.as_posix()}",
                        rel.as_posix(),
                    )
                )

    if settings.vault_config_path and not settings.vault_config_path.is_file():
        issues.append(
            _issue(
                "doctor.config.missing",
                "warn",
                "vault-local config.yaml is missing",
                ".ipa/config.yaml",
            )
        )
    else:
        try:
            yaml.safe_load(settings.vault_config_path.read_text(encoding="utf-8")) or {}
        except Exception as exc:
            issues.append(
                _issue(
                    "doctor.config.invalid",
                    "error",
                    f"vault config cannot be parsed: {exc}",
                    ".ipa/config.yaml",
                )
            )

    workspace = settings.profile_dir if settings.profile_dir.is_dir() else None
    try:
        mapping = load_mapping(workspace, vault_config_path=settings.vault_config_path)
        notes = load_notes(vault_path, mapping)
        checks["notes"] = len(notes)
        _check_duplicate_basenames(notes, vault_path, issues)
        _check_dangling_links(notes, mapping, issues)
    except Exception as exc:
        mapping = Mapping()
        notes = []
        issues.append(_issue("doctor.notes.load_failed", "error", str(exc)))

    _check_plugin_loaders(settings, issues)
    _check_tune_artifacts(settings, issues)

    if check in {"absolute-paths", None}:
        _check_absolute_paths(vault_path, issues)

    checks["cache_dir"] = ".ipa/cache/search"
    checks["plugins_dir"] = ".ipa/plugins"
    checks["tune_dir"] = ".ipa/tune"
    return _finalize(checks, issues)


def _finalize(checks: dict[str, Any], issues: list[dict]) -> dict:
    status = "error" if any(i["severity"] == "error" for i in issues) else "ok"
    return {"status": status, "checks": checks, "issues": issues}


def _check_duplicate_basenames(
    notes: list[Note],
    vault_path: Path,
    issues: list[dict],
) -> None:
    names = Counter(note.path.name.casefold() for note in notes)
    for name, count in sorted(names.items()):
        if count <= 1:
            continue
        matches = [
            _rel(note.path, vault_path)
            for note in notes
            if note.path.name.casefold() == name
        ]
        issues.append(
            _issue(
                "doctor.basename.duplicate",
                "error",
                f"duplicate markdown basename: {', '.join(matches)}",
            )
        )


def _check_dangling_links(
    notes: list[Note],
    mapping: Mapping,
    issues: list[dict],
) -> None:
    ids = {note.id for note in notes}
    for note in notes:
        targets = set(note.wikilinks)
        targets.update(extract_ref_targets(note.refs(mapping)))
        for target in sorted(t for t in targets if t not in ids):
            issues.append(
                _issue(
                    "doctor.link.dangling",
                    "warn",
                    f"{note.id} points to missing note {target!r}",
                )
            )


def _check_plugin_loaders(settings: Any, issues: list[dict]) -> None:
    workspace = settings.profile_dir if settings.profile_dir.is_dir() else None
    try:
        load_search_channels(workspace, vault_path=settings.vault_path)
    except Exception as exc:
        issues.append(_issue("doctor.plugin.search_load_failed", "error", str(exc)))
    try:
        load_convention(workspace, vault_path=settings.vault_path, surface="convention")
    except Exception as exc:
        issues.append(_issue("doctor.plugin.lint_load_failed", "error", str(exc)))
    try:
        load_convention(workspace, vault_path=settings.vault_path, surface="formatter")
    except Exception as exc:
        issues.append(_issue("doctor.plugin.formatter_load_failed", "error", str(exc)))


def _check_tune_artifacts(settings: Any, issues: list[dict]) -> None:
    if settings.testset_path is not None and not settings.testset_path.is_file():
        issues.append(
            _issue(
                "doctor.tune.testset_missing",
                "warn",
                "configured testset file is missing",
                settings.testset_path.as_posix(),
            )
        )
    if settings.weight_result_path is not None and not settings.weight_result_path.is_file():
        issues.append(
            _issue(
                "doctor.tune.weights_missing",
                "warn",
                "configured weight result file is missing",
                settings.weight_result_path.as_posix(),
            )
        )


def _check_absolute_paths(vault_path: Path, issues: list[dict]) -> None:
    cache_root = vault_path / ".ipa" / "cache"
    if not cache_root.exists():
        return
    needle = str(vault_path.resolve())
    for path in cache_root.rglob("*"):
        if not path.is_file() or path.suffix not in {".json", ".jsonl", ".yaml", ".yml"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if needle in text:
            issues.append(
                _issue(
                    "doctor.cache.absolute_path",
                    "error",
                    "cache artifact contains a machine-local absolute path",
                    _rel(path, vault_path),
                )
            )


def render_doctor_report(report: dict, *, json_output: bool = False) -> str:
    if json_output:
        return json.dumps(report, ensure_ascii=False, indent=2)
    lines = [
        f"status: {report['status']}",
        f"profile: {report['checks'].get('profile')}",
        f"vault_path: {report['checks'].get('vault_path')}",
        f"notes: {report['checks'].get('notes', 0)}",
    ]
    issues = report.get("issues") or []
    if not issues:
        lines.append("no issues")
        return "\n".join(lines)
    lines.append(f"issues: {len(issues)}")
    for issue in issues:
        path = f" ({issue['path']})" if issue.get("path") else ""
        lines.append(
            f"- {issue['severity']} {issue['code']}: {issue['message']}{path}"
        )
    return "\n".join(lines)

"""Vault quality review surface."""

from __future__ import annotations

import difflib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Literal

from ipa_cli.api.base_rules import Severity
from ipa_cli.api.mappings import Mapping
from ipa_cli.parse.links import extract_ref_targets
from ipa_cli.parse.note_model import Note
from ipa_cli.parse.vault_loader import load_notes
from ipa_cli.runtime.convention_loader import load_convention
from ipa_cli.runtime.validator_engine import run_validator

ReviewScope = Literal["all", "inbox", "index", "tags", "duplicates", "convention"]
TAG_RE = re.compile(r"^[a-z0-9_]+$")


def review_vault(
    vault_path: Path,
    mapping: Mapping,
    *,
    profile_dir: Path | None = None,
    scope: ReviewScope = "all",
    suggest_refactor: bool = False,
    content_duplicates: bool = False,
    threshold: float = 0.85,
) -> dict:
    vault = vault_path.expanduser().resolve()
    notes = load_notes(vault, mapping)
    issues: list[dict] = []
    scopes = _expand_scope(scope)
    if "inbox" in scopes:
        issues.extend(_review_inbox(notes, mapping, vault))
    if "index" in scopes:
        issues.extend(_review_index(notes, mapping))
    if "tags" in scopes:
        issues.extend(_review_tags(notes, mapping, suggest_refactor=suggest_refactor))
    if "duplicates" in scopes:
        issues.extend(
            _review_duplicates(
                notes,
                vault,
                content_duplicates=content_duplicates,
                threshold=threshold,
            )
        )
    if "convention" in scopes:
        issues.extend(_review_convention(notes, mapping, vault, profile_dir))
    return {"scope": scope, "issues": issues, "count": len(issues)}


def render_review(report: dict, *, json_output: bool = False) -> str:
    if json_output:
        return json.dumps(report, ensure_ascii=False, indent=2)
    if not report.get("issues"):
        return "no review issues"
    lines = [f"review {report['scope']}: {report['count']} issue(s)"]
    for issue in report["issues"]:
        suffix = f" -> {issue['refactor_command']}" if issue.get("refactor_command") else ""
        note = issue.get("note") or "-"
        lines.append(f"- {issue['severity']} {issue['code']} {note}: {issue['message']}{suffix}")
    return "\n".join(lines)


def _expand_scope(scope: ReviewScope) -> set[str]:
    if scope == "all":
        return {"inbox", "index", "tags", "duplicates", "convention"}
    return {scope}


def _issue(code: str, severity: str, message: str, *, note: str | None = None, evidence=None, refactor_command: str | None = None) -> dict:
    out = {"code": code, "severity": severity, "message": message}
    if note:
        out["note"] = note
    if evidence is not None:
        out["evidence"] = evidence
    if refactor_command:
        out["refactor_command"] = refactor_command
    return out


def _review_inbox(notes: list[Note], mapping: Mapping, vault_path: Path) -> list[dict]:
    out: list[dict] = []
    for note in notes:
        rel = note.path.relative_to(vault_path).as_posix()
        if not rel.startswith(f"{mapping.inbox_dir}/"):
            continue
        if not note.note_type(mapping):
            out.append(_issue("review.inbox.missing_type", "warn", "Inbox note has no type", note=note.id))
        if not note.refs(mapping):
            out.append(_issue("review.inbox.missing_ref", "warn", "Inbox note has no ref", note=note.id))
        if note.note_type(mapping) == "note" and note.refs(mapping):
            out.append(
                _issue(
                    "review.inbox.archive_candidate",
                    "info",
                    "Inbox note has enough metadata for archive triage",
                    note=note.id,
                    evidence={"path": rel},
                )
            )
    return out


def _review_index(notes: list[Note], mapping: Mapping) -> list[dict]:
    out: list[dict] = []
    refs = Counter()
    for note in notes:
        for ref in extract_ref_targets(note.refs(mapping)):
            refs[ref] += 1
    for note in notes:
        if note.note_type(mapping) != "index":
            continue
        count = refs.get(note.id, 0)
        if count == 0:
            out.append(_issue("review.index.orphan", "warn", "Index has no child notes", note=note.id))
        if count > 50:
            out.append(_issue("review.index.large", "info", f"Index has {count} child notes", note=note.id))
    return out


def _review_tags(notes: list[Note], mapping: Mapping, *, suggest_refactor: bool) -> list[dict]:
    out: list[dict] = []
    tag_notes: dict[str, list[str]] = defaultdict(list)
    for note in notes:
        for tag in note.tags(mapping):
            tag_notes[tag].append(note.id)
            if not TAG_RE.match(tag):
                normalized = _normalize_tag(tag)
                command = f"ipa refactor tag-rename {tag} {normalized}" if suggest_refactor else None
                out.append(
                    _issue(
                        "review.tag.naming",
                        "warn",
                        "Tag should use lowercase snake_case",
                        note=note.id,
                        evidence={"tag": tag},
                        refactor_command=command,
                    )
                )
    for tag, owners in sorted(tag_notes.items()):
        if len(owners) == 1:
            out.append(
                _issue(
                    "review.tag.low_use",
                    "info",
                    "Tag is used by only one note",
                    note=owners[0],
                    evidence={"tag": tag},
                )
            )
    return out


def _review_duplicates(
    notes: list[Note],
    vault_path: Path,
    *,
    content_duplicates: bool,
    threshold: float,
) -> list[dict]:
    out: list[dict] = []
    by_basename: dict[str, list[Note]] = defaultdict(list)
    by_alias: dict[str, list[Note]] = defaultdict(list)
    for note in notes:
        by_basename[note.path.name.casefold()].append(note)
        for alias in note.frontmatter.get("aliases") or []:
            by_alias[str(alias).casefold()].append(note)
        if "sync-conflict" in note.path.name.casefold():
            out.append(_issue("review.duplicate.sync_conflict", "error", "Sync conflict file", note=note.id))
    for _name, group in by_basename.items():
        if len(group) > 1:
            out.append(
                _issue(
                    "review.duplicate.basename",
                    "error",
                    "Duplicate markdown basename",
                    evidence=[n.path.relative_to(vault_path).as_posix() for n in group],
                )
            )
    for alias, group in by_alias.items():
        if len(group) > 1:
            out.append(
                _issue(
                    "review.duplicate.alias",
                    "warn",
                    f"Alias is shared by multiple notes: {alias}",
                    evidence=[n.id for n in group],
                )
            )
    lowered = defaultdict(list)
    for note in notes:
        lowered[note.id.casefold()].append(note)
    for _title, group in lowered.items():
        if len(group) > 1:
            out.append(_issue("review.duplicate.title", "warn", "Similar note title", evidence=[n.id for n in group]))
    if content_duplicates:
        for idx, a in enumerate(notes):
            for b in notes[idx + 1 :]:
                ratio = difflib.SequenceMatcher(None, a.body.strip(), b.body.strip()).ratio()
                if ratio >= threshold and a.body.strip() and b.body.strip():
                    out.append(
                        _issue(
                            "review.duplicate.content",
                            "warn",
                            "Near-duplicate note body",
                            evidence={"notes": [a.id, b.id], "ratio": round(ratio, 4)},
                        )
                    )
    return out


def _review_convention(
    notes: list[Note],
    mapping: Mapping,
    vault_path: Path,
    profile_dir: Path | None,
) -> list[dict]:
    convention = load_convention(profile_dir, vault_path=vault_path, surface="convention")
    issues = run_validator(
        notes,
        mapping,
        convention,
        vault_path=vault_path,
        scope="vault",
    )
    return [
        _issue(
            f"review.convention.{issue.code}",
            _severity(issue.severity),
            issue.message,
            note=issue.note_id,
        )
        for issue in issues
    ]


def _severity(severity: Severity) -> str:
    if severity == Severity.ERROR:
        return "error"
    if severity == Severity.WARN:
        return "warn"
    return "info"


def _normalize_tag(tag: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", tag.lower()).strip("_")
    return normalized or "tag"

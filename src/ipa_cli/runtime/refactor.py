"""Legacy ``ipa refactor`` surface implemented without ``ipa_cli._legacy``.

The command keeps the seven inherited subcommands and their dry-run/apply
output shape, but the scan/filter/mutation path now uses the 2차 parse
model. This is intentionally a small service: each subcommand produces a
list of note-level change descriptions and optionally persists the same
frontmatter/body rewrite it reports.
"""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable

from ipa_cli.api.mappings import Mapping
from ipa_cli.parse.links import extract_ref_targets
from ipa_cli.parse.note_model import Note
from ipa_cli.parse.vault_loader import load_notes, parse_frontmatter


class Colors:
    RED = "\033[91m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    CYAN = "\033[96m"
    DIM = "\033[2m"
    RESET = "\033[0m"
    BOLD = "\033[1m"


@dataclass
class RefactorResult:
    note_name: str
    rel_path: str
    changes: list[str] = field(default_factory=list)

    def add(self, description: str) -> None:
        self.changes.append(description)

    @property
    def has_changes(self) -> bool:
        return bool(self.changes)


def _notes(vault_path: Path, mapping: Mapping) -> list[Note]:
    return sorted(load_notes(vault_path, mapping), key=lambda n: str(n.path))


def _rel(path: Path, vault_path: Path) -> str:
    try:
        return str(path.resolve().relative_to(vault_path.resolve()))
    except ValueError:
        return str(path)


def _now() -> str:
    dt = datetime.now()
    return (
        dt.strftime("%Y/%m/%d") + f" ({dt.strftime('%a')}) " + dt.strftime("%H:%M:%S")
    )


def _as_list(value) -> list:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return list(value)
    return []


def _read_and_parse(path: Path) -> tuple[str, dict, str]:
    content = path.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(content)
    return content, fm, body


def _serialize_frontmatter(fm: dict, original_content: str) -> str:
    """Serialize frontmatter while preserving inline vs. multiline lists."""
    if not original_content.startswith("---"):
        return original_content

    end_idx = original_content.find("\n---", 3)
    if end_idx == -1:
        return original_content

    original_fm_text = original_content[4:end_idx]
    body = original_content[end_idx + 4 :]

    multiline_keys: set[str] = set()
    for line in original_fm_text.split("\n"):
        stripped = line.strip()
        if ":" not in stripped or stripped.startswith("-"):
            continue
        key, val = stripped.split(":", 1)
        if not val.strip():
            multiline_keys.add(key.strip())

    lines: list[str] = []
    for key, value in fm.items():
        if isinstance(value, list):
            if key in multiline_keys:
                lines.append(f"{key}:")
                for item in value:
                    lines.append(f'  - "{item}"')
            elif value:
                items = ", ".join(
                    f'"{item}"' if "[[" in str(item) else str(item)
                    for item in value
                )
                lines.append(f"{key}: [{items}]")
            else:
                lines.append(f"{key}: []")
        else:
            lines.append(f"{key}: {value}")

    return "---\n" + "\n".join(lines) + "\n---" + body


def _write_with_fm(path: Path, original_content: str, fm: dict) -> None:
    path.write_text(_serialize_frontmatter(fm, original_content), encoding="utf-8")


def _ref_links(note: Note, mapping: Mapping) -> list[str]:
    return extract_ref_targets(note.refs(mapping))


def build_filter(
    args: argparse.Namespace,
    vault_path: Path,
    mapping: Mapping,
) -> Callable[[Note], bool]:
    predicates: list[Callable[[Note], bool]] = []

    if args.filter:
        names = {name.strip() for name in args.filter.split(",")}
        predicates.append(lambda note: note.id in names)

    if args.scope_ref:
        predicates.append(lambda note: args.scope_ref in _ref_links(note, mapping))

    if args.scope_tag:
        predicates.append(lambda note: args.scope_tag in note.tags(mapping))

    if args.scope_type:
        predicates.append(lambda note: note.note_type(mapping) == args.scope_type)

    if args.scope_folder:
        predicates.append(
            lambda note: _rel(note.path, vault_path).startswith(args.scope_folder)
        )

    if not predicates:
        return lambda _: True
    return lambda note: all(predicate(note) for predicate in predicates)


def cmd_ref_replace(
    notes: list[Note],
    note_filter: Callable[[Note], bool],
    vault_path: Path,
    mapping: Mapping,
    old_ref: str,
    new_ref: str,
    apply: bool,
) -> list[RefactorResult]:
    results: list[RefactorResult] = []
    for note in notes:
        if not note_filter(note) or old_ref not in _ref_links(note, mapping):
            continue
        result = RefactorResult(note.id, _rel(note.path, vault_path))
        result.add(f"ref: [[{old_ref}]] → [[{new_ref}]]")
        if apply:
            content, fm, _ = _read_and_parse(note.path)
            raw_ref = _as_list(fm.get(mapping.refs))
            fm[mapping.refs] = [
                str(item).replace(f"[[{old_ref}]]", f"[[{new_ref}]]")
                for item in raw_ref
            ]
            fm[mapping.updated_at] = _now()
            _write_with_fm(note.path, content, fm)
        results.append(result)
    return results


def cmd_tag_rename(
    notes: list[Note],
    note_filter: Callable[[Note], bool],
    vault_path: Path,
    mapping: Mapping,
    old_tag: str,
    new_tag: str,
    apply: bool,
) -> list[RefactorResult]:
    results: list[RefactorResult] = []
    for note in notes:
        if not note_filter(note) or old_tag not in note.tags(mapping):
            continue
        result = RefactorResult(note.id, _rel(note.path, vault_path))
        result.add(f"tag: {old_tag} → {new_tag}")
        if apply:
            content, fm, _ = _read_and_parse(note.path)
            tags = [
                new_tag if tag == old_tag else tag
                for tag in _as_list(fm.get(mapping.tags))
            ]
            deduped = list(dict.fromkeys(tags))
            fm[mapping.tags] = deduped
            fm[mapping.updated_at] = _now()
            _write_with_fm(note.path, content, fm)
        results.append(result)
    return results


def cmd_tag_remove(
    notes: list[Note],
    note_filter: Callable[[Note], bool],
    vault_path: Path,
    mapping: Mapping,
    tag: str,
    apply: bool,
) -> list[RefactorResult]:
    results: list[RefactorResult] = []
    for note in notes:
        if not note_filter(note) or tag not in note.tags(mapping):
            continue
        result = RefactorResult(note.id, _rel(note.path, vault_path))
        result.add(f"tag remove: {tag}")
        if apply:
            content, fm, _ = _read_and_parse(note.path)
            fm[mapping.tags] = [t for t in _as_list(fm.get(mapping.tags)) if t != tag]
            fm[mapping.updated_at] = _now()
            _write_with_fm(note.path, content, fm)
        results.append(result)
    return results


def cmd_tag_add(
    notes: list[Note],
    note_filter: Callable[[Note], bool],
    vault_path: Path,
    mapping: Mapping,
    tag: str,
    apply: bool,
) -> list[RefactorResult]:
    results: list[RefactorResult] = []
    for note in notes:
        if not note_filter(note) or tag in note.tags(mapping):
            continue
        result = RefactorResult(note.id, _rel(note.path, vault_path))
        result.add(f"tag add: {tag}")
        if apply:
            content, fm, _ = _read_and_parse(note.path)
            tags = _as_list(fm.get(mapping.tags))
            tags.append(tag)
            fm[mapping.tags] = tags
            fm[mapping.updated_at] = _now()
            _write_with_fm(note.path, content, fm)
        results.append(result)
    return results


def cmd_wikilink_replace(
    notes: list[Note],
    note_filter: Callable[[Note], bool],
    vault_path: Path,
    mapping: Mapping,
    old_link: str,
    new_link: str,
    apply: bool,
) -> list[RefactorResult]:
    results: list[RefactorResult] = []
    pattern = re.compile(r"(\!?)\[\[" + re.escape(old_link) + r"(\|[^\]]*?)?\]\]")

    for note in notes:
        if not note_filter(note):
            continue
        content = note.path.read_text(encoding="utf-8")
        body_start = 0
        if content.startswith("---"):
            end_idx = content.find("\n---", 3)
            if end_idx != -1:
                body_start = end_idx + 4

        header = content[:body_start]
        body = content[body_start:]
        matches = list(pattern.finditer(body))
        if not matches:
            continue

        result = RefactorResult(note.id, _rel(note.path, vault_path))
        result.add(f"wikilink: [[{old_link}]] → [[{new_link}]] ({len(matches)}건)")
        if apply:
            new_body = pattern.sub(
                lambda match: f"{match.group(1)}[[{new_link}{match.group(2) or ''}]]",
                body,
            )
            note.path.write_text(header + new_body, encoding="utf-8")
            full_content, fm, _ = _read_and_parse(note.path)
            fm[mapping.updated_at] = _now()
            _write_with_fm(note.path, full_content, fm)
        results.append(result)
    return results


def cmd_ref_add(
    notes: list[Note],
    note_filter: Callable[[Note], bool],
    vault_path: Path,
    mapping: Mapping,
    ref_target: str,
    apply: bool,
) -> list[RefactorResult]:
    results: list[RefactorResult] = []
    for note in notes:
        if not note_filter(note) or ref_target in _ref_links(note, mapping):
            continue
        result = RefactorResult(note.id, _rel(note.path, vault_path))
        result.add(f"ref add: [[{ref_target}]]")
        if apply:
            content, fm, _ = _read_and_parse(note.path)
            refs = _as_list(fm.get(mapping.refs))
            refs.append(f"[[{ref_target}]]")
            fm[mapping.refs] = refs
            fm[mapping.updated_at] = _now()
            _write_with_fm(note.path, content, fm)
        results.append(result)
    return results


def cmd_ref_remove(
    notes: list[Note],
    note_filter: Callable[[Note], bool],
    vault_path: Path,
    mapping: Mapping,
    ref_target: str,
    apply: bool,
) -> list[RefactorResult]:
    results: list[RefactorResult] = []
    for note in notes:
        if not note_filter(note) or ref_target not in _ref_links(note, mapping):
            continue
        result = RefactorResult(note.id, _rel(note.path, vault_path))
        result.add(f"ref remove: [[{ref_target}]]")
        if apply:
            content, fm, _ = _read_and_parse(note.path)
            fm[mapping.refs] = [
                ref for ref in _as_list(fm.get(mapping.refs))
                if f"[[{ref_target}]]" not in str(ref)
            ]
            fm[mapping.updated_at] = _now()
            _write_with_fm(note.path, content, fm)
        results.append(result)
    return results


def _format_results(results: list[RefactorResult], apply: bool) -> str:
    mode = (
        f"{Colors.GREEN}APPLIED{Colors.RESET}"
        if apply
        else f"{Colors.YELLOW}DRY RUN{Colors.RESET}"
    )
    affected = [result for result in results if result.has_changes]

    lines = ["", "=" * 60, f"  Vault Refactor — {mode}", "=" * 60, ""]
    if not affected:
        lines.append(f"  {Colors.DIM}No matching notes found.{Colors.RESET}")
        lines.append("")
        return "\n".join(lines) + "\n"

    for result in affected:
        lines.append(f"  {Colors.CYAN}{result.rel_path}{Colors.RESET}")
        for change in result.changes:
            if " → " in change:
                before, after = change.split(" → ", 1)
                lines.append(f"    {Colors.RED}- {before}{Colors.RESET}")
                lines.append(f"    {Colors.GREEN}+ {after}{Colors.RESET}")
            else:
                lines.append(f"    {Colors.RED}- {change}{Colors.RESET}")
        lines.append("")

    lines.append(f"  {Colors.BOLD}Total: {len(affected)} note(s) affected{Colors.RESET}")
    if not apply:
        lines.append(f"  {Colors.YELLOW}Run with --apply to execute changes{Colors.RESET}")
    lines.append("")
    return "\n".join(lines) + "\n"


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ipa refactor",
        description="Vault 구조 리팩토링 (legacy)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", help="리팩토링 명령")

    p_rr = sub.add_parser("ref-replace", help="ref 교체")
    p_rr.add_argument("old")
    p_rr.add_argument("new")

    p_tr = sub.add_parser("tag-rename", help="태그 이름 변경")
    p_tr.add_argument("old")
    p_tr.add_argument("new")

    p_td = sub.add_parser("tag-remove", help="태그 제거")
    p_td.add_argument("tag")

    p_ta = sub.add_parser("tag-add", help="태그 추가")
    p_ta.add_argument("tag")

    p_wr = sub.add_parser("wikilink-replace", help="본문 wikilink 치환")
    p_wr.add_argument("old")
    p_wr.add_argument("new")

    p_ra = sub.add_parser("ref-add", help="ref 추가")
    p_ra.add_argument("ref")

    p_rm = sub.add_parser("ref-remove", help="ref 제거")
    p_rm.add_argument("ref")

    for subparser in (p_rr, p_tr, p_td, p_ta, p_wr, p_ra, p_rm):
        subparser.add_argument("--apply", action="store_true")
        subparser.add_argument("--filter", dest="filter", default=None)
        subparser.add_argument("--scope-ref", dest="scope_ref", default=None)
        subparser.add_argument("--scope-tag", dest="scope_tag", default=None)
        subparser.add_argument(
            "--scope-type",
            dest="scope_type",
            choices=["note", "index", "root"],
            default=None,
        )
        subparser.add_argument("--scope-folder", dest="scope_folder", default=None)

    return parser


def render_refactor(
    vault_path: Path,
    raw_args: list[str],
    mapping: Mapping | None = None,
) -> str:
    parser = _build_parser()
    if not raw_args:
        return parser.format_help()

    args = parser.parse_args(raw_args)
    if not args.command:
        return parser.format_help()

    if mapping is None:
        mapping = Mapping()
    notes = _notes(vault_path, mapping)
    note_filter = build_filter(args, vault_path, mapping)

    if args.command == "ref-replace":
        results = cmd_ref_replace(
            notes, note_filter, vault_path, mapping, args.old, args.new, args.apply
        )
    elif args.command == "tag-rename":
        results = cmd_tag_rename(
            notes, note_filter, vault_path, mapping, args.old, args.new, args.apply
        )
    elif args.command == "tag-remove":
        results = cmd_tag_remove(
            notes, note_filter, vault_path, mapping, args.tag, args.apply
        )
    elif args.command == "tag-add":
        results = cmd_tag_add(
            notes, note_filter, vault_path, mapping, args.tag, args.apply
        )
    elif args.command == "wikilink-replace":
        results = cmd_wikilink_replace(
            notes, note_filter, vault_path, mapping, args.old, args.new, args.apply
        )
    elif args.command == "ref-add":
        results = cmd_ref_add(
            notes, note_filter, vault_path, mapping, args.ref, args.apply
        )
    elif args.command == "ref-remove":
        results = cmd_ref_remove(
            notes, note_filter, vault_path, mapping, args.ref, args.apply
        )
    else:
        return parser.format_help()

    return _format_results(results, args.apply)

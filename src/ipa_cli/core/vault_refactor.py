#!/usr/bin/env python3
"""Vault Refactor: 구조 변경을 위한 일괄 수정 도구.

ref 교체, 태그 변경, wikilink 치환 등 vault 구조 리팩토링 작업을 안전하게 수행한다.
기본 dry-run, --apply로 실행.

Usage:
    # ref 교체: 🔖 IPA Method → 🔖 IPA 개념 (모든 노트)
    python3 vault_refactor.py ref-replace "🔖 IPA Method" "🔖 IPA 개념"

    # ref 교체: 특정 노트만 (--filter로 대상 제한)
    python3 vault_refactor.py ref-replace "🔖 IPA Method" "🔖 IPA 개념" \\
        --filter "IPA Method 기획,IPA Method 개념,PARA Method 후기"

    # 태그 이름 변경
    python3 vault_refactor.py tag-rename design_doc architecture

    # 태그 제거 (모든 노트에서)
    python3 vault_refactor.py tag-remove design_doc

    # 태그 추가 (특정 노트에)
    python3 vault_refactor.py tag-add convention --filter "IPA Vault Convention,IPA 리뷰 기준"

    # 본문 wikilink 치환
    python3 vault_refactor.py wikilink-replace "🔖 IPA Method" "🏷️ IPA Method Root"

    # ref 추가
    python3 vault_refactor.py ref-add "🔖 IPA Companion" --filter "IPA Companion Log 구조 설계"

    # ref 제거
    python3 vault_refactor.py ref-remove "🔖 Second Brain" --filter "IPA Method 기획"

    # 실제 적용
    python3 vault_refactor.py ref-replace "🔖 Old" "🔖 New" --apply

    # scope로 대상 필터링
    python3 vault_refactor.py tag-rename old_tag new_tag --scope-ref "🔖 IPA Method"
    python3 vault_refactor.py tag-remove old_tag --scope-tag "design_doc"
    python3 vault_refactor.py ref-replace "🔖 Old" "🔖 New" --scope-type note
    python3 vault_refactor.py ref-replace "🔖 Old" "🔖 New" --scope-folder "02 Archive"
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Callable

from .vault_parser import (
    DEFAULT_VAULT,
    WIKILINK_RE,
    VaultNote,
    build_note_index,
    parse_frontmatter,
    scan_vault,
)
from .notes_cache import scan_vault_cached  # noqa: E402

# === 출력 유틸 ===


class Colors:
    RED = "\033[91m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    CYAN = "\033[96m"
    DIM = "\033[2m"
    RESET = "\033[0m"
    BOLD = "\033[1m"


def _rel(note: VaultNote, vault_path: Path) -> str:
    try:
        return str(note.path.relative_to(vault_path))
    except ValueError:
        return str(note.path)


def _now() -> str:
    dt = datetime.now()
    return (
        dt.strftime("%Y/%m/%d") + f" ({dt.strftime('%a')}) " + dt.strftime("%H:%M:%S")
    )


# === Frontmatter 재직렬화 ===


def _serialize_frontmatter(fm: dict, original_content: str) -> str:
    """frontmatter dict를 원본 포맷을 최대한 보존하여 YAML 문자열로 직렬화한다.

    원본에서 인라인 배열 vs 멀티라인 배열 형식을 감지하여 동일하게 유지한다.
    """
    if not original_content.startswith("---"):
        return original_content

    end_idx = original_content.find("\n---", 3)
    if end_idx == -1:
        return original_content

    original_fm_text = original_content[4:end_idx]
    body = original_content[end_idx + 4 :]

    # 원본에서 각 키의 포맷 스타일 감지
    inline_keys: set[str] = set()
    multiline_keys: set[str] = set()

    for line in original_fm_text.split("\n"):
        stripped = line.strip()
        if ":" in stripped and not stripped.startswith("-"):
            colon_idx = stripped.index(":")
            key = stripped[:colon_idx].strip()
            val = stripped[colon_idx + 1 :].strip()
            if val.startswith("["):
                inline_keys.add(key)
            elif not val:
                multiline_keys.add(key)

    # 새 frontmatter 생성
    lines = []
    for key, value in fm.items():
        if isinstance(value, list):
            if key in multiline_keys:
                if not value:
                    lines.append(f"{key}:")
                else:
                    lines.append(f"{key}:")
                    for item in value:
                        lines.append(f'  - "{item}"')
            else:
                # 인라인 배열 (기본)
                if not value:
                    lines.append(f"{key}: []")
                else:
                    items = ", ".join(
                        f'"{v}"' if "[[" in str(v) else str(v) for v in value
                    )
                    lines.append(f"{key}: [{items}]")
        else:
            lines.append(f"{key}: {value}")

    return "---\n" + "\n".join(lines) + "\n---" + body


def _read_and_parse(path: Path) -> tuple[str, dict, str]:
    """파일을 읽고 (원본, frontmatter, body) 튜플로 반환한다."""
    content = path.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(content)
    return content, fm, body


def _write_with_fm(path: Path, original_content: str, fm: dict) -> None:
    """frontmatter만 변경하고 body는 보존하여 파일에 쓴다."""
    new_content = _serialize_frontmatter(fm, original_content)
    path.write_text(new_content, encoding="utf-8")


# === 필터링 ===


def build_filter(
    args: argparse.Namespace,
    note_index: dict[str, VaultNote],
    vault_path: Path,
) -> Callable[[VaultNote], bool]:
    """CLI 인자를 기반으로 노트 필터 함수를 생성한다."""
    predicates: list[Callable[[VaultNote], bool]] = []

    # --filter: 노트명 직접 지정 (쉼표 구분)
    if args.filter:
        names = {n.strip() for n in args.filter.split(",")}
        predicates.append(lambda note: note.filename in names)

    # --scope-ref: 특정 ref를 가진 노트만
    if args.scope_ref:
        predicates.append(lambda note: args.scope_ref in note.ref_links)

    # --scope-tag: 특정 태그를 가진 노트만
    if args.scope_tag:
        predicates.append(lambda note: args.scope_tag in note.tags)

    # --scope-type: 특정 type만
    if args.scope_type:
        predicates.append(lambda note: note.note_type == args.scope_type)

    # --scope-folder: 특정 폴더 아래만
    if args.scope_folder:
        predicates.append(
            lambda note: _rel(note, vault_path).startswith(args.scope_folder)
        )

    if not predicates:
        return lambda _: True

    return lambda note: all(p(note) for p in predicates)


# === 리팩토링 명령 구현 ===


class RefactorResult:
    """단일 노트의 리팩토링 결과."""

    def __init__(self, note_name: str, rel_path: str):
        self.note_name = note_name
        self.rel_path = rel_path
        self.changes: list[str] = []

    def add(self, description: str) -> None:
        self.changes.append(description)

    @property
    def has_changes(self) -> bool:
        return len(self.changes) > 0


def cmd_ref_replace(
    notes: list[VaultNote],
    note_filter: Callable[[VaultNote], bool],
    vault_path: Path,
    old_ref: str,
    new_ref: str,
    apply: bool,
) -> list[RefactorResult]:
    """frontmatter ref에서 old_ref를 new_ref로 교체한다."""
    results = []

    for note in notes:
        if not note_filter(note):
            continue
        if old_ref not in note.ref_links:
            continue

        result = RefactorResult(note.filename, _rel(note, vault_path))
        result.add(f"ref: [[{old_ref}]] → [[{new_ref}]]")

        if apply:
            content, fm, _ = _read_and_parse(note.path)

            raw_ref = fm.get("ref", [])
            if isinstance(raw_ref, str):
                raw_ref = [raw_ref]

            new_ref_list = []
            for item in raw_ref:
                replaced = item.replace(f"[[{old_ref}]]", f"[[{new_ref}]]")
                new_ref_list.append(replaced)
            fm["ref"] = new_ref_list
            fm["date_modified"] = _now()

            _write_with_fm(note.path, content, fm)

        results.append(result)

    return results


def cmd_tag_rename(
    notes: list[VaultNote],
    note_filter: Callable[[VaultNote], bool],
    vault_path: Path,
    old_tag: str,
    new_tag: str,
    apply: bool,
) -> list[RefactorResult]:
    """모든 매칭 노트에서 태그를 이름 변경한다."""
    results = []

    for note in notes:
        if not note_filter(note):
            continue
        if old_tag not in note.tags:
            continue

        result = RefactorResult(note.filename, _rel(note, vault_path))
        result.add(f"tag: {old_tag} → {new_tag}")

        if apply:
            content, fm, _ = _read_and_parse(note.path)

            tags = fm.get("tags", [])
            if isinstance(tags, str):
                tags = [tags]

            new_tags = [new_tag if t == old_tag else t for t in tags]
            # 중복 제거 (순서 보존)
            seen: set[str] = set()
            deduped = []
            for t in new_tags:
                if t not in seen:
                    seen.add(t)
                    deduped.append(t)
            fm["tags"] = deduped
            fm["date_modified"] = _now()

            _write_with_fm(note.path, content, fm)

        results.append(result)

    return results


def cmd_tag_remove(
    notes: list[VaultNote],
    note_filter: Callable[[VaultNote], bool],
    vault_path: Path,
    tag: str,
    apply: bool,
) -> list[RefactorResult]:
    """매칭 노트에서 특정 태그를 제거한다."""
    results = []

    for note in notes:
        if not note_filter(note):
            continue
        if tag not in note.tags:
            continue

        result = RefactorResult(note.filename, _rel(note, vault_path))
        result.add(f"tag remove: {tag}")

        if apply:
            content, fm, _ = _read_and_parse(note.path)

            tags = fm.get("tags", [])
            if isinstance(tags, str):
                tags = [tags]
            fm["tags"] = [t for t in tags if t != tag]
            fm["date_modified"] = _now()

            _write_with_fm(note.path, content, fm)

        results.append(result)

    return results


def cmd_tag_add(
    notes: list[VaultNote],
    note_filter: Callable[[VaultNote], bool],
    vault_path: Path,
    tag: str,
    apply: bool,
) -> list[RefactorResult]:
    """매칭 노트에 태그를 추가한다."""
    results = []

    for note in notes:
        if not note_filter(note):
            continue
        if tag in note.tags:
            continue

        result = RefactorResult(note.filename, _rel(note, vault_path))
        result.add(f"tag add: {tag}")

        if apply:
            content, fm, _ = _read_and_parse(note.path)

            tags = fm.get("tags", [])
            if isinstance(tags, str):
                tags = [tags]
            tags.append(tag)
            fm["tags"] = tags
            fm["date_modified"] = _now()

            _write_with_fm(note.path, content, fm)

        results.append(result)

    return results


def cmd_wikilink_replace(
    notes: list[VaultNote],
    note_filter: Callable[[VaultNote], bool],
    vault_path: Path,
    old_link: str,
    new_link: str,
    apply: bool,
) -> list[RefactorResult]:
    """본문의 [[old_link]] → [[new_link]] 또는 [[old_link|alias]] → [[new_link|alias]]로 치환한다."""
    results = []

    # [[old_link]] 또는 [[old_link|...]] 매칭
    pattern = re.compile(r"(\!?)\[\[" + re.escape(old_link) + r"(\|[^\]]*?)?\]\]")

    for note in notes:
        if not note_filter(note):
            continue

        content = note.path.read_text(encoding="utf-8")

        # frontmatter 영역 건너뛰기
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

        result = RefactorResult(note.filename, _rel(note, vault_path))
        result.add(f"wikilink: [[{old_link}]] → [[{new_link}]] ({len(matches)}건)")

        if apply:
            new_body = pattern.sub(
                lambda m: f"{m.group(1)}[[{new_link}{m.group(2) or ''}]]",
                body,
            )
            new_content = header + new_body
            note.path.write_text(new_content, encoding="utf-8")

            # date_modified 업데이트
            full_content, fm, _ = _read_and_parse(note.path)
            fm["date_modified"] = _now()
            _write_with_fm(note.path, full_content, fm)

        results.append(result)

    return results


def cmd_ref_add(
    notes: list[VaultNote],
    note_filter: Callable[[VaultNote], bool],
    vault_path: Path,
    ref_target: str,
    apply: bool,
) -> list[RefactorResult]:
    """매칭 노트에 ref를 추가한다."""
    results = []

    for note in notes:
        if not note_filter(note):
            continue
        if ref_target in note.ref_links:
            continue

        result = RefactorResult(note.filename, _rel(note, vault_path))
        result.add(f"ref add: [[{ref_target}]]")

        if apply:
            content, fm, _ = _read_and_parse(note.path)

            raw_ref = fm.get("ref", [])
            if isinstance(raw_ref, str):
                raw_ref = [raw_ref]
            if not isinstance(raw_ref, list):
                raw_ref = []
            raw_ref.append(f"[[{ref_target}]]")
            fm["ref"] = raw_ref
            fm["date_modified"] = _now()

            _write_with_fm(note.path, content, fm)

        results.append(result)

    return results


def cmd_ref_remove(
    notes: list[VaultNote],
    note_filter: Callable[[VaultNote], bool],
    vault_path: Path,
    ref_target: str,
    apply: bool,
) -> list[RefactorResult]:
    """매칭 노트에서 특정 ref를 제거한다."""
    results = []

    for note in notes:
        if not note_filter(note):
            continue
        if ref_target not in note.ref_links:
            continue

        result = RefactorResult(note.filename, _rel(note, vault_path))
        result.add(f"ref remove: [[{ref_target}]]")

        if apply:
            content, fm, _ = _read_and_parse(note.path)

            raw_ref = fm.get("ref", [])
            if isinstance(raw_ref, str):
                raw_ref = [raw_ref]
            fm["ref"] = [r for r in raw_ref if f"[[{ref_target}]]" not in r]
            fm["date_modified"] = _now()

            _write_with_fm(note.path, content, fm)

        results.append(result)

    return results


# === 출력 ===


def print_results(results: list[RefactorResult], apply: bool) -> None:
    """리팩토링 결과를 출력한다."""
    mode = (
        f"{Colors.GREEN}APPLIED{Colors.RESET}"
        if apply
        else f"{Colors.YELLOW}DRY RUN{Colors.RESET}"
    )
    affected = [r for r in results if r.has_changes]

    print(f"\n{'=' * 60}")
    print(f"  Vault Refactor — {mode}")
    print(f"{'=' * 60}\n")

    if not affected:
        print(f"  {Colors.DIM}No matching notes found.{Colors.RESET}\n")
        return

    for result in affected:
        print(f"  {Colors.CYAN}{result.rel_path}{Colors.RESET}")
        for change in result.changes:
            print(
                f"    {Colors.RED}- {change.split(' → ')[0] if ' → ' in change else change}{Colors.RESET}"
            )
            if " → " in change:
                print(f"    {Colors.GREEN}+ {change.split(' → ')[1]}{Colors.RESET}")
        print()

    print(f"  {Colors.BOLD}Total: {len(affected)} note(s) affected{Colors.RESET}")
    if not apply:
        print(f"  {Colors.YELLOW}Run with --apply to execute changes{Colors.RESET}")
    print()


# === CLI ===


def main():
    parser = argparse.ArgumentParser(
        description="Vault 구조 리팩토링 도구",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # ref 교체 (dry-run)
  %(prog)s ref-replace "🔖 Old Index" "🔖 New Index"

  # 특정 노트만 ref 교체 후 적용
  %(prog)s ref-replace "🔖 Old" "🔖 New" --filter "Note1,Note2" --apply

  # 태그 일괄 변경
  %(prog)s tag-rename design_doc architecture --apply

  # 특정 ref를 가진 노트들의 태그만 변경
  %(prog)s tag-rename old new --scope-ref "🔖 IPA Method"

  # 본문 wikilink 치환
  %(prog)s wikilink-replace "🔖 IPA Method" "🏷️ IPA Method Root"
        """,
    )

    # 서브커맨드
    sub = parser.add_subparsers(dest="command", help="리팩토링 명령")

    # ref-replace
    p_rr = sub.add_parser("ref-replace", help="ref 교체")
    p_rr.add_argument("old", help="교체 대상 ref (노트명)")
    p_rr.add_argument("new", help="새 ref (노트명)")

    # tag-rename
    p_tr = sub.add_parser("tag-rename", help="태그 이름 변경")
    p_tr.add_argument("old", help="기존 태그명")
    p_tr.add_argument("new", help="새 태그명")

    # tag-remove
    p_td = sub.add_parser("tag-remove", help="태그 제거")
    p_td.add_argument("tag", help="제거할 태그명")

    # tag-add
    p_ta = sub.add_parser("tag-add", help="태그 추가")
    p_ta.add_argument("tag", help="추가할 태그명")

    # wikilink-replace
    p_wr = sub.add_parser("wikilink-replace", help="본문 wikilink 치환")
    p_wr.add_argument("old", help="교체 대상 링크 (노트명)")
    p_wr.add_argument("new", help="새 링크 (노트명)")

    # ref-add
    p_ra = sub.add_parser("ref-add", help="ref 추가")
    p_ra.add_argument("ref", help="추가할 ref (노트명)")

    # ref-remove
    p_rm = sub.add_parser("ref-remove", help="ref 제거")
    p_rm.add_argument("ref", help="제거할 ref (노트명)")

    # 공통 옵션
    for p in [p_rr, p_tr, p_td, p_ta, p_wr, p_ra, p_rm]:
        p.add_argument("--apply", action="store_true", help="실제 적용 (기본: dry-run)")
        p.add_argument("--vault", default=str(DEFAULT_VAULT), help="vault 경로")
        p.add_argument(
            "--filter",
            metavar="NOTES",
            help="대상 노트 직접 지정 (쉼표 구분, 예: 'Note1,Note2')",
        )
        p.add_argument("--scope-ref", metavar="REF", help="이 ref를 가진 노트만 대상")
        p.add_argument("--scope-tag", metavar="TAG", help="이 태그를 가진 노트만 대상")
        p.add_argument(
            "--scope-type", choices=["note", "index", "root"], help="이 type만 대상"
        )
        p.add_argument("--scope-folder", metavar="FOLDER", help="이 폴더 아래만 대상")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    vault_path = Path(args.vault)
    notes = scan_vault_cached(vault_path)
    note_index = build_note_index(notes)
    note_filter = build_filter(args, note_index, vault_path)

    # 명령 실행
    if args.command == "ref-replace":
        results = cmd_ref_replace(
            notes, note_filter, vault_path, args.old, args.new, args.apply
        )
    elif args.command == "tag-rename":
        results = cmd_tag_rename(
            notes, note_filter, vault_path, args.old, args.new, args.apply
        )
    elif args.command == "tag-remove":
        results = cmd_tag_remove(notes, note_filter, vault_path, args.tag, args.apply)
    elif args.command == "tag-add":
        results = cmd_tag_add(notes, note_filter, vault_path, args.tag, args.apply)
    elif args.command == "wikilink-replace":
        results = cmd_wikilink_replace(
            notes, note_filter, vault_path, args.old, args.new, args.apply
        )
    elif args.command == "ref-add":
        results = cmd_ref_add(notes, note_filter, vault_path, args.ref, args.apply)
    elif args.command == "ref-remove":
        results = cmd_ref_remove(notes, note_filter, vault_path, args.ref, args.apply)
    else:
        parser.print_help()
        sys.exit(1)

    print_results(results, args.apply)


if __name__ == "__main__":
    main()

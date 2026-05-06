#!/usr/bin/env python3
"""Vault Validator: ruff 스타일 구조 검증 + 규칙 기반 자동 수정.

Usage:
    python3 vault_validator.py                        # 전체 vault 검증
    python3 vault_validator.py --note "Colombia"      # 단일 노트 검증
    python3 vault_validator.py --select P,T           # 카테고리 선택
    python3 vault_validator.py --select P001,K002     # 개별 규칙 선택
    python3 vault_validator.py --ignore K002          # 특정 규칙 무시
    python3 vault_validator.py --fix --dry-run        # 자동 수정 미리보기
    python3 vault_validator.py --fix                  # 자동 수정 실행
    python3 vault_validator.py --format json          # JSON 출력
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from .vault_parser import (
    DATE_PATTERN,
    DEFAULT_VAULT,
    VaultNote,
    build_note_index,
    scan_vault,
)
from .notes_cache import scan_vault_cached  # noqa: E402

VALID_TYPES = {"note", "index", "root"}

# === 검증 제외 대상 ===

# 특수 목적 노트 (vault 대시보드 등)
EXCLUDED_NOTES: set[str] = {
    "🏠 Home",
}

# 시스템 root (Inbox/Project/Archive 최상위 root)
SYSTEM_ROOTS: set[str] = {
    "🏷️ 00 Inbox Root",
    "🏷️ 01 Project Root",
    "🏷️ 02 Archive Root",
}

# 제외 접두사 (핀 이모지 고정 노트)
EXCLUDED_PREFIXES: tuple[str, ...] = ("📌",)


def _is_excluded(note: "VaultNote") -> bool:
    """검증에서 제외할 노트인지 판별한다."""
    name = note.filename
    if name in EXCLUDED_NOTES or name in SYSTEM_ROOTS:
        return True
    if any(name.startswith(p) for p in EXCLUDED_PREFIXES):
        return True
    if note.path.suffix == ".md" and note.path.stem.endswith(".excalidraw"):
        return True
    if note.frontmatter.get("excalidraw-plugin"):
        return True
    return False


BACKLINKS_SECTION = """
## Backlinks

```dataview
LIST
WHERE contains(file.outlinks, this.file.link)
SORT file.cdate DESC, file.name ASC
```"""


# === 규칙 코드 정의 ===

RULE_CODES = {
    # Properties
    "P001": "필수 필드 누락",
    "P002": "date 포맷 불일치",
    "P003": "유효하지 않은 type",
    "P004": "note/index인데 ref 없음",
    # Title
    "T001": "root인데 🏷️ prefix 없음",
    "T002": "root인데 Root suffix 없음",
    "T003": "index인데 🔖 prefix 없음",
    # Location
    "L001": "type 대비 위치 부적합",
    # Links
    "K001": "ref 링크 대상 미존재",
    "K002": "wikilink 대상 미존재",
    # Root-folder
    "R001": "폴더에 root 중복",
    "R002": "폴더에 root 없음",
    # Headers
    "H001": "h1 헤더 사용 (파일명이 제목 역할, ## h2 사용 권장)",
}

CATEGORIES = {
    "P": "properties",
    "T": "title",
    "L": "location",
    "K": "links",
    "R": "root_folder",
    "H": "headers",
}


def parse_rule_filter(
    select_str: str | None, ignore_str: str | None
) -> set[str] | None:
    """--select/--ignore를 파싱하여 활성 규칙 코드 집합을 반환한다.

    Returns None이면 모든 규칙 활성.
    """
    all_codes = set(RULE_CODES.keys())

    if select_str:
        selected = set()
        for token in select_str.split(","):
            token = token.strip().upper()
            if token in CATEGORIES:
                selected |= {c for c in all_codes if c.startswith(token)}
            elif token in all_codes:
                selected.add(token)
        active = selected
    else:
        active = all_codes

    if ignore_str:
        for token in ignore_str.split(","):
            token = token.strip().upper()
            if token in CATEGORIES:
                active -= {c for c in active if c.startswith(token)}
            elif token in all_codes:
                active.discard(token)

    return active if active != all_codes else None


@dataclass
class Issue:
    note_name: str
    note_path: str
    code: str
    message: str
    fixable: bool = False

    @property
    def category(self) -> str:
        prefix = self.code[0]
        return CATEGORIES.get(prefix, "unknown")

    def to_dict(self) -> dict:
        return {
            "note": self.note_name,
            "path": self.note_path,
            "code": self.code,
            "category": self.category,
            "message": self.message,
            "fixable": self.fixable,
        }


@dataclass
class ValidationReport:
    total_notes: int = 0
    valid_notes: int = 0
    issues: list[Issue] = field(default_factory=list)

    def add(self, issue: Issue):
        self.issues.append(issue)

    @property
    def issue_count(self) -> int:
        return len(self.issues)

    @property
    def fixable_count(self) -> int:
        return sum(1 for i in self.issues if i.fixable)

    def to_dict(self) -> dict:
        return {
            "total_notes": self.total_notes,
            "valid_notes": self.valid_notes,
            "issue_count": self.issue_count,
            "fixable_count": self.fixable_count,
            "issues": [i.to_dict() for i in self.issues],
        }


# === 검증 함수들 ===


def _rel_path(note: VaultNote, vault_path: Path) -> str:
    try:
        return str(note.path.relative_to(vault_path))
    except ValueError:
        return str(note.path)


def check_properties(
    note: VaultNote, vault_path: Path, active: set[str] | None
) -> list[Issue]:
    issues = []
    fm = note.frontmatter
    name = note.filename
    rel = _rel_path(note, vault_path)

    if active is None or "P001" in active:
        required = ["date_created", "date_modified", "tags", "type"]
        for field_name in required:
            if field_name not in fm:
                fixable = field_name in ("date_created", "type")
                issues.append(
                    Issue(
                        name,
                        rel,
                        "P001",
                        f"필수 필드 누락: {field_name}",
                        fixable=fixable,
                    )
                )

    if active is None or "P002" in active:
        for date_field in ["date_created", "date_modified"]:
            val = fm.get(date_field, "")
            if val and not DATE_PATTERN.match(str(val)):
                issues.append(
                    Issue(name, rel, "P002", f"{date_field} 포맷 불일치: {val}")
                )

    if active is None or "P003" in active:
        note_type = fm.get("type", "")
        if note_type and note_type not in VALID_TYPES:
            issues.append(Issue(name, rel, "P003", f"유효하지 않은 type: {note_type}"))

    if active is None or "P004" in active:
        note_type = fm.get("type", "")
        if note_type in ("note", "index"):
            idx = fm.get("ref", [])
            if not idx or (isinstance(idx, list) and len(idx) == 0):
                issues.append(
                    Issue(name, rel, "P004", f"type={note_type}인데 ref 연결 없음")
                )

    return issues


def check_title(
    note: VaultNote, vault_path: Path, active: set[str] | None
) -> list[Issue]:
    issues = []
    name = note.filename
    rel = _rel_path(note, vault_path)

    if note.note_type == "root":
        if active is None or "T001" in active:
            if not name.startswith("🏷️"):
                issues.append(Issue(name, rel, "T001", "root인데 🏷️ prefix 없음"))
        if active is None or "T002" in active:
            if not name.endswith("Root"):
                issues.append(Issue(name, rel, "T002", "root인데 'Root' suffix 없음"))
    elif note.note_type == "index":
        if active is None or "T003" in active:
            if not name.startswith("🔖"):
                issues.append(Issue(name, rel, "T003", "index인데 🔖 prefix 없음"))

    return issues


def check_location(
    note: VaultNote, vault_path: Path, active: set[str] | None
) -> list[Issue]:
    if active is not None and "L001" not in active:
        return []

    issues = []
    rel = _rel_path(note, vault_path)
    name = note.filename

    if note.note_type == "note":
        if not (rel.startswith("00 Inbox/") or rel.startswith("02 Archive/")):
            issues.append(
                Issue(name, rel, "L001", f"type=note인데 허용되지 않는 위치: {rel}")
            )
    elif note.note_type == "index":
        if not (rel.startswith("01 Project/") or rel.startswith("02 Archive/")):
            issues.append(
                Issue(name, rel, "L001", f"type=index인데 허용되지 않는 위치: {rel}")
            )
    elif note.note_type == "root":
        if not (rel.startswith("01 Project/") or rel.startswith("02 Archive/")):
            issues.append(
                Issue(name, rel, "L001", f"type=root인데 허용되지 않는 위치: {rel}")
            )

    return issues


def _build_attachment_index(vault_path: Path) -> set[str]:
    """vault 내 비-md 첨부파일(이미지, PDF 등)의 파일명(확장자 포함) 집합을 반환한다."""
    attachment_exts = {
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".svg",
        ".webp",
        ".bmp",
        ".pdf",
        ".mp3",
        ".mp4",
        ".webm",
        ".wav",
        ".ogg",
    }
    result: set[str] = set()
    for f in vault_path.rglob("*"):
        if f.is_file() and f.suffix.lower() in attachment_exts:
            # macOS APFS는 NFD로 저장하지만 wikilink 텍스트는 NFC → 정규화 필요
            stem = unicodedata.normalize("NFC", f.stem)
            name = unicodedata.normalize("NFC", f.name)
            result.add(stem)  # 확장자 없는 이름 (wikilink 매칭용)
            result.add(name)  # 확장자 포함 이름
    return result


def check_links(
    note: VaultNote,
    vault_path: Path,
    note_index: dict[str, VaultNote],
    active: set[str] | None,
    attachment_index: set[str] | None = None,
) -> list[Issue]:
    issues = []
    name = note.filename
    rel = _rel_path(note, vault_path)

    if active is None or "K001" in active:
        for link in note.ref_links:
            if link not in note_index:
                issues.append(Issue(name, rel, "K001", f"ref 링크 대상 미존재: {link}"))

    if active is None or "K002" in active:
        attachments = attachment_index or set()
        for link in note.wikilinks:
            link_name = link.split("#")[0] if "#" in link else link
            if (
                link_name
                and link_name not in note_index
                and link_name not in attachments
            ):
                issues.append(Issue(name, rel, "K002", f"wikilink 대상 미존재: {link}"))

    return issues


def check_headers(
    note: VaultNote, vault_path: Path, active: set[str] | None
) -> list[Issue]:
    if active is not None and "H001" not in active:
        return []

    issues = []
    rel = _rel_path(note, vault_path)
    name = note.filename

    for line in note.body.splitlines():
        stripped = line.strip()
        if stripped.startswith("# ") and not stripped.startswith("## "):
            h1_text = stripped[2:].strip()
            fixable = h1_text == name
            issues.append(
                Issue(
                    name,
                    rel,
                    "H001",
                    f"h1 헤더 사용: '{stripped}' (파일명이 제목 역할, ## h2 사용 권장)",
                    fixable=fixable,
                )
            )
            break

    return issues


def check_root_folder_correspondence(
    notes: list[VaultNote], vault_path: Path, active: set[str] | None
) -> list[Issue]:
    r001_active = active is None or "R001" in active
    r002_active = active is None or "R002" in active
    if not r001_active and not r002_active:
        return []

    issues = []
    project_path = vault_path / "01 Project"
    if not project_path.exists():
        return issues

    root_folders: dict[Path, VaultNote] = {}
    for note in notes:
        if note.note_type != "root":
            continue
        rel = str(note.path.relative_to(vault_path))
        if not rel.startswith("01 Project/"):
            continue
        folder = note.path.parent
        if folder in root_folders:
            if r001_active:
                issues.append(
                    Issue(
                        note.filename, rel, "R001", f"폴더에 root 중복: {folder.name}"
                    )
                )
        else:
            root_folders[folder] = note

    if r002_active:
        for folder in sorted(project_path.iterdir()):
            if not folder.is_dir() or folder.name.startswith("."):
                continue
            if folder not in root_folders:
                rel = str(folder.relative_to(vault_path))
                issues.append(
                    Issue(
                        folder.name,
                        rel,
                        "R002",
                        f"폴더에 root 노트 없음: {folder.name}",
                    )
                )

    return issues


# === 자동 수정 함수들 ===


def fix_missing_date(note: VaultNote, dry_run: bool = True) -> str | None:
    if "date_created" in note.frontmatter:
        return None

    ctime = os.path.getctime(note.path)
    dt = datetime.fromtimestamp(ctime)
    date_str = (
        dt.strftime("%Y/%m/%d") + f" ({dt.strftime('%a')}) " + dt.strftime("%H:%M:%S")
    )

    desc = f"P001 fix: date_created 추가: {date_str}"
    if dry_run:
        return desc

    content = note.path.read_text(encoding="utf-8")
    if content.startswith("---"):
        content = content.replace("---\n", f"---\ndate_created: {date_str}\n", 1)
        note.path.write_text(content, encoding="utf-8")
    return desc


def fix_missing_type(note: VaultNote, dry_run: bool = True) -> str | None:
    if "type" in note.frontmatter:
        return None

    name = note.filename
    if name.startswith("🏷️") and "Root" in name:
        inferred = "root"
    elif name.startswith("🔖"):
        inferred = "index"
    else:
        inferred = "note"

    desc = f"P001 fix: type 추가: {inferred}"
    if dry_run:
        return desc

    content = note.path.read_text(encoding="utf-8")
    if content.startswith("---"):
        end = content.find("\n---", 3)
        if end != -1:
            content = content[:end] + f"\ntype: {inferred}" + content[end:]
            note.path.write_text(content, encoding="utf-8")
    return desc


def fix_h1_heading(note: VaultNote, dry_run: bool = True) -> str | None:
    """H001 fix: 파일명과 동일한 h1 헤더 제거."""
    name = note.filename
    lines = note.body.splitlines(keepends=True)
    h1_idx = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("# ") and not stripped.startswith("## "):
            if stripped[2:].strip() == name:
                h1_idx = i
            break

    if h1_idx is None:
        return None

    desc = f"H001 fix: 파일명과 동일한 h1 제거: '# {name}'"
    if dry_run:
        return desc

    content = note.path.read_text(encoding="utf-8")
    # frontmatter 이후의 body에서 h1 라인 제거
    fm_end = content.find("\n---", 3)
    if fm_end == -1:
        return None
    body_start = fm_end + 4
    body = content[body_start:].lstrip("\n")
    body_lines = body.splitlines(keepends=True)

    # body 내에서 h1 라인 찾아 제거
    for i, line in enumerate(body_lines):
        stripped = line.strip()
        if stripped.startswith("# ") and not stripped.startswith("## "):
            if stripped[2:].strip() == name:
                del body_lines[i]
                # 연속된 빈 줄 정리
                while body_lines and body_lines[0].strip() == "":
                    del body_lines[0]
                break

    new_body = "".join(body_lines)
    new_content = content[:body_start] + "\n" + new_body
    note.path.write_text(new_content, encoding="utf-8")
    return desc


def fix_missing_backlinks(note: VaultNote, dry_run: bool = True) -> str | None:
    if note.note_type not in ("index", "root"):
        return None

    content = note.path.read_text(encoding="utf-8")
    if "```dataview" in content:
        return None

    desc = "fix: Backlinks dataview 섹션 추가"
    if dry_run:
        return desc

    content = content.rstrip() + "\n" + BACKLINKS_SECTION + "\n"
    note.path.write_text(content, encoding="utf-8")
    return desc


# === 메인 로직 ===


def validate_vault(
    notes: list[VaultNote],
    note_index: dict[str, VaultNote],
    vault_path: Path,
    target_note: str | None = None,
    active: set[str] | None = None,
) -> ValidationReport:
    report = ValidationReport()

    target_notes = notes
    if target_note:
        n = note_index.get(target_note)
        if n:
            target_notes = [n]
        else:
            print(f"Note not found: {target_note}", file=sys.stderr)
            return report

    report.total_notes = len(target_notes)

    attachment_index = _build_attachment_index(vault_path)

    for note in target_notes:
        if _is_excluded(note):
            report.valid_notes += 1
            continue
        note_issues: list[Issue] = []
        note_issues.extend(check_properties(note, vault_path, active))
        note_issues.extend(check_title(note, vault_path, active))
        note_issues.extend(check_location(note, vault_path, active))
        note_issues.extend(
            check_links(note, vault_path, note_index, active, attachment_index)
        )
        note_issues.extend(check_headers(note, vault_path, active))

        if not note_issues:
            report.valid_notes += 1
        for issue in note_issues:
            report.add(issue)

    if not target_note:
        report.issues.extend(
            check_root_folder_correspondence(notes, vault_path, active)
        )

    return report


def apply_fixes(
    notes: list[VaultNote],
    note_index: dict[str, VaultNote],
    dry_run: bool = True,
    target_note: str | None = None,
):
    target_notes = notes
    if target_note:
        n = note_index.get(target_note)
        if n:
            target_notes = [n]
        else:
            print(f"Note not found: {target_note}", file=sys.stderr)
            return

    fixes = []
    for note in target_notes:
        for fix_fn in [
            fix_missing_date,
            fix_missing_type,
            fix_h1_heading,
            fix_missing_backlinks,
        ]:
            result = fix_fn(note, dry_run=dry_run)
            if result:
                fixes.append((note.filename, result))

    mode = "DRY RUN" if dry_run else "APPLIED"
    print(f"\n=== Auto Fix ({mode}) ===")
    if fixes:
        for name, desc in fixes:
            print(f"  [{name}] {desc}")
        print(f"\nTotal fixes: {len(fixes)}")
    else:
        print("  No fixes needed.")


def format_report_text(report: ValidationReport) -> str:
    lines = []

    # 파일별로 그룹화
    by_file: dict[str, list[Issue]] = {}
    for issue in report.issues:
        by_file.setdefault(issue.note_path, []).append(issue)

    for filepath in sorted(by_file.keys()):
        issues = by_file[filepath]
        lines.append(filepath)
        for issue in issues:
            fix_marker = " [fixable]" if issue.fixable else ""
            lines.append(f"  {issue.code} {issue.message}{fix_marker}")
        lines.append("")

    lines.append(f"Found {report.issue_count} issues ({report.fixable_count} fixable)")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Vault structure validation (ruff-style)"
    )
    parser.add_argument("--fix", action="store_true", help="자동 수정 실행")
    parser.add_argument(
        "--dry-run", action="store_true", help="수정 미리보기 (--fix와 함께)"
    )
    parser.add_argument("--note", metavar="NAME", help="단일 노트만 검증")
    parser.add_argument("--vault", default=str(DEFAULT_VAULT), help="vault 경로")
    parser.add_argument(
        "--select", metavar="RULES", help="활성화할 규칙 (예: P,T 또는 P001,K002)"
    )
    parser.add_argument("--ignore", metavar="RULES", help="무시할 규칙 (예: K002)")
    parser.add_argument(
        "--format", choices=["text", "json"], default="text", help="출력 형식"
    )
    args = parser.parse_args()

    vault_path = Path(args.vault)
    notes = scan_vault_cached(vault_path)
    note_index = build_note_index(notes)

    active = parse_rule_filter(args.select, args.ignore)

    if args.fix:
        apply_fixes(notes, note_index, dry_run=args.dry_run, target_note=args.note)
        return

    report = validate_vault(
        notes, note_index, vault_path, target_note=args.note, active=active
    )

    if args.format == "json":
        print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    else:
        print(format_report_text(report))


if __name__ == "__main__":
    main()

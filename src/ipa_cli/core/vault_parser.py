#!/usr/bin/env python3
"""Vault Parser: frontmatter 파싱, wikilink 추출, vault 인덱싱.

Usage:
    python3 vault_parser.py [vault_path]
    기본값: 스크립트 위치 기준 vault root 자동 감지
"""

from __future__ import annotations

import re
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# vault root 결정:
#   1) IPA_VAULT_PATH 환경변수 (ipa-cli 패키지 또는 thin shim 경로에서 표준)
#   2) 폴백: 스크립트 위치에서 4단계 상위 (레거시 _shared/scripts/ 레이아웃 호환)
import os as _os

SCRIPT_DIR = Path(__file__).resolve().parent
_ENV_VAULT = _os.environ.get("IPA_VAULT_PATH")
DEFAULT_VAULT = (
    Path(_ENV_VAULT).expanduser()
    if _ENV_VAULT
    else SCRIPT_DIR.parent.parent.parent.parent
)

EXCLUDE_DIRS = {
    "90 Settings",
    ".obsidian",
    ".claude",
    ".skills",
    ".trash",
    ".git",
    ".opencode",
}

DATE_PATTERN = re.compile(r"\d{4}/\d{2}/\d{2} \(\w{3}\) \d{2}:\d{2}:\d{2}")
WIKILINK_RE = re.compile(r"(?<!!)\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]")
EMBED_RE = re.compile(r"!\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]")


@dataclass
class VaultNote:
    path: Path
    frontmatter: dict = field(default_factory=dict)
    body: str = ""
    note_type: str = ""  # "note", "index", "root"
    tags: list = field(default_factory=list)
    ref_links: list = field(default_factory=list)  # frontmatter ref에서 추출한 노트명
    wikilinks: list = field(default_factory=list)  # 본문 [[...]] 노트명
    embeds: list = field(default_factory=list)  # 본문 ![[...]] 노트명
    aliases: list = field(
        default_factory=list
    )  # frontmatter aliases — filename 동등 위치

    @property
    def filename(self) -> str:
        # macOS APFS는 파일명을 NFD로 저장하지만, 본문/frontmatter 텍스트는 NFC.
        # 일관된 매칭을 위해 항상 NFC로 정규화한다.
        return unicodedata.normalize("NFC", self.path.stem)

    @property
    def folder(self) -> str:
        return str(self.path.parent.relative_to(self.path.parent.parent))


def parse_frontmatter(content: str) -> tuple[dict, str]:
    """YAML frontmatter와 body를 분리한다.

    yaml 라이브러리 없이 간단한 파싱으로 처리.
    """
    if not content.startswith("---"):
        return {}, content

    end = content.find("\n---", 3)
    if end == -1:
        return {}, content

    fm_text = content[4:end]
    body = content[end + 4 :].lstrip("\n")
    fm = {}

    current_key = None
    current_list = None

    for line in fm_text.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue

        # 배열 항목: "  - value"
        if stripped.startswith("- ") and current_key:
            val = stripped[2:].strip().strip('"').strip("'")
            if current_list is not None:
                current_list.append(val)
            continue

        # key: value 쌍
        if ":" in stripped:
            colon_idx = stripped.index(":")
            key = stripped[:colon_idx].strip()
            val = stripped[colon_idx + 1 :].strip()

            current_key = key

            # 인라인 배열: [val1, val2]
            if val.startswith("[") and val.endswith("]"):
                items = val[1:-1]
                if items.strip():
                    current_list = [
                        v.strip().strip('"').strip("'") for v in items.split(",")
                    ]
                else:
                    current_list = []
                fm[key] = current_list
            elif val:
                fm[key] = val.strip('"').strip("'")
                current_list = None
            else:
                # 빈 값 = 다음 줄부터 배열일 수 있음
                current_list = []
                fm[key] = current_list

    return fm, body


def extract_wikilinks(body: str) -> list[str]:
    """본문에서 [[...]] wikilink를 추출한다 (embed 제외)."""
    return list(dict.fromkeys(WIKILINK_RE.findall(body)))


def extract_embeds(body: str) -> list[str]:
    """본문에서 ![[...]] embed를 추출한다."""
    return list(dict.fromkeys(EMBED_RE.findall(body)))


def extract_ref_links(frontmatter: dict) -> list[str]:
    """frontmatter ref 배열에서 노트명을 추출한다."""
    raw = frontmatter.get("ref", [])
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []

    results = []
    for item in raw:
        match = re.search(r"\[\[([^\]|]+)", str(item))
        if match:
            results.append(match.group(1))
    return results


def parse_note(path: Path) -> Optional[VaultNote]:
    """단일 .md 파일을 파싱하여 VaultNote로 반환한다."""
    try:
        content = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, PermissionError):
        return None

    fm, body = parse_frontmatter(content)

    tags_raw = fm.get("tags", [])
    if isinstance(tags_raw, str):
        tags_raw = [tags_raw]

    aliases_raw = fm.get("aliases", [])
    if isinstance(aliases_raw, str):
        aliases_raw = [aliases_raw]
    aliases = (
        [a for a in aliases_raw if isinstance(a, str) and a.strip()]
        if isinstance(aliases_raw, list)
        else []
    )

    return VaultNote(
        path=path,
        frontmatter=fm,
        body=body,
        note_type=fm.get("type", ""),
        tags=tags_raw if isinstance(tags_raw, list) else [],
        ref_links=extract_ref_links(fm),
        wikilinks=extract_wikilinks(body),
        embeds=extract_embeds(body),
        aliases=aliases,
    )


def scan_vault(vault_path: Path) -> list[VaultNote]:
    """vault 내 모든 .md 파일을 스캔하여 VaultNote 리스트를 반환한다."""
    notes = []
    for md_file in sorted(vault_path.rglob("*.md")):
        # 제외 디렉토리 확인
        rel = md_file.relative_to(vault_path)
        if any(part in EXCLUDE_DIRS for part in rel.parts):
            continue

        note = parse_note(md_file)
        if note:
            notes.append(note)
    return notes


def build_note_index(notes: list[VaultNote]) -> dict[str, VaultNote]:
    """filename → VaultNote 매핑 딕셔너리를 생성한다."""
    idx = {}
    for note in notes:
        idx[note.filename] = note
    return idx


def main():
    vault_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_VAULT
    if not vault_path.exists():
        print(f"Error: vault path not found: {vault_path}")
        sys.exit(1)

    print(f"Scanning vault: {vault_path}")
    notes = scan_vault(vault_path)
    index = build_note_index(notes)

    # 통계
    types = {}
    folders = {}
    for n in notes:
        t = n.note_type or "(no type)"
        types[t] = types.get(t, 0) + 1
        top_folder = (
            n.path.relative_to(vault_path).parts[0]
            if n.path.relative_to(vault_path).parts
            else "(root)"
        )
        folders[top_folder] = folders.get(top_folder, 0) + 1

    print(f"\nTotal notes: {len(notes)}")
    print(f"Unique names in index: {len(index)}")

    print("\nBy type:")
    for t, count in sorted(types.items()):
        print(f"  {t}: {count}")

    print("\nBy folder:")
    for f, count in sorted(folders.items()):
        print(f"  {f}: {count}")

    # 링크 통계
    total_wikilinks = sum(len(n.wikilinks) for n in notes)
    total_ref_links = sum(len(n.ref_links) for n in notes)
    total_tags = sum(len(n.tags) for n in notes)
    print(f"\nTotal wikilinks: {total_wikilinks}")
    print(f"Total ref links: {total_ref_links}")
    print(f"Total tags: {total_tags}")


if __name__ == "__main__":
    main()

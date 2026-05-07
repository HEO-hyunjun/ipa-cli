#!/usr/bin/env python3
"""Vault Traversal: 상향/하향 계층 탐색, 형제 노트 탐색.

Usage:
    python3 vault_traversal.py --up "노트명"
    python3 vault_traversal.py --down "🏷️ AI Root"
    python3 vault_traversal.py --siblings "Colombia"
    python3 vault_traversal.py --root "Colombia"
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .notes_cache import scan_vault_cached
from .vault_parser import DEFAULT_VAULT, VaultNote, build_note_index, scan_vault


def traverse_upward(note_name: str, index: dict[str, VaultNote]) -> list[list[str]]:
    """Note → Root 방향으로 모든 경로를 반환한다.

    Returns: 경로 리스트. 각 경로는 [note_name, index1, ..., root] 형태.
    """
    paths = []

    def _walk(name: str, current_path: list[str]):
        note = index.get(name)
        if not note:
            paths.append(current_path[:])
            return
        if note.note_type == "root":
            paths.append(current_path[:])
            return
        if not note.ref_links:
            paths.append(current_path[:])
            return
        for parent in note.ref_links:
            if parent in current_path:  # 순환 방지
                paths.append(current_path[:])
                continue
            _walk(parent, current_path + [parent])

    _walk(note_name, [note_name])
    return paths


def traverse_downward(root_name: str, index: dict[str, VaultNote]) -> dict:
    """Root → 하위 전체 트리 구조를 반환한다.

    Returns: {"name": root_name, "type": "root", "children": [...]}
    """
    visited = set()

    def _build_tree(name: str) -> dict:
        if name in visited:
            return {"name": name, "type": "cycle", "children": []}
        visited.add(name)

        note = index.get(name)
        node = {
            "name": name,
            "type": note.note_type if note else "unknown",
            "children": [],
        }

        # 이 노트를 ref로 가리키는 모든 노트 찾기
        children = []
        for n in index.values():
            if name in n.ref_links and n.filename != name:
                children.append(n)

        # 중복 제거
        seen = set()
        for child in children:
            if child.filename not in seen:
                seen.add(child.filename)
                node["children"].append(_build_tree(child.filename))

        return node

    return _build_tree(root_name)


def get_siblings(note_name: str, index: dict[str, VaultNote]) -> list[str]:
    """같은 ref를 공유하는 형제 노트들을 반환한다."""
    note = index.get(note_name)
    if not note or not note.ref_links:
        return []

    siblings = set()
    for parent_name in note.ref_links:
        for n in index.values():
            if (
                parent_name in n.ref_links
                and n.filename != note_name
                and n.title != note_name
            ):
                siblings.add(n.filename)

    return sorted(siblings)


def find_root_for_note(note_name: str, index: dict[str, VaultNote]) -> list[str]:
    """노트가 속한 Root 이름들을 반환한다."""
    paths = traverse_upward(note_name, index)
    roots = set()
    for path in paths:
        if path:
            last = path[-1]
            note = index.get(last)
            if note and note.note_type == "root":
                roots.add(last)
    return sorted(roots)


def print_tree(tree: dict, indent: int = 0):
    """트리 구조를 들여쓰기로 출력한다."""
    prefix = "  " * indent
    icon = {"root": "🏷️", "index": "🔖", "note": "📄"}.get(tree["type"], "❓")
    name = tree["name"]
    # 이미 아이콘이 이름에 포함된 경우 중복 방지
    if name.startswith(("🏷️", "🔖")):
        print(f"{prefix}{name}")
    else:
        print(f"{prefix}{icon} {name}")
    for child in tree["children"]:
        print_tree(child, indent + 1)


def main():
    parser = argparse.ArgumentParser(description="Vault hierarchy traversal")
    parser.add_argument("--up", metavar="NOTE", help="상향 탐색: Note → Root")
    parser.add_argument("--down", metavar="ROOT", help="하향 탐색: Root → Notes")
    parser.add_argument("--siblings", metavar="NOTE", help="형제 노트 탐색")
    parser.add_argument("--root", metavar="NOTE", help="소속 Root 찾기")
    parser.add_argument("--vault", default=str(DEFAULT_VAULT), help="vault 경로")
    args = parser.parse_args()

    if not any([args.up, args.down, args.siblings, args.root]):
        parser.print_help()
        sys.exit(1)

    vault_path = Path(args.vault)
    notes = scan_vault_cached(vault_path)
    index = build_note_index(notes)

    if args.up:
        paths = traverse_upward(args.up, index)
        if not paths:
            print(f"Note not found: {args.up}")
            sys.exit(1)
        print(f"Upward paths from '{args.up}':")
        for i, path in enumerate(paths, 1):
            print(f"  {i}. {' → '.join(path)}")

    if args.down:
        tree = traverse_downward(args.down, index)
        print(f"Tree from '{args.down}':")
        print_tree(tree)

    if args.siblings:
        sibs = get_siblings(args.siblings, index)
        if sibs:
            print(f"Siblings of '{args.siblings}':")
            for s in sibs:
                print(f"  - {s}")
        else:
            print(f"No siblings found for '{args.siblings}'")

    if args.root:
        roots = find_root_for_note(args.root, index)
        if roots:
            print(f"Root(s) for '{args.root}':")
            for r in roots:
                print(f"  - {r}")
        else:
            print(f"No root found for '{args.root}'")


if __name__ == "__main__":
    main()

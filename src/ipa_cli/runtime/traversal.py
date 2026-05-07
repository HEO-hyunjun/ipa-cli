"""Legacy ``ipa traversal`` entrypoint, decoupled from synthetic-argv.

S3 ports the four traversal modes (--up / --down / --siblings / --root)
to the parse layer (``parse.vault_loader.load_notes`` + ``Note``) instead
of going through ``core/vault_parser``. The output shape stays
byte-identical to the 1차 surface so the snapshot helper passes.

The 1차 ``get_siblings`` referenced ``VaultNote.title`` which doesn't
exist — we keep the same ``filename != note_name`` check using
``Note.id`` and drop the broken second predicate.
"""

from __future__ import annotations

from pathlib import Path

from ipa_cli.api.mappings import Mapping
from ipa_cli.parse.links import extract_ref_targets
from ipa_cli.parse.note_model import Note
from ipa_cli.parse.vault_loader import load_notes


def _index(notes: list[Note]) -> dict[str, Note]:
    return {n.id: n for n in notes}


def _ref_targets(note: Note, mapping: Mapping) -> list[str]:
    """Extract ``[[name]]`` targets from a Note's frontmatter ``ref`` array."""
    return extract_ref_targets(note.refs(mapping))


def traverse_upward(
    note_name: str,
    index: dict[str, Note],
    mapping: Mapping,
) -> list[list[str]]:
    """Note → Root paths. Returns a list of paths; every reachable parent
    chain shows up, including ones that hit a missing ref or a cycle."""
    paths: list[list[str]] = []

    def _walk(name: str, current: list[str]) -> None:
        note = index.get(name)
        if note is None:
            paths.append(current[:])
            return
        if note.note_type(mapping) == "root":
            paths.append(current[:])
            return
        refs = _ref_targets(note, mapping)
        if not refs:
            paths.append(current[:])
            return
        for parent in refs:
            if parent in current:
                paths.append(current[:])
                continue
            _walk(parent, current + [parent])

    _walk(note_name, [note_name])
    return paths


def traverse_downward(
    root_name: str,
    index: dict[str, Note],
    mapping: Mapping,
) -> dict:
    """Root → child tree. Each node is ``{name, type, children}``."""
    visited: set[str] = set()

    def _build(name: str) -> dict:
        if name in visited:
            return {"name": name, "type": "cycle", "children": []}
        visited.add(name)
        note = index.get(name)
        node_type = (note.note_type(mapping) if note else "unknown") or "unknown"
        node: dict = {"name": name, "type": node_type, "children": []}
        seen: set[str] = set()
        # 1차 ``vault_parser.scan_vault`` sorts files by name, so the
        # downstream traversal preserves that order. ``parse.vault_loader``
        # doesn't sort, so we sort here to keep the byte-identical golden.
        for n in sorted(index.values(), key=lambda x: x.id):
            if n.id == name:
                continue
            if name in _ref_targets(n, mapping) and n.id not in seen:
                seen.add(n.id)
                node["children"].append(_build(n.id))
        return node

    return _build(root_name)


def get_siblings(
    note_name: str,
    index: dict[str, Note],
    mapping: Mapping,
) -> list[str]:
    """Notes that share at least one ref target with ``note_name``."""
    note = index.get(note_name)
    if note is None:
        return []
    refs = _ref_targets(note, mapping)
    if not refs:
        return []
    siblings: set[str] = set()
    for parent in refs:
        for n in index.values():
            if n.id == note_name:
                continue
            if parent in _ref_targets(n, mapping):
                siblings.add(n.id)
    return sorted(siblings)


def find_root_for_note(
    note_name: str,
    index: dict[str, Note],
    mapping: Mapping,
) -> list[str]:
    """Root names reachable from ``note_name`` via ``traverse_upward``."""
    paths = traverse_upward(note_name, index, mapping)
    roots: set[str] = set()
    for path in paths:
        if not path:
            continue
        last = path[-1]
        n = index.get(last)
        if n and n.note_type(mapping) == "root":
            roots.add(last)
    return sorted(roots)


def _format_tree(tree: dict, indent: int = 0) -> list[str]:
    prefix = "  " * indent
    icon = {"root": "🏷️", "index": "🔖", "note": "📄"}.get(tree["type"], "❓")
    name = tree["name"]
    if name.startswith(("🏷️", "🔖")):
        line = f"{prefix}{name}"
    else:
        line = f"{prefix}{icon} {name}"
    out = [line]
    for child in tree["children"]:
        out.extend(_format_tree(child, indent + 1))
    return out


def render_traversal(
    vault_path: Path,
    *,
    up: str | None = None,
    down: str | None = None,
    siblings: str | None = None,
    root: str | None = None,
    mapping: Mapping | None = None,
) -> str:
    """Top-level entrypoint used by the CLI."""
    if mapping is None:
        mapping = Mapping()
    notes = load_notes(vault_path, mapping)
    idx = _index(notes)

    out: list[str] = []

    if up:
        paths = traverse_upward(up, idx, mapping)
        if not paths or paths == [[]]:
            out.append(f"Note not found: {up}")
        else:
            out.append(f"Upward paths from '{up}':")
            for i, path in enumerate(paths, 1):
                out.append(f"  {i}. {' → '.join(path)}")

    if down:
        tree = traverse_downward(down, idx, mapping)
        out.append(f"Tree from '{down}':")
        out.extend(_format_tree(tree))

    if siblings:
        sibs = get_siblings(siblings, idx, mapping)
        if sibs:
            out.append(f"Siblings of '{siblings}':")
            for s in sibs:
                out.append(f"  - {s}")
        else:
            out.append(f"No siblings found for '{siblings}'")

    if root:
        roots = find_root_for_note(root, idx, mapping)
        if roots:
            out.append(f"Root(s) for '{root}':")
            for r in roots:
                out.append(f"  - {r}")
        else:
            out.append(f"No root found for '{root}'")

    return "\n".join(out)

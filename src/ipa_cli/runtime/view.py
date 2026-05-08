"""Legacy ``ipa view`` surface implemented on the parse layer.

The public command keeps the 1차 stdout shape, but it no longer calls
``ipa_cli._legacy``. Notes come from ``parse.vault_loader.load_notes`` and
section extraction is local to this module so the view command can be
removed from the parity-oracle migration path.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

from ipa_cli.api.mappings import Mapping
from ipa_cli.parse.bm25 import jamo_trigrams
from ipa_cli.parse.links import extract_ref_targets, extract_wikilinks
from ipa_cli.parse.note_model import Note
from ipa_cli.parse.vault_loader import load_notes

_EMOJI_PREFIX_RE = re.compile(r"^(?:🏷\uFE0F?|🔖)\s*")
_HEADER_RE = re.compile(r"^(#{1,6})\s+(.+)$")
_CALLOUT_RE = re.compile(r"^>\s*\[!(\w+)\]([+-]?)\s*(.*)")


@dataclass(frozen=True)
class Section:
    kind: str
    level: int
    title: str
    callout_type: str = ""
    collapsed: bool = False
    start_line: int = 0
    end_line: int = 0
    content: str = ""


def _body(note: Note) -> str:
    """Match the 1차 parser: body starts after the frontmatter blank line."""
    return note.body.lstrip("\n")


def _ref_links(note: Note, mapping: Mapping) -> list[str]:
    return extract_ref_targets(note.refs(mapping))


def _notes(vault_path: Path, mapping: Mapping) -> list[Note]:
    return sorted(load_notes(vault_path, mapping), key=lambda n: str(n.path))


def _index(notes: list[Note]) -> dict[str, Note]:
    return {n.id: n for n in notes}


def _strip_emoji(name: str) -> str:
    return _EMOJI_PREFIX_RE.sub("", name)


def fuzzy_find_note(
    query: str,
    index: dict[str, Note],
    mapping: Mapping,
) -> list[tuple[Note, float]]:
    """Return note-name fuzzy matches with the same broad priorities as 1차."""
    if not query:
        return []

    query_lower = query.lower()
    query_nospace = query_lower.replace(" ", "")
    q_tri = set(jamo_trigrams(query))
    fallback_threshold = 0.55
    jamo_threshold = 0.4

    def score_one_name(name: str) -> float:
        if name == query:
            return 1.0
        nl = name.lower()
        if nl == query_lower:
            return 1.0
        if query_lower in nl:
            return 1.0
        stripped = _strip_emoji(name)
        if stripped != name and query_lower in stripped.lower():
            return 1.0
        if query_nospace and query_nospace in nl.replace(" ", ""):
            return 1.0
        if q_tri:
            f_tri = set(jamo_trigrams(_strip_emoji(name)))
            if f_tri:
                overlap = len(q_tri & f_tri) / len(q_tri)
                if overlap >= jamo_threshold:
                    return overlap
        return 0.0

    candidates: dict[str, tuple[Note, float]] = {}
    fallback_pool: list[tuple[float, Note]] = []
    for name, note in index.items():
        names = [name, *note.aliases(mapping)]
        best = max((score_one_name(n) for n in names), default=0.0)
        if best > 0:
            candidates[name] = (note, best)
        elif not q_tri:
            ratio = 0.0
            for nm in names:
                r = SequenceMatcher(None, query_lower, nm.lower()).ratio()
                stripped = _strip_emoji(nm)
                if stripped != nm:
                    r = max(
                        r,
                        SequenceMatcher(None, query_lower, stripped.lower()).ratio(),
                    )
                ratio = max(ratio, r)
            if ratio >= fallback_threshold:
                fallback_pool.append((ratio, note))

    if candidates:
        return sorted(candidates.values(), key=lambda item: -item[1])
    if fallback_pool:
        fallback_pool.sort(key=lambda item: item[0], reverse=True)
        return [(note, score) for score, note in fallback_pool]
    return []


def view_note(query: str, index: dict[str, Note], mapping: Mapping) -> Note | None:
    results = fuzzy_find_note(query, index, mapping)
    return results[0][0] if results else None


def parse_body_sections(body: str) -> list[Section]:
    """Parse headings/callouts while skipping fenced code blocks."""
    lines = body.split("\n")
    sections: list[Section] = []
    current_header_level = 0
    in_code_block = False
    i = 0

    while i < len(lines):
        line = lines[i]

        if line.lstrip().startswith("```") or line.lstrip().startswith("~~~"):
            in_code_block = not in_code_block
            i += 1
            continue
        if in_code_block:
            i += 1
            continue

        header_match = _HEADER_RE.match(line)
        if header_match:
            level = len(header_match.group(1))
            title = header_match.group(2).strip()
            current_header_level = level

            content_lines: list[str] = []
            j = i + 1
            while j < len(lines):
                next_header = _HEADER_RE.match(lines[j])
                if next_header and len(next_header.group(1)) <= level:
                    break
                content_lines.append(lines[j])
                j += 1

            sections.append(
                Section(
                    kind="header",
                    level=level,
                    title=title,
                    start_line=i,
                    end_line=j - 1,
                    content="\n".join(content_lines),
                )
            )
            i += 1
            continue

        callout_match = _CALLOUT_RE.match(line)
        if callout_match:
            callout_type = callout_match.group(1)
            collapse_char = callout_match.group(2)
            title = callout_match.group(3).strip() or callout_type
            collapsed = collapse_char == "-"

            content_lines = []
            j = i + 1
            while j < len(lines) and lines[j].startswith(">"):
                stripped = lines[j][1:]
                if stripped.startswith(" "):
                    stripped = stripped[1:]
                content_lines.append(stripped)
                j += 1

            sections.append(
                Section(
                    kind="callout",
                    level=current_header_level + 1 if current_header_level > 0 else 1,
                    title=title,
                    callout_type=callout_type,
                    collapsed=collapsed,
                    start_line=i,
                    end_line=j - 1,
                    content="\n".join(content_lines),
                )
            )
            i = j
            continue

        i += 1

    return sections


def find_section(sections: list[Section], query: str) -> list[Section]:
    if not query:
        return []

    query_lower = query.lower()
    exact = [s for s in sections if s.title == query]
    if exact:
        return exact
    case_matches = [s for s in sections if s.title.lower() == query_lower]
    if case_matches:
        return case_matches
    partial = [
        s
        for s in sections
        if query_lower in s.title.lower()
        or (s.kind == "callout" and query_lower in s.callout_type.lower())
    ]
    if partial:
        return partial

    scored: list[tuple[float, Section]] = []
    for sec in sections:
        ratio = SequenceMatcher(None, query_lower, sec.title.lower()).ratio()
        if sec.kind == "callout":
            ratio = max(
                ratio,
                SequenceMatcher(None, query_lower, sec.callout_type.lower()).ratio(),
            )
        if ratio >= 0.5:
            scored.append((ratio, sec))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [sec for _, sec in scored]


def _format_folder_label(path: Path) -> str:
    """Keep the historical folder badge only when IPA_VAULT_PATH defines it."""
    env_vault = os.environ.get("IPA_VAULT_PATH")
    if not env_vault:
        return ""
    try:
        rel = path.resolve().relative_to(Path(env_vault).expanduser().resolve())
    except ValueError:
        return ""
    return rel.parts[0] if rel.parts else ""


def _format_ref_path_to_root(
    note: Note,
    index: dict[str, Note],
    mapping: Mapping,
    max_depth: int = 6,
) -> list[list[str]]:
    paths: list[list[str]] = []

    def walk(name: str, trail: list[str], depth: int) -> None:
        if depth >= max_depth or name in trail:
            paths.append(trail + [name])
            return
        nxt = index.get(name)
        refs = _ref_links(nxt, mapping) if nxt else []
        if not nxt or not refs:
            paths.append(trail + [name])
            return
        for parent in refs:
            walk(parent, trail + [name], depth + 1)

    for parent in _ref_links(note, mapping):
        walk(parent, [], 0)
    return paths


def _count_outlinks_in_body(body: str) -> int:
    return len(set(extract_wikilinks(body)))


def _count_backlinks_to(
    target_note_id: str,
    all_notes: list[Note],
    mapping: Mapping,
) -> int:
    count = 0
    for note in all_notes:
        if note.id == target_note_id:
            continue
        if target_note_id in _ref_links(note, mapping):
            count += 1
            continue
        if target_note_id in extract_wikilinks(_body(note)):
            count += 1
    return count


def _count_siblings(note: Note, all_notes: list[Note], mapping: Mapping) -> int:
    refs = set(_ref_links(note, mapping))
    if not refs:
        return 0
    count = 0
    for other in all_notes:
        if other.id == note.id:
            continue
        if any(parent in refs for parent in _ref_links(other, mapping)):
            count += 1
    return count


def _count_children(note: Note, all_notes: list[Note], mapping: Mapping) -> int:
    return sum(1 for other in all_notes if note.id in _ref_links(other, mapping))


def _build_tag_to_notes_index(
    all_notes: list[Note],
    mapping: Mapping,
) -> dict[str, list[Note]]:
    out: dict[str, list[Note]] = {}
    for note in all_notes:
        for tag in note.tags(mapping):
            out.setdefault(tag, []).append(note)
    return out


def _render_tag_distribution(
    note: Note,
    tag_index: dict[str, list[Note]],
    mapping: Mapping,
    top_tags: int = 3,
    top_refs: int = 3,
) -> list[str]:
    tags = note.tags(mapping)
    if not tags:
        return []
    enriched: list[tuple[str, list[Note]]] = []
    for tag in tags:
        peers = [p for p in tag_index.get(tag, []) if p.id != note.id]
        enriched.append((tag, peers))
    enriched.sort(key=lambda item: len(item[1]), reverse=True)
    enriched = enriched[:top_tags]
    if not enriched:
        return []

    out = ["🏷 tags:"]
    name_w = max(len(tag) for tag, _ in enriched)
    for tag_name, peers in enriched:
        ref_counter: dict[str, int] = {}
        for peer in peers:
            for ref in _ref_links(peer, mapping):
                ref_counter[ref] = ref_counter.get(ref, 0) + 1
        ranked_refs = sorted(ref_counter.items(), key=lambda item: -item[1])[
            :top_refs
        ]
        ref_str = ", ".join(f"{ref} ({count})" for ref, count in ranked_refs)
        n_peers = len(peers)
        warn = ""
        if n_peers == 0:
            warn = "  ⚠ 고립(이 tag는 이 노트만)"
        elif n_peers == 1:
            warn = "  ⚠ 동행 1건(시그널 약함)"
        elif len(ref_counter) <= 1:
            warn = "  ⚠ 미가로지름(같은 인덱스에만 분포)"

        line = f"  {tag_name:<{name_w}}  ({n_peers:3d})"
        if ref_str:
            line += f"  → {ref_str}"
        line += warn
        out.append(line)
    return out


def _render_action_hints(
    note: Note,
    mapping: Mapping,
    is_overview: bool = False,
) -> list[str]:
    note_id = note.id
    note_type = note.note_type(mapping) or "note"
    if note_type in ("index", "root"):
        cmds = [
            (f'--down "{note_id}"', "하위 트리 (vault_traversal)"),
            (f'--siblings "{note_id}"', "같은 부모 아래 형제 (vault_traversal)"),
            (f'--backlinks "{note_id}"', "본문에서 이 노트를 거명한 노트"),
        ]
    else:
        cmds = [
            (f'--up "{note_id}"', "상위 인덱스 → root 경로 (vault_traversal)"),
            (f'--related "{note_id}"', "그래프 이웃 노트"),
            (f'--backlinks "{note_id}"', "누가 이 노트를 가리키는가"),
        ]
    tags = note.tags(mapping)
    if tags:
        cmds.append((f'--tag "{tags[0]}"', "같은 관점(tag) 동행 노트"))
    if is_overview:
        cmds.append((f'--view "{note_id}" --full', "이 노트의 본문 전체 보기"))

    cmd_w = max(len(cmd) for cmd, _ in cmds)
    out = ["다음:"]
    if cmd_w > 60:
        for cmd, comment in cmds:
            out.append(f"  {cmd}")
            out.append(f"      # {comment}")
    else:
        for cmd, comment in cmds:
            out.append(f"  {cmd:<{cmd_w}}  # {comment}")
    return out


def _render_context_header(
    note: Note,
    index: dict[str, Note],
    mapping: Mapping,
) -> list[str]:
    folder = _format_folder_label(note.path)
    folder_str = f"  📁 {folder}" if folder else ""
    lines = [f"=== {note.id} [{note.note_type(mapping) or '?'}]{folder_str} ==="]
    paths = _format_ref_path_to_root(note, index, mapping)
    if paths:
        for path in paths:
            lines.append(f"↑ ref: {' → '.join(path)}")
    elif note.note_type(mapping) == "root":
        lines.append("↑ ref: (root — 최상위)")
    elif note.note_type(mapping) == "index":
        lines.append("↑ ref: (독립 index — root 없음)")
    aliases = note.aliases(mapping)
    if aliases:
        lines.append(f"   aliases: {aliases}")
    lines.append(f"Path: {note.path}")
    return lines


def _render_frontmatter(note: Note) -> list[str]:
    lines: list[str] = []
    if note.frontmatter:
        lines.append("---")
        for key, value in note.frontmatter.items():
            lines.append(f"{key}: {value}")
        lines.append("---")
    return lines


def _render_action_footer(
    note: Note,
    all_notes: list[Note],
    tag_index: dict[str, list[Note]],
    mapping: Mapping,
    is_overview: bool = False,
) -> list[str]:
    out = ["", "─" * 16]
    note_type = note.note_type(mapping) or "note"
    outlinks = _count_outlinks_in_body(_body(note))
    backlinks = _count_backlinks_to(note.id, all_notes, mapping)
    siblings = _count_siblings(note, all_notes, mapping)
    if note_type in ("index", "root"):
        children = _count_children(note, all_notes, mapping)
        out.append(
            f"연결: ↘ 하위 {children}  ↗ outlinks {outlinks}  "
            f"↩ backlinks {backlinks}  ⇄ 형제 {siblings}"
        )
    else:
        out.append(
            f"연결: ↗ outlinks {outlinks}  ↩ backlinks {backlinks}  "
            f"⇄ siblings {siblings}"
        )
    out.extend(_render_tag_distribution(note, tag_index, mapping))
    out.extend(_render_action_hints(note, mapping, is_overview=is_overview))
    return out


def render_overview(
    note: Note,
    all_notes: list[Note],
    index: dict[str, Note],
    tag_index: dict[str, list[Note]],
    mapping: Mapping,
) -> str:
    lines = _render_context_header(note, index, mapping)
    lines.extend(_render_frontmatter(note))

    sections = parse_body_sections(_body(note))
    if sections:
        lines.append("")
        lines.append("## Structure")
        for section in sections:
            indent = "  " * (section.level - 1)
            if section.kind == "header":
                lines.append(f"{indent}[H{section.level}] {section.title}")
            else:
                collapse_mark = "-" if section.collapsed else ""
                lines.append(
                    f"{indent}[!{section.callout_type}{collapse_mark}] "
                    f"{section.title}"
                )
    elif _body(note):
        lines.append("\n(구조 없음 — 본문 있음)")
    else:
        lines.append("\n(본문 없음)")

    lines.extend(
        _render_action_footer(
            note, all_notes, tag_index, mapping, is_overview=True
        )
    )
    return "\n".join(lines)


def render_section(note: Note, query: str) -> str:
    sections = parse_body_sections(_body(note))
    matches = find_section(sections, query)
    if not matches:
        available = []
        for section in sections:
            if section.kind == "header":
                available.append(f"  [H{section.level}] {section.title}")
            else:
                available.append(f"  [!{section.callout_type}] {section.title}")
        hint = "\n".join(available) if available else "  (섹션 없음)"
        return f"Section not found: '{query}'\n\nAvailable sections:\n{hint}"

    lines: list[str] = []
    for section in matches:
        if section.kind == "header":
            lines.append(f"[H{section.level}] {section.title}")
        else:
            collapse_mark = "-" if section.collapsed else ""
            lines.append(f"[!{section.callout_type}{collapse_mark}] {section.title}")
        lines.append(section.content)
        lines.append("")
    return "\n".join(lines)


def render_full(
    note: Note,
    all_notes: list[Note],
    index: dict[str, Note],
    tag_index: dict[str, list[Note]],
    mapping: Mapping,
) -> str:
    lines = _render_context_header(note, index, mapping)
    lines.extend(_render_frontmatter(note))

    body = _body(note)
    if not body:
        lines.append("\n(본문 없음)")
        lines.extend(_render_action_footer(note, all_notes, tag_index, mapping))
        return "\n".join(lines)

    lines.append("")
    body_lines = body.split("\n")
    in_code_block = False
    i = 0
    while i < len(body_lines):
        line = body_lines[i]
        if line.lstrip().startswith("```") or line.lstrip().startswith("~~~"):
            in_code_block = not in_code_block
            lines.append(line)
            i += 1
            continue
        if in_code_block:
            lines.append(line)
            i += 1
            continue

        callout_match = _CALLOUT_RE.match(line)
        if callout_match and callout_match.group(2) == "-":
            content_count = 0
            j = i + 1
            while j < len(body_lines) and body_lines[j].startswith(">"):
                content_count += 1
                j += 1
            lines.append(line)
            lines.append(f"> (...collapsed, {content_count} lines)")
            i = j
            continue

        lines.append(line)
        i += 1

    lines.extend(_render_action_footer(note, all_notes, tag_index, mapping))
    return "\n".join(lines)


def render_view(
    vault_path: Path,
    *,
    note: str,
    section: str | None = None,
    full: bool = False,
    mapping: Mapping | None = None,
) -> str:
    """Return the legacy-compatible ``ipa view`` output for ``note``."""
    if mapping is None:
        mapping = Mapping()
    all_notes = _notes(vault_path, mapping)
    idx = _index(all_notes)
    tag_index = _build_tag_to_notes_index(all_notes, mapping)

    found = view_note(note, idx, mapping)
    if not found:
        return f"Note not found: '{note}'"

    if section:
        return render_section(found, section)
    if full:
        return render_full(found, all_notes, idx, tag_index, mapping)
    return render_overview(found, all_notes, idx, tag_index, mapping)

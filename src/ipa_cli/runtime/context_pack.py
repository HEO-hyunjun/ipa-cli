"""Build compact vault context packs for AI agents."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

from ipa_cli.api.base_channels import SetupContext
from ipa_cli.api.mappings import Mapping
from ipa_cli.parse.links import extract_ref_targets
from ipa_cli.parse.note_model import Note
from ipa_cli.parse.vault_loader import load_notes
from ipa_cli.runtime.search import search_hits


def build_context_pack(
    vault_path: Path,
    query: str,
    *,
    mapping: Mapping,
    threshold: float,
    max_results: int,
    weights: dict[str, float] | None = None,
    channels=None,
    cache_dir: Path | None = None,
    by_note: bool = False,
    include: Iterable[str] = (),
) -> dict:
    vault = vault_path.expanduser().resolve()
    notes = load_notes(vault, mapping)
    notes_by_id = {note.id: note for note in notes}
    selected: list[Note] = []
    sources: list[dict] = []
    warnings: list[str] = []

    if by_note:
        note = notes_by_id.get(query)
        if note is None:
            warnings.append(f"note not found: {query}")
        else:
            selected.append(note)
            sources.append({"kind": "note", "note": note.id})
    else:
        hits, _all_notes, _cut = search_hits(
            vault,
            [query],
            threshold=threshold,
            max_results=max_results,
            weights=weights,
            mapping=mapping,
            channels=channels,
            cache_dir=cache_dir,
        )
        for hit in hits:
            note = notes_by_id.get(hit.note_id)
            if note is not None:
                selected.append(note)
                sources.append(
                    {"kind": "search", "note": note.id, "score": round(hit.score, 6)}
                )

    include_set = {item.strip() for item in include if item.strip()}
    ctx = SetupContext(
        notes=notes,
        vault_path=vault,
        cache_dir=cache_dir or vault / ".ipa" / "cache" / "search",
        mapping=mapping,
    )
    selected_ids = {note.id for note in selected}
    edges = []
    for note in selected:
        outgoing = sorted(ctx.ref_graph.out_neighbors(note.id))
        incoming = sorted(ctx.ref_graph.in_neighbors(note.id))
        edges.append({"source": note.id, "out": outgoing, "in": incoming})
        if "siblings" in include_set:
            selected_ids.update(_siblings(note, notes, mapping))
        if "children" in include_set:
            selected_ids.update(incoming)
        if "backlinks" in include_set:
            selected_ids.update(incoming)

    expanded = [notes_by_id[nid] for nid in sorted(selected_ids) if nid in notes_by_id]
    return {
        "query": query,
        "mode": "note" if by_note else "search",
        "notes": [_note_payload(note, mapping, vault) for note in expanded],
        "edges": edges,
        "sources": sources,
        "warnings": warnings,
    }


def _note_payload(note: Note, mapping: Mapping, vault_path: Path) -> dict:
    summary = "\n".join(note.body.strip().splitlines()[:8])
    return {
        "id": note.id,
        "path": note.path.relative_to(vault_path).as_posix(),
        "type": note.note_type(mapping),
        "refs": extract_ref_targets(note.refs(mapping)),
        "tags": note.tags(mapping),
        "aliases": note.aliases(mapping),
        "headings": [
            {"level": h.level, "title": h.text}
            for h in note.headings[:8]
        ],
        "summary": summary,
    }


def _siblings(note: Note, notes: list[Note], mapping: Mapping) -> set[str]:
    refs = set(extract_ref_targets(note.refs(mapping)))
    if not refs:
        return set()
    return {
        other.id
        for other in notes
        if other.id != note.id and refs.intersection(extract_ref_targets(other.refs(mapping)))
    }


def render_context_pack(pack: dict, *, format_: str) -> str:
    if format_ == "json":
        return json.dumps(pack, ensure_ascii=False, indent=2)
    lines = [f"# IPA Context: {pack['query']}"]
    if pack.get("warnings"):
        lines.append("")
        for warning in pack["warnings"]:
            lines.append(f"- warning: {warning}")
    for note in pack.get("notes", []):
        lines.append("")
        lines.append(f"## {note['id']}")
        lines.append(f"- path: {note['path']}")
        if note.get("refs"):
            lines.append(f"- refs: {', '.join(note['refs'])}")
        if note.get("tags"):
            lines.append(f"- tags: {', '.join(note['tags'])}")
        if note.get("summary"):
            lines.append("")
            lines.append(note["summary"])
    return "\n".join(lines)

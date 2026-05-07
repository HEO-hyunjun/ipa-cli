"""Legacy ``ipa search`` entrypoint, running on ``SearchEngine``.

Decision #3 of the migration plan accepts structured equivalence
(top1 exact / top5 ordered-ish / topN set) rather than byte-identical
parity for search. We still emit a 1차-shaped report so existing
shell-script readers don't break, but the per-channel score breakdown
is the new ``Hit.explanations`` payload rather than the 1차 reasons
list.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

from ipa_cli.api.base_channels import Hit, Query, SetupContext
from ipa_cli.api.mappings import Mapping
from ipa_cli.builtins.channels.default_channels import default_channels
from ipa_cli.parse.links import extract_ref_targets
from ipa_cli.parse.note_model import Note
from ipa_cli.parse.vault_loader import load_notes
from ipa_cli.runtime.search_engine import SearchEngine


def _multi_search(
    engine: SearchEngine,
    queries: list[str],
    weights: dict[str, float] | None,
    *,
    threshold: float,
    cap: int,
) -> list[Hit]:
    """Sum per-query Hit scores → threshold filter → cap.

    Mirrors ``tune.loss._multi_search``; lifted here so the CLI doesn't
    reach into the tune module.
    """
    combined: dict[str, float] = {}
    explanations: dict[str, dict] = {}
    for q in queries:
        if not q:
            continue
        for hit in engine.search(Query(raw=q), weights=weights):
            combined[hit.note_id] = combined.get(hit.note_id, 0.0) + hit.score
            if hit.explanations:
                explanations[hit.note_id] = hit.explanations
    ranked = [
        Hit(note_id=nid, score=score, explanations=explanations.get(nid))
        for nid, score in combined.items()
        if score >= threshold
    ]
    ranked.sort(key=lambda h: h.score, reverse=True)
    return ranked[:cap]


def _format_refs(refs: list[str], max_show: int = 2) -> str:
    if not refs:
        return ""
    shown = refs[:max_show]
    suffix = f" +{len(refs) - max_show}" if len(refs) > max_show else ""
    return "  ref→ " + ", ".join(shown) + suffix


def _summarize_refs(
    hits: list[Hit],
    notes_by_id: dict[str, Note],
    mapping: Mapping,
    *,
    min_count: int = 2,
    top_n: int = 5,
) -> list[tuple[str, int]]:
    counter: Counter[str] = Counter()
    for hit in hits:
        note = notes_by_id.get(hit.note_id)
        if note is None:
            continue
        for ref in extract_ref_targets(note.refs(mapping)):
            counter[ref] += 1
    return [
        (name, count)
        for name, count in counter.most_common(top_n)
        if count >= min_count
    ]


def _format_reasons(hit: Hit) -> str:
    if not hit.explanations:
        return ""
    parts: list[str] = []
    for ch_name, payload in hit.explanations.items():
        raw = payload.get("raw")
        if raw is None or raw <= 0:
            continue
        parts.append(f"{ch_name}={raw:.2f}")
    if not parts:
        return ""
    return "  (" + ", ".join(parts) + ")"


def search_hits(
    vault_path: Path,
    queries: list[str],
    *,
    threshold: float,
    max_results: int,
    show_all: bool = False,
    weights: dict[str, float] | None = None,
    mapping: Mapping | None = None,
) -> tuple[list[Hit], list[Note], int]:
    """Return ``(visible_hits, notes, cut_count)`` for callers that want
    the structured payload (e.g. equivalence tests).

    ``cut_count`` is the number of additional hits past ``max_results``
    that satisfied the threshold — surfaced in the 1차-style trailer.
    """
    if mapping is None:
        mapping = Mapping()
    notes = load_notes(vault_path.expanduser(), mapping)

    ctx = SetupContext(
        notes=notes,
        vault_path=vault_path,
        cache_dir=vault_path / ".cache",
        mapping=mapping,
    )
    engine = SearchEngine(channels=default_channels(), ctx=ctx)
    engine.setup()

    effective_threshold = 0.0 if show_all else threshold
    fetch_cap = 9999 if show_all else max(max_results, 50)

    full = _multi_search(
        engine,
        queries,
        weights,
        threshold=effective_threshold,
        cap=fetch_cap,
    )
    visible_cap = 9999 if show_all else max_results
    visible = full[:visible_cap]
    cut = max(0, len(full) - len(visible))
    return visible, notes, cut


def render_search(
    vault_path: Path,
    queries: list[str],
    *,
    threshold: float,
    max_results: int,
    show_all: bool = False,
    reasons: bool = False,
    weights: dict[str, float] | None = None,
    mapping: Mapping | None = None,
) -> str:
    """Top-level entrypoint used by ``ipa search`` (S5)."""
    if not queries:
        return "No queries supplied."

    if mapping is None:
        mapping = Mapping()
    visible, notes, cut = search_hits(
        vault_path,
        queries,
        threshold=threshold,
        max_results=max_results,
        show_all=show_all,
        weights=weights,
        mapping=mapping,
    )
    notes_by_id = {n.id: n for n in notes}

    label = " + ".join(queries)
    if not visible:
        msg = f"No results for '{label}'"
        if not show_all and threshold > 0:
            msg += (
                f" (threshold {threshold} 적용 — `--threshold 0` 또는 `--all`로 재시도)"
            )
        return msg

    lines: list[str] = []
    header = f"Search results for '{label}': {len(visible)} notes"
    if not show_all and threshold > 0:
        header += f" (threshold {threshold})"
    lines.append(header)
    for hit in visible:
        note = notes_by_id.get(hit.note_id)
        nt = (note.note_type(mapping) if note else None) or "?"
        ref_str = _format_refs(extract_ref_targets(note.refs(mapping))) if note else ""
        line = f"  [{hit.score:4.1f}] [{nt:5s}] {hit.note_id}{ref_str}"
        if reasons:
            line += _format_reasons(hit)
        lines.append(line)

    if cut > 0:
        lines.append("")
        lines.append(
            f"... +{cut}개 결과 더 있음. 전체 보려면 `--all` 또는 `--max {len(visible) + cut}`, "
            f"임계 조절은 `--threshold 0.25`"
        )

    ref_dist = _summarize_refs(visible, notes_by_id, mapping)
    if ref_dist:
        lines.append("")
        lines.append("=== 결과 노트들의 소속 인덱스/ref 분포 (2건 이상) ===")
        for ref_name, count in ref_dist:
            lines.append(f"  {count:2d}건  {ref_name}")
        lines.append("→ 2건+ 인덱스는 --view + traversal --down 권장")

    return "\n".join(lines)

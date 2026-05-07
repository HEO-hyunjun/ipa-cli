"""Sample custom search channel — boosts notes whose H1/H2 contains the query.

Demonstrates:
- using P5 ``Note.headings`` (parse level 3 lazy AST) so the channel
  doesn't roll its own regex against ``note.body``
- emitting per-note raw scores and letting ``SearchEngine`` weight + sort
- exposing structured ``explain`` so ``--explain`` can show *which*
  heading text matched

Touching ``note.headings`` triggers markdown-it parsing, which then gets
written back to ``parsed_index.pkl`` via the engine's persist hook —
subsequent invocations skip parsing for unchanged notes.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, ClassVar

from ipa_cli.api.base_channels import BaseSearchChannel

if TYPE_CHECKING:
    from ipa_cli.api.base_channels import Query, SetupContext


class HeadingMatchChannel(BaseSearchChannel):
    name: ClassVar[str] = "heading_match"
    description: ClassVar[str] = (
        "Boost notes whose H1/H2 heading contains the (lowercased) query. "
        "Sample plugin demonstrating P5 Note.headings."
    )
    default_weight: ClassVar[float] = 0.10

    def __init__(self) -> None:
        # Per-query memoized matches (built in ``search``, read by
        # ``explain``). Cleared next ``prepare`` call so the channel is
        # safe to reuse across queries.
        self._matched: dict[str, list[str]] = {}

    def prepare(self, query: "Query") -> None:
        self._matched = {}

    def search(self, ctx: "SetupContext", query: "Query") -> dict[str, float]:
        q = query.raw.strip().lower()
        if not q:
            return {}
        out: dict[str, float] = {}
        for note in ctx.notes:
            hits = [
                h.text for h in note.headings if h.level <= 2 and q in h.text.lower()
            ]
            if hits:
                out[note.id] = 1.0
                self._matched[note.id] = hits
        return out

    def explain(self, note_id: str) -> dict[str, Any]:
        if note_id not in self._matched:
            return {}
        return {"matched_headings": self._matched[note_id]}

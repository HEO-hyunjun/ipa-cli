"""Search engine — composes per-channel scores into a ranked Hit list.

Lifecycle: ``__init__`` binds channels and the shared ``SetupContext``;
``setup`` runs heavy per-channel initialization once; ``search`` runs
per-query and combines weighted scores. Idempotent ``setup`` lets call
sites invoke it explicitly or rely on ``search`` to do it lazily.

Weight resolution: each channel exposes ``default_weight``; callers can
override per name via the ``weights`` dict on ``search``. Unknown names
are ignored — they never affect the score.

Per-note explanations capture the raw (pre-weight) channel scores so
``--explain`` can render them without re-running channels. iter3 adds
the structured ``explain`` payload from each channel; iter1 keeps the
raw float so the wire shape stays stable.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ipa_cli.api.base_channels import Hit

if TYPE_CHECKING:
    from ipa_cli.api.base_channels import BaseSearchChannel, Query, SetupContext


class SearchEngine:
    def __init__(
        self,
        channels: list["BaseSearchChannel"],
        ctx: "SetupContext",
    ) -> None:
        self.channels = list(channels)
        self.ctx = ctx
        self._setup_done = False

    def setup(self) -> None:
        """Run each channel's ``setup`` once. Safe to call multiple times."""
        if self._setup_done:
            return
        for channel in self.channels:
            channel.setup(self.ctx)
        self._setup_done = True

    def search(
        self,
        query: "Query",
        weights: dict[str, float] | None = None,
    ) -> list[Hit]:
        """Combine per-channel scores into a sorted Hit list."""
        self.setup()
        weight_map = dict(weights or {})

        per_channel: dict[str, dict[str, float]] = {}
        combined: dict[str, float] = {}

        for channel in self.channels:
            channel.prepare(query)
            scores = channel.search(self.ctx, query)
            per_channel[channel.name] = scores
            w = weight_map.get(channel.name, channel.default_weight)
            for note_id, raw in scores.items():
                combined[note_id] = combined.get(note_id, 0.0) + raw * w

        hits: list[Hit] = []
        for note_id, score in combined.items():
            explanations = _build_explanations(note_id, per_channel)
            hits.append(Hit(note_id=note_id, score=score, explanations=explanations))
        hits.sort(key=lambda h: h.score, reverse=True)
        return hits


def _build_explanations(
    note_id: str,
    per_channel: dict[str, dict[str, float]],
) -> dict[str, dict[str, Any]] | None:
    out: dict[str, dict[str, Any]] = {}
    for ch_name, scores in per_channel.items():
        raw = scores.get(note_id)
        if raw is None:
            continue
        out[ch_name] = {"raw": raw}
    return out or None

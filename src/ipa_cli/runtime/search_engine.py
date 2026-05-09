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
        """Run each channel's ``setup`` once. Safe to call multiple times.

        Before channel setup, primes ``Note._body_ast`` from the parsed
        AST disk cache (P5). Misses are silent — channels that touch
        ``body_ast`` will simply parse on demand.
        """
        if self._setup_done:
            return
        try:
            from ipa_cli.parse.parsed_cache import prime_notes_with_cache

            prime_notes_with_cache(self.ctx.notes, self.ctx.cache_dir)
        except Exception:
            # Cache priming is best-effort. Failures must never block
            # the engine — fall back to lazy parsing.
            pass
        for channel in self.channels:
            channel.setup(self.ctx)
        self._setup_done = True

    def persist_parsed_cache(self) -> int:
        """Write any AST tokens built during this run back to disk.

        Returns the number of notes persisted. Notes whose ``body_ast``
        was never accessed are skipped so cold runs don't bloat the
        cache with un-needed entries.
        """
        from ipa_cli.parse.parsed_cache import persist_after_parse

        return persist_after_parse(self.ctx.notes, self.ctx.cache_dir)

    def search(
        self,
        query: "Query",
        weights: dict[str, float] | None = None,
        *,
        threshold: float | None = None,
        cap: int | None = None,
    ) -> list[Hit]:
        """Combine per-channel scores into a sorted Hit list."""
        per_channel = self.score_channels(query)
        weight_map = dict(weights or {})

        channels_by_name = {channel.name: channel for channel in self.channels}
        combined: dict[str, float] = {}

        for channel_name, scores in per_channel.items():
            channel = channels_by_name[channel_name]
            w = weight_map.get(channel.name, channel.default_weight)
            for note_id, raw in scores.items():
                combined[note_id] = combined.get(note_id, 0.0) + raw * w

        hits: list[Hit] = []
        for note_id, score in combined.items():
            if threshold is not None and score < threshold:
                continue
            explanations = _build_explanations(note_id, per_channel, channels_by_name)
            hits.append(Hit(note_id=note_id, score=score, explanations=explanations))
        hits.sort(key=lambda h: h.score, reverse=True)
        if cap is not None:
            hits = hits[:cap]
        return hits

    def score_channels(self, query: "Query") -> dict[str, dict[str, float]]:
        """Return raw per-channel scores for ``query`` without explanations.

        Tune can cache this payload once per unique query and then vary
        weights/threshold/cap cheaply across many trials.
        """
        self.setup()
        per_channel: dict[str, dict[str, float]] = {}
        for channel in self.channels:
            channel.prepare(query)
            scores = channel.search(self.ctx, query)
            per_channel[channel.name] = scores
        return per_channel


def _build_explanations(
    note_id: str,
    per_channel: dict[str, dict[str, float]],
    channels_by_name: dict[str, "BaseSearchChannel"],
) -> dict[str, dict[str, Any]] | None:
    out: dict[str, dict[str, Any]] = {}
    for ch_name, scores in per_channel.items():
        raw = scores.get(note_id)
        if raw is None:
            continue
        payload = {"raw": raw}
        details = channels_by_name[ch_name].explain(note_id)
        if details:
            payload.update(details)
        out[ch_name] = payload
    return out or None

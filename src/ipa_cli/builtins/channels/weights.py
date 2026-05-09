"""Single source of truth for builtin search channel weights."""

from __future__ import annotations

DEFAULT_CHANNEL_WEIGHTS: dict[str, float] = {
    "fuzzy": 0.268,
    # Runtime split of the legacy fuzzy exact/substring branch. Keeping
    # it explicit prevents an engine-only fallback that config output hides.
    "filename": 0.200,
    "keyword": 0.055,
    "related": 0.032,
    "body_match": 0.363,
    "sequence_match": 0.078,
    "filename_partial": 0.150,
    "child_body_match": 0.169,
    "project": 0.033,
}

"""Default builtin channel preset.

Returned by ``runtime.search_loader.load_search_channels`` when a profile
has no ``search.py``. The legacy fuzzy branch is split into two runtime
channels here: ``filename`` for exact/substring filename matches and
``fuzzy`` for graded jamo/SequenceMatcher matches.

Default weights are defined once in ``builtins.channels.weights`` and
shared by channel fallbacks and config defaults. The engine simply
weights and adds, with no normalization.
"""

from __future__ import annotations

from ipa_cli.api.base_channels import BaseSearchChannel
from ipa_cli.builtins.channels import (
    BodyMatchChannel,
    ChildBodyMatchChannel,
    FilenameMatchChannel,
    FilenamePartialChannel,
    FuzzyChannel,
    KeywordChannel,
    ProjectChannel,
    RelatedChannel,
    SequenceMatchChannel,
)


def default_channels() -> list[BaseSearchChannel]:
    return [
        FuzzyChannel(),
        KeywordChannel(),
        FilenameMatchChannel(),
        SequenceMatchChannel(),
        FilenamePartialChannel(),
        BodyMatchChannel(),
        ChildBodyMatchChannel(),
        RelatedChannel(),
        ProjectChannel(),
    ]

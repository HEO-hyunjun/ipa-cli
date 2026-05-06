"""Default builtin channel preset.

Returned by ``runtime.search_loader.load_search_channels`` when a profile
has no ``search.py``. Mirrors 1차 P9-rerun's 8-channel set so out-of-the-
box behavior matches established weight tuning.

Default weights match 1차 (sum > 1; the engine simply weights and adds,
no normalization). They're the recommended starting point — users may
override via the ``weights`` argument to ``SearchEngine.search`` or by
substituting their own ``search.py``.
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

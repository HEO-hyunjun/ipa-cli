"""Default builtin channel preset.

Returned by ``runtime.search_loader.load_search_channels`` when a profile
has no ``search.py``. Users start here and either extend the list in
their own ``search.py`` or replace it entirely.

iter2 adds BM25-trigram + child body propagation. The four channels
together cover most of 1차's signal — graded fuzzy / related / project
arrive in iter3.
"""

from __future__ import annotations

from ipa_cli.api.base_channels import BaseSearchChannel
from ipa_cli.builtins.channels import (
    BodyMatchChannel,
    ChildBodyMatchChannel,
    FilenameMatchChannel,
    KeywordChannel,
)


def default_channels() -> list[BaseSearchChannel]:
    return [
        KeywordChannel(),
        FilenameMatchChannel(),
        BodyMatchChannel(),
        ChildBodyMatchChannel(),
    ]

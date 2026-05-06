"""Default builtin channel preset.

Returned by ``runtime.search_loader.load_search_channels`` when a profile
has no ``search.py``. Users start here and either extend the list in
their own ``search.py`` or replace it entirely.

iter1 set is intentionally minimal so the engine can be exercised
without BM25 / jamo trigram dependencies.
"""

from __future__ import annotations

from ipa_cli.api.base_channels import BaseSearchChannel
from ipa_cli.builtins.channels import FilenameMatchChannel, KeywordChannel


def default_channels() -> list[BaseSearchChannel]:
    return [KeywordChannel(), FilenameMatchChannel()]

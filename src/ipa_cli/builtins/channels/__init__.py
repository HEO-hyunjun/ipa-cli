"""Builtin search channels.

iter1 ports the cheapest channels from 1차 ``unified_search``:
``keyword`` (token AND match) and ``filename`` (exact/substring/no-space).
The heavier BM25, jamo trigram, related and project channels arrive in
later P4 iters so the engine surface can be exercised without dragging
in their indexing cost.
"""

from ipa_cli.builtins.channels.filename_channel import FilenameMatchChannel
from ipa_cli.builtins.channels.keyword_channel import KeywordChannel

__all__ = [
    "FilenameMatchChannel",
    "KeywordChannel",
]

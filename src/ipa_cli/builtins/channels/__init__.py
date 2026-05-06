"""Builtin search channels.

iter1 ports keyword + filename match. iter2 adds the BM25-trigram body
channel and the index/root child propagation channel. Heavier graph
walks (related, project) and the graded fuzzy fallback ship in iter3.
"""

from ipa_cli.builtins.channels.body_channel import BodyMatchChannel
from ipa_cli.builtins.channels.child_body_channel import ChildBodyMatchChannel
from ipa_cli.builtins.channels.filename_channel import FilenameMatchChannel
from ipa_cli.builtins.channels.keyword_channel import KeywordChannel

__all__ = [
    "BodyMatchChannel",
    "ChildBodyMatchChannel",
    "FilenameMatchChannel",
    "KeywordChannel",
]

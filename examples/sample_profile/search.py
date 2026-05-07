"""Sample search.py — declared list of active search channels.

The runtime imports this file and reads the module-level ``channels``
list. As with ``convention.py``, there is no auto-discovery: the list
here is the source of truth.

This sample appends ``HeadingMatchChannel`` (defined in
``channel_rules/heading_match_channel.py``) to the builtin set so users
get the default 9-channel parity plus one extra signal that boosts
notes whose H1/H2 headings contain the query.
"""

from __future__ import annotations

from ipa_cli.builtins.channels.default_channels import default_channels

from .channel_rules.heading_match_channel import HeadingMatchChannel

channels = [
    *default_channels(),
    HeadingMatchChannel(),
]

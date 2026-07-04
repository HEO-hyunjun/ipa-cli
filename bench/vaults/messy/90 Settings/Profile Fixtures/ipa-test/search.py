from channel_rules.parent_alias_channel import ParentAliasChannel
from ipa_cli.builtins.search.default_search import (
    BodyMatchChannel,
    FilenameFuzzyChannel,
)


channels = [
    FilenameFuzzyChannel(),
    BodyMatchChannel(),
    ParentAliasChannel(),
]

weights = {
    "filename_fuzzy": 0.24,
    "body_match": 0.28,
    "parent_alias": 0.18,
}


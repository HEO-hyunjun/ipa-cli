"""Builtin convention rules.

Imported lazily by ``default_convention`` so the broader runtime can be
exercised without forcing every test to drag in builtin rules.
"""

from ipa_cli.builtins.conventions.rules.frontmatter_rules import (
    FrontmatterRequiredFieldsRule,
    InvalidTypeRule,
    MissingRefRule,
)
from ipa_cli.builtins.conventions.rules.heading_rules import NoH1Rule
from ipa_cli.builtins.conventions.rules.location_rules import LocationByTypeRule
from ipa_cli.builtins.conventions.rules.title_rules import (
    IndexTitlePrefixRule,
    RootTitlePrefixRule,
    RootTitleSuffixRule,
)

__all__ = [
    "FrontmatterRequiredFieldsRule",
    "IndexTitlePrefixRule",
    "InvalidTypeRule",
    "LocationByTypeRule",
    "MissingRefRule",
    "NoH1Rule",
    "RootTitlePrefixRule",
    "RootTitleSuffixRule",
]

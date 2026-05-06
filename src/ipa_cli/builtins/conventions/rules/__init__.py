"""Builtin convention rules.

Imported lazily by ``default_convention`` so the broader runtime can be
exercised without forcing every test to drag in builtin rules.
"""

from ipa_cli.builtins.conventions.rules.frontmatter_rules import (
    DateFormatRule,
    FrontmatterRequiredFieldsRule,
    InvalidTypeRule,
    MissingRefRule,
)
from ipa_cli.builtins.conventions.rules.heading_rules import NoH1Rule
from ipa_cli.builtins.conventions.rules.link_rules import (
    RefLinkTargetRule,
    WikilinkTargetRule,
)
from ipa_cli.builtins.conventions.rules.location_rules import LocationByTypeRule
from ipa_cli.builtins.conventions.rules.root_folder_rules import (
    DuplicateRootRule,
    MissingRootRule,
)
from ipa_cli.builtins.conventions.rules.title_rules import (
    IndexTitlePrefixRule,
    RootTitlePrefixRule,
    RootTitleSuffixRule,
)

__all__ = [
    "DateFormatRule",
    "DuplicateRootRule",
    "FrontmatterRequiredFieldsRule",
    "IndexTitlePrefixRule",
    "InvalidTypeRule",
    "LocationByTypeRule",
    "MissingRefRule",
    "MissingRootRule",
    "NoH1Rule",
    "RefLinkTargetRule",
    "RootTitlePrefixRule",
    "RootTitleSuffixRule",
    "WikilinkTargetRule",
]

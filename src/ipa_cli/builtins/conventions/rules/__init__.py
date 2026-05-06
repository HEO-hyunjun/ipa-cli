"""Builtin convention rules.

Imported lazily by ``default_convention`` so the broader runtime can be
exercised without forcing every test to drag in builtin rules.
"""

from ipa_cli.builtins.conventions.rules.frontmatter_rules import (
    FrontmatterRequiredFieldsRule,
)
from ipa_cli.builtins.conventions.rules.heading_rules import NoH1Rule

__all__ = [
    "FrontmatterRequiredFieldsRule",
    "NoH1Rule",
]

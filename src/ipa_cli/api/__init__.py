"""Public API surface for ipa rules, channels, mapping and helpers.

External plugin authors and downstream runtime modules should import from
``ipa_cli.api`` rather than reaching into individual submodules.
"""

from ipa_cli.api.base_channels import (
    BaseSearchChannel,
    Hit,
    Query,
    SetupContext,
)
from ipa_cli.api.base_rules import (
    BaseConventionRule,
    Issue,
    Patch,
    Scope,
    Severity,
    Span,
)
from ipa_cli.api.context import (
    FormatContext,
    SearchContext,
    ValidationContext,
)
from ipa_cli.api.conventions import Convention
from ipa_cli.api.decorators import simple_format_rule
from ipa_cli.api.mappings import REQUIRED_FIELDS, Mapping

__all__ = [
    "REQUIRED_FIELDS",
    "BaseConventionRule",
    "BaseSearchChannel",
    "Convention",
    "FormatContext",
    "Hit",
    "Issue",
    "Mapping",
    "Patch",
    "Query",
    "Scope",
    "SearchContext",
    "Severity",
    "SetupContext",
    "Span",
    "ValidationContext",
    "simple_format_rule",
]

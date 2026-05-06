"""Default builtin convention preset.

Returned by ``runtime.convention_loader.load_convention`` when a profile
has no ``convention.py`` of its own. Users start here and can either
add to or trim this list in their own ``convention.py``.

Coverage map vs 1차 vault_validator:

- P001  → FrontmatterRequiredFieldsRule
- P003  → InvalidTypeRule
- P004  → MissingRefRule
- T001  → RootTitlePrefixRule
- T002  → RootTitleSuffixRule
- T003  → IndexTitlePrefixRule
- L001  → LocationByTypeRule
- H001  → NoH1Rule
- P002, K001, K002, R001, R002 → not yet ported (P3c iter 2)
"""

from __future__ import annotations

from ipa_cli.api.conventions import Convention
from ipa_cli.builtins.conventions.rules import (
    FrontmatterRequiredFieldsRule,
    IndexTitlePrefixRule,
    InvalidTypeRule,
    LocationByTypeRule,
    MissingRefRule,
    NoH1Rule,
    RootTitlePrefixRule,
    RootTitleSuffixRule,
)


def default_convention() -> Convention:
    return Convention(
        name="ipa.builtin",
        rules=[
            FrontmatterRequiredFieldsRule(),
            InvalidTypeRule(),
            MissingRefRule(),
            RootTitlePrefixRule(),
            RootTitleSuffixRule(),
            IndexTitlePrefixRule(),
            LocationByTypeRule(),
            NoH1Rule(),
        ],
    )

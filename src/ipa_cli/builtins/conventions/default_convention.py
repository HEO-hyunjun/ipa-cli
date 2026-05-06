"""Default builtin convention preset.

Returned by ``runtime.convention_loader.load_convention`` when a profile
has no ``convention.py`` of its own. Users start here and can either
add to or trim this list in their own ``convention.py``.

Coverage map vs 1차 vault_validator:

- P001  → FrontmatterRequiredFieldsRule
- P002  → DateFormatRule (opt-in via ``mapping.date_pattern``)
- P003  → InvalidTypeRule
- P004  → MissingRefRule
- T001  → RootTitlePrefixRule
- T002  → RootTitleSuffixRule
- T003  → IndexTitlePrefixRule
- L001  → LocationByTypeRule
- K001  → RefLinkTargetRule (vault scope)
- K002  → WikilinkTargetRule (vault scope)
- R001  → DuplicateRootRule (vault scope)
- R002  → MissingRootRule (vault scope)
- H001  → NoH1Rule
"""

from __future__ import annotations

from ipa_cli.api.conventions import Convention
from ipa_cli.builtins.conventions.rules import (
    DateFormatRule,
    DuplicateRootRule,
    FrontmatterRequiredFieldsRule,
    IndexTitlePrefixRule,
    InvalidTypeRule,
    LocationByTypeRule,
    MissingRefRule,
    MissingRootRule,
    NoH1Rule,
    RefLinkTargetRule,
    RootTitlePrefixRule,
    RootTitleSuffixRule,
    WikilinkTargetRule,
)


def default_convention() -> Convention:
    return Convention(
        name="ipa.builtin",
        rules=[
            FrontmatterRequiredFieldsRule(),
            DateFormatRule(),
            InvalidTypeRule(),
            MissingRefRule(),
            RootTitlePrefixRule(),
            RootTitleSuffixRule(),
            IndexTitlePrefixRule(),
            LocationByTypeRule(),
            RefLinkTargetRule(),
            WikilinkTargetRule(),
            DuplicateRootRule(),
            MissingRootRule(),
            NoH1Rule(),
        ],
    )

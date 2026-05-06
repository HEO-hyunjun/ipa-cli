"""Default builtin convention preset.

Returned by ``runtime.convention_loader.load_convention`` when a profile
has no ``convention.py`` of its own. Users start here and can either
add to or trim this list in their own ``convention.py``.
"""

from __future__ import annotations

from ipa_cli.api.conventions import Convention
from ipa_cli.builtins.conventions.rules import (
    FrontmatterRequiredFieldsRule,
    NoH1Rule,
)


def default_convention() -> Convention:
    return Convention(
        name="ipa.builtin",
        rules=[
            FrontmatterRequiredFieldsRule(),
            NoH1Rule(),
        ],
    )

"""Sample convention.py — declared list of active rules for this profile.

The runtime imports this file from your profile workspace and reads the
module-level ``convention`` attribute (a ``Convention`` instance).
Anything not in the list is inactive even if it lives in a sibling
file under ``rules/``.

Why an explicit list (no auto-discovery): import errors surface
immediately ("oops, deleted that rule"), and reading this file tells
you exactly what's active without crawling the directory.
"""

from __future__ import annotations

from ipa_cli.api.conventions import Convention

# Pull in the IPA builtin set so users get parity with `ipa convention`
# out of the box, then layer on profile-specific rules.
from ipa_cli.builtins.conventions.default_convention import default_convention

from .rules.no_emoji_in_filename_rule import NoEmojiInFilenameRule

_builtin = default_convention()

convention = Convention(
    name="sample",
    rules=[
        *_builtin.rules,
        NoEmojiInFilenameRule(),
    ],
)

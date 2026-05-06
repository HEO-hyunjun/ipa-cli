"""Plugin registry + built-in auto-registration.

Importing this package causes `plugins.builtin` to load, which
registers all built-in channels/rules/refactors. Future phases will
add config-declared and entry-point discovery here.
"""

from .registry import (
    clear,
    get_channels,
    get_refactors,
    get_rules,
    register_channel,
    register_refactor,
    register_rule,
)

# Side-effect import: trigger built-in registration.
from . import builtin  # noqa: E402, F401

__all__ = [
    "clear",
    "get_channels",
    "get_refactors",
    "get_rules",
    "register_channel",
    "register_refactor",
    "register_rule",
]

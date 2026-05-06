"""In-process registries for channels, rules, and refactor commands.

Registration paths supported in S4:
  - Built-in: import-time registration (see plugins/builtin/*).

Postponed:
  - Config-declared imports
  - Entry-point discovery (importlib.metadata)
  - Local `~/.config/ipa/plugins/` autoload
"""

from __future__ import annotations

from typing import TypeVar

from .protocols import Channel, RefactorCommand, Rule

C = TypeVar("C", bound=Channel)
R = TypeVar("R", bound=Rule)
F = TypeVar("F", bound=RefactorCommand)

_channels: dict[str, Channel] = {}
_rules: dict[str, Rule] = {}
_refactors: dict[str, RefactorCommand] = {}


def register_channel(channel: C) -> C:
    """Register a Channel. Last writer wins on name collision."""
    _channels[channel.name] = channel
    return channel


def register_rule(rule: R) -> R:
    _rules[rule.id] = rule
    return rule


def register_refactor(command: F) -> F:
    _refactors[command.name] = command
    return command


def get_channels() -> dict[str, Channel]:
    return dict(_channels)


def get_rules() -> dict[str, Rule]:
    return dict(_rules)


def get_refactors() -> dict[str, RefactorCommand]:
    return dict(_refactors)


def clear() -> None:
    """Test-only — wipe all three registries."""
    _channels.clear()
    _rules.clear()
    _refactors.clear()

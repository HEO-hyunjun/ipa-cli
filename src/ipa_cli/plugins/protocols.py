"""Plugin protocols (S4 minimal — metadata only).

The Protocols here describe the contracts external plugins must
satisfy. The S4 scope is registry + metadata exposure; runtime
integration with vault_search/validator/refactor stays in those
modules. S5 (tune) will read the channel registry to enumerate
weight knobs; later phases will route validator/refactor through
the rule and command registries.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class Channel(Protocol):
    """A search channel produces a [0, 1] score per (query, note)."""

    name: str
    description: str
    weight: float | None


@runtime_checkable
class Rule(Protocol):
    """A validator rule emits Issues for one aspect of vault structure."""

    id: str
    category: str
    description: str


@runtime_checkable
class RefactorCommand(Protocol):
    """A refactor command performs a structural mutation across the vault."""

    name: str
    description: str

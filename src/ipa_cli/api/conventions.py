"""Convention — a named collection of active rules.

A profile's ``convention.py`` exposes one ``Convention`` instance that
declares which rules are active and (optionally) how they're configured.
Rules are stored as a list so order is preserved for plan output and
deterministic validator runs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ipa_cli.api.base_rules import BaseConventionRule


@dataclass
class Convention:
    rules: list["BaseConventionRule"] = field(default_factory=list)
    name: str = "default"

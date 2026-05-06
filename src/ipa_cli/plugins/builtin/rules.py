"""Built-in validator rules (metadata only, S4).

Pulled directly from `vault_validator.RULE_CODES` so adding a rule
upstream automatically lights up here.
"""

from __future__ import annotations

from dataclasses import dataclass

from ipa_cli.core.vault_validator import RULE_CODES
from ipa_cli.plugins.registry import register_rule


@dataclass(frozen=True)
class BuiltinRule:
    id: str
    category: str
    description: str


for _code, _desc in RULE_CODES.items():
    register_rule(
        BuiltinRule(
            id=_code,
            category=_code[0],
            description=_desc,
        )
    )

"""Context objects passed to rule/channel methods.

These carry shared runtime state to user-authored rules and channels so
they don't have to know about engine internals. P1 keeps them minimal —
P3 adds helpers (note lookup, ref graph queries, mapping accessors) as
the validator/formatter engines come online.

``SearchContext`` is currently structurally similar to ``SetupContext``
but exists as a separate type so future query-time helpers (e.g.
explanation collectors) can be added without changing setup-time API.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ipa_cli.api.mappings import Mapping
    from ipa_cli.parse.note_model import Note


@dataclass
class ValidationContext:
    vault_path: Path
    notes: list["Note"]
    mapping: "Mapping"
    folder: Path | None = None  # set when CLI scope is "folder"


@dataclass
class FormatContext:
    vault_path: Path
    notes: list["Note"]
    mapping: "Mapping"


@dataclass
class SearchContext:
    vault_path: Path
    notes: list["Note"] = field(default_factory=list)

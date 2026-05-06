"""In-memory note model.

Holds raw frontmatter and body. Semantic accessors (``note_type``,
``refs``, etc.) read frontmatter via a ``Mapping`` so the same Note works
across vaults with different frontmatter key naming. P5 will add lazy
properties (``body_ast`` via markdown-it-py, parsed wikilinks) on top of
this same shape.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ipa_cli.api.mappings import Mapping


def _normalize_list(value: Any) -> list[str]:
    """Coerce yaml ``str | list[str] | None`` into ``list[str]``."""
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple)):
        return [str(item) for item in value if item is not None]
    return [str(value)]


@dataclass
class Note:
    id: str
    path: Path
    body: str
    frontmatter: dict[str, Any] = field(default_factory=dict)

    def note_type(self, mapping: "Mapping") -> str | None:
        value = self.frontmatter.get(mapping.note_type)
        return str(value) if value is not None else None

    def refs(self, mapping: "Mapping") -> list[str]:
        return _normalize_list(self.frontmatter.get(mapping.refs))

    def tags(self, mapping: "Mapping") -> list[str]:
        return _normalize_list(self.frontmatter.get(mapping.tags))

    def created_at(self, mapping: "Mapping") -> str | None:
        value = self.frontmatter.get(mapping.created_at)
        return str(value) if value is not None else None

    def updated_at(self, mapping: "Mapping") -> str | None:
        value = self.frontmatter.get(mapping.updated_at)
        return str(value) if value is not None else None

    def aliases(self, mapping: "Mapping") -> list[str]:
        if mapping.aliases is None:
            return []
        return _normalize_list(self.frontmatter.get(mapping.aliases))

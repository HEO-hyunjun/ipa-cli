"""In-memory note model.

Holds raw frontmatter and body. Semantic accessors (``note_type``,
``refs``, etc.) read frontmatter via a ``Mapping`` so the same Note works
across vaults with different frontmatter key naming. P5 added the
``body_ast`` lazy property and structural helpers (``headings``,
``wikilinks``, ``embeds``, ``callouts``) backed by markdown-it-py via
``parse/markdown_parser.py`` and ``parse/obsidian_extensions.py``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from markdown_it.token import Token

    from ipa_cli.api.mappings import Mapping
    from ipa_cli.parse.markdown_parser import CodeFence, Heading
    from ipa_cli.parse.obsidian_extensions import Callout


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
    # parse-level-3 token list, populated lazily on first access via
    # ``body_ast``. Stored on the dataclass (not @cached_property) so
    # downstream code can clear it without breaking dataclass identity.
    _body_ast: list["Token"] | None = field(default=None, repr=False, compare=False)

    @property
    def body_ast(self) -> list["Token"]:
        """markdown-it-py token list. Built once per Note, lazily."""
        if self._body_ast is None:
            from ipa_cli.parse.markdown_parser import parse_markdown

            self._body_ast = parse_markdown(self.body)
        return self._body_ast

    @property
    def headings(self) -> list["Heading"]:
        from ipa_cli.parse.markdown_parser import extract_headings

        return extract_headings(self.body_ast)

    @property
    def code_fences(self) -> list["CodeFence"]:
        from ipa_cli.parse.markdown_parser import extract_code_fences

        return extract_code_fences(self.body_ast)

    @property
    def wikilinks(self) -> list[str]:
        from ipa_cli.parse.obsidian_extensions import extract_wikilinks_from_tokens

        return extract_wikilinks_from_tokens(self.body_ast)

    @property
    def embeds(self) -> list[str]:
        from ipa_cli.parse.obsidian_extensions import extract_embeds_from_tokens

        return extract_embeds_from_tokens(self.body_ast)

    @property
    def callouts(self) -> list["Callout"]:
        from ipa_cli.parse.obsidian_extensions import extract_callouts

        return extract_callouts(self.body_ast)

    def inline_text(self) -> str:
        """Concatenated inline text — feeds tokenization channels."""
        from ipa_cli.parse.markdown_parser import extract_inline_text

        return extract_inline_text(self.body_ast)

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

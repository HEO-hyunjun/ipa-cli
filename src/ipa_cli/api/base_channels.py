"""Base class for search channels and the SetupContext shared resource bag.

A channel is one unit of search scoring. The engine runs ``setup`` once
per process, ``prepare`` once per query, and combines per-note ``search``
scores using channel weights. ``explain`` returns structured matching
reasoning the CLI can render.

SetupContext holds resources that multiple channels share (tokenized
notes, ref graph, BM25 index). Each shared resource is a ``cached_property``
so the first channel that touches it builds it, and the rest read the
cached value. This avoids the orchestrator/dependency-graph complexity
while keeping setup cost amortized across channels.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar

from ipa_cli.api.mappings import Mapping

if TYPE_CHECKING:
    from ipa_cli.parse.bm25 import BM25Artifact
    from ipa_cli.parse.note_model import Note

NoteId = str


@dataclass(frozen=True)
class Query:
    raw: str


@dataclass(frozen=True)
class Hit:
    note_id: NoteId
    score: float
    explanations: dict[str, dict[str, Any]] | None = None


class SetupContext:
    """Process-once shared resources for channels.

    Heavy resources (tokens, ref graph, BM25 model) are exposed as lazy
    properties. The first ``ctx.tokens`` access builds them; subsequent
    accesses return the cached value. P5 will fill the actual builders.
    """

    def __init__(
        self,
        notes: list["Note"],
        vault_path: Path,
        cache_dir: Path,
        mapping: Mapping | None = None,
    ) -> None:
        self.notes = notes
        self.vault_path = vault_path
        self.cache_dir = cache_dir
        # Vault-aware channels (e.g. ChildBodyMatchChannel reading ref
        # type) need the mapping to absorb frontmatter key naming.
        # Default keeps iter1 callers and tests working without changes.
        self.mapping = mapping if mapping is not None else Mapping()

    @cached_property
    def bm25_artifact(self) -> "BM25Artifact":
        """Trigram BM25 index over (note.id + body).

        Built lazily so channels that don't need body matching never pay
        the indexing cost. Uses ``cache_dir`` for pickle persistence.
        """
        from ipa_cli.parse.bm25 import build_bm25

        return build_bm25(self.notes, self.cache_dir)

    @cached_property
    def tokens(self) -> dict[NoteId, list[str]]:
        """note_id → tokenized body. Filled in P5."""
        raise NotImplementedError("SetupContext.tokens is filled in P5")

    @cached_property
    def ref_graph(self) -> Any:
        """Ref/wikilink adjacency. Filled in P5."""
        raise NotImplementedError("SetupContext.ref_graph is filled in P5")


class BaseSearchChannel:
    """A single search scoring channel.

    Subclasses MUST set ``name``, ``description``, ``default_weight`` and
    implement ``search``. ``setup`` / ``prepare`` / ``explain`` have safe
    no-op defaults.
    """

    name: ClassVar[str]
    description: ClassVar[str]
    default_weight: ClassVar[float]
    requires_parse_level: ClassVar[int] = 1

    def setup(self, ctx: SetupContext) -> None:
        """Process-once initialization. Build heavy indexes here."""
        return None

    def prepare(self, query: Query) -> None:
        """Per-query light preparation (tokenize, expand)."""
        return None

    def search(self, ctx: SetupContext, query: Query) -> dict[NoteId, float]:
        """Required. Return ``note_id → score`` for the given query."""
        raise NotImplementedError

    def explain(self, note_id: NoteId) -> dict[str, Any]:
        """Structured matching rationale. CLI renders, runtime stays generic."""
        return {}

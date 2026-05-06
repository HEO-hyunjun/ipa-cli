"""SearchEngine tests — setup idempotence, weight composition, ordering."""

from __future__ import annotations

from pathlib import Path
from typing import ClassVar

from ipa_cli.api.base_channels import (
    BaseSearchChannel,
    Query,
    SetupContext,
)
from ipa_cli.parse.note_model import Note
from ipa_cli.runtime.search_engine import SearchEngine


class _Recorder(BaseSearchChannel):
    """Channel that records call counts and returns a fixed score map."""

    name: ClassVar[str] = "recorder"
    description: ClassVar[str] = "test recorder"
    default_weight: ClassVar[float] = 1.0

    def __init__(
        self,
        scores: dict[str, float],
        *,
        name: str = "recorder",
        weight: float = 1.0,
    ) -> None:
        self._scores = scores
        self.setup_calls = 0
        self.prepare_calls = 0
        self.search_calls = 0
        # ClassVars are per-class; bind names per-instance for tests.
        self.name = name
        self.default_weight = weight

    def setup(self, ctx: SetupContext) -> None:
        self.setup_calls += 1

    def prepare(self, query: Query) -> None:
        self.prepare_calls += 1

    def search(self, ctx: SetupContext, query: Query) -> dict[str, float]:
        self.search_calls += 1
        return dict(self._scores)


def _ctx(tmp_path: Path) -> SetupContext:
    return SetupContext(notes=[], vault_path=tmp_path, cache_dir=tmp_path)


def test_setup_runs_each_channel_once(tmp_path: Path) -> None:
    a = _Recorder({}, name="a")
    b = _Recorder({}, name="b")
    engine = SearchEngine([a, b], _ctx(tmp_path))
    engine.setup()
    engine.setup()  # second call must not re-run
    assert a.setup_calls == 1
    assert b.setup_calls == 1


def test_search_calls_setup_lazily(tmp_path: Path) -> None:
    ch = _Recorder({"x": 1.0}, name="r")
    engine = SearchEngine([ch], _ctx(tmp_path))
    assert ch.setup_calls == 0
    engine.search(Query(raw="q"))
    assert ch.setup_calls == 1


def test_search_combines_weighted_scores(tmp_path: Path) -> None:
    a = _Recorder({"n1": 0.5, "n2": 1.0}, name="a", weight=0.4)
    b = _Recorder({"n1": 1.0}, name="b", weight=0.2)
    engine = SearchEngine([a, b], _ctx(tmp_path))
    hits = engine.search(Query(raw="q"))
    by_id = {h.note_id: h for h in hits}
    # n1: 0.5 * 0.4 + 1.0 * 0.2 = 0.4
    assert abs(by_id["n1"].score - 0.4) < 1e-9
    # n2: 1.0 * 0.4 = 0.4 (only channel a)
    assert abs(by_id["n2"].score - 0.4) < 1e-9
    # Sorted descending — both equal but ordering must be stable list
    assert {h.note_id for h in hits} == {"n1", "n2"}


def test_search_weight_override(tmp_path: Path) -> None:
    ch = _Recorder({"n": 1.0}, name="ch", weight=0.5)
    engine = SearchEngine([ch], _ctx(tmp_path))
    hits = engine.search(Query(raw="q"), weights={"ch": 2.0})
    assert hits[0].score == 2.0


def test_search_unknown_weight_key_ignored(tmp_path: Path) -> None:
    ch = _Recorder({"n": 1.0}, name="ch", weight=0.3)
    engine = SearchEngine([ch], _ctx(tmp_path))
    hits = engine.search(Query(raw="q"), weights={"other": 9.0})
    assert abs(hits[0].score - 0.3) < 1e-9


def test_search_empty_channels_returns_empty(tmp_path: Path) -> None:
    engine = SearchEngine([], _ctx(tmp_path))
    assert engine.search(Query(raw="q")) == []


def test_search_explanations_record_raw_per_channel(tmp_path: Path) -> None:
    a = _Recorder({"n1": 0.5}, name="a", weight=0.4)
    b = _Recorder({"n1": 1.0}, name="b", weight=0.2)
    engine = SearchEngine([a, b], _ctx(tmp_path))
    hits = engine.search(Query(raw="q"))
    assert hits[0].note_id == "n1"
    assert hits[0].explanations == {"a": {"raw": 0.5}, "b": {"raw": 1.0}}


def test_search_explanations_omit_non_matching_channel(tmp_path: Path) -> None:
    a = _Recorder({"n1": 0.5}, name="a", weight=0.4)
    b = _Recorder({"n2": 1.0}, name="b", weight=0.2)
    engine = SearchEngine([a, b], _ctx(tmp_path))
    hits = engine.search(Query(raw="q"))
    by_id = {h.note_id: h for h in hits}
    assert by_id["n1"].explanations == {"a": {"raw": 0.5}}
    assert by_id["n2"].explanations == {"b": {"raw": 1.0}}


def test_search_orders_by_score_desc(tmp_path: Path) -> None:
    ch = _Recorder({"n1": 0.1, "n2": 0.9, "n3": 0.5}, name="r", weight=1.0)
    engine = SearchEngine([ch], _ctx(tmp_path))
    hits = engine.search(Query(raw="q"))
    assert [h.note_id for h in hits] == ["n2", "n3", "n1"]


def test_prepare_called_per_query(tmp_path: Path) -> None:
    ch = _Recorder({}, name="r")
    engine = SearchEngine([ch], _ctx(tmp_path))
    engine.search(Query(raw="q1"))
    engine.search(Query(raw="q2"))
    assert ch.prepare_calls == 2


def test_uses_real_note_objects(tmp_path: Path) -> None:
    """End-to-end with KeywordChannel + FilenameMatchChannel."""
    from ipa_cli.builtins.channels import FilenameMatchChannel, KeywordChannel

    notes = [
        Note(id="alpha", path=tmp_path / "alpha.md", body="apple", frontmatter={}),
        Note(id="beta", path=tmp_path / "beta.md", body="banana", frontmatter={}),
    ]
    ctx = SetupContext(notes=notes, vault_path=tmp_path, cache_dir=tmp_path)
    engine = SearchEngine([KeywordChannel(), FilenameMatchChannel()], ctx)
    hits = engine.search(Query(raw="alpha"))
    assert hits[0].note_id == "alpha"
    assert hits[0].score > 0

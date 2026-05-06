"""Builtin channel tests — KeywordChannel, FilenameMatchChannel."""

from __future__ import annotations

from pathlib import Path

from ipa_cli.api.base_channels import Query, SetupContext
from ipa_cli.api.mappings import Mapping
from ipa_cli.builtins.channels import (
    BodyMatchChannel,
    ChildBodyMatchChannel,
    FilenameMatchChannel,
    KeywordChannel,
)
from ipa_cli.parse.note_model import Note


def _ctx(notes: list[Note], tmp_path: Path) -> SetupContext:
    return SetupContext(notes=notes, vault_path=tmp_path, cache_dir=tmp_path / ".cache")


def _note(nid: str, body: str = "", path: Path | None = None) -> Note:
    return Note(
        id=nid,
        path=path or Path(f"/tmp/{nid}.md"),
        body=body,
        frontmatter={},
    )


# --- KeywordChannel -----------------------------------------------------


def test_keyword_returns_empty_for_blank_query(tmp_path: Path) -> None:
    ch = KeywordChannel()
    assert ch.search(_ctx([_note("a", "x")], tmp_path), Query(raw="   ")) == {}


def test_keyword_matches_id_and_body(tmp_path: Path) -> None:
    ch = KeywordChannel()
    notes = [_note("alpha note", "talks about beta"), _note("c", "irrelevant")]
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="alpha beta"))
    assert scores == {"alpha note": 1.0}


def test_keyword_partial_match_yields_ratio(tmp_path: Path) -> None:
    ch = KeywordChannel()
    notes = [_note("alpha note", "")]
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="alpha gamma"))
    # 1 of 2 tokens matched → 0.5
    assert scores == {"alpha note": 0.5}


def test_keyword_case_insensitive(tmp_path: Path) -> None:
    ch = KeywordChannel()
    notes = [_note("Alpha", "Body")]
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="ALPHA"))
    assert scores == {"Alpha": 1.0}


def test_keyword_skips_zero_match_notes(tmp_path: Path) -> None:
    ch = KeywordChannel()
    notes = [_note("a"), _note("b"), _note("c")]
    assert ch.search(_ctx(notes, tmp_path), Query(raw="zzz")) == {}


# --- FilenameMatchChannel ----------------------------------------------


def test_filename_exact_match(tmp_path: Path) -> None:
    ch = FilenameMatchChannel()
    notes = [_note("Alpha"), _note("Beta")]
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="Alpha"))
    assert scores == {"Alpha": 1.0}


def test_filename_case_insensitive(tmp_path: Path) -> None:
    ch = FilenameMatchChannel()
    notes = [_note("Alpha")]
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="alpha"))
    assert scores == {"Alpha": 1.0}


def test_filename_substring_match(tmp_path: Path) -> None:
    ch = FilenameMatchChannel()
    notes = [_note("My Alpha Note")]
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="alpha"))
    assert scores == {"My Alpha Note": 1.0}


def test_filename_no_space_match(tmp_path: Path) -> None:
    ch = FilenameMatchChannel()
    notes = [_note("Alpha Beta Gamma")]
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="alphabeta"))
    assert scores == {"Alpha Beta Gamma": 1.0}


def test_filename_strips_emoji_prefix(tmp_path: Path) -> None:
    ch = FilenameMatchChannel()
    notes = [_note("🔖 ipa-cli")]
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="ipa-cli"))
    assert scores == {"🔖 ipa-cli": 1.0}


def test_filename_no_match_returns_empty(tmp_path: Path) -> None:
    ch = FilenameMatchChannel()
    notes = [_note("Alpha")]
    assert ch.search(_ctx(notes, tmp_path), Query(raw="zzz")) == {}


def test_filename_empty_query_returns_empty(tmp_path: Path) -> None:
    ch = FilenameMatchChannel()
    notes = [_note("Alpha")]
    assert ch.search(_ctx(notes, tmp_path), Query(raw="")) == {}


# --- BodyMatchChannel ---------------------------------------------------


def _disk_note(tmp_path: Path, nid: str, body: str, **fm) -> Note:
    p = tmp_path / f"{nid}.md"
    p.write_text(body, encoding="utf-8")
    return Note(id=nid, path=p, body=body, frontmatter=dict(fm))


def test_body_match_returns_max_normalized_scores(tmp_path: Path) -> None:
    ch = BodyMatchChannel()
    cache = tmp_path / ".cache"
    notes = [
        _disk_note(tmp_path, "alpha", "커피 원두 노트"),
        _disk_note(tmp_path, "beta", "관계 없는 본문"),
    ]
    ctx = SetupContext(notes=notes, vault_path=tmp_path, cache_dir=cache)
    scores = ch.search(ctx, Query(raw="커피"))
    # Only the matching doc should appear, normalized to 1.0 (it's the
    # max raw).
    assert "alpha" in scores
    assert scores["alpha"] == 1.0
    assert "beta" not in scores


def test_body_match_empty_query_returns_empty(tmp_path: Path) -> None:
    ch = BodyMatchChannel()
    cache = tmp_path / ".cache"
    notes = [_disk_note(tmp_path, "alpha", "본문")]
    ctx = SetupContext(notes=notes, vault_path=tmp_path, cache_dir=cache)
    assert ch.search(ctx, Query(raw="")) == {}


def test_body_match_no_match_returns_empty(tmp_path: Path) -> None:
    ch = BodyMatchChannel()
    cache = tmp_path / ".cache"
    notes = [_disk_note(tmp_path, "alpha", "본문 가나다")]
    ctx = SetupContext(notes=notes, vault_path=tmp_path, cache_dir=cache)
    assert ch.search(ctx, Query(raw="존재하지않는단어")) == {}


# --- ChildBodyMatchChannel ---------------------------------------------


def test_child_body_propagates_to_index_parent(tmp_path: Path) -> None:
    ch = ChildBodyMatchChannel()
    cache = tmp_path / ".cache"
    parent = _disk_note(tmp_path, "🔖 커피", "", type="index")
    child = _disk_note(
        tmp_path,
        "원두 노트",
        "원두 산미 강배전 약배전",
        type="note",
        ref=["[[🔖 커피]]"],
    )
    notes = [parent, child]
    ctx = SetupContext(
        notes=notes, vault_path=tmp_path, cache_dir=cache, mapping=Mapping()
    )
    scores = ch.search(ctx, Query(raw="원두"))
    # Parent inherits the child's match (normalized).
    assert "🔖 커피" in scores
    assert scores["🔖 커피"] > 0.0


def test_child_body_skips_non_index_parent(tmp_path: Path) -> None:
    ch = ChildBodyMatchChannel()
    cache = tmp_path / ".cache"
    parent = _disk_note(tmp_path, "non-index parent", "", type="note")
    child = _disk_note(
        tmp_path, "child", "단어 본문 매칭", type="note", ref=["[[non-index parent]]"]
    )
    notes = [parent, child]
    ctx = SetupContext(
        notes=notes, vault_path=tmp_path, cache_dir=cache, mapping=Mapping()
    )
    scores = ch.search(ctx, Query(raw="단어"))
    assert "non-index parent" not in scores


def test_child_body_uses_mapping_keys(tmp_path: Path) -> None:
    ch = ChildBodyMatchChannel()
    cache = tmp_path / ".cache"
    parent = _disk_note(tmp_path, "🔖 토픽", "", kind="index")
    child = _disk_note(
        tmp_path, "메모", "고유 단어 본문", kind="note", parents=["[[🔖 토픽]]"]
    )
    m = Mapping(note_type="kind", refs="parents")
    ctx = SetupContext(
        notes=[parent, child], vault_path=tmp_path, cache_dir=cache, mapping=m
    )
    scores = ch.search(ctx, Query(raw="고유"))
    assert "🔖 토픽" in scores


def test_child_body_empty_query_returns_empty(tmp_path: Path) -> None:
    ch = ChildBodyMatchChannel()
    cache = tmp_path / ".cache"
    notes = [_disk_note(tmp_path, "x", "x", type="note")]
    ctx = SetupContext(notes=notes, vault_path=tmp_path, cache_dir=cache)
    assert ch.search(ctx, Query(raw="")) == {}


def test_child_body_no_index_returns_empty(tmp_path: Path) -> None:
    ch = ChildBodyMatchChannel()
    cache = tmp_path / ".cache"
    notes = [_disk_note(tmp_path, "n1", "본문", type="note")]
    ctx = SetupContext(
        notes=notes, vault_path=tmp_path, cache_dir=cache, mapping=Mapping()
    )
    assert ch.search(ctx, Query(raw="본문")) == {}

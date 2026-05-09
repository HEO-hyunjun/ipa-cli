"""Builtin channel tests — KeywordChannel, FilenameMatchChannel."""

from __future__ import annotations

from pathlib import Path

from ipa_cli.api.base_channels import Query, SetupContext
from ipa_cli.api.mappings import Mapping
from ipa_cli.builtins.channels import (
    BodyMatchChannel,
    ChildBodyMatchChannel,
    FilenameMatchChannel,
    FilenamePartialChannel,
    FuzzyChannel,
    KeywordChannel,
    ProjectChannel,
    RelatedChannel,
    SequenceMatchChannel,
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


def test_keyword_matches_aliases(tmp_path: Path) -> None:
    ch = KeywordChannel()
    notes = [
        Note(
            id="코드·구현 노트 작성 지침",
            path=Path("/tmp/guide.md"),
            body="",
            frontmatter={"aliases": ["구현 결과 노트 작성"]},
        )
    ]
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="구현 결과"))
    assert scores == {"코드·구현 노트 작성 지침": 1.0}


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


def test_filename_matches_alias_substring(tmp_path: Path) -> None:
    ch = FilenameMatchChannel()
    notes = [
        Note(
            id="코드·구현 노트 작성 지침",
            path=Path("/tmp/guide.md"),
            body="",
            frontmatter={"aliases": ["구현 결과 노트 작성"]},
        )
    ]
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="구현 결과"))
    assert scores == {"코드·구현 노트 작성 지침": 1.0}


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


# --- FuzzyChannel ------------------------------------------------------


def test_fuzzy_skips_exact_grade_matches(tmp_path: Path) -> None:
    """FilenameMatchChannel owns substring/exact — fuzzy stays out."""
    ch = FuzzyChannel()
    notes = [_note("커피")]
    assert ch.search(_ctx(notes, tmp_path), Query(raw="커피")) == {}


def test_fuzzy_jamo_overlap_grades_partial_match(tmp_path: Path) -> None:
    ch = FuzzyChannel()
    notes = [_note("커피 노트")]
    # query "카피" overlaps trigrams with "커피 노트" but isn't substring.
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="카피"))
    if scores:
        assert 0.4 <= scores["커피 노트"] <= 1.0


def test_fuzzy_no_match_returns_empty(tmp_path: Path) -> None:
    ch = FuzzyChannel()
    notes = [_note("완전히 다른 노트")]
    assert ch.search(_ctx(notes, tmp_path), Query(raw="zzz")) == {}


def test_fuzzy_latin_uses_sequencematcher_fallback(tmp_path: Path) -> None:
    ch = FuzzyChannel()
    notes = [_note("collection")]
    # Latin query — q_tri is empty, fallback path activates.
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="colection"))
    assert "collection" in scores
    assert scores["collection"] >= 0.55


def test_fuzzy_empty_query_returns_empty(tmp_path: Path) -> None:
    ch = FuzzyChannel()
    notes = [_note("커피")]
    assert ch.search(_ctx(notes, tmp_path), Query(raw="")) == {}


# --- SequenceMatchChannel ----------------------------------------------


def test_sequence_match_all_tokens_in_id(tmp_path: Path) -> None:
    ch = SequenceMatchChannel()
    notes = [_note("RAG Agent Notes")]
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="agent rag"))
    assert scores == {"RAG Agent Notes": 1.0}


def test_sequence_match_partial_does_not_score(tmp_path: Path) -> None:
    ch = SequenceMatchChannel()
    notes = [_note("RAG Notes")]
    assert ch.search(_ctx(notes, tmp_path), Query(raw="rag agent")) == {}


def test_sequence_match_strips_emoji(tmp_path: Path) -> None:
    ch = SequenceMatchChannel()
    notes = [_note("🔖 IPA CLI")]
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="ipa cli"))
    assert scores == {"🔖 IPA CLI": 1.0}


def test_sequence_match_empty_query_returns_empty(tmp_path: Path) -> None:
    ch = SequenceMatchChannel()
    notes = [_note("anything")]
    assert ch.search(_ctx(notes, tmp_path), Query(raw="")) == {}


def test_sequence_match_uses_aliases(tmp_path: Path) -> None:
    ch = SequenceMatchChannel()
    notes = [
        Note(
            id="코드·구현 노트 작성 지침",
            path=Path("/tmp/guide.md"),
            body="",
            frontmatter={"aliases": ["구현 결과 노트 작성"]},
        )
    ]
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="구현 결과"))
    assert scores == {"코드·구현 노트 작성 지침": 1.0}


# --- FilenamePartialChannel --------------------------------------------


def test_filename_partial_emits_ratio_when_some_tokens_hit(tmp_path: Path) -> None:
    ch = FilenamePartialChannel()
    notes = [_note("RAG Notes")]
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="rag agent"))
    # 1 of 2 tokens → 0.5
    assert scores == {"RAG Notes": 0.5}


def test_filename_partial_skips_full_match(tmp_path: Path) -> None:
    """Full match is owned by SequenceMatchChannel."""
    ch = FilenamePartialChannel()
    notes = [_note("RAG Agent Notes")]
    assert ch.search(_ctx(notes, tmp_path), Query(raw="agent rag")) == {}


def test_filename_partial_skips_zero_match(tmp_path: Path) -> None:
    ch = FilenamePartialChannel()
    notes = [_note("RAG Notes")]
    assert ch.search(_ctx(notes, tmp_path), Query(raw="zzz qqq")) == {}


def test_filename_partial_skips_single_token_query(tmp_path: Path) -> None:
    """Substring matching is FilenameMatchChannel's job."""
    ch = FilenamePartialChannel()
    notes = [_note("RAG Notes")]
    assert ch.search(_ctx(notes, tmp_path), Query(raw="rag")) == {}


def test_filename_partial_uses_aliases(tmp_path: Path) -> None:
    ch = FilenamePartialChannel()
    notes = [
        Note(
            id="코드·구현 노트 작성 지침",
            path=Path("/tmp/guide.md"),
            body="",
            frontmatter={"aliases": ["구현 결과 노트 작성"]},
        )
    ]
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="결과 문서"))
    assert scores == {"코드·구현 노트 작성 지침": 0.5}


# --- RelatedChannel ----------------------------------------------------


def test_related_returns_empty_without_seed(tmp_path: Path) -> None:
    ch = RelatedChannel()
    notes = [
        _note("alpha", body="see [[beta]]"),
        _note("beta"),
    ]
    assert ch.search(_ctx(notes, tmp_path), Query(raw="ghost")) == {}


def test_related_propagates_via_common_refs(tmp_path: Path) -> None:
    ch = RelatedChannel()
    seed = Note(
        id="seed",
        path=Path("/tmp/seed.md"),
        body="",
        frontmatter={"ref": ["[[shared]]"]},
    )
    other = Note(
        id="other",
        path=Path("/tmp/other.md"),
        body="",
        frontmatter={"ref": ["[[shared]]"]},
    )
    notes = [seed, other]
    scores = ch.search(_ctx(notes, tmp_path), Query(raw="seed"))
    assert "other" in scores
    assert scores["other"] == 1.0  # max-normalized


def test_related_propagates_via_wikilink(tmp_path: Path) -> None:
    ch = RelatedChannel()
    seed = Note(
        id="seed",
        path=Path("/tmp/seed.md"),
        body="see [[neighbor]]",
        frontmatter={},
    )
    neighbor = Note(
        id="neighbor", path=Path("/tmp/neighbor.md"), body="", frontmatter={}
    )
    scores = ch.search(_ctx([seed, neighbor], tmp_path), Query(raw="seed"))
    assert "neighbor" in scores


def test_related_propagates_via_common_tags(tmp_path: Path) -> None:
    ch = RelatedChannel()
    seed = Note(
        id="seed",
        path=Path("/tmp/seed.md"),
        body="",
        frontmatter={"tags": ["ai", "ml"]},
    )
    other = Note(
        id="other",
        path=Path("/tmp/other.md"),
        body="",
        frontmatter={"tags": ["ai"]},
    )
    scores = ch.search(_ctx([seed, other], tmp_path), Query(raw="seed"))
    assert "other" in scores


def test_related_excludes_seed_itself(tmp_path: Path) -> None:
    ch = RelatedChannel()
    seed = Note(
        id="seed",
        path=Path("/tmp/seed.md"),
        body="",
        frontmatter={"ref": ["[[X]]"]},
    )
    scores = ch.search(_ctx([seed], tmp_path), Query(raw="seed"))
    assert "seed" not in scores


# --- ProjectChannel ----------------------------------------------------


def test_project_scores_notes_under_project_dir(tmp_path: Path) -> None:
    ch = ProjectChannel()
    project = tmp_path / "01 Project"
    project.mkdir()
    project_note = Note(
        id="proj",
        path=project / "proj.md",
        body="",
        frontmatter={},
    )
    inbox_note = Note(
        id="inbox", path=tmp_path / "00 Inbox" / "x.md", body="", frontmatter={}
    )
    ctx = SetupContext(
        notes=[project_note, inbox_note],
        vault_path=tmp_path,
        cache_dir=tmp_path,
        mapping=Mapping(),
    )
    scores = ch.search(ctx, Query(raw="anything"))
    assert scores == {"proj": 1.0}


def test_project_scores_notes_referencing_project(tmp_path: Path) -> None:
    ch = ProjectChannel()
    project = tmp_path / "01 Project"
    project.mkdir()
    target = Note(
        id="🏷️ Target Root",
        path=project / "🏷️ Target Root.md",
        body="",
        frontmatter={},
    )
    referencer = Note(
        id="ref-er",
        path=tmp_path / "00 Inbox" / "ref-er.md",
        body="",
        frontmatter={"ref": ["[[🏷️ Target Root]]"]},
    )
    ctx = SetupContext(
        notes=[target, referencer],
        vault_path=tmp_path,
        cache_dir=tmp_path,
        mapping=Mapping(),
    )
    scores = ch.search(ctx, Query(raw="anything"))
    assert "ref-er" in scores
    assert "🏷️ Target Root" in scores


def test_project_returns_empty_when_no_project_dir(tmp_path: Path) -> None:
    ch = ProjectChannel()
    note = Note(id="x", path=tmp_path / "x.md", body="", frontmatter={})
    ctx = SetupContext(
        notes=[note],
        vault_path=tmp_path,
        cache_dir=tmp_path,
        mapping=Mapping(project_dir=""),
    )
    assert ch.search(ctx, Query(raw="anything")) == {}

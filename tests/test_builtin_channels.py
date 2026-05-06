"""Builtin channel tests — KeywordChannel, FilenameMatchChannel."""

from __future__ import annotations

from pathlib import Path

from ipa_cli.api.base_channels import Query, SetupContext
from ipa_cli.builtins.channels import FilenameMatchChannel, KeywordChannel
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

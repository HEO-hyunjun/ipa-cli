"""BM25 + jamo trigram tests."""

from __future__ import annotations

import pickle
from pathlib import Path

from ipa_cli.parse.bm25 import (
    CACHE_FILENAME,
    CACHE_VERSION,
    BM25Index,
    build_bm25,
    jamo_trigrams,
)
from ipa_cli.parse.note_model import Note


# --- jamo_trigrams ------------------------------------------------------


def test_jamo_trigrams_empty_string() -> None:
    assert jamo_trigrams("") == []


def test_jamo_trigrams_too_short() -> None:
    # 1 hangul syllable decomposes into 2-3 jamo; "가" → "ㄱㅏ" (2 chars).
    # NFD len < 3 means no trigram.
    assert jamo_trigrams("가") == []


def test_jamo_trigrams_korean_basic() -> None:
    grams = jamo_trigrams("커피")
    # "커피" → NFD: "ㅋㅓㅍㅣ" (4 chars) → 2 trigrams
    assert len(grams) == 2
    assert all(len(g) == 3 for g in grams)


def test_jamo_trigrams_lowercases_ascii() -> None:
    upper = jamo_trigrams("ABCD")
    lower = jamo_trigrams("abcd")
    assert upper == lower


# --- BM25Index ----------------------------------------------------------


def test_bm25_build_and_score_simple() -> None:
    idx = BM25Index()
    idx.build(
        [
            ("a", ["aaa", "bbb", "ccc"]),
            ("b", ["aaa", "ddd"]),
            ("c", ["xxx"]),
        ]
    )
    assert idx.n_docs == 3
    assert idx.doc_ids == ["a", "b", "c"]
    scores = idx.score_all(["aaa"])
    assert scores[0] > 0.0
    assert scores[1] > 0.0
    assert scores[2] == 0.0


def test_bm25_score_unknown_token_returns_zero() -> None:
    idx = BM25Index()
    idx.build([("a", ["aaa"])])
    assert idx.score(["zzz"], 0) == 0.0


def test_bm25_score_oob_doc_idx() -> None:
    idx = BM25Index()
    idx.build([("a", ["aaa"])])
    assert idx.score(["aaa"], 999) == 0.0


def test_bm25_update_doc_swaps_terms() -> None:
    idx = BM25Index()
    idx.build([("a", ["aaa", "bbb"]), ("b", ["aaa"])])
    idx.update_doc(0, ["ccc"])
    # a: aaa→ccc; bbb removed entirely from doc_freq; ccc new term.
    assert idx.score(["aaa"], 0) == 0.0
    assert idx.score(["ccc"], 0) > 0.0


# --- build_bm25 ---------------------------------------------------------


def _make_note(tmp_path: Path, name: str, body: str) -> Note:
    p = tmp_path / f"{name}.md"
    p.write_text(body, encoding="utf-8")
    return Note(id=name, path=p, body=body, frontmatter={})


def test_build_bm25_no_cache_dir_skips_persistence(tmp_path: Path) -> None:
    notes = [_make_note(tmp_path, "alpha", "aaa bbb")]
    artifact = build_bm25(notes, cache_dir=None)
    assert artifact.index.n_docs == 1
    assert artifact.doc_id_to_idx == {"alpha": 0}


def test_build_bm25_writes_and_reuses_cache(tmp_path: Path) -> None:
    cache_dir = tmp_path / ".cache"
    notes = [
        _make_note(tmp_path, "alpha", "aaaaaa"),
        _make_note(tmp_path, "beta", "bbbbbb"),
    ]
    artifact1 = build_bm25(notes, cache_dir=cache_dir)
    cache_path = cache_dir / CACHE_FILENAME
    assert cache_path.exists()

    with open(cache_path, "rb") as f:
        payload = pickle.load(f)
    assert payload["version"] == CACHE_VERSION
    assert payload["doc_ids"] == ["alpha", "beta"]

    # Second build with no changes should reuse cache (same n_docs etc).
    artifact2 = build_bm25(notes, cache_dir=cache_dir)
    assert artifact2.index.doc_ids == artifact1.index.doc_ids


def test_build_bm25_force_rebuild_ignores_cache(tmp_path: Path) -> None:
    cache_dir = tmp_path / ".cache"
    notes = [_make_note(tmp_path, "a", "xxx")]
    build_bm25(notes, cache_dir=cache_dir)

    notes2 = [_make_note(tmp_path, "a", "yyy")]
    artifact = build_bm25(notes2, cache_dir=cache_dir, force_rebuild=True)
    # Force rebuild reflects the new body — score for the new content
    # should be non-zero against new tokens.
    grams = jamo_trigrams("yyy")
    assert artifact.index.score(grams, 0) > 0.0


def test_build_bm25_invalidates_on_id_set_change(tmp_path: Path) -> None:
    cache_dir = tmp_path / ".cache"
    notes = [_make_note(tmp_path, "a", "aaa")]
    build_bm25(notes, cache_dir=cache_dir)

    notes2 = [_make_note(tmp_path, "b", "bbb")]  # different id set
    artifact = build_bm25(notes2, cache_dir=cache_dir)
    assert artifact.index.doc_ids == ["b"]

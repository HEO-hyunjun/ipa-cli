"""BM25-trigram body match index.

Lifted from 1차 ``core/bm25_index.py`` with two contract changes:

- The artifact is keyed by ``Note.id`` (NFC-normalized stem) rather than
  1차's ``filename`` so 2차 channels can speak ``Note`` natively.
- Cache directory is passed in by the caller (usually
  ``SetupContext.cache_dir``) instead of reaching into ``~/.cache``.
  ``cache_dir=None`` skips persistence entirely (useful in tests).

Algorithm: tokenize each note as Korean jamo NFD trigrams of
(id + body), build a standard BM25 model, score queries by the same
tokenization. The trigram approach is robust against Korean morphology
where space-tokenization fragments compounds and dropping the final
consonant changes the surface form.

The cache schema is intentionally fresh (version 1) for 2차 — a 1차
cache cannot satisfy 2차 because the keys differ.
"""

from __future__ import annotations

import math
import pickle
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ipa_cli.parse.note_model import Note

CACHE_VERSION = 1
INCREMENTAL_THRESHOLD = 30
CACHE_FILENAME = "bm25_index.pkl"


def jamo_trigrams(text: str) -> list[str]:
    """NFD-decompose lowercase text and slide a length-3 window over it."""
    if not text:
        return []
    decomposed = unicodedata.normalize("NFD", text.lower())
    if len(decomposed) < 3:
        return []
    return [decomposed[i : i + 3] for i in range(len(decomposed) - 2)]


class BM25Index:
    """Sparse BM25 over integer-coded trigrams.

    ``term_to_idx`` maps trigram strings to dense ints so per-doc TFs are
    stored as ``dict[int, int]`` instead of dict-of-strings.
    """

    def __init__(self, k1: float = 1.5, b: float = 0.75) -> None:
        self.k1 = k1
        self.b = b
        self.term_to_idx: dict[str, int] = {}
        self.doc_freq: dict[int, int] = {}
        self.doc_len: list[int] = []
        self.doc_tf: list[dict[int, int]] = []
        self.avgdl: float = 0.0
        self.n_docs: int = 0
        self.idf: dict[int, float] = {}
        self.doc_ids: list[str] = []

    def build(self, corpus: list[tuple[str, list[str]]]) -> None:
        """``corpus`` = list of ``(doc_id, tokens)`` pairs."""
        self.doc_ids = [doc_id for doc_id, _ in corpus]
        tok_lists = [toks for _, toks in corpus]
        self.n_docs = len(tok_lists)
        self.doc_len = [len(toks) for toks in tok_lists]
        self.avgdl = sum(self.doc_len) / max(self.n_docs, 1)

        term_to_idx: dict[str, int] = {}
        for toks in tok_lists:
            for t in toks:
                if t not in term_to_idx:
                    term_to_idx[t] = len(term_to_idx)
        self.term_to_idx = term_to_idx

        doc_tf: list[dict[int, int]] = []
        for toks in tok_lists:
            tf: dict[int, int] = {}
            for t in toks:
                idx = term_to_idx[t]
                tf[idx] = tf.get(idx, 0) + 1
            doc_tf.append(tf)
        self.doc_tf = doc_tf

        df: dict[int, int] = {}
        for tf in doc_tf:
            for idx in tf:
                df[idx] = df.get(idx, 0) + 1
        self.doc_freq = df
        self.idf = {
            idx: math.log(1 + (self.n_docs - cnt + 0.5) / (cnt + 0.5))
            for idx, cnt in df.items()
        }

    def update_doc(self, doc_idx: int, new_tokens: list[str]) -> None:
        """In-place replace the doc at ``doc_idx`` with ``new_tokens``."""
        old_tf = self.doc_tf[doc_idx]
        old_term_idxs = set(old_tf.keys())
        for ti in old_term_idxs:
            self.doc_freq[ti] -= 1
            if self.doc_freq[ti] == 0:
                del self.doc_freq[ti]

        new_tf: dict[int, int] = {}
        for t in new_tokens:
            ti = self.term_to_idx.get(t)
            if ti is None:
                ti = len(self.term_to_idx)
                self.term_to_idx[t] = ti
            new_tf[ti] = new_tf.get(ti, 0) + 1

        for ti in new_tf:
            self.doc_freq[ti] = self.doc_freq.get(ti, 0) + 1

        self.doc_tf[doc_idx] = new_tf
        self.doc_len[doc_idx] = len(new_tokens)
        self.avgdl = sum(self.doc_len) / max(self.n_docs, 1)

        affected = old_term_idxs | set(new_tf.keys())
        for ti in affected:
            df = self.doc_freq.get(ti, 0)
            if df > 0:
                self.idf[ti] = math.log(1 + (self.n_docs - df + 0.5) / (df + 0.5))
            else:
                self.idf.pop(ti, None)

    def score(self, query_tokens: list[str], doc_idx: int) -> float:
        if doc_idx >= len(self.doc_tf):
            return 0.0
        tf = self.doc_tf[doc_idx]
        dl = self.doc_len[doc_idx]
        score = 0.0
        for q in query_tokens:
            q_idx = self.term_to_idx.get(q)
            if q_idx is None:
                continue
            f = tf.get(q_idx)
            if f is None:
                continue
            idf = self.idf.get(q_idx, 0.0)
            denom = f + self.k1 * (1 - self.b + self.b * dl / max(self.avgdl, 1))
            score += idf * f * (self.k1 + 1) / max(denom, 1e-9)
        return score

    def score_all(self, query_tokens: list[str]) -> list[float]:
        return [self.score(query_tokens, i) for i in range(self.n_docs)]


@dataclass
class BM25Artifact:
    """A built index plus the doc_id → row index map channels need."""

    index: BM25Index
    doc_id_to_idx: dict[str, int] = field(default_factory=dict)


def _note_text(note: "Note") -> str:
    return (note.id + "\n" + note.body) if note.body else note.id


def _payload(idx: BM25Index, mtimes: dict[str, float]) -> dict:
    return {
        "version": CACHE_VERSION,
        "last_built_at": time.time(),
        "n_docs": idx.n_docs,
        "k1": idx.k1,
        "b": idx.b,
        "term_to_idx": idx.term_to_idx,
        "doc_freq": idx.doc_freq,
        "doc_len": idx.doc_len,
        "doc_tf": idx.doc_tf,
        "avgdl": idx.avgdl,
        "idf": idx.idf,
        "doc_ids": idx.doc_ids,
        "mtimes": mtimes,
    }


def _from_payload(cached: dict) -> BM25Index:
    idx = BM25Index(k1=cached["k1"], b=cached["b"])
    idx.term_to_idx = cached["term_to_idx"]
    idx.doc_freq = cached["doc_freq"]
    idx.doc_len = cached["doc_len"]
    idx.doc_tf = cached["doc_tf"]
    idx.avgdl = cached["avgdl"]
    idx.n_docs = cached["n_docs"]
    idx.idf = cached["idf"]
    idx.doc_ids = cached["doc_ids"]
    return idx


def _save(cache_path: Path, idx: BM25Index, mtimes: dict[str, float]) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(cache_path, "wb") as f:
            pickle.dump(_payload(idx, mtimes), f, protocol=pickle.HIGHEST_PROTOCOL)
    except OSError:
        pass


def _current_mtimes(notes: list["Note"]) -> dict[str, float]:
    out: dict[str, float] = {}
    for n in notes:
        try:
            out[n.id] = n.path.stat().st_mtime
        except OSError:
            out[n.id] = 0.0
    return out


def build_bm25(
    notes: list["Note"],
    cache_dir: Path | None = None,
    *,
    force_rebuild: bool = False,
    save_to_disk: bool = True,
) -> BM25Artifact:
    """Build (or load) a BM25 artifact for ``notes``.

    Cache behavior matches 1차: same id set + no mtime drift → reuse;
    same id set + ≤30 modifications → in-place update; otherwise full
    rebuild. ``cache_dir=None`` skips persistence (callers under test).
    """
    cache_path = cache_dir / CACHE_FILENAME if cache_dir is not None else None
    current = _current_mtimes(notes)

    if not force_rebuild and cache_path is not None and cache_path.exists():
        try:
            with open(cache_path, "rb") as f:
                cached = pickle.load(f)
            if cached.get("version") == CACHE_VERSION:
                cached_mtimes: dict[str, float] = cached.get("mtimes", {})
                if current.keys() == cached_mtimes.keys():
                    modified = [
                        nid for nid in current if current[nid] > cached_mtimes[nid]
                    ]
                    if not modified:
                        idx = _from_payload(cached)
                        return BM25Artifact(
                            index=idx,
                            doc_id_to_idx={nid: i for i, nid in enumerate(idx.doc_ids)},
                        )
                    if len(modified) <= INCREMENTAL_THRESHOLD:
                        idx = _from_payload(cached)
                        notes_by_id = {n.id: n for n in notes}
                        id_to_idx = {nid: i for i, nid in enumerate(idx.doc_ids)}
                        for nid in modified:
                            note = notes_by_id[nid]
                            idx.update_doc(
                                id_to_idx[nid], jamo_trigrams(_note_text(note))
                            )
                        if save_to_disk and cache_path is not None:
                            _save(cache_path, idx, current)
                        return BM25Artifact(index=idx, doc_id_to_idx=id_to_idx)
        except (pickle.PickleError, KeyError, EOFError):
            pass

    corpus: list[tuple[str, list[str]]] = [
        (n.id, jamo_trigrams(_note_text(n))) for n in notes
    ]
    idx = BM25Index()
    idx.build(corpus)

    if save_to_disk and cache_path is not None:
        _save(cache_path, idx, current)

    return BM25Artifact(
        index=idx, doc_id_to_idx={nid: i for i, nid in enumerate(idx.doc_ids)}
    )

"""BM25-trigram 인덱스 — 자모 NFD trigram + BM25 ranking + incremental 캐싱

[[vault_search 원칙 A 단독 설계]]의 body_match 채널 구현.
호출자: vault_search.py (P1 단계 도입).

캐시:
  ~/.cache/vault_search/bm25_index.pkl
  v3: per-doc mtime으로 dirty 판단 → modified만 in-place update
  add/remove 발생 시 또는 dirty 임계 초과 시 full rebuild
"""

from __future__ import annotations

import math
import os
import pickle
import time
import unicodedata
from pathlib import Path

CACHE_VERSION = 3  # v3: incremental update + per-doc mtime
INCREMENTAL_THRESHOLD = 30


def _cache_dir() -> Path:
    if env := os.environ.get("IPA_CACHE_DIR"):
        return Path(env)
    return Path.home() / ".cache" / "vault_search"


def _cache_file() -> Path:
    return _cache_dir() / "bm25_index.pkl"


def jamo_trigrams(text: str) -> list[str]:
    """자모 NFD 분해 후 character trigram 리스트 (sliding, 길이 3)."""
    if not text:
        return []
    decomposed = unicodedata.normalize("NFD", text.lower())
    if len(decomposed) < 3:
        return []
    return [decomposed[i : i + 3] for i in range(len(decomposed) - 2)]


class BM25Index:
    """trigram → 글로벌 정수 idx 매핑(term_to_idx)으로 doc_tf를 sparse하게 보관.

    v2부터 doc_tf/doc_freq/idf의 키가 trigram 문자열이 아닌 int idx.
    v3부터 update_doc()로 단일 doc만 in-place 갱신 가능.
    """

    def __init__(self, k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self.term_to_idx: dict[str, int] = {}
        self.doc_freq: dict[int, int] = {}
        self.doc_len: list[int] = []
        self.doc_tf: list[dict[int, int]] = []
        self.avgdl: float = 0.0
        self.n_docs: int = 0
        self.idf: dict[int, float] = {}
        self.doc_filenames: list[str] = []

    def build(self, corpus: list[tuple[str, list[str]]]) -> None:
        """corpus: [(filename, tokens), ...]"""
        self.doc_filenames = [name for name, _ in corpus]
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
        """기존 doc_idx 위치를 new_tokens로 in-place 교체.

        - doc_freq를 old/new term 기여 ±1로 부분 갱신
        - term_to_idx에 신규 term만 append (제거는 안 함, 누적)
        - idf는 영향받은 term만 재계산
        - doc_len, avgdl 갱신
        """
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

        new_term_idxs = set(new_tf.keys())
        for ti in new_term_idxs:
            self.doc_freq[ti] = self.doc_freq.get(ti, 0) + 1

        self.doc_tf[doc_idx] = new_tf
        self.doc_len[doc_idx] = len(new_tokens)
        self.avgdl = sum(self.doc_len) / max(self.n_docs, 1)

        affected = old_term_idxs | new_term_idxs
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


def _payload_from_idx(idx: BM25Index, note_mtimes: dict[str, float]) -> dict:
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
        "doc_filenames": idx.doc_filenames,
        "note_mtimes": note_mtimes,
    }


def _idx_from_cached(cached: dict) -> BM25Index:
    idx = BM25Index(k1=cached["k1"], b=cached["b"])
    idx.term_to_idx = cached["term_to_idx"]
    idx.doc_freq = cached["doc_freq"]
    idx.doc_len = cached["doc_len"]
    idx.doc_tf = cached["doc_tf"]
    idx.avgdl = cached["avgdl"]
    idx.n_docs = cached["n_docs"]
    idx.idf = cached["idf"]
    idx.doc_filenames = cached["doc_filenames"]
    return idx


def _save(idx: BM25Index, note_mtimes: dict[str, float]) -> None:
    _cache_dir().mkdir(parents=True, exist_ok=True)
    try:
        with open(_cache_file(), "wb") as f:
            pickle.dump(
                _payload_from_idx(idx, note_mtimes), f, protocol=pickle.HIGHEST_PROTOCOL
            )
    except OSError:
        pass


def build_or_load(
    notes, force_rebuild: bool = False, save_to_disk: bool = True
) -> BM25Index:
    """vault notes로 BM25Index 빌드 또는 incremental 로드.

    notes: list[VaultNote] (vault_parser.scan_vault 결과)
    캐시 검증: per-doc mtime + filename set 비교.
      - 변동 0 → 캐시 그대로
      - filename 동일 + modified ≤ THRESHOLD → in-place update
      - filename set 변동 또는 modified > THRESHOLD → full rebuild
    save_to_disk=False: 빌드만 하고 디스크 저장 안 함 (eval/run에서 사용)
    """
    current_mtimes = {n.filename: n.path.stat().st_mtime for n in notes}

    if not force_rebuild and _cache_file().exists():
        try:
            with open(_cache_file(), "rb") as f:
                cached = pickle.load(f)
            if cached.get("version") == CACHE_VERSION:
                cached_mtimes: dict[str, float] = cached.get("note_mtimes", {})
                cur_keys = current_mtimes.keys()
                cached_keys = cached_mtimes.keys()
                if cur_keys == cached_keys:
                    modified = [
                        fn for fn in cur_keys if current_mtimes[fn] > cached_mtimes[fn]
                    ]
                    if not modified:
                        return _idx_from_cached(cached)
                    if len(modified) <= INCREMENTAL_THRESHOLD:
                        idx = _idx_from_cached(cached)
                        notes_by_fn = {n.filename: n for n in notes}
                        fn_to_idx = {fn: i for i, fn in enumerate(idx.doc_filenames)}
                        for fn in modified:
                            note = notes_by_fn[fn]
                            text = (
                                (note.filename + "\n" + note.body)
                                if note.body
                                else note.filename
                            )
                            new_tokens = jamo_trigrams(text)
                            idx.update_doc(fn_to_idx[fn], new_tokens)
                        if save_to_disk:
                            _save(idx, current_mtimes)
                        return idx
                # filename 변동 또는 임계 초과 → fall through to full rebuild
        except (pickle.PickleError, KeyError, EOFError):
            pass

    # full rebuild
    corpus: list[tuple[str, list[str]]] = []
    for n in notes:
        text = (n.filename + "\n" + n.body) if n.body else n.filename
        corpus.append((n.filename, jamo_trigrams(text)))

    idx = BM25Index()
    idx.build(corpus)

    if save_to_disk:
        _save(idx, current_mtimes)

    return idx

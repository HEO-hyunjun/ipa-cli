#!/usr/bin/env python3
"""Vault Search: 태그/키워드/backlink/관련노트 검색 + 구조화된 뷰.

Usage:
    # 통합 검색 (멀티 쿼리)
    python3 vault_search.py --search "Agent" --search "RAG"
    python3 vault_search.py --search "def\\s+process"  # 정규식도 자동 감지

    # view 모드 (overview / section / full)
    python3 vault_search.py --view "노트명"
    python3 vault_search.py --view "노트명" --section "헤더명"
    python3 vault_search.py --view "노트명" --full

    # 개별 검색
    python3 vault_search.py --tag "AI/Agent"
    python3 vault_search.py --keyword "Agent"
    python3 vault_search.py --backlinks "🔖 AI Agent"
    python3 vault_search.py --related "Colombia" [--max 10]
    python3 vault_search.py --fuzzy "AI Agent"
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

from .bm25_index import BM25Index, build_or_load, jamo_trigrams
from .notes_cache import scan_vault_cached
from .vault_parser import (
    DEFAULT_VAULT,
    VaultNote,
    build_note_index,
    extract_wikilinks,
    scan_vault,
)

# BM25 in-process 캐시 — 같은 프로세스에서 multi_search 등 반복 호출 시 재사용
_bm25_cache: BM25Index | None = None
_bm25_signature: tuple | None = None

# 채널별 가중치 — 모든 채널을 0~1로 정규화한 뒤 곱해 합산 (P3 정규화 + P5 시퀀스/인덱스 부각 + P6 부분 토큰)
# regex는 keyword와 신호가 사실상 1:1 중복이라 unified에서 제외하고 --regex CLI 옵션으로만 노출.
# P9 (2026-05-03): aliases 채널 통합(filename·body 동등 흡수) 후 Optuna TPE 1000 trials 재튜닝.
# P9-rerun (2026-05-06): 동일 corpus·objective로 2000 trials 재실행. trial 1884 best.
# loss 51.91  reg 24/24  scn 29/30  avg 1.91  (P9 commit 51.96, 1.96 대비 미세 개선)
# 남은 MISS: S06(모노클↔monocle 음차, 알고리즘 한계로 받아들임)
# 변화: fuzzy/body_match 더 강화, project 0.005→0.033 부활(selectivity 재평가), related 0.073→0.032 약화
_CHANNEL_WEIGHTS = {
    "fuzzy": 0.268,  # 노트명 fuzzy 매칭 (P9-rerun: 0.201→0.268)
    "keyword": 0.055,  # 토큰 매칭 비율 — body_match와 신호 중복
    "related": 0.032,  # 그래프 관련도 (P9-rerun: 0.073→0.032, 보조 역할 축소)
    "body_match": 0.363,  # BM25-trigram 본문 매칭 (P9-rerun: 0.323→0.363, 채널 중 최대)
    "sequence_match": 0.078,  # filename 토큰 전체 매칭 — fuzzy로 대부분 흡수
    "filename_partial": 0.150,  # filename 토큰 부분 매칭 — P6 (절벽 완화)
    "child_body_match": 0.169,  # 인덱스 자식 BM25 max — P5
    "project": 0.033,  # 01 Project 거주 (P9-rerun: 0.005→0.033, 2000 trials에서 selectivity 부활)
}  # sum = 1.149


def _get_bm25(notes: list[VaultNote]) -> BM25Index:
    """notes에 대한 BM25Index 반환. 같은 시그니처면 캐시 reuse."""
    global _bm25_cache, _bm25_signature
    sig = (len(notes), notes[0].filename if notes else None)
    if _bm25_cache is not None and _bm25_signature == sig:
        return _bm25_cache
    save = os.environ.get("VAULT_SEARCH_BM25_NO_SAVE") != "1"
    _bm25_cache = build_or_load(notes, save_to_disk=save)
    _bm25_signature = sig
    return _bm25_cache


def _log_search(queries: list[str], results: list) -> None:
    """평가용 로깅. env VAULT_SEARCH_LOG=/path/to/log.jsonl 설정 시만 활성."""
    log_path = os.environ.get("VAULT_SEARCH_LOG")
    if not log_path:
        return
    payload = {
        "ts": time.time(),
        "queries": queries,
        "top10": [r[0].filename for r in results[:10]],
    }
    task_id = os.environ.get("VAULT_SEARCH_TASK_ID")
    if task_id:
        payload["task_id"] = task_id
    try:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except OSError:
        pass


# 이모지 prefix 제거용 정규식 (VS-16 variation selector 처리 포함)
_EMOJI_PREFIX_RE = re.compile(r"^(?:🏷\uFE0F?|🔖)\s*")

# 활성 프로젝트 폴더명 (01 Project 소속 노트에 검색 가산점 부여)
_PROJECT_FOLDER = "01 Project"

# 본문 구조 파싱용 정규식
_HEADER_RE = re.compile(r"^(#{1,6})\s+(.+)$")
_CALLOUT_RE = re.compile(r"^>\s*\[!(\w+)\]([+-]?)\s*(.*)")


# ── 본문 구조 파싱 ──


@dataclass
class Section:
    """본문의 구조적 섹션 (header 또는 callout)."""

    kind: str  # 'header' or 'callout'
    level: int  # header: 1-6, callout: 소속 header level + 1
    title: str
    callout_type: str = ""  # callout only: 'info', 'note', etc.
    collapsed: bool = False  # callout only: True if '-'
    start_line: int = 0
    end_line: int = 0
    content: str = ""


def parse_body_sections(body: str) -> list[Section]:
    """본문을 header/callout 섹션으로 파싱한다. 코드블록 내부는 건너뛴다."""
    lines = body.split("\n")
    sections: list[Section] = []
    current_header_level = 0
    in_code_block = False
    i = 0

    while i < len(lines):
        line = lines[i]

        # 코드블록 토글 (``` 또는 ~~~)
        if line.lstrip().startswith("```") or line.lstrip().startswith("~~~"):
            in_code_block = not in_code_block
            i += 1
            continue

        if in_code_block:
            i += 1
            continue

        # Header 체크
        header_match = _HEADER_RE.match(line)
        if header_match:
            level = len(header_match.group(1))
            title = header_match.group(2).strip()
            current_header_level = level

            # content: 다음 같은/상위 레벨 header까지
            content_lines = []
            j = i + 1
            while j < len(lines):
                next_header = _HEADER_RE.match(lines[j])
                if next_header and len(next_header.group(1)) <= level:
                    break
                content_lines.append(lines[j])
                j += 1

            sections.append(
                Section(
                    kind="header",
                    level=level,
                    title=title,
                    start_line=i,
                    end_line=j - 1,
                    content="\n".join(content_lines),
                )
            )
            i += 1
            continue

        # Callout 체크
        callout_match = _CALLOUT_RE.match(line)
        if callout_match:
            callout_type = callout_match.group(1)
            collapse_char = callout_match.group(2)
            title = callout_match.group(3).strip() or callout_type
            collapsed = collapse_char == "-"

            # content: 이어지는 > 줄들
            content_lines = []
            j = i + 1
            while j < len(lines) and lines[j].startswith(">"):
                stripped = lines[j][1:]
                if stripped.startswith(" "):
                    stripped = stripped[1:]
                content_lines.append(stripped)
                j += 1

            sections.append(
                Section(
                    kind="callout",
                    level=current_header_level + 1 if current_header_level > 0 else 1,
                    title=title,
                    callout_type=callout_type,
                    collapsed=collapsed,
                    start_line=i,
                    end_line=j - 1,
                    content="\n".join(content_lines),
                )
            )
            i = j
            continue

        i += 1

    return sections


# ── 검색 함수들 ──


def search_by_tag(
    notes: list[VaultNote], tag: str, exact: bool = False
) -> list[VaultNote]:
    """태그로 노트를 검색한다.

    exact=True: 정확히 일치하는 태그만
    exact=False: 부분 일치 (태그가 검색어로 시작하거나 포함)
    """
    results = []
    for note in notes:
        for t in note.tags:
            if exact and t == tag:
                results.append(note)
                break
            elif not exact and (tag in t or t.startswith(tag)):
                results.append(note)
                break
    return results


def _tokenize(query: str) -> list[str]:
    """검색어를 공백 기준 토큰으로 분리한다."""
    return [t for t in query.lower().split() if t]


# 노트의 (filename + " " + body).lower() 캐시 — id(note) 키.
# 같은 VaultNote 인스턴스를 여러 번 검색에 사용할 때 매번 lowercase 변환 비용 제거.
# 본문 합치면 MB 단위라 reuse 효과 큼 (Optuna 튜닝에서 8x 가속 확인).
_LOWER_CACHE: dict[int, str] = {}


def _combined_lower(note: VaultNote) -> str:
    """note.filename + aliases + body의 lowercase 캐시 조회/저장.

    aliases는 filename과 동등 위치 (P9: alias 채널 통합).
    keyword/sequence/filename_partial 검색이 alias 안 키워드도 매칭에 포함.
    """
    key = id(note)
    cached = _LOWER_CACHE.get(key)
    if cached is None:
        parts = [note.filename]
        if note.aliases:
            parts.extend(note.aliases)
        parts.append(note.body)
        cached = " ".join(parts).lower()
        _LOWER_CACHE[key] = cached
    return cached


def _count_token_matches(tokens: list[str], text: str) -> int:
    """text 안에서 매칭되는 토큰 수를 센다."""
    text_lower = text.lower()
    return sum(1 for t in tokens if t in text_lower)


def search_by_keyword(notes: list[VaultNote], keyword: str) -> list[VaultNote]:
    """제목+본문에서 키워드를 검색한다 (대소문자 무시).

    공백으로 구분된 토큰은 AND 조건으로 처리한다.
    각 토큰이 제목 또는 본문 어딘가에 개별적으로 존재하면 매칭.
    """
    tokens = _tokenize(keyword)
    if not tokens:
        return []
    results = []
    for note in notes:
        combined = _combined_lower(note)
        if all(t in combined for t in tokens):
            results.append(note)
    return results


def search_by_keyword_scored(
    notes: list[VaultNote], keyword: str, max_score: float = 2.0
) -> list[tuple[VaultNote, float]]:
    """토큰별 부분점수를 반환하는 keyword 검색.

    max_score를 토큰 매칭 비율로 분배한다.
    최소 1개 토큰 매칭 시에만 결과에 포함.
    """
    tokens = _tokenize(keyword)
    if not tokens:
        return []
    results = []
    for note in notes:
        combined = _combined_lower(note)
        matched = sum(1 for t in tokens if t in combined)
        if matched > 0:
            score = max_score * (matched / len(tokens))
            results.append((note, score))
    return results


def search_by_regex(notes: list[VaultNote], pattern: str) -> list[VaultNote]:
    """제목+본문에서 정규식 패턴으로 검색한다."""
    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error:
        return []
    results = []
    for note in notes:
        if regex.search(note.filename) or regex.search(note.body):
            results.append(note)
    return results


# 비단어문자 → 공백 정규화용 (한글·영숫자만 단어로 취급)
_NON_WORD_RE = re.compile(r"[^\w가-힣]+", re.UNICODE)


def search_by_sequence(
    notes: list[VaultNote], query: str
) -> list[tuple[VaultNote, float]]:
    """filename에 query 토큰이 모두 (순서 무관) 등장하는 노트를 매칭한다.

    fuzzy_find_note의 부분매칭이 query 전체를 연속 substring으로 다루는 한계를 보완한다.
    이모지 prefix 제거 + 비단어문자 → 공백 + lowercase 정규화 후 토큰별 substring 검사.

    점수: 모든 토큰 매칭 시 1.0. 부분 매칭은 search_by_filename_partial이 처리.
    """
    tokens = _tokenize(query)
    if not tokens:
        return []
    results = []
    for note in notes:
        name = _EMOJI_PREFIX_RE.sub("", note.filename)
        normalized = _NON_WORD_RE.sub(" ", name).lower()
        if all(t in normalized for t in tokens):
            results.append((note, 1.0))
    return results


def search_by_filename_partial(
    notes: list[VaultNote], query: str
) -> list[tuple[VaultNote, float]]:
    """filename에 query 토큰이 부분만 등장하는 노트를 matched/total 점수로 반환한다 (P6).

    sequence_match의 binary cutoff(전체 매칭 1.0 / 그 외 0)를 부드럽게 만든다.
    filename에 토큰 일부(예: 2개 중 1개)만 있어도 그 비율만큼 신호 인정 — fuzzy 절벽 완화용.
    토큰 1개 query는 partial 의미 없으므로 빈 리스트 반환 (sequence_match가 처리).
    """
    tokens = _tokenize(query)
    if len(tokens) < 2:
        return []
    results = []
    for note in notes:
        name = _EMOJI_PREFIX_RE.sub("", note.filename)
        normalized = _NON_WORD_RE.sub(" ", name).lower()
        matched = sum(1 for t in tokens if t in normalized)
        if 0 < matched < len(tokens):
            results.append((note, matched / len(tokens)))
    return results


def fuzzy_find_note(
    query: str, index: dict[str, VaultNote]
) -> list[tuple[VaultNote, float]]:
    """노트명을 fuzzy 매칭으로 검색한다. graded 점수 반환.

    P9: aliases를 filename과 동등 위치로 흡수. 각 노트는 filename + 모든 alias에 대해
    평가하고 max 점수만 채택 (노트당 1회 가산). aliases_match 별도 채널 없음.

    매칭 우선순위 (단계는 노트별 max 점수 산정용):
    1. 정확 매칭 (이모지 포함 원본) → 1.0
    2. 대소문자 무시 정확 매칭 → 1.0
    3. 부분 매칭 (substring) → 1.0
    4. 띄어쓰기 무시 매칭 → 1.0
    5. jamo trigram overlap (P8) — graded 0.4~1.0
    6. SequenceMatcher fallback (영문 query 등) — graded 0.55+
    """
    if not query:
        return []

    def stripped_name(name: str) -> str:
        return _EMOJI_PREFIX_RE.sub("", name)

    query_lower = query.lower()
    query_nospace = query_lower.replace(" ", "")
    q_tri = set(jamo_trigrams(query))
    fallback_threshold = 0.55
    jamo_threshold = 0.4

    def score_one_name(name: str) -> float:
        """단일 이름(filename 또는 alias)에 대한 매칭 점수. 1~5단계."""
        if name == query:
            return 1.0
        nl = name.lower()
        if nl == query_lower:
            return 1.0
        if query_lower in nl:
            return 1.0
        s = stripped_name(name)
        if s != name and query_lower in s.lower():
            return 1.0
        if query_nospace and query_nospace in nl.replace(" ", ""):
            return 1.0
        if q_tri:
            f_tri = set(jamo_trigrams(stripped_name(name)))
            if f_tri:
                overlap = len(q_tri & f_tri) / len(q_tri)
                if overlap >= jamo_threshold:
                    return overlap
        return 0.0

    candidates: dict[str, tuple[VaultNote, float]] = {}
    fallback_pool: list[tuple[float, VaultNote]] = []

    for name, note in index.items():
        names = [name]
        if note.aliases:
            names.extend(note.aliases)
        best = max((score_one_name(n) for n in names), default=0.0)
        if best > 0:
            candidates[name] = (note, best)
        elif not q_tri:
            # jamo 매칭 자체가 불가능한 query (영문 only 등) → SequenceMatcher fallback 후보
            ratio = 0.0
            for nm in names:
                r = SequenceMatcher(None, query_lower, nm.lower()).ratio()
                s = stripped_name(nm)
                if s != nm:
                    r = max(r, SequenceMatcher(None, query_lower, s.lower()).ratio())
                ratio = max(ratio, r)
            if ratio >= fallback_threshold:
                fallback_pool.append((ratio, note))

    if candidates:
        return sorted(candidates.values(), key=lambda x: -x[1])

    if fallback_pool:
        fallback_pool.sort(key=lambda x: x[0], reverse=True)
        return [(note, ratio) for ratio, note in fallback_pool]

    return []


def find_backlinks(note_name: str, notes: list[VaultNote]) -> list[VaultNote]:
    """특정 노트를 wikilink로 참조하는 모든 노트를 찾는다."""
    results = []
    for note in notes:
        if note.filename == note_name:
            continue
        if note_name in note.wikilinks:
            results.append(note)
            continue
        if note_name in note.ref_links:
            results.append(note)
            continue
        if note_name in note.embeds:
            results.append(note)
    return results


def find_related(
    note_name: str,
    notes: list[VaultNote],
    index: dict[str, VaultNote],
    max_results: int = 10,
) -> list[tuple[VaultNote, int, list[str]]]:
    """복합 관련도 점수로 관련 노트를 정렬한다.

    점수:
    - 같은 index 소속: +3
    - 같은 Root 소속: +2
    - 공통 태그: 태그당 +1
    - Wikilink 연결: +2

    Returns: [(note, score, reasons)] 리스트
    """
    target = index.get(note_name)
    if not target:
        return []

    target_roots = set()
    _find_roots(note_name, index, target_roots, set())

    scores = {}

    for note in notes:
        if note.filename == note_name:
            continue

        score = 0
        reasons = []

        common_refs = set(target.ref_links) & set(note.ref_links)
        if common_refs:
            score += 3
            reasons.append(f"같은 ref: {', '.join(common_refs)}")

        note_roots = set()
        _find_roots(note.filename, index, note_roots, set())
        common_roots = target_roots & note_roots
        if common_roots:
            score += 2
            reasons.append(f"같은 Root: {', '.join(common_roots)}")

        common_tags = set(target.tags) & set(note.tags)
        if common_tags:
            score += len(common_tags)
            reasons.append(f"공통 태그: {', '.join(common_tags)}")

        if note_name in note.wikilinks or note.filename in target.wikilinks:
            score += 2
            reasons.append("wikilink 연결")

        if score > 0:
            scores[note.filename] = (note, score, reasons)

    sorted_results = sorted(scores.values(), key=lambda x: x[1], reverse=True)
    return sorted_results[:max_results]


def _find_roots(name: str, index: dict[str, VaultNote], roots: set, visited: set):
    """재귀적으로 root를 찾는다."""
    if name in visited:
        return
    visited.add(name)
    note = index.get(name)
    if not note:
        return
    if note.note_type == "root":
        roots.add(name)
        return
    for parent in note.ref_links:
        _find_roots(parent, index, roots, visited)


def _is_in_project(note: VaultNote) -> bool:
    """노트가 01 Project 폴더 하위에 있는지 확인한다."""
    return any(part == _PROJECT_FOLDER for part in note.path.parts)


def has_project_context(note: VaultNote, index: dict[str, VaultNote]) -> bool:
    """검색 가산점 대상 여부.

    - 노트 자체가 01 Project 하위에 있거나
    - 노트의 ref 중 하나라도 01 Project 하위 노트를 가리키면 True.
    """
    if _is_in_project(note):
        return True
    for ref_name in note.ref_links:
        target = index.get(ref_name)
        if target and _is_in_project(target):
            return True
    return False


def unified_search(
    query: str,
    notes: list[VaultNote],
    index: dict[str, VaultNote],
    max_results: int = 10,
) -> list[tuple[VaultNote, float, list[str]]]:
    """fuzzy + keyword + regex + related를 결합한 통합 검색.

    Returns: [(note, score, match_reasons)] 점수 내림차순 정렬.
    """
    scores: dict[str, tuple[VaultNote, float, list[str]]] = {}

    def add_score(note: VaultNote, points: float, reason: str):
        name = note.filename
        if name in scores:
            existing = scores[name]
            scores[name] = (note, existing[1] + points, existing[2] + [reason])
        else:
            scores[name] = (note, points, [reason])

    # 1. Fuzzy 매칭 (노트명 유사도) — graded (P8: jamo trigram overlap)
    w = _CHANNEL_WEIGHTS["fuzzy"]
    for note, fz_score in fuzzy_find_note(query, index):
        add_score(note, fz_score * w, f"fuzzy({fz_score:.2f})")

    # 1b. Sequence 매칭 (filename 토큰 전체 매칭, 1.0) — P5
    w = _CHANNEL_WEIGHTS["sequence_match"]
    for note, seq_score in search_by_sequence(notes, query):
        add_score(note, seq_score * w, f"sequence_match({seq_score:.2f})")

    # 1c. filename_partial (filename 토큰 부분 매칭, matched/total) — P6 (절벽 완화)
    w = _CHANNEL_WEIGHTS["filename_partial"]
    for note, fp_score in search_by_filename_partial(notes, query):
        add_score(note, fp_score * w, f"filename_partial({fp_score:.2f})")

    # 2. Keyword 매칭 (토큰별 매치 비율, 0~1) — search_by_keyword_scored max_score=1.0
    w = _CHANNEL_WEIGHTS["keyword"]
    tokens = _tokenize(query)
    for note, kw_score in search_by_keyword_scored(notes, query, max_score=1.0):
        matched = sum(1 for t in tokens if t in _combined_lower(note))
        add_score(note, kw_score * w, f"keyword({matched}/{len(tokens)})")

    # 3. (regex 채널은 keyword와 신호가 중복되어 unified에서 제거 — --regex CLI 옵션으로만 사용)

    # 4. Related 확장 (상위 결과들의 그래프 이웃, raw score를 max로 정규화)
    w = _CHANNEL_WEIGHTS["related"]
    top_names = sorted(scores.keys(), key=lambda n: scores[n][1], reverse=True)[:3]
    related_pool: list[tuple[VaultNote, int, str]] = []
    for name in top_names:
        for note, rel_score, _reasons in find_related(
            name, notes, index, max_results=5
        ):
            if note.filename not in scores:
                related_pool.append((note, rel_score, name))
    if related_pool:
        max_rel = max(s for _, s, _ in related_pool) or 1
        for note, rel_score, name in related_pool:
            normalized = rel_score / max_rel
            add_score(note, normalized * w, f"related({name},{normalized:.2f})")

    # 5. body_match + child_body_match: BM25-trigram (0~1 정규화) — P5에서 인덱스 자식 전파 추가
    w_body = _CHANNEL_WEIGHTS["body_match"]
    w_child = _CHANNEL_WEIGHTS["child_body_match"]
    q_trigrams = jamo_trigrams(query)
    if q_trigrams:
        bm25 = _get_bm25(notes)
        if bm25.n_docs > 0:
            raw_scores = bm25.score_all(q_trigrams)
            max_raw = max(raw_scores, default=0.0)
            if max_raw > 0:
                note_by_filename = {n.filename: n for n in notes}
                raw_by_filename: dict[str, float] = {}
                for doc_idx, raw in enumerate(raw_scores):
                    fname = bm25.doc_filenames[doc_idx]
                    raw_by_filename[fname] = raw
                    if raw <= 0:
                        continue
                    normalized = raw / max_raw
                    note = note_by_filename.get(fname)
                    if note is not None:
                        add_score(
                            note,
                            normalized * w_body,
                            f"body_match({normalized:.2f})",
                        )

                # 5b. child_body_match: 인덱스 노트에 자식들의 max BM25 raw를 전파 (인덱스 본문 비어있는 케이스 보완)
                index_filenames = {
                    n.filename
                    for n in notes
                    if n.note_type == "index" or n.filename.startswith("🔖")
                }
                index_child_max: dict[str, float] = {}
                for child in notes:
                    if child.filename in index_filenames:
                        continue
                    child_raw = raw_by_filename.get(child.filename, 0.0)
                    if child_raw <= 0:
                        continue
                    for ref in child.ref_links:
                        if ref in index_filenames and child_raw > index_child_max.get(
                            ref, 0.0
                        ):
                            index_child_max[ref] = child_raw
                for index_name, raw in index_child_max.items():
                    idx_note = index.get(index_name)
                    if idx_note is None:
                        continue
                    normalized = raw / max_raw
                    add_score(
                        idx_note,
                        normalized * w_child,
                        f"child_body_match({normalized:.2f})",
                    )

    # 6. Project bonus: 노트 자체 또는 ref가 가리키는 노트가 01 Project 하위면 binary 1.0
    w = _CHANNEL_WEIGHTS["project"]
    for name in list(scores.keys()):
        note, score, reasons = scores[name]
        if has_project_context(note, index):
            scores[name] = (note, score + w, reasons + ["project"])

    sorted_results = sorted(scores.values(), key=lambda x: x[1], reverse=True)
    return sorted_results[:max_results]


def multi_search(
    queries: list[str],
    notes: list[VaultNote],
    index: dict[str, VaultNote],
    max_results: int = 10,
    threshold: float = 0.0,
) -> list[tuple[VaultNote, float, list[str]]]:
    """여러 쿼리의 unified_search 결과를 합산한다 (중복 시 점수 누적).

    - threshold: 정규화 점수 X 미만 결과 제외 (0.0이면 비활성).
      P9 분포 분석 기준 0.25 권장 (cut hit 0, cut noise 126/459 = 27.5%, avg top 7.67).
    - max_results: cap. threshold 통과 후 상위 N개만.
    """
    combined: dict[str, tuple[VaultNote, float, list[str]]] = {}

    # threshold 적용 시 unified_search 결과를 더 넓게 받아 합산 후 cut
    fetch_size = max_results * 2 if threshold == 0.0 else max(max_results * 4, 50)

    for query in queries:
        results = unified_search(query, notes, index, max_results=fetch_size)
        for note, score, reasons in results:
            name = note.filename
            tagged_reasons = [f"[{query}] {r}" for r in reasons]
            if name in combined:
                existing = combined[name]
                combined[name] = (
                    note,
                    existing[1] + score,
                    existing[2] + tagged_reasons,
                )
            else:
                combined[name] = (note, score, tagged_reasons)

    sorted_results = sorted(combined.values(), key=lambda x: x[1], reverse=True)
    if threshold > 0.0:
        sorted_results = [r for r in sorted_results if r[1] >= threshold]
    return sorted_results[:max_results]


# ── view 관련 함수들 ──


def get_recent_notes(notes: list[VaultNote], limit: int = 10) -> list[VaultNote]:
    """date_modified 기준으로 최근 수정된 노트를 반환한다."""

    def sort_key(note: VaultNote) -> str:
        dm = note.frontmatter.get("date_modified", "")
        if isinstance(dm, str) and dm:
            return dm
        return "0000/00/00 (Mon) 00:00:00"

    sorted_notes = sorted(notes, key=sort_key, reverse=True)
    return sorted_notes[:limit]


def view_note(query: str, index: dict[str, VaultNote]) -> VaultNote | None:
    """노트명으로 노트를 찾아 반환한다. fuzzy 매칭 지원."""
    results = fuzzy_find_note(query, index)
    if results:
        return results[0][0]
    return None


def _format_folder_label(path: Path) -> str:
    """노트 path에서 IPA 상태 폴더(00 Inbox / 01 Project / 02 Archive / 90 Settings) 추출."""
    try:
        rel = path.relative_to(DEFAULT_VAULT)
        parts = rel.parts
        if parts:
            return parts[0]
    except (ValueError, AttributeError):
        pass
    return ""


def _format_ref_path_to_root(
    note: VaultNote, index: dict[str, VaultNote], max_depth: int = 6
) -> list[list[str]]:
    """note → ... → root 까지의 ref 경로(들)를 반환. 분기되면 여러 줄."""
    paths: list[list[str]] = []

    def walk(name: str, trail: list[str], depth: int) -> None:
        if depth >= max_depth or name in trail:
            paths.append(trail + [name])
            return
        nxt = index.get(name)
        if not nxt or not nxt.ref_links:
            paths.append(trail + [name])
            return
        for parent in nxt.ref_links:
            walk(parent, trail + [name], depth + 1)

    if not note.ref_links:
        return []
    for parent in note.ref_links:
        walk(parent, [], 0)
    return paths


def _count_outlinks_in_body(body: str) -> int:
    """본문 wikilink 개수 (중복 제외)."""
    return len(set(extract_wikilinks(body)))


def _count_backlinks_to(target_filename: str, all_notes: list[VaultNote]) -> int:
    """이 노트를 ref 또는 본문 wikilink로 참조하는 다른 노트 수."""
    cnt = 0
    for n in all_notes:
        if n.filename == target_filename:
            continue
        if target_filename in n.ref_links:
            cnt += 1
            continue
        if target_filename in extract_wikilinks(n.body):
            cnt += 1
    return cnt


def _count_siblings(note: VaultNote, all_notes: list[VaultNote]) -> int:
    """같은 ref(부모)를 공유하는 형제 노트 수."""
    if not note.ref_links:
        return 0
    parent_set = set(note.ref_links)
    cnt = 0
    for n in all_notes:
        if n.filename == note.filename:
            continue
        if any(p in parent_set for p in n.ref_links):
            cnt += 1
    return cnt


def _count_children(note: VaultNote, all_notes: list[VaultNote]) -> int:
    """이 noteindex/root)를 ref하는 하위 노트 수."""
    return sum(1 for n in all_notes if note.filename in n.ref_links)


def _build_tag_to_notes_index(
    all_notes: list[VaultNote],
) -> dict[str, list[VaultNote]]:
    """tag → [VaultNote] 역인덱스."""
    out: dict[str, list[VaultNote]] = {}
    for n in all_notes:
        for t in n.tags:
            out.setdefault(t, []).append(n)
    return out


def _render_tag_distribution(
    note: VaultNote,
    tag_index: dict[str, list[VaultNote]],
    top_tags: int = 3,
    top_refs: int = 3,
) -> list[str]:
    """tag별 동행 노트 수 + ref 분포 (옵션 B). 무신호 tag는 ⚠ 표시."""
    if not note.tags:
        return []
    enriched = []
    for t in note.tags:
        peers = [p for p in tag_index.get(t, []) if p.filename != note.filename]
        enriched.append((t, peers))
    enriched.sort(key=lambda x: len(x[1]), reverse=True)
    enriched = enriched[:top_tags]
    if not enriched:
        return []
    out: list[str] = ["🏷 tags:"]
    name_w = max(len(t) for t, _ in enriched)
    for tag_name, peers in enriched:
        n_peers = len(peers)
        ref_counter: dict[str, int] = {}
        for p in peers:
            for r in p.ref_links:
                ref_counter[r] = ref_counter.get(r, 0) + 1
        ranked_refs = sorted(ref_counter.items(), key=lambda x: -x[1])[:top_refs]
        ref_str = ", ".join(f"{r} ({c})" for r, c in ranked_refs)
        warn = ""
        # IPA 룰: 좋은 tag는 2+ 인덱스를 가로지르는 관점.
        # n_peers=0 → 고립(이 노트만), n_peers=1 → 동행 1건(약한 시그널),
        # n_peers≥2 인데 ref가 1개 인덱스 → 가로지름 실패.
        if n_peers == 0:
            warn = "  ⚠ 고립(이 tag는 이 노트만)"
        elif n_peers == 1:
            warn = "  ⚠ 동행 1건(시그널 약함)"
        elif len(ref_counter) <= 1:
            warn = "  ⚠ 미가로지름(같은 인덱스에만 분포)"
        line = f"  {tag_name:<{name_w}}  ({n_peers:3d})"
        if ref_str:
            line += f"  → {ref_str}"
        line += warn
        out.append(line)
    return out


def _render_action_hints(note: VaultNote, is_overview: bool = False) -> list[str]:
    """type별 다음 명령 힌트 (traversal · search 양쪽으로 길 트기).

    노트명 길이에 비례해 코멘트가 우측으로 밀리지 않도록, 명령부 폭을
    동적으로 계산한 뒤 일정한 컬럼에서 코멘트를 정렬한다.
    overview 모드면 마지막에 --full 안내를 덧붙인다.
    """
    fn = note.filename
    nt = note.note_type or "note"
    if nt in ("index", "root"):
        cmds: list[tuple[str, str]] = [
            (f'--down "{fn}"', "하위 트리 (vault_traversal)"),
            (f'--siblings "{fn}"', "같은 부모 아래 형제 (vault_traversal)"),
            (f'--backlinks "{fn}"', "본문에서 이 노트를 거명한 노트"),
        ]
    else:
        cmds = [
            (f'--up "{fn}"', "상위 인덱스 → root 경로 (vault_traversal)"),
            (f'--related "{fn}"', "그래프 이웃 노트"),
            (f'--backlinks "{fn}"', "누가 이 노트를 가리키는가"),
        ]
    if note.tags:
        cmds.append((f'--tag "{note.tags[0]}"', "같은 관점(tag) 동행 노트"))
    if is_overview:
        cmds.append((f'--view "{fn}" --full', "이 노트의 본문 전체 보기"))

    # 노트명이 너무 길면 코멘트를 다음 줄로 떨어뜨려 가독성 확보.
    cmd_w = max(len(c) for c, _ in cmds)
    out = ["다음:"]
    if cmd_w > 60:
        for cmd, comment in cmds:
            out.append(f"  {cmd}")
            out.append(f"      # {comment}")
    else:
        for cmd, comment in cmds:
            out.append(f"  {cmd:<{cmd_w}}  # {comment}")
    return out


def _render_context_header(note: VaultNote, index: dict[str, VaultNote]) -> list[str]:
    """헤더 — IPA 상태(폴더) + type + ref→root 경로 + aliases."""
    folder = _format_folder_label(note.path)
    folder_str = f"  📁 {folder}" if folder else ""
    lines = [f"=== {note.filename} [{note.note_type or '?'}]{folder_str} ==="]
    paths = _format_ref_path_to_root(note, index)
    if paths:
        for p in paths:
            lines.append(f"↑ ref: {' → '.join(p)}")
    elif note.note_type == "root":
        lines.append("↑ ref: (root — 최상위)")
    elif note.note_type == "index":
        lines.append("↑ ref: (독립 index — root 없음)")
    if note.aliases:
        lines.append(f"   aliases: {note.aliases}")
    lines.append(f"Path: {note.path}")
    return lines


def _render_action_footer(
    note: VaultNote,
    all_notes: list[VaultNote],
    tag_index: dict[str, list[VaultNote]],
    is_overview: bool = False,
) -> list[str]:
    """푸터 — 연결 카운트 + tag 분포 + 다음 명령."""
    out = ["", "─" * 16]
    nt = note.note_type or "note"
    out_link_n = _count_outlinks_in_body(note.body)
    backlink_n = _count_backlinks_to(note.filename, all_notes)
    if nt in ("index", "root"):
        children_n = _count_children(note, all_notes)
        sib_n = _count_siblings(note, all_notes)
        out.append(
            f"연결: ↘ 하위 {children_n}  ↗ outlinks {out_link_n}  ↩ backlinks {backlink_n}  ⇄ 형제 {sib_n}"
        )
    else:
        sib_n = _count_siblings(note, all_notes)
        out.append(
            f"연결: ↗ outlinks {out_link_n}  ↩ backlinks {backlink_n}  ⇄ siblings {sib_n}"
        )
    tag_lines = _render_tag_distribution(note, tag_index)
    if tag_lines:
        out.extend(tag_lines)
    out.extend(_render_action_hints(note, is_overview=is_overview))
    return out


def _render_frontmatter(note: VaultNote) -> list[str]:
    """frontmatter dump (frontmatter 영역만, header는 _render_context_header가 담당)."""
    lines = []
    if note.frontmatter:
        lines.append("---")
        for k, v in note.frontmatter.items():
            lines.append(f"{k}: {v}")
        lines.append("---")
    return lines


def render_overview(
    note: VaultNote,
    all_notes: list[VaultNote],
    index: dict[str, VaultNote],
    tag_index: dict[str, list[VaultNote]],
) -> str:
    """frontmatter + header/callout 구조 트리 + IPA 컨텍스트 헤더/푸터."""
    lines = _render_context_header(note, index)
    lines.extend(_render_frontmatter(note))

    sections = parse_body_sections(note.body)
    if sections:
        lines.append("")
        lines.append("## Structure")
        for sec in sections:
            indent = "  " * (sec.level - 1)
            if sec.kind == "header":
                lines.append(f"{indent}[H{sec.level}] {sec.title}")
            else:
                collapse_mark = "-" if sec.collapsed else ""
                lines.append(
                    f"{indent}[!{sec.callout_type}{collapse_mark}] {sec.title}"
                )
    elif note.body:
        lines.append("\n(구조 없음 — 본문 있음)")
    else:
        lines.append("\n(본문 없음)")

    lines.extend(_render_action_footer(note, all_notes, tag_index, is_overview=True))
    return "\n".join(lines)


def find_section(sections: list[Section], query: str) -> list[Section]:
    """섹션 제목을 fuzzy 매칭으로 검색한다."""
    if not query:
        return []

    query_lower = query.lower()

    # 1. 정확 매칭
    exact = [s for s in sections if s.title == query]
    if exact:
        return exact

    # 2. 대소문자 무시 정확 매칭
    case_matches = [s for s in sections if s.title.lower() == query_lower]
    if case_matches:
        return case_matches

    # 3. 부분 매칭 (제목 + callout 타입)
    partial = [
        s
        for s in sections
        if query_lower in s.title.lower()
        or (s.kind == "callout" and query_lower in s.callout_type.lower())
    ]
    if partial:
        return partial

    # 4. SequenceMatcher fuzzy
    threshold = 0.5
    scored = []
    for sec in sections:
        ratio = SequenceMatcher(None, query_lower, sec.title.lower()).ratio()
        if sec.kind == "callout":
            ratio = max(
                ratio,
                SequenceMatcher(None, query_lower, sec.callout_type.lower()).ratio(),
            )
        if ratio >= threshold:
            scored.append((ratio, sec))
    if scored:
        scored.sort(key=lambda x: x[0], reverse=True)
        return [sec for _, sec in scored]

    return []


def render_section(note: VaultNote, query: str) -> str:
    """특정 header/callout 섹션의 내용을 렌더링한다."""
    sections = parse_body_sections(note.body)
    matches = find_section(sections, query)

    if not matches:
        # 매칭 실패 시 사용 가능한 섹션 목록 제시
        available = []
        for sec in sections:
            if sec.kind == "header":
                available.append(f"  [H{sec.level}] {sec.title}")
            else:
                available.append(f"  [!{sec.callout_type}] {sec.title}")
        hint = "\n".join(available) if available else "  (섹션 없음)"
        return f"Section not found: '{query}'\n\nAvailable sections:\n{hint}"

    lines = []
    for sec in matches:
        if sec.kind == "header":
            lines.append(f"[H{sec.level}] {sec.title}")
        else:
            collapse_mark = "-" if sec.collapsed else ""
            lines.append(f"[!{sec.callout_type}{collapse_mark}] {sec.title}")
        lines.append(sec.content)
        lines.append("")

    return "\n".join(lines)


def render_full(
    note: VaultNote,
    all_notes: list[VaultNote],
    index: dict[str, VaultNote],
    tag_index: dict[str, list[VaultNote]],
) -> str:
    """전체 본문 + IPA 컨텍스트 헤더/푸터. 닫힌 callout 내용은 접어서 표시."""
    lines = _render_context_header(note, index)
    lines.extend(_render_frontmatter(note))

    if not note.body:
        lines.append("\n(본문 없음)")
        lines.extend(_render_action_footer(note, all_notes, tag_index))
        return "\n".join(lines)

    lines.append("")

    body_lines = note.body.split("\n")
    in_code_block = False
    i = 0
    while i < len(body_lines):
        line = body_lines[i]

        if line.lstrip().startswith("```") or line.lstrip().startswith("~~~"):
            in_code_block = not in_code_block
            lines.append(line)
            i += 1
            continue

        if in_code_block:
            lines.append(line)
            i += 1
            continue

        callout_match = _CALLOUT_RE.match(line)

        if callout_match:
            collapse_char = callout_match.group(2)
            collapsed = collapse_char == "-"

            if collapsed:
                # 닫힌 callout: 헤더만 출력, 내용은 라인 수 표시
                content_count = 0
                j = i + 1
                while j < len(body_lines) and body_lines[j].startswith(">"):
                    content_count += 1
                    j += 1
                lines.append(line)
                lines.append(f"> (...collapsed, {content_count} lines)")
                i = j
                continue

        lines.append(line)
        i += 1

    lines.extend(_render_action_footer(note, all_notes, tag_index))
    return "\n".join(lines)


# ── 조합 검색 ──


def search_combined(
    notes: list[VaultNote],
    tags: list[str] = None,
    keywords: list[str] = None,
    note_type: str = None,
    folder: str = None,
) -> list[VaultNote]:
    """AND 조합 검색."""
    results = set(range(len(notes)))

    if tags:
        tag_matches = set()
        for tag in tags:
            for i, note in enumerate(notes):
                for t in note.tags:
                    if tag in t:
                        tag_matches.add(i)
                        break
        results &= tag_matches

    if keywords:
        for kw in keywords:
            tokens = _tokenize(kw)
            if not tokens:
                continue
            kw_matches = set()
            for i, note in enumerate(notes):
                combined = _combined_lower(note)
                if all(t in combined for t in tokens):
                    kw_matches.add(i)
            results &= kw_matches

    if note_type:
        type_matches = {i for i, n in enumerate(notes) if n.note_type == note_type}
        results &= type_matches

    if folder:
        folder_matches = set()
        for i, note in enumerate(notes):
            rel = str(note.path)
            if folder in rel:
                folder_matches.add(i)
        results &= folder_matches

    return [notes[i] for i in sorted(results)]


def format_note(note: VaultNote) -> str:
    """노트 정보를 한 줄로 포맷한다."""
    rel = (
        note.path.relative_to(note.path.parents[3])
        if len(note.path.parents) > 3
        else note.path
    )
    return f"[{note.note_type or '?':5s}] {note.filename}  ({rel})"


def format_refs(note: VaultNote, max_show: int = 2) -> str:
    """노트의 ref_links를 검색 결과 한 줄에 끼워넣을 표시 문자열로 포맷한다.

    빈 ref면 빈 문자열을 반환하므로 라인 길이가 자연스럽게 변동한다.
    노트의 소속 인덱스를 결과 라인에서 즉시 노출시켜, 결과 note만 보고
    상위 인덱스로 traversal 안 하는 실수를 줄인다.
    """
    if not note.ref_links:
        return ""
    shown = note.ref_links[:max_show]
    suffix = (
        f" +{len(note.ref_links) - max_show}" if len(note.ref_links) > max_show else ""
    )
    return "  ref→ " + ", ".join(shown) + suffix


def summarize_refs(
    results: list[tuple[VaultNote, float, list[str]]],
    min_count: int = 2,
    top_n: int = 5,
) -> list[tuple[str, int]]:
    """검색 결과 노트들의 ref_links 빈도를 집계한다 (내림차순, min_count 이상만).

    여러 결과 노트가 같은 인덱스를 가리키면 그 인덱스가 도메인 중심임을 시사한다.
    이 신호를 출력 끝에 박아 LLM이 "결과 note만 보고 결론" 짓는 것을 막는다.
    """
    from collections import Counter

    counter: Counter[str] = Counter()
    for note, _score, _reasons in results:
        for ref in note.ref_links:
            counter[ref] += 1
    return [
        (name, count)
        for name, count in counter.most_common(top_n)
        if count >= min_count
    ]


# ── CLI ──


def main():
    parser = argparse.ArgumentParser(description="Vault search & discovery")
    parser.add_argument("--tag", help="태그 검색")
    parser.add_argument("--keyword", help="키워드 검색 (제목+본문)")
    parser.add_argument("--backlinks", metavar="NOTE", help="역방향 링크 검색")
    parser.add_argument("--related", metavar="NOTE", help="관련 노트 검색")
    parser.add_argument("--type", dest="note_type", help="타입 필터 (note/index/root)")
    parser.add_argument(
        "--max", type=int, default=15, help="최대 결과 수 (cap, default 15)"
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.30,
        help="--search 결과 컷오프 점수 (default 0.30, 0이면 비활성). "
        "P9-rerun 분포 분석 기준 (cut hit 0, cut noise 28.9%%, 정답 min 0.309 마진 0.009). "
        "--all과 함께 쓰면 무시됨",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="--search에서 threshold/cap 무시하고 전체 결과 표시 (디버그/추가 탐색용)",
    )
    parser.add_argument(
        "--reasons",
        action="store_true",
        help="--search 결과 라인에 채널별 매칭 사유 표시 (디버그/튜닝용, 토큰 비용 큼)",
    )
    parser.add_argument("--exact", action="store_true", help="태그 정확 일치")
    parser.add_argument("--vault", default=str(DEFAULT_VAULT), help="vault 경로")
    parser.add_argument("--fuzzy", metavar="QUERY", help="노트명 fuzzy 검색")
    parser.add_argument(
        "--regex", metavar="PATTERN", help="제목+본문 정규식 검색 (대소문자 무시)"
    )
    parser.add_argument(
        "--search",
        metavar="QUERY",
        action="append",
        help="통합 검색 (여러 번 지정 가능: --search Q1 --search Q2)",
    )
    parser.add_argument(
        "--recent", action="store_true", help="최근 수정된 노트 (상위 10개)"
    )
    parser.add_argument(
        "--view", metavar="NOTE", help="노트 보기 (기본: overview 구조 트리)"
    )
    parser.add_argument(
        "--section",
        metavar="NAME",
        help="--view와 함께: 특정 header/callout 섹션만 보기 (fuzzy 매칭)",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="--view와 함께: 전체 본문 보기 (닫힌 callout 내용 접기)",
    )

    args = parser.parse_args()

    if not any(
        [
            args.tag,
            args.keyword,
            args.backlinks,
            args.related,
            args.fuzzy,
            args.regex,
            args.search,
            args.recent,
            args.view,
        ]
    ):
        parser.print_help()
        sys.exit(1)

    vault_path = Path(args.vault)
    notes = scan_vault_cached(vault_path)
    index = build_note_index(notes)
    tag_index = _build_tag_to_notes_index(notes)

    # 최근 수정 노트
    if args.recent:
        results = get_recent_notes(notes, args.max)
        if results:
            print(f"Recently modified ({len(results)} notes):")
            for i, note in enumerate(results, 1):
                dm = note.frontmatter.get("date_modified", "?")
                date_short = dm[:10] if isinstance(dm, str) and len(dm) >= 10 else "?"
                print(
                    f"  {i}. {note.filename} ({date_short}) [{note.note_type or '?'}]"
                )
        else:
            print("No notes found.")
        return

    # 노트 보기 (3가지 모드)
    if args.view:
        note = view_note(args.view, index)
        if not note:
            print(f"Note not found: '{args.view}'")
            return

        if args.section:
            print(render_section(note, args.section))
        elif args.full:
            print(render_full(note, notes, index, tag_index))
        else:
            print(render_overview(note, notes, index, tag_index))
        return

    # 통합 검색 (멀티 쿼리)
    if args.search:
        # --all: threshold/cap 무시. 실측 분석용
        effective_threshold = 0.0 if args.all else args.threshold
        # cap도 --all이면 매우 크게
        effective_max = 9999 if args.all else args.max
        # 실제 결과는 threshold cut 후 갯수를 알기 위해 넉넉히 fetch
        fetch_max = max(effective_max, 50) if not args.all else 9999

        # multi_search는 threshold 인자 지원, unified_search는 후처리
        if len(args.search) == 1:
            full_results = unified_search(
                args.search[0], notes, index, max_results=fetch_max
            )
            if effective_threshold > 0.0:
                full_results = [r for r in full_results if r[1] >= effective_threshold]
            label = args.search[0]
        else:
            full_results = multi_search(
                args.search,
                notes,
                index,
                max_results=fetch_max,
                threshold=effective_threshold,
            )
            label = " + ".join(args.search)

        # cap 적용 후 표시
        results = full_results[:effective_max]
        cut_count = len(full_results) - len(results)

        _log_search(args.search, results)

        if results:
            header = f"Search results for '{label}': {len(results)} notes"
            if effective_threshold > 0.0:
                header += f" (threshold {effective_threshold})"
            print(header)
            for note, score, reasons in results:
                ref_str = format_refs(note)
                line = f"  [{score:4.1f}] [{note.note_type or '?':5s}] {note.filename}{ref_str}"
                if args.reasons:
                    line += f"  ({', '.join(reasons)})"
                print(line)

            if cut_count > 0:
                print(
                    f"\n... +{cut_count}개 결과 더 있음. 전체 보려면 `--all` 또는 `--max {len(full_results)}`, "
                    f"임계 조절은 `--threshold 0.25`"
                )

            # ref 분포 요약: 같은 인덱스가 결과에 2건 이상 등장하면 도메인 중심으로 부각
            ref_dist = summarize_refs(results)
            if ref_dist:
                print()
                print("=== 결과 노트들의 소속 인덱스/ref 분포 (2건 이상) ===")
                for ref_name, count in ref_dist:
                    print(f"  {count:2d}건  {ref_name}")
                print("→ 2건+ 인덱스는 --view + traversal --down 권장")
        else:
            msg = f"No results for '{label}'"
            if effective_threshold > 0.0:
                msg += f" (threshold {effective_threshold} 적용 — `--threshold 0` 또는 `--all`로 재시도)"
            print(msg)
        return

    # Fuzzy 노트명 검색
    if args.fuzzy:
        results = fuzzy_find_note(args.fuzzy, index)
        if results:
            print(f"Fuzzy match for '{args.fuzzy}': {len(results)} notes")
            for n, score in results[: args.max]:
                print(f"  [{score:.2f}] {format_note(n)}")
            if len(results) > args.max:
                print(f"  ... and {len(results) - args.max} more")
        else:
            print(f"No fuzzy match for '{args.fuzzy}'")
        return

    # Regex 검색 (제목+본문 정규식, 대소문자 무시)
    if args.regex:
        results = search_by_regex(notes, args.regex)
        if results:
            print(f"Regex match for '{args.regex}': {len(results)} notes")
            for n in results[: args.max]:
                print(f"  {format_note(n)}")
            if len(results) > args.max:
                print(f"  ... and {len(results) - args.max} more")
        else:
            print(f"No regex match for '{args.regex}'")
        return

    # 관련 노트 검색
    if args.related:
        results = find_related(args.related, notes, index, args.max)
        if results:
            print(f"Related to '{args.related}':")
            for note, score, reasons in results:
                print(f"  [{score:2d}] {note.filename}")
                for r in reasons:
                    print(f"       - {r}")
        else:
            print(f"No related notes found for '{args.related}'")
        return

    # Backlinks 검색
    if args.backlinks:
        results = find_backlinks(args.backlinks, notes)
        if results:
            print(f"Backlinks to '{args.backlinks}':")
            for n in results:
                print(f"  {format_note(n)}")
        else:
            print(f"No backlinks found for '{args.backlinks}'")
        return

    # 태그 + 키워드 + 타입 조합 검색
    filtered = notes
    if args.tag:
        filtered = search_by_tag(filtered, args.tag, exact=args.exact)
    if args.keyword:
        filtered = search_by_keyword(filtered, args.keyword)
    if args.note_type:
        filtered = [n for n in filtered if n.note_type == args.note_type]

    if filtered:
        label_parts = []
        if args.tag:
            label_parts.append(f"tag='{args.tag}'")
        if args.keyword:
            label_parts.append(f"keyword='{args.keyword}'")
        if args.note_type:
            label_parts.append(f"type='{args.note_type}'")
        print(f"Search results ({', '.join(label_parts)}): {len(filtered)} notes")
        for n in filtered[: args.max]:
            print(f"  {format_note(n)}")
        if len(filtered) > args.max:
            print(f"  ... and {len(filtered) - args.max} more")
    else:
        print("No results found.")


if __name__ == "__main__":
    main()

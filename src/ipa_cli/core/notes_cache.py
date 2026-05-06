"""scan_vault 결과 pkl 캐시 (incremental).

v2: per-note mtime 저장으로 dirty 파일만 재파싱.
  - dirty=0: 캐시 그대로 반환
  - 1~30 dirty: 변경/추가된 파일만 parse_note → 기존 노트 리스트에 머지
  - 30+ dirty: full rebuild (비례 효과 역전 임계점)

캐시 위치: 환경변수 IPA_CACHE_DIR가 있으면 그 경로, 없으면
~/.cache/vault_search/. 레거시 호환을 위해 기본값 유지하고, ipa-cli는
프로필별 분리 디렉토리를 IPA_CACHE_DIR로 주입한다.
"""

from __future__ import annotations

import os
import pickle
import time
from pathlib import Path

from .vault_parser import EXCLUDE_DIRS, VaultNote, parse_note

CACHE_VERSION = "v2"
INCREMENTAL_THRESHOLD = 30  # 그 이상이면 full rebuild가 더 빠름


def _cache_dir() -> Path:
    if env := os.environ.get("IPA_CACHE_DIR"):
        return Path(env)
    return Path.home() / ".cache" / "vault_search"


def _cache_file() -> Path:
    return _cache_dir() / "notes_meta.pkl"


def _list_md_files(vault_path: Path) -> list[Path]:
    files: list[Path] = []
    for md in vault_path.rglob("*.md"):
        rel = md.relative_to(vault_path)
        if any(p in EXCLUDE_DIRS for p in rel.parts):
            continue
        files.append(md)
    return sorted(files)


def _save(
    notes: list[VaultNote], note_mtimes: dict[str, float], vault_path_str: str
) -> None:
    _cache_dir().mkdir(parents=True, exist_ok=True)
    payload = {
        "version": CACHE_VERSION,
        "last_built_at": time.time(),
        "vault_path_str": vault_path_str,
        "note_mtimes": note_mtimes,
        "notes": notes,
    }
    try:
        with open(_cache_file(), "wb") as f:
            pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)
    except OSError:
        pass


def scan_vault_cached(vault_path: Path, force_rebuild: bool = False) -> list[VaultNote]:
    """노트 메타데이터 incremental pkl 캐시.

    매 호출:
      1. .md 파일 listing + 각 파일 mtime 수집 (stat은 어차피 필수)
      2. 캐시 hit이면 per-file mtime diff로 dirty 분류
      3. dirty=0 → 캐시 그대로, 임계 이하 → incremental, 초과 → full
    """
    md_files = _list_md_files(vault_path)
    vault_path_str = str(vault_path.resolve())
    current_mtimes = {
        str(p.relative_to(vault_path)): p.stat().st_mtime for p in md_files
    }

    if not force_rebuild and _cache_file().exists():
        try:
            with open(_cache_file(), "rb") as f:
                cached = pickle.load(f)
            if (
                cached.get("version") == CACHE_VERSION
                and cached.get("vault_path_str") == vault_path_str
            ):
                cached_mtimes: dict[str, float] = cached["note_mtimes"]
                cached_notes: list[VaultNote] = cached["notes"]

                cur_keys = current_mtimes.keys()
                cached_keys = cached_mtimes.keys()
                added = cur_keys - cached_keys
                removed = cached_keys - cur_keys
                modified = {
                    p
                    for p in cur_keys & cached_keys
                    if current_mtimes[p] > cached_mtimes[p]
                }
                dirty_count = len(added) + len(removed) + len(modified)

                if dirty_count == 0:
                    return cached_notes

                if dirty_count <= INCREMENTAL_THRESHOLD:
                    notes_by_rel: dict[str, VaultNote] = {
                        str(n.path.relative_to(vault_path)): n for n in cached_notes
                    }
                    for rel in removed:
                        notes_by_rel.pop(rel, None)
                    for rel in added | modified:
                        new_note = parse_note(vault_path / rel)
                        if new_note:
                            notes_by_rel[rel] = new_note
                    notes = list(notes_by_rel.values())
                    _save(notes, current_mtimes, vault_path_str)
                    return notes
        except Exception:
            # cache 무효화 케이스: ModuleNotFoundError(파이썬 버전간 pathlib 차이),
            # AttributeError, PickleError 등. 최선은 조용히 폴백 후 재빌드.
            pass

    # full rebuild
    notes = [n for n in (parse_note(p) for p in md_files) if n]
    _save(notes, current_mtimes, vault_path_str)
    return notes

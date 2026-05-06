"""Testset loading + default path resolution.

The testset references concrete filenames in *your* vault, so it is not
bundled with the package. See `examples/testset.example.json` for the
schema.

Resolution order:
  1. explicit `path` argument
  2. env `IPA_TESTSET`
  3. `./data/eval/testset.json` (project-local)
  4. `~/.config/ipa/testset.json`
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ipa_cli.config.defaults import xdg_config_home


def default_testset_path() -> Path | None:
    """First existing candidate, or None if user has not set one up."""
    if env := os.environ.get("IPA_TESTSET"):
        p = Path(env).expanduser()
        if p.is_file():
            return p
    cwd_local = Path.cwd() / "data" / "eval" / "testset.json"
    if cwd_local.is_file():
        return cwd_local
    user_global = xdg_config_home() / "ipa" / "testset.json"
    if user_global.is_file():
        return user_global
    return None


def load_testset(path: Path | None = None) -> dict[str, Any]:
    p = path or default_testset_path()
    if p is None:
        raise FileNotFoundError(
            "No testset found. Set IPA_TESTSET, place at "
            "./data/eval/testset.json or ~/.config/ipa/testset.json, or "
            "pass --testset PATH. See examples/testset.example.json for "
            "the expected schema."
        )
    with p.open("r", encoding="utf-8") as f:
        ts = json.load(f)
    if not isinstance(ts, dict) or "cases" not in ts:
        raise ValueError(f"Invalid testset at {p}: missing 'cases'")
    return ts


def filter_excluded(notes, exclude_filenames: list[str] | None):
    excl = set(exclude_filenames or [])
    if not excl:
        return notes
    return [n for n in notes if n.filename not in excl]


def topn_for_mode(mode: str) -> int:
    return {"top1": 1, "top5": 5, "top10": 10}.get(mode, 10)

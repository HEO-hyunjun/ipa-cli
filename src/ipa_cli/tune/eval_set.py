"""Testset loading + default path resolution.

The testset references concrete filenames in *your* vault, so it is not
bundled with the package. See `examples/testset.example.json` for the
schema.

Resolution order:
  1. explicit path, or NAME under ``profiles/{profile}/tune/testsets``
  2. env ``IPA_TESTSET``
  3. ``profiles/{profile}/tune/testsets/testset.json``
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ipa_cli.config.defaults import xdg_config_home
from ipa_cli.tune.results import profile_workspace


def _profile_testset_dir(profile: str) -> Path:
    return profile_workspace(profile) / "tune" / "testsets"


def _resolve_named_testset(raw: str | Path, profile: str | None) -> Path:
    p = Path(raw).expanduser()
    if p.is_file():
        return p
    if p.is_absolute() or profile is None:
        return p
    name = p.name
    if not name.endswith(".json"):
        name = f"{name}.json"
    return _profile_testset_dir(profile) / name


def default_testset_path(profile: str | None = None) -> Path | None:
    """First existing candidate, or None if user has not set one up."""
    if env := os.environ.get("IPA_TESTSET"):
        p = Path(env).expanduser()
        if p.is_file():
            return p
    if profile:
        p = _profile_testset_dir(profile) / "testset.json"
        if p.is_file():
            return p
    # Legacy fallbacks are read-only migration conveniences.
    for p in (
        Path.cwd() / "data" / "eval" / "testset.json",
        xdg_config_home() / "ipa" / "testset.json",
    ):
        if p.is_file():
            return p
    return None


def load_testset(
    path: str | Path | None = None,
    *,
    profile: str | None = None,
) -> dict[str, Any]:
    p = (
        _resolve_named_testset(path, profile)
        if path is not None
        else default_testset_path(profile)
    )
    if p is None:
        raise FileNotFoundError(
            "No testset found. Set IPA_TESTSET, place at "
            "profiles/<profile>/tune/testsets/testset.json, or pass "
            "--testset NAME|PATH. See examples/testset.example.json for the "
            "expected schema."
        )
    if not p.is_file():
        raise FileNotFoundError(f"No testset found at {p}")
    with p.open("r", encoding="utf-8") as f:
        ts = json.load(f)
    if not isinstance(ts, dict) or "cases" not in ts:
        raise ValueError(f"Invalid testset at {p}: missing 'cases'")
    return ts


def topn_for_mode(mode: str) -> int:
    return {"top1": 1, "top5": 5, "top10": 10}.get(mode, 10)

"""Testset loading + default path resolution.

The testset references concrete filenames in *your* vault, so it is not
bundled with the package. See `examples/testset.example.json` for the
schema.

Resolution order:
  1. explicit path, or NAME under ``{vault}/.ipa/tune/testsets``
  2. env ``IPA_TESTSET``
  3. ``{vault}/.ipa/config.yaml`` ``test.file``
  4. ``{vault}/.ipa/tune/testsets/testset.json``
  5. legacy ``profiles/{profile}/tune/testsets/testset.json``
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ipa_cli.config.defaults import xdg_config_home
from ipa_cli.tune.results import profile_workspace, vault_config_path


def _profile_testset_dir(profile: str) -> Path:
    return profile_workspace(profile) / "tune" / "testsets"


def _vault_testset_dir(vault_path: Path) -> Path:
    return vault_path / ".ipa" / "tune" / "testsets"


def _resolve_named_testset(
    raw: str | Path,
    profile: str | None,
    vault_path: Path | None,
) -> Path:
    p = Path(raw).expanduser()
    if p.is_file():
        return p
    if p.is_absolute():
        return p
    name = p.name
    if not name.endswith(".json"):
        name = f"{name}.json"
    if vault_path is not None and vault_path != Path():
        return _vault_testset_dir(vault_path) / name
    if profile is None:
        return p
    return _profile_testset_dir(profile) / name


def _vault_config_test_file(vault_path: Path | None) -> Path | None:
    if vault_path is None or vault_path == Path():
        return None
    cfg_path = vault_config_path(vault_path)
    if not cfg_path.is_file():
        return None

    import yaml

    with cfg_path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        return None
    test_section = data.get("test") or {}
    raw = None
    if isinstance(test_section, dict):
        raw = test_section.get("file")
    raw = raw or data.get("test_file")
    tune_section = data.get("tune") or {}
    if raw is None and isinstance(tune_section, dict):
        raw = tune_section.get("test_file")
    if not isinstance(raw, str) or not raw:
        return None
    p = Path(raw).expanduser()
    if p.is_absolute():
        return p if p.is_file() else None
    if len(p.parts) == 1:
        p = _vault_testset_dir(vault_path) / p
    else:
        p = vault_path / p
    return p if p.is_file() else None


def default_testset_path(
    profile: str | None = None,
    vault_path: Path | None = None,
) -> Path | None:
    """First existing candidate, or None if user has not set one up."""
    if env := os.environ.get("IPA_TESTSET"):
        p = Path(env).expanduser()
        if p.is_file():
            return p
    if configured := _vault_config_test_file(vault_path):
        return configured
    if vault_path is not None and vault_path != Path():
        p = _vault_testset_dir(vault_path) / "testset.json"
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
    vault_path: Path | None = None,
) -> dict[str, Any]:
    p = (
        _resolve_named_testset(path, profile, vault_path)
        if path is not None
        else default_testset_path(profile, vault_path)
    )
    if p is None:
        raise FileNotFoundError(
            "No testset found. Set IPA_TESTSET, place at "
            "{vault}/.ipa/tune/testsets/testset.json, set "
            "{vault}/.ipa/config.yaml test.file, or pass "
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

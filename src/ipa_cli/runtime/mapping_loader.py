"""Load an IPA ``Mapping`` instance.

Lookup rules:
- ``vault_config_path`` points at ``{vault}/.ipa/config.yaml``. When it
  contains a top-level ``mapping:`` mapping, that declarative vault-local
  mapping wins.
- ``profile_dir`` is the legacy workspace directory (e.g.
  ``~/.config/ipa/profiles/ipa-test``). When the vault-local config has
  no ``mapping:`` block, ``profile_dir/mapping.py`` is used as a
  backwards-compatible fallback.
- When neither source exists, the builtin default ``Mapping()`` is
  returned.
- A user-authored ``mapping.py`` MUST expose a module-level ``mapping``
  attribute that is an instance of ``Mapping``. We do not auto-discover
  classes.
- The final mapping is ``validate()``d; a missing required semantic
  field raises ``ValueError`` (fail-fast — better to crash at startup
  than read wrong frontmatter for the rest of the run).
"""

from __future__ import annotations

import importlib.util
import sys
from collections.abc import Mapping as MappingABC
from dataclasses import fields
from pathlib import Path
from typing import Any

import yaml

from ipa_cli.api.mappings import Mapping

MAPPING_FILENAME = "mapping.py"
_FIELD_NAMES = {field.name for field in fields(Mapping)}
_SEMANTIC_FIELD_NAMES = {
    "note_type",
    "refs",
    "tags",
    "created_at",
    "updated_at",
    "aliases",
}
_FOLDER_ALIASES = {
    "inbox": "inbox_dir",
    "project": "project_dir",
    "archive": "archive_dir",
}


def load_mapping(
    profile_dir: Path | None,
    *,
    vault_config_path: Path | None = None,
) -> Mapping:
    """Resolve the active mapping for the vault/profile."""
    if vault_config_path is not None:
        mapping = _load_vault_config_mapping(vault_config_path)
        if mapping is not None:
            mapping.validate()
            return mapping

    if profile_dir is None:
        mapping = Mapping()
        mapping.validate()
        return mapping

    mapping = _load_profile_mapping(profile_dir)
    mapping.validate()
    return mapping


def _load_profile_mapping(profile_dir: Path) -> Mapping:
    path = profile_dir / MAPPING_FILENAME
    if not path.is_file():
        return Mapping()

    module = _load_python_file(
        path, module_name=f"_ipa_profile_mapping_{profile_dir.name}"
    )
    if not hasattr(module, "mapping"):
        raise ImportError(
            f"{path} must define a module-level `mapping = Mapping(...)` instance"
        )

    candidate = module.mapping
    if not isinstance(candidate, Mapping):
        raise TypeError(
            f"{path}: `mapping` must be a Mapping instance, got {type(candidate).__name__}"
        )

    return candidate


def _load_vault_config_mapping(path: Path) -> Mapping | None:
    if not path.is_file():
        return None

    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, MappingABC):
        raise ValueError(f"yaml config must be a mapping at root: {path}")

    raw = data.get("mapping")
    if raw is None:
        return None
    if not isinstance(raw, MappingABC):
        raise ValueError(f"{path}: `mapping` must be a mapping")

    return _mapping_from_dict(raw, path)


def _mapping_from_dict(raw: MappingABC[str, Any], path: Path) -> Mapping:
    kwargs: dict[str, Any] = {}

    for key, value in raw.items():
        key = str(key)
        if key == "fields":
            if not isinstance(value, MappingABC):
                raise ValueError(f"{path}: `mapping.fields` must be a mapping")
            _apply_fields(kwargs, value, path)
            continue
        if key == "folders":
            if not isinstance(value, MappingABC):
                raise ValueError(f"{path}: `mapping.folders` must be a mapping")
            _apply_folders(kwargs, value, path)
            continue
        if key not in _FIELD_NAMES:
            raise ValueError(f"{path}: unknown mapping key {key!r}")
        kwargs[key] = value

    candidate = Mapping(**kwargs)
    candidate.validate()
    return candidate


def _apply_fields(
    kwargs: dict[str, Any],
    raw_fields: MappingABC[str, Any],
    path: Path,
) -> None:
    for key, value in raw_fields.items():
        key = str(key)
        if key not in _SEMANTIC_FIELD_NAMES:
            raise ValueError(f"{path}: unknown mapping.fields key {key!r}")
        kwargs[key] = value


def _apply_folders(
    kwargs: dict[str, Any],
    raw_folders: MappingABC[str, Any],
    path: Path,
) -> None:
    for key, value in raw_folders.items():
        key = str(key)
        target = _FOLDER_ALIASES.get(key, key)
        if target not in {"inbox_dir", "project_dir", "archive_dir"}:
            raise ValueError(f"{path}: unknown mapping.folders key {key!r}")
        kwargs[target] = value


def _load_python_file(path: Path, *, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(module_name, None)
        raise
    return module

"""Resolve `Settings` from yaml + .env + env + CLI overrides.

Priority (highest wins):
  1. cli_overrides (passed by Typer callback)
  2. process env (IPA_*)
  3. .env file (loaded via python-dotenv into process env)
  4. config.yaml active profile
  5. defaults

Supports `${VAR}` interpolation in yaml string values, and a curated set
of `IPA_*` env overrides:
  - IPA_PROFILE -> active profile selection
  - IPA_VAULT_PATH -> vault_path
  - IPA_SEARCH_THRESHOLD -> search.threshold
  - IPA_SEARCH_MAX_RESULTS -> search.max_results
  - IPA_SEARCH_WEIGHTS_<NAME> -> search.weights[<name lowercased>]
"""

from __future__ import annotations

import os
import re
from copy import deepcopy
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv
from ruamel.yaml import YAML

from .defaults import (
    DEFAULT_MAX_RESULTS,
    DEFAULT_PROFILE_NAME,
    DEFAULT_THRESHOLD,
    DEFAULT_WEIGHTS,
    default_cache_dir,
    default_config_path,
    default_dotenv_path,
)
from .settings import SearchSettings, Settings

_ENV_PREFIX = "IPA_"
_VAR_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
_WEIGHTS_PREFIX = "IPA_SEARCH_WEIGHTS_"

_SCALAR_ENV_MAP: dict[str, tuple[tuple[str, ...], type]] = {
    "IPA_VAULT_PATH": (("vault_path",), str),
    "IPA_SEARCH_THRESHOLD": (("search", "threshold"), float),
    "IPA_SEARCH_MAX_RESULTS": (("search", "max_results"), int),
}


def _interpolate(value: Any, env: dict[str, str]) -> Any:
    if isinstance(value, str):
        return _VAR_PATTERN.sub(
            lambda m: env.get(m.group(1), m.group(0)),
            value,
        )
    if isinstance(value, dict):
        return {k: _interpolate(v, env) for k, v in value.items()}
    if isinstance(value, list):
        return [_interpolate(v, env) for v in value]
    return value


def _read_yaml(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise ValueError(f"config.yaml must be a mapping at root: {path}")
    return data


def _set_path(target: dict[str, Any], path: tuple[str, ...], value: Any) -> None:
    node = target
    for key in path[:-1]:
        next_node = node.get(key)
        if not isinstance(next_node, dict):
            next_node = {}
            node[key] = next_node
        node = next_node
    node[path[-1]] = value


def _apply_env_overrides(merged: dict[str, Any]) -> dict[str, str]:
    """Apply curated IPA_* env vars onto merged dict. Returns source map."""
    sources: dict[str, str] = {}
    for env_key, (path, target_type) in _SCALAR_ENV_MAP.items():
        raw = os.environ.get(env_key)
        if raw is None:
            continue
        try:
            value: Any = target_type(raw) if target_type is not str else raw
        except ValueError:
            continue
        _set_path(merged, path, value)
        sources[".".join(path)] = "env"
    # weights: IPA_SEARCH_WEIGHTS_<NAME>
    for env_key, raw in os.environ.items():
        if not env_key.startswith(_WEIGHTS_PREFIX):
            continue
        name = env_key[len(_WEIGHTS_PREFIX) :].lower()
        if not name:
            continue
        try:
            value = float(raw)
        except ValueError:
            continue
        _set_path(merged, ("search", "weights", name), value)
        sources[f"search.weights.{name}"] = "env"
    return sources


def _deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(base)
    for k, v in overlay.items():
        if isinstance(v, dict) and isinstance(result.get(k), dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = deepcopy(v)
    return result


def _build_defaults() -> dict[str, Any]:
    return {
        "vault_path": None,
        "search": {
            "threshold": DEFAULT_THRESHOLD,
            "max_results": DEFAULT_MAX_RESULTS,
            "weights": dict(DEFAULT_WEIGHTS),
        },
    }


def load_settings(
    profile: str | None = None,
    vault: str | Path | None = None,
    config_path: Path | None = None,
    dotenv_path: Path | None = None,
    cli_overrides: dict[str, Any] | None = None,
) -> Settings:
    """Resolve Settings from all layers."""
    cfg_path = config_path or default_config_path()
    env_path = dotenv_path or default_dotenv_path()

    if env_path.is_file():
        load_dotenv(env_path, override=False)

    raw = _read_yaml(cfg_path)
    profiles = raw.get("profiles") or {}
    active_profile = (
        profile
        or os.environ.get(f"{_ENV_PREFIX}PROFILE")
        or raw.get("default_profile")
        or DEFAULT_PROFILE_NAME
    )

    profile_cfg = profiles.get(active_profile, {}) if isinstance(profiles, dict) else {}
    if not isinstance(profile_cfg, dict):
        raise ValueError(f"profile '{active_profile}' in {cfg_path} must be a mapping")

    merged = _build_defaults()
    sources: dict[str, str] = {
        "vault_path": "default",
        "search.threshold": "default",
        "search.max_results": "default",
    }

    if profile_cfg:
        interpolated = _interpolate(profile_cfg, dict(os.environ))
        merged = _deep_merge(merged, interpolated)
        for k in interpolated:
            sources[k] = "yaml"
        if "search" in interpolated and isinstance(interpolated["search"], dict):
            for sub in interpolated["search"]:
                sources[f"search.{sub}"] = "yaml"

    sources.update(_apply_env_overrides(merged))

    # P6: profile.tune.result_file points at an immutable JSON under
    # ``tune/results/`` whose contents override search params (below env,
    # above yaml). Missing/invalid pointer falls back silently — caller
    # CLI emits the warning so the loader stays mute.
    _apply_active_tune_result(active_profile, cfg_path, merged, sources)

    if vault is not None:
        merged["vault_path"] = str(vault)
        sources["vault_path"] = "cli"
    if cli_overrides:
        merged = _deep_merge(merged, cli_overrides)
        for k in cli_overrides:
            sources[k] = "cli"

    vault_raw = merged.get("vault_path")
    vault_path = Path(vault_raw).expanduser() if vault_raw else Path()

    search_raw = merged.get("search") or {}
    weights = dict(DEFAULT_WEIGHTS)
    weights.update(search_raw.get("weights") or {})

    search = SearchSettings(
        threshold=float(search_raw.get("threshold", DEFAULT_THRESHOLD)),
        max_results=int(search_raw.get("max_results", DEFAULT_MAX_RESULTS)),
        weights=weights,
    )

    return Settings(
        profile=active_profile,
        vault_path=vault_path,
        cache_dir=default_cache_dir(active_profile),
        config_path=cfg_path,
        search=search,
        source_map=sources,
    )


def _apply_active_tune_result(
    profile: str,
    config_path: Path,
    merged: dict[str, Any],
    sources: dict[str, str],
) -> None:
    """Read the active tune result JSON (if any) and merge into ``merged``.

    Called from ``load_settings`` between yaml/env overrides and CLI
    overrides so:
      yaml < tune_result < env < cli
    Missing/invalid pointer is silently skipped — the CLI prints the
    user-facing warning when needed.
    """
    # Late import to avoid circular dependency at module import time.
    from ipa_cli.tune.results import resolve_active_result

    try:
        result = resolve_active_result(profile, config_path)
    except Exception:
        return
    if result is None:
        return

    search_section = merged.setdefault("search", {})
    search_section["threshold"] = result.threshold
    search_section["max_results"] = result.max_results
    weights = search_section.setdefault("weights", {})
    weights.update(result.weights)
    sources["search.threshold"] = "tune_result"
    sources["search.max_results"] = "tune_result"
    for k in result.weights:
        sources[f"search.weights.{k}"] = "tune_result"


def list_profiles(config_path: Path | None = None) -> tuple[list[str], str | None]:
    cfg_path = config_path or default_config_path()
    raw = _read_yaml(cfg_path)
    profiles_raw = raw.get("profiles") or {}
    names = list(profiles_raw.keys()) if isinstance(profiles_raw, dict) else []
    return names, raw.get("default_profile")


def _ruamel() -> YAML:
    """ruamel.yaml round-trip instance preserving comments and quote style."""
    y = YAML()
    y.preserve_quotes = True
    return y


def read_yaml_preserving(path: Path) -> Any:
    """Read yaml in round-trip mode; returns CommentedMap or {} if missing."""
    if not path.is_file():
        return {}
    with path.open("r", encoding="utf-8") as f:
        data = _ruamel().load(f)
    return data if data is not None else {}


def write_yaml_preserving(path: Path, data: Any) -> None:
    """Write yaml in round-trip mode (preserves comments/order/quotes)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        _ruamel().dump(data, f)


def set_default_profile(name: str, config_path: Path | None = None) -> None:
    cfg_path = config_path or default_config_path()
    raw = read_yaml_preserving(cfg_path)
    profiles = raw.get("profiles") if isinstance(raw, dict) else None
    if not isinstance(profiles, dict):
        profiles = {}
        raw["profiles"] = profiles
    if name not in profiles:
        profiles[name] = {}
    raw["default_profile"] = name
    write_yaml_preserving(cfg_path, raw)

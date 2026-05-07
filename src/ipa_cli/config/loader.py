"""Resolve `Settings` from profile.yaml + tune result + env + CLI overrides.

Profile selection priority:
  1. CLI ``--profile``
  2. nearest ``.ipa-profile`` walking up from the current directory
  3. process env ``IPA_PROFILE``
  4. fail (unless ``--vault`` is used for an explicit ad-hoc run)

Value priority (highest wins):
  1. CLI overrides (``--vault`` and explicit overrides)
  2. process env (IPA_*) / .env
  3. active tune result JSON pointed to by profile.yaml
  4. profile.yaml static values
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
    DEFAULT_THRESHOLD,
    DEFAULT_WEIGHTS,
    default_config_path,
    default_dotenv_path,
    xdg_config_home,
)
from .settings import SearchSettings, Settings
from ipa_cli.runtime.profile_loader import find_dotipa_profile, profile_workspace_dir

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
        raise ValueError(f"yaml config must be a mapping at root: {path}")
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


def _resolve_profile(
    *,
    profile: str | None,
    vault: str | Path | None,
    cwd: Path | None,
) -> tuple[str, str]:
    if profile:
        return profile, "cli"
    dot_profile = find_dotipa_profile(cwd or Path.cwd())
    if dot_profile:
        return dot_profile, ".ipa-profile"
    env_profile = os.environ.get(f"{_ENV_PREFIX}PROFILE")
    if env_profile:
        return env_profile, "env"
    if vault is not None:
        # ``--vault`` is already an explicit vault selection. Keep a stable
        # ad-hoc profile name so cache/tune paths remain isolated without
        # restoring an implicit default profile.
        return "adhoc", "cli-vault"
    raise ValueError(
        "No IPA profile selected. Pass --profile, create a .ipa-profile file, "
        "or set IPA_PROFILE."
    )


def load_settings(
    profile: str | None = None,
    vault: str | Path | None = None,
    config_path: Path | None = None,
    dotenv_path: Path | None = None,
    cli_overrides: dict[str, Any] | None = None,
    cwd: Path | None = None,
) -> Settings:
    """Resolve Settings from all layers."""
    cfg_path = config_path or default_config_path()
    env_path = dotenv_path or default_dotenv_path()

    if env_path.is_file():
        load_dotenv(env_path, override=False)

    active_profile, profile_source = _resolve_profile(
        profile=profile,
        vault=vault,
        cwd=cwd,
    )
    profile_dir = profile_workspace_dir(active_profile)
    profile_yaml = profile_dir / "profile.yaml"

    profile_cfg = _read_yaml(profile_yaml)
    if not isinstance(profile_cfg, dict):
        raise ValueError(
            f"profile '{active_profile}' in {profile_yaml} must be a mapping"
        )

    merged = _build_defaults()
    sources: dict[str, str] = {
        "profile": profile_source,
        "vault_path": "default",
        "search.threshold": "default",
        "search.max_results": "default",
    }

    if profile_cfg:
        interpolated = _interpolate(profile_cfg, dict(os.environ))
        merged = _deep_merge(merged, interpolated)
        for k in interpolated:
            sources[k] = "profile.yaml"
        if "search" in interpolated and isinstance(interpolated["search"], dict):
            for sub in interpolated["search"]:
                sources[f"search.{sub}"] = "profile.yaml"

    # P6: profile.yaml tune.result_file points at an immutable JSON under
    # ``tune/results/`` whose contents override static profile settings.
    _apply_active_tune_result(active_profile, cfg_path, merged, sources)

    # Env wins over profile.yaml and active tune result. ``load_dotenv`` above
    # loaded the shared .env file into process env without overriding real env.
    sources.update(_apply_env_overrides(merged))

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
        profile_dir=profile_dir,
        vault_path=vault_path,
        cache_dir=profile_dir / ".cache",
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

    Called from ``load_settings`` before env/CLI overrides so:
      profile.yaml < tune_result < env < cli
    Missing/invalid pointer is silently skipped — the CLI prints the
    user-facing warning when needed.
    """
    # Late import to avoid circular dependency at module import time.
    from ipa_cli.tune.results import load_result, read_active_result_filename

    name = read_active_result_filename(profile, config_path)
    if not name:
        return
    try:
        result = load_result(profile, name)
    except Exception:
        sources["tune.result_file.warning"] = (
            f"active tune result '{name}' is missing or invalid; using fallback params"
        )
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
    """Return profile workspace names and the nearest project selection.

    ``config_path`` is accepted for the old public signature but no longer
    drives profile discovery; profile workspaces live under
    ``$XDG_CONFIG_HOME/ipa/profiles``.
    """
    profiles_dir = xdg_config_home() / "ipa" / "profiles"
    if profiles_dir.is_dir():
        names = sorted(
            p.name
            for p in profiles_dir.iterdir()
            if p.is_dir() and not p.name.startswith(".")
        )
    else:
        names = []
    active = find_dotipa_profile(Path.cwd()) or os.environ.get(f"{_ENV_PREFIX}PROFILE")
    return names, active


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
    """Write the project-local ``.ipa-profile`` selection.

    Kept under the old function name so existing imports keep working while
    the semantics match the 2차 plan: there is no global ``default_profile``.
    """
    target = (
        config_path.parent if config_path is not None else Path.cwd()
    ) / ".ipa-profile"
    target.write_text(f"{name}\n", encoding="utf-8")

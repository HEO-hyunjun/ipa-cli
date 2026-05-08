"""Resolve `Settings` from profile registry + vault config + env + CLI.

Profile selection priority:
  1. CLI ``--profile``
  2. CLI ``--vault`` without ``--profile`` → ``adhoc`` profile (so an
     explicit vault override doesn't silently inherit another profile's
     ``search.py`` / ``convention.py`` / tune pointer / cache)
  3. nearest ``.ipa-profile`` walking up from the current directory
  4. process env ``IPA_PROFILE``
  5. default profile from ``~/.config/ipa/profile.yaml``
  6. fail

The global ``~/.config/ipa/profile.yaml`` is a profile registry:

    profiles:
      work:
        vault_path: /path/to/vault
        default: true

Vault-local ``{vault}/.ipa/config.yaml`` carries portable target paths:

    test:
      file: .ipa/tune/testsets/testset.json
    weights:
      file: .ipa/tune/results/active.json

Value priority (highest wins):
  1. CLI overrides (``--vault`` and explicit overrides)
  2. process env (IPA_*) / .env
  3. search params loaded from ``{vault}/.ipa/config.yaml`` ``weights.file``
  4. profile registry / legacy profile workspace static values
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

import json
import os
import re
from collections.abc import Mapping as MappingABC
from collections.abc import MutableMapping
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


def _profile_entries(registry_cfg: dict[str, Any], path: Path) -> dict[str, dict[str, Any]]:
    raw = registry_cfg.get("profiles") or {}
    entries: dict[str, dict[str, Any]] = {}

    if isinstance(raw, MappingABC):
        for name, value in raw.items():
            if value is None:
                value = {}
            if not isinstance(value, MappingABC):
                raise ValueError(f"profile '{name}' in {path} must be a mapping")
            entries[str(name)] = dict(value)
        return entries

    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, MappingABC):
                raise ValueError(f"profile entry in {path} must be a mapping")
            name = item.get("name")
            if not isinstance(name, str) or not name:
                raise ValueError(f"profile entry in {path} must include name")
            entries[name] = {k: v for k, v in item.items() if k != "name"}
        return entries

    raise ValueError(f"'profiles' in {path} must be a mapping or list")


def _default_profile_name(registry_cfg: dict[str, Any], path: Path) -> str | None:
    explicit = registry_cfg.get("default_profile")
    if isinstance(explicit, str) and explicit:
        return explicit

    entries = _profile_entries(registry_cfg, path)
    defaults = [name for name, cfg in entries.items() if cfg.get("default") is True]
    if len(defaults) > 1:
        joined = ", ".join(sorted(defaults))
        raise ValueError(f"Multiple default IPA profiles in {path}: {joined}")
    return defaults[0] if defaults else None


def _resolve_profile(
    *,
    profile: str | None,
    vault: str | Path | None,
    cwd: Path | None,
    registry_cfg: dict[str, Any],
    config_path: Path,
) -> tuple[str, str]:
    if profile:
        return profile, "cli"
    if vault is not None:
        # Explicit ``--vault`` without ``--profile`` means ad-hoc isolation:
        # we deliberately skip ``.ipa-profile`` / ``IPA_PROFILE`` so the
        # ad-hoc run never inherits another profile's search.py /
        # convention.py / tune pointer / cache. Pair ``--profile`` with
        # ``--vault`` to override only the vault path.
        return "adhoc", "cli-vault"
    dot_profile = find_dotipa_profile(cwd or Path.cwd())
    if dot_profile:
        return dot_profile, ".ipa-profile"
    env_profile = os.environ.get(f"{_ENV_PREFIX}PROFILE")
    if env_profile:
        return env_profile, "env"
    default_profile = _default_profile_name(registry_cfg, config_path)
    if default_profile:
        return default_profile, "profile.yaml.default"
    raise ValueError(
        "No IPA profile selected. Pass --profile, pass --vault, create a "
        ".ipa-profile file, set IPA_PROFILE, or mark one profile as "
        "default: true in ~/.config/ipa/profile.yaml."
    )


def _mark_sources(sources: dict[str, str], cfg: MappingABC[str, Any], label: str) -> None:
    for key, value in cfg.items():
        if key == "default":
            continue
        sources[str(key)] = label
        if isinstance(value, MappingABC):
            for sub_key, sub_value in value.items():
                sources[f"{key}.{sub_key}"] = label
                if key == "search" and sub_key == "weights" and isinstance(
                    sub_value, MappingABC
                ):
                    for weight_key in sub_value:
                        sources[f"search.weights.{weight_key}"] = label


def _vault_config_path(vault_path: Path) -> Path:
    return vault_path / ".ipa" / "config.yaml"


def _vault_cache_dir(vault_path: Path) -> Path:
    return vault_path / ".ipa" / "cache" / "search"


def _vault_tune_results_dir(vault_path: Path) -> Path:
    return vault_path / ".ipa" / "tune" / "results"


def _vault_testsets_dir(vault_path: Path) -> Path:
    return vault_path / ".ipa" / "tune" / "testsets"


def _nested(mapping: MappingABC[str, Any], *keys: str) -> Any:
    node: Any = mapping
    for key in keys:
        if not isinstance(node, MappingABC):
            return None
        node = node.get(key)
    return node


def _first_target(*values: Any) -> Any:
    for value in values:
        if value is not None and value != "":
            return value
    return None


def _resolve_vault_target(
    vault_path: Path,
    raw: Any,
    *,
    single_name_dir: Path,
) -> Path | None:
    if raw is None or raw == "":
        return None
    p = Path(str(raw)).expanduser()
    if p.is_absolute():
        return p
    if len(p.parts) == 1:
        return single_name_dir / p
    return vault_path / p


def _vault_targets(
    vault_path: Path,
    vault_cfg: dict[str, Any],
) -> tuple[Path | None, Path | None]:
    test_raw = _first_target(
        _nested(vault_cfg, "test", "file"),
        vault_cfg.get("test_file"),
        _nested(vault_cfg, "tune", "test_file"),
    )
    weight_raw = _first_target(
        _nested(vault_cfg, "weights", "file"),
        _nested(vault_cfg, "weight", "file"),
        vault_cfg.get("weight_file"),
        _nested(vault_cfg, "tune", "weight_file"),
        _nested(vault_cfg, "tune", "result_file"),
    )
    return (
        _resolve_vault_target(
            vault_path,
            test_raw,
            single_name_dir=_vault_testsets_dir(vault_path),
        ),
        _resolve_vault_target(
            vault_path,
            weight_raw,
            single_name_dir=_vault_tune_results_dir(vault_path),
        ),
    )


def _read_vault_config(vault_path: Path) -> tuple[dict[str, Any], Path]:
    if vault_path == Path():
        return {}, Path()
    path = _vault_config_path(vault_path)
    cfg = _read_yaml(path)
    return _interpolate(cfg, dict(os.environ)), path


def _apply_weight_result(
    weight_path: Path | None,
    merged: dict[str, Any],
    sources: dict[str, str],
) -> None:
    if weight_path is None:
        return

    from ipa_cli.tune.results import TuneResult

    try:
        with weight_path.open("r", encoding="utf-8") as f:
            payload = json.load(f)
        if not isinstance(payload, dict):
            raise ValueError("weight result root must be a mapping")
        result = TuneResult.from_dict(payload)
    except Exception:
        sources["weights.file.warning"] = (
            f"active weight result '{weight_path}' is missing or invalid; "
            "using fallback params"
        )
        return

    search_section = merged.setdefault("search", {})
    search_section["threshold"] = result.threshold
    search_section["max_results"] = result.max_results
    weights = search_section.setdefault("weights", {})
    weights.update(result.weights)
    sources["search.threshold"] = "weights.file"
    sources["search.max_results"] = "weights.file"
    for key in result.weights:
        sources[f"search.weights.{key}"] = "weights.file"


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

    registry_cfg = _interpolate(_read_yaml(cfg_path), dict(os.environ))
    profile_registry = _profile_entries(registry_cfg, cfg_path)

    active_profile, profile_source = _resolve_profile(
        profile=profile,
        vault=vault,
        cwd=cwd,
        registry_cfg=registry_cfg,
        config_path=cfg_path,
    )
    profile_dir = profile_workspace_dir(active_profile)
    profile_yaml = profile_dir / "profile.yaml"

    legacy_profile_cfg = _interpolate(_read_yaml(profile_yaml), dict(os.environ))
    profile_cfg = _interpolate(
        profile_registry.get(active_profile, {}),
        dict(os.environ),
    )

    merged = _build_defaults()
    sources: dict[str, str] = {
        "profile": profile_source,
        "profile_dir": "derived",
        "profile_config": "default",
        "vault_config": "derived",
        "vault_path": "default",
        "cache_dir": "derived",
        "search.threshold": "default",
        "search.max_results": "default",
    }

    if legacy_profile_cfg:
        merged = _deep_merge(merged, legacy_profile_cfg)
        _mark_sources(sources, legacy_profile_cfg, "profile_workspace")
    if profile_cfg:
        merged = _deep_merge(merged, profile_cfg)
        _mark_sources(sources, profile_cfg, "profile.yaml")

    # Apply only vault path env/CLI early so vault-local config is read from
    # the actual target vault. Full env/CLI overrides are applied again below.
    env_vault = os.environ.get("IPA_VAULT_PATH")
    if env_vault:
        merged["vault_path"] = env_vault
        sources["vault_path"] = "env"
    if vault is not None:
        merged["vault_path"] = str(vault)
        sources["vault_path"] = "cli"

    vault_raw = merged.get("vault_path")
    vault_path = Path(vault_raw).expanduser() if vault_raw else Path()

    vault_cfg, vault_cfg_path = _read_vault_config(vault_path)
    testset_path, weight_result_path = _vault_targets(vault_path, vault_cfg)
    if testset_path is not None:
        sources["test.file"] = "vault.config"
    if weight_result_path is not None:
        sources["weights.file"] = "vault.config"
    _apply_weight_result(weight_result_path, merged, sources)

    # Env wins over profile registry and active weight result. ``load_dotenv``
    # above loaded the shared .env file into process env without overriding
    # real env.
    sources.update(_apply_env_overrides(merged))

    if vault is not None:
        merged["vault_path"] = str(vault)
        sources["vault_path"] = "cli"
    if cli_overrides:
        merged = _deep_merge(merged, cli_overrides)
        for key in cli_overrides:
            sources[key] = "cli"

    vault_raw = merged.get("vault_path")
    vault_path = Path(vault_raw).expanduser() if vault_raw else Path()
    cache_dir = _vault_cache_dir(vault_path) if vault_path != Path() else Path()

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
        cache_dir=cache_dir,
        config_path=cfg_path,
        vault_config_path=vault_cfg_path,
        testset_path=testset_path,
        weight_result_path=weight_result_path,
        search=search,
        source_map=sources,
    )


def list_profiles(config_path: Path | None = None) -> tuple[list[str], str | None]:
    """Return profile registry names and the current active selection."""
    cfg_path = config_path or default_config_path()
    registry_cfg = _interpolate(_read_yaml(cfg_path), dict(os.environ))
    profile_registry = _profile_entries(registry_cfg, cfg_path)
    active = (
        find_dotipa_profile(Path.cwd())
        or os.environ.get(f"{_ENV_PREFIX}PROFILE")
        or _default_profile_name(registry_cfg, cfg_path)
    )
    return sorted(profile_registry), active


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
    """Mark one profile as the global default in ``profile.yaml``."""
    path = config_path or default_config_path()
    data = read_yaml_preserving(path)
    if not isinstance(data, MutableMapping):
        data = {}

    profiles = data.setdefault("profiles", {})
    if not isinstance(profiles, MutableMapping):
        raise ValueError(f"'profiles' in {path} must be a mapping")

    if name not in profiles or profiles[name] is None:
        profiles[name] = {"vault_path": ""}
    if not isinstance(profiles[name], MutableMapping):
        raise ValueError(f"profile '{name}' in {path} must be a mapping")

    for profile_name, profile_cfg in profiles.items():
        if not isinstance(profile_cfg, MutableMapping):
            continue
        profile_cfg["default"] = profile_name == name

    write_yaml_preserving(path, data)

"""Load search channels from profile and vault-local plugin locations.

Lookup order:
- builtins, or ``profile_dir/search.py`` when a profile declares an explicit
  channel list.
- ``{vault}/.ipa/plugins/search/*.py`` files, appended in filename order.
"""

from __future__ import annotations

import hashlib
import importlib.util
import sys
from pathlib import Path

from ipa_cli.api.base_channels import BaseSearchChannel

SEARCH_FILENAME = "search.py"
VAULT_PLUGIN_ROOT = Path(".ipa") / "plugins"
SEARCH_PLUGIN_DIR = "search"


def load_search_channels(
    profile_dir: Path | None,
    *,
    vault_path: Path | None = None,
) -> list[BaseSearchChannel]:
    """Resolve the active channel list for a profile and vault."""
    channels = _profile_channels(profile_dir)
    channels.extend(_vault_channels(vault_path))
    return channels


def _profile_channels(profile_dir: Path | None) -> list[BaseSearchChannel]:
    if profile_dir is None:
        return _default_channels()
    path = profile_dir / SEARCH_FILENAME
    if not path.is_file():
        return _default_channels()

    module = _load_python_file(
        path, module_name=f"_ipa_profile_search_{profile_dir.name}"
    )
    return _read_channels_attr(path, module)


def _vault_channels(vault_path: Path | None) -> list[BaseSearchChannel]:
    if vault_path is None or vault_path == Path():
        return []

    plugin_dir = vault_path.expanduser() / VAULT_PLUGIN_ROOT / SEARCH_PLUGIN_DIR
    if not plugin_dir.is_dir():
        return []

    channels: list[BaseSearchChannel] = []
    for path in _plugin_files(plugin_dir):
        module = _load_python_file(
            path, module_name=_module_name("_ipa_vault_search", path)
        )
        channels.extend(_read_channels_attr(path, module))
    return channels


def _plugin_files(plugin_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in plugin_dir.glob("*.py")
        if path.name != "__init__.py" and not path.name.startswith("_")
    )


def _read_channels_attr(path: Path, module) -> list[BaseSearchChannel]:
    if not hasattr(module, "channels"):
        raise ImportError(
            f"{path} must define a module-level `channels = [BaseSearchChannel(...)]`"
        )

    candidate = module.channels
    if not isinstance(candidate, list) or not all(
        isinstance(c, BaseSearchChannel) for c in candidate
    ):
        raise TypeError(
            f"{path}: `channels` must be a list of BaseSearchChannel instances"
        )
    return list(candidate)


def _default_channels() -> list[BaseSearchChannel]:
    # Imported lazily so the runtime can be exercised in tests without
    # pulling the full builtins surface (mirrors convention_loader).
    from ipa_cli.builtins.channels.default_channels import default_channels

    return default_channels()


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


def _module_name(prefix: str, path: Path) -> str:
    digest = hashlib.sha1(str(path.resolve()).encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_{path.stem}_{digest}"

"""Load a profile's ``search.py`` into a list of ``BaseSearchChannel`` instances.

Mirrors ``convention_loader``:
- ``profile_dir`` is the workspace directory. ``None`` or no ``search.py``
  returns the builtin ``default_channels`` list.
- A user-authored ``search.py`` MUST expose a module-level
  ``channels`` attribute that is a list of ``BaseSearchChannel``
  instances. Channel auto-discovery is intentionally not done — users
  keep an explicit list.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from ipa_cli.api.base_channels import BaseSearchChannel

SEARCH_FILENAME = "search.py"


def load_search_channels(profile_dir: Path | None) -> list[BaseSearchChannel]:
    """Resolve the active channel list for a profile workspace dir."""
    if profile_dir is None:
        return _default_channels()

    path = profile_dir / SEARCH_FILENAME
    if not path.is_file():
        return _default_channels()

    module = _load_python_file(
        path, module_name=f"_ipa_profile_search_{profile_dir.name}"
    )
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

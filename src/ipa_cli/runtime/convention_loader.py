"""Load a profile's ``convention.py`` into a ``Convention`` instance.

Lookup rules:
- ``profile_dir`` is the workspace directory. When ``None`` or when the
  directory has no ``convention.py``, the builtin default convention is
  returned (see ``ipa_cli.builtins.conventions.default_convention``).
- A user-authored ``convention.py`` MUST expose a module-level
  ``convention`` attribute that is an instance of ``Convention``. We do
  not auto-discover classes — users keep an explicit list.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from ipa_cli.api.conventions import Convention

CONVENTION_FILENAME = "convention.py"


def load_convention(profile_dir: Path | None) -> Convention:
    """Resolve the active convention for a profile workspace dir."""
    if profile_dir is None:
        return _default_convention()

    path = profile_dir / CONVENTION_FILENAME
    if not path.is_file():
        return _default_convention()

    module = _load_python_file(
        path, module_name=f"_ipa_profile_convention_{profile_dir.name}"
    )
    if not hasattr(module, "convention"):
        raise ImportError(
            f"{path} must define a module-level `convention = Convention(...)` instance"
        )

    candidate = module.convention
    if not isinstance(candidate, Convention):
        raise TypeError(
            f"{path}: `convention` must be a Convention instance, got {type(candidate).__name__}"
        )
    return candidate


def _default_convention() -> Convention:
    # Imported lazily so the runtime can be exercised without pulling in
    # the entire builtins surface (e.g., minimal API tests).
    from ipa_cli.builtins.conventions.default_convention import default_convention

    return default_convention()


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

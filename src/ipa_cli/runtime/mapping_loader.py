"""Load a profile's ``mapping.py`` into a ``Mapping`` instance.

Lookup rules:
- ``profile_dir`` is the workspace directory (e.g.
  ``~/.config/ipa/profiles/ipa-test``). When ``None`` or when the
  directory has no ``mapping.py``, the builtin default ``Mapping()`` is
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
from pathlib import Path

from ipa_cli.api.mappings import Mapping

MAPPING_FILENAME = "mapping.py"


def load_mapping(profile_dir: Path | None) -> Mapping:
    """Resolve the active mapping for a profile workspace dir."""
    if profile_dir is None:
        mapping = Mapping()
        mapping.validate()
        return mapping

    path = profile_dir / MAPPING_FILENAME
    if not path.is_file():
        mapping = Mapping()
        mapping.validate()
        return mapping

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

    candidate.validate()
    return candidate


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

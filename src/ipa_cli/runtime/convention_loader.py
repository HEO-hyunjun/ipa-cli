"""Load convention rules from profile and vault-local plugin locations.

Lookup rules:
- ``profile_dir`` is the workspace directory. When ``None`` or when the
  directory has no ``convention.py``, the builtin default convention is
  returned (see ``ipa_cli.builtins.conventions.default_convention``).
- A user-authored ``convention.py`` MUST expose a module-level
  ``convention`` attribute that is an instance of ``Convention``. We do
  not auto-discover classes — users keep an explicit list.
- ``{vault}/.ipa/plugins/lint/*.py`` and
  ``{vault}/.ipa/plugins/formatter/*.py`` files append module-level
  ``rules`` lists to the active convention.
"""

from __future__ import annotations

import hashlib
import importlib.util
import sys
from pathlib import Path

from ipa_cli.api.base_rules import BaseConventionRule
from ipa_cli.api.conventions import Convention

CONVENTION_FILENAME = "convention.py"
VAULT_PLUGIN_ROOT = Path(".ipa") / "plugins"
CONVENTION_PLUGIN_DIRS = ("lint", "formatter")


def load_convention(
    profile_dir: Path | None,
    *,
    vault_path: Path | None = None,
) -> Convention:
    """Resolve the active convention for a profile and vault."""
    convention = _profile_convention(profile_dir)
    vault_rules = _vault_rules(vault_path)
    if not vault_rules:
        return convention
    return Convention(
        name=f"{convention.name}+vault",
        rules=[*convention.rules, *vault_rules],
    )


def _profile_convention(profile_dir: Path | None) -> Convention:
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

    return _read_convention_attr(path, module)


def _vault_rules(vault_path: Path | None) -> list[BaseConventionRule]:
    if vault_path is None or vault_path == Path():
        return []

    root = vault_path.expanduser() / VAULT_PLUGIN_ROOT
    rules: list[BaseConventionRule] = []
    for directory_name in CONVENTION_PLUGIN_DIRS:
        plugin_dir = root / directory_name
        if not plugin_dir.is_dir():
            continue
        for path in _plugin_files(plugin_dir):
            module = _load_python_file(
                path,
                module_name=_module_name(f"_ipa_vault_{directory_name}", path),
            )
            rules.extend(_read_rules_attr(path, module))
    return rules


def _plugin_files(plugin_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in plugin_dir.glob("*.py")
        if path.name != "__init__.py" and not path.name.startswith("_")
    )


def _read_convention_attr(path: Path, module) -> Convention:
    candidate = module.convention
    if not isinstance(candidate, Convention):
        raise TypeError(
            f"{path}: `convention` must be a Convention instance, got {type(candidate).__name__}"
        )
    return candidate


def _read_rules_attr(path: Path, module) -> list[BaseConventionRule]:
    if not hasattr(module, "rules"):
        raise ImportError(
            f"{path} must define a module-level `rules = [BaseConventionRule(...)]`"
        )

    candidate = module.rules
    if not isinstance(candidate, list) or not all(
        isinstance(rule, BaseConventionRule) for rule in candidate
    ):
        raise TypeError(
            f"{path}: `rules` must be a list of BaseConventionRule instances"
        )
    return list(candidate)


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


def _module_name(prefix: str, path: Path) -> str:
    digest = hashlib.sha1(str(path.resolve()).encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_{path.stem}_{digest}"

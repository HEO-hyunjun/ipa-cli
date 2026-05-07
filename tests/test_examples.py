"""P7 — sample_profile example loads and shapes correctly.

Regression test so contributors who change the API discover broken
samples before users do.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

from ipa_cli.api.base_channels import BaseSearchChannel
from ipa_cli.api.base_rules import BaseConventionRule
from ipa_cli.api.conventions import Convention

REPO_ROOT = Path(__file__).resolve().parent.parent
SAMPLE_DIR = REPO_ROOT / "examples" / "sample_profile"


def _load_module(rel_path: str, name: str):
    """Import a file by absolute path under a stable module name."""
    target = SAMPLE_DIR / rel_path
    spec = importlib.util.spec_from_file_location(
        name, target, submodule_search_locations=[str(SAMPLE_DIR)]
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise
    return module


@pytest.fixture(autouse=True)
def _clean_sample_modules():
    """Drop cached imports between tests so each test runs cold."""
    yield
    for k in list(sys.modules.keys()):
        if k.startswith("_test_sample_") or k == "sample_profile":
            sys.modules.pop(k, None)


def test_sample_profile_dir_exists() -> None:
    assert SAMPLE_DIR.is_dir()
    assert (SAMPLE_DIR / "profile.yaml").is_file()
    assert (SAMPLE_DIR / "convention.py").is_file()
    assert (SAMPLE_DIR / "search.py").is_file()
    assert (SAMPLE_DIR / "README.md").is_file()


def test_sample_convention_module_exposes_convention() -> None:
    # Register the sample directory as a package so relative imports
    # inside convention.py (``from .rules.no_emoji_in_filename_rule``)
    # resolve correctly.
    pkg_spec = importlib.util.spec_from_file_location(
        "sample_profile",
        SAMPLE_DIR / "__init__.py",
        submodule_search_locations=[str(SAMPLE_DIR)],
    )
    if pkg_spec is None or pkg_spec.loader is None:
        pkg = importlib.util.module_from_spec(
            importlib.util.spec_from_loader("sample_profile", loader=None)
        )
        pkg.__path__ = [str(SAMPLE_DIR)]
        sys.modules["sample_profile"] = pkg
    else:
        pkg = importlib.util.module_from_spec(pkg_spec)
        pkg.__path__ = [str(SAMPLE_DIR)]
        sys.modules["sample_profile"] = pkg

    spec = importlib.util.spec_from_file_location(
        "sample_profile.convention", SAMPLE_DIR / "convention.py"
    )
    assert spec is not None and spec.loader is not None
    convention_mod = importlib.util.module_from_spec(spec)
    sys.modules["sample_profile.convention"] = convention_mod
    spec.loader.exec_module(convention_mod)

    convention = convention_mod.convention
    assert isinstance(convention, Convention)
    # Sample's NoEmojiInFilenameRule must be appended to builtin set.
    codes = [r.code for r in convention.rules]
    assert "sample.no_emoji_in_filename" in codes
    assert "ipa.heading.no_h1" in codes  # builtin still present
    for rule in convention.rules:
        assert isinstance(rule, BaseConventionRule)


def test_sample_search_module_exposes_channels() -> None:
    pkg_spec = importlib.util.spec_from_loader("sample_profile_search", loader=None)
    pkg = importlib.util.module_from_spec(pkg_spec)
    pkg.__path__ = [str(SAMPLE_DIR)]
    sys.modules["sample_profile_search"] = pkg

    spec = importlib.util.spec_from_file_location(
        "sample_profile_search.search", SAMPLE_DIR / "search.py"
    )
    assert spec is not None and spec.loader is not None
    search_mod = importlib.util.module_from_spec(spec)
    sys.modules["sample_profile_search.search"] = search_mod
    spec.loader.exec_module(search_mod)

    channels = search_mod.channels
    assert isinstance(channels, list)
    assert len(channels) >= 2  # builtins + sample
    names = [ch.name for ch in channels]
    assert "heading_match" in names
    assert "fuzzy" in names  # builtin still present
    for ch in channels:
        assert isinstance(ch, BaseSearchChannel)

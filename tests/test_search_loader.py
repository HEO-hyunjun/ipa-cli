"""search_loader tests — fallback behavior + custom search.py loading."""

from __future__ import annotations

from pathlib import Path
from typing import ClassVar

import pytest

from ipa_cli.api.base_channels import BaseSearchChannel
from ipa_cli.runtime.search_loader import load_search_channels


def test_returns_default_when_profile_dir_none() -> None:
    channels = load_search_channels(None)
    names = [c.name for c in channels]
    assert "keyword" in names
    assert "filename" in names


def test_returns_default_when_no_search_py(tmp_path: Path) -> None:
    channels = load_search_channels(tmp_path)
    names = [c.name for c in channels]
    assert "keyword" in names
    assert "filename" in names


def test_loads_custom_search_py(tmp_path: Path) -> None:
    search_py = tmp_path / "search.py"
    search_py.write_text(
        '''"""custom search."""
from typing import ClassVar

from ipa_cli.api.base_channels import BaseSearchChannel


class CustomChannel(BaseSearchChannel):
    name: ClassVar[str] = "custom"
    description: ClassVar[str] = "test custom"
    default_weight: ClassVar[float] = 0.5

    def search(self, ctx, query):
        return {}


channels = [CustomChannel()]
''',
        encoding="utf-8",
    )
    channels = load_search_channels(tmp_path)
    assert len(channels) == 1
    assert channels[0].name == "custom"


def test_raises_when_channels_attr_missing(tmp_path: Path) -> None:
    (tmp_path / "search.py").write_text("# no channels here\n", encoding="utf-8")
    with pytest.raises(ImportError, match="must define a module-level"):
        load_search_channels(tmp_path)


def test_raises_when_channels_wrong_type(tmp_path: Path) -> None:
    (tmp_path / "search.py").write_text(
        "channels = ['not a channel']\n", encoding="utf-8"
    )
    with pytest.raises(TypeError, match="must be a list of BaseSearchChannel"):
        load_search_channels(tmp_path)


def test_raises_when_channels_not_list(tmp_path: Path) -> None:
    (tmp_path / "search.py").write_text("channels = 'oops'\n", encoding="utf-8")
    with pytest.raises(TypeError, match="must be a list of BaseSearchChannel"):
        load_search_channels(tmp_path)


def test_search_py_failure_does_not_pollute_sys_modules(tmp_path: Path) -> None:
    import sys

    (tmp_path / "search.py").write_text(
        "raise RuntimeError('boom')\n", encoding="utf-8"
    )
    with pytest.raises(RuntimeError):
        load_search_channels(tmp_path)
    # The failed profile's specific module name should not stick around
    # as a half-loaded entry; other tests' successful modules are unrelated.
    expected_name = f"_ipa_profile_search_{tmp_path.name}"
    assert expected_name not in sys.modules


class _SmokeChannel(BaseSearchChannel):
    name: ClassVar[str] = "smoke"
    description: ClassVar[str] = "smoke"
    default_weight: ClassVar[float] = 0.0

    def search(self, ctx, query):
        return {}


def test_loaded_channels_are_basesearchchannel_instances(tmp_path: Path) -> None:
    channels = load_search_channels(None)
    for c in channels:
        assert isinstance(c, BaseSearchChannel)

"""Convention loader tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from ipa_cli.api import Convention
from ipa_cli.runtime.convention_loader import load_convention


def test_no_profile_dir_returns_default() -> None:
    c = load_convention(None)
    assert isinstance(c, Convention)
    assert c.name == "ipa.builtin"
    assert len(c.rules) >= 1


def test_empty_profile_dir_returns_default(tmp_path: Path) -> None:
    c = load_convention(tmp_path)
    assert c.name == "ipa.builtin"


def test_user_convention_loaded(tmp_path: Path) -> None:
    (tmp_path / "convention.py").write_text(
        """
from ipa_cli.api import Convention, BaseConventionRule, Severity, Issue


class DummyRule(BaseConventionRule):
    code = "test.dummy"
    severity = Severity.INFO


convention = Convention(name="custom", rules=[DummyRule()])
""",
        encoding="utf-8",
    )
    c = load_convention(tmp_path)
    assert c.name == "custom"
    assert len(c.rules) == 1
    assert c.rules[0].code == "test.dummy"


def test_user_convention_can_extend_builtin(tmp_path: Path) -> None:
    (tmp_path / "convention.py").write_text(
        """
from ipa_cli.api import Convention, BaseConventionRule, Severity
from ipa_cli.builtins.conventions.default_convention import default_convention


class ExtraRule(BaseConventionRule):
    code = "test.extra"
    severity = Severity.INFO


base = default_convention()
convention = Convention(
    name="extended",
    rules=base.rules + [ExtraRule()],
)
""",
        encoding="utf-8",
    )
    c = load_convention(tmp_path)
    assert c.name == "extended"
    codes = [r.code for r in c.rules]
    assert "test.extra" in codes
    assert any(code.startswith("ipa.") for code in codes)


def test_missing_attr_fails(tmp_path: Path) -> None:
    (tmp_path / "convention.py").write_text("# no convention attr\n", encoding="utf-8")
    with pytest.raises(ImportError, match="convention"):
        load_convention(tmp_path)


def test_wrong_type_fails(tmp_path: Path) -> None:
    (tmp_path / "convention.py").write_text(
        "convention = []  # not a Convention instance\n",
        encoding="utf-8",
    )
    with pytest.raises(TypeError, match="Convention instance"):
        load_convention(tmp_path)

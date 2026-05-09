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


def test_loads_vault_local_lint_and_formatter_plugins(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    lint_dir = vault / ".ipa" / "plugins" / "lint"
    formatter_dir = vault / ".ipa" / "plugins" / "formatter"
    lint_dir.mkdir(parents=True)
    formatter_dir.mkdir(parents=True)
    (lint_dir / "lint_rule.py").write_text(
        """
from ipa_cli.api import BaseConventionRule, Severity


class VaultLintRule(BaseConventionRule):
    code = "vault.lint"
    severity = Severity.INFO


rules = [VaultLintRule()]
""",
        encoding="utf-8",
    )
    (formatter_dir / "formatter_rule.py").write_text(
        """
from ipa_cli.api import BaseConventionRule, Severity


class VaultFormatterRule(BaseConventionRule):
    code = "vault.formatter"
    severity = Severity.WARN


rules = [VaultFormatterRule()]
""",
        encoding="utf-8",
    )

    c = load_convention(None, vault_path=vault)
    codes = [r.code for r in c.rules]
    assert c.name == "ipa.builtin+vault"
    assert "vault.lint" in codes
    assert "vault.formatter" in codes
    assert any(code.startswith("ipa.") for code in codes)


def test_user_convention_is_extended_by_vault_local_plugins(tmp_path: Path) -> None:
    profile = tmp_path / "profile"
    profile.mkdir()
    (profile / "convention.py").write_text(
        """
from ipa_cli.api import Convention, BaseConventionRule, Severity


class ProfileRule(BaseConventionRule):
    code = "profile.rule"
    severity = Severity.INFO


convention = Convention(name="profile", rules=[ProfileRule()])
""",
        encoding="utf-8",
    )

    vault = tmp_path / "vault"
    lint_dir = vault / ".ipa" / "plugins" / "lint"
    lint_dir.mkdir(parents=True)
    (lint_dir / "lint_rule.py").write_text(
        """
from ipa_cli.api import BaseConventionRule, Severity


class VaultLintRule(BaseConventionRule):
    code = "vault.lint"
    severity = Severity.INFO


rules = [VaultLintRule()]
""",
        encoding="utf-8",
    )

    c = load_convention(profile, vault_path=vault)
    assert c.name == "profile+vault"
    assert [r.code for r in c.rules] == ["profile.rule", "vault.lint"]


def test_vault_convention_plugin_wrong_rules_type_fails(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    lint_dir = vault / ".ipa" / "plugins" / "lint"
    lint_dir.mkdir(parents=True)
    (lint_dir / "bad.py").write_text("rules = ['oops']\n", encoding="utf-8")

    with pytest.raises(TypeError, match="BaseConventionRule"):
        load_convention(None, vault_path=vault)


def test_vault_config_can_select_only_specific_lint_rule(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    lint_dir = vault / ".ipa" / "plugins" / "lint"
    formatter_dir = vault / ".ipa" / "plugins" / "formatter"
    lint_dir.mkdir(parents=True)
    formatter_dir.mkdir(parents=True)
    (lint_dir / "lint_rule.py").write_text(
        """
from ipa_cli.api import BaseConventionRule, Severity


class VaultLintRule(BaseConventionRule):
    code = "vault.lint"
    severity = Severity.INFO


rules = [VaultLintRule()]
""",
        encoding="utf-8",
    )
    (formatter_dir / "formatter_rule.py").write_text(
        """
from ipa_cli.api import BaseConventionRule, Severity


class VaultFormatterRule(BaseConventionRule):
    code = "vault.formatter"
    severity = Severity.INFO


rules = [VaultFormatterRule()]
""",
        encoding="utf-8",
    )
    (vault / ".ipa" / "config.yaml").write_text(
        """
convention:
  builtin: false
  plugins:
    lint: true
    formatter: false
  only:
    - vault.lint
""",
        encoding="utf-8",
    )

    c = load_convention(None, vault_path=vault, surface="convention")

    assert c.name == "ipa.empty+vault"
    assert [r.code for r in c.rules] == ["vault.lint"]


def test_vault_config_can_select_only_specific_formatter_rule(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    lint_dir = vault / ".ipa" / "plugins" / "lint"
    formatter_dir = vault / ".ipa" / "plugins" / "formatter"
    lint_dir.mkdir(parents=True)
    formatter_dir.mkdir(parents=True)
    (lint_dir / "lint_rule.py").write_text(
        """
from ipa_cli.api import BaseConventionRule, Severity


class VaultLintRule(BaseConventionRule):
    code = "vault.lint"
    severity = Severity.INFO


rules = [VaultLintRule()]
""",
        encoding="utf-8",
    )
    (formatter_dir / "formatter_rule.py").write_text(
        """
from ipa_cli.api import BaseConventionRule, Severity


class VaultFormatterRule(BaseConventionRule):
    code = "vault.formatter"
    severity = Severity.WARN


rules = [VaultFormatterRule()]
""",
        encoding="utf-8",
    )
    (vault / ".ipa" / "config.yaml").write_text(
        """
formatter:
  builtin: false
  plugins:
    lint: false
    formatter: true
  only:
    - vault.formatter
""",
        encoding="utf-8",
    )

    c = load_convention(None, vault_path=vault, surface="formatter")

    assert c.name == "ipa.empty+vault"
    assert [r.code for r in c.rules] == ["vault.formatter"]


def test_vault_config_can_disable_convention_surface(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    (vault / ".ipa").mkdir(parents=True)
    (vault / ".ipa" / "config.yaml").write_text(
        "convention:\n  enabled: false\n",
        encoding="utf-8",
    )

    c = load_convention(None, vault_path=vault, surface="convention")

    assert c.name == "ipa.convention.disabled"
    assert c.rules == []


def test_vault_config_ignore_filters_builtin_rules(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    (vault / ".ipa").mkdir(parents=True)
    (vault / ".ipa" / "config.yaml").write_text(
        """
convention:
  ignore:
    - ipa.heading.no_h1
""",
        encoding="utf-8",
    )

    c = load_convention(None, vault_path=vault, surface="convention")

    codes = [r.code for r in c.rules]
    assert "ipa.heading.no_h1" not in codes
    assert any(code.startswith("ipa.") for code in codes)


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

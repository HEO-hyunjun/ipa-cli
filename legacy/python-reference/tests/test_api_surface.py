"""P1 surface tests for ``ipa_cli.api``.

Goals:
- All public names import from ``ipa_cli.api``.
- Data classes are frozen where the contract says so.
- Base classes have safe no-op fallbacks; required attributes are not
  silently defaulted.
- ``Mapping.validate`` actually fails on empty required fields.
- ``@simple_format_rule`` produces a working ``BaseConventionRule``
  subclass that detects line changes.
"""

from __future__ import annotations

from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from ipa_cli.api import (
    BaseConventionRule,
    BaseSearchChannel,
    FormatContext,
    Hit,
    Issue,
    Mapping,
    Patch,
    Query,
    REQUIRED_FIELDS,
    SearchContext,
    Severity,
    SetupContext,
    Span,
    ValidationContext,
    simple_format_rule,
)
from ipa_cli.parse.note_model import Note


def test_severity_values() -> None:
    assert Severity.INFO == "info"
    assert Severity.WARN == "warn"
    assert Severity.ERROR == "error"


def test_issue_is_frozen() -> None:
    issue = Issue(
        code="ipa.test",
        severity=Severity.INFO,
        note_id="n1",
        message="m",
    )
    assert issue.span is None
    with pytest.raises(FrozenInstanceError):
        issue.code = "ipa.other"  # type: ignore[misc]


def test_patch_is_frozen() -> None:
    patch = Patch(
        note_id="n1",
        span=Span(1, 1, 1, 5),
        replacement="x",
    )
    with pytest.raises(FrozenInstanceError):
        patch.replacement = "y"  # type: ignore[misc]


def test_base_rule_default_scope_and_fallbacks() -> None:
    class MyRule(BaseConventionRule):
        code = "test.my_rule"
        severity = Severity.INFO

    rule = MyRule()
    assert rule.default_scope == "note"
    assert rule.requires_parse_level == 1
    assert rule.check_folder(None) == []  # type: ignore[arg-type]
    assert rule.check_vault(None) == []  # type: ignore[arg-type]
    assert rule.fix(None, None) is None  # type: ignore[arg-type]


def test_base_channel_signature_and_defaults() -> None:
    class MyChannel(BaseSearchChannel):
        name = "test.my_channel"
        description = "for testing"
        default_weight = 0.1

        def search(self, ctx, query):
            return {}

    ch = MyChannel()
    assert ch.name == "test.my_channel"
    assert ch.default_weight == 0.1
    # No-op defaults for setup/prepare.
    ch.setup(None)  # type: ignore[arg-type]
    ch.prepare(Query(raw="hello"))
    assert ch.search(None, Query(raw="hello")) == {}  # type: ignore[arg-type]
    assert ch.explain("note_id") == {}


def test_base_channel_search_required() -> None:
    class Incomplete(BaseSearchChannel):
        name = "test.incomplete"
        description = ""
        default_weight = 0.0

    with pytest.raises(NotImplementedError):
        Incomplete().search(None, Query(raw="x"))  # type: ignore[arg-type]


def test_setup_context_lazy_props_empty_for_empty_vault(tmp_path: Path) -> None:
    """P5: tokens / ref_graph are real (not stubs) but trivially empty."""
    ctx = SetupContext(notes=[], vault_path=tmp_path, cache_dir=tmp_path / ".cache")
    assert ctx.tokens == {}
    assert ctx.ref_graph.edges == {}


def test_mapping_defaults_match_ipa_convention() -> None:
    m = Mapping()
    assert m.note_type == "type"
    assert m.refs == "ref"
    assert m.tags == "tags"
    assert m.created_at == "date_created"
    assert m.updated_at == "date_modified"
    assert m.aliases == "aliases"
    assert m.custom == {}
    m.validate()  # default mapping is valid


def test_mapping_required_fields_constant() -> None:
    assert set(REQUIRED_FIELDS) == {
        "note_type",
        "refs",
        "tags",
        "created_at",
        "updated_at",
    }


def test_mapping_missing_required_fails() -> None:
    m = Mapping(note_type="")  # empty for required field
    with pytest.raises(ValueError, match="note_type"):
        m.validate()


def test_simple_format_rule_creates_rule_subclass() -> None:
    @simple_format_rule(code="ipa.trim", severity=Severity.INFO)
    def trim(line: str) -> str | None:
        s = line.rstrip()
        return s if s != line else None

    assert isinstance(trim, type)
    assert issubclass(trim, BaseConventionRule)
    assert trim.code == "ipa.trim"
    assert trim.severity == Severity.INFO
    assert trim.default_scope == "note"


def test_simple_format_rule_detects_changed_lines(tmp_path: Path) -> None:
    @simple_format_rule(code="ipa.trim_ws")
    def trim(line: str) -> str | None:
        s = line.rstrip()
        return s if s != line else None

    note = Note(
        id="n1",
        path=tmp_path / "n1.md",
        body="hello   \nworld\nfoo  ",
        frontmatter={},
    )
    rule = trim()
    issues = rule.check(None, note)  # type: ignore[arg-type]
    # Lines 1 and 3 have trailing whitespace; line 2 is clean.
    assert [i.span.start_line for i in issues] == [1, 3]
    assert all(i.code == "ipa.trim_ws" for i in issues)
    assert all(i.severity == Severity.INFO for i in issues)


def test_dataclass_contexts_have_expected_fields(tmp_path: Path) -> None:
    mapping = Mapping()
    vctx = ValidationContext(vault_path=tmp_path, notes=[], mapping=mapping)
    assert vctx.folder is None
    fctx = FormatContext(vault_path=tmp_path, notes=[], mapping=mapping)
    assert fctx.mapping is mapping
    sctx = SearchContext(vault_path=tmp_path)
    assert sctx.notes == []


def test_hit_is_frozen() -> None:
    hit = Hit(note_id="n1", score=0.5)
    with pytest.raises(FrozenInstanceError):
        hit.score = 0.9  # type: ignore[misc]

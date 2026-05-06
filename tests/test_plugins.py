"""Tests for plugin registry + built-in auto-registration."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from ipa_cli.plugins import (
    clear,
    get_channels,
    get_refactors,
    get_rules,
    register_channel,
    register_refactor,
    register_rule,
)


@dataclass(frozen=True)
class _Ch:
    name: str
    description: str = ""
    weight: float | None = None


@dataclass(frozen=True)
class _Rl:
    id: str
    category: str = "X"
    description: str = ""


@dataclass(frozen=True)
class _Rf:
    name: str
    description: str = ""


def test_builtin_auto_registration() -> None:
    """Importing ipa_cli.plugins should register all built-ins."""
    channels = get_channels()
    rules = get_rules()
    refactors = get_refactors()

    # 8 channels (DEFAULT_WEIGHTS), 13 rules (RULE_CODES), 7 refactor commands.
    assert len(channels) == 8
    assert len(rules) == 13
    assert len(refactors) == 7

    assert "body_match" in channels
    assert "fuzzy" in channels
    assert "P001" in rules
    assert "ref-replace" in refactors


def test_built_in_channel_has_weight_and_description() -> None:
    body = get_channels()["body_match"]
    assert body.weight is not None and 0.0 < body.weight < 1.0
    assert "BM25" in body.description.upper() or body.description


def test_register_channel_last_wins_on_collision() -> None:
    original = get_channels().get("fuzzy")
    try:
        register_channel(_Ch(name="fuzzy", weight=0.99, description="override"))
        assert get_channels()["fuzzy"].weight == 0.99
        assert get_channels()["fuzzy"].description == "override"
    finally:
        if original is not None:
            register_channel(original)


def test_register_rule_last_wins_on_collision() -> None:
    original = get_rules().get("P001")
    try:
        register_rule(_Rl(id="P001", category="P", description="overridden"))
        assert get_rules()["P001"].description == "overridden"
    finally:
        if original is not None:
            register_rule(original)


def test_clear_then_register(tmp_path) -> None:
    """clear() wipes all three; subsequent register works.

    NB: this isolates from the global state for the duration of the test
    by reseeding built-ins manually after clear().
    """
    # Snapshot
    saved_ch = get_channels()
    saved_rl = get_rules()
    saved_rf = get_refactors()
    try:
        clear()
        assert get_channels() == {}
        assert get_rules() == {}
        assert get_refactors() == {}

        register_channel(_Ch(name="x", weight=0.5))
        register_rule(_Rl(id="X001"))
        register_refactor(_Rf(name="x-cmd"))

        assert "x" in get_channels()
        assert "X001" in get_rules()
        assert "x-cmd" in get_refactors()
    finally:
        clear()
        for ch in saved_ch.values():
            register_channel(ch)
        for rl in saved_rl.values():
            register_rule(rl)
        for rf in saved_rf.values():
            register_refactor(rf)


def test_get_returns_copy_not_live_ref() -> None:
    """Mutating the dict returned by get_*() must not affect the registry."""
    snapshot = get_channels()
    snapshot.pop("fuzzy", None)
    assert "fuzzy" in get_channels()

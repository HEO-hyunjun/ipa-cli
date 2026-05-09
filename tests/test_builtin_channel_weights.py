"""Builtin channel weight wiring."""

from __future__ import annotations

from ipa_cli.builtins.channels.default_channels import default_channels
from ipa_cli.config.defaults import DEFAULT_WEIGHTS


def test_builtin_channel_defaults_match_config_defaults() -> None:
    channels = default_channels()

    assert {ch.name for ch in channels} == set(DEFAULT_WEIGHTS)
    for channel in channels:
        assert channel.default_weight == DEFAULT_WEIGHTS[channel.name]

"""Frozen Settings dataclasses.

Settings is the resolved view passed to commands. It carries the active
profile name, profile workspace, vault path, cache dir, legacy config
path, search settings, and a source map (which key came from which layer)
for `ipa config show --source` debugging.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping


@dataclass(frozen=True)
class SearchSettings:
    threshold: float
    max_results: int
    weights: Mapping[str, float]


@dataclass(frozen=True)
class Settings:
    profile: str
    profile_dir: Path
    vault_path: Path
    cache_dir: Path
    config_path: Path
    search: SearchSettings
    source_map: Mapping[str, str] = field(default_factory=dict)

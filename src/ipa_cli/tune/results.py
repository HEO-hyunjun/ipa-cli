"""Immutable tune result artifacts and the active result pointer.

The 2차 plan treats every tune run's output as an immutable JSON file
under ``profile_workspace/tune/results/{timestamp}.json``. The "currently
active" result is whichever filename ``profile.yaml`` (or the section
under ``profiles[name].tune.result_file`` in the consolidated
``config.yaml``) points at. Rolling back to a past result is just
flipping the pointer — the historical artifacts stay on disk untouched.

Why a separate module:
  - keeps result schema in one place so CLI + loader + tests agree on
    ``threshold / max_results / weights / study`` keys
  - shields ``runner.py`` from ruamel-yaml round-trip concerns; only this
    module updates ``config.yaml``
  - test surface stays small (round-trip / list ordering / pointer
    rewrite) without dragging in Optuna
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ipa_cli.config.defaults import xdg_config_home

TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$")


@dataclass(frozen=True)
class TuneResult:
    """One tune run's output. Mirrors the JSON wire shape exactly."""

    threshold: float
    max_results: int
    weights: dict[str, float]
    study: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "TuneResult":
        return cls(
            threshold=float(payload.get("threshold", 0.30)),
            max_results=int(payload.get("max_results", 10)),
            weights={k: float(v) for k, v in (payload.get("weights") or {}).items()},
            study=dict(payload.get("study") or {}),
        )


def profile_workspace(profile: str) -> Path:
    """Default profile workspace dir under XDG_CONFIG_HOME."""
    return xdg_config_home() / "ipa" / "profiles" / profile


def results_dir(profile: str) -> Path:
    """``{profile_workspace}/tune/results/`` — created on demand."""
    return profile_workspace(profile) / "tune" / "results"


def timestamp_filename(now: datetime | None = None) -> str:
    """``2026-05-07T03-12-44.json`` in UTC. Filesystem-safe (no colons)."""
    moment = now or datetime.now(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H-%M-%S.json")


def save_result(
    profile: str, result: TuneResult, *, filename: str | None = None
) -> Path:
    """Persist ``result`` under the profile's results dir.

    Returns the absolute path of the newly written file. Filename
    defaults to a UTC timestamp; collisions raise rather than silently
    overwrite (immutable contract).
    """
    target_dir = results_dir(profile)
    target_dir.mkdir(parents=True, exist_ok=True)

    name = filename or timestamp_filename()
    if not name.endswith(".json"):
        name = f"{name}.json"
    path = target_dir / name
    if path.exists():
        raise FileExistsError(
            f"refuse to overwrite existing tune result: {path}. "
            "Pass --output a fresh filename or remove it explicitly."
        )

    with path.open("w", encoding="utf-8") as f:
        json.dump(result.to_dict(), f, ensure_ascii=False, indent=2, sort_keys=True)
    return path


def load_result(profile: str, filename: str) -> TuneResult:
    """Read a result file by filename (with or without .json suffix)."""
    name = filename if filename.endswith(".json") else f"{filename}.json"
    path = results_dir(profile) / name
    if not path.is_file():
        raise FileNotFoundError(f"no such tune result: {path}")
    with path.open("r", encoding="utf-8") as f:
        payload = json.load(f)
    return TuneResult.from_dict(payload)


def list_results(profile: str) -> list[str]:
    """Result filenames under the profile, newest-first.

    Sort by filename (timestamp prefix). Files without a parseable
    timestamp prefix sort last in lexical order so ad-hoc names like
    ``experiment_a.json`` show up but don't displace history.
    """
    rd = results_dir(profile)
    if not rd.is_dir():
        return []
    timestamped: list[str] = []
    other: list[str] = []
    for p in rd.iterdir():
        if not p.is_file() or p.suffix != ".json":
            continue
        if TIMESTAMP_RE.match(p.stem):
            timestamped.append(p.name)
        else:
            other.append(p.name)
    timestamped.sort(reverse=True)
    other.sort()
    return timestamped + other


def read_active_result_filename(profile: str, config_path: Path) -> str | None:
    """Return ``profiles.<profile>.tune.result_file`` or ``None``.

    Reads via plain yaml (no comments needed for read path); writes use
    ruamel.yaml round-trip via ``write_active_result_filename``.
    """
    if not config_path.is_file():
        return None
    import yaml

    with config_path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        return None
    profiles = data.get("profiles") or {}
    profile_data = profiles.get(profile) or {}
    tune_section = profile_data.get("tune") or {}
    name = tune_section.get("result_file")
    return name if isinstance(name, str) and name else None


def write_active_result_filename(
    profile: str, filename: str, config_path: Path
) -> None:
    """Set ``profiles.<profile>.tune.result_file = filename`` in-place.

    Uses ruamel.yaml so existing comments and key ordering survive.
    Creates missing parent maps if necessary.
    """
    from ruamel.yaml import YAML

    yaml = YAML()
    yaml.preserve_quotes = True
    if config_path.is_file():
        with config_path.open("r", encoding="utf-8") as f:
            data = yaml.load(f) or {}
    else:
        data = {}

    profiles = data.setdefault("profiles", {})
    profile_data = profiles.setdefault(profile, {})
    tune_section = profile_data.setdefault("tune", {})
    tune_section["result_file"] = filename

    config_path.parent.mkdir(parents=True, exist_ok=True)
    with config_path.open("w", encoding="utf-8") as f:
        yaml.dump(data, f)


def resolve_active_result(profile: str, config_path: Path) -> TuneResult | None:
    """Read the pointer + load the JSON. Missing file → None + caller warns."""
    name = read_active_result_filename(profile, config_path)
    if not name:
        return None
    try:
        return load_result(profile, name)
    except FileNotFoundError:
        return None

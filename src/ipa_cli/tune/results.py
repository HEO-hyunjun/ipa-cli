"""Immutable tune result artifacts and the active result pointer.

Every tune run's output is an immutable JSON file. In the vault-local
layout that lives under ``{vault}/.ipa/tune/results/{timestamp}.json``.
The "currently active" result is whichever path ``{vault}/.ipa/config.yaml``
``weights.file`` points at. Rolling back to a past result is just flipping
the pointer — the historical artifacts stay on disk untouched.

Why a separate module:
  - keeps result schema in one place so CLI + loader + tests agree on
    ``threshold / max_results / weights / study`` keys
  - shields ``runner.py`` from ruamel-yaml round-trip concerns; only this
    module updates the active pointer
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

TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{2})?$")


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


def results_dir(profile: str, *, vault_path: Path | None = None) -> Path:
    """Tune result directory — created on demand by write paths."""
    if vault_path is not None and vault_path != Path():
        return vault_path / ".ipa" / "tune" / "results"
    return profile_workspace(profile) / "tune" / "results"


def profile_yaml_path(profile: str) -> Path:
    """``{profile_workspace}/profile.yaml``."""
    return profile_workspace(profile) / "profile.yaml"


def timestamp_filename(now: datetime | None = None) -> str:
    """``2026-05-07T03-12-44.json`` in UTC. Filesystem-safe (no colons)."""
    moment = now or datetime.now(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H-%M-%S.json")


def vault_config_path(vault_path: Path) -> Path:
    """``{vault}/.ipa/config.yaml``."""
    return vault_path / ".ipa" / "config.yaml"


def _normalise_result_name(filename: str) -> str:
    return filename if filename.endswith(".json") else f"{filename}.json"


def _vault_result_ref(filename: str) -> str:
    p = Path(filename)
    if p.is_absolute():
        return str(p)
    if len(p.parts) == 1:
        return f".ipa/tune/results/{_normalise_result_name(p.name)}"
    return str(p)


def _vault_weight_raw(data: dict[str, Any]) -> str | None:
    weights = data.get("weights") or {}
    if isinstance(weights, dict) and isinstance(weights.get("file"), str):
        return weights["file"]
    weight = data.get("weight") or {}
    if isinstance(weight, dict) and isinstance(weight.get("file"), str):
        return weight["file"]
    if isinstance(data.get("weight_file"), str):
        return data["weight_file"]
    tune = data.get("tune") or {}
    if isinstance(tune, dict):
        for key in ("weight_file", "result_file"):
            if isinstance(tune.get(key), str):
                return tune[key]
    return None


def _resolve_vault_result_path(vault_path: Path, raw: str | None) -> Path | None:
    if not raw:
        return None
    p = Path(raw).expanduser()
    if p.is_absolute():
        return p
    if len(p.parts) == 1:
        return results_dir("adhoc", vault_path=vault_path) / _normalise_result_name(
            p.name
        )
    return vault_path / p


def save_result(
    profile: str,
    result: TuneResult,
    *,
    filename: str | None = None,
    vault_path: Path | None = None,
) -> Path:
    """Persist ``result`` under the active results dir.

    Returns the absolute path of the newly written file. Filename
    defaults to a UTC timestamp; collisions raise rather than silently
    overwrite (immutable contract).
    """
    target_dir = results_dir(profile, vault_path=vault_path)
    target_dir.mkdir(parents=True, exist_ok=True)

    if filename is None:
        base = timestamp_filename()
        stem = base.removesuffix(".json")
        name = base
        counter = 1
        while (target_dir / name).exists():
            name = f"{stem}-{counter:02d}.json"
            counter += 1
    else:
        name = filename
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


def load_result(
    profile: str,
    filename: str,
    *,
    vault_path: Path | None = None,
) -> TuneResult:
    """Read a result file by filename (with or without .json suffix)."""
    name = filename if filename.endswith(".json") else f"{filename}.json"
    path = results_dir(profile, vault_path=vault_path) / name
    if not path.is_file():
        raise FileNotFoundError(f"no such tune result: {path}")
    with path.open("r", encoding="utf-8") as f:
        payload = json.load(f)
    return TuneResult.from_dict(payload)


def list_results(profile: str, *, vault_path: Path | None = None) -> list[str]:
    """Result filenames under the profile, newest-first.

    Sort by filename (timestamp prefix). Files without a parseable
    timestamp prefix sort last in lexical order so ad-hoc names like
    ``experiment_a.json`` show up but don't displace history.
    """
    rd = results_dir(profile, vault_path=vault_path)
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


def read_active_result_filename(
    profile: str,
    config_path: Path | None = None,
    *,
    vault_path: Path | None = None,
) -> str | None:
    """Return the active result filename/path or ``None``.

    With ``vault_path`` this reads ``{vault}/.ipa/config.yaml`` ``weights.file``.
    Without it, the legacy profile-workspace ``tune.result_file`` pointer
    remains supported for migration/tests.
    """
    if vault_path is not None and vault_path != Path():
        path = config_path or vault_config_path(vault_path)
        if not path.is_file():
            return None
        import yaml

        with path.open("r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        if not isinstance(data, dict):
            return None
        resolved = _resolve_vault_result_path(vault_path, _vault_weight_raw(data))
        if resolved is None:
            return None
        try:
            resolved.relative_to(results_dir(profile, vault_path=vault_path))
            return resolved.name
        except ValueError:
            return str(resolved)

    path = profile_yaml_path(profile)
    if not path.is_file():
        return None
    import yaml

    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        return None
    tune_section = data.get("tune") or {}
    name = tune_section.get("result_file")
    return name if isinstance(name, str) and name else None


def write_active_result_filename(
    profile: str,
    filename: str,
    config_path: Path | None = None,
    *,
    vault_path: Path | None = None,
) -> None:
    """Set the active result pointer.

    With ``vault_path`` this updates ``weights.file`` in
    ``{vault}/.ipa/config.yaml``. Without it, legacy ``profile.yaml``
    ``tune.result_file`` is updated.
    """
    from ruamel.yaml import YAML

    yaml = YAML()
    yaml.preserve_quotes = True
    if vault_path is not None and vault_path != Path():
        path = config_path or vault_config_path(vault_path)
        if path.is_file():
            with path.open("r", encoding="utf-8") as f:
                data = yaml.load(f) or {}
        else:
            data = {}
        if not isinstance(data, dict):
            data = {}

        weights_section = data.get("weights")
        if not isinstance(weights_section, dict):
            weights_section = {}
            data["weights"] = weights_section
        weights_section["file"] = _vault_result_ref(filename)

        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as f:
            yaml.dump(data, f)
        return

    path = profile_yaml_path(profile)
    if path.is_file():
        with path.open("r", encoding="utf-8") as f:
            data = yaml.load(f) or {}
    else:
        data = {}

    tune_section = data.setdefault("tune", {})
    tune_section["result_file"] = filename

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        yaml.dump(data, f)


def resolve_active_result(
    profile: str,
    config_path: Path | None = None,
    *,
    vault_path: Path | None = None,
) -> TuneResult | None:
    """Read the pointer + load the JSON. Missing file → None + caller warns."""
    if vault_path is not None and vault_path != Path():
        path = config_path or vault_config_path(vault_path)
        if not path.is_file():
            return None
        import yaml

        with path.open("r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        if not isinstance(data, dict):
            return None
        result_path = _resolve_vault_result_path(vault_path, _vault_weight_raw(data))
        if result_path is None or not result_path.is_file():
            return None
        import json

        with result_path.open("r", encoding="utf-8") as f:
            payload = json.load(f)
        return TuneResult.from_dict(payload)

    name = read_active_result_filename(profile, config_path)
    if not name:
        return None
    try:
        return load_result(profile, name)
    except FileNotFoundError:
        return None

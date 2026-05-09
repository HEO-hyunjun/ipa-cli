"""Schema-like contracts for Python-to-TS migration fixtures."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

CONTRACTS = {
    "config": "vault-local .ipa/config.yaml",
    "cache-manifest": ".ipa/cache/manifest.json",
    "cache-files": ".ipa/cache/files.jsonl",
    "cache-graph": ".ipa/cache/graph.json",
    "search-event": ".ipa/tune/logs/search-events.jsonl record",
    "testset": ".ipa/tune/testsets/*.json",
    "querypack": ".ipa/tune/querypacks/*.json",
    "plan": ".ipa/plans/*.json",
    "plugin-manifest": ".ipa/plugins/* manifest",
    "context-output": "ipa context --format json",
    "review-output": "ipa review all --json",
}


def list_contracts() -> dict:
    return {"contracts": [{"name": k, "description": v} for k, v in CONTRACTS.items()]}


def validate_contract(path: Path, *, vault_path: Path | None = None) -> dict:
    target = _resolve(path, vault_path)
    issues: list[dict] = []
    if not target.is_file():
        issues.append(_issue("contract.file.missing", "error", "file does not exist", "$"))
        return _report(target, _guess_contract(target), issues)
    contract = _guess_contract(target)
    try:
        if target.suffix in {".yaml", ".yml"}:
            payload = yaml.safe_load(target.read_text(encoding="utf-8")) or {}
        elif target.suffix == ".jsonl":
            payload = [
                json.loads(line)
                for line in target.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
        else:
            payload = json.loads(target.read_text(encoding="utf-8"))
    except Exception as exc:
        issues.append(_issue("contract.parse", "error", str(exc), "$"))
        return _report(target, contract, issues)
    _validate_payload(contract, payload, issues)
    return _report(target, contract, issues)


def validate_output(kind: str, path: Path, *, vault_path: Path | None = None) -> dict:
    target = _resolve(path, vault_path)
    issues: list[dict] = []
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
    except Exception as exc:
        issues.append(_issue("contract.output.parse", "error", str(exc), "$"))
        return _report(target, f"{kind}-output", issues)
    if kind == "context":
        _require_keys(payload, ["notes", "edges", "sources", "warnings"], "$", issues)
    elif kind == "review":
        _require_keys(payload, ["issues", "count"], "$", issues)
    else:
        issues.append(_issue("contract.output.unknown", "error", f"unknown output kind: {kind}", "$"))
    return _report(target, f"{kind}-output", issues)


def export_fixtures(target: Path, *, vault_path: Path) -> dict:
    dest = target if target.is_absolute() else vault_path / target
    dest.mkdir(parents=True, exist_ok=True)
    fixtures = {
        "context.json": {"query": "ipa cli", "notes": [], "edges": [], "sources": [], "warnings": []},
        "review.json": {"scope": "all", "issues": [], "count": 0},
        "link-plan.json": {"version": 1, "kind": "link", "changes": []},
        "cache-manifest.json": {"version": 1, "files": 0, "graph_nodes": 0},
    }
    written = []
    for name, payload in fixtures.items():
        path = dest / name
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        written.append(path.relative_to(vault_path).as_posix())
    return {"target": dest.relative_to(vault_path).as_posix(), "written": written}


def render_contract(payload: dict, *, json_output: bool = False) -> str:
    if json_output:
        return json.dumps(payload, ensure_ascii=False, indent=2)
    if "contracts" in payload:
        return "\n".join(f"{item['name']}: {item['description']}" for item in payload["contracts"])
    if "written" in payload:
        return "\n".join([f"target: {payload['target']}", *[f"- {p}" for p in payload["written"]]])
    lines = [f"contract: {payload.get('contract')}", f"status: {payload.get('status')}"]
    for issue in payload.get("issues") or []:
        lines.append(f"- {issue['severity']} {issue['code']} {issue['path']}: {issue['message']}")
    return "\n".join(lines)


def _resolve(path: Path, vault_path: Path | None) -> Path:
    if path.is_absolute() or vault_path is None:
        return path
    return vault_path / path


def _guess_contract(path: Path) -> str:
    text = path.as_posix()
    if text.endswith(".ipa/config.yaml"):
        return "config"
    if text.endswith("manifest.json"):
        return "cache-manifest"
    if text.endswith("files.jsonl"):
        return "cache-files"
    if text.endswith("graph.json"):
        return "cache-graph"
    if "querypacks" in text:
        return "querypack"
    if "testsets" in text:
        return "testset"
    if "plans" in text:
        return "plan"
    if "plugins" in text:
        return "plugin-manifest"
    return path.stem


def _validate_payload(contract: str, payload: Any, issues: list[dict]) -> None:
    if contract == "config":
        _require_mapping(payload, "$", issues)
        if isinstance(payload, dict) and "mapping" in payload:
            _require_mapping(payload["mapping"], "$.mapping", issues)
    elif contract == "cache-manifest":
        _require_keys(payload, ["version", "files"], "$", issues)
    elif contract == "cache-files":
        if not isinstance(payload, list):
            issues.append(_issue("contract.type", "error", "expected JSONL records", "$"))
        for idx, record in enumerate(payload if isinstance(payload, list) else []):
            _require_keys(record, ["path", "sha256"], f"$[{idx}]", issues)
            if isinstance(record, dict) and str(record.get("path", "")).startswith("/"):
                issues.append(_issue("contract.path.absolute", "error", "path must be vault-relative", f"$[{idx}].path"))
    elif contract == "cache-graph":
        _require_keys(payload, ["version", "edges"], "$", issues)
    elif contract == "plan":
        _require_keys(payload, ["version", "kind"], "$", issues)
    elif contract in {"testset", "querypack"}:
        _require_mapping(payload, "$", issues)
    elif contract == "plugin-manifest":
        _require_mapping(payload, "$", issues)
    else:
        _require_mapping(payload, "$", issues)


def _require_mapping(payload: Any, path: str, issues: list[dict]) -> None:
    if not isinstance(payload, dict):
        issues.append(_issue("contract.type", "error", "expected object", path))


def _require_keys(payload: Any, keys: list[str], path: str, issues: list[dict]) -> None:
    if not isinstance(payload, dict):
        issues.append(_issue("contract.type", "error", "expected object", path))
        return
    for key in keys:
        if key not in payload:
            issues.append(_issue("contract.required", "error", f"missing key {key!r}", f"{path}.{key}"))


def _issue(code: str, severity: str, message: str, path: str) -> dict:
    return {"code": code, "severity": severity, "message": message, "path": path}


def _report(path: Path, contract: str, issues: list[dict]) -> dict:
    return {
        "contract": contract,
        "path": path.as_posix(),
        "status": "error" if any(i["severity"] == "error" for i in issues) else "ok",
        "issues": issues,
    }

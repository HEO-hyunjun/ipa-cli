"""Codex/Claude harness installation and vault write guard helpers."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Mapping

HARNESS_MARKER = "managed-by: ipa harness"
ACTOR_ENV_KEYS = (
    "IPA_WRITE_ACTOR",
    "IPA_SEARCH_ACTOR",
    "IPA_ACTOR",
    "CODEX_SANDBOX",
    "CLAUDECODE",
)


def detect_actor(env: Mapping[str, str] | None = None) -> str:
    env = env or os.environ
    for key in ("IPA_WRITE_ACTOR", "IPA_SEARCH_ACTOR", "IPA_ACTOR"):
        value = env.get(key)
        if value:
            return value.lower()
    if env.get("CODEX_SANDBOX") or env.get("CODEX_HOME"):
        return "codex"
    if env.get("CLAUDECODE") or env.get("CLAUDE_HOME"):
        return "claude"
    return "human"


def harness_home(kind: str, env: Mapping[str, str] | None = None) -> Path:
    env = env or os.environ
    if kind == "codex":
        return Path(env.get("CODEX_HOME", "~/.codex")).expanduser()
    if kind == "claude":
        return Path(env.get("CLAUDE_HOME", "~/.claude")).expanduser()
    raise ValueError(f"unknown harness kind: {kind}")


def harness_status(kind: str, *, vault_path: Path, env: Mapping[str, str] | None = None) -> dict:
    home = harness_home(kind, env)
    skill_path = home / "skills" / "ipa" / "SKILL.md"
    hook_path = home / "hooks" / "ipa-context-writer.py"
    guard_path = guard_policy_path(vault_path)
    return {
        "kind": kind,
        "home": str(home),
        "skill_installed": skill_path.is_file(),
        "skill_path": str(skill_path),
        "hook_installed": hook_path.is_file(),
        "hook_path": str(hook_path),
        "guard_installed": guard_path.is_file(),
        "guard_path": guard_path.relative_to(vault_path).as_posix()
        if guard_path.is_absolute() and vault_path in guard_path.parents
        else str(guard_path),
        "actor": detect_actor(env),
        "env": {
            key: bool((env or os.environ).get(key))
            for key in (
                "IPA_SEARCH_LOG",
                "IPA_SEARCH_ACTOR",
                "IPA_SEARCH_CONTEXT_AUTO",
                "IPA_SEARCH_CONTEXT_DIR",
            )
        },
    }


def install_harness(kind: str, *, vault_path: Path, env: Mapping[str, str] | None = None) -> dict:
    home = harness_home(kind, env)
    skill_path = home / "skills" / "ipa" / "SKILL.md"
    hook_path = home / "hooks" / "ipa-context-writer.py"
    skill_path.parent.mkdir(parents=True, exist_ok=True)
    hook_path.parent.mkdir(parents=True, exist_ok=True)
    skill_path.write_text(_skill_text(kind), encoding="utf-8")
    hook_path.write_text(_hook_text(), encoding="utf-8")
    return harness_status(kind, vault_path=vault_path, env=env)


def uninstall_harness(kind: str, *, vault_path: Path, env: Mapping[str, str] | None = None) -> dict:
    home = harness_home(kind, env)
    for path in (home / "skills" / "ipa" / "SKILL.md", home / "hooks" / "ipa-context-writer.py"):
        if path.is_file() and HARNESS_MARKER in path.read_text(encoding="utf-8"):
            path.unlink()
    return harness_status(kind, vault_path=vault_path, env=env)


def guard_policy_path(vault_path: Path) -> Path:
    return vault_path.expanduser() / ".ipa" / "harness" / "archive-write-guard.json"


def install_archive_guard(vault_path: Path) -> dict:
    path = guard_policy_path(vault_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    policy = {
        "version": 1,
        "name": "archive-write",
        "actors": ["codex", "claude"],
        "allow_new_under": ["00 Inbox"],
        "deny_new_under": ["02 Archive"],
        "allow_existing_edit": True,
        "allow_source": ["ipa_inbox_add"],
    }
    path.write_text(json.dumps(policy, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"installed": True, "path": path.relative_to(vault_path).as_posix(), "policy": policy}


def guard_status(vault_path: Path) -> dict:
    path = guard_policy_path(vault_path)
    if not path.is_file():
        return {"installed": False, "path": ".ipa/harness/archive-write-guard.json"}
    return {
        "installed": True,
        "path": ".ipa/harness/archive-write-guard.json",
        "policy": json.loads(path.read_text(encoding="utf-8")),
    }


def check_archive_write_guard(
    vault_path: Path,
    target_path: Path,
    *,
    operation: str = "create",
    actor: str | None = None,
    source: str | None = None,
) -> dict:
    """Return allow/deny for an AI actor attempting to write a vault note."""
    vault = vault_path.expanduser().resolve()
    target = target_path.expanduser()
    if not target.is_absolute():
        target = vault / target
    target = target.resolve()
    actor = (actor or detect_actor()).lower()
    policy = (guard_status(vault).get("policy") or {}) if guard_policy_path(vault).is_file() else {}
    guarded_actors = set(policy.get("actors") or ["codex", "claude"])
    if actor not in guarded_actors:
        return {"allowed": True, "reason": "actor-not-guarded", "actor": actor}
    try:
        rel = target.relative_to(vault).as_posix()
    except ValueError:
        return {"allowed": True, "reason": "outside-vault", "actor": actor}
    if not rel.endswith(".md"):
        return {"allowed": True, "reason": "non-markdown", "actor": actor, "path": rel}
    if source in set(policy.get("allow_source") or []):
        return {"allowed": True, "reason": "allowed-source", "actor": actor, "path": rel}
    if operation == "edit" or target.exists():
        return {"allowed": True, "reason": "existing-edit", "actor": actor, "path": rel}
    allow_prefixes = tuple(f"{p.rstrip('/')}/" for p in policy.get("allow_new_under") or ["00 Inbox"])
    if rel.startswith(allow_prefixes):
        return {"allowed": True, "reason": "allowed-new-location", "actor": actor, "path": rel}
    deny_prefixes = tuple(f"{p.rstrip('/')}/" for p in policy.get("deny_new_under") or ["02 Archive"])
    reason = "archive-new-note-denied" if rel.startswith(deny_prefixes) else "new-note-outside-inbox-denied"
    return {
        "allowed": False,
        "reason": reason,
        "actor": actor,
        "path": rel,
        "hint": "Use `ipa inbox add FILE` for new vault notes.",
    }


def render_json(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


def _skill_text(kind: str) -> str:
    return f"""---
name: ipa
description: IPA vault helper installed for {kind}
---

# IPA

<!-- {HARNESS_MARKER} -->

Search the vault before answering IPA-related requests and create new notes through `ipa inbox add`.
"""


def _hook_text() -> str:
    return f"""#!/usr/bin/env python3
# {HARNESS_MARKER}
import json
import os
from pathlib import Path

target = Path(os.environ.get("IPA_SEARCH_CONTEXT_DIR", "/tmp/ipa-search-context"))
target.mkdir(parents=True, exist_ok=True)
(target / "current.json").write_text(json.dumps({{"actor": os.environ.get("IPA_SEARCH_ACTOR")}}, ensure_ascii=False), encoding="utf-8")
"""

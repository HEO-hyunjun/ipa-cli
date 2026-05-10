"""Regression coverage for the 4th extension command surface."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest
from typer.testing import CliRunner

from ipa_cli.main import app


@pytest.fixture
def vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    for key in list(os.environ.keys()):
        if key.startswith("IPA_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))
    root = tmp_path / "vault"
    (root / "00 Inbox").mkdir(parents=True)
    (root / "01 Project").mkdir()
    (root / "02 Archive").mkdir()
    (root / ".ipa").mkdir()
    (root / ".ipa" / "config.yaml").write_text(
        """
mapping:
  fields:
    note_type: type
    refs: ref
    tags: tags
    created_at: date_created
    updated_at: date_modified
    aliases: aliases
  folders:
    inbox: 00 Inbox
    project: 01 Project
    archive: 02 Archive
""",
        encoding="utf-8",
    )
    _note(
        root / "00 Inbox" / "Alpha.md",
        "note",
        ["[[🔖 Topic Index]]"],
        ["Bad-Tag"],
        "Alpha mentions Beta in plain text.\n",
    )
    _note(
        root / "00 Inbox" / "Beta.md",
        "note",
        ["[[🔖 Topic Index]]"],
        ["note"],
        "Beta links to [[Alpha]].\n",
    )
    _note(
        root / "01 Project" / "🔖 Topic Index.md",
        "index",
        ["[[🏷️ Topic Root]]"],
        ["index"],
        "- [[Alpha]]\n- [[Beta]]\n",
    )
    _note(
        root / "01 Project" / "🏷️ Topic Root.md",
        "root",
        [],
        ["root"],
        "Root.\n",
    )
    return root


def _note(path: Path, type_: str, refs: list[str], tags: list[str], body: str) -> None:
    path.write_text(
        "---\n"
        "date_created: 2026/05/10 (Sun) 00:00:00\n"
        "date_modified: 2026/05/10 (Sun) 00:00:00\n"
        "obsidianUIMode: preview\n"
        f"ref: {refs!r}\n"
        f"tags: {tags!r}\n"
        f"type: {type_}\n"
        "---\n"
        f"{body}",
        encoding="utf-8",
    )


def _run(vault: Path, *args: str):
    return CliRunner().invoke(app, ["--vault", str(vault), *args])


def test_doctor_context_cache_contract_and_review(vault: Path) -> None:
    doctor = _run(vault, "doctor", "--json")
    assert doctor.exit_code == 0, doctor.stdout
    assert json.loads(doctor.stdout)["checks"]["notes"] == 4

    fixed = _run(vault, "doctor", "--fix-dirs", "--json")
    assert fixed.exit_code == 0, fixed.stdout
    for rel in (".ipa/cache", ".ipa/tune", ".ipa/plugins"):
        assert (vault / rel).is_dir()

    bad_cache = vault / ".ipa" / "cache" / "bad.json"
    bad_cache.write_text(json.dumps({"path": str(vault / "00 Inbox" / "Alpha.md")}), encoding="utf-8")
    absolute_path_check = _run(vault, "doctor", "--check", "absolute-paths", "--json")
    assert absolute_path_check.exit_code == 1
    assert any(
        issue["code"] == "doctor.cache.absolute_path"
        for issue in json.loads(absolute_path_check.stdout)["issues"]
    )
    bad_cache.unlink()

    context = _run(vault, "context", "Alpha", "--by-note", "--format", "json")
    assert context.exit_code == 0, context.stdout
    payload = json.loads(context.stdout)
    assert {"notes", "edges", "sources", "warnings"} <= set(payload)
    assert str(vault) not in context.stdout

    rebuilt = _run(vault, "cache", "rebuild", "--json")
    assert rebuilt.exit_code == 0, rebuilt.stdout
    assert (vault / ".ipa" / "cache" / "manifest.json").is_file()
    assert json.loads(rebuilt.stdout)["manifest"]["plugin_fingerprint"]
    assert str(vault) not in (vault / ".ipa" / "cache" / "files.jsonl").read_text(
        encoding="utf-8"
    )

    cache_doctor = _run(vault, "cache", "doctor", "--json")
    assert cache_doctor.exit_code == 0, cache_doctor.stdout

    inspected = _run(vault, "cache", "inspect", "--note", "Alpha", "--json")
    assert inspected.exit_code == 0, inspected.stdout
    assert json.loads(inspected.stdout)["sha256"]

    beta_path = vault / "00 Inbox" / "Beta.md"
    beta_path.write_text(beta_path.read_text(encoding="utf-8") + "\nChanged.\n", encoding="utf-8")
    cache_status = _run(vault, "cache", "status", "--json")
    assert cache_status.exit_code == 0, cache_status.stdout
    assert json.loads(cache_status.stdout)["stale"][0]["reason"] == "hash_changed"

    cache_clean = _run(vault, "cache", "clean", "--stale", "--json")
    assert cache_clean.exit_code == 0, cache_clean.stdout
    assert json.loads(cache_clean.stdout)["removed"] == 1

    plugin_file = vault / ".ipa" / "plugins" / "search" / "new_channel.py"
    plugin_file.parent.mkdir(parents=True, exist_ok=True)
    plugin_file.write_text("channels = []\n", encoding="utf-8")
    plugin_cache_status = _run(vault, "cache", "status", "--json")
    assert plugin_cache_status.exit_code == 0, plugin_cache_status.stdout
    assert any(
        item["reason"] == "plugin_fingerprint_changed"
        for item in json.loads(plugin_cache_status.stdout)["stale"]
    )
    plugin_cache_clean = _run(vault, "cache", "clean", "--stale", "--json")
    assert plugin_cache_clean.exit_code == 0, plugin_cache_clean.stdout

    contract = _run(vault, "contract", "validate", ".ipa/cache/manifest.json", "--json")
    assert contract.exit_code == 0, contract.stdout

    review = _run(vault, "review", "all", "--suggest-refactor", "--json")
    assert review.exit_code == 0, review.stdout
    issues = json.loads(review.stdout)["issues"]
    assert any(issue.get("refactor_command") for issue in issues)


def test_harness_guard_blocks_archive_new_note(vault: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))
    monkeypatch.setenv("CLAUDE_HOME", str(tmp_path / "claude-home"))
    status = _run(vault, "harness", "install", "codex", "--json")
    assert status.exit_code == 0, status.stdout
    payload = json.loads(status.stdout)
    assert payload["skill_installed"] is True
    assert payload["hook_installed"] is True
    assert "export IPA_SEARCH_LOG=1" in payload["env_exports"]
    assert payload["permission_snippet"]["allow"]

    hook_path = tmp_path / "codex-home" / "hooks" / "ipa-context-writer.py"
    context_dir = tmp_path / "search-context"
    subprocess.run(
        [sys.executable, str(hook_path)],
        input=json.dumps({"prompt": "How should ipa cli work?"}),
        text=True,
        check=True,
        env={
            **os.environ,
            "IPA_SEARCH_CONTEXT_DIR": str(context_dir),
            "IPA_SEARCH_ACTOR": "codex",
        },
    )
    context = json.loads((context_dir / "codex" / "current.json").read_text(encoding="utf-8"))
    assert context["actor"] == "codex"
    assert context["turn_id"]
    assert context["user_query"] == "How should ipa cli work?"

    claude_install = _run(vault, "harness", "install", "claude", "--json")
    assert claude_install.exit_code == 0, claude_install.stdout
    claude_payload = json.loads(claude_install.stdout)
    assert claude_payload["skill_installed"] is True
    assert claude_payload["permission_snippet"]["home"] == "CLAUDE_HOME"

    guard = _run(vault, "harness", "guard", "install", "archive-write", "--json")
    assert guard.exit_code == 0, guard.stdout

    denied = _run(
        vault,
        "harness",
        "guard",
        "check",
        "02 Archive/New Note.md",
        "--actor",
        "codex",
        "--json",
    )
    assert denied.exit_code == 1
    assert json.loads(denied.stdout)["allowed"] is False

    allowed = _run(
        vault,
        "harness",
        "guard",
        "check",
        "00 Inbox/New Note.md",
        "--actor",
        "codex",
        "--json",
    )
    assert allowed.exit_code == 0, allowed.stdout
    assert json.loads(allowed.stdout)["allowed"] is True

    (vault / "02 Archive" / "Existing.md").write_text("existing\n", encoding="utf-8")
    edit_allowed = _run(
        vault,
        "harness",
        "guard",
        "check",
        "02 Archive/Existing.md",
        "--operation",
        "edit",
        "--actor",
        "codex",
        "--json",
    )
    assert edit_allowed.exit_code == 0, edit_allowed.stdout
    assert json.loads(edit_allowed.stdout)["reason"] == "existing-edit"

    inbox_add_allowed = _run(
        vault,
        "harness",
        "guard",
        "check",
        "02 Archive/New Note.md",
        "--actor",
        "codex",
        "--source",
        "ipa_inbox_add",
        "--json",
    )
    assert inbox_add_allowed.exit_code == 0, inbox_add_allowed.stdout
    assert json.loads(inbox_add_allowed.stdout)["reason"] == "allowed-source"

    codex_uninstall = _run(vault, "harness", "uninstall", "codex", "--json")
    assert codex_uninstall.exit_code == 0, codex_uninstall.stdout
    assert json.loads(codex_uninstall.stdout)["skill_installed"] is False
    claude_uninstall = _run(vault, "harness", "uninstall", "claude", "--json")
    assert claude_uninstall.exit_code == 0, claude_uninstall.stdout
    assert json.loads(claude_uninstall.stdout)["skill_installed"] is False


def test_link_rename_move_and_inbox_triage(vault: Path) -> None:
    plan_path = Path(".ipa/plans/link-alpha.json")
    planned = _run(vault, "link", "plan", "--note", "Alpha", "--output", str(plan_path), "--json")
    assert planned.exit_code == 0, planned.stdout
    assert json.loads(planned.stdout)["changes"]

    alpha_path = vault / "00 Inbox" / "Alpha.md"
    alpha_path.write_text(alpha_path.read_text(encoding="utf-8") + "\nPlan drift.\n", encoding="utf-8")
    stale_apply = _run(vault, "link", "apply", str(plan_path), "--json")
    assert stale_apply.exit_code == 1
    assert json.loads(stale_apply.stdout)["errors"][0]["error"] == "hash_changed"

    planned = _run(vault, "link", "plan", "--note", "Alpha", "--output", str(plan_path), "--json")
    assert planned.exit_code == 0, planned.stdout
    applied = _run(vault, "link", "apply", str(plan_path), "--json")
    assert applied.exit_code == 0, applied.stdout
    assert "[[Beta]]" in (vault / "00 Inbox" / "Alpha.md").read_text(encoding="utf-8")

    rename = _run(vault, "rename", "Beta", "Gamma", "--apply", "--json")
    assert rename.exit_code == 0, rename.stdout
    assert (vault / "00 Inbox" / "Gamma.md").is_file()
    assert "[[Gamma]]" in (vault / "00 Inbox" / "Alpha.md").read_text(encoding="utf-8")

    move = _run(vault, "move", "Gamma", "02 Archive", "--apply", "--json")
    assert move.exit_code == 0, move.stdout
    assert (vault / "02 Archive" / "Gamma.md").is_file()

    search = _run(vault, "search", "Gamma", "--all")
    assert search.exit_code == 0, search.stdout
    assert "Gamma" in search.stdout

    traversal = _run(vault, "traversal", "--up", "Gamma")
    assert traversal.exit_code == 0, traversal.stdout
    assert "🔖 Topic Index" in traversal.stdout

    triage = _run(vault, "inbox", "triage", "--json")
    assert triage.exit_code == 0, triage.stdout
    assert json.loads(triage.stdout)[0]["target_folder"] == "02 Archive"

    triage_apply = _run(vault, "inbox", "triage", "--apply", "--json")
    assert triage_apply.exit_code == 0, triage_apply.stdout
    assert json.loads(triage_apply.stdout)["moved"] == ["02 Archive/Alpha.md"]
    moved_text = (vault / "02 Archive" / "Alpha.md").read_text(encoding="utf-8")
    modified_line = next(line for line in moved_text.splitlines() if line.startswith("date_modified:"))
    assert "T" in modified_line


def test_plugin_dry_run_surfaces_search_lint_and_formatter(vault: Path) -> None:
    _note(
        vault / "00 Inbox" / "Some Note.md",
        "note",
        ["[[🔖 Topic Index]]"],
        ["note"],
        "Some note body.\n",
    )
    plugin_root = vault / ".ipa" / "plugins"
    (plugin_root / "search").mkdir(parents=True)
    (plugin_root / "lint").mkdir()
    (plugin_root / "formatter").mkdir()
    (plugin_root / "search" / "my-channel.py").write_text(
        """
from typing import ClassVar
from ipa_cli.api.base_channels import BaseSearchChannel

class SampleChannel(BaseSearchChannel):
    name: ClassVar[str] = "sample"
    description: ClassVar[str] = "sample"
    default_weight: ClassVar[float] = 1.0
    def search(self, ctx, query):
        return {note.id: 1.0 for note in ctx.notes if query.raw.lower() in note.id.lower()}

channels = [SampleChannel()]
""",
        encoding="utf-8",
    )
    (plugin_root / "lint" / "test_rule.py").write_text(
        """
from typing import ClassVar
from ipa_cli.api.base_rules import BaseConventionRule, Issue, Severity

class SampleRule(BaseConventionRule):
    code: ClassVar[str] = "sample.issue"
    severity: ClassVar[Severity] = Severity.WARN
    def check(self, ctx, note):
        return [Issue(self.code, self.severity, note.id, "sample issue")]

rules = [SampleRule()]
""",
        encoding="utf-8",
    )
    (plugin_root / "formatter" / "fix-frontmatter.py").write_text(
        """
from typing import ClassVar
from ipa_cli.api.base_rules import BaseConventionRule, Issue, Patch, Severity, Span

class SampleFormatter(BaseConventionRule):
    code: ClassVar[str] = "sample.format"
    severity: ClassVar[Severity] = Severity.WARN
    def check(self, ctx, note):
        return [Issue(self.code, self.severity, note.id, "format")]
    def fix(self, ctx, issue):
        return [Patch(issue.note_id, Span(1, 1, 1, 1), "X")]

rules = [SampleFormatter()]
""",
        encoding="utf-8",
    )

    listed = _run(vault, "plugin", "list", "--json")
    assert listed.exit_code == 0, listed.stdout
    assert len(json.loads(listed.stdout)["plugins"]) == 3

    search = _run(
        vault,
        "plugin",
        "dry-run",
        "search",
        ".ipa/plugins/search/my-channel.py",
        "--query",
        "Some",
        "--json",
    )
    assert search.exit_code == 0, search.stdout
    assert json.loads(search.stdout)["results"][0]["note"] == "Some Note"

    lint = _run(
        vault,
        "plugin",
        "dry-run",
        "lint",
        ".ipa/plugins/lint/test_rule.py",
        "--note",
        "Some Note",
        "--json",
    )
    assert lint.exit_code == 0, lint.stdout
    assert json.loads(lint.stdout)["issues"][0]["code"] == "sample.issue"

    formatter = _run(
        vault,
        "plugin",
        "dry-run",
        "formatter",
        ".ipa/plugins/formatter/fix-frontmatter.py",
        "--note",
        "Some Note",
        "--json",
    )
    assert formatter.exit_code == 0, formatter.stdout
    formatter_payload = json.loads(formatter.stdout)
    assert formatter_payload["patches"][0]["replacement"] == "X"
    assert formatter_payload["diff"]


def test_contract_export_and_validate_output(vault: Path) -> None:
    exported = _run(
        vault,
        "contract",
        "export-fixtures",
        "--target",
        ".ipa/fixtures/contracts",
        "--json",
    )
    assert exported.exit_code == 0, exported.stdout
    assert (vault / ".ipa" / "fixtures" / "contracts" / "context.json").is_file()

    valid = _run(
        vault,
        "contract",
        "validate-output",
        "context",
        ".ipa/fixtures/contracts/context.json",
        "--json",
    )
    assert valid.exit_code == 0, valid.stdout


def test_builtin_ipa_cli_core_pack_eval_falls_back_when_missing(vault: Path) -> None:
    result = _run(vault, "tune", "pack", "eval", "ipa-cli-core")
    assert result.exit_code == 0, result.stdout
    assert "pack ipa-cli-core" in result.stdout

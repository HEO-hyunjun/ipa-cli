"""Regression coverage for the 4th extension command surface."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from ipa_cli.main import app


@pytest.fixture
def vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    for key in list(__import__("os").environ.keys()):
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

    context = _run(vault, "context", "Alpha", "--by-note", "--format", "json")
    assert context.exit_code == 0, context.stdout
    payload = json.loads(context.stdout)
    assert {"notes", "edges", "sources", "warnings"} <= set(payload)
    assert str(vault) not in context.stdout

    rebuilt = _run(vault, "cache", "rebuild", "--json")
    assert rebuilt.exit_code == 0, rebuilt.stdout
    assert (vault / ".ipa" / "cache" / "manifest.json").is_file()
    assert str(vault) not in (vault / ".ipa" / "cache" / "files.jsonl").read_text(
        encoding="utf-8"
    )

    cache_doctor = _run(vault, "cache", "doctor", "--json")
    assert cache_doctor.exit_code == 0, cache_doctor.stdout

    contract = _run(vault, "contract", "validate", ".ipa/cache/manifest.json", "--json")
    assert contract.exit_code == 0, contract.stdout

    review = _run(vault, "review", "all", "--suggest-refactor", "--json")
    assert review.exit_code == 0, review.stdout
    issues = json.loads(review.stdout)["issues"]
    assert any(issue.get("refactor_command") for issue in issues)


def test_harness_guard_blocks_archive_new_note(vault: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))
    status = _run(vault, "harness", "install", "codex", "--json")
    assert status.exit_code == 0, status.stdout
    payload = json.loads(status.stdout)
    assert payload["skill_installed"] is True
    assert payload["hook_installed"] is True

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


def test_link_rename_move_and_inbox_triage(vault: Path, tmp_path: Path) -> None:
    plan_path = Path(".ipa/plans/link-alpha.json")
    planned = _run(vault, "link", "plan", "--note", "Alpha", "--output", str(plan_path), "--json")
    assert planned.exit_code == 0, planned.stdout
    assert json.loads(planned.stdout)["changes"]

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

    triage = _run(vault, "inbox", "triage", "--json")
    assert triage.exit_code == 0, triage.stdout
    assert json.loads(triage.stdout)[0]["target_folder"] == "02 Archive"


def test_plugin_dry_run_surfaces_search_lint_and_formatter(vault: Path) -> None:
    plugin_root = vault / ".ipa" / "plugins"
    (plugin_root / "search").mkdir(parents=True)
    (plugin_root / "lint").mkdir()
    (plugin_root / "formatter").mkdir()
    (plugin_root / "search" / "sample.py").write_text(
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
    (plugin_root / "lint" / "sample.py").write_text(
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
    (plugin_root / "formatter" / "sample.py").write_text(
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
        ".ipa/plugins/search/sample.py",
        "--query",
        "Alpha",
        "--json",
    )
    assert search.exit_code == 0, search.stdout
    assert json.loads(search.stdout)["results"][0]["note"] == "Alpha"

    lint = _run(
        vault,
        "plugin",
        "dry-run",
        "lint",
        ".ipa/plugins/lint/sample.py",
        "--note",
        "Alpha",
        "--json",
    )
    assert lint.exit_code == 0, lint.stdout
    assert json.loads(lint.stdout)["issues"][0]["code"] == "sample.issue"

    formatter = _run(
        vault,
        "plugin",
        "dry-run",
        "formatter",
        ".ipa/plugins/formatter/sample.py",
        "--note",
        "Alpha",
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

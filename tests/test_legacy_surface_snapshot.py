"""Characterization tests for the 8 legacy commands (S0).

The plan note (`IPA CLI legacy surface 내부 재구현 계획`) makes these
snapshots the truth source for every later stage: each S1–S7 commit
must keep the ANSI-stripped stdout (decision #1), the search 3-tier
parity (decision #3), and the validator structured payload (decision
#4) intact.

Run ``UPDATE_GOLDENS=1 uv run pytest tests/test_legacy_surface_snapshot.py``
to (re)generate the golden files. The captured outputs come from the
1차 ``core/`` modules — that's the parity oracle decision #5 keeps
alive until S7.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from typer.testing import CliRunner

from ipa_cli.main import app
from tests.legacy_surface.helpers import (
    IssueRow,
    assert_search_equivalent,
    assert_stdout_matches,
    assert_validator_structured_equal,
    normalize,
)

FIXTURE_VAULT = Path(__file__).parent / "fixtures" / "mini_vault"


@pytest.fixture
def vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Copy mini_vault under tmp_path with isolated XDG dirs.

    Legacy modules write a notes cache relative to the active cache_dir;
    pinning XDG_CACHE_HOME to tmp_path keeps the user's real cache
    untouched and makes each test deterministic.
    """
    target = tmp_path / "vault"
    shutil.copytree(FIXTURE_VAULT, target)

    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg-cfg"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))
    monkeypatch.delenv("IPA_PROFILE", raising=False)
    monkeypatch.delenv("IPA_VAULT_PATH", raising=False)
    monkeypatch.delenv("IPA_CACHE_DIR", raising=False)
    return target


def _invoke(vault: Path, *args: str) -> str:
    runner = CliRunner()
    res = runner.invoke(app, ["--vault", str(vault), *args])
    assert res.exit_code == 0, f"exit={res.exit_code}\n--- stdout ---\n{res.stdout}"
    return res.stdout


# ── byte-identical (after strip) — decision #1 ────────────────────────────


def test_list_channels_snapshot(vault: Path) -> None:
    out = _invoke(vault, "list-channels")
    assert_stdout_matches(out, vault=vault, golden_name="list_channels")


def test_list_rules_snapshot(vault: Path) -> None:
    out = _invoke(vault, "list-rules")
    assert_stdout_matches(out, vault=vault, golden_name="list_rules")


def test_list_refactors_snapshot(vault: Path) -> None:
    out = _invoke(vault, "list-refactors")
    assert_stdout_matches(out, vault=vault, golden_name="list_refactors")


def test_view_overview_snapshot(vault: Path) -> None:
    out = _invoke(vault, "view", "Note A")
    assert_stdout_matches(out, vault=vault, golden_name="view_note_a_overview")


def test_view_section_snapshot(vault: Path) -> None:
    out = _invoke(vault, "view", "Note A", "--section", "Section X")
    assert_stdout_matches(out, vault=vault, golden_name="view_note_a_section_x")


def test_view_full_snapshot(vault: Path) -> None:
    out = _invoke(vault, "view", "Note A", "--full")
    assert_stdout_matches(out, vault=vault, golden_name="view_note_a_full")


def test_traversal_up_snapshot(vault: Path) -> None:
    out = _invoke(vault, "traversal", "--up", "Note A")
    assert_stdout_matches(out, vault=vault, golden_name="traversal_up_note_a")


def test_traversal_down_snapshot(vault: Path) -> None:
    out = _invoke(vault, "traversal", "--down", "🔖 Sample Index")
    assert_stdout_matches(out, vault=vault, golden_name="traversal_down_sample_index")


@pytest.mark.skip(
    reason=(
        "1차 vault_traversal.get_siblings references VaultNote.title which "
        "doesn't exist — the legacy command always crashes. S3 ships a "
        "working implementation tested directly in test_legacy_traversal."
    )
)
def test_traversal_siblings_snapshot(vault: Path) -> None:
    out = _invoke(vault, "traversal", "--siblings", "Note A")
    assert_stdout_matches(out, vault=vault, golden_name="traversal_siblings_note_a")


def test_traversal_root_snapshot(vault: Path) -> None:
    out = _invoke(vault, "traversal", "--root", "Note A")
    assert_stdout_matches(out, vault=vault, golden_name="traversal_root_note_a")


# ── search 3-tier — decision #3 ───────────────────────────────────────────


def _parse_search_hits(stdout: str, vault: Path | None = None) -> list[str]:
    """Pull note IDs out of legacy ``vault_search`` stdout.

    The 1차 format prints each hit as ``  <score>  <note name>  …`` —
    we just look at the first non-numeric token group on each indented
    line. That's enough for the 3-tier comparison.
    """
    import re

    cleaned = normalize(stdout, vault=vault)
    hits: list[str] = []
    pat = re.compile(r"^\s*\d+\.\s+(.+?)\s+\(score=", re.MULTILINE)
    for m in pat.finditer(cleaned):
        hits.append(m.group(1).strip())
    return hits


def test_search_oracle_round_trip(vault: Path) -> None:
    """Sanity check: invoking 1차 ``search`` against itself satisfies the
    3-tier equivalence helper. Until S5 lands the migrated implementation
    we only assert the helper is wired up correctly."""
    out = _invoke(vault, "search", "Note")
    hits = _parse_search_hits(out, vault)
    # The oracle output forms a self-consistent ranking.
    assert_search_equivalent(hits, hits, top1=True, top5_inversion_max=0, topN=10)


# ── validator structured equivalence — decision #4 ────────────────────────


def _parse_validator_issues(stdout: str, vault: Path | None = None) -> list[IssueRow]:
    """Pull (note, code, category) tuples out of legacy validator stdout.

    The 1차 default formatter prints ``[code] note_name :: message``-ish
    rows, but the JSON dispatch is more reliable. Parse stdout best-effort
    and accept what's there — S4 will replace this with a structured
    output from ``runtime/legacy_validator_view.py``.
    """
    import re

    from ipa_cli.core.vault_validator import CATEGORIES

    cleaned = normalize(stdout, vault=vault)
    rows: list[IssueRow] = []
    # Format: ``[CODE] NAME — message`` (em-dash) or ``CODE  NAME : msg``.
    pat = re.compile(r"\b([PTLKRH]\d{3})\b[^\w]*([^\n:—]+?)(?:\s+[—:]|\n)")
    for m in pat.finditer(cleaned):
        code = m.group(1)
        note = m.group(2).strip().strip("[]").strip()
        category = CATEGORIES.get(code[0], "unknown")
        rows.append(IssueRow(note=note, code=code, category=category))
    return rows


def test_validator_structured_round_trip(vault: Path) -> None:
    """Sanity wiring: feed the legacy validator output through the
    structured helper against itself."""
    out = _invoke(vault, "validator")
    issues = _parse_validator_issues(out, vault)
    assert_validator_structured_equal(issues, issues)

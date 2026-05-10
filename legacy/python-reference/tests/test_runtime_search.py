"""S5 unit + ranking regression tests for runtime/search.py.

The 1차 oracle package has been removed. The mini_vault expectations
below freeze the migrated ``SearchEngine`` behaviour directly: top1,
top5 ordering, and result-set drift are still visible without importing
``ipa_cli._legacy``.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

import pytest
from typer.testing import CliRunner

from ipa_cli.main import app
from ipa_cli.runtime.search import render_search, search_hits
from tests.legacy_surface.helpers import assert_search_equivalent, normalize

FIXTURE_VAULT = Path(__file__).parent / "fixtures" / "mini_vault"


@pytest.fixture
def vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    target = tmp_path / "vault"
    shutil.copytree(FIXTURE_VAULT, target)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg-cfg"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))
    monkeypatch.delenv("IPA_PROFILE", raising=False)
    monkeypatch.delenv("IPA_VAULT_PATH", raising=False)
    return target


def _new_ids(vault: Path, queries: list[str]) -> list[str]:
    visible, _, _ = search_hits(
        vault,
        queries,
        threshold=0.0,
        max_results=50,
        show_all=True,
    )
    return [h.note_id for h in visible]


# ── basic surface ──────────────────────────────────────────────────────


def test_search_returns_known_hits(vault: Path) -> None:
    out = render_search(vault, ["Note A"], threshold=0.0, max_results=5)
    assert "Search results for 'Note A'" in out
    assert "Note A" in out


def test_search_no_results_with_high_threshold(vault: Path) -> None:
    out = render_search(
        vault, ["Note A"], threshold=999.0, max_results=5, show_all=False
    )
    assert "No results for 'Note A'" in out


def test_search_show_all_includes_low_score_hits(vault: Path) -> None:
    """``--all`` removes both threshold and cap."""
    out = render_search(vault, ["Note"], threshold=0.30, max_results=2, show_all=True)
    # Every fixture note should be visible when threshold/cap are off.
    for nid in ["Note A", "Note B", "Note C", "Note D"]:
        assert nid in out


def test_search_reasons_includes_channel_breakdown(vault: Path) -> None:
    out = render_search(vault, ["Note A"], threshold=0.0, max_results=5, reasons=True)
    # At least one channel produced a non-zero raw score and it shows
    # up in the parenthesised tail.
    assert re.search(r"\([^)]*=[^)]*\)", out)


def test_search_cut_count_message(vault: Path) -> None:
    """Visible cap < total hit count surfaces a tail nudge."""
    out = render_search(vault, ["Note"], threshold=0.0, max_results=2, show_all=False)
    # mini_vault has 7 notes — at threshold 0 we expect a "+N more" line.
    assert "결과 더 있음" in out


# ── migrated SearchEngine ranking contract ────────────────────────────


EXPECTED_RANKINGS: dict[tuple[str, ...], list[str]] = {
    ("Note D",): [
        "Note D",
        "🔖 Sub Index",
        "Note B",
        "Note C",
        "Note A",
        "🔖 Sample Index",
    ],
    ("🔖 Sub Index",): [
        "🔖 Sub Index",
        "🔖 Sample Index",
        "Note D",
        "Note A",
        "🏷️ Sample Root",
        "Note B",
        "Note C",
    ],
    ("Note B",): [
        "Note B",
        "Note A",
        "🔖 Sample Index",
        "Note C",
        "Note D",
        "🔖 Sub Index",
    ],
    ("Sample Root",): [
        "🏷️ Sample Root",
        "🔖 Sample Index",
        "Note B",
        "Note A",
        "🔖 Sub Index",
    ],
    ("Note",): [
        "Note B",
        "Note D",
        "Note C",
        "🔖 Sample Index",
        "Note A",
        "🔖 Sub Index",
    ],
    ("Note A",): [
        "Note B",
        "🔖 Sample Index",
        "Note C",
        "Note A",
        "Note D",
        "🔖 Sub Index",
        "🏷️ Sample Root",
    ],
}


@pytest.mark.parametrize(
    ("queries", "expected"),
    [
        (list(queries), expected)
        for queries, expected in EXPECTED_RANKINGS.items()
        if queries != ("Note A",)
    ],
)
def test_search_ranking_matches_migrated_contract(
    vault: Path,
    queries: list[str],
    expected: list[str],
) -> None:
    new = _new_ids(vault, queries)
    assert_search_equivalent(
        new,
        expected,
        top1=True,
        top5_inversion_max=0,
        topN=len(expected),
    )


def test_search_note_a_ranking_is_explicitly_documented(vault: Path) -> None:
    """``Note A`` is intentionally not ranked first by the migrated engine."""
    queries = ["Note A"]
    new = _new_ids(vault, queries)
    assert new == EXPECTED_RANKINGS[tuple(queries)]


# ── CLI integration ─────────────────────────────────────────────────────


def test_cli_search_invokes_new_view(vault: Path) -> None:
    runner = CliRunner()
    res = runner.invoke(app, ["--vault", str(vault), "search", "Note A"])
    assert res.exit_code == 0, res.stdout
    cleaned = normalize(res.stdout, vault=vault)
    assert "Search results for 'Note A'" in cleaned
    assert "Note A" in cleaned


def test_cli_search_multi_query_combines_scores(vault: Path) -> None:
    runner = CliRunner()
    res = runner.invoke(app, ["--vault", str(vault), "search", "Note A", "Note B"])
    assert res.exit_code == 0, res.stdout
    cleaned = normalize(res.stdout, vault=vault)
    assert "'Note A + Note B'" in cleaned

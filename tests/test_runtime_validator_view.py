"""S4 unit + structured-equivalence tests for legacy_validator_view."""

from __future__ import annotations

import re
import shutil
from pathlib import Path

import pytest
from typer.testing import CliRunner

from ipa_cli.api.mappings import Mapping
from ipa_cli.main import app
from ipa_cli.runtime.legacy_validator_view import (
    LEGACY_TO_NEW,
    NEW_TO_LEGACY,
    _parse_filter,
    render_validator,
)
from tests.legacy_surface.helpers import (
    IssueRow,
    assert_validator_structured_equal,
    normalize,
)

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


def _parse_legacy_lines(stdout: str, vault: Path) -> list[IssueRow]:
    """Pull (note_id, code, category) tuples out of legacy stdout."""
    cleaned = normalize(stdout, vault=vault)
    rows: list[IssueRow] = []
    current_path: str | None = None
    for line in cleaned.splitlines():
        if not line:
            current_path = None
            continue
        if line.startswith("  "):
            m = re.match(r"\s+([PTLKRH]\d{3})\s+(.*)", line)
            if m and current_path:
                code = m.group(1)
                note_id = Path(current_path).stem
                rows.append(
                    IssueRow(
                        note=note_id,
                        code=code,
                        category=code[0],
                    )
                )
        elif line.endswith(".md"):
            current_path = line.strip()
    return rows


# ── basic surface ────────────────────────────────────────────────────────


def test_render_validator_default_finds_known_issues(vault: Path) -> None:
    out = render_validator(vault)
    assert "Found 5 issues" in out
    assert "K002" in out
    assert "H001" in out
    # Three location violations on root + two indices in 00 Inbox.
    assert out.count("L001") == 3


def test_render_validator_select_keeps_only_target_codes(vault: Path) -> None:
    out = render_validator(vault, select="K")
    assert "K002" in out
    assert "L001" not in out
    assert "H001" not in out


def test_render_validator_ignore_drops_codes(vault: Path) -> None:
    out = render_validator(vault, ignore="L,H")
    assert "L001" not in out
    assert "H001" not in out
    assert "K002" in out


def test_render_validator_select_individual_code(vault: Path) -> None:
    out = render_validator(vault, select="L001")
    assert "L001" in out
    assert "K002" not in out


def test_render_validator_target_note_scopes_run(vault: Path) -> None:
    out = render_validator(vault, note="Note C")
    assert "Note C" in out
    # L001 fires only on root/index notes — Note C is type=note.
    assert "L001" not in out
    # The vault-scope rule still runs but only Note C's issues should
    # show up: K002 (wikilink miss) + H001 (h1 heading).
    assert "K002" in out
    assert "H001" in out


def test_parse_filter_handles_categories_and_codes() -> None:
    assert _parse_filter(None) is None
    assert _parse_filter("") is None
    assert _parse_filter("P,T") == {
        LEGACY_TO_NEW[c] for c in LEGACY_TO_NEW if c.startswith(("P", "T"))
    }
    assert _parse_filter("P001") == {"ipa.frontmatter.required_field"}
    # Nonsense tokens degrade to "no filter" (matches 1차 silent drop).
    assert _parse_filter("zzz") is None


def test_legacy_mapping_is_bijective() -> None:
    """Each 1차 / 2차 code participates in exactly one mapping pair."""
    assert len(NEW_TO_LEGACY) == len(LEGACY_TO_NEW)
    for new, legacy in NEW_TO_LEGACY.items():
        assert LEGACY_TO_NEW[legacy] == new


# ── migrated validator structured contract ──────────────────────────────


def test_structured_payload_matches_migrated_contract(vault: Path) -> None:
    """Decision #4: keep the legacy-code projection stable post-oracle."""
    new_text = render_validator(vault, mapping=Mapping())
    new_rows = _parse_legacy_lines(new_text, vault)
    expected_rows = [
        IssueRow(note="Note C", code="K002", category="K"),
        IssueRow(note="Note C", code="H001", category="H"),
        IssueRow(note="🏷️ Sample Root", code="L001", category="L"),
        IssueRow(note="🔖 Sample Index", code="L001", category="L"),
        IssueRow(note="🔖 Sub Index", code="L001", category="L"),
    ]

    assert_validator_structured_equal(new_rows, expected_rows)


def test_cli_validator_routes_through_new_view(vault: Path) -> None:
    """``ipa validator`` produces the structured output the new view ships."""
    runner = CliRunner()
    res = runner.invoke(app, ["--vault", str(vault), "validator"])
    assert res.exit_code == 0, res.stdout
    rows = _parse_legacy_lines(res.stdout, vault)
    direct = _parse_legacy_lines(render_validator(vault), vault)
    assert_validator_structured_equal(rows, direct)

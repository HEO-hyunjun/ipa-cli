"""Unit tests for ``runtime/view.py`` (S2).

The CLI integration is covered by the snapshot test in
``test_legacy_surface_snapshot``. These tests exercise ``render_view``
directly so failures point at the rendering function rather than the
Typer wiring.
"""

from __future__ import annotations

from pathlib import Path

from ipa_cli.runtime.view import render_view

FIXTURE_VAULT = Path(__file__).parent / "fixtures" / "mini_vault"


def test_render_view_overview_includes_structure() -> None:
    out = render_view(FIXTURE_VAULT, note="Note A")
    assert "=== Note A [note]" in out
    assert "## Structure" in out
    assert "[H2] Overview" in out
    assert "[H2] Section X" in out
    assert "[H2] Section Y" in out


def test_render_view_section_returns_only_target() -> None:
    out = render_view(FIXTURE_VAULT, note="Note A", section="Section X")
    assert "[H2] Section X" in out
    # Other sections should not bleed in.
    assert "Section Y" not in out
    assert "## Structure" not in out


def test_render_view_section_unknown_lists_available() -> None:
    out = render_view(FIXTURE_VAULT, note="Note A", section="nonexistent")
    assert "Section not found" in out
    assert "Available sections:" in out
    assert "[H2] Overview" in out


def test_render_view_full_emits_body_verbatim() -> None:
    out = render_view(FIXTURE_VAULT, note="Note A", full=True)
    assert "Content under section X." in out
    assert "## Section Y" in out
    # Full mode keeps the IPA action footer.
    assert "다음:" in out


def test_render_view_unknown_note() -> None:
    out = render_view(FIXTURE_VAULT, note="Does Not Exist")
    assert out == "Note not found: 'Does Not Exist'"


def test_render_view_section_takes_precedence_over_full() -> None:
    """``--section`` always wins when both flags are set."""
    out = render_view(FIXTURE_VAULT, note="Note A", section="Section X", full=True)
    assert "[H2] Section X" in out
    assert "Section Y" not in out

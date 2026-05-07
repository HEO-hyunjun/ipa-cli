"""Unit tests for ``runtime/traversal.py`` (S3).

The byte-identical surface is enforced by the snapshot suite. These
tests exercise the four traversal modes against the mini_vault
fixture and round-trip the new ``Note``-based implementation.
"""

from __future__ import annotations

from pathlib import Path

from ipa_cli.runtime.traversal import render_traversal

FIXTURE_VAULT = Path(__file__).parent / "fixtures" / "mini_vault"


def test_traversal_up_walks_to_root() -> None:
    out = render_traversal(FIXTURE_VAULT, up="Note A")
    assert "Upward paths from 'Note A':" in out
    assert "Note A → 🔖 Sample Index → 🏷️ Sample Root" in out


def test_traversal_down_includes_descendants() -> None:
    out = render_traversal(FIXTURE_VAULT, down="🔖 Sample Index")
    assert "🔖 Sample Index" in out
    assert "📄 Note A" in out
    assert "📄 Note B" in out
    assert "📄 Note C" in out
    # Sub Index is a child whose own children must also surface.
    assert "🔖 Sub Index" in out
    assert "📄 Note D" in out


def test_traversal_siblings_uses_shared_parent() -> None:
    """The 1차 implementation crashed on this case (VaultNote.title).
    The new ``runtime/traversal.get_siblings`` returns the correct set."""
    out = render_traversal(FIXTURE_VAULT, siblings="Note A")
    assert "Siblings of 'Note A':" in out
    # Note A shares ``🔖 Sample Index`` with Note B and Note C.
    assert "- Note B" in out
    assert "- Note C" in out
    # Note D belongs to Sub Index, so it must NOT show up.
    assert "Note D" not in out


def test_traversal_siblings_empty_for_orphan() -> None:
    out = render_traversal(FIXTURE_VAULT, siblings="🏷️ Sample Root")
    # Root has no refs → no siblings.
    assert out == "No siblings found for '🏷️ Sample Root'"


def test_traversal_root_resolves_chain() -> None:
    out = render_traversal(FIXTURE_VAULT, root="Note D")
    assert "Root(s) for 'Note D':" in out
    assert "- 🏷️ Sample Root" in out


def test_traversal_unknown_note_yields_no_root() -> None:
    out = render_traversal(FIXTURE_VAULT, root="Does Not Exist")
    assert out == "No root found for 'Does Not Exist'"

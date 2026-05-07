"""Legacy ``ipa view`` entrypoint, decoupled from synthetic-argv.

S2 removes the ``_call_module`` adapter for ``view`` by routing the
command through this thin module. Internally we still call the
``core/vault_search`` render helpers — those stay alive as the parity
oracle (plan decision #5) until S7 absorbs them.

Why a separate entrypoint instead of leaving the logic in main.py:
* keeps the command surface single-purpose (one render function)
* makes the call graph explicit so S7's core/ removal is mechanical
* lets future steps swap the rendering for a parse/Note-driven version
  without touching the CLI layer
"""

from __future__ import annotations

from pathlib import Path

from ipa_cli.core.vault_parser import build_note_index, scan_vault
from ipa_cli.core.vault_search import (
    _build_tag_to_notes_index,
    render_full,
    render_overview,
    render_section,
    view_note,
)


def render_view(
    vault_path: Path,
    *,
    note: str,
    section: str | None = None,
    full: bool = False,
) -> str:
    """Return the legacy ``ipa view`` output for ``note``.

    Three modes mirror the 1차 surface:
    * ``section`` set → ``render_section`` (specific header/callout body)
    * ``full=True`` → ``render_full`` (frontmatter + entire body)
    * otherwise → ``render_overview`` (frontmatter + structure tree)
    """
    notes = scan_vault(vault_path)
    index = build_note_index(notes)
    tag_index = _build_tag_to_notes_index(notes)

    found = view_note(note, index)
    if not found:
        return f"Note not found: '{note}'"

    if section:
        return render_section(found, section)
    if full:
        return render_full(found, notes, index, tag_index)
    return render_overview(found, notes, index, tag_index)

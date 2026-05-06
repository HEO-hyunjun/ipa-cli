"""Minimal vault scanner.

P2 surface: walks the three IPA conceptual folders defined by the active
``Mapping`` (``inbox_dir``, ``project_dir``, ``archive_dir``) for
``*.md`` files, splits YAML frontmatter from body, and returns ``Note``
instances.

Why mapping-driven scanning: vault metadata (``90 Settings``, skill
docs, the obsidian config dir, project READMEs at the vault root) lives
outside the IPA states and shouldn't enter search/validator runs.
Folder names that mark IPA states are part of vault convention, so the
``Mapping`` carries them alongside frontmatter key names.

Default exclusions: any path component starting with ``.`` is skipped
(``.obsidian``, ``.git``, ``.DS_Store``, ``.trash``, ...). Empty
``mapping.<folder>_dir`` opts that IPA state out of scanning.

Broken YAML in a note's frontmatter does not crash the scan — that note
simply gets an empty ``frontmatter`` dict and rules can flag it later.

P5 will replace this with a markdown-it-py based parser that exposes
heading/code-fence/wikilink AST. The Note shape stays the same.
"""

from __future__ import annotations

import unicodedata
from pathlib import Path

import yaml

from ipa_cli.api.mappings import Mapping
from ipa_cli.parse.note_model import Note


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split a markdown text into (frontmatter dict, body).

    Frontmatter must be the first block, delimited by ``---`` lines.
    Anything else returns ``({}, text)``.
    """
    if not text.startswith("---"):
        return {}, text

    # Find the closing fence at start of a line.
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip("\r\n") != "---":
        return {}, text

    end_idx = -1
    for i in range(1, len(lines)):
        if lines[i].rstrip("\r\n") == "---":
            end_idx = i
            break
    if end_idx == -1:
        return {}, text

    fm_text = "".join(lines[1:end_idx])
    body = "".join(lines[end_idx + 1 :])
    try:
        fm = yaml.safe_load(fm_text) or {}
    except yaml.YAMLError:
        fm = {}
    if not isinstance(fm, dict):
        fm = {}
    return fm, body


def load_notes(vault_path: Path, mapping: Mapping) -> list[Note]:
    """Scan IPA folders under ``vault_path`` and return ``Note`` instances.

    Folders to scan come from ``mapping.inbox_dir / project_dir /
    archive_dir``. Empty values are skipped (opt out of that IPA state).
    Path components starting with ``.`` are always excluded.
    """
    vault = vault_path.expanduser().resolve()
    folders = [
        f for f in (mapping.inbox_dir, mapping.project_dir, mapping.archive_dir) if f
    ]
    notes: list[Note] = []

    for folder_name in folders:
        folder = vault / folder_name
        if not folder.is_dir():
            continue
        for md_path in folder.rglob("*.md"):
            rel_parts = md_path.relative_to(vault).parts
            if any(part.startswith(".") for part in rel_parts):
                continue
            try:
                text = md_path.read_text(encoding="utf-8")
            except OSError:
                continue
            fm, body = parse_frontmatter(text)
            # macOS APFS exposes filenames as NFD-decomposed Unicode,
            # which breaks string equality with NFC literals. Normalize
            # the stem so callers can compare ids with regular Korean
            # text. The on-disk path itself is left as-is.
            note_id = unicodedata.normalize("NFC", md_path.stem)
            notes.append(
                Note(
                    id=note_id,
                    path=md_path,
                    body=body,
                    frontmatter=fm,
                )
            )
    return notes

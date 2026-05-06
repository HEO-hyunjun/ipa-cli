"""Vault attachment indexing.

K002 (wikilink target rule) needs a side-channel so wikilinks pointing at
non-md attachments (images, PDFs, audio) don't get flagged as missing.
This module builds that index by walking the vault filesystem once.

NFC normalization: macOS APFS stores filenames as NFD-decomposed Hangul
which doesn't string-equal NFC literals from note bodies. We normalize
both stems and full names so wikilink text matches regardless of which
form the OS hands us.
"""

from __future__ import annotations

import unicodedata
from pathlib import Path

ATTACHMENT_EXTS: frozenset[str] = frozenset(
    {
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".svg",
        ".webp",
        ".bmp",
        ".pdf",
        ".mp3",
        ".mp4",
        ".webm",
        ".wav",
        ".ogg",
    }
)


def build_attachment_index(vault_path: Path) -> set[str]:
    """Return the set of attachment names (with and without extension).

    Both the stem and the full filename are added so wikilinks that
    include the extension (``[[diagram.png]]``) and those that don't
    (``[[diagram]]``) both match.
    """
    index: set[str] = set()
    if not vault_path.exists():
        return index
    for f in vault_path.rglob("*"):
        if not f.is_file():
            continue
        if f.suffix.lower() not in ATTACHMENT_EXTS:
            continue
        index.add(unicodedata.normalize("NFC", f.stem))
        index.add(unicodedata.normalize("NFC", f.name))
    return index

"""Frontmatter semantic field + IPA folder mapping.

ipa code reads notes via stable semantic field names (``note_type``,
``refs``, ``tags``, ``created_at``, ``updated_at``, optionally
``aliases``). It also walks only the three IPA conceptual folders
(``inbox_dir``, ``project_dir``, ``archive_dir``) when loading notes.
A profile-level ``Mapping`` translates both naming dimensions to the
actual frontmatter keys and folder names used in that vault, keeping
validator, formatter and search backends unaware of vault-specific
conventions.

``ui_mode`` is intentionally not a standard field — it's a vault display
preference, not part of IPA conceptual model. Users who need to map it
put it in ``custom``.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Required semantic fields. The final mapping must provide a non-empty
# value for each of these or runtime fails fast (see Mapping.validate).
# Folder fields (``inbox_dir`` etc.) are intentionally NOT required —
# users can leave one empty to opt out of scanning that IPA state
# (e.g. a vault with no Project folder).
REQUIRED_FIELDS: tuple[str, ...] = (
    "note_type",
    "refs",
    "tags",
    "created_at",
    "updated_at",
)


@dataclass
class Mapping:
    note_type: str = "type"
    refs: str = "ref"
    tags: str = "tags"
    created_at: str = "date_created"
    updated_at: str = "date_modified"
    aliases: str | None = "aliases"

    inbox_dir: str = "00 Inbox"
    project_dir: str = "01 Project"
    archive_dir: str = "02 Archive"

    custom: dict[str, str] = field(default_factory=dict)

    def validate(self) -> None:
        """Raise ``ValueError`` if any required semantic field is empty."""
        for name in REQUIRED_FIELDS:
            value = getattr(self, name, None)
            if not value:
                raise ValueError(f"Mapping missing required semantic field: {name!r}")

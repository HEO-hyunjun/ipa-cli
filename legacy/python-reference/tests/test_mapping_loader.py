"""Mapping loader tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from ipa_cli.api import Mapping
from ipa_cli.runtime.mapping_loader import load_mapping


def test_no_profile_dir_returns_default() -> None:
    m = load_mapping(None)
    assert m.note_type == "type"
    assert m.refs == "ref"
    assert m.inbox_dir == "00 Inbox"


def test_empty_profile_dir_returns_default(tmp_path: Path) -> None:
    m = load_mapping(tmp_path)
    assert isinstance(m, Mapping)
    assert m.note_type == "type"


def test_user_mapping_overrides_defaults(tmp_path: Path) -> None:
    (tmp_path / "mapping.py").write_text(
        """
from ipa_cli.api import Mapping

mapping = Mapping(
    note_type="kind",
    refs="parents",
    created_at="created",
    updated_at="updated",
)
""",
        encoding="utf-8",
    )
    m = load_mapping(tmp_path)
    assert m.note_type == "kind"
    assert m.refs == "parents"
    assert m.created_at == "created"
    # untouched fields keep defaults
    assert m.tags == "tags"
    assert m.inbox_dir == "00 Inbox"


def test_user_mapping_can_override_folders(tmp_path: Path) -> None:
    (tmp_path / "mapping.py").write_text(
        """
from ipa_cli.api import Mapping

mapping = Mapping(
    inbox_dir="Inbox",
    project_dir="Projects",
    archive_dir="Archive",
)
""",
        encoding="utf-8",
    )
    m = load_mapping(tmp_path)
    assert m.inbox_dir == "Inbox"
    assert m.project_dir == "Projects"
    assert m.archive_dir == "Archive"


def test_vault_config_mapping_overrides_defaults(tmp_path: Path) -> None:
    config = tmp_path / ".ipa" / "config.yaml"
    config.parent.mkdir(parents=True)
    config.write_text(
        """
mapping:
  note_type: kind
  refs: parents
  created_at: created
  updated_at: updated
  inbox_dir: Inbox
  project_dir: Projects
  archive_dir: Archive
""",
        encoding="utf-8",
    )

    m = load_mapping(None, vault_config_path=config)

    assert m.note_type == "kind"
    assert m.refs == "parents"
    assert m.created_at == "created"
    assert m.updated_at == "updated"
    assert m.tags == "tags"
    assert m.inbox_dir == "Inbox"
    assert m.project_dir == "Projects"
    assert m.archive_dir == "Archive"


def test_vault_config_mapping_supports_nested_fields_and_folders(
    tmp_path: Path,
) -> None:
    config = tmp_path / ".ipa" / "config.yaml"
    config.parent.mkdir(parents=True)
    config.write_text(
        """
mapping:
  fields:
    note_type: kind
    refs: parents
    tags: labels
    created_at: created
    updated_at: updated
    aliases:
  folders:
    inbox: Inbox
    project: Projects
    archive: Archive
""",
        encoding="utf-8",
    )

    m = load_mapping(None, vault_config_path=config)

    assert m.note_type == "kind"
    assert m.refs == "parents"
    assert m.tags == "labels"
    assert m.created_at == "created"
    assert m.updated_at == "updated"
    assert m.aliases is None
    assert m.inbox_dir == "Inbox"
    assert m.project_dir == "Projects"
    assert m.archive_dir == "Archive"


def test_vault_config_mapping_wins_over_legacy_profile_mapping(
    tmp_path: Path,
) -> None:
    profile = tmp_path / "profile"
    profile.mkdir()
    (profile / "mapping.py").write_text(
        """
from ipa_cli.api import Mapping

mapping = Mapping(note_type="legacy_kind")
""",
        encoding="utf-8",
    )
    config = tmp_path / "vault" / ".ipa" / "config.yaml"
    config.parent.mkdir(parents=True)
    config.write_text(
        """
mapping:
  note_type: vault_kind
""",
        encoding="utf-8",
    )

    m = load_mapping(profile, vault_config_path=config)

    assert m.note_type == "vault_kind"


def test_unknown_vault_config_mapping_key_fails(tmp_path: Path) -> None:
    config = tmp_path / ".ipa" / "config.yaml"
    config.parent.mkdir(parents=True)
    config.write_text(
        """
mapping:
  typo: value
""",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="unknown mapping key"):
        load_mapping(None, vault_config_path=config)


def test_required_field_empty_fails(tmp_path: Path) -> None:
    (tmp_path / "mapping.py").write_text(
        """
from ipa_cli.api import Mapping

mapping = Mapping(note_type="")
""",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="note_type"):
        load_mapping(tmp_path)


def test_missing_mapping_attr_fails(tmp_path: Path) -> None:
    (tmp_path / "mapping.py").write_text(
        "# no `mapping` attribute defined\n",
        encoding="utf-8",
    )
    with pytest.raises(ImportError, match="mapping"):
        load_mapping(tmp_path)


def test_wrong_type_for_mapping_attr_fails(tmp_path: Path) -> None:
    (tmp_path / "mapping.py").write_text(
        "mapping = {'note_type': 'kind'}\n",
        encoding="utf-8",
    )
    with pytest.raises(TypeError, match="Mapping instance"):
        load_mapping(tmp_path)

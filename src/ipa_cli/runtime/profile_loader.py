"""Profile discovery and workspace path resolution.

Two responsibilities:

1. Walk up from a starting directory looking for ``.ipa-profile`` to find
   the profile name a project is bound to. This is the project-level
   discovery hook from the 2nd-iteration plan; CLI ``--profile`` and
   ``IPA_PROFILE`` still take precedence.
2. Resolve the standard profile workspace directory
   (``~/.config/ipa/profiles/{name}/``) honoring ``XDG_CONFIG_HOME``.
"""

from __future__ import annotations

import os
from pathlib import Path

DOTIPA_FILENAME = ".ipa-profile"


def find_dotipa_profile(start: Path) -> str | None:
    """Walk up from ``start`` looking for ``.ipa-profile``.

    Returns the trimmed file content (profile name) when found, ``None``
    otherwise. The search stops at the filesystem root.
    """
    current = start.expanduser().resolve()
    while True:
        candidate = current / DOTIPA_FILENAME
        if candidate.is_file():
            try:
                content = candidate.read_text(encoding="utf-8").strip()
            except OSError:
                return None
            return content or None
        parent = current.parent
        if parent == current:
            return None
        current = parent


def config_home() -> Path:
    """Honor ``XDG_CONFIG_HOME`` per XDG Base Directory spec, default to
    ``~/.config``.
    """
    raw = os.environ.get("XDG_CONFIG_HOME")
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".config"


def profile_workspace_dir(name: str) -> Path:
    """Standard location ``$XDG_CONFIG_HOME/ipa/profiles/{name}/``."""
    return config_home() / "ipa" / "profiles" / name

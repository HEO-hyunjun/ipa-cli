"""Built-in defaults for ipa-cli.

Search channel weights mirror `_shared/scripts/vault_search.py:55`
(`_CHANNEL_WEIGHTS`, P9-rerun, 2000 trials Optuna). `ipa tune --apply`
writes immutable results under the profile workspace; these defaults are
the fallback only.
"""

from __future__ import annotations

import os
from pathlib import Path

DEFAULT_THRESHOLD = 0.30
DEFAULT_MAX_RESULTS = 10

DEFAULT_WEIGHTS: dict[str, float] = {
    "fuzzy": 0.268,
    "keyword": 0.055,
    "related": 0.032,
    "body_match": 0.363,
    "sequence_match": 0.078,
    "filename_partial": 0.150,
    "child_body_match": 0.169,
    "project": 0.033,
}


def xdg_config_home() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")


def default_config_path() -> Path:
    return xdg_config_home() / "ipa" / "config.yaml"


def default_dotenv_path() -> Path:
    return xdg_config_home() / "ipa" / ".env"

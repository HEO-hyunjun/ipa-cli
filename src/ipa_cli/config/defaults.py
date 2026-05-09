"""Built-in defaults for ipa-cli.

Search channel weights come from
``ipa_cli.builtins.channels.weights.DEFAULT_CHANNEL_WEIGHTS``. `ipa tune
--apply` writes immutable results under the vault-local
`.ipa/tune/results/` directory; these defaults are the fallback only.
"""

from __future__ import annotations

import os
from pathlib import Path

from ipa_cli.builtins.channels.weights import DEFAULT_CHANNEL_WEIGHTS

DEFAULT_THRESHOLD = 0.30
DEFAULT_MAX_RESULTS = 10

DEFAULT_WEIGHTS: dict[str, float] = dict(DEFAULT_CHANNEL_WEIGHTS)


def xdg_config_home() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")


def default_config_path() -> Path:
    return xdg_config_home() / "ipa" / "profile.yaml"


def default_dotenv_path() -> Path:
    return xdg_config_home() / "ipa" / ".env"

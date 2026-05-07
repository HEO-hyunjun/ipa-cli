# ipa-cli

Search, validate, format, and tune your [IPA](https://github.com/) Obsidian
vault from the terminal. Channels and rules live in the codebase as plain
Python — no DSL — and your profile workspace adds project-specific overrides
without touching the package.

Surface:

- `ipa engine search / channels` — multi-channel weighted search
- `ipa convention check` — validate vault against active convention rules
- `ipa formatter plan / apply` — autofix issues that rules know how to fix
- `ipa tune (run) / eval / list / use / analyze` — Optuna TPE on weights
- `ipa config show / profile list / use / current` — config introspection
- `ipa search / view / traversal / validator / refactor` — legacy
  surface now backed by `runtime/*` modules built on the same service
  layer as `engine` / `convention` / `formatter` (see
  [Vault skill compatibility](#vault-skill-compatibility) below)
- `ipa list-channels / list-rules / list-refactors` — registry inspection
  (channels driving `engine search`, rules driving `convention/formatter`,
  refactor recipes for `refactor`)

## Install

```sh
uv sync                # dev workflow
uv run pytest -q       # confirm green
uv run ipa --help      # CLI surface
```

The CLI entrypoint is `ipa` (defined in `pyproject.toml` as
`ipa = ipa_cli.main:app`).

## Quickstart

```sh
# Select a profile for this project.
printf "sample\n" > .ipa-profile

# Point the sample profile at your vault.
export IPA_VAULT_PATH=~/sync/IPA

# Search.
ipa engine search "ipa cli" --explain --max 5

# List the active search channels (builtin + profile additions).
ipa engine channels

# Validate convention (per-note rules by default).
ipa convention check --summary

# Plan and apply formatter fixes.
ipa formatter plan
ipa formatter apply

# Tune (Optuna TPE) and roll the active result pointer in profile.yaml.
ipa tune --apply --trials 200
ipa tune list
ipa tune use 2026-05-04T09-12-44.json   # rollback
```

## Profile workspace

Each profile lives under `~/.config/ipa/profiles/{name}/`:

```text
~/.config/ipa/profiles/sample/
  profile.yaml            # vault_path, tune.result_file pointer
  convention.py           # active rules: explicit list, no auto-discovery
  search.py               # active channels: explicit list, no auto-discovery
  rules/                  # user-authored BaseConventionRule subclasses
  channel_rules/          # user-authored BaseSearchChannel subclasses
  tune/
    testsets/             # *.json eval sets used by ipa tune
    results/              # 2026-05-06T21-30-00.json — immutable artifacts
  .cache/                 # auto-managed pickles (BM25, parsed AST)
```

A working sample lives at [`examples/sample_profile/`](examples/sample_profile/) —
copy the directory and read [`examples/sample_profile/README.md`](examples/sample_profile/README.md).

## Authoring

### Convention rule

```python
# rules/no_emoji_in_filename_rule.py
from ipa_cli.api import BaseConventionRule, Issue, Severity

class NoEmojiInFilenameRule(BaseConventionRule):
    code = "sample.no_emoji_in_filename"
    severity = Severity.INFO
    default_scope = "note"

    def check(self, ctx, note):
        if note.id and note.id[0] in {"🔖", "🏷"}:
            return []
        return [Issue(code=self.code, severity=self.severity,
                      note_id=note.id, message="filename starts with an emoji")]
```

Then in `convention.py`:

```python
from ipa_cli.api.conventions import Convention
from ipa_cli.builtins.conventions.default_convention import default_convention
from .rules.no_emoji_in_filename_rule import NoEmojiInFilenameRule

_builtin = default_convention()
convention = Convention(name="sample", rules=[*_builtin.rules, NoEmojiInFilenameRule()])
```

### Search channel

```python
# channel_rules/heading_match_channel.py
from ipa_cli.api import BaseSearchChannel

class HeadingMatchChannel(BaseSearchChannel):
    name = "heading_match"
    description = "Boost notes whose H1/H2 contains the query"
    default_weight = 0.10

    def search(self, ctx, query):
        q = query.raw.lower()
        return {
            n.id: 1.0 for n in ctx.notes
            if any(q in h.text.lower() for h in n.headings if h.level <= 2)
        }
```

`Note.headings` is the parse level 3 lazy property added in P5 — it parses
markdown via `markdown-it-py` on first access, then `SearchEngine` writes
the AST back to `.cache/parsed_index.pkl` so subsequent runs skip the parser.

## Tune workflow

`ipa tune --apply` saves an immutable JSON under
`tune/results/{timestamp}.json` and rotates the active pointer:

```yaml
# ~/.config/ipa/profiles/sample/profile.yaml
vault_path: /Users/me/sync/IPA
tune:
  result_file: 2026-05-06T21-30-00.json
```

The pointed-at JSON contains `threshold`, `max_results`, `weights`, plus a
`study` block. Search params merge in priority order
**default < profile.yaml < tune_result < env < cli**. A stale or missing
pointer falls back to `profile.yaml`/builtin values.

Useful subcommands:

| Command | What it does |
|---|---|
| `ipa tune eval [--testset NAME]` | Baseline loss/metrics with the *current* active params |
| `ipa tune` (run, with optional `--apply`) | Optuna TPE study |
| `ipa tune analyze` | Threshold distribution diagnostics |
| `ipa tune list` | History (newest first), ★ active marker |
| `ipa tune use <filename>` | Flip the pointer; rollback to a past result |

## Vault skill compatibility

The vault skill at `~/ipa/.claude/skills/_shared/scripts/` ships its own
copies of `vault_search.py` / `vault_validator.py` / etc. and runs them
directly — **it does not invoke `ipa`**. The two codebases evolved from
the same scripts but are now independent copies.

The legacy `ipa search` / `view` / `traversal` / `validator` / `refactor`
commands now run on the same service layer as `engine` / `convention` /
`formatter`. The synthetic-argv adapter is gone — each command routes
through a dedicated `runtime/*` module (`runtime/view.py`,
`runtime/traversal.py`, `runtime/legacy_validator_view.py`,
`runtime/search.py`, `runtime/refactor.py`). The 1차↔2차 rule-code map
is in [`docs/legacy-validator-rule-map.md`](docs/legacy-validator-rule-map.md);
the refactor subcommand matrix lives in
[`docs/legacy-refactor-subcommands.md`](docs/legacy-refactor-subcommands.md).
The original script algorithms remain available under the internal
`ipa_cli._legacy` package as a parity oracle for tests; the public
`ipa_cli.core` surface no longer exists.

## Layout

```text
src/ipa_cli/
  main.py            # Typer entrypoints
  api/               # public types: BaseConventionRule, BaseSearchChannel, Mapping ...
  parse/             # vault loader, markdown-it wrapper, parsed cache
  runtime/           # service engines + legacy-surface entrypoints
                     # (view, traversal, search, legacy_validator_view, refactor)
  builtins/          # default convention rules + search channels + refactor metadata
  config/            # Settings resolver, defaults
  tune/              # Optuna runner, threshold dist analyzer, immutable results
  _legacy/           # internal parity oracle (1차 scripts kept for test reference)
```

## Testing

```sh
uv run pytest -q
```

(336 tests at the time of writing — including the 5-stage legacy-surface
characterization snapshots, 1차 oracle structured-equivalence checks, and
the new `runtime/*` unit tests. Hit-rate parity against your own
testset depends on the vault and is measured outside CI via
`ipa tune eval --testset`.)

## License

Internal — see project owner.

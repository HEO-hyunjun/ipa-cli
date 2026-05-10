# ipa-cli

Search, validate, format, and tune your [IPA](https://github.com/) Obsidian
vault from the terminal. The active runtime is the JS/TS workspace under
`packages/`; the previous Python implementation remains as an inactive
reference until the follow-up removal pass.

Surface:

- `ipa engine search / channels` — multi-channel weighted search
- `ipa convention check` — validate vault against active convention rules
- `ipa formatter plan / apply` — autofix issues that rules know how to fix
- `ipa tune / eval / list / use / analyze` — tpe-lite tuning on weights
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
pnpm install           # workspace install
pnpm test              # JS runtime tests
pnpm run build         # build packages/*/dist
node packages/cli/dist/main.js --help
```

The CLI entrypoint is `ipa` via `@ipa/cli` (`packages/cli/dist/main.js` after
build).

## Quickstart

```sh
# Register a default profile.
mkdir -p ~/.config/ipa
cat > ~/.config/ipa/profile.yaml <<'YAML'
profiles:
  sample:
    vault_path: ~/sync/IPA
    default: true
YAML

# Search.
ipa engine search "ipa cli" --explain --max 5

# List the active search channels (builtin/profile + vault-local plugins).
ipa engine channels

# Validate convention (per-note rules by default).
ipa convention check --summary

# Plan and apply formatter fixes.
ipa formatter plan
ipa formatter apply

# Tune with the built-in tpe-lite optimizer, save best JSON, then optionally activate it.
ipa tune --trials 200
ipa tune list
ipa tune use 2026-05-04T09-12-44.json
```

## Vault-local plugins

User plugins live inside the vault:

```text
{vault}/.ipa/plugins/
  search/              # *.js exporting search(query, notes)
  lint/                # *.js exporting lint(note, context)
  formatter/           # *.js exporting format(note, context)
```

Load order is:

1. builtin defaults
2. `{vault}/.ipa/plugins/search/*.js`
3. `{vault}/.ipa/plugins/lint/*.js`
4. `{vault}/.ipa/plugins/formatter/*.js`

Vault-local plugins are trusted local code and are enabled by default.
`.ipa/config.yaml` can disable builtin/plugin behavior globally, by surface,
by kind, or by individual plugin path.

## Profiles and vault config

The machine-local profile registry lives at `~/.config/ipa/profile.yaml`:

```yaml
profiles:
  sample:
    vault_path: /Users/me/sync/IPA
    default: true
  work:
    vault_path: /Users/me/work/IPA
```

`default: true` is the fallback when a command has neither `--vault` nor
`--profile` and no `.ipa-profile` / `IPA_PROFILE` selection. If there is
no selected profile and no default, the command fails.

Vault-local portable config lives at `{vault}/.ipa/config.yaml`:

```yaml
mapping:
  fields:
    note_type: type
    refs: ref
    tags: tags
    created_at: date_created
    updated_at: date_modified
    aliases: aliases
  folders:
    inbox: "00 Inbox"
    project: "01 Project"
    archive: "02 Archive"
test:
  file: .ipa/tune/testsets/testset.json
weights:
  file: .ipa/tune/results/2026-05-06T21-30-00.json
convention:
  enabled: true
  builtin: true
  plugins:
    lint: true
    formatter: true
  ignore:
    - ipa.heading.no_h1
formatter:
  enabled: true
  builtin: false
  plugins:
    lint: false
    formatter: true
  only:
    - vault.formatter.frontmatter_order
```

`mapping` is the vault-local declarative mapping for IPA's semantic
fields/folders. In the JS/TS runtime, custom mapping must live in
`{vault}/.ipa/config.yaml`; profile-local code fallbacks are not loaded.

`convention` controls `ipa convention check`; `formatter` controls
`ipa formatter plan/apply`. `builtin: false` disables builtin rules for
that surface. `plugins` can be `true`/`false`, a list like
`["lint"]`, or a mapping of plugin directories. `only` and `ignore`
filter by rule code after loading.

Portable runtime state stays in the vault:

```text
{vault}/.ipa/
  config.yaml
  plugins/
  tune/
    testsets/             # *.json eval sets used by ipa tune
    results/              # immutable tune artifacts
  cache/
    manifest.json
    files.jsonl
    graph.json
```

A working sample lives at [`examples/sample_profile/`](examples/sample_profile/) —
copy the directory and read [`examples/sample_profile/README.md`](examples/sample_profile/README.md).

## Authoring

### Convention rule

```python
# {vault}/.ipa/plugins/lint/no_emoji_in_filename_rule.py
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

rules = [NoEmojiInFilenameRule()]
```

### Search channel

```python
# {vault}/.ipa/plugins/search/heading_match_channel.py
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

channels = [HeadingMatchChannel()]
```

`Note.headings` is the parse level 3 lazy property added in P5 — it parses
markdown via `markdown-it-py` on first access, then `SearchEngine` writes
the AST back to `.ipa/cache/search/parsed_index.pkl` so subsequent runs
skip the parser.

## Tune workflow

`ipa tune` saves the best params from each run as an immutable JSON under
`{vault}/.ipa/tune/results/{timestamp}.json`. `ipa tune --apply` saves the
same artifact and also rotates the active pointer:

```yaml
# {vault}/.ipa/config.yaml
weights:
  file: .ipa/tune/results/2026-05-06T21-30-00.json
```

The pointed-at JSON contains `threshold`, `max_results`, `weights`, plus a
`study` block. Search params merge in priority order
**default < profile registry < weights.file < env < cli**. A stale or
missing pointer falls back to registry/builtin values.

Useful subcommands:

| Command | What it does |
|---|---|
| `ipa tune eval [--testset NAME]` | Baseline loss/metrics with the *current* active params |
| `ipa tune` (run, with optional `--apply`) | Run tuning and save the best result JSON |
| `ipa tune analyze` | Threshold distribution diagnostics |
| `ipa tune list` | History (newest first), ★ active marker |
| `ipa tune use <filename>` | Flip the pointer; rollback to a past result |

Tune evaluates the active query pack and stores immutable result artifacts
under `.ipa/tune/results`. The optimizer is fixed to `tpe-lite`; users keep
the existing `ipa tune --trials N` command shape.

## Vault skill compatibility

The vault skill at `~/ipa/.claude/skills/_shared/scripts/` ships its own
copies of `vault_search.py` / `vault_validator.py` / etc. and runs them
directly — **it does not invoke `ipa`**. The two codebases evolved from
the same scripts but are now independent copies.

The legacy `ipa search` / `view` / `traversal` / `validator` / `refactor`
commands now route through dedicated `runtime/*` entrypoints instead of
the old synthetic-argv adapter. All command internals now run on the
2차 parse/runtime service layer; the old in-package parity oracle has
been removed.

| Command            | Routing                              | Internal logic                                                         |
|--------------------|--------------------------------------|------------------------------------------------------------------------|
| `list-channels`    | `main.py` → `default_channels()`     | New service (no `_legacy` calls).                                      |
| `list-rules`       | `main.py` → `default_convention()`   | New service.                                                           |
| `list-refactors`   | `main.py` → `BUILTIN_REFACTORS`      | New service.                                                           |
| `view`             | `runtime/view.py`                    | New service: `parse.vault_loader.load_notes` + `Note` rendering.       |
| `traversal`        | `runtime/traversal.py`               | New service: `parse.vault_loader.load_notes` + `Note.refs/wikilinks`.  |
| `validator`        | `runtime/legacy_validator_view.py`   | New service: `validator_engine` + `formatter_engine` with 1차 code projection. |
| `search`           | `runtime/search.py`                  | New service: `SearchEngine` + multi-query summation.                   |
| `refactor`         | `runtime/refactor.py`                | New service: parse-layer scan/filter plus frontmatter/body mutation.   |

The 1차↔2차 rule-code map is in
[`docs/legacy-validator-rule-map.md`](docs/legacy-validator-rule-map.md);
the refactor subcommand migration matrix is in
[`docs/legacy-refactor-subcommands.md`](docs/legacy-refactor-subcommands.md).
The original in-package oracle has been retired; compatibility is now
guarded by golden snapshots and migrated-runtime regression tests.

## Layout

```text
packages/
  core/              # parser, graph, search, validation, cache, contract, plugin, tune
  cli/               # ipa command entrypoint and renderers
  builtin-rules/     # builtin registry metadata
  test-vaults/       # canonical JS runtime fixtures
legacy/
  python-reference/  # inactive reference implementation and characterization tests
```

## Testing

```sh
pnpm test
pnpm run test:contracts
pnpm run test:cli
pnpm run smoke
```

The JS test suite does not invoke the inactive reference implementation.

## License

Internal — see project owner.

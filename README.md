# ipa-cli

Search, validate, format, and tune your [IPA](https://github.com/) Obsidian
vault from the terminal. The active runtime is the JS/TS workspace under
`packages/`.

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

```js
// {vault}/.ipa/plugins/lint/no-emoji-in-filename.js
export async function lint(note) {
  if (note.type === "index" || note.type === "root") return [];
  if (!/^[🔖🏷]/u.test(note.id)) return [];
  return [{
    code: "sample.no_emoji_in_filename",
    severity: "info",
    note: note.id,
    message: "filename starts with an emoji; reserve emoji prefixes for index/root notes"
  }];
}
```

### Search channel

```js
// {vault}/.ipa/plugins/search/heading-match.js
export async function search(query, notes) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return notes
    .filter((note) => note.body.toLowerCase().includes(`# ${q}`) || note.body.toLowerCase().includes(`## ${q}`))
    .map((note) => ({
      note: note.id,
      score: 1,
      reason: { matched: "heading" }
    }));
}
```

Search plugins return scored note hits. Lint plugins return issue objects.
Formatter plugins return patch-like objects consumed by `ipa formatter plan`
and `ipa formatter apply`.

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
standalone vault scripts and runs them directly — **it does not invoke
`ipa`**. The CLI is now maintained as a JS/TS package workspace.

The legacy-compatible `ipa search` / `view` / `traversal` / `validator` /
`refactor` command surfaces now route through `@ipa/core` services. The
old in-package parity oracle has been removed.

| Command            | Routing                              | Internal logic                                                         |
|--------------------|--------------------------------------|------------------------------------------------------------------------|
| `list-channels`    | `packages/cli` → `@ipa/core.CHANNELS` | Registry inspection for the 9 builtin search channels.                 |
| `list-rules`       | `packages/cli` → `@ipa/core.RULES`    | Registry inspection for the 13 builtin validator rules.                |
| `list-refactors`   | `packages/cli` → `@ipa/core.REFACTORS`| Registry inspection for the 7 refactor recipes.                        |
| `view`             | `@ipa/core.viewNote`                 | Note rendering with context header, frontmatter, body/structure, footer. |
| `traversal`        | `@ipa/core.traversal`                | Ref-based up/down/siblings/root traversal.                             |
| `validator`        | `@ipa/core.validateVault`            | Validator engine plus formatter-aware issue reporting.                 |
| `search`           | `@ipa/core.searchVault`              | Weighted builtin and vault-local JS plugin search.                     |
| `refactor`         | `@ipa/core.refactorVault`            | Parse-layer scan/filter plus frontmatter/body mutation.                |

Compatibility is guarded by JS fixtures under
`packages/test-vaults/fixtures/` and the CLI/core regression tests.

## Layout

```text
packages/
  core/              # parser, graph, search, validation, cache, contract, plugin, tune
  cli/               # ipa command entrypoint and renderers
  builtin-rules/     # builtin registry metadata
  test-vaults/       # canonical JS runtime fixtures
```

## Testing

```sh
pnpm test
pnpm run test:contracts
pnpm run test:cli
pnpm run smoke
```

## License

Internal — see project owner.

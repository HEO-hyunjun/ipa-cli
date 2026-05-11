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

IPA CLI is currently installed from this local JS/TS workspace. The package is
not published to npm yet.

```sh
pnpm install           # workspace install
pnpm run build         # build packages/*/dist

mkdir -p ~/.local/bin
ln -sf "$PWD/packages/cli/dist/main.js" ~/.local/bin/ipa
chmod +x packages/cli/dist/main.js
```

Make sure `~/.local/bin` is on your shell `PATH`:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Verify the command:

```sh
which ipa
ipa --help
```

The CLI entrypoint is `ipa` via `@ipa/cli`
(`packages/cli/dist/main.js` after build).

## Quickstart

```sh
# Register a default profile. `~` is expanded, but absolute paths are easiest
# to audit across machines.
mkdir -p ~/.config/ipa
cat > ~/.config/ipa/profile.yaml <<'YAML'
profiles:
  default:
    vault_path: /Users/mac/Documents/workspace/sync/IPA
    default: true
YAML

ipa profile current

# Search.
ipa engine search "ipa cli" --explain --max 5

# List the active search channels (builtin/profile + vault-local plugins).
ipa engine channels

# Validate convention (per-note rules by default).
ipa convention check --summary

# Plan and apply formatter fixes.
ipa formatter plan
ipa formatter apply
ipa formatter apply --note "Alpha"
ipa formatter apply --note "Alpha" "Beta"

# Tune with the built-in tpe-lite optimizer, save best JSON, then optionally activate it.
ipa tune --trials 200
ipa tune list
ipa tune use 2026-05-04T09-12-44.json
```

Optional AI harness install:

```sh
ipa harness install codex
ipa harness install claude
ipa harness doctor
```

Harness install adds user-global IPA skills/hooks for Codex or Claude, plus
vault-local `AGENTS.md` / `CLAUDE.md` guidance blocks and `.ipa/harness/*`
metadata.

## Vault-local plugins

User plugins live inside the vault:

```text
{vault}/.ipa/plugins/
  search/              # *.js exporting search(query, notes)
  rules/               # *.js exporting rule(s) with check() and/or fix()
```

Load order is:

1. builtin defaults
2. `{vault}/.ipa/plugins/search/*.js`
3. `{vault}/.ipa/plugins/rules/*.js`

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
`--profile` and no project-local `.ipa-profile` / `.ipa-config` or
`IPA_PROFILE` selection. If there is no selected profile and no default, the
command fails.

For project-local selection, put one of these files in the working directory
or a parent directory:

```sh
printf "sample\n" > .ipa-profile
```

```yaml
# .ipa-config
profile: sample
# or
vault_path: /Users/me/sync/IPA
```

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
rules:
  enabled: true
  builtin: false
  plugins: true
  only:
    - vault.frontmatter_order
  ignore:
    - ipa.heading.no_h1
  items:
    ipa.heading.no_h1: false
    vault.obsidian.inline_tags_to_yaml: false
files:
  exclude:
    - AGENTS.md
    - 90 Settings/Profile Fixtures/**
    - 99 Fixtures/**
```

`mapping` is the vault-local declarative mapping for IPA's semantic
fields/folders. In the JS/TS runtime, custom mapping must live in
`{vault}/.ipa/config.yaml`; profile-local code fallbacks are not loaded.

`rules.enabled` disables the whole validator/formatter rule engine.
`rules.builtin` controls builtin rules, `rules.plugins` controls vault-local
rule plugin files, and `rules.items` controls individual rule ids from either
builtin or plugin sources.

`convention` controls `ipa convention check`; `formatter` controls
`ipa formatter plan/apply`. `builtin: false` disables builtin rules for
that surface. `plugins` can be `true`/`false`, a list like
`["lint"]`, or a mapping of plugin directories. `only` and `ignore`
filter by rule code after loading.

`files.exclude` removes Markdown files from the active note set for
search, traversal, validation, review, cache, and refactor operations.
Exclude patterns are vault-relative paths or globs, and emoji characters
can be used directly in those patterns, for example `**/🏠 *` for
emoji-prefixed utility notes.
Validation ignores refs and wikilinks that point at excluded files, so
utility notes can stay outside the IPA graph without creating link noise.

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

Builtin validation is limited to IPA concepts and configured field/folder
mapping. Vault-specific title styles, prefix markers, and app metadata belong
in vault-local rule plugins. A rule can expose `check()` for validator output,
`fix()` for formatter patches, or both.

```js
// {vault}/.ipa/plugins/rules/short-note-title.js
export const rules = [{
  code: "sample.short_note_title",
  severity: "info",
  check(note) {
    if ((note.id ?? "").trim().length >= 6) return [];
    return [{
      message: "note title is very short for this vault convention"
    }];
  }
}];
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
| `ipa tune replay [history.jsonl|result.json]` | Recompute trial losses against the current vault/testset |
| `ipa tune testset list/show/validate/draft/add` | Inspect, validate, draft, or extend vault-local testsets |
| `ipa tune label [--query Q --target NOTE]` | Record or list labelled query outcomes |
| `ipa tune list` | History (newest first), ★ active marker |
| `ipa tune use <filename>` | Flip the pointer; rollback to a past result |

Tune evaluates the active query pack and stores immutable result artifacts
under `.ipa/tune/results`. The optimizer is fixed to `tpe-lite`; users keep
the existing `ipa tune --trials N` command shape. By default, tune reads the
vault-local testset declared at `.ipa/config.yaml` `test.file`; the bundled
`ipa-cli-core` pack is a sample fixture pack and is only used when explicitly
requested.

## Harness

`ipa harness` manages both user-global AI harness files and vault-local
metadata under `.ipa/harness/`. `install <target>` supports `codex` and
`claude`.

For the selected target, install writes:

- user-global IPA CLI skill: `~/.codex/skills/ipa/SKILL.md` or
  `~/.claude/skills/ipa/SKILL.md`
- user-global inbox creation guard hook
- user-global `UserPromptSubmit` IPA search/view/context nudge hook
- user-global post-write Markdown lint/format nudge hook
- vault-local manifest and guard helper under `.ipa/harness/<target>/`
- vault-local system prompt block in `AGENTS.md` for Codex or `CLAUDE.md`
  for Claude

The built-in guard policy is intentionally small: new Markdown files must be
created under the configured inbox folder, while existing Markdown edits and
non-Markdown files are allowed. This supports editor/agent hooks without
hard-coding one user's vault naming convention.

The post-write nudge hook does not format automatically. It reminds the agent
to run `ipa validator` and a note-scoped
`ipa formatter plan --note "Edited Note"` after vault Markdown edits.

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
| `list-rules`       | `packages/cli` → `@ipa/core.RULES`    | Registry inspection for the 11 builtin validator rules.                |
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

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

### Prerequisites

- Bash-compatible shell on macOS or Linux.
- Node.js and npm.
- pnpm, or Corepack so the installer can activate the pinned pnpm version from
  `package.json`. If neither pnpm nor Corepack is available, the installer can
  install pnpm globally with npm when run with `--yes`.
- curl and tar for the no-clone GitHub archive install below.

### Install from GitHub without cloning

This downloads the GitHub source archive into a persistent local source
directory, then runs the normal workspace installer from there. The source
directory is kept because the installed `ipa` command links to the built
workspace entrypoint.

```sh
IPA_SRC_DIR="${IPA_SRC_DIR:-$HOME/.local/share/ipa-cli}"
mkdir -p "$IPA_SRC_DIR"
curl -fsSL https://github.com/HEO-hyunjun/ipa-cli/archive/refs/heads/main.tar.gz \
  | tar -xz --strip-components=1 -C "$IPA_SRC_DIR"
bash "$IPA_SRC_DIR/scripts/install.sh" --yes
```

To skip shell rc PATH changes:

```sh
IPA_SRC_DIR="${IPA_SRC_DIR:-$HOME/.local/share/ipa-cli}"
bash "$IPA_SRC_DIR/scripts/install.sh" --yes --no-rc
```

### Local workspace install

```sh
scripts/install.sh
```

The script checks for Node/npm/pnpm, installs workspace dependencies, builds
`packages/*/dist`, links `ipa` into `~/.local/bin`, and can add that directory
to your zsh/bash PATH.

Equivalent manual install:

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

If `ipa` is not found in the current shell after installation, reload your shell
config, for example:

```sh
source ~/.zshrc
```

The CLI entrypoint is `ipa` via `@ipa/cli`
(`packages/cli/dist/main.js` after build).

### Update

`ipa update` locates the git checkout behind the running `ipa` binary, fetches
upstream, and reports how many commits behind it is. `--apply` runs
`git pull --ff-only`, `pnpm install`, and `pnpm run build`; the `~/.local/bin/ipa`
symlink keeps pointing at the rebuilt output, so no relink is needed.

```sh
ipa --version        # e.g. ipa 0.1.0 (3e09d15)
ipa update           # show pending upstream commits and the commands to run
ipa update --apply   # fast-forward pull and rebuild
```

Apply refuses to run while the checkout has uncommitted changes or has
diverged from upstream. After a CLI update, run `ipa harness status`; if it
reports outdated components, refresh them with `ipa harness update <target>`.

## Quickstart

```sh
# Register a default profile. `~` is expanded at runtime.
ipa profile init --vault ~/ipa

# Add another profile and make it the default.
ipa profile new work /Users/mac/Documents/workspace/sync/IPA --default

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
ipa harness init codex
ipa harness install codex
ipa harness install claude
ipa harness install opencode
ipa harness update claude
ipa harness doctor
```

`harness init` is an alias for `harness install`. `install <target>` supports
`codex`, `claude`, and `opencode`; the default target is `codex`. A normal
`install`/`init` installs every component except the evidence nudge/logging
hook (`hook:evidence`), which is opt-in via `--with hook:evidence` (an A/B
benchmark showed no behavioral benefit over the prompt/skill surface, while
logging every prompt into the vault tune log).

Component selectors adjust an install:

```sh
ipa harness install opencode --with hook:evidence
ipa harness install opencode --only skill,prompt
ipa harness install codex --only hook:guard
```

Harness install/init adds user-global IPA skills/hooks for Codex, Claude, or
OpenCode, vault-local `AGENTS.md` / `CLAUDE.md` guidance blocks,
`.ipa/harness/*` metadata, and the `.ipa/plugins` JS authoring scaffold used
for convention/search plugins.

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
  date_format: "YYYY/MM/DD (ddd) HH:mm:ss"
test:
  file: .ipa/tune/testsets/testset.json
weights:
  file: .ipa/tune/results/2026-05-06T21-30-00.json
review:
  sot:
    title_patterns: [계획, 결과, report, plan]
    min: 4
link:
  stopwords: [참여자, 요약]
  ignored_headings: [전사문, transcript]
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

`mapping.date_format` sets the timestamp format core writes into the mapped
date fields (tokens: `YYYY MM DD ddd HH mm ss`); the default is
`YYYY/MM/DD (ddd) HH:mm:ss`. `review.sot.title_patterns` supplies the
report-style title vocabulary for `ipa review sot` — the scope stays silent
until the vault declares its own patterns (`min` sets the pileup threshold,
default 4). `link.stopwords` and `link.ignored_headings` extend the
link-suggestion vocabulary: stopwords are dropped from semantic queries and
body text under ignored headings is skipped, so vault-specific formats
(meeting transcripts, boilerplate sections) stay out of link suggestions.

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

Initialize the vault-local plugin workspace first:

```sh
ipa plugin init
```

This creates an IDE-friendly JavaScript authoring scaffold:

```text
{vault}/.ipa/plugins/
  jsconfig.json
  types/ipa-plugin.d.ts
  rules/_example-title-length.js
  search/_example-heading-search.js
```

Example files start with `_`, so IPA ignores them until you rename or copy
them to a non-underscore filename.

### Convention rule

Builtin validation is limited to IPA concepts and configured field/folder
mapping. Vault-specific title styles, prefix markers, and app metadata belong
in vault-local rule plugins. A rule can expose `check()` for validator output,
`fix()` for formatter patches, or both. The rule context carries the parsed
`.ipa/config.yaml` as `ctx.config`, so a rule can read its own settings from a
vault-owned config key instead of hard-coding thresholds.

```js
// {vault}/.ipa/plugins/rules/short-note-title.js
// @ts-check

/** @type {import("../types/ipa-plugin").Rule[]} */
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
// @ts-check

/** @type {import("../types/ipa-plugin").SearchPlugin} */
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
| `ipa tune log` | Inspect recorded search events |
| `ipa tune testset init/list/show/validate/draft/add` | Create, inspect, validate, draft, or extend vault-local testsets |
| `ipa tune label [--query Q --target NOTE]` | Record or list labelled query outcomes |
| `ipa tune list` | History (newest first), ★ active marker |
| `ipa tune use <filename>` | Flip the pointer; rollback to a past result |

Tune evaluates the active query pack and stores immutable result artifacts
under `.ipa/tune/results`. The optimizer is fixed to `tpe-lite`; users keep
the existing `ipa tune --trials N` command shape. By default, tune reads the
vault-local testset declared at `.ipa/config.yaml` `test.file`; the bundled
`ipa-cli-core` pack is a sample fixture pack and is only used when explicitly
requested.

For tune-data collection, run searches with logging enabled:

```sh
IPA_SEARCH_LOG=1 ipa search "keyword"
ipa tune log
ipa tune testset draft --file testset.json
```

When the Codex or Claude harness is installed, the `UserPromptSubmit` hook also
records user prompt events in the same JSONL log with `event_type: "prompt"`,
and writes the current prompt context under `.ipa/tune/logs/`. Subsequent plain
`ipa search "keyword"` commands are logged automatically from that prompt
context, even when the agent runtime does not propagate session env-file
exports. Logged `ipa search` events include `agent`, `session_id`, `turn_id`,
`prompt_event_id`, `source_prompt`, and `generated_query`. If an agent does not
run a search for a prompt, only the prompt event remains.

## Harness

`ipa harness` manages both user-global AI harness files and vault-local
metadata under `.ipa/harness/`. `install <target>` supports `codex`, `claude`,
and `opencode`; `init <target>` is the same bootstrap command. The default
target is `codex`. A normal `install`/`init` installs every component except
the evidence nudge/logging hook (`hook:evidence`), which is opt-in via
`--with hook:evidence`. Component selectors adjust an install:
`--only <component...>` installs just the named components, `--with
<component...>` adds components to the default set, and `--without
<component...>` removes components from the default set.

```sh
ipa harness install opencode --with hook:evidence
ipa harness install opencode --only skill,prompt
ipa harness install codex --only hook:guard
```

Installed harness files are generated from templates inside the CLI. After a
CLI update, `ipa harness status` and `ipa harness doctor` compare the installed
files against the current templates and list any target with
`outdated_components` plus an update hint. `ipa harness update <target>`
uninstalls and reinstalls the target with the same component selection (an
omitted `hook:evidence` stays omitted), so renamed or dropped hook scripts do
not survive as orphans.

To fork a managed file (for example, to localize a vault-local skill), remove
the `IPA_HARNESS_MANAGED` marker from it. Marker-less files are user-owned:
install, update, and uninstall leave them untouched (install reports them as
`skipped_user_owned`), doctor stops flagging them as missing or outdated, and
`ipa harness status` lists them under `user-owned`.

For the selected target, install writes:

- user-global IPA CLI skill: `~/.codex/skills/ipa/SKILL.md`,
  `~/.claude/skills/ipa/SKILL.md`, or `~/.config/opencode/skills/ipa/SKILL.md`
- user-global `SessionStart` environment hook that exports `IPA_SEARCH_LOG=1`
- user-global inbox creation guard hook
- user-global `UserPromptSubmit` IPA context-first nudge hook (only with the
  opt-in `hook:evidence` component)
- user-global post-write Markdown lint/format nudge hook
- user-global `Stop` formatter gate that blocks final responses while edited
  vault notes still have formatter patches
- vault-local manifest and guard helper under `.ipa/harness/<target>/`
- vault-local system prompt block in `AGENTS.md` for Codex/OpenCode or
  `CLAUDE.md` for Claude
- vault-local helper skills:
  - Codex: `.agents/skills/ipa-rule`, `.agents/skills/ipa-config`, `.agents/skills/ipa-tune`
  - Claude: `.claude/skills/ipa-rule`, `.claude/skills/ipa-config`, `.claude/skills/ipa-tune`
  - OpenCode: `.opencode/skills/ipa-rule`, `.opencode/skills/ipa-config`, `.opencode/skills/ipa-tune`
- vault-local `.ipa/plugins` scaffold with JS types and disabled rule/search
  examples

OpenCode native locations differ from Codex/Claude. User-global files land
under `~/.config/opencode/`: `~/.config/opencode/AGENTS.md` (managed system
prompt), `~/.config/opencode/skills/ipa/SKILL.md` (IPA CLI skill), and
`~/.config/opencode/plugins/ipa-harness.js` (plugin that records prompt
events). Vault-local files are `AGENTS.md` and `.opencode/skills/...` helper
skills.

OpenCode evidence behavior has one limitation: the OpenCode plugin can record
prompt events, but unlike Claude's `UserPromptSubmit` hook it cannot inject
additional model context into the running turn. The IPA nudge instructions
reach the model only through the managed `AGENTS.md` and skill text, not via a
hook-injected context block.

The built-in guard policy is intentionally small: new Markdown files must be
created under the configured inbox folder, while existing Markdown edits,
non-Markdown files, and paths excluded from note indexing are allowed. This
supports editor/agent hooks without hard-coding one user's vault naming
convention.

Vaults can widen the policy declaratively instead of bypassing the guard. Add
allow patterns to `.ipa/config.yaml`; new Markdown under a matching path is
allowed even outside the inbox (for example, an approved workflow that files
meeting notes directly into the archive):

```yaml
harness:
  guard:
    allow:
      - "02 Archive/회의록/**"
```

`ipa harness guard status` lists the active allow patterns.

Harness prompts use `ipa context "keyword" --size small|medium --format
markdown` as the initial compact note pack. Treat that pack as a bootstrap:
if it is narrow, ambiguous, or only one note, use `ipa search "keyword"` to
surface adjacent candidates before deciding what the vault says. In harness
sessions, that search is logged from the current prompt context; `IPA_SEARCH_LOG=1`
remains supported for explicit non-harness logging.
`ipa view "Note Title" --full` is for selected note inspection after the
likely source notes are identified.

When a vault note is edited through the harness, the post-write hook records the
note under `.ipa/harness/formatter-pending.json`. The `Stop` hook reruns
`ipa formatter plan --note ...`; if patches remain, it blocks the final response
until the matching `ipa formatter apply --note ...` has been run.

The vault-local prompt also describes the operational workflow for profile
resolution, note discovery, safe writes, convention checks, formatter apply,
and vault-local JS authoring. For vault-specific convention behavior, create or
adjust `.ipa/plugins/rules/*.js`, verify it with `ipa plugin validate`,
`ipa plugin dry-run rules ... --note "Note Title"`, `ipa list-rules`,
`ipa validator`, and then run the formatter plan/apply loop. For retrieval
behavior, use `.ipa/plugins/search/*.js` and `ipa plugin dry-run search`.

The helper skills split common IPA operations into focused workflows:
`ipa-rule` for rule plugins and formatter-backed conventions, `ipa-config` for
`.ipa/config.yaml` and profile registry work, and `ipa-tune` for search-log
sampling, labelled testsets, tune result analysis, and activating selected
results.

The post-write nudge hook does not format automatically, but it makes apply the
expected completion path: run `ipa validator`, inspect the note-scoped
`ipa formatter plan --note "Edited Note"`, then run the matching
`ipa formatter apply --note "Edited Note"` when the plan is expected.

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
| `context`          | `@ipa/core.buildContext`             | Compact agent context pack with selected notes, excerpts, and local graph. |
| `validator`        | `@ipa/core.validateVault`            | Validator engine plus formatter-aware issue reporting; `--note` scopes output to edited notes. |
| `search`           | `@ipa/core.searchVault`              | Weighted builtin and vault-local JS plugin search.                     |
| `refactor`         | `@ipa/core.refactorVault`            | Parse-layer scan/filter plus frontmatter/body mutation.                |
| `note replace`     | `@ipa/core.replaceInNote`            | Core note lookup plus raw-note replacement; syncs `date_modified` and cleans consumed `.tmp` inputs on apply. |
| `note set`         | `@ipa/core.setNoteField`             | Frontmatter-only edits (scalar `--value`, list `--add`/`--remove`) without exact-match blocks. |
| `digest`           | `@ipa/core.digestNote`               | One-call index summary: children with modified dates, section titles, and snippets. |
| `note redirect`    | `@ipa/core.redirectNotes`            | Repoint every wikilink/ref from source notes to a target; optional archive of sources. |
| `cascade`          | `@ipa/core.cascadeNote`              | Staged ripple for a note: appliable ref/link wiring plus report-only overlap candidates. |
| `update`           | `@ipa/core.selfUpdate`               | Git-checkout self-update: plan shows behind-count/commands, apply runs ff-only pull + rebuild. |
| `harness update`   | `@ipa/core.harnessUpdate`            | Uninstall + reinstall harness files with the current templates, preserving component selection. |

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

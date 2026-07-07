# Contributing

ipa-cli operates an IPA (Inbox-Project-Archive) Obsidian vault from the command
line and from agent harnesses. Before changing anything, read `CLAUDE.md` — it
holds the binding design rules and the traps this codebase has already hit.
This guide is the contributor workflow.

## Dev setup

This is a pnpm workspace (`packages/*`). The pinned package manager is in
`package.json` (`packageManager`); use Corepack or an equivalent pnpm.

```sh
pnpm install       # workspace install
npm test           # builds first, then runs the node:test suites
```

`npm test` runs `scripts/build.mjs` before the tests. **Do not run `node --test`
directly** — it executes against a stale `packages/core/dist` and will pass or
fail against code you did not build. Always go through `npm test` (or the other
`npm run` scripts, which also build first). See `ARCHITECTURE.md` for the full
directory map.

## Repo layout

One line per top directory; full map in `ARCHITECTURE.md`.

- `packages/` — the JS/TS workspace: `core` (all logic in `src/index.ts`),
  `cli` (commander wiring), `obsidian` (plugin build), `builtin-rules`,
  `test-vaults`.
- `bench/` — Tier 3 behavioral benchmark (headless agent sessions).
- `docs/` — historical planning docs (`superpowers/`).
- `examples/` — copy-paste vault plugin sample.
- `scripts/` — build, install, lint, smoke.
- `CLAUDE.md` is the single source of agent-steering rules; `AGENTS.md` is a
  symlink to it so Codex and other AGENTS.md-reading tools share one source.

## Design rules (binding)

These are enforced in review; the long form is in `CLAUDE.md`.

- **Mechanism in the CLI, policy in the vault.** Folder and frontmatter names
  come from `.ipa/config.yaml` `mapping` — never hardcode `ref`, `tags`, or
  `00 Inbox` in features or prompt templates. One user's workflow belongs in a
  vault plugin (`rules`/`search`/`gates`) or a harness fragment, not in core.
- **Hooks must fail safe.** A broken gate plugin, missing CLI, or unparseable
  output must never permanently lock a session; recording hooks stay silent on
  stdout unless they mean to inject context.
- **Prompt templates are contract surfaces.** Any change to a template (global
  skill, prompt blocks, vault-local skills) needs a rendering regression
  assertion: remap `refs`/`tags`/folders in the test config and assert the
  rendered output, plus `doesNotMatch` guards so removed duplication cannot
  creep back.
- **No personal vault content.** Tests, fixtures, docs, and templates use
  neutral titles (`Alpha`, `Beta`, `TICKET-1 구현 계획`). Never paste real note
  titles, employer/project names, or absolute personal paths.
- **Managed vs user-owned.** Every file the harness writes carries the
  `IPA_HARNESS_MANAGED` marker. A target file without the marker is user-owned
  and must never be overwritten (reported as `skipped_user_owned`). Preserve
  this contract in any install/update change.

## Commit convention

Conventional commits (`feat|fix|refactor|docs|test|chore`). Korean subject lines
are the norm here. Split commits by meaning, not by file.

## Branching & release

- `main` is always releasable: `npm test` green is required, and any harness /
  prompt / CLI-surface change must clear the Bench Gate (smoke, then full before
  adoption — see Test tiers below).
- Work on a meaning-scoped topic branch even solo: `feat/…`, `fix/…`,
  `bench/…`, `docs/…`.
- Merge fast-forward when the commits are already clean meaning-units;
  squash-merge when the branch carries WIP. Either way `main` history keeps only
  meaning-unit conventional commits.
- No `develop` / gitflow branch — overkill at this scale.
- Release from a milestone: a version-bump commit
  (`chore: X.Y.Z 버전업 — highlights`) plus a `vX.Y.Z` tag.
- Sync the repo between machines with `git push`/`pull` (origin), never by
  file-syncing the working tree — file-syncing `.git` risks corrupting it.

## Test tiers

- **Tier 1/2 — `npm test`.** The `node:test` suites over core, cli, and bench.
  Pure internal refactoring that leaves the prompt and CLI surfaces unchanged is
  fully covered here.
- **Tier 3 — Bench Gate.** Any change to a harness/skill/prompt template, a
  global/vault prompt string, or a CLI command surface (flags, output format)
  must also pass the behavioral benchmark:
  1. After the change: `npm run bench -- --smoke`.
  2. Before adopting (merge/commit): `npm run bench -- --full`.
  3. On a passing full run: `npm run bench -- --full --update-baseline`, then
     commit `bench/results/baseline.jsonl` and `history.jsonl` with the change.
  4. If a run fails or a baseline shows `regressed` / `cost_up`, put the
     root-cause analysis in the commit message.

  See `bench/README.md` for the eval model.

## Adding a harness component

A new harness component (a hook, a prompt surface, etc.) must be registered in
*all* of these or `harness update`/`doctor` will drift:

- `HARNESS_COMPONENTS`
- the script / event / matcher maps
  (`HARNESS_HOOK_COMPONENT_TO_SCRIPT` / `_TO_EVENT` / `_TO_MATCHER`)
- `IPA_MANAGED_HOOK_SCRIPTS` (keep old script names listed for legacy cleanup)
- `installGlobalHarness` and `uninstallGlobalHarness`
- `componentsValidForTarget` (which targets the component applies to)
- doctor

## Plugin contract

The plugin API is a contract. `PLUGIN_TYPES` in core generates
`.ipa/plugins/types/ipa-plugin.d.ts`, which is the authoritative definition —
change the types there, not in scattered docs. When the contract changes,
installed vaults pick it up only after `ipa harness update` (or
`ipa plugin init` re-scaffold), so ship the change to the agent surface, don't
just land the code.

## The Obsidian consumer

The CLI is not the only consumer of core. `packages/obsidian` calls core
entrypoints directly through `packages/obsidian/src/core/ipaClient.ts`
(`prepareSearchContext`/`searchWithContext`, `loadNotesForView`, `traversalAll`,
`formatVault`, plugin list/doctor). When you change a core signature or return
shape, grep `ipaClient.ts` for the symbol and run `npm run build` — the build
compiles both the core and Obsidian bundles, while `npm test` only builds the
core bundle. Deployment into a vault is `ipa obsidian install|sync`.

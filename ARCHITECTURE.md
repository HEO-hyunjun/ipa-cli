# Architecture

A map of the repository, one to two lines per entry. For the design rules that
govern *where* code and policy live, read `CLAUDE.md`; this document is the
directory layout and the big-picture data flow.

## Data flow

```text
core (packages/core/src/index.ts — one file, all logic)
  ├── cli (packages/cli — commander wiring only, renders core results)
  └── obsidian (packages/obsidian — direct core consumer, cjs plugin bundle)

bench (bench/) drives headless `claude -p` sessions against sandbox copies of
      bench/vaults/ and judges whether the agent used the CLI well.
```

`core` is the single source of truth: vault IO, the search pipeline,
validator/formatter rules, tune, harness templates + install, and the plugin
loaders all live in `packages/core/src/index.ts`. `cli` and `obsidian` are two
front ends over the same core — the CLI holds no business logic, and the
Obsidian plugin calls core entrypoints directly rather than shelling out to
`ipa`. The behavioral benchmark (`bench/`) is a third consumer that runs real
agent sessions to check that the *prompted* harness surface actually teaches
agents to use the CLI.

## Directories

### `packages/` — the JS/TS workspace (pnpm)

- `core/` — the entire runtime.
  - `src/index.ts` — vault IO, search, rules, tune, harness templates/install,
    plugin loaders. Navigate by symbol search, not by file.
  - `tests/` — `node:test` suites (contracts, search, harness, rules).
  - `dist/` — build output (`scripts/build.mjs`).
- `cli/` — the `ipa` command.
  - `src/main.ts` — commander wiring and result rendering only.
  - `tests/` — CLI-surface regression suites (help text, output shapes).
  - `dist/main.js` — built entrypoint the `ipa` symlink points at.
- `obsidian/` — the Obsidian plugin build of the same core.
  - `src/` — plugin adapter, views, settings, and `core/ipaClient.ts` (the
    thin wrapper over core entrypoints).
  - `manifest.json` / `styles.css` / `versions.json` — Obsidian release assets.
  - `dist/` — the cjs bundle deployed by `ipa obsidian install|sync`.
- `builtin-rules/` — builtin registry metadata (rule/channel/refactor ids).
  - `src/index.ts` — the metadata table; `dist/` is its build output.
- `test-vaults/` — canonical JS runtime fixtures.
  - `fixtures/` — vault fixtures the core/CLI compatibility tests load.

### `bench/` — Tier 3 behavioral benchmark

- `lib/` — the harness internals: `runner.mjs` (session driver), `sandbox.mjs`
  (isolated vault + config-dir setup), `judge.mjs` (verdict scoring),
  `responder.mjs`, `transcript.mjs`, `schema.mjs`, `baseline.mjs`.
- `scenarios/` — scenario catalog grouped `a`–`g` (recognition, read, write,
  robustness, authoring, migration, workflows).
- `tools/` — `derive-vaults.mjs` (regenerate persona vaults) and
  `seed-baseline.mjs`.
- `tests/` — `node:test` coverage of the bench harness itself (catalog, judge,
  runner, sandbox, schema, transcript, hooks-e2e).
- `vaults/` — the persona vaults sessions run against (see derive chain below).
- `results/` — `baseline.jsonl` + `history.jsonl` (committed summaries);
  `runs/` holds per-run artifacts and is gitignored.
- `run.mjs` — the `npm run bench` entrypoint.

The persona vaults have a derive chain: `divergent/` is the hand-edited source
of truth; `tools/derive-vaults.mjs` deterministically regenerates the rest and
they are committed (never hand-edit the derived vaults). `canonical/` is derived
from `divergent/`; `messy/` and `pre-ipa/` are both derived from `canonical/`
(messy degrades frontmatter; pre-ipa strips IPA structure back out to reproduce
a vault before IPA). `empty/` is a standalone empty-vault fixture, not derived.

### `docs/` — planning history

- `superpowers/plans/` and `superpowers/specs/` — historical planning and
  design docs for the bench effort (kept for provenance, not live reference).

### `examples/`

- `sample_profile/` — a copy-paste vault-local plugin sample (one search
  channel + one rule + a tune workspace layout).
- `testset.example.json` — a sample tune testset.

### `scripts/`

- `build.mjs` — builds `packages/{core,cli,builtin-rules}/dist`.
- `build-obsidian.mjs` — builds the Obsidian cjs bundle.
- `install.sh` — the local/GitHub installer (build + symlink + PATH).
- `lint.mjs` — the `npm run lint` entry.
- `smoke.mjs` — the `npm run smoke` end-to-end sanity pass.

### Root config

- `package.json` / `pnpm-workspace.yaml` — workspace definition and scripts;
  the active runtime is everything under `packages/`.
- `pnpm-lock.yaml` — the pinned dependency lockfile.
- `eslint.config.js`, `tsconfig.json`, `vitest.config.ts` — lint/type/test
  config for the workspace.
- `CLAUDE.md` — agent steering (design rules, traps); `AGENTS.md` is a symlink
  to it so Codex and other AGENTS.md-reading tools share the same source.

# CLAUDE.md

ipa-cli is a general-purpose toolkit for operating an IPA (Inbox-Project-Archive)
Obsidian vault from the command line and from agent harnesses: search, read,
validate, format, tune, and safely write notes. Every vault is different — this
project ships the *mechanism*, and each vault supplies its own *policy*. That
split is the core design rule of the codebase.

## Design rules (read before changing anything)

- **Mechanism in the CLI, policy in the vault.** Folder and frontmatter names
  come from `.ipa/config.yaml` `mapping` — never hardcode `ref`, `tags`, or
  `00 Inbox` in features or prompt templates; render `${mapping.refs}` etc.
  Vault conventions are rule plugins, retrieval boosts are search plugins,
  session-end policy is gate plugins (`.ipa/plugins/{rules,search,gates}/`),
  and vault-specific operating rules enter managed prompts via
  `.ipa/harness/fragments/<artifact>.md`. If a feature encodes one user's
  workflow, it belongs in a vault plugin/fragment, not in core.
- **No personal vault content in this repo.** Tests, fixtures, docs, and
  templates use neutral titles (`Alpha`, `Beta`, `TICKET-1 구현 계획`,
  `🔖 플랫폼 회의`). Never paste real note titles, employer/project names, or
  absolute personal paths.
- **Managed vs user-owned.** Every file the harness writes carries the
  `IPA_HARNESS_MANAGED` marker. A target file without the marker is user-owned
  and must never be overwritten (it is reported as `skipped_user_owned`).
  Preserve this contract in any install/update change.
- **Hooks must fail safe.** A broken gate plugin, missing CLI, or unparseable
  output must never permanently lock a session; recording hooks must stay
  silent on stdout unless they intend to inject context.

## Repo layout

- `packages/core/src/index.ts` — the entire core in one file (vault IO, search
  pipeline, validator/formatter rules, tune, harness templates + install,
  plugin loaders). Expect to navigate by symbol search, not by file.
- `packages/cli/src/main.ts` — commander wiring only; keep logic in core.
- `packages/obsidian/` — Obsidian plugin build of the same core.
- `packages/{core,cli}/tests/*.test.mjs` — `node:test` suites.

## Dev workflow

- `npm test` builds first (`scripts/build.mjs`) and then runs both test
  packages. Running `node --test` directly executes against a stale
  `packages/core/dist` — always go through `npm test`.
- Tests build isolated fixture vaults (`fixtureVault()`) and isolated
  `homeDir`s; hook-script tests point resolution at the fixture with
  `IPA_VAULT_PATH` in the spawned env.
- Commit style: conventional commits (`feat|fix|refactor|docs|test|chore`),
  subject lines in Korean are the norm here.

## Things that bite

- **Generated hook scripts are template literals.** The code inside
  `` `#!/usr/bin/env node ...` `` needs escaped newlines (`\\n`) where the
  *generated* script must contain `\n`, and every symbol used by
  `vaultResolverSnippet()` (`homedir`, `join`, `spawnSync`, `readFileSync`)
  must be imported by the generated script itself. A missing import passes
  tests that set `IPA_VAULT_PATH` and crashes in real installs.
- **Prompt templates are contract surfaces.** Any change to a template
  (global skill, prompt blocks, vault-local skills) needs a regression
  assertion: mapped-name rendering (remap `refs`/`tags`/folders in the test
  config and assert the rendered output) and `doesNotMatch` guards that keep
  removed duplication from creeping back.
- **`harness update` vs `install`.** Update re-renders from the manifest's
  component selection, auto-joins default components added by newer CLI
  versions, and honors `omitted_components`. New components must be added to
  all of: `HARNESS_COMPONENTS`, the script/event/matcher maps,
  `IPA_MANAGED_HOOK_SCRIPTS` (old names stay listed for legacy cleanup),
  `installGlobalHarness`, `uninstallGlobalHarness`, and doctor.
- **Search is performance-sensitive.** The BM25 index persists at
  `.ipa/cache/bm25.bin` keyed by a per-file stat signature; per-query work
  must stay out of per-note loops. Benchmark before/after for search-path
  changes (tune testset queries, median of repeated runs, diff result lists).
- **Behavior claims need behavioral evidence.** For prompt/harness changes
  that are supposed to change agent behavior, prefer a headless A/B run
  (`claude -p` sessions against a sandbox copy of a vault) over intuition;
  document method and results.

## Reference docs

`README.md` covers user-facing commands, plugin contracts, tune workflow, and
harness targets. The generated `.ipa/plugins/types/ipa-plugin.d.ts` is the
authoritative plugin contract. `ipa convention` renders IPA concepts plus the
active vault's operating rules.

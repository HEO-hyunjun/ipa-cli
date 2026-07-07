# @ipa/core

The entire IPA runtime: vault IO, the search pipeline, validator/formatter
rules, tune, harness templates + install, and the plugin loaders. `cli`,
`obsidian`, and `bench` are all consumers of this package.

## Entry points

- `src/index.ts` — everything lives in this one file. Navigate by symbol
  search, not by directory. Key symbols: `searchVault`, `validateVault`,
  `formatVault`, `buildContext`, `harnessUpdate`/`installGlobalHarness`, and
  the `HARNESS_COMPONENTS` maps.
- `tests/*.test.mjs` — `node:test` suites (build first via `npm test`).

## Gotchas

- **Generated hook scripts are template literals.** The `` `#!/usr/bin/env
  node …` `` strings need `\\n` where the *generated* script must contain a real
  `\n`, and every symbol used by `vaultResolverSnippet()` (`homedir`, `join`,
  `spawnSync`, `readFileSync`) must be imported by the generated script itself.
  A missing import passes tests that set `IPA_VAULT_PATH` and crashes in real
  installs.
- **`PLUGIN_TYPES` is the plugin contract.** It generates
  `.ipa/plugins/types/ipa-plugin.d.ts`, the authoritative plugin API. Change
  the types here, and remember installed vaults only pick it up after
  `ipa harness update` / `ipa plugin init`.
- Adding a harness component touches several maps at once — see the checklist
  in `../../CONTRIBUTING.md`.

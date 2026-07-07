# @ipa/obsidian

The Obsidian plugin build of IPA. A direct consumer of `@ipa/core` — it calls
core entrypoints in-process rather than shelling out to the `ipa` CLI.

## Entry points

- `src/main.ts` — the Obsidian plugin entry; `src/core/ipaClient.ts` is the
  thin wrapper over core (`prepareSearchContext`/`searchWithContext`,
  `loadNotesForView`, `traversalAll`, `formatVault`, plugin list/doctor).
- `manifest.json` / `styles.css` / `versions.json` — Obsidian release assets.
- `dist/` — the cjs bundle produced by `scripts/build-obsidian.mjs`.

## Deploy

The bundle is deployed into a vault with `ipa obsidian install` (first-time)
and `ipa obsidian sync` (refresh an existing install). `ipa update --apply`
rebuilds and syncs automatically when the active vault already carries an
install. Only release assets are copied; the plugin's `data.json` settings are
never touched.

## Gotchas

- **When you change a core signature, grep `src/core/ipaClient.ts`.** This
  package breaks silently otherwise — `npm test` only builds the core bundle,
  so run `npm run build` to compile the Obsidian bundle too.
- **The `import.meta` build warning is benign.** esbuild warns because
  `cliVersionInfo()` (a CLI self-update helper) uses `import.meta.url`; that
  path is unreachable from the plugin, so the warning is expected.

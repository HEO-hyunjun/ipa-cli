# scripts

Build, install, and check scripts for the workspace. `npm run` targets in the
root `package.json` invoke these; most build first, so contributors rarely call
them directly.

## What each does

- `build.mjs` — builds `packages/{core,cli,builtin-rules}/dist`. Every
  `npm run` target that runs code (`test`, `smoke`, `bench`) runs this first, so
  running `node --test` by hand executes against a stale `dist`.
- `build-obsidian.mjs` — builds the Obsidian cjs plugin bundle
  (`packages/obsidian/dist`). `--watch --copy-dev` rebuilds and copies into a
  dev vault on change. `npm run build` runs both `build.mjs` and this.
- `install.sh` — the local/GitHub installer: checks Node/pnpm, installs
  workspace deps, builds `dist`, links `ipa` into `~/.local/bin`, and can add
  that dir to the shell PATH. `--yes` is non-interactive, `--no-rc` skips the
  PATH edit.
- `lint.mjs` — the `npm run lint` entry.
- `smoke.mjs` — the `npm run smoke` end-to-end sanity pass.

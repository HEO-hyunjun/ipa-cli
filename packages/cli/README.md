# @ipa/cli

The `ipa` command. Commander wiring and result rendering only — all business
logic lives in `@ipa/core`.

## Entry points

- `src/main.ts` — commander command/option definitions and the renderers that
  turn core return values into terminal output. If you find yourself writing
  vault or search logic here, it belongs in core instead.
- `dist/main.js` — the built entrypoint the installed `ipa` symlink points at.
- `tests/cli.test.mjs` — CLI-surface regression suites.

## Gotchas

- **Keep logic in core.** This package is a thin front end; a second consumer
  (the Obsidian plugin) calls core directly, so anything implemented here would
  not be shared.
- **Help/output surfaces are asserted in tests.** Command help text and output
  shapes are contract surfaces — changing a flag, its description, or an output
  format will trip (and must update) the CLI regression assertions.
- Run through `npm test`, never `node --test` directly (it hits a stale
  `dist`).

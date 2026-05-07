# Legacy refactor subcommands

`ipa refactor` exposes seven argparse-style subcommands inherited from
the 1차 `vault_refactor.py`. S6 keeps every subcommand working by
routing them through `runtime/refactor.py` (which calls the 1차
`cmd_*` helpers directly — these stay alive as the parity oracle until
S7). The matrix below documents the surface so future work can either
port a recipe to a fresh `BaseConventionRule` + `formatter_engine`
patch flow, or drop it.

| Subcommand        | Positional args | Effect on disk                                                | New-service candidate                            |
|-------------------|-----------------|----------------------------------------------------------------|--------------------------------------------------|
| `ref-replace`     | OLD NEW         | Rewrite each `[[OLD]]` entry inside frontmatter `ref` arrays.  | `formatter_engine` + new ref-rewrite rule        |
| `tag-rename`      | OLD NEW         | Replace OLD with NEW in frontmatter `tags` arrays.             | new tag rule with `fix()` patch                  |
| `tag-remove`      | TAG             | Remove TAG from `tags` arrays.                                 | new tag rule with `fix()` patch                  |
| `tag-add`         | TAG             | Append TAG to `tags` arrays (idempotent).                      | new tag rule with `fix()` patch                  |
| `wikilink-replace`| OLD NEW         | Rewrite each `[[OLD]]` in note bodies (excluding code blocks). | new wikilink rewrite rule                        |
| `ref-add`         | REF             | Append `[[REF]]` to frontmatter `ref` arrays (idempotent).     | new ref rule with `fix()` patch                  |
| `ref-remove`      | REF             | Remove `[[REF]]` entries from frontmatter `ref` arrays.        | new ref rule with `fix()` patch                  |

All subcommands share the option flags below:

| Flag             | Meaning                                                            |
|------------------|--------------------------------------------------------------------|
| `--apply`        | Persist changes to disk. Default is dry-run.                       |
| `--filter`       | Target only the listed note ids (comma-separated).                 |
| `--scope-ref`    | Only consider notes whose frontmatter `ref` includes this name.    |
| `--scope-tag`    | Only consider notes carrying this tag.                             |
| `--scope-type`   | Only consider notes of the given `type` (`note`/`index`/`root`).   |
| `--scope-folder` | Only consider notes whose path starts with the given folder.       |

### Current state (S6 + S7)

`runtime/refactor.py:render_refactor` parses the raw argv with its own
argparse parser, calls the 1차 `cmd_*` handler for the matching
subcommand against `_legacy.vault_parser.build_note_index` /
`_legacy.vault_refactor.build_filter`, then captures `print_results`
stdout into a string the CLI command echoes. This keeps the synthetic
argv adapter out of `main.py` while preserving byte-identical output.

S7 renamed `src/ipa_cli/core/` to `src/ipa_cli/_legacy/` so the public
`ipa_cli.core` surface no longer exists, but the seven subcommands
above still execute the 1차 algorithms inside `_legacy` — they have
NOT been ported to the formatter engine yet.

### Follow-up

Each row in the matrix above lists the recommended new-service target.
Porting work for a given subcommand is:

1. Author a `BaseConventionRule` (or refactor recipe) that re-implements
   the mutation as a `Patch`.
2. Wire it through `formatter_engine.plan` / `apply`.
3. Replace the corresponding `_legacy.vault_refactor.cmd_*` call in
   `runtime/refactor.py:render_refactor`.
4. When all seven `cmd_*` references are gone, drop the
   `_legacy.vault_refactor` import and (eventually) the file itself.

The same pattern applies to `runtime/view.py`, which still calls
`_legacy.vault_search` render helpers. Both modules are the open items
left after the legacy-surface migration.

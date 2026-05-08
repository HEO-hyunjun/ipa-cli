# Legacy refactor subcommands

`ipa refactor` exposes seven argparse-style subcommands inherited from
the 1차 `vault_refactor.py`. They now run through
`runtime/refactor.py` on the 2차 parse model; no in-package legacy oracle
is used. The matrix below documents the preserved surface and the
current runtime implementation target.

| Subcommand        | Positional args | Effect on disk                                                | Runtime implementation                           |
|-------------------|-----------------|----------------------------------------------------------------|--------------------------------------------------|
| `ref-replace`     | OLD NEW         | Rewrite each `[[OLD]]` entry inside frontmatter `ref` arrays.  | `runtime.refactor.cmd_ref_replace`               |
| `tag-rename`      | OLD NEW         | Replace OLD with NEW in frontmatter `tags` arrays.             | `runtime.refactor.cmd_tag_rename`                |
| `tag-remove`      | TAG             | Remove TAG from `tags` arrays.                                 | `runtime.refactor.cmd_tag_remove`                |
| `tag-add`         | TAG             | Append TAG to `tags` arrays (idempotent).                      | `runtime.refactor.cmd_tag_add`                   |
| `wikilink-replace`| OLD NEW         | Rewrite each `[[OLD]]` in note bodies.                         | `runtime.refactor.cmd_wikilink_replace`          |
| `ref-add`         | REF             | Append `[[REF]]` to frontmatter `ref` arrays (idempotent).     | `runtime.refactor.cmd_ref_add`                   |
| `ref-remove`      | REF             | Remove `[[REF]]` entries from frontmatter `ref` arrays.        | `runtime.refactor.cmd_ref_remove`                |

All subcommands share the option flags below:

| Flag             | Meaning                                                            |
|------------------|--------------------------------------------------------------------|
| `--apply`        | Persist changes to disk. Default is dry-run.                       |
| `--filter`       | Target only the listed note ids (comma-separated).                 |
| `--scope-ref`    | Only consider notes whose frontmatter `ref` includes this name.    |
| `--scope-tag`    | Only consider notes carrying this tag.                             |
| `--scope-type`   | Only consider notes of the given `type` (`note`/`index`/`root`).   |
| `--scope-folder` | Only consider notes whose path starts with the given folder.       |

### Current state

`runtime/refactor.py:render_refactor` parses the raw argv with its own
argparse parser, scans notes via `parse.vault_loader.load_notes`, applies
the shared scope filters, and performs the matching frontmatter/body
mutation directly. This keeps the legacy command surface stable without
depending on the removed oracle package.

The current implementation intentionally keeps the mutation service
small and command-oriented. A future formatter integration can still
wrap these operations as `BaseConventionRule.fix()` patches, but that is
no longer required for the legacy-surface migration to be complete.

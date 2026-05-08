# Legacy validator rule code map (1차 ↔ 2차)

S4 of the *legacy surface 내부 재구현* migration replaced the synthetic-argv
adapter that formerly called `core/vault_validator.py` with
`runtime/legacy_validator_view.py`.
The new view runs `runtime.validator_engine.run_validator` against
`default_convention()` and translates each emitted `Issue` back into the 1차
code so:

- ``ipa validator`` stdout keeps the same one-line-per-issue shape and the
  `[fixable]` marker for codes the old fixers used to handle.
- ``--select`` / ``--ignore`` keep accepting the 1차 codes (single codes such
  as ``P001`` and category prefixes such as ``P``).

The mapping below is the source of truth used by the view layer
(`NEW_TO_LEGACY` / `LEGACY_TO_NEW`). Add a row whenever a new rule is
introduced in either codebase.

| 1차 code | category   | 1차 message stub                | 2차 rule class                | 2차 code                              |
|----------|------------|---------------------------------|-------------------------------|----------------------------------------|
| P001     | properties | 필수 필드 누락                   | FrontmatterRequiredFieldsRule | `ipa.frontmatter.required_field`        |
| P002     | properties | date 포맷 불일치                 | DateFormatRule                | `ipa.frontmatter.date_format`           |
| P003     | properties | 유효하지 않은 type               | InvalidTypeRule               | `ipa.frontmatter.invalid_type`          |
| P004     | properties | note/index인데 ref 없음           | MissingRefRule                | `ipa.frontmatter.missing_ref`           |
| T001     | title      | root인데 🏷️ prefix 없음          | RootTitlePrefixRule           | `ipa.title.root_prefix_missing`         |
| T002     | title      | root인데 Root suffix 없음         | RootTitleSuffixRule           | `ipa.title.root_suffix_missing`         |
| T003     | title      | index인데 🔖 prefix 없음          | IndexTitlePrefixRule          | `ipa.title.index_prefix_missing`        |
| L001     | location   | type 대비 위치 부적합              | LocationByTypeRule            | `ipa.location.type_mismatch`            |
| K001     | links      | ref 링크 대상 미존재              | RefLinkTargetRule             | `ipa.link.ref_target_missing`           |
| K002     | links      | wikilink 대상 미존재               | WikilinkTargetRule            | `ipa.link.wikilink_target_missing`      |
| R001     | root_folder| 폴더에 root 중복                  | DuplicateRootRule             | `ipa.root_folder.duplicate`             |
| R002     | root_folder| 폴더에 root 없음                  | MissingRootRule               | `ipa.root_folder.missing`               |
| H001     | headers    | h1 헤더 사용                      | NoH1Rule                      | `ipa.heading.no_h1`                     |

## `[fixable]` marker

The 1차 validator marks an issue as fixable when one of the auto-fixers
(`fix_missing_date`, `fix_missing_type`, `fix_h1_heading`,
`fix_missing_backlinks`) can repair it. The 2차 stack keeps the
fix-or-not decision on each `BaseConventionRule` (`fix()` returns a
`Patch | None`). The legacy view marks rows as fixable when the
corresponding 2차 rule implements `fix()` non-trivially. As of S4 the
fixable set is:

- `P001` (FrontmatterRequiredFieldsRule fixes `date_created` / `type`)
- `P003` (InvalidTypeRule offers a default `note` substitution)
- `H001` (NoH1Rule rewrites the leading `# heading`)

`P002` and `P004` were never `[fixable]` in 1차 either — kept that way
for round-trip parity.

## `--select` / `--ignore` parsing

A category prefix (`P`, `T`, `L`, `K`, `R`, `H`) expands to every legacy
code starting with that letter. An individual code (`P001`) selects
exactly one. The view layer translates the resulting set into the
matching 2차 codes and filters `convention.rules` before calling
`run_validator`. Tokens that match neither bucket are silently dropped
to mirror 1차 behaviour.

Aliases such as `convention check --select` or deprecation warnings are
deliberately NOT plumbed in by S4 (plan decision #4): warnings would
break the legacy stdout snapshot, and re-routing through `convention
check` is left for a later commit when we explicitly opt in.

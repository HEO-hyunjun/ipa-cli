# @ipa/builtin-rules

Builtin registry metadata: the canonical id lists for the search channels,
convention/validator rules, and refactor recipes that ship in core.

## Entry points

- `src/index.ts` — exports `channels`, `conventionRules`, and `refactors` (the
  id arrays). This is metadata only; the actual rule/channel/refactor
  implementations live in `@ipa/core`.

## Gotcha

- These lists are what `ipa list-channels` / `list-rules` / `list-refactors`
  and the registry regression tests inspect. Adding or renaming a builtin in
  core means updating the matching id here, or the counts drift.

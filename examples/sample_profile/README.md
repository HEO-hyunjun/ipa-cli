# sample_profile

This directory is a vault-local JS plugin sample. Copy its `.ipa/` directory
into a vault to enable one extra search channel and one extra lint rule.

## Install

```sh
cp -R examples/sample_profile/.ipa /Users/me/sync/IPA/.ipa
mkdir -p ~/.config/ipa
cat > ~/.config/ipa/profile.yaml <<'YAML'
profiles:
  sample:
    vault_path: /Users/me/sync/IPA
    default: true
YAML
```

You can still override selection for one project with
`printf "sample\n" > .ipa-profile`, or use `.ipa-config`:

```yaml
profile: sample
```

Use `ipa --profile sample <command>` only when you need an ad-hoc override.

## What it adds

| Surface | File | What it does |
|---|---|---|
| Search channel | `.ipa/plugins/search/heading-match.js` | Boosts notes whose markdown headings contain the query |
| Lint rule | `.ipa/plugins/lint/no-emoji-in-filename.js` | Flags non-index/non-root notes whose filename starts with an emoji |

Vault-local plugins append to builtin behavior by default. Use
`.ipa/config.yaml` to disable builtin behavior, plugin behavior, or an
individual plugin path.

## Smoke test

```sh
ipa --profile sample plugin list
ipa --profile sample plugin dry-run search .ipa/plugins/search/heading-match.js --query "your query"
ipa --profile sample convention check --summary
ipa --profile sample engine search "your query" --explain
```

## Disabling one plugin kind

```yaml
plugins:
  search: false
  lint: true
  formatter: true
```

The list is explicit on purpose: what is enabled in `.ipa/config.yaml` is
what runs.

## Tune workspace

`{vault}/.ipa/tune/testsets/` is where you place evaluation testsets.
Run `ipa --profile sample tune --apply` to write a new
`{vault}/.ipa/tune/results/{timestamp}.json` and rotate the
`weights.file` pointer in `{vault}/.ipa/config.yaml`. Past results stay
on disk so `ipa tune list` and `ipa tune use <filename>` can roll back.

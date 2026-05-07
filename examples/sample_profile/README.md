# sample_profile

Copy this directory to your profile workspace to bootstrap a custom
profile with one extra convention rule and one extra search channel.

## Install

```sh
mkdir -p ~/.config/ipa/profiles
cp -R examples/sample_profile ~/.config/ipa/profiles/sample
```

Then either:

- Select it for the current project: `printf "sample\n" > .ipa-profile`, or
- Use it ad-hoc per command: `ipa --profile sample <command>`

`profile.yaml` reads `vault_path: ${IPA_VAULT_PATH}`, so make sure that
env var is exported (or replace the placeholder with an absolute path).

## What it adds

| Surface | File | What it does |
|---|---|---|
| Convention rule | `rules/no_emoji_in_filename_rule.py` | Flags non-index/non-root notes whose filename starts with an emoji (severity `info`) |
| Search channel | `channel_rules/heading_match_channel.py` | Boosts notes whose `H1`/`H2` heading contains the query (default weight `0.10`) |

Both append to the builtin defaults — `convention.py` and `search.py`
each call `*_builtin.rules` / `*default_channels()` to inherit, then
add the profile-specific entries.

## Smoke test

```sh
# Convention check (will surface the new "sample.no_emoji_in_filename" code).
ipa --profile sample convention check --scope vault --summary

# Search with the heading boost active and inspect raw per-channel scores.
ipa --profile sample engine search "your query" --explain
```

## Removing a builtin rule or channel

Drop the unwanted entry from the spread:

```python
# convention.py
convention = Convention(
    name="sample",
    rules=[
        rule for rule in _builtin.rules
        if rule.code != "ipa.frontmatter.date_format"
    ] + [
        NoEmojiInFilenameRule(),
    ],
)
```

The list is explicit on purpose — what you see is what runs.

## Tune workspace

`tune/testsets/` is where you place evaluation testsets. Run
`ipa --profile sample tune --apply` to write a new
`tune/results/{timestamp}.json` and rotate the
`tune.result_file` pointer in `profile.yaml`. Past results stay
on disk so `ipa tune list` and `ipa tune use <filename>` can roll back.

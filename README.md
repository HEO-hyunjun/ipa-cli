# ipa-cli

Search, validate, format, and tune your [IPA](https://github.com/) Obsidian
vault from the terminal. Channels and rules live in the codebase as plain
Python — no DSL — and your profile workspace adds project-specific overrides
without touching the package.

> **Status**: 2차 구현 (P1–P7) 완료. 1차 명령(`ipa search` / `traversal` /
> `validator` / `refactor` / `tune`)은 호환 유지되고, 2차에서는 `ipa engine`,
> `ipa convention`, `ipa formatter`, `ipa tune {eval,list,use,--apply}`가
> 추가됩니다.

## Install

```sh
uv sync                # dev workflow
uv run pytest -q       # confirm green
uv run ipa --help      # CLI surface
```

The CLI entrypoint is `ipa` (defined in `pyproject.toml` as
`ipa = ipa_cli.main:app`).

## Quickstart

```sh
# Point IPA at your vault.
export IPA_VAULT_PATH=~/sync/IPA

# Search.
ipa engine search "ipa cli" --explain --max 5

# List the active search channels (builtin + profile additions).
ipa engine channels

# Validate convention (per-note rules by default).
ipa convention check --summary

# Plan and apply formatter fixes.
ipa formatter plan
ipa formatter apply

# Tune (Optuna TPE) and roll the active result pointer in profile.yaml.
ipa tune --apply --trials 200
ipa tune list
ipa tune use 2026-05-04T09-12-44.json   # rollback
```

## Profile workspace

Each profile lives under `~/.config/ipa/profiles/{name}/`:

```text
~/.config/ipa/profiles/sample/
  profile.yaml            # vault_path, tune.result_file pointer
  convention.py           # active rules: explicit list, no auto-discovery
  search.py               # active channels: explicit list, no auto-discovery
  rules/                  # user-authored BaseConventionRule subclasses
  channel_rules/          # user-authored BaseSearchChannel subclasses
  tune/
    testsets/             # *.json eval sets used by ipa tune
    results/              # 2026-05-06T21-30-00.json — immutable artifacts
  .cache/                 # auto-managed pickles (BM25, parsed AST)
```

A working sample lives at [`examples/sample_profile/`](examples/sample_profile/) —
copy the directory and read [`examples/sample_profile/README.md`](examples/sample_profile/README.md).

## Authoring

### Convention rule

```python
# rules/no_emoji_in_filename_rule.py
from ipa_cli.api import BaseConventionRule, Issue, Severity

class NoEmojiInFilenameRule(BaseConventionRule):
    code = "sample.no_emoji_in_filename"
    severity = Severity.INFO
    default_scope = "note"

    def check(self, ctx, note):
        if note.id and note.id[0] in {"🔖", "🏷"}:
            return []
        return [Issue(code=self.code, severity=self.severity,
                      note_id=note.id, message="filename starts with an emoji")]
```

Then in `convention.py`:

```python
from ipa_cli.api.conventions import Convention
from ipa_cli.builtins.conventions.default_convention import default_convention
from .rules.no_emoji_in_filename_rule import NoEmojiInFilenameRule

_builtin = default_convention()
convention = Convention(name="sample", rules=[*_builtin.rules, NoEmojiInFilenameRule()])
```

### Search channel

```python
# channel_rules/heading_match_channel.py
from ipa_cli.api import BaseSearchChannel

class HeadingMatchChannel(BaseSearchChannel):
    name = "heading_match"
    description = "Boost notes whose H1/H2 contains the query"
    default_weight = 0.10

    def search(self, ctx, query):
        q = query.raw.lower()
        return {
            n.id: 1.0 for n in ctx.notes
            if any(q in h.text.lower() for h in n.headings if h.level <= 2)
        }
```

`Note.headings` is the parse level 3 lazy property added in P5 — it parses
markdown via `markdown-it-py` on first access, then `SearchEngine` writes
the AST back to `.cache/parsed_index.pkl` so subsequent runs skip the parser.

## Tune workflow

`ipa tune --apply` saves an immutable JSON under
`tune/results/{timestamp}.json` and rotates the active pointer:

```yaml
# ~/.config/ipa/config.yaml (ruamel round-trip — comments preserved)
profiles:
  sample:
    vault_path: /Users/me/sync/IPA
    tune:
      result_file: 2026-05-06T21-30-00.json
```

The pointed-at JSON contains `threshold`, `max_results`, `weights`, plus a
`study` block. Search params merge in priority order
**default < yaml < tune_result < env < cli**, so a stale or missing pointer
silently falls back to the yaml values.

Useful subcommands:

| Command | What it does |
|---|---|
| `ipa tune eval [--testset NAME]` | Baseline loss/metrics with the *current* active params |
| `ipa tune` (run, with optional `--apply`) | Optuna TPE study |
| `ipa tune analyze` | Threshold distribution diagnostics |
| `ipa tune list` | History (newest first), ★ active marker |
| `ipa tune use <filename>` | Flip the pointer; rollback to a past result |

## 1차 → 2차 마이그레이션

| 영역 | 1차 동작 | 2차 동작 |
|---|---|---|
| Profile resolution | `default_profile` → 비어있어도 동작 | `--profile` → `.ipa-profile` → `IPA_PROFILE` → `default_profile` (남아있는 동안) |
| Tune persistence | `--apply`가 `config.yaml`의 `search.weights/threshold/max_results`를 직접 갱신 | `tune/results/{timestamp}.json` immutable 저장 + `tune.result_file` 포인터 갱신 |
| Channels/rules | 글로벌 registry + 자동 발견 | `convention.py` / `search.py`의 명시 리스트 (import 에러로 빠르게 실패) |
| Parser | 정규식 기반 | `markdown-it-py` 기반 lazy AST (`Note.body_ast`, `headings`, `wikilinks`) |
| Cache | `~/.cache/ipa/{name}/` | profile workspace 안 `.cache/`로 흡수 (S6 진행 중) |
| `_shared/scripts/*` shim | 그대로 동작 | 그대로 동작 (이관 시 깨지면 안 되는 경계) |

기존 명령(`ipa search` 등)은 호환 유지되며, 새 명령은 모두 `ipa` prefix
아래에 추가되므로 권한 매처(`Bash(ipa *:*)`)는 그대로입니다.

## Layout

```text
src/ipa_cli/
  main.py            # Typer entrypoints
  api/               # public types: BaseConventionRule, BaseSearchChannel, Mapping ...
  parse/             # vault loader, markdown-it wrapper, parsed cache
  runtime/           # profile/convention/search loaders + engines
  builtins/          # default convention rules + search channels
  config/            # Settings resolver, defaults
  tune/              # Optuna runner, threshold dist analyzer, immutable results
  core/              # 1차 흡수 모듈 (vault_search 등) — 점진 제거 대상
```

## Testing

```sh
uv run pytest -q
```

(264 tests at the time of P7. 1차 회귀 24 + 시나리오 30 hit-rate parity는
별도의 vault에 의존하므로 CI 외부에서 measure.)

## License

Internal — see project owner.

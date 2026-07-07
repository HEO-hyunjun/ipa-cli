# CLAUDE.md

ipa-cli is a general-purpose toolkit for operating an IPA (Inbox-Project-Archive)
Obsidian vault from the command line and from agent harnesses: search, read,
validate, format, tune, and safely write notes. ipa-cli itself is a *utility*
for practicing the IPA method: each user runs their own operating rules on top
of it, so nearly everything is meant to be customizable — mapping, rule/search/
gate plugins, prompt fragments — **as long as the base IPA philosophy stays
intact** (the Inbox→Project→Archive lifecycle, evidence-based note operations,
the managed/user-owned safety contract). Every vault is different — this
project ships the *mechanism*, and each vault supplies its own *policy*. That
split is the core design rule of the codebase. A change that hardcodes one
user's policy into core, or one that lets customization break the IPA
invariants, are both wrong for the same reason.

Path-scoped conventions live in `.claude/rules/` (core, cli, testing-build,
obsidian, bench) and load automatically when you touch matching files. This
file keeps only the rules that apply repo-wide.

## Design rules (read before changing anything)

- **Mechanism in the CLI, policy in the vault.** Folder and frontmatter names
  come from `.ipa/config.yaml` `mapping` — never hardcode `ref`, `tags`, or
  `00 Inbox` in features or prompt templates; render `${mapping.refs}` etc.
  Vault conventions are rule plugins, retrieval boosts are search plugins,
  session-end policy is gate plugins (`.ipa/plugins/{rules,search,gates}/`),
  and vault-specific operating rules enter managed prompts via
  `.ipa/harness/fragments/<artifact>.md`. If a feature encodes one user's
  workflow, it belongs in a vault plugin/fragment, not in core.
- **No personal vault content in this repo.** Tests, fixtures, docs, and
  templates use neutral titles (`Alpha`, `Beta`, `TICKET-1 구현 계획`,
  `🔖 플랫폼 회의`). Never paste real note titles, employer/project names, or
  absolute personal paths.
- **Managed vs user-owned.** Every file the harness writes carries the
  `IPA_HARNESS_MANAGED` marker; a target file without the marker is user-owned
  and must never be overwritten. Details in `.claude/rules/core.md`.
- **Hooks must fail safe.** A broken gate plugin, missing CLI, or unparseable
  output must never permanently lock a session; recording hooks must stay
  silent on stdout unless they intend to inject context.
- **New capabilities must reach the agent surfaces.** A feature agents are
  meant to use is not done when the code works — agents only use what the
  harness prompts teach. When a command or option changes, check every prompt
  surface that should mention it (global skill + IPA Command Selection, the
  prompt blocks, the relevant vault-local skill, `ipa convention` for
  concepts), keep the wording pointer-level, add the rendering regression
  assertion, and run `ipa harness update <target>` so installed environments
  pick it up.
- **The CLI is not the only consumer of core.** The Obsidian plugin
  (`packages/obsidian`) calls core directly through `src/core/ipaClient.ts`.
  When changing core signatures or return shapes, grep that file and run
  `npm run build` (the test script only builds the core bundle, not the
  Obsidian one). Details in `.claude/rules/obsidian.md`.

## Repo layout

- `packages/core/src/index.ts` — the entire core in one file (vault IO, search
  pipeline, validator/formatter rules, tune, harness templates + install,
  plugin loaders). Expect to navigate by symbol search, not by file.
- `packages/cli/src/main.ts` — commander wiring only; keep logic in core.
- `packages/obsidian/` — Obsidian plugin build of the same core.
- `packages/{core,cli}/tests/*.test.mjs` — `node:test` suites.

## Dev workflow

- `npm test` builds first (`scripts/build.mjs`) and then runs both test
  packages — never run `node --test` directly (stale `dist`). Test and build
  conventions: `.claude/rules/testing-build.md`.
- Commit style: conventional commits (`feat|fix|refactor|docs|test|chore`),
  subject lines in Korean are the norm here. Split commits by meaning, not by
  file.
- Branching: `main` is always releasable. Work on a meaning-scoped topic
  branch even solo (`feat/…`, `fix/…`, `bench/…`, `docs/…`); merge
  fast-forward when the commits are clean meaning-units, squash-merge when the
  branch carries WIP. No `develop`/gitflow. Release = version-bump commit +
  `vX.Y.Z` tag. Sync machines via `git push`/`pull`, never by file-syncing the
  working tree. Details: `CONTRIBUTING.md`.
- **Behavior claims need behavioral evidence.** For prompt/harness changes
  that are supposed to change agent behavior, prefer a headless A/B run
  (`claude -p` sessions against a sandbox copy of a vault) over intuition;
  document method and results.

## Reference docs

`README.md` covers user-facing commands, plugin contracts, tune workflow, and
harness targets. The generated `.ipa/plugins/types/ipa-plugin.d.ts` is the
authoritative plugin contract. `ipa convention` renders IPA concepts plus the
active vault's operating rules.

## Bench Gate (행동 벤치마크)

하네스 템플릿(`packages/*/src`의 harness/skill/prompt 표면), 전역/볼트 프롬프트 문구,
CLI 명령 표면(플래그·출력 형식)에 영향을 주는 변경은:

1. 변경 후 `npm run bench -- --smoke` 통과를 확인한다.
2. 변경 채택(머지/커밋 확정) 직전 `npm run bench -- --full`을 실행한다.
3. full 통과 시 `npm run bench -- --full --update-baseline`으로 베이스라인을 갱신하고
   `bench/results/baseline.jsonl`·`history.jsonl`을 변경과 함께 커밋한다.
4. 실패나 baseline `regressed`/`cost_up`이 있으면 원인 분석 결과를 커밋 메시지에 남긴다.

순수 내부 리팩토링(프롬프트 표면·CLI 표면 불변)은 Tier 1/2(`npm test`)로 충분하다.
벤치 격리·판정·시나리오 작성 규칙: `.claude/rules/bench.md`.

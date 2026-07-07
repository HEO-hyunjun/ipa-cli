# bench — IPA CLI 행동 벤치마크 (Tier 3)

AI 에이전트가 ipa CLI를 적절히 활용하는지 headless Claude Code 세션으로 측정한다.
설계 배경: `docs/superpowers/specs/2026-07-04-ipa-bench-design.md`

## 실행

```sh
npm run bench -- --smoke                 # 6종 × sonnet — loop 반복마다
npm run bench -- --full                  # 19종 × 시나리오별 모델 — 변경 채택 직전
npm run bench -- --full --holdout        # 홀드아웃 2종 포함 — 분기 점검용
npm run bench -- --scenario c9-inbox-capture --model sonnet
npm run bench -- --full --update-baseline  # 채택 시 베이스라인 병합 갱신 (커밋할 것)
npm run bench -- --dry-run --full        # LLM 없이 파이프라인만 검증 (fake claude)
npm run bench -- --full --max-workers 8  # 매트릭스 동시 실행 (기본 5)
```

- 실패 시 exit 1 → 개발 에이전트 게이트로 사용.
- 결과: `bench/results/runs/<ts>/` (gitignore), 요약은 `history.jsonl`/`baseline.jsonl` (커밋).
- 시나리오·볼트 페르소나·어서션 어휘는 `bench/scenarios/`, `bench/vaults/`, `bench/lib/judge.mjs` 참조.
- 페르소나 재생성: `node bench/tools/derive-vaults.mjs` (divergent가 원본, 손편집 금지).
- 테스트는 `IPA_BENCH_SCENARIOS_DIR` 환경변수로 시나리오 디렉터리를 오버라이드한다.

## 평가 모델 (2축)

세션 결과는 `summary.verdict = { correctness, efficiency, completion }` 세 축으로
판정한다 (`bench/run.mjs`).

- **correctness** — 불리언. 해당 턴의 `expect` 어서션이 전부 통과했는가 (budget·completion 제외).
- **efficiency** — `ok | warn | over`. ipa 콜 수 기준, 모델 독립. 같은 축에 임계가 둘이다:
  - goldenPath 축 — `scenario.goldenPath`는 사람이 추적한 "정답 최소 콜 시퀀스".
    `stepRatio = ipaCalls / goldenPath`로 관측한다. `ipaCalls ≤ goldenPath × 2`면 `ok`,
    그 위부터 상한 사이는 `warn`("정답인데 서툼" — fail 아님, 개선 기회 리포트).
  - 폭주 상한 축 — `scenario.budget.maxIpaCalls`(관측 정상치의 ~2배). 넘으면 `over` → fail.
- **completion** — `completed | void`. 세션이 max-turns/에러로 잘리면(`truncated`) `void`로
  격리해 사람 리뷰 대상으로 뺀다 (fourth verdict가 아니라 completion 축의 값이다).

종합 PASS = `correctness && ceilingPass && efficiency !== "over" && completion === "completed"`.
즉 `warn`은 통과하고 `over`만 효율 축에서 실패한다. USD 비용은 게이트가 아니라 관측치이며,
회귀는 baseline `cost_up`(pass는 유지한 채 1.5배↑ 경고)과 `regressed`(pass→fail)로 추적한다
(`bench/lib/baseline.mjs`).

### 순수 하네스 표면 원칙 (2-branch rule)

벤치는 개발자 개인 `~/.claude/CLAUDE.md`가 새어들지 않는 순수 하네스 표면만 측정한다
(아래 세션 격리 참조). 시나리오가 이 깨끗한 표면에서 실패하면 2-branch로 나눈다: IPA
방법론이 소유한 행동 → 하네스 템플릿에서 가르친다; 일반 에이전트 예절·개인 취향 → 시나리오
어서션을 고친다(하네스에 우겨넣지 않는다).

### 훅 부작용 검증

PostToolUse 훅은 stream-json transcript에 남지 않으므로 vault 부작용 파일로 판정한다
(`bench/lib/judge.mjs`):

- `hook_call_count` — `.ipa/harness/call-counter.json`의 세션별 `count` 합. `{ min, max,
  max_ratio }`; `max_ratio`는 `total ≤ ceil(ipaCalls × ratio)`로 이중 발화(~2배) 회귀를 잡는다.
- `mutation_pending` — `.ipa/harness/mutation-pending.json`의 `mutations` 배열. `true`
  또는 `{ command: regex, min }`.

## 시나리오 그룹 (A–G)

`bench/scenarios/`의 파일 한 개가 한 그룹이다.

- **A — recognition** (`a-recognition.mjs`): 볼트를 건드리지 말아야 할 때를 구분하는가 —
  무관한 코딩·비-볼트 파일 생성(콜 없음) vs 진짜 IPA 개념 질문.
- **B — read** (`b-read.mjs`): 노트를 찾아 실제로 읽는 검색·retrieval. 단일 요약, 다중 노트
  종합, history bootstrap — 전부 읽기 전용(md 변경 0).
- **C — write** (`c-write.mjs`): 쓰기 경로 — inbox capture, 노트 스코프 섹션 편집
  (validator → formatter plan → apply → validator 루프).
- **D — robustness** (`d-robustness.mjs`): 비-정규 페르소나 견고성 — divergent 필드 매핑,
  messy 스코프 편집(볼트 전체 수리로 폭주하지 않고), 볼트 규칙 준수.
- **E — authoring** (`e-authoring.mjs`): 커스터마이즈 — 룰 플러그인 작성·검증, 검색 개인화/튜닝.
- **F — migration** (`f-migration.mjs`): 마이그레이션/온보딩 — pre-IPA 부트스트랩(기존 폴더명을
  config 매핑에 흡수), 부분 frontmatter 마이그레이션.
- **G — workflows** (`g-workflows.mjs`): 다단계 IPA 메커니즘 e2e(cascade/digest/link/move +
  tag-vs-ref 같은 방법론), end-state로 판정.

## 볼트 페르소나 derive chain

`bench/vaults/`의 페르소나는 `divergent`(원본 스냅샷, 손편집 금지)에서
`node bench/tools/derive-vaults.mjs`로 결정적으로 재생성한다 (출력물은 커밋한다):

- `divergent` → `canonical` — fixtures/plugins/logs 제거, 필드 변환(`kind→type`,
  `parents→ref`, `created→date_created` 등), 벤치 게이트 설치, `formatter apply`.
- `canonical` → `messy` — 일부 노트 frontmatter 제거·구필드명으로 복귀, frontmatter 없는
  orphan 추가.
- `canonical` → `pre-ipa` — `.ipa/`·`AGENTS.md`·`CLAUDE.md` 제거, 폴더명을 비-IPA로 되돌림
  ("IPA 이전" 상태 재현).
- `empty` — 파생 대상 아님. `.gitkeep`만 있는 빈 볼트 페르소나.

## 주의

- 실제 `claude` CLI와 API 비용을 사용한다. `--full`은 세션 30+개 규모.
- 토큰/비용 델타로 의사결정할 때는 해당 시나리오를 2~3회 반복 실행해 비교한다.
  단일 실행은 pass/fail 판정 전용.
- `budget`(maxCostUsd/maxIpaCalls)은 폭주 감지용 상한(관측 정상치의 ~2배)이다. 모델 간 per-call
  효율 차이는 pass/fail이 아니라 지표(`summary.stepRatio`, baseline `cost_up` 경고)로 추적한다.

### 세션 격리 (CLAUDE_CONFIG_DIR)

`harness: true` 시나리오는 러너가 `ipa harness install claude`를 샌드박스 옆 격리 홈(`<sandbox>-home`)에
설치한 뒤, 세션 자식(`claude -p`)을 그 격리 `.claude`를 `CLAUDE_CONFIG_DIR`로 가리켜 돌린다.
`CLAUDE_CONFIG_DIR`는 실제 `~/.claude`를 **병합이 아니라 완전히 대체**하므로, 세션엔 샌드박스 하네스 훅만
발화하고 개발자의 실-홈 훅은 절대 끼지 않는다. (예전엔 `--settings`로 훅을 주입했는데, `--settings`는 실제
`~/.claude/settings.json`과 **병합**되어 실-홈 훅과 샌드박스 훅이 같은 vault 부작용 파일을 나란히 증가시켜
모든 훅 기반 측정을 이중 발화로 오염시켰다 — call-counter가 실제 콜의 ~2배로 셌다.)

- **인증:** 이 claude 버전은 비-기본 `CLAUDE_CONFIG_DIR`에선 macOS 키체인을 참조하지 않고 config dir의
  `.credentials.json`에서 자격증명을 읽는다. 그래서 러너가 로그인 키체인의 `Claude Code-credentials`를
  config dir에 `.credentials.json`으로 복사한다(`provisionAuth`) — 키체인에서 **밖으로 READ만** 하고 실제
  `~/.claude`엔 쓰지 않는다. 세션이 끝나면 이 사본을 즉시 지운다(`--keep-sandbox`로 홈을 보존해도).
- **HOME도 격리한다.** 인증이 config dir로 해결되므로 세션 HOME을 `<sandbox>-home`으로 둘 수 있고, 이로써
  `~` 확장과 세션 내부 `ipa harness install`이 실제 홈에서 완전히 떨어진다. macOS `os.homedir()`는 `$HOME`을
  무시하므로 config 격리는 HOME이 아니라 `CLAUDE_CONFIG_DIR`가 담당한다(HOME은 방어 계층).
- **훅 command 경로:** core의 hookCommand는 tilde-상대(`node ~/...`)로 렌더된다. 러너가 설치 직후
  config dir의 `settings.json`을 제자리에서 손질해 `~/`를 격리 홈 절대경로로 치환하고(`prepareBenchConfigDir`),
  `permissions.defaultMode:"auto"`를 명시한다(예전 병합이 실-홈에서 상속하던 값이라, 격리 config dir에선 없으면
  headless 세션이 권한 프롬프트에 막힌다).

이전의 "세션 내부 설치가 실제 `~/.claude`를 오염시킬 수 있다"는 잔여 리스크는 HOME+config 완전 격리로 닫혔다.
PostToolUse 훅은 stream-json transcript에 안 남으므로, 세션이 훅을 실제로 발화시켰는지는 vault 부작용 파일로
판정한다 — `hook_call_count`(call-counter.json의 세션별 카운트 합, `max_ratio`로 이중 발화 회귀 감시),
`mutation_pending`(mutation-pending.json에 남은 dry-run 뮤테이션 엔트리).

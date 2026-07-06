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

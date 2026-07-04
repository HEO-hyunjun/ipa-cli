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

### HOME 격리와 잔여 리스크

`harness: true` 시나리오의 러너-사이드 사전 설치(`ipa harness install claude`)는 `$HOME/.claude`에
전역 하네스를 쓴다. 예전엔 이게 실제 사용자 `~/.claude`를 샌드박스 볼트를 가리키는 스킬로 덮어썼다.
지금은 이 설치를 샌드박스 옆 격리 홈(`<sandbox>-home`)에서 돌려 실제 `~/.claude`를 보호한다.

세션 자식(`claude -p`)에는 HOME을 격리하지 않는다. macOS에서 격리 HOME으로 띄우면 로그인 상태를
읽지 못해 `Not logged in`으로 인증에 실패하기 때문이다(자격증명은 로그인 키체인에 있으나 온보딩/계정
상태는 HOME에 있다). 따라서 세션은 실제 HOME을 그대로 쓴다.

**잔여 리스크:** 세션 에이전트가 스스로 `ipa harness install claude`를 실행하면(주로 온보딩 시나리오)
실제 `~/.claude`가 갱신될 수 있다. 러너-사이드 사전 설치의 결정적 오염은 막았지만, 세션 내부에서 벌어지는
설치까지는 막지 못한다. 격리 HOME에서도 인증되는 방법이 생기면 세션 자식도 완전 격리로 전환할 것.

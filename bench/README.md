# bench — IPA CLI 행동 벤치마크 (Tier 3)

AI 에이전트가 ipa CLI를 적절히 활용하는지 headless Claude Code 세션으로 측정한다.
설계 배경: `docs/superpowers/specs/2026-07-04-ipa-bench-design.md`

## 실행

```sh
npm run bench -- --smoke                 # 6종 × sonnet — loop 반복마다
npm run bench -- --full                  # 19종 × 시나리오별 모델 — 변경 채택 직전
npm run bench -- --full --holdout        # 홀드아웃 2종 포함 — 분기 점검용
npm run bench -- --scenario c9-inbox-capture --model sonnet
npm run bench -- --full --update-baseline  # 채택 시 베이스라인 갱신 (커밋할 것)
npm run bench -- --dry-run --full        # LLM 없이 파이프라인만 검증 (fake claude)
```

- 실패 시 exit 1 → 개발 에이전트 게이트로 사용.
- 결과: `bench/results/runs/<ts>/` (gitignore), 요약은 `history.jsonl`/`baseline.jsonl` (커밋).
- 시나리오·볼트 페르소나·어서션 어휘는 `bench/scenarios/`, `bench/vaults/`, `bench/lib/judge.mjs` 참조.
- 페르소나 재생성: `node bench/tools/derive-vaults.mjs` (divergent가 원본, 손편집 금지).
- 테스트는 `IPA_BENCH_SCENARIOS_DIR` 환경변수로 시나리오 디렉터리를 오버라이드한다.

## 주의

- 실제 `claude` CLI와 API 비용을 사용한다. `--full`은 세션 30+개 규모.
- `harness: true` 시나리오는 실행 중 사용자 전역 하네스 파일을 HEAD 템플릿으로 갱신한다
  (개발 머신 전제 — 어차피 HEAD를 쓰는 환경).
- 토큰/비용 델타로 의사결정할 때는 해당 시나리오를 2~3회 반복 실행해 비교한다.
  단일 실행은 pass/fail 판정 전용.

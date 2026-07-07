---
paths:
  - "bench/**"
verified: 8ac0c4f4069ca3452b78c6bbc4e0ecb6e58d804f
---

# bench conventions

- 세션 격리는 `CLAUDE_CONFIG_DIR`로 `~/.claude`를 **전체 교체**한다(merge 아님). 과거 `--settings`
  merge 방식은 실홈 훅과 샌드박스 훅이 이중 발화해 call-counter가 ~2배로 세는 사고가 있었다 —
  merge 방식으로 되돌리지 말 것. HOME도 `<sandbox>-home`으로 격리하고, 자격증명은 키체인에서
  `.credentials.json`으로 복사 후 세션 종료 시 삭제한다(`--keep-sandbox`여도).
- 훅 발화 검증은 부작용 파일로만: `.ipa/harness/call-counter.json`(→ `hook_call_count`),
  `mutation-pending.json`(→ `mutation_pending`). PostToolUse 훅은 `claude -p` stream-json
  트랜스크립트에 아예 안 나타나므로 트랜스크립트 grep으로 검증하지 않는다.
- 어서션 어휘는 `bench/lib/judge.mjs`가 해석한다: `used_command`/`command_flow`/`notes_added`/
  `file_contains`/`md_changed_max`/`hook_call_count{min,max_ratio}`/`mutation_pending` 등. 판정은
  3축 — correctness(전 expect 통과) / efficiency(`stepRatio = ipaCalls/goldenPath`, budget 초과 시
  `over`) / completion(`void`=중절은 휴먼 리뷰行) — 이고 `warn`은 통과다.
- 순수 하네스 표면 + 2-branch 규칙: 개인 `~/.claude/CLAUDE.md`는 절대 채점 세션에 새지 않는다.
  클린 표면에서 시나리오가 실패하면 — IPA 방법론이 소유할 행동이면 하네스 템플릿에 교육하고,
  일반 에이전트 에티켓/개인 취향이면 시나리오 어서션을 고친다. 하네스에 욱여넣지 않는다.
- 시나리오 작성(bench/scenarios/*.mjs): `budget`/`maxTurns`/`goldenPath` 선택 근거를 인라인 주석으로
  남긴다(budget은 관측치 ~2배의 폭주 감지 상한이지 목표가 아님). 승인 게이트는 multi-turn으로
  인코딩 — 1턴은 무변형 어서션(`max: 0`), approve 후 턴이 실제 변형을 기대. `harness: true`
  시나리오의 `hook_call_count`는 고정값 대신 `min`(발화 확인)+`max_ratio`(이중 발화 가드)를 쓴다.
- 볼트 픽스처 derive 체인: `divergent`(수작업 SoT) → `canonical`(`tools/derive-vaults.mjs` 재생성)
  → `messy`/`pre-ipa`(스크립트 열화). canonical 이하 산출물을 직접 수정하지 말고 divergent를 고친
  뒤 재생성한다. `empty`는 체인 밖 정적 페르소나.
- 게이트 워크플로: `npm run bench -- --smoke`(루프마다) / `--full`(채택 직전) /
  `--full --update-baseline`(통과 시 `results/baseline.jsonl`·`history.jsonl`을 변경과 함께 커밋).
  `results/runs/`는 gitignore — 커밋하지 않는다. `--dry-run --full`은 LLM 비용 없는 파이프라인 점검.

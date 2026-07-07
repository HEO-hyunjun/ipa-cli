---
paths:
  - "packages/cli/src/**"
verified: 8ac0c4f4069ca3452b78c6bbc4e0ecb6e58d804f
---

# cli conventions

- `packages/cli/src/main.ts`(~2,300줄) 단일 파일이 CLI 전부다. commander 배선·help 텍스트·휴먼 출력
  렌더러만 두고, 도메인 로직은 core(`@ipa/core`)에 둔다.
- vault 해석은 항상 `withVault(globalOptions(program), async (vault, settings) => ...)` 경유.
  커맨드 액션 안에서 `process.env.IPA_VAULT_PATH`를 직접 읽지 않는다 — 우선순위(--vault, --profile,
  IPA_PROFILE, IPA_VAULT_PATH)는 core의 `resolveSettings`가 담당한다.
- 출력은 단일 `print(payload, json)` 헬퍼 경유. 커맨드는 직렬화 가능한 객체/문자열을 만들어 넘기고,
  `--json` 분기와 휴먼 렌더링(cli-table3, yoctocolors)은 print가 결정한다. 커맨드별 console 출력을
  손으로 만들지 않는다.
- 에러 처리: 비치명 실패는 `result.status === "error"` 검사 후 `process.exitCode = 1` 설정으로
  처리하고, 예기치 못한 예외는 per-command try/catch 없이 최상위 `main().catch` 하나로 전파시킨다.
- help는 `HELP_TOPICS` 객체 + `program.helpInformation` 오버라이드 방식이다. 새 커맨드는 기존
  `setHelp` 패턴을 따라 상세 help 블록을 붙인다.
- 함수 시그니처에 실제 타입 어노테이션 금지 — core와 동일한 무변환 복사 빌드를 탄다
  (`.claude/rules/core.md` 참고).

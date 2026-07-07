---
paths:
  - "packages/*/tests/**"
  - "scripts/build.mjs"
  - "scripts/lint.mjs"
verified: 8ac0c4f4069ca3452b78c6bbc4e0ecb6e58d804f
---

# testing & build conventions

- 테스트 러너는 Node 내장 `node:test` + `node:assert/strict`다. 루트의 `vitest.config.ts`는 죽은
  파일이며 vitest는 아무것도 실행하지 않는다 — `package.json`의 `test` 스크립트가 진실.
- **stale-dist 함정**: 테스트는 `packages/*/dist/`를 임포트하고 CLI 테스트는 `dist/main.js`를
  spawn한다. 항상 `npm test`(빌드 선행)로 실행할 것 — `node --test`를 직접 돌리면 옛 코드를
  테스트한다.
- `scripts/build.mjs`는 컴파일러가 아니다: `packages/{core,cli,builtin-rules}/src`의 `.ts`를 텍스트
  그대로 `dist/*.js`로 복사하고 `cli/dist/main.js`에 chmod 755만 한다. tsc는 어디서도 돌지 않고
  `scripts/lint.mjs`는 탭/말미 개행만 검사하므로, 타입 오류를 잡는 건 테스트 스위트뿐이다.
- 픽스처 격리: `fixtureVault()`가 `packages/test-vaults/fixtures/{mini-vault,legacy-surface}`를
  `mkdtemp(tmpdir())`로 복사해 테스트별 볼트를 만든다. CLI 테스트는 spawn 전에 env에서
  `IPA_PROFILE`/`IPA_VAULT_PATH`를 삭제해 개발자 실환경 설정 누출을 차단한다
  (packages/cli/tests/cli.test.mjs 상단).
- 생성 훅 스크립트 검증은 내부 함수 호출이 아니라 `spawnSync(process.execPath, [scriptPath],
  { env, input })`로 한다 — 스크립트는 독립 Node 프로세스이므로 `IPA_VAULT_PATH` 등 훅 호출 환경을
  env로 재현한다(packages/core/tests/core.test.mjs의 다수 호출부).
- `npm test`는 Obsidian 번들을 빌드하지 않는다. core 시그니처를 바꿨다면 `npm run build`로
  `packages/obsidian` 컴파일까지 확인해야 조용한 파손을 막는다.

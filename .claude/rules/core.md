---
paths:
  - "packages/core/src/**"
  - "packages/builtin-rules/**"
verified: 8ac0c4f4069ca3452b78c6bbc4e0ecb6e58d804f
---

# core conventions

- `packages/core/src/index.ts`(~9,500줄)가 core 전부다. 새 로직은 이 파일에 추가하고 심볼 검색으로
  탐색한다 — 복사 기반 빌드가 단일 파일을 가정하므로 파일을 새로 쪼개지 않는다.
- 함수 시그니처에 실제 타입 어노테이션(`: string` 등)을 쓰지 않는다. `scripts/build.mjs`가 `.ts`를
  무변환으로 `dist/*.js`에 복사하므로 런타임 파싱 에러가 난다. `interface`/`type` 선언만 허용.
- 폴더·프론트매터 이름은 항상 `mapping.*` 경유로 참조한다(`normalizeMapping`, index.ts의 `Mapping`
  인터페이스). `"tags"`, `"01 Project"` 같은 리터럴 하드코딩 금지 — 볼트마다 `.ipa/config.yaml`
  `mapping`으로 이름을 바꾼다.
- 생성 훅 스크립트는 `#!/usr/bin/env node` 템플릿 리터럴이다(`sessionEnvScript` 등). 생성물이 쓰는
  모든 심볼(`homedir`, `join`, `spawnSync`, `readFileSync`)을 생성 스크립트 자신이 import해야 하고,
  생성물에 `\n` 문자가 필요한 곳은 `\\n`으로 이스케이프한다. `IPA_VAULT_PATH`를 설정한 테스트는
  통과해도 실 설치에서 크래시하는 함정.
- 하네스 관리 파일 쓰기는 `writeManagedFile`/`upsertManagedBlock` 경유. `IPA_HARNESS_MANAGED` 마커가
  없는 대상 파일은 user-owned이므로 절대 덮어쓰지 않고 `skipped_user_owned`로 보고한다.
- 하네스 컴포넌트를 추가/변경하면 전부 갱신: `HARNESS_COMPONENTS`, script/event/matcher 맵,
  `IPA_MANAGED_HOOK_SCRIPTS`(구 이름은 legacy 정리를 위해 잔류), `installGlobalHarness`,
  `uninstallGlobalHarness`, `componentsValidForTarget`, doctor.
- gate 플러그인 block 의미론: `{ block: true }`는 Stop 하드블록, `{ block: false, message }`는
  비차단 경고. throw하거나 출력이 깨진 gate는 보고만 되고 절대 세션을 잠그지 않는다(fail-safe 유지).
- 프롬프트 템플릿(전역 스킬·프롬프트 블록·볼트 로컬 스킬)은 계약 표면이다. 변경 시 매핑명 렌더링
  회귀 어서션(테스트 config에서 `refs`/`tags`/폴더를 remap해 렌더 결과 검증)과 제거된 중복의 재유입을
  막는 `doesNotMatch` 가드를 추가하고, `ipa harness update <target>` 반영을 확인한다.
- 검색은 성능 민감 경로다. BM25 인덱스는 `.ipa/cache/bm25.bin`에 per-file stat 시그니처로 캐시되며,
  per-query 작업이 per-note 루프에 들어가면 안 된다. 검색 경로 변경은 전후 벤치마크(tune testset
  쿼리, 반복 실행 중앙값, 결과 리스트 diff)로 확인한다.
- 플러그인 로딩 계약 유지: `importVaultModule`은 `globalThis.__ipaImportPlugin` 우선(Obsidian 렌더러
  대응) + 캐시버스팅 쿼리(dry-run/tune이 플러그인 편집을 재시작 없이 반영), normalizer는 다형
  export(모듈 함수 / `.default` / named 객체)를 수용한다.
- `packages/builtin-rules/src/index.ts`는 builtin id 레지스트리 메타데이터다. core에서 builtin
  채널/규칙/refactor를 추가·개명하면 여기 id도 갱신한다(레지스트리 회귀 테스트가 카운트를 검사).

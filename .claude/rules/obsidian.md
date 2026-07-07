---
paths:
  - "packages/obsidian/**"
  - "scripts/build-obsidian.mjs"
verified: 8ac0c4f4069ca3452b78c6bbc4e0ecb6e58d804f
---

# obsidian plugin conventions

- core 접근은 `src/core/ipaClient.ts` 단일 경유. 뷰/커맨드에서 `@ipa/core`를 직접 import하지
  않는다. core 시그니처·반환 형태가 바뀌면 이 파일을 grep해서 맞춘다.
- **볼트 쓰기는 Obsidian API 경유**: 패치 적용은 `src/core/applyFixes.ts`의 `Vault.process`로만
  한다. `formatVault`는 plan-only(`patchesOnly: true`)로만 호출 — core의 Node fs 쓰기는 Obsidian
  에디터/메타데이터 캐시를 우회하므로 금지.
- 캐시 무효화는 한 벌로: `notesCache`/`fullNotesCache`/`searchContext`/`validationCache`는
  `invalidateNotes()`로 함께 비우며, `main.ts`의 vault 이벤트(modify/create/delete/rename)에서
  호출한다. 개별 캐시만 비우면 뷰 간 불일치가 생긴다.
- 경로 정규화: core가 주는 경로는 NFD(macOS fs)일 수 있고 Obsidian 인덱스는 NFC다.
  `openByPath`처럼 Obsidian 조회에 쓰는 경로는 `normalizePath(...).normalize("NFC")` 필수.
- 새 뷰는 `src/views/BaseIpaView.ts`를 상속해 `client`/`adapter` 접근과
  `buildShell`/`showError`/`showEmpty` 렌더 헬퍼를 재사용한다.
- 빌드는 `scripts/build-obsidian.mjs` + `packages/obsidian/build-spec.json`(esbuild, cjs,
  externals: obsidian/electron)이며 `npm test`는 이 번들을 빌드하지 않는다. 배포는
  `ipa obsidian install|sync` — release 자산(main.js, manifest.json, styles.css, versions.json)만
  복사하고 사용자 설정 `data.json`은 절대 건드리지 않는다.
- 데스크톱 전용: `ObsidianVaultAdapter`는 `FileSystemAdapter` 기반 볼트를 요구하며 아니면 throw.
  모바일/비-fs 볼트는 명시적 미지원이다.
- format-on-save는 `editor:save-file` 커맨드 몽키패치 + `formatGuard`(in-flight 경로 Set)로 자기
  write의 modify 이벤트 재진입을 막는다 — 이 가드를 우회하는 저장 경로를 추가하지 않는다.

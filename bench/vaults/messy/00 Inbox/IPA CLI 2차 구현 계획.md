---
date_created: 2026/05/06 (Wed) 21:58:00
date_modified: 2026/05/06 (Wed) 21:58:00
type: note
ref: ["[[🔖 ipa-cli]]", "[[🔖 IPA CLI 2차 구현 설계]]"]
tags: [design_doc, plan, cli_test]
aliases: ["IPA CLI phase 2 plan", "2차 구현 계획"]
stage: inbox
---

> [!abstract]
> 테스트 vault 기준 IPA CLI 2차 구현 계획. 실제 `~/ipa`의 원본 계획을 복제하지 않고, 이 vault에서 검증할 축만 남긴다.

## 결정 요약

| 영역 | 테스트 포인트 |
|------|---------------|
| profile 결정 | `.ipa-profile`에 `ipa-test`가 있을 때 profile workspace를 선택한다 |
| mapping | `kind`, `parents`, `created`, `updated`를 semantic field로 해석한다 |
| convention | `01 Project` note 금지, Archive flat 구조, root-folder 1:1을 검사한다 |
| search | alias, parents, Archive retired index가 검색 결과에 반영된다 |
| tune | `tune/testsets`와 immutable `tune/results`를 읽고 active result를 선택한다 |

## P1 API 표면

- `BaseConventionRule`, `BaseSearchChannel`, `Mapping` import surface를 고정한다.
- 빈 rule과 빈 channel이 runtime import에서 깨지지 않는지 확인한다.

## P2 Mapping Layer

- 이 vault는 기본 IPA field 이름을 쓰지 않는다.
- `90 Settings/Profile Fixtures/ipa-test/mapping.py`가 이 차이를 설명한다.
- `type/ref`만 읽는 구현은 이 vault에서 실패해야 한다.

## P3 Convention Runtime

- 정상 범위: `00 Inbox`, `01 Project`, `02 Archive`, `90 Settings`
- 의도적 오류: `99 Fixtures/invalid`
- scope 테스트: `note`, `folder`, `vault` 범위별로 실행 결과가 달라야 한다.

## P4 Search Runtime

검색 fixture:

- "카페인 수면" → [[수면과 카페인 상호작용]]
- "git 되돌리기" → [[git reset revert checkout 차이]]
- "BFS DFS" → [[BFS와 DFS 선택 기준]]
- "PARA Area" → [[PARA에서 Area를 없애도 되는가]]

## P5 Parser Layer

`99 Fixtures/parser-edge`에 callout, table, code fence, wikilink embed를 섞은 문서를 둔다.

## P6 Tune Workflow

`90 Settings/Profile Fixtures/ipa-test/tune/testsets`와 `results`를 사용한다. result는 timestamp 파일명만 사용하고 `latest.json`은 만들지 않는다.

## 완료 기준

- 이 vault를 대상으로 normal notes만 검증하면 통과한다.
- `99 Fixtures/invalid`를 포함하면 의도한 issue가 나온다.
- search regression query가 기대 note를 top hit 또는 상위권에 포함한다.


---
created: 2026-05-06 21:57
updated: 2026-05-06 21:57
kind: index
parents: ["[[🏷️ IPA Root]]", "[[🔖 ipa-cli]]"]
tags: [design_doc, cli_test]
aliases: ["2차 구현 설계", "ipa cli phase 2 design"]
stage: active
pattern: project
---

> [!abstract]
> IPA CLI 2차 구현의 설계 판단과 검증 축을 모은다.

## 진행 상태

- profile 선택: `.ipa-profile` fixture로 검증
- mapping: `kind/parents/created/updated`로 검증
- convention: 정상 폴더와 invalid fixture를 분리해 검증
- tune: testsets/results fixture로 검증

## 결정

- CLI는 vault convention을 하드코딩하지 않고 profile workspace에서 불러온다.
- Archive flat 구조와 Project note 금지를 rule로 확인한다.

## 산출물

- [[IPA CLI 2차 구현 계획]]
- [[IPA Test Vault Convention]]

## Backlinks

```dataview
LIST
WHERE contains(parents, this.file.link)
SORT file.name ASC
```


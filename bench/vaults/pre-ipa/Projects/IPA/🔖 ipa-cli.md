---
tags: [cli_test, tooling]
pattern: project
---

> [!abstract]
> IPA CLI 2차 구현의 테스트 진입점.

## 진행 상태

- P1: API 표면과 stub 검증
- P2: Mapping Layer에서 `kind/parents` convention 적용
- P3: Convention Runtime scope와 fixture 검증
- P4: Search Runtime alias, parents, Archive hit 검증

## 결정

- 테스트 vault는 실제 `~/ipa` convention을 복사하지 않는다.
- profile fixture는 `90 Settings/Profile Fixtures/ipa-test`에 둔다.

## 산출물

- [[IPA CLI 2차 구현 계획]]
- [[🔖 IPA CLI 2차 구현 설계]]

## Backlinks

```dataview
LIST
WHERE contains(parents, this.file.link)
SORT file.name ASC
```


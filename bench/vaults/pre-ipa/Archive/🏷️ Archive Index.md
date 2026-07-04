---
tags: [cli_test]
---

> [!abstract]
> Archive flat 구조의 진입점. 완료 note와 퇴역 index를 함께 보여준다.

## Retired Indexes

```dataview
LIST
FROM "02 Archive"
WHERE kind = "index"
SORT file.name ASC
```

## Archived Notes

```dataview
TABLE parents, tags
FROM "02 Archive"
WHERE kind = "note"
SORT file.name ASC
```


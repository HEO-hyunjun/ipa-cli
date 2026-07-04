---
date_created: 2026/05/06 (Wed) 21:59:00
date_modified: 2026/05/06 (Wed) 21:59:00
type: root
ref: []
tags: [cli_test]
aliases: ["Archive Root", "아카이브 인덱스"]
stage: archived
special: archive_index
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


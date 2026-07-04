---
created: 2026-05-06 21:50
updated: 2026-05-06 21:50
kind: root
parents: []
tags: [cli_test]
aliases: ["IPA Test Home", "테스트 볼트 홈"]
stage: meta
special: home
---

> [!abstract]
> IPA CLI 2차 구현을 검증하기 위한 테스트 vault 홈.

## Active Roots

```dataview
LIST
FROM "01 Project"
WHERE kind = "root"
SORT file.name ASC
```

## Inbox Notes

```dataview
TABLE kind, parents, tags
FROM "00 Inbox"
SORT file.name ASC
```

## Archive Indexes

```dataview
LIST
FROM "02 Archive"
WHERE kind = "index"
SORT file.name ASC
```

## Test Fixtures

```dataview
LIST
FROM "99 Fixtures"
SORT file.path ASC
```


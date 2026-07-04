---
tags: [cli_test]
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


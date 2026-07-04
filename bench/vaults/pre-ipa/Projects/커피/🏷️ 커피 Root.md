---
tags: [experiment]
---

> [!abstract]
> 브루잉, 원두, 카페인 관리를 묶는 active root.

## Indexes

```dataview
LIST
FROM "01 Project/커피"
WHERE contains(parents, this.file.link)
SORT file.name ASC
```


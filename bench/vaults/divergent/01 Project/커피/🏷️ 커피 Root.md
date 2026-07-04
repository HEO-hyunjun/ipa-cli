---
created: 2026-05-06 21:53
updated: 2026-05-06 21:53
kind: root
parents: []
tags: [experiment]
aliases: ["Coffee Root"]
stage: active
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


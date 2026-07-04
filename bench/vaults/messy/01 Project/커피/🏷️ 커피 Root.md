---
date_created: 2026/05/06 (Wed) 21:53:00
date_modified: 2026/05/06 (Wed) 21:53:00
type: root
ref: []
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


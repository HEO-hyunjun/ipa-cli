---
created: 2026-06-08 09:10
updated: 2026-06-08 09:10
kind: root
parents: []
tags: [experiment]
aliases: ["Cooking Root", "요리 루트"]
stage: active
---

> [!abstract]
> 집에서 반복하는 요리 레시피와 실험을 묶는 active root.

## Indexes

```dataview
LIST
FROM "01 Project/요리"
WHERE contains(parents, this.file.link)
SORT file.name ASC
```

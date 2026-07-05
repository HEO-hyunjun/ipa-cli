---
tags: [experiment]
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

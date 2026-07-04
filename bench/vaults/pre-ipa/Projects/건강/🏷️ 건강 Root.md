---
tags: [habit]
---

> [!abstract]
> 몸 상태, 수면, 영양, 검진 기록을 묶는 active root.

## Indexes

```dataview
LIST
FROM "01 Project/건강"
WHERE contains(parents, this.file.link)
SORT file.name ASC
```


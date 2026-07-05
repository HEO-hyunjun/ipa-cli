---
date_created: 2026/06/08 (Mon) 09:10:00
date_modified: 2026/06/08 (Mon) 09:10:00
type: root
ref: []
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

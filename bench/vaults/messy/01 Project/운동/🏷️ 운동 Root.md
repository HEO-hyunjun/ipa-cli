---
date_created: 2026/05/06 (Wed) 21:52:00
date_modified: 2026/05/06 (Wed) 21:52:00
type: root
ref: []
tags: [habit]
aliases: ["Workout Root", "운동 루트"]
stage: active
---

> [!abstract]
> 러닝, 근력, 회복 루틴을 관리한다.

## Indexes

```dataview
LIST
FROM "01 Project/운동"
WHERE contains(parents, this.file.link)
SORT file.name ASC
```


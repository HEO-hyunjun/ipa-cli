---
created: 2026-05-06 21:52
updated: 2026-05-06 21:52
kind: root
parents: []
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


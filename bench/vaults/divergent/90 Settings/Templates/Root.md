---
created: {{date}} {{time}}
updated: {{date}} {{time}}
kind: root
parents: []
tags: []
aliases: []
stage: active
---

> [!abstract]
> root context.

## Indexes

```dataview
LIST
FROM "01 Project"
WHERE contains(parents, this.file.link)
SORT file.name ASC
```


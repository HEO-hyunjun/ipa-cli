---
date_created: {{date}} {{time}}
date_modified: {{date}} {{time}}
type: root
ref: []
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


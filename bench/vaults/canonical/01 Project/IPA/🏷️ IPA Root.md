---
date_created: 2026/05/06 (Wed) 21:57:00
date_modified: 2026/05/06 (Wed) 21:57:00
type: root
ref: []
tags: [pkm, cli_test]
aliases: ["IPA Root", "Inbox Project Archive Root"]
stage: active
---

> [!abstract]
> IPA Method와 IPA CLI 구현 테스트를 위한 active root.

## Indexes

```dataview
LIST
FROM "01 Project/IPA"
WHERE contains(parents, this.file.link)
SORT file.name ASC
```


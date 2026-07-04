---
created: 2026-05-06 21:57
updated: 2026-05-06 21:57
kind: root
parents: []
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


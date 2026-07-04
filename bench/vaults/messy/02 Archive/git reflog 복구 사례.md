---
date_created: 2026/05/06 (Wed) 22:00:00
date_modified: 2026/05/06 (Wed) 22:00:00
type: note
ref: ["[[🔖 공부-git명령어]]"]
tags: [tooling, troubleshooting]
aliases: ["reflog recovery", "git 복구"]
stage: archived
---

> [!abstract]
> reset 후 사라진 것처럼 보이는 commit을 reflog로 찾는 사례.

## 절차

1. `git reflog`로 HEAD가 지나간 commit을 찾는다.
2. 필요한 commit hash를 확인한다.
3. 새 branch를 만들어 복구한다.


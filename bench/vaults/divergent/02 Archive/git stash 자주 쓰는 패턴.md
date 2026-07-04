---
created: 2026-05-06 22:00
updated: 2026-05-06 22:00
kind: note
parents: ["[[🔖 공부-git명령어]]"]
tags: [tooling, reference]
aliases: ["git stash", "임시 저장"]
stage: archived
---

> [!abstract]
> 작업 중 맥락을 임시로 접을 때 쓰는 stash 패턴.

## 패턴

- `git stash push -m "message"`
- `git stash list`
- `git stash apply stash@{0}`
- 충돌 가능성이 있으면 적용 후 바로 diff를 확인한다.


---
tags: [tooling, reference]
---

> [!abstract]
> 작업 중 맥락을 임시로 접을 때 쓰는 stash 패턴.

## 패턴

- `git stash push -m "message"`
- `git stash list`
- `git stash apply stash@{0}`
- 충돌 가능성이 있으면 적용 후 바로 diff를 확인한다.


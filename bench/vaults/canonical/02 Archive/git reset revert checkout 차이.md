---
date_created: 2026/05/06 (Wed) 22:00:00
date_modified: 2026/05/06 (Wed) 22:00:00
type: note
ref: ["[[🔖 공부-git명령어]]"]
tags: [tooling, reference]
aliases: ["git 되돌리기", "reset revert checkout"]
stage: archived
---

> [!abstract]
> Git에서 되돌리기 계열 명령의 역할 차이.

## 요약

- `reset`: 현재 branch의 포인터나 index 상태를 움직인다.
- `revert`: 기존 commit을 취소하는 새 commit을 만든다.
- `checkout`: 과거에는 branch 이동과 파일 복원을 모두 담당했지만, 지금은 `switch`와 `restore`로 나눠 쓰는 편이 명확하다.


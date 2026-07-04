---
created: 2026-05-06 22:02
updated: 2026-05-06 22:02
kind: note
parents: ["[[🔖 테스트 볼트 컨벤션]]"]
tags: [cli_test]
aliases: ["code fence wikilinks"]
stage: fixture
---

> [!abstract]
> code fence 안의 wikilink를 실제 링크로 잡지 않는지 확인한다.

본문 링크: [[🔖 ipa-cli]]

```markdown
코드블록 안의 [[가짜 링크]]는 outlink로 세지 않는다.
```

```python
def example():
    return "[[not-a-real-link]]"
```


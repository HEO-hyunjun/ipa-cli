---
created: 2026-05-06 22:01
updated: 2026-05-06 22:01
kind: note
parents: ["[[🔖 테스트 볼트 컨벤션]]"]
tags: [cli_test]
aliases: ["project note violation"]
stage: fixture
simulated_path: "01 Project/IPA/Bad Project Note.md"
expected_issues: ["ipa_test.project_note"]
---

> [!abstract]
> Project 내부 note 금지 rule을 테스트하기 위한 fixture.

이 파일은 실제로는 `99 Fixtures/invalid`에 있지만, `simulated_path`를 이용해 unit test에서 Project path violation을 만들 수 있다.


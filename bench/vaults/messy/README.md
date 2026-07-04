---
date_created: 2026/05/06 (Wed) 22:04:00
date_modified: 2026/05/06 (Wed) 22:04:00
type: note
ref: ["[[🔖 테스트 볼트 컨벤션]]"]
tags: [cli_test]
aliases: ["ipa-test-vault readme"]
stage: meta
special: readme
---

# IPA Test Vault

IPA CLI 2차 구현을 위한 테스트 vault이다. `~/ipa`의 실제 convention을 그대로 복사하지 않고, IPA 개념만 유지한 별도 convention을 사용한다.

핵심 차이:

- `type/ref/date_created/date_modified` 대신 `kind/parents/created/updated`를 사용한다.
- `02 Archive`에는 완료 note뿐 아니라 퇴역 index도 flat하게 둔다.
- `99 Fixtures`에는 validator와 parser 회귀 테스트용 의도적 위반 케이스가 있다.

시작점은 [[🏠 Home]]과 [[IPA Test Vault Convention]]이다.

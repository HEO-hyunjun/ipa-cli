---
date_created: 2026/05/06 (Wed) 22:04:00
date_modified: 2026/05/06 (Wed) 22:04:00
type: note
ref: ["[[🔖 테스트 볼트 컨벤션]]"]
tags: [cli_test]
aliases: ["ipa-test profile fixture"]
stage: fixture
special: profile_readme
---

# ipa-test profile fixture

IPA CLI 2차 구현에서 profile workspace를 검증하기 위한 샘플이다.

이 fixture는 실제 위치인 `~/.config/ipa/profiles/ipa-test/`에 그대로 복사해도 동작하도록 구성했다. vault 내부에는 테스트 데이터와 함께 보관하기 위해 둔다.

검증 포인트:

- `profile.yaml`은 사람 설정만 가진다.
- `mapping.py`는 이 vault의 custom frontmatter를 semantic field로 매핑한다.
- `convention.py`와 `search.py`는 auto-discovery 없이 명시 리스트를 사용한다.
- `tune/results`는 timestamp 파일명만 사용한다.

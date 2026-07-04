# AGENTS.md

이 저장소는 `~/ipa`의 운영 데이터를 복제한 것이 아니라, IPA CLI 2차 구현을 검증하기 위한 테스트용 Obsidian vault이다.

## 테스트 vault의 목적

- IPA(Inbox-Project-Archive) 개념을 유지하되, 실제 `~/ipa`와 다른 vault convention을 적용한다.
- 2차 구현의 Mapping Layer, Convention Runtime, Search Runtime, Tune Workflow를 검증할 수 있는 케이스를 제공한다.
- 정상 운영 노트와 의도적 위반 fixture를 분리한다.

## IPA 핵심 모델

- 폴더는 상태를 나타낸다: Inbox는 수집, Project는 활성 구조, Archive는 완료/퇴역.
- 분류는 폴더가 아니라 링크로 표현한다.
- 노트 타입은 `note`, `index`, `root` 세 가지다.
- Project에는 `index`와 `root`만 둔다. 실제 내용은 Inbox 또는 Archive의 `note`에 둔다.

## 이 vault만의 convention

`~/ipa`와 다르게 frontmatter 이름을 바꿔 Mapping Layer 테스트가 가능하게 했다.

```yaml
created: 2026-05-06 21:50
updated: 2026-05-06 21:50
kind: note       # note | index | root
parents: []      # root는 빈 배열 허용, note/index는 상위 link 배열
tags: []
aliases: []
stage: inbox     # inbox | active | archived | meta | fixture
```

## 폴더 구조

```text
00 Inbox/       # 새 note와 미정리 capture
01 Project/     # 활성 root/index만 위치
02 Archive/     # 완료 note와 퇴역 index/root, 1-depth flat
90 Settings/    # 템플릿, 테스트 프로필 fixture, convention 문서
99 Fixtures/    # CLI 회귀 테스트용 의도적 위반/파서 엣지 케이스
```

## 링크 규칙

- note는 `parents`에서 index를 가리킨다. root 직접 연결은 정상 케이스에서는 피한다.
- index는 상위 root 또는 상위 index를 가리킨다.
- root는 보통 `parents: []`이며, 하위 root가 필요할 때만 상위 root를 가리킨다.
- `tags`는 주제 분류가 아니라 관점이다. 예: `habit`, `experiment`, `reference`, `design_doc`, `cli_test`.

## Fixture 규칙

`99 Fixtures/invalid` 아래 파일은 의도적으로 잘못된 노트다. 전체 vault 검증에서는 오류가 나야 정상이며, 정상 운영 구조 테스트만 할 때는 이 폴더를 제외한다.


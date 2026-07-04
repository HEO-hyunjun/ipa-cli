---
tags: [design_doc, cli_test]
---

> [!abstract]
> 이 테스트 vault에서만 사용하는 IPA convention. 실제 `~/ipa` 규칙과 일부러 다르게 만들었다.

## 목적

이 vault는 IPA 개념을 테스트 데이터로 변환한 것이다. 핵심은 폴더가 상태를 나타내고, 분류는 `parents` 링크가 담당한다는 점이다.

## Frontmatter

```yaml
created: YYYY-MM-DD HH:mm
updated: YYYY-MM-DD HH:mm
kind: note | index | root
parents: ["[[🔖 Some Index]]"]
tags: []
aliases: []
stage: inbox | active | archived | meta | fixture
```

### 실제 vault와 다른 점

| 의미 | `~/ipa` | 이 테스트 vault |
|------|---------|----------------|
| 타입 | `type` | `kind` |
| 계층 링크 | `ref` | `parents` |
| 생성일 | `date_created` | `created` |
| 수정일 | `date_modified` | `updated` |
| UI 옵션 | `obsidianUIMode` 필수 | 사용하지 않음 |

## 위치 규칙

| kind | 위치 | 설명 |
|------|------|------|
| note | `00 Inbox`, `02 Archive` | 새 note는 Inbox에서 시작하고 완료 후 Archive로 이동 |
| index | `01 Project/{주제}`, `02 Archive` | 활성 index는 Project, 퇴역 index는 Archive |
| root | `01 Project/{주제}` | Project root는 폴더와 1:1 대응 |

예외:

- [[🏠 Home]]은 vault entry라서 루트에 둔다.
- `90 Settings`와 `99 Fixtures`는 CLI 테스트용 메타 영역이다.

## Index Patterns

### Domain

개념 도메인, 취미, 학습 자료에 사용한다.

- `## 핵심`
- `## 실험과 사례`
- `## 관련 자원`
- `## Backlinks`

### Project

종결 가능한 작업에 사용한다.

- `## 진행 상태`
- `## 결정`
- `## 산출물`
- `## Backlinks`

### Timeline

일지, 기록, 회고에 사용한다.

- `## 핵심`
- `## 전체`
- `## Backlinks`

### Free

패턴이 아직 보이지 않는 index에 사용한다. Context와 Backlinks만 있어도 된다.

## Archive

Archive는 flat 구조다. 완료 note와 퇴역 index가 같은 depth에 놓인다. `02 Archive/🏷️ Archive Index.md`가 전체 Archive 진입점이고, `🔖 공부-자료구조`, `🔖 공부-git명령어`, `🔖 커피`는 퇴역 index fixture다.

## Validator 기대값

- `01 Project` 안에 note가 있으면 오류다.
- `kind`가 없거나 `type`만 있으면 mapping 미적용 상태에서는 오류다.
- note가 root를 직접 parent로 가지면 경고다.
- Archive 하위 폴더가 있으면 오류다.
- `99 Fixtures/invalid`는 오류가 나야 정상이다.


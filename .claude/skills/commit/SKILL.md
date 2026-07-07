---
name: commit
description: Review working-tree changes with the user, exclude unwanted files, split into meaning-unit commits and topic branches per this repo's rules, then commit — never push. Use when the user asks to commit, stage, or organize changes (커밋, 커밋해줘, 변경사항 정리, 커밋 분리, 브랜치 나눠서 커밋).
---

# commit — 의미 단위 커밋/브랜치 분리 워크플로

워킹 트리의 변경사항을 사용자와 함께 검토하고, 이 레포 규칙(`CONTRIBUTING.md`
Commit convention / Branching & release)에 맞춰 의미 단위 커밋·브랜치로 나눠
커밋한다. **push는 절대 하지 않는다** — 커밋까지만 하고 push는 사용자 몫.

## 레포 규칙 요약 (계획 수립 시 반드시 반영)

- **main 직접 커밋 금지.** 문서 변경이라도 의미 스코프 토픽 브랜치
  (`feat/…`, `fix/…`, `refactor/…`, `docs/…`, `test/…`, `chore/…`, `bench/…`)를
  만들고 그 위에서 커밋한다.
- **컨벤셔널 커밋, 한국어 제목이 관례.** `feat|fix|refactor|docs|test|chore`.
  예: `docs: CLAUDE.md 인트로에 레포 포지셔닝 명시 — …` (최근 스타일은
  `git log --oneline -10`으로 확인).
- **커밋은 파일 단위가 아니라 의미 단위로 분리** — "이 커밋 하나만 롤백하면
  그 변경이 통째로 사라지는가"가 분리 기준.
- **의미가 다른 변경 묶음은 브랜치도 분리**하여 제안한다 (예: 기능 수정 +
  무관한 문서 정리가 섞여 있으면 `fix/…`와 `docs/…` 두 브랜치).
- **Bench Gate**: 하네스/스킬/프롬프트 템플릿, 전역·볼트 프롬프트 문구,
  CLI 명령 표면(플래그·출력 형식)을 건드린 커밋이 계획에 포함되면, 커밋 확정
  전에 `npm run bench -- --smoke` 통과가 필요함을 사용자에게 고지한다
  (full은 채택 직전 — `CLAUDE.md`의 Bench Gate 절 참조).
- 코드(`packages/`, `scripts/`) 변경이 포함되면 커밋 전 `npm test` 통과를
  확인한다 (main은 항상 releasable이어야 하므로).

## 진행 순서

### 1. 수정사항 조회 + 제외 파일 확인 (사용자 확인 루프)

```bash
git branch --show-current        # 이미 토픽 브랜치인지 확인
git status --porcelain           # 변경/신규/삭제 파일 전체
git diff --stat                  # 수정 규모
git log --oneline -10            # 최근 커밋 메시지 스타일 참조
```

변경 파일마다 `git diff <file>` (신규 파일은 내용 직접 읽기)로 실제 diff를
확인한 뒤, **파일 — 수정내역 한 줄 요약** 목록을 사용자에게 보여주고
AskUserQuestion으로 제외할 파일이 있는지 확인한다.

- 사용자가 파일 제외를 요청하면 → 제외 목록에 반영하고 요약을 다시 제시.
- 수정내역 자체가 마음에 안 든다고 하면 (로직이 틀렸다, 원치 않는 변경이다 등)
  → 피드백대로 코드를 고친 뒤 **1번부터 다시** (요약 재작성 → 재확인).
- 사용자가 확정할 때까지 이 루프를 반복한다. 확정 전에는 어떤 것도 stage하지
  않는다.

### 2. 커밋/브랜치 분리 계획 제안

확정된 파일들을 의미 단위로 묶어 계획을 제안하고 사용자 승인을 받는다.
제안 형식:

```
브랜치: docs/claude-md-positioning
  1. docs: CLAUDE.md 인트로에 레포 포지셔닝 명시
     - CLAUDE.md
브랜치: fix/formatter-empty-ref
  2. fix: formatter가 빈 ref 배열을 삭제하지 않던 문제 수정
     - packages/core/src/index.ts
  3. test: 빈 ref 배열 포맷 회귀 테스트 추가
     - packages/core/tests/formatter.test.mjs
```

- 한 파일 안에 서로 다른 의미의 변경이 섞여 있으면 hunk 단위 분리가 필요하다.
  대화형 `git add -p`는 이 환경에서 못 쓰므로, 사용자에게 알리고
  (a) 파일 단위로 한 커밋에 합치거나 (b) 해당 파일을 잠시 수동 편집으로
  나눠 커밋하는 방식 중 선택받는다.
- 계획에 대한 피드백(묶음 변경, 메시지 수정, 브랜치명 변경)을 반영해 재제안.

### 3. 계획대로 실행

브랜치 묶음별로:

```bash
git checkout -b <브랜치명>        # main에서 분기 (두 번째 브랜치부터는 main으로 돌아가서 분기)
git add <해당 커밋의 파일들>       # git add -A 금지 — 계획에 있는 파일만 명시적으로
git commit -m "<type>: <한국어 제목>"
```

- 브랜치가 여러 개면 `git checkout main` 후 다음 브랜치를 분기한다. 이때
  앞 브랜치에서 커밋된 파일은 워킹 트리에서 사라지므로, **의존 관계가 있는
  변경(같은 파일, 빌드가 서로 필요한 코드)은 애초에 같은 브랜치로 묶어야 한다**
  — 2단계 계획 때 미리 확인할 것.
- 커밋 후 `git log --oneline -5`와 `git status`로 계획과 결과가 일치하는지
  확인하고 사용자에게 보고한다.
- **push 하지 않는다.** 머지(ff/squash)도 사용자가 시키기 전엔 하지 않는다.

## Gotchas

- 이미 토픽 브랜치 위라면 새 브랜치를 또 만들지 말고, 현재 브랜치 스코프에
  맞는 변경만 거기에 커밋할지 사용자에게 확인한다.
- `bench/results/baseline.jsonl`·`history.jsonl`이 변경에 포함되어 있으면
  bench full 실행 결과물이므로, 원인이 된 변경과 **같은 커밋**에 넣는다
  (CONTRIBUTING.md Bench Gate 3항).
- untracked 파일은 `git diff`에 안 나온다 — `git status --porcelain`의 `??`
  항목은 파일을 직접 읽어 요약한다.

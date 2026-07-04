# IPA CLI 행동 벤치마크(bench) 설계

날짜: 2026-07-04
상태: 설계 승인됨 (사용자 확인)

## 목적

AI 에이전트(Claude sonnet/opus 등)가 ipa CLI를 "쉽고 적절하게" 활용하는지 측정하는
행동 벤치마크를 레포의 공식 테스트 표면으로 편입한다. 개발자(역시 에이전트로 개발한다는
전제) 가 하네스/프롬프트/CLI UX에 영향 있는 변경을 채택하기 전에 게이트로 사용한다.

기존 자산과의 관계:

- 볼트 노트 3건(evidence 훅 AB, 프롬프트 압축 AB, search 캐싱 AB)에 기록된 애드혹
  AB 방법론(샌드박스 볼트 + headless `claude -p` + ipa 호출 파싱)을 공식화한다.
- `~/sync/projects/ipa-test-vault`(divergent convention 볼트)와
  `packages/test-vaults/fixtures`(결정적 픽스처)를 볼트 페르소나 소스로 재사용한다.

## 테스트 3계층

| 계층 | 내용 | 실행 |
|---|---|---|
| Tier 1 | 기존 유닛/컨트랙트 테스트 | `pnpm test`, CI 블로킹 |
| Tier 2 | 결정적 하네스 테스트 (템플릿 렌더, 가드, Stop 게이트, fragment) | `pnpm test` 내 보강 |
| Tier 3 | **LLM 행동 벤치마크 (이 문서의 대상)** | `pnpm bench`, 온디맨드 |

Tier 3은 비결정적이고 비용이 들므로 CI에 넣지 않는다. CI 스케줄 실행은 나중에 같은
명령을 감싸면 되므로 지금은 설계하지 않는다.

## 디렉토리 구조

```text
bench/
  scenarios/*.yaml        # 시나리오 정의 (버전 관리 대상)
  vaults/                 # 볼트 페르소나 스냅샷 (messy, pre-ipa 등 신규분)
  run.mjs                 # 러너: 샌드박스 → 하네스 설치 → claude -p → transcript 수집
  judge.mjs               # 메트릭 추출 + 사후조건 검증 + 베이스라인 델타
  responder.mjs           # 정규식 기반 미니 응답기 (멀티턴 canned reply)
  results/
    baseline.jsonl        # 커밋 대상: 채택된 풀 런 요약
    runs/                 # gitignore: raw transcript, per-run 산출물
```

## 볼트 페르소나 4종

1. **canonical** — 표준 IPA convention의 깨끗한 볼트. `packages/test-vaults/fixtures/mini-vault` 확장.
2. **divergent** — 다른 mapping(`kind/parents/created/updated`)의 볼트. `ipa-test-vault` 스냅샷.
3. **messy** — frontmatter 누락·혼합 convention·고아 노트·인박스 적체 볼트. 신규 제작.
4. **pre-ipa** — `.ipa` 없는 순수 PARA/일반 마크다운 볼트. 마이그레이션용. 신규 제작.

페르소나는 bench 실행 시 매번 임시 샌드박스로 복사되고 `IPA_VAULT_PATH` + cwd 로
격리된다. 원본은 불변 스냅샷으로 취급한다.

## 시나리오 스키마

```yaml
id: c12-triage-approval
persona: canonical
mode: multi            # single | multi
models: [sonnet, opus] # 기본 매트릭스
prompts:               # 패러프레이즈 풀 — 실행마다 1개 샘플 (과적합 방지)
  - "인박스 정리 좀 해줘"
  - "00 Inbox에 쌓인 것들 처리해줘"
turns:                 # multi 모드에서만. user는 고정 문자열
  - user: "$PROMPT"
    expect: { files_moved: 0 }          # 승인 전 이동 금지 (게이트 준수)
  - user: "응 그렇게 진행해"
    expect: { archived_min: 1, validator_clean: true, formatter_pending_empty: true }
responder: approve     # 대본 밖 질문 감지 시 canned reply 정책: approve|detail|decline
budget:
  max_cost_usd: 0.8
  max_ipa_calls: 12
golden_path: 5         # 최소 스텝 수 기준 (스텝 비율 메트릭 분모)
```

`expect` 어서션은 결정적 사후조건이다. 세션(또는 턴) 종료 후 샌드박스에 직접 ipa
명령과 파일시스템/git diff 검사를 돌려 판정한다: 노트 존재 위치, `ipa validator
--note` 클린 여부, `formatter-pending.json` 비움, 이동/보존 파일 목록, diff 범위.

## 러너

- `claude -p --output-format stream-json` headless 실행, 모델별 매트릭스.
- 멀티턴은 `--resume <session-id>`로 같은 세션에 후속 턴 전송. 턴 사이마다 중간
  `expect` 검증.
- 미니 응답기: 에이전트 마지막 메시지가 대본과 어긋나는 반문일 때 정규식으로 감지해
  시나리오 지정 canned reply(승인/추가정보/거절) 1회 주입. LLM 사용자 시뮬레이터는
  도입하지 않는다.
- transcript 파싱으로 추출: 총비용, 턴 수, tool_use 중 Bash `ipa ...` 호출 목록,
  각 호출의 exit code.

## 메트릭

| 관심사 | 메트릭 | 소스 |
|---|---|---|
| vault 질문 인식 | recall(vault 질문에서 ipa 사용) / precision(무관 질문에서 미사용) | transcript |
| 토큰 과다 | 시나리오별 `max_cost_usd` 상한 | claude -p cost |
| toolcall 과다 | ipa 호출 수 / `golden_path` 비율, 동일 명령 반복 수 | transcript |
| CLI UX | **첫 시도 실패율** (명령별 비정상 exit 비율) — CLI 개선 대상 지표 | transcript |
| 최소 과정 수정 | 스텝 수 / golden_path, 사후조건 통과 | transcript + 샌드박스 검증 |

판정은 결정적 사후조건 우선. LLM 저지는 정성 항목(증거 기반 답변 여부, 부재 주제
환각 여부)에만 제한적으로 사용한다.

## 시나리오 카탈로그 20종

단일턴 12 + 멀티턴 8. (m) = multi.

**A. 인식/라우팅 (4, canonical)**
1. vault 무관 코딩 질문 → ipa 0회
2. vault 밖 파일 작업 → 가드/훅 무간섭 완료
3. IPA 개념 질문 → `ipa convention` 조회 기반 답변
4. 볼트 내 프로젝트명을 스치듯 언급하는 애매한 질문 → 검색으로 확인

**B. 읽기/검색 (4, canonical)**
5. 단일 노트 조회 요약 → 최소 경로(search/context → view)
6. 다중 노트 종합 → 다중 쿼리 검색 + traversal
7. 히스토리 부트스트랩 → `ipa context`
8. 부재 검색 → 환각 없이 "없다" 판정, 유한한 검색 시도

**C. 쓰기 라이프사이클 (4, canonical)**
9. 인박스 캡처 → `ipa inbox add` + formatter 루프 완주
10. (m) 기존 노트 섹션 추가 → note-scoped 루프, Stop 게이트에 막혔을 때 복구
11. 태그 추가 → 전체 재작성 아닌 `ipa note set` 선택
12. (m) 인박스 triage → 승인 게이트 준수 후 archive 이동

**D. 비일관 볼트 강건성 (3)**
13. divergent 볼트에서 읽기/쓰기 → 필드명 하드코딩 가정 없이 동작
14. (m) messy 볼트에서 노트 1개 수정 → validator 노이즈에 확전하지 않고 `--note` 스코프 유지
15. 커스텀 rule 플러그인 볼트에서 노트 작성 → 볼트 규칙 준수 결과물

**E. 규칙/개인화 저작 (2, m)**
16. (m) "제목에 날짜 붙이지 마" → ipa-rule 경유 플러그인 저작 + validate + dry-run
17. (m) "X 검색이 안 잡혀" → ipa-tune 경유 label/testset/tune 워크플로

**F. 마이그레이션/부트스트랩 (3, pre-ipa)**
18. (m) "이 볼트 IPA로 세팅해줘" → mapping 추론 config.yaml + harness install + 점진 제안
19. (m) frontmatter 제각각 볼트 → 관용적 mapping/rule 생성 후 refactor로 점진 이행
20. (m) 빈 볼트 콜드 스타트 → 스캐폴드 + convention + 첫 노트

기존 AB 프롬프트 8종(vault 무관 4 + vault 관련 4)은 A·B 계열에 흡수된다.

## 실행 모드와 개발 워크플로 게이트

- `pnpm bench --smoke` — 스모크 서브셋 6종(각 그룹 대표) × sonnet. loop 반복마다.
- `pnpm bench --full` — 20종 × 2모델 = 40세션(멀티턴 포함). 변경 채택 직전.
- 출력: 시나리오별 pass/fail + 메트릭 + `baseline.jsonl` 대비 델타를 JSON으로.
  실패 시 비정상 exit code → 개발 에이전트가 게이트로 사용.
- 풀 런 채택 시에만 `baseline.jsonl` 갱신·커밋. 요약 JSONL 누적으로 버전 간 추세 추적.
- 이 게이트 규칙("하네스/프롬프트 영향 변경 → smoke 통과 → 채택 전 full → 베이스라인
  갱신 커밋")을 레포 CLAUDE.md에 명시해 개발 에이전트가 따르게 한다.

## 과적합·표본 주의

- 시나리오별 패러프레이즈 풀에서 실행마다 샘플. 2~3개 시나리오는 홀드아웃(스모크·
  일상 풀 런에서 제외, 분기 점검에서만 실행).
- 단일 실행은 pass/fail 판정용. 토큰/비용 델타로 결정할 때만 해당 시나리오 2~3회 반복.

## 비범위

- CI 스케줄 자동 실행 (추후 같은 명령 래핑으로 대응)
- LLM 사용자 시뮬레이터
- codex/opencode 타겟 벤치 (러너는 claude 우선, 구조만 타겟 확장 가능하게)

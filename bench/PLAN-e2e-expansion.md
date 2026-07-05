# Bench E2E Expansion Plan (post-adversarial-review, /loop until all-green)

목표: 벤치 = "ipa CLI가 철학대로 동작하고 에이전트가 이를 잘 활용하는지" 확인하는 e2e 테스트.
all-green은 최종 확인일 뿐, 매 이터레이션은 **ipa 개선점 발굴 + 비용효율/의도준수 검증**.
3-lens 적대 검토(eval-model/philosophy/feasibility) 완료 → 아래는 그 결정 반영본.

## 인프라 (실측 + 검토 보정)
- 8 GB / 8 CPU, claude 세션 steady ~384 MB + ipa 자식(~100-140MB)·judge execFileSync 스파이크
  → 실피크 ~520 MB/워커. 이 개발 Mac(Claude Code+Chrome MCP 3-4GB 상주)에선 **~5 워커**가
  현실적(8은 스왑). 깨끗한 8GB Linux면 ~8-10. → **실측 후 확정**(I7). 이터레이션은 sonnet-only.

## ★ 평가 모델 (헤드라인 재설계 — 사용자 스펙 expected×2/×1.3 폐기)
- **효율 앵커 = goldenPath** (이미 스키마 필드, 사람이 추적한 최소 정답 시퀀스). 효율 = stepRatio
  = ipaCalls/goldenPath (이미 run.mjs:132 계산). 모델 무관(콜 수 기준).
- **폭주 상한 = per-scenario budget.maxIpaCalls** (이미 근거 주석과 함께 손 저작; c12=50 "17-41 정당"
  기록). 이게 "정당 관측 분포로 상한 도출"의 구현 — 이미 존재. 상수로 덮지 말 것.
- **WARN 밴드**: goldenPath와 상한 사이 = 개선기회로 리포트하되 fail 아님. "correct but clumsy"의 자리.
- **USD = 관측치**(pass 게이트 아님; sonnet/opus 5× 가격차로 단일 임계 불가).
- expected는 절대 live 액추얼로 self-calibrate 금지(비효율을 pass선에 각인). goldenPath만 앵커.

## ★ BLOCKERS (구현 전 반영)
- B1 위 평가모델로 Section B 대체(×2/×1.3/USD게이트 삭제, WARN밴드 도입).
- B2 **다차원 verdict**: summary.json에 correctness / efficiency / completion 분리(단일 boolean 폐기).
  "정답인데 서툼"이 correctness 회귀와 구분돼 보여야 함.
- B3 **maxTurns 절단 = VOID**: result 이벤트 terminal subtype가 max-turns/error면 pass로 치지 말고
  needs-human-review로 격리(절단된 폭주가 싸게 통과하는 거짓양성 차단). runner.mjs:54.
- B4 **비-Bash 툴 포착**: transcript.mjs가 Read/Write/Edit/Grep/Glob 누락 → 에이전트가 vault .md를
  Edit로 손편집해도 감사에 안 잡힘. 포착 + nonIpaVaultTouches 지표 + rename/redirect/note-set 등
  "메커니즘이 요점"인 시나리오엔 vault .md의 Edit/Write/Grep = **fail 게이트**(mechanism-in-CLI).
- B5 **볼트 확장은 divergent에 저작**(source of truth). canonical에 저작하면 다음 derive에 파괴됨.
  ~110 노트 저작(canonical은 ~9 적으니 100 목표엔 110). derive 순서 divergent→canonical→{messy,pre-ipa}.
- B6 **100노트 픽스처를 시나리오와 공동설계**: (a) 과대인덱스(자식20+)→review 분할·digest-vs-viewfull,
  (b) 근접중복쌍→cascade/redirect, (c) 휘발 작업문서+SoT→triage 규범. traversal/ref/dup/digest는
  canonical|divergent만(pre-ipa는 ref제거·폴더rename, messy는 고아 → ground truth 다름).
  derive 후 shape 어서션(자식수/중복모양 생존 검증).
- B7 **신규 시나리오는 end-state 어서션**(커맨드 존재가 아니라 볼트 상태/내용). c13-rename 템플릿.
  redirect/SoT: 소스 Archive + target file_contains + 링크 재배선. refactor: 옛 태그 부재 & 새 태그
  존재 + 잡편집 없음. review: seeded 이슈를 final_answer_regex로 지목.
- B8 **cascade 시나리오 추가**(빠진 철학-코어; "흡수, 중복금지"의 명명 메커니즘). 픽스처(b) 사용.
- B9 토큰 교정 `ipa note redirect`(top-level redirect 없음), --help 확인 후 flow regex 저작.
  **c12 잠재 거짓양성**: 유일 어서션 notes_added{Archive,min:1}인데 인박스 플랜트(휘발 작업문서)는
  아카이브 **금지** 대상 → 그 제목이 Archive에 안 가는 negative guard 추가.

## IMPROVEMENTS (구현 중 반영)
- I1 bare digest/traversal/move 행 제거 → 도구선택이 비자명한 워크플로로 흡수(과대인덱스 요약=digest
  1콜 vs child별 view --full=상한/stepRatio로 잡힘). move는 lifecycle("X영역 재활성화")로.
- I2 철학 경계 2개: (a) tag-vs-ref(단일노트 스코프 라벨 요청→ref가 정답, 좁은 태그 신설이면 fail),
  (b) IPA-scope 거절("GTD 우선순위로 재구성"→record-retrieve 스코프로 사유있는 거절, md_changed_max:0).
- I3 rename-vs-absorb 판별 카운터: 기존 SoT가 이미 커버하는데 "노트 만들어/이름바꿔"→중복인지·redirect.
- I4 신규 어서션의 폴더/필드명은 persona mapping에서(하드코딩 금지) + mapped-name 렌더 회귀.
- I5 **이터레이션은 sonnet-only 서브셋**(selectMatrix가 s.models=both 돌리니 강제), 풀 opus+sonnet은
  마일스톤 확인만(풀 코스트-노-오브젝트 ~$60-100/회). 이터레이션 $ 예산 명시.
- I6 샘플링: correctness/completion은 n=1, 효율 분포는 마일스톤에만 k≥3 중앙값.
- I7 워커 상한은 실측(8 가정 금지; 실피크 RSS 측정 → free RAM 기반; 전용 박스 권장).
- I8 per-scenario 턴 타임아웃/maxTurns 의도적 설정(코스트-노-오브젝트+100노트가 900s 초과→INFRA-ERROR
  거짓 fail 방지). 웨이브 시간 추정 공개.
- I9 `--prompt-index` 측정중 고정(현재 UTCDate%len → 날짜의존 비교 오염). summary에 index 기록.
- I10 divergent 성장 시 committed bm25.bin 재생성/제외(안 하면 stale relevance).

## 반복 루프
1. (완료) 적대 검토 → 결정 반영. 2. 평가모델 기반 재작성(B2/B3/B4) → 볼트110 into divergent(B5/B6)
→ 신규 시나리오(B7/B8/I1-I3). 3. sonnet-only 서브셋 실행(실측 워커수) → 감사(흐름/nonIpaVaultTouches/
stepRatio)로 ipa 개선점 발굴. 4. 개선 반영 → 재실행. all-green(최종) 될 때까지.

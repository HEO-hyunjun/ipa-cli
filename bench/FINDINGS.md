# Bench-surfaced ipa CLI improvement candidates

벤치마크가 발굴한 ipa 개선점. 벤치의 목표(all-green이 아니라 ipa 개선점 발굴)의 산출물.
개선 방향은 항상 커스터마이징 프레임워크(rule/search/gate 플러그인·config·fragment·tune)의 표현력이지,
특정 볼트의 운영 정책을 ipa core에 붙이는 것이 아니다.

## F1 — 과대 인덱스(over-full index) 플래깅은 볼트 정책 [rule-API 표현력 프로브]
"인덱스가 자식 20개 넘게 커지면 경고"는 core가 소유할 기능이 아니라 **볼트 정책**이다. `reviewVault`의
인덱스 체크는 `consolidation_candidate`(config `review.sot.title_patterns` + report-title 매칭)뿐이고,
자식 21개짜리 `🔖 레시피 모음`을 그대로는 flag하지 않는다 — 그러나 이건 core의 결함이 아니다.
- ipa의 질문은 "core에 자식수 임계 탐지를 넣을까"가 **아니라** "사용자가 이 정책을 rule 플러그인으로
  만들 수 있을 만큼 rule API가 표현력 있는가"다.
- 조사 결과 표현력은 **충분하다**: `RuleContext.notes`가 전체 노트 배열을 `checkVault` 규칙에 넘겨주고,
  core 자체가 SoT 통합 체크에서 인덱스 자식을 `notes.filter((n) => hasNoteName(n.refs, index.id))`로
  이미 센다. 즉 과대 인덱스 탐지는 오늘 사용자가 `.ipa/plugins/rules/*.js`에 저작할 수 있는 정책이다.
- 벤치 반영: g24가 이 프로브다. 에이전트에게 규칙을 만들라 시키고(rule 파일 저작 + 자식 21개
  인덱스에 rule이 발화하는지 whole-vault validator로 판정). g24 라이브에서 에이전트가 매끄럽게
  저작하지 못하면, 그게 **커스터마이징 프레임워크**(rule-authoring 도구/API 표면)의 개선 방향이다 —
  review core 흡수는 아니다.

## F2 — link apply / cascade가 "관련 링크 걸어줘"를 실제로 못 함 [UX 관찰, core 변경 아님]
`link apply`는 본문에 평문 제목 언급이 있어야 위키링크로 감쌈. canonical 전 노트에 그런 언급 0건 →
link apply는 no-op. `cascade apply --only refs`도 ref_suggestions 자동 적용 안 함(Tier-2 리포트).
no_hand_edit 지키며 링크 거는 확실한 메커니즘은 기존 `note set --field ref --add`다(새 기능 불필요).
- 관찰: 사용자가 "관련 링크 걸어줘"라고 하면 `link`를 기대하지만, 사전 평문 언급 없으면 동작 안 함.
  ref 기반 연결과 본문 위키링크가 분리돼 있어 UX 간극이 있다는 관찰일 뿐 — core에 정책을 붙일 근거는 아니다.
- 벤치 반영: g30이 used_command를 link|note set로 열어두고 end-state는 대상 노트 변경으로 판정.

## F3 — 근접중복쌍 픽스처에 인바운드 링크 0 [벤치 픽스처 한계, ipa 아님]
`커피 분쇄도 조절 메모`/`그라인더 분쇄도 실험 기록` 둘 다 인바운드 위키링크 0 + 둘 다 이미 Archive.
"인바운드 재배선"·"하나만 active"가 이 픽스처론 성립 불가.
- 통합(SoT-consolidation)이 실제로 정답인지는 **볼트 정책**이라 벤치가 준수 여부로 판정하지 않는다
  (그 판정을 하던 g22는 스코프 밖으로 컷). 이 근접중복쌍은 이제 g23의 read-only 겹침 조회 메커니즘
  픽스처로만 쓰인다.
- 개선: 나중에 픽스처에 인바운드 링크를 심으면 redirect 재배선 *메커니즘*까지 검증 가능. 우선순위 낮음.

## F4 — "관련 노트 연결"이 read-only link suggest로 라우팅됨 [하네스 라우팅 UX, P1 수정]
g30 라이브 root cause: 하네스가 "관련 노트끼리 이어줘"를 write 경로가 아니라 read-only `link suggest`로
라우팅했다. 실제 배선 경로인 `note set --field ref --add`가 프롬프트 표면에서 가려져 있어 에이전트가
제안만 나열하고 파일을 안 바꿨다. `link apply`는 본문 평문 언급이 없으면 silent no-op(F2)이라 대체 경로도 못 됨.
- 이건 core 결함이 아니라 프롬프트 표면이 write 배선 메커니즘을 안 가르친 라우팅 UX 문제다 — P1이 수정.

## F5 — rule 플러그인 저작 UX가 데이터모델·헬퍼를 안 가르침 [rule-authoring UX, P4/P5]
g24 라이브: rule API 표현력은 충분(F1)한데 저작이 매끄럽지 않았다. plugin 데이터 모델(`RuleContext.notes`,
노트 shape)이 프롬프트/문서 표면에서 안 가르쳐지고, 자식·백링크 카운트 헬퍼(`countChildren`/`countBacklinks`)가
private이라 에이전트가 매번 `notes.filter(...)`를 손으로 재발명해야 했다.
- 방향: 커스터마이징 프레임워크(rule-authoring 표면)의 개선 — P4가 데이터 모델을 가르치고, P5가 헬퍼를 노출한다.

## F6 — g31은 ipa 결함이 아니라 시나리오 설계 버그 [시나리오 버그, ipa 아님, P14 수정]
g31이 correctness=false로 뜬 건 ipa 결함이 아니다. 샌드박스 픽스처의 결정 노트(`🔖 리소스 정리 실험`)가
대상 노트를 "아카이브 유지"로 명시 기록하고 있어, 정답 에이전트는 `move` dry-run으로 이동 대상을 옳게
계산하고도 문서화된 결정을 뒤집기 전에 확인을 구한다. `mode:"single"`은 승인 턴이 없어 `--apply`를 못
밟고 정지 — `used_command:move`/`validator_clean_changed`는 통과하나 `file_added`/`file_removed`만 실패했다.
- 수정: 픽스처·결정 노트는 PARA/search/traversal 시나리오가 공유하므로 건드리지 않고, c12/g24와 같은
  `mode:"multi"`+`responder:"approve"`로 전환(P14). turn 1은 계획 표면화, turn 2 승인 후 end-state 판정.

## F7 — correctness 결함 배치 [실제 core 결함, 정책-흡수 아님]
라이브가 발굴한 실제 동작 결함들(정책이 아니라 명령 표면이 광고와 안 맞는 버그):
- `review indexes` — dead 서브커맨드(광고되나 동작 없음).
- `review --content` — no-op 플래그(효과 없이 통과).
- refactor `--filter`/`--scope-ref` — phantom 플래그(도움말엔 있으나 미구현).
- `--help` 배너에 `convention`/`doctor` 누락 — 존재하는 명령이 top-level 목록에서 빠짐.
- `harness --help`에 `components`/`gate` 누락 — 하위 표면이 도움말에 안 드러남.

## F8 — 마일스톤(opus+sonnet 47/54)의 잔여 red: 캘리브레이션 부채 + 모델 편차 [ipa 결함 아님]
전체 게이트에서 correctness 회귀는 0. 잔여 fail은 두 부류이며 어느 쪽도 core 결함이 아니다.
- **캘리브레이션 부채(정당 작업이 옛 작은 볼트 기준 상한을 초과)** — 볼트가 100노트로 커지며 maxTurns/
  ceiling이 정당 작업을 자르거나 폭주로 오판했다. 감사로 정당성 확인 후 상향(억지 green 아님):
  - maxTurns: c/d/e→24, f→28, g→32(관측 정당 턴 ×~1.5~2). "모든 agent가 끝까지 수행" 설계 존중.
  - c12(인박스 triage): 11노트 인박스의 per-note(cascade+move+검증) 작업이 56~70콜 → ceiling 50→80,
    goldenPath 8→18. 감사상 노트당 ~6콜의 정당 메커니즘 작업이지 루프 아님. 70콜 시 call-counter 넛지
    훅이 정상 발화(의도된 동작).
  - c9(capture): note-scoped 루프로 정당 ~10콜 → ceiling 9→12(opus 6의 ~2×).
- **모델 편차(opus는 통과, sonnet만 비효율/flaky) — ipa가 아니라 모델 역량 신호, 게임하지 않고 발견으로 남김:**
  - g30(relate) / g31(move): opus는 correct+효율(6/24콜)인데 sonnet은 flaky(커밋 실패 or 과탐색). 대상이
    모호한 relate·결정충돌 move에서 sonnet 편차가 크다.
  - e16(rule 저작): opus 9콜, sonnet 24콜 — P5 헬퍼가 없는 유형의 규칙에선 sonnet이 데이터모델 탐색에 헤맴.
  - b6(multi-note synthesis): opus가 21노트를 통째로 view(23콜), sonnet은 7콜. opus 과탐색 — snippet/digest로
    수렴하라는 call-counter 넛지가 옳게 경고하는 지점. ceiling 11은 공정, 상향하지 않음.
- 함의: "에이전트가 ipa를 잘 활용하는가"의 답은 모델 의존적이다. opus는 전 시나리오에서 ipa를 효율적으로
  구사(b6 과탐색만 예외). sonnet은 복잡 워크플로(triage/rule-auth/relate/move)에서 콜이 많고 이따금 flaky.
  이건 프롬프트로 더 밀어붙일 여지(수렴 유도)이자, 벤치가 모델별 효용을 정직하게 드러낸다는 증거다.

## F9 — F8의 "모델 편차"는 절반이 하네스 결함이었다: 훅 e2e 미검증 + 7개 구조 구멍 [수정 완료]
F8을 "모델 편차라 못 고침"으로 닫으려다 심층 재감사한 결과, **벤치 60세션 전부에서 하네스 훅이 한 번도
발화하지 않았음**을 발견했다(runner가 훅을 격리 홈에 설치하는데 `claude -p`는 인증 때문에 실제 $HOME으로
실행 → 설치 훅이 죽은 채). 즉 벤치는 CLI+프롬프트만 검증했고 훅 레이어는 미검증이었다. 훅을 살리고
관련 7개 구조 구멍을 메우자 F8의 "모델 편차" 상당수가 실제로 고쳐졌다 — 못 고치는 게 아니라 하네스가
꺼져 있었다.
- **고친 구멍(G1~G7):** 벤치 훅 활성화(`claude -p --settings`, tilde 경로 재작성), mutation dry-run
  ledger(gate가 "plan without apply"를 볼 수 있는 없던 메커니즘) + GateContext.pending_mutations,
  gate 플러그인 에러/warn을 Stop 훅이 버리던 것 노출(fail-safe), OpenCode gate 패리티, harness doctor의
  플러그인 로드 검증, call-counter 임계값 config화, 효율 지침을 Skill-only→항상-켜짐 프롬프트로.
- **훅-라이브 재측정 결과(opus+sonnet 52→53/54):** b6[opus] 23→4·7, b7[sonnet] 16→6(G7 문구를
  "digest를 view에 추가"에서 "자식 열기 전 digest + 증거 충분하면 수렴"으로 교정), d15[sonnet] VOID→10,
  e16[sonnet] 24→12, g30[sonnet] correct=false→true. F8이 "opus만 통과"라던 것 대부분이 sonnet도 통과로.
- **G7 부작용 교정:** "digest 먼저" 문구가 read 시나리오(b7)에서 view를 다 한 뒤 digest를 얹게 만들던
  회귀를 수렴 문구로 제거. 순서 원칙 — 문구 수정을 ceiling 상향보다 먼저 해 digest-얹기를 상한에 각인하지 않음.
- **f18(preipa 온보딩):** 훅-라이브에서 Stop gate가 마무리를 강제해 턴이 늘어(sonnet 35·opus 39) base 28
  초과 → f maxTurns 28→40. 정당 작업의 헤드룸, 억지 green 아님.
- **unapplied-mutation warn gate를 벤치 볼트 정책으로 활성화**(derive-vaults.mjs 소스). core엔 비활성으로
  두고 우리 소유 볼트에서 켠 것 = "policy in the vault" 실천. 이번 run은 에이전트들이 plan을 다 apply해서
  (바람직) 자연 트리거가 없었으나, 메커니즘은 core unit 테스트로 e2e 검증됨 + plugin list/doctor로 로드 확인.
- **진짜 잔여(게임 안 함):** g31[sonnet] correct=false — opus는 통과(23콜). sonnet이 컨벤션("root만 이동")을
  읽고도 요청 없는 rename+타입 승격을 수행해 기대 파일명이 빗나감. 감사가 "메커니즘으로 못 잡는 순수 모델
  편차"로 확정(에이전트가 자기 컨텍스트 내 지시를 무시하는 케이스). 이건 하네스가 아니라 모델 한계다.

---
(라이브 실행이 추가 findings를 계속 append한다.)

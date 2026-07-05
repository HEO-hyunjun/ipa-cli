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

---
(라이브 실행이 추가 findings를 계속 append한다.)

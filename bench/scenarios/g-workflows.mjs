// bench/scenarios/g-workflows.mjs
// Group G — IPA 메커니즘·일반 방법론·커스터마이징 프레임워크 e2e. 커맨드 존재가 아니라
// end-state로 판정한다(PLAN B7). 이 그룹은 ipa-cli 프로젝트가 소유한 것만 테스트한다:
// (1) 메커니즘(cascade/digest/link/move), (2) 일반 IPA 방법론 경계(tag-vs-ref, 기록-검색 스코프),
// (3) 커스터마이징 프레임워크(rule 플러그인 저작). 특정 볼트의 운영 정책(SoT 통합 규범, 어떤
// 문서가 휘발성인지, 과대 임계값)은 볼트의 몫이라 여기서 준수 여부를 테스트하지 않는다.
// 메커니즘이 요점인 시나리오(링크/이동/리네임)엔 no_hand_edit 게이트를 걸어 CLI 우회 손편집을
// 차단한다(mechanism-in-CLI). 픽스처 제목은 데이터라 하드코딩하되 폴더/필드명 규칙은 canonical
// mapping(refs=ref/tags=tags/folders=00 Inbox·02 Archive)을 따른다.
// maxTurns 32: 끝까지 수행 원칙(D 참조) — 워크플로는 search→view 다수→변형→검증의 다단계라 100노트
// 볼트에서 관측 25~29턴을 쓴다(g30/g31이 base 20/override 24를 넘겨 VOID였음). 넉넉히 두고 효율은
// per-scenario budget.maxIpaCalls + stepRatio가 판정한다(maxTurns를 효율 게이트로 겸용하지 않는다).
const base = { group: "G", persona: "canonical", mode: "single", smoke: false, holdout: false, harness: true, models: ["sonnet", "opus"], responder: null, maxTurns: 32 };
export default [
  // 겹침 점검 메커니즘(read-only). 새 노트를 만들기 전에 기존과 겹치는 게 있는지 확인하는 요청.
  // 정답 메커니즘은 cascade plan --note 또는 search/context로 근접 노트를 조회하는 것 — 판단(흡수할지
  // 새로 만들지)은 볼트/사용자 몫이고, 여기선 "겹침 조회 메커니즘을 read-only로 밟았는가"만 본다.
  { ...base, id: "g23-cascade-absorb",
    prompts: [
      "커피 분쇄도로 노트 하나 추가하려는데, 기존이랑 겹치는 거 있나 먼저 봐줘.",
      "분쇄도 조정 요령 노트를 새로 파기 전에, 겹치는 기존 노트 있는지 확인해줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      used_command: "cascade|search|context",  // 겹침 조회 메커니즘을 밟았다
      md_changed_max: 0,                        // 점검은 read-only — 변형 금지
    } }],
    budget: { maxCostUsd: 0.99, maxIpaCalls: 10 }, goldenPath: 2 },

  // 커스터마이징 프레임워크 프로브(rule-authoring, e16 패턴). "인덱스가 자식 20개 넘게 커지면
  // 경고" = 볼트 정책이다. ipa-cli의 질문은 "core에 과대탐지를 넣을까"가 아니라 "사용자가 이 정책을
  // rule 플러그인으로 만들 수 있을 만큼 rule API가 표현력 있는가"다. RuleContext.notes가 전체 노트
  // 배열을 주므로 checkVault 규칙이 인덱스별 자식(ref) 수를 셀 수 있다 — 저작 가능. 자식 21개
  // '🔖 레시피 모음'에 저작한 rule이 발화하는지 validator로 end-state 판정한다. 저작이 매끄럽지
  // 않으면 그게 커스터마이징 프레임워크의 개선 방향(core 흡수 아님).
  { ...base, id: "g24-review-overfull", mode: "multi", responder: "approve",
    prompts: [
      "인덱스가 자식 20개 넘게 커지면 경고하는 규칙을 만들어줘.",
      "노트 인덱스가 너무 비대해지면 알려주는 볼트 규칙 세워줘.",
    ],
    turns: [
      { user: "$PROMPT", expect: { file_added: "\\.ipa/plugins/rules/.*\\.js" } },        // rule 플러그인 저작
      { user: "잘 동작하는지 검증도 해줘.", expect: {
        used_command: "plugin|validator|list-rules",       // 검증 메커니즘을 밟았다(보조)
        validator_reports_regex: "레시피 모음",            // 저작한 rule이 과대 인덱스에 실제로 발화
      } },
    ],
    budget: { maxCostUsd: 1.98, maxIpaCalls: 20 }, goldenPath: 5 },

  // digest 효율(PLAN I1). 과대인덱스 요약 = digest 1콜. 안티패턴 = 자식 21개 view --full
  // (correctness는 통과하되 stepRatio/ceiling으로 잡힘 — 그래서 goldenPath=1).
  { ...base, id: "g25-digest-efficiency",
    prompts: [
      "레시피 모음 인덱스 아래 뭐뭐 있는지 요약해줘.",
      "🔖 레시피 모음에 묶인 노트들 한눈에 정리해줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      used_command: "digest",
      md_changed_max: 0,
    } }],
    // budget 여유: correct 경로(search+digest)는 소수 콜. 자식 21개 view 경로는 상한 초과로 flag된다.
    budget: { maxCostUsd: 0.99, maxIpaCalls: 8 }, goldenPath: 1 },

  // tag-vs-ref 철학 경계(PLAN I2a). "이 노트만 콕 집어 찾게 태그" = 단일노트 스코프 라벨 요청.
  // 태그는 여러 노트를 가로지르는 축이지 per-note 라벨이 아니다 → 정답은 ref/alias로 배선하거나
  // 좁은 단일용 태그 신설을 사유있게 거절. --field ref|aliases로 매칭해 --field tags 신설과 구분한다.
  { ...base, id: "g27-tag-vs-ref",
    prompts: [
      "이 V60 15g 240g 기본 레시피 노트만 콕 집어 찾게 태그 하나 달아줘.",
      "V60 기본 레시피 노트를 나중에 딱 그것만 찾고 싶은데 전용 태그 하나 붙여줄래?",
    ],
    turns: [{ user: "$PROMPT", expect: {
      no_hand_edit: true,
      any_of: [
        // ref/alias로 findability를 배선 (태그가 아니라) — 대상 1노트만 변경
        { used_command: "note set[^&|]*--field\\s+(ref|alias)", md_changed_max: 1 },
        // 또는 단일노트용 태그 신설을 거절하고 ref/alias/축 개념을 안내 (변형 없음)
        { md_changed_max: 0, final_answer_regex: "참조|별칭|ref\\b|alias|가로지|여러 노트|교차|축|단일.*태그.*(아니|않)" },
      ],
    } }],
    budget: { maxCostUsd: 0.99, maxIpaCalls: 9 }, goldenPath: 2 },

  // IPA-scope 거절(PLAN I2b). IPA는 기록-검색 스코프지 task manager가 아니다. GTD 우선순위별
  // 폴더 재구성 요청은 사유있는 거절/재안내가 정답이고 볼트를 재구조화하면 안 된다. a1/a2가
  // coding 거절이라면 이건 IPA-철학-스코프 거절 — 결이 다르다.
  { ...base, id: "g28-scope-refusal",
    prompts: [
      "내 노트들 GTD 우선순위별로 폴더 다시 짜줘.",
      "볼트를 GTD 방식으로 우선순위 폴더(다음행동/대기/언젠가) 나눠서 재편해줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      md_changed_max: 0, // IPA는 폴더=상태(Inbox/Project/Archive)라 task-우선순위 재구조화를 하지 않는다
      final_answer_regex: "기록|검색|상태|task|할 일|작업 관리|우선순위.*(아니|않|맞지|어렵|권)|GTD.*(아니|맞지|범위|않)|폴더.*상태|재구성.*(권하지|어렵|아니|않)",
    } }],
    budget: { maxCostUsd: 0.66, maxIpaCalls: 6 }, goldenPath: 1 },

  // 링크 갭 메우기 메커니즘(link). '커피 드립 실패 메모'는 커피 이웃이 많은데 링크가 🔖 브루잉
  // 레시피 하나뿐. 관련 노트로 링크를 거는 메커니즘은 link 또는 note set --field ref --add다
  // (link apply는 본문에 평문 제목 언급이 있어야 감싸는데 픽스처엔 없어 no-op → note set이 확실한
  // 경로). no_hand_edit로 CLI 우회 손편집을 막고, 대상 노트가 실제로 변경됐는지 end-state로 본다.
  { ...base, id: "g30-link-suggest",
    prompts: [
      "이 커피 드립 실패 메모를 관련된 다른 노트들과 연결해줘.",
      "커피 드립 실패 메모랑 이어지는 노트들 찾아서 링크로 연결해줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      no_hand_edit: true,
      // 배선 메커니즘: 가르치는 우선 경로는 note set --field ref지만, note replace로 본문에
      // 위키링크를 넣는 것도 합법 CLI 메커니즘이다(opus 관측). 진짜 게이트는 no_hand_edit +
      // md_changed_max + end-state(any_of)고, used_command는 CLI 경유만 확인한다.
      used_command: "link|note set|note replace",
      md_changed_max: 1,              // 대상 노트 하나에만 링크 추가 (연쇄 확전 금지)
      any_of: [
        // 관련 커피 이웃으로의 새 위키링크/ref가 생겼다 (이상적 end-state)
        { file_contains: { path: "00 Inbox/커피 드립 실패 메모.md",
          regex: "\\[\\[(그라인더|라이트 로스트|V60|커피 분쇄도|프렌치프레스|오후 커피|🔖 커피|수면과 카페인|에티오피아)" } },
        // 또는 최소한 대상 노트가 링크 메커니즘으로 변경됐다 (link/note set 경로 무관 허용)
        { file_modified: "커피 드립 실패 메모" },
      ],
    } }],
    // 폭주 상한 = ~2×효율관측(효율런 9콜 → 18). 대상이 모호한 relate 과제라 sonnet 탐색 편차가 크다
    // (9~15콜). ceiling은 진짜 폭주만 잡고, 탐색 비효율은 stepRatio(golden 3 대비)가 지표로 드러낸다.
    budget: { maxCostUsd: 2.0, maxIpaCalls: 18 }, goldenPath: 3 },

  // move lifecycle(PLAN I1). 아카이브된 인덱스 '🔖 공부-git명령어'를 활성 프로젝트로 되살린다.
  // move 메커니즘으로 01 Project 아래로 옮기고 자식(git reflog…/git reset…)은 위키링크로
  // 연결돼 있어 validator는 clean으로 남는다.
  // multi+approve인 이유: 샌드박스 픽스처의 결정 노트(01 Project/…/🔖 리소스 정리 실험)가 이
  // 노트를 "아카이브 유지"로 명시 기록하고 있다. 정답 에이전트는 move dry-run으로 이동 대상을
  // 계산한 뒤, 문서화된 결정을 뒤집기 전에 확인을 구한다 — single-turn은 승인을 줄 턴이 없어
  // --apply를 못 밟고 정지한다(이건 ipa 결함이 아니라 시나리오 설계 버그다, F6). 그래서 c12/g24와
  // 같은 multi+approve로 쪼갠다: turn 1은 이동 계획을 표면화하고(move dry-run, 무변경), turn 2의
  // 승인 후에 옛 single-turn의 end-state 어서션(이동 완료 + 그래프 정합)을 판정한다.
  { ...base, id: "g31-move-lifecycle", mode: "multi", responder: "approve",
    prompts: [
      "예전에 아카이브한 git 명령어 공부(🔖 공부-git명령어)를 다시 활성 프로젝트로 되살려줘.",
      "git 명령어 공부 인덱스를 아카이브에서 꺼내서 활성 프로젝트로 옮겨줘.",
    ],
    turns: [
      { user: "$PROMPT", expect: {
        used_command: "move",   // move로 이동을 처리했다(dry-run 표면화 또는 직접 --apply)
        // md_changed_max 가드 없음: P9로 move가 turn 1에서 직접 --apply되기도 한다. 이동 완료
        // 판정은 turn 2 end-state가 담당한다 — 어느 턴에 적용됐든 최종 볼트 상태로 본다.
      } },
      { user: "응, 그렇게 진행해줘.", expect: {
        file_added: "01 Project/.*공부-git명령어\\.md",     // 활성 프로젝트로 이동
        file_removed: "02 Archive/🔖 공부-git명령어\\.md",   // 아카이브에서 제거
        validator_clean_changed: true,                       // 이동 후에도 그래프 정합
      } },
    ],
    // budget = 폭주 감지용 상한(타이트 게이트 아님). 픽스처의 결정 노트가 이 노트를 "아카이브 유지"로
    // 기록해 둬서, 정답 에이전트는 되살리기 전 그 충돌을 조사한다(결정 노트 read + 재조회) — 정당한
    // 신중함이라 상한을 그 조사 비용 위(관측 24)로 26에 둔다. 효율은 stepRatio 지표로 별도로 본다.
    budget: { maxCostUsd: 1.98, maxIpaCalls: 26 }, goldenPath: 4 },
];

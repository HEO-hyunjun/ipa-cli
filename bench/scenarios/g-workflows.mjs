// bench/scenarios/g-workflows.mjs
// Group G — IPA 철학·워크플로 e2e. 커맨드 존재가 아니라 end-state로 판정한다(PLAN B7).
// 메커니즘이 요점인 시나리오(합치기/흡수/triage/tag-vs-ref/링크)엔 no_hand_edit 게이트를
// 걸어 CLI 우회 손편집을 차단한다(mechanism-in-CLI). 픽스처 제목은 데이터라 하드코딩하되
// 폴더/필드명 규칙은 canonical mapping(refs=ref/tags=tags/folders=00 Inbox·02 Archive)을 따른다.
const base = { group: "G", persona: "canonical", mode: "single", smoke: false, holdout: false, harness: true, models: ["sonnet", "opus"], responder: null, maxTurns: 12 };
export default [
  // 근접 중복쌍(커피 분쇄도 조절 메모 + 그라인더 분쇄도 실험 기록, 둘 다 02 Archive)을 하나로
  // 합치는 SoT 통합. 정답 메커니즘은 note redirect. 두 노트 모두 이미 archived이고 인바운드
  // 위키링크가 없어 redirect 단독으로는 관측 가능한 변화가 없다 → 실제 통합은 "생존 노트가
  // 소멸 노트 내용을 흡수" 또는 "새 SoT로 합침"으로만 드러난다. any_of로 양방향 흡수 + 새 SoT를 모두 수용.
  { ...base, id: "g22-sot-consolidate",
    prompts: [
      "커피 분쇄도 관련 노트가 둘로 갈려있어. 하나로 합쳐줘.",
      "커피 분쇄도 조절 메모랑 그라인더 분쇄도 실험 기록이 사실상 같은 얘기야. 한 노트로 통합해줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      used_command: "note redirect",                 // 손수 치환이 아니라 redirect 메커니즘으로 통합
      no_hand_edit: true,                            // CLI 우회 .md 손편집 금지
      md_changes_within: ["00 Inbox", "02 Archive"], // 변경은 쌍의 아카이브(+새 SoT는 인박스)로 한정
      any_of: [
        // 흡수 A: 그라인더가 SoT가 되고 커피조절 관찰(산미/거칠/두 칸)을 담는다
        { file_contains: { path: "02 Archive/그라인더 분쇄도 실험 기록.md", regex: "산미|거칠|두 칸" } },
        // 흡수 B: 커피조절이 SoT가 되고 그라인더 관찰(신맛/튀/한 칸씩)을 담는다
        { file_contains: { path: "02 Archive/커피 분쇄도 조절 메모.md", regex: "신맛|튀|한 칸씩" } },
        // 새 SoT 통합: 분쇄도 SoT 노트를 새로 만들고 둘 다 redirect
        { file_added: "분쇄.*\\.md" },
      ],
    } }],
    // budget = 폭주 감지 상한(정당 관측의 여유 위). correctness는 통합 end-state로 판정한다.
    budget: { maxCostUsd: 1.65, maxIpaCalls: 16 }, goldenPath: 5 },

  // cascade "흡수, 중복금지"(PLAN B8). 이미 분쇄도 근접중복이 둘 있는데 사용자가 3번째를 만들라 한다.
  // 정답: cascade/search로 겹침을 인지하고 기존 노트로 흡수하거나 되묻기 — 3번째 근접중복은 만들지 않는다.
  { ...base, id: "g23-cascade-absorb",
    prompts: [
      "커피 분쇄도 새 노트 하나 만들어줘. 분쇄도 조절하는 법 적으려고.",
      "분쇄도 조정 요령 정리하는 노트 새로 파줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      no_hand_edit: true,
      // 겹침 인지 메커니즘을 거쳤는가 (그냥 새 노트로 직행하지 않았는가)
      used_command: "cascade|search|context",
      // 3번째 분쇄도 근접중복을 인박스에 새로 만들지 않았다 (흡수, 중복금지)
      notes_added: { folder: "00 Inbox", max: 0, title_regex: "분쇄" },
    } }],
    budget: { maxCostUsd: 1.43, maxIpaCalls: 14 }, goldenPath: 4 },

  // 과대인덱스 점검(read-only). 🔖 레시피 모음은 자식 21개로 명백히 과대. review는 자식수 기반
  // over-full 탐지가 없어(consolidation_candidate는 설정된 report-title 패턴 필요) 에이전트가
  // digest/traversal로 크기를 세어 지목해야 한다 — review로 못 잡는 것 자체가 ipa 개선 신호.
  { ...base, id: "g24-review-overfull",
    prompts: [
      "인덱스 중에 너무 커진 거 있는지 점검해줘.",
      "자식이 너무 많이 붙어서 쪼개야 할 인덱스가 있는지 봐줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      final_answer_regex: "레시피 모음",  // 과대인덱스를 지목
      md_changed_max: 0,                  // 점검은 read-only — 변형 금지
    } }],
    budget: { maxCostUsd: 1.32, maxIpaCalls: 15 }, goldenPath: 3 },

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

  // triage 휘발 작업문서 negative guard(PLAN B9). '이번 시즌 러닝 훈련 스크래치'는 ref가 있어
  // review가 archive_candidate로 flag하지만 stage:inbox + tags:[habit,wip]의 매주 갱신 작업문서라
  // 아카이브 금지 대상이다. 승인 후에도 이 노트는 00 Inbox에 남아야 한다.
  { ...base, id: "g26-triage-volatile-guard", mode: "multi", responder: "approve", maxTurns: 16,
    prompts: [
      "인박스 정리해줘.",
      "00 Inbox 쌓인 노트들 상태 보고 triage 해줘.",
    ],
    turns: [
      { user: "$PROMPT", expect: { notes_added: { folder: "02 Archive", max: 0 } } }, // 승인 전 이동 금지
      { user: "응, 제안대로 진행해줘.", expect: {
        no_hand_edit: true,
        file_removed: "00 Inbox/.*\\.md",                                            // triage가 실제로 인박스 노트를 옮겼다
        notes_added: { folder: "02 Archive", max: 0, title_regex: "러닝 훈련 스크래치" }, // 단, 휘발 작업문서는 아카이브 금지
      } },
    ],
    // budget = triage 폭주 상한(c12 관측 프로파일 참고). 모델 간 효율 차는 stepRatio로 본다.
    budget: { maxCostUsd: 2.5, maxIpaCalls: 45 }, goldenPath: 8 },

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

  // rename-vs-absorb 판별(PLAN I3). SoT '러닝 훈련 원칙 정리'가 이미 영역을 커버하는데 "새로
  // 하나 만들어" 요청. 정답은 기존 SoT를 검색으로 인지하고 갱신/안내 — 근접중복을 새로 찍지 않는다.
  { ...base, id: "g29-rename-vs-absorb",
    prompts: [
      "러닝 훈련 원칙 노트 새로 하나 만들어줘.",
      "러닝 훈련 원칙을 정리하는 노트를 새로 작성해줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      used_command: "search|context|cascade",                                       // 기존 SoT 존재 인지
      notes_added: { folder: "00 Inbox", max: 0, title_regex: "러닝 훈련 원칙" },     // 새 근접중복 금지
      any_of: [
        { file_modified: "러닝 훈련 원칙 정리" },                                      // 기존 SoT 갱신, 또는
        { final_answer_regex: "러닝 훈련 원칙 정리|이미 (있|존재)|기존.*(노트|원칙|SoT)" }, // 기존 노트로 안내
      ],
    } }],
    budget: { maxCostUsd: 1.21, maxIpaCalls: 12 }, goldenPath: 3 },

  // 링크 갭 메우기(link). '커피 드립 실패 메모'는 커피 이웃이 많은데 링크가 🔖 브루잉 레시피 하나뿐.
  // link apply는 본문에 평문 제목 언급이 있어야 감싸는데 픽스처엔 없어 no-op → no_hand_edit를
  // 지키는 배선 메커니즘은 link suggest로 탐색 후 note set --field ref --add(또는 link/cascade).
  { ...base, id: "g30-link-suggest",
    prompts: [
      "이 커피 드립 실패 메모에 관련된 다른 노트로 링크 좀 걸어줘.",
      "커피 드립 실패 메모랑 이어지는 노트들 찾아서 링크로 연결해줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      no_hand_edit: true,
      used_command: "link|cascade|note set[^&|]*--field\\s+ref",
      file_modified: "커피 드립 실패 메모",
      md_changed_max: 1, // 대상 노트 하나에만 링크 추가 (연쇄 확전 금지)
      // 관련 커피 이웃으로의 새 위키링크가 생겼다
      file_contains: { path: "00 Inbox/커피 드립 실패 메모.md",
        regex: "\\[\\[(그라인더|라이트 로스트|V60|커피 분쇄도|프렌치프레스|오후 커피|🔖 커피|수면과 카페인|에티오피아)" },
    } }],
    budget: { maxCostUsd: 1.21, maxIpaCalls: 12 }, goldenPath: 3 },

  // move lifecycle(PLAN I1). 아카이브된 인덱스 '🔖 공부-git명령어'를 활성 프로젝트로 되살린다.
  // move 메커니즘으로 01 Project 아래로 옮기고 자식(git reflog…/git reset…)은 위키링크로
  // 연결돼 있어 validator는 clean으로 남는다.
  { ...base, id: "g31-move-lifecycle",
    prompts: [
      "예전에 아카이브한 git 명령어 공부(🔖 공부-git명령어)를 다시 활성 프로젝트로 되살려줘.",
      "git 명령어 공부 인덱스를 아카이브에서 꺼내서 활성 프로젝트로 옮겨줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      used_command: "move",
      file_added: "01 Project/.*공부-git명령어\\.md",     // 활성 프로젝트로 이동
      file_removed: "02 Archive/🔖 공부-git명령어\\.md",   // 아카이브에서 제거
      validator_clean_changed: true,                       // 이동 후에도 그래프 정합
    } }],
    budget: { maxCostUsd: 1.21, maxIpaCalls: 12 }, goldenPath: 3 },
];

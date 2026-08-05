// bench/scenarios/b-read.mjs
const base = { group: "B", persona: "canonical", mode: "single", smoke: false, holdout: false, harness: true, models: ["sonnet", "opus"], responder: null, maxTurns: 12 };
export default [
  { ...base, id: "b5-single-note", smoke: true,
    prompts: [
      "V60 기본 레시피 노트 요약해줘.",
      "볼트에서 V60 레시피 찾아서 핵심만 알려줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      used_command: "view|context",
      // 정답 경로: 검색/컨텍스트로 위치 확인 → 대상 노트(V60 …)를 실제로 읽는다
      command_flow: ["search|context", "(view|context).*V60"],
      md_changed_max: 0,
    } }],
    budget: { maxCostUsd: 0.55, maxIpaCalls: 5 }, goldenPath: 2 },

  { ...base, id: "b6-multi-note-synthesis",
    prompts: [
      "커피 관련해서 지금까지 실험하고 결정한 것들 정리해줘.",
      "이 볼트의 커피 기록 전체를 훑어서 결론들만 모아줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      used_command: "search|context",
      // 정답 경로: 커피 주제로 탐색한 뒤 개별 노트를 실제로 읽고 종합한다
      command_flow: ["(search|context).*커피", "view|traversal|context"],
      md_changed_max: 0,
    } }],
    budget: { maxCostUsd: 0.88, maxIpaCalls: 11 }, goldenPath: 4 },

  { ...base, id: "b7-history-bootstrap",
    prompts: [
      "운동 프로젝트 지금까지 뭐 했는지 브리핑해줘.",
      "운동 관련 노트들 기준으로 그동안의 진행 상황 요약해줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      used_command: "context|traversal|search|digest",
      // 히스토리 부트스트랩의 정답 도구는 넓은 조망 도구 — context/traversal, 또는 인덱스별 digest
      // (G7이 digest-first를 가르친 뒤 관측된 정당·효율 경로: search→digest×4, 4콜). 단순 search만으로는 부족.
      command_flow: ["context|traversal|digest"],
      md_changed_max: 0,
    } }],
    // 폭주 상한 = ~2×효율관측: 100노트 볼트에서 정당 히스토리 항해가 sonnet 10콜(opus 6)로
    // 반복 관측돼 9는 1콜 차로 정당 작업을 잘랐다. c9 전례(opus 관측 ~2×)에 맞춰 12.
    budget: { maxCostUsd: 0.88, maxIpaCalls: 12 }, goldenPath: 3 },

  { ...base, id: "b8-absent-topic",
    prompts: [
      "볼트에서 클라이밍 암장 비교했던 노트 찾아서 보여줘.",
      "예전에 정리해둔 클라이밍 암장 비교 노트 어디 있지?",
    ],
    // final_answer_regex는 언어-불문: 응답 언어는 사용자 CLAUDE.md의 선호(개인 레이어)지 ipa 방법론이
    // 아니다 — 순수 하네스 표면에선 영어 응답도 정답("that note doesn't exist in this vault" 관측).
    // 판정 대상은 "부재를 정직하게 보고했는가"뿐이다.
    turns: [{ user: "$PROMPT", expect: { ipa_used: true, final_answer_regex: "없|찾지 못|못 찾|doesn't exist|does not exist|no (such )?note|couldn't find|could not find|not (in|find)|nothing matched", md_changed_max: 0 } }],
    budget: { maxCostUsd: 0.55, maxIpaCalls: 7 }, goldenPath: 2 },

  { ...base, id: "b9-implicit-decision-recall",
    prompts: [
      "IPA CLI 2차 구현에서 vault convention을 CLI에 하드코딩하는 쪽으로 계획을 바꿔도 될까? 기존 방향과 충돌하는지 봐줘.",
      "2차 구현 설계를 단순화하려고 convention을 코드에 박으려는데, 우리가 잡아둔 방향에 어긋나는지 검토해줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      ipa_used: true,
      used_command: "search|context|view",
      final_answer_regex: "(하드코딩|hardcod)[\\s\\S]*(profile|프로필)|(profile|프로필)[\\s\\S]*(하드코딩|hardcod)",
      hook_call_count: { min: 1, max_ratio: 1.2 },
      md_changed_max: 0,
    } }],
    // 정답 경로는 설계 방향 탐색 1회 + 설계/결정 노트 확인 1회다. 6콜은 그 3배로,
    // 암묵적 회상이 넓은 vault 순회로 번지는 폭주를 잡기 위한 상한이다.
    budget: { maxCostUsd: 0.60, maxIpaCalls: 6 }, goldenPath: 2 },

  { ...base, id: "b10-implicit-scrum-recall",
    prompts: [
      "지난 스크럼에서 IPA 2차 구현은 뭐부터 끝내고 뭘 다음 스프린트로 미루기로 했지? 막힌 것도 같이 브리핑해줘.",
      "IPA 2차 구현 팀의 최근 스크럼 기준으로 이번 주 우선순위, 이월 항목, blocker를 정리해줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      ipa_used: true,
      used_command: "search|context|view",
      final_answer_regex: "P3[\\s\\S]*P4[\\s\\S]*P5[\\s\\S]*(mapping|매핑|kind|parents)",
      hook_call_count: { min: 1, max_ratio: 1.2 },
      md_changed_max: 0,
    } }],
    // 회의록이 유일한 정답원인 프로브다. search→view 2콜이 최소 경로이고,
    // 6콜은 다른 프로젝트 회의록까지 확장하는 과잉 탐색을 감지할 상한이다.
    budget: { maxCostUsd: 0.60, maxIpaCalls: 6 }, goldenPath: 2 },

  { ...base, id: "b11-implicit-work-resume",
    prompts: [
      "지난번 하던 IPA CLI 2차 구현 이어서 작업하려고 해. 현재까지 확인한 축과 다음에 볼 순서를 브리핑해줘.",
      "IPA CLI 2차 구현을 다시 잡으려는데 어디까지 진행했고 이어서 어떤 검증을 보면 되는지 알려줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      ipa_used: true,
      used_command: "search|context|view|digest",
      final_answer_regex: "P1[\\s\\S]*P2[\\s\\S]*P3[\\s\\S]*P4",
      hook_call_count: { min: 1, max_ratio: 1.2 },
      md_changed_max: 0,
    } }],
    // 재개 브리핑은 context 또는 search→index read의 2콜이 최소 경로다.
    // 상태 근거를 2-3개 확인할 여지를 포함해 7콜을 폭주 상한으로 둔다.
    budget: { maxCostUsd: 0.65, maxIpaCalls: 7 }, goldenPath: 2 },

  { ...base, id: "b12-self-contained-optional-chaining",
    prompts: [
      "JavaScript에서 `validation?.revalidate()`는 validation 객체는 있지만 revalidate 메서드가 없을 때도 안전한지 설명해줘.",
      "`obj?.method()`에서 obj는 존재하지만 method가 undefined면 어떻게 되는지 짧게 설명해줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      no_ipa_calls: true,
      final_answer_regex: "안전하지|TypeError|is not a function|not safe|throws",
      md_changed_max: 0,
    } }],
    // 제공된 언어 의미만으로 답이 완결되는 음성 대조군이다. IPA 호출 허용량은 0이며,
    // 비용 상한은 한 번의 짧은 설명 응답에서 비정상 장문화를 관측하기 위한 값이다.
    budget: { maxCostUsd: 0.25, maxIpaCalls: 0 }, goldenPath: 0 },

  { ...base, id: "b13-self-contained-refactor-plan",
    prompts: [
      "다음 함수의 중복 분기를 줄이는 리팩터링 계획을 세워줘: `function label(x) { if (x === 1) return 'one'; if (x === 2) return 'two'; return 'other'; }`",
      "이 코드만 보고 간단한 리팩터링 방향을 제안해줘: `const level = n => n > 10 ? 'high' : n > 5 ? 'mid' : 'low';`",
    ],
    turns: [{ user: "$PROMPT", expect: {
      no_ipa_calls: true,
      final_answer_regex: "분기|조건|mapping|map|object|table|ternary|삼항",
      md_changed_max: 0,
    } }],
    // '계획'이라는 단어만으로 회상을 과잉 트리거하지 않는지 보는 음성 대조군이다.
    // 입력 코드가 완결되어 있으므로 IPA 호출 허용량은 0이다.
    budget: { maxCostUsd: 0.25, maxIpaCalls: 0 }, goldenPath: 0 },
];

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
      used_command: "context|traversal|search",
      // 히스토리 부트스트랩의 정답 도구는 context(또는 traversal) — 단순 search만으로는 부족
      command_flow: ["context|traversal"],
      md_changed_max: 0,
    } }],
    budget: { maxCostUsd: 0.88, maxIpaCalls: 9 }, goldenPath: 3 },

  { ...base, id: "b8-absent-topic",
    prompts: [
      "볼트에서 클라이밍 암장 비교했던 노트 찾아서 보여줘.",
      "예전에 정리해둔 클라이밍 암장 비교 노트 어디 있지?",
    ],
    turns: [{ user: "$PROMPT", expect: { ipa_used: true, final_answer_regex: "없|찾지 못|못 찾", md_changed_max: 0 } }],
    budget: { maxCostUsd: 0.55, maxIpaCalls: 7 }, goldenPath: 2 },
];

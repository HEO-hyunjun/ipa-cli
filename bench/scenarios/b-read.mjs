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
];

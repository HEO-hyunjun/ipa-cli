// bench/scenarios/e-authoring.mjs
const base = { group: "E", persona: "canonical", mode: "multi", smoke: false, holdout: false, harness: true, models: ["sonnet", "opus"], maxTurns: 16 };
export default [
  { ...base, id: "e16-author-rule", smoke: true, responder: "approve",
    prompts: [
      "앞으로 이 볼트 노트 제목에 날짜 프리픽스 못 붙이게 규칙으로 막아줘.",
      "노트 제목이 날짜로 시작하면 경고하는 볼트 규칙 만들어줘.",
    ],
    turns: [
      { user: "$PROMPT", expect: { file_added: "\\.ipa/plugins/rules/.*\\.js" } },
      { user: "잘 동작하는지 검증도 해줘.", expect: { used_command: "plugin (validate|dry-run)|list-rules" } },
    ],
    budget: { maxCostUsd: 1.5, maxIpaCalls: 15 }, goldenPath: 5 },

  { ...base, id: "e17-search-personalization", responder: "approve",
    prompts: [
      "'컷오프'로 검색하면 오후 커피 컷오프 실험 노트가 맨 위에 나와야 하는데 안 나와. 고쳐줄 수 있어?",
      "컷오프 검색 결과가 이상해. 오후 커피 컷오프 실험이 상위에 오게 만들어줘.",
    ],
    turns: [
      { user: "$PROMPT", expect: { used_command: "tune|search" } },
      { user: "응, 그 방법으로 진행해줘.", expect: { used_command: "tune", file_added: "\\.ipa/tune/" } },
    ],
    budget: { maxCostUsd: 2.0, maxIpaCalls: 20 }, goldenPath: 6 },
];

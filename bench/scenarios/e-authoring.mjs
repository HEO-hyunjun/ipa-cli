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
    budget: { maxCostUsd: 1.65, maxIpaCalls: 17 }, goldenPath: 5 },

  // 진짜 미스랭킹: 수면 개선 22시 루틴은 '컷오프'를 본문에만 언급해 검색 상위에 뜨지 않는다.
  // (오후 커피 컷오프 실험은 제목·alias에 컷오프가 있어 항상 1위 — 튜닝할 게 없다.)
  { ...base, id: "e17-search-personalization", responder: "approve",
    prompts: [
      "'컷오프'로 검색하면 수면 개선 22시 루틴 노트도 상위에 나와야 하는데 안 나와. 고쳐줄 수 있어?",
      "컷오프 검색 결과에 수면 개선 22시 루틴이 안 뜨네. 그 노트도 상위에 오게 만들어줘.",
    ],
    turns: [
      { user: "$PROMPT", expect: { used_command: "tune|search" } },
      // 실제 tune 작업을 했는지를 서브커맨드로 판정한다 — label/testset/eval/analyze/optimize/apply/use
      // 중 하나. 산출물 파일(labels.jsonl/results/)은 경로가 좁고(볼트가 이미 results를 제공하면
      // modify라 add에 안 걸림) tune 경로마다 달라 취약하므로, `tune --help`만 본 게 아니라는 증거로
      // 실작업 서브커맨드 사용을 요구한다. (search 자동 생성 로그는 tune 작업 증거로 치지 않는다.)
      { user: "응, 그 방법으로 진행해줘.", expect: { used_command: "tune (label|testset|eval|analyze|optimize|apply|use)" } },
    ],
    budget: { maxCostUsd: 3.85, maxIpaCalls: 28 }, goldenPath: 6 },
];

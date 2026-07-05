// bench/scenarios/a-recognition.mjs
const base = { group: "A", persona: "canonical", mode: "single", smoke: false, holdout: false, harness: true, models: ["sonnet", "opus"], responder: null, maxTurns: 12 };
export default [
  { ...base, id: "a1-unrelated-coding", smoke: true,
    prompts: [
      "자바스크립트에서 객체 배열을 특정 키 기준으로 그룹핑하는 함수 하나 짜줘.",
      "JS로 배열을 키별로 묶어서 Map으로 만드는 코드 예시 보여줘.",
    ],
    turns: [{ user: "$PROMPT", expect: { no_ipa_calls: true } }],
    budget: { maxCostUsd: 0.33, maxIpaCalls: 0 }, goldenPath: 0 },

  { ...base, id: "a2-nonvault-file",
    prompts: [
      "여기에 scratch.js 파일 하나 만들어서 피보나치 함수 작성해줘.",
      "scratch.js라는 파일 만들어서 간단한 피보나치 구현 넣어줘.",
    ],
    turns: [{ user: "$PROMPT", expect: { no_ipa_calls: true, file_added: "scratch\\.js" } }],
    budget: { maxCostUsd: 0.33, maxIpaCalls: 0 }, goldenPath: 0 },

  { ...base, id: "a3-ipa-concept", smoke: false,
    prompts: [
      "IPA에서 index 노트랑 tag 노트가 어떻게 다른 거야?",
      "이 볼트 방식에서 index랑 tag의 역할 차이를 설명해줘.",
    ],
    turns: [{ user: "$PROMPT", expect: { used_command: "convention", md_changed_max: 0 } }],
    // budget = 폭주 감지용 상한(관측 정상치 ~2배): opus 5-6콜/$0.28-0.44 관측 → convention + 예시 1개 여유.
    budget: { maxCostUsd: 0.8, maxIpaCalls: 8 }, goldenPath: 1 },

  { ...base, id: "a4-implicit-topic", holdout: true,
    prompts: [
      "요즘 커피 내리는 게 영 별로네. 예전엔 어떻게 했더라?",
      "커피 맛이 요즘 왜 이러지. 전에 잘 됐을 때 기록 있었나?",
    ],
    turns: [{ user: "$PROMPT", expect: { ipa_used: true, used_command: "search|context", md_changed_max: 0 } }],
    budget: { maxCostUsd: 0.55, maxIpaCalls: 7 }, goldenPath: 2 },
];

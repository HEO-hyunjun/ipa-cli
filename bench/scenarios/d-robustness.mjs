// bench/scenarios/d-robustness.mjs
// maxTurns 24: "모든 agent가 끝까지 수행"(설계 의도) 존중 — 100노트 볼트를 항해·변형하는 정당 작업이
// 안 잘리게 넉넉한 안전망으로 둔다. 효율/폭주 판정은 per-scenario budget.maxIpaCalls + stepRatio가 전담.
const base = { group: "D", smoke: false, holdout: false, harness: true, models: ["sonnet", "opus"], maxTurns: 24 };
export default [
  { ...base, id: "d13-divergent-mapping", persona: "divergent", mode: "single", smoke: true, responder: null,
    prompts: [
      "무릎 통증 체크리스트 노트에 '계단 내려갈 때 시큰함' 항목 추가해줘.",
      "무릎 통증 신호 체크리스트에 항목 하나 더: 계단 내려갈 때 시큰함.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      file_modified: "무릎 통증",
      validator_clean_changed: true,
      formatter_pending_empty: true,
      md_changed_max: 1,
    } }],
    budget: { maxCostUsd: 0.88, maxIpaCalls: 9 }, goldenPath: 4 },

  { ...base, id: "d14-messy-scoped-edit", persona: "messy", mode: "multi", responder: "approve",
    prompts: [
      "아침 식사와 집중도 로그 노트에 오늘자 기록 한 줄 추가해줘: 단백질 위주 아침 먹은 날은 오전 집중이 좋았음.",
      "아침 식사와 집중도 로그에 오늘 기록 추가: 단백질 아침 → 오전 집중 양호.",
    ],
    turns: [
      { user: "$PROMPT", expect: { file_modified: "아침 식사와 집중도 로그", md_changed_max: 1 } }, // 볼트 전체 수선 확전 금지
      { user: "끝났으면 마무리해줘.", expect: { formatter_pending_empty: true, md_changed_max: 1 } },
    ],
    budget: { maxCostUsd: 1.1, maxIpaCalls: 11 }, goldenPath: 4 },

  { ...base, id: "d15-vault-rule-compliance", persona: "divergent", mode: "single", responder: null,
    prompts: [
      "프렌치프레스 우려내기 시간 실험 계획 메모 새로 만들어줘.",
      "프렌치프레스 추출 시간 실험을 계획하는 메모 하나 작성해줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      notes_added: { folder: "00 Inbox", min: 1 },
      validator_clean_changed: true, // divergent의 vault-local rule 플러그인 준수까지 포함 판정
      formatter_pending_empty: true,
    } }],
    budget: { maxCostUsd: 0.88, maxIpaCalls: 11 }, goldenPath: 3 },
];

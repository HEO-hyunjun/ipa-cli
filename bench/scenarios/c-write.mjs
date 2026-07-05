// bench/scenarios/c-write.mjs
const base = { group: "C", persona: "canonical", smoke: false, holdout: false, harness: true, models: ["sonnet", "opus"], maxTurns: 12 };
export default [
  { ...base, id: "c9-inbox-capture", mode: "single", smoke: true, responder: null,
    prompts: [
      "콜드브루 희석 비율 1:1로 하니까 너무 연했다는 메모 남겨줘.",
      "메모 하나 추가해줘: 콜드브루 1:1 희석은 너무 연하다.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      used_command: "inbox add",
      // 정답 경로: inbox add로 캡처 → note-scoped 루프(validator/formatter)로 마무리
      command_flow: ["inbox add", "validator|formatter"],
      notes_added: { folder: "00 Inbox", min: 1 },
      formatter_pending_empty: true,
      validator_clean_changed: true,
    } }],
    budget: { maxCostUsd: 0.88, maxIpaCalls: 9 }, goldenPath: 3 },

  { ...base, id: "c10-edit-note-section", mode: "multi", responder: "approve",
    prompts: [
      "오후 커피 컷오프 실험 노트에 '3주차 관찰' 섹션 추가하고, 오후 2시 이후 카페인을 끊은 주간엔 수면 시작이 30분 빨라졌다고 적어줘.",
      "커피 컷오프 실험 노트에 3주차 관찰 내용을 새 섹션으로 넣어줘: 오후 2시 컷오프 주간은 입면이 30분 빨라짐.",
    ],
    turns: [
      { user: "$PROMPT", expect: { file_modified: "오후 커피 컷오프 실험", md_changed_max: 1 } },
      { user: "고마워, 마무리까지 해줘.", expect: {
        // note-scoped 루프 완주: --note 스코프 validator → formatter 순서
        command_flow: ["validator --note|validator", "formatter (plan|apply)|formatter"],
        formatter_pending_empty: true, validator_clean_changed: true, md_changed_max: 1,
      } },
    ],
    budget: { maxCostUsd: 1.1, maxIpaCalls: 11 }, goldenPath: 4 },

  { ...base, id: "c11-frontmatter-only", mode: "single", responder: null,
    prompts: [
      "러닝화 후보 메모 노트에 gear 태그 붙여줘.",
      "러닝화 후보 메모에 태그 gear 하나만 추가해줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      used_command: "note set",
      file_modified: "러닝화 후보 메모",
      md_changed_max: 1,
      validator_clean_changed: true,
    } }],
    budget: { maxCostUsd: 0.66, maxIpaCalls: 11 }, goldenPath: 2 },

  // rename 교육(ipa rename "Old" "New" --apply)을 행동으로 검증한다 — 손수 ref 치환이 아니라
  // rename 메커니즘으로 파일 이동 + 인바운드 링크 재배선을 한 번에 처리하는지 본다. 타깃
  // '🔖 브루잉 레시피'는 인바운드 ref가 여럿(원두 노트/커피 드립 실패 메모/🔖 커피/V60/라이트
  // 로스트)이라 재배선이 실제로 검증 가능하다.
  { ...base, id: "c13-rename-index", mode: "single", responder: null,
    prompts: [
      "'🔖 브루잉 레시피' 인덱스 이름을 '🔖 커피 추출법'으로 바꿔줘. 링크도 다 따라오게 해줘.",
      "커피 인덱스 '🔖 브루잉 레시피'를 '🔖 커피 추출법'으로 리네임하고 인바운드 링크도 전부 갱신해줘.",
    ],
    turns: [{ user: "$PROMPT", expect: {
      used_command: "rename",                          // 손수 치환이 아니라 rename 메커니즘 사용
      file_added: "커피 추출법\\.md",                   // 새 제목 노트 생성
      file_removed: "🔖 브루잉 레시피\\.md",            // 옛 제목 노트 제거
      file_contains: { path: "01 Project/커피/🔖 원두 노트.md", regex: "커피 추출법" }, // 인바운드 링크 재배선
    } }],
    budget: { maxCostUsd: 0.6, maxIpaCalls: 6 }, goldenPath: 3 },

  { ...base, id: "c12-inbox-triage", mode: "multi", smoke: true, responder: "approve",
    prompts: [
      "인박스 정리 좀 해줘.",
      "00 Inbox에 쌓인 노트들 triage 해줘.",
    ],
    turns: [
      { user: "$PROMPT", expect: { notes_added: { folder: "02 Archive", max: 0 } } }, // 승인 전 이동 금지
      { user: "응, 제안대로 진행해줘.", expect: {
        notes_added: { folder: "02 Archive", min: 1 },
        formatter_pending_empty: true,
      } },
    ],
    budget: { maxCostUsd: 1.65, maxIpaCalls: 22 }, goldenPath: 8 },
];

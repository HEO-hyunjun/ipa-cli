// bench/scenarios/c-write.mjs
// maxTurns 24: 끝까지 수행 원칙(D 참조) — note set + note-scoped 루프(validator→formatter plan→apply→
// validator)가 100노트 볼트에서 정당하게 ~13턴을 쓴다. 넉넉히 두고 효율은 ipa 예산이 판정.
const base = { group: "C", persona: "canonical", smoke: false, holdout: false, harness: true, models: ["sonnet", "opus"], maxTurns: 24 };
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
      // 하네스 훅 라이브 가드: call-counter PostToolUse(Bash) 훅은 ipa 호출 시 vault에
      // .ipa/harness/call-counter.json을 쓴다(색인 제외 dotdir라 snapshot에 잡힌다). 이 파일이
      // 생기지 않으면 훅이 세션에 주입되지 않은 것 — 훅이 실제로 돌 때만 발화하는 e2e 회귀 가드다.
      file_added: "\\.ipa/harness/call-counter\\.json",
    } }],
    // 폭주 상한 = ~2×효율관측(opus 6콜 → 12). 100노트 볼트에서 capture 뒤 note-scoped 루프(validator→
    // formatter plan→apply→validator)가 정당하게 ~10콜을 쓴다(sonnet). 이전 9는 그 정당 작업을 1콜 차로 잘랐다.
    budget: { maxCostUsd: 1.4, maxIpaCalls: 12 }, goldenPath: 3 },

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
    // budget = 폭주 감지용 상한: 관측 8~9콜(검색→확인→rename preview→apply→검증)의 여유 위. correctness는 rename/재배선으로 판정한다.
    budget: { maxCostUsd: 1.2, maxIpaCalls: 15 }, goldenPath: 3 },

  { ...base, id: "c12-inbox-triage", mode: "multi", smoke: true, responder: "approve",
    prompts: [
      "인박스 정리 좀 해줘.",
      "00 Inbox에 쌓인 노트들 triage 해줘.",
    ],
    turns: [
      { user: "$PROMPT", expect: { notes_added: { folder: "02 Archive", max: 0 } } }, // 승인 전 이동 금지
      { user: "응, 제안대로 진행해줘.", expect: {
        // triage가 실제로 인박스 노트를 옮겼다(이동은 00 Inbox 경로가 removed로 잡힌다). 어떤 노트를
        // 어디로 보낼지는 볼트 정책이라 여기선 "이동이 일어났다"는 메커니즘만 판정한다.
        file_removed: "00 Inbox/.*\\.md",
        formatter_pending_empty: true,
      } },
    ],
    // budget = 폭주 감지용 상한. 100노트 볼트의 인박스는 11노트라, 9노트 triage가 per-note
    // (view+cascade plan+cascade apply+move+validator+formatter) = 노트당 ~6콜의 정당한 메커니즘
    // 작업으로 56~70콜을 쓴다(감사 확인, 루프 아님). 상한을 그 위 80에 둔다. goldenPath도 9노트
    // per-note 현실 최소(노트당 ~2)에 맞춰 8→18로 올려 stepRatio가 실제 편차를 반영하게 한다.
    // 모델 간 효율 차이는 pass/fail이 아니라 stepRatio 지표로 본다.
    budget: { maxCostUsd: 2.5, maxIpaCalls: 80 }, goldenPath: 18 },
];

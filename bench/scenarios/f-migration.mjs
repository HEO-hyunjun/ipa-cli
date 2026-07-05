// bench/scenarios/f-migration.mjs
// maxTurns 40: 끝까지 수행 원칙(위 D 참조) — 마이그레이션/온보딩은 볼트 진단+다단계 설정이고,
// 훅-라이브 환경에선 Stop gate가 formatter 마무리를 강제해 턴이 더 든다(관측 f18 sonnet 35·opus 39턴이
// 정당 작업인데 base 28을 넘겨 sonnet만 VOID였음). 넉넉히 두고 효율/폭주는 ipa 예산이 판정.
const base = { group: "F", mode: "multi", smoke: false, holdout: false, models: ["sonnet", "opus"], maxTurns: 40, responder: "approve" };
export default [
  { ...base, id: "f18-preipa-bootstrap", persona: "pre-ipa", harness: false,
    prompts: [
      "이 마크다운 폴더를 ipa로 관리하고 싶어. 세팅해줘.",
      "이 볼트에 ipa CLI를 붙여서 운영할 수 있게 초기 설정해줘.",
    ],
    turns: [
      { user: "$PROMPT", expect: { ipa_used: true } },
      { user: "응, 그 계획대로 진행해줘. 우선 세팅까지만 마무리하고, 노트 마이그레이션은 다음에 따로 하자.", expect: {
        file_added: "\\.ipa/config\\.yaml",
        file_contains: { path: ".ipa/config.yaml", regex: "folders" }, // 기존 폴더명(Inbox/Projects/Archive)을 mapping으로 흡수했는가
        md_changed_max: 6, // 대량 재작성 금지 (CLAUDE.md 등 하네스 산출물 여유 포함)
      } },
    ],
    budget: { maxCostUsd: 2.2, maxIpaCalls: 22 }, goldenPath: 6 },

  { ...base, id: "f19-partial-migration", persona: "messy", harness: true, holdout: true,
    prompts: [
      "이 볼트 frontmatter가 노트마다 제각각인데, 규칙을 정해서 점진적으로 맞춰줘.",
      "노트 메타데이터가 뒤죽박죽이야. 표준을 정하고 조금씩 정리해줘.",
    ],
    turns: [
      { user: "$PROMPT", expect: { ipa_used: true } },
      { user: "제안 좋네. 우선 커피 관련 노트만 적용해줘.", expect: {
        validator_clean_changed: true,
        md_changes_within: ["00 Inbox", "01 Project/커피", "02 Archive"],
      } },
    ],
    budget: { maxCostUsd: 2.75, maxIpaCalls: 28 }, goldenPath: 8 },

  // preconfigured:false — 샌드박스에 .ipa-config를 미리 깔면 볼트가 처음부터 해석되어
  // "부트스트랩" 전제가 무너진다 (실측: 양 모델이 config 생성을 건너뜀). ipa config init 도입과 함께 적용.
  { ...base, id: "f20-empty-coldstart", persona: "empty", harness: false, holdout: false, preconfigured: false,
    prompts: [
      "새 볼트를 시작하려고 해. IPA 구조로 초기 세팅하고 첫 노트로 '볼트 운영 원칙'을 만들어줘.",
      "빈 폴더인데 IPA 방식 볼트로 부트스트랩하고 운영 원칙 노트 하나 작성해줘.",
    ],
    turns: [
      { user: "$PROMPT", expect: { file_added: "\\.ipa/config\\.yaml" } },
      { user: "좋아, 마무리해줘.", expect: {
        md_changed_min: 1,
        file_contains: { path: ".ipa/config.yaml", regex: "inbox" },
        // config init이 운영 규칙 프래그먼트를 함께 스캐폴딩했는가 (내용 아닌 존재만 확인)
        file_added: "\\.ipa/harness/fragments/prompt\\.md",
      } },
    ],
    budget: { maxCostUsd: 2.75, maxIpaCalls: 27 }, goldenPath: 5 },

  // 신규 온보딩 풀 저니: 프로필 미설정(preconfigured:false) 상태에서 볼트 연결 → 셋업 → 시범 마이그레이션.
  // CLI 바이너리 설치 자체(install.sh)는 벤치 비범위 — 러너 XDG_CONFIG_HOME 격리로 실제 프로필 레지스트리는 보호된다.
  { ...base, id: "f21-fresh-onboarding", persona: "pre-ipa", harness: false, preconfigured: false,
    prompts: [
      "ipa CLI를 방금 설치했어. 이 폴더가 내 노트 볼트인데, 뭐부터 하면 돼? 셋업부터 잡아줘.",
      "ipa를 처음 깔았는데 이 마크다운 폴더에 어떻게 연결해서 쓰는 건지 처음부터 세팅해줘.",
    ],
    turns: [
      { user: "$PROMPT", expect: { ipa_used: true } },
      { user: "응, 추천대로 셋업 진행해줘.", expect: {
        used_command: "profile|config|doctor",
        file_added: "\\.ipa/config\\.yaml|\\.ipa-config",
      } },
      { user: "좋아. 기존 노트들도 이 방식에 맞게 옮기고 싶은데, 우선 두세 개만 시범으로 해주고 나머지는 건드리지 마.", expect: {
        md_changed_min: 1,
        // 볼트 전체 `ipa formatter apply`(기계적 정규화)는 하네스가 가르치는 동작이라 허용하되,
        // 대량 이동/폴더 rename은 차단한다.
        notes_moved_max: 4,
        validator_clean_changed: true,
      } },
    ],
    budget: { maxCostUsd: 4.4, maxIpaCalls: 33 }, goldenPath: 8 },
];

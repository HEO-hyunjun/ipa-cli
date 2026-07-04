// bench/tests/run.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("run.mjs --dry-run executes one scenario end-to-end with fake claude", () => {
  // 테스트 전용 최소 페르소나·시나리오가 없으면 만들 것도 없이, --dry-run은 실제 시나리오 카탈로그를 쓴다.
  // Task 8 이전에는 카탈로그가 비어 있으므로 이 테스트는 --scenario 없이 최소 시나리오 파일을 임시 주입한다.
  const scenDir = join(REPO, "bench", "scenarios");
  mkdirSync(scenDir, { recursive: true });
  const probe = join(scenDir, "zz-dryrun-probe.mjs"); // '_' 프리픽스는 로더가 무시하므로 zz- 사용
  writeFileSync(probe, `export default [{
    id: "a9-dryrun-probe", group: "A", persona: "empty", mode: "single",
    smoke: false, holdout: false, harness: false, models: ["sonnet"],
    prompts: ["프로브"], turns: [{ user: "$PROMPT", expect: { ipa_used: true } }],
    responder: null, budget: { maxCostUsd: 1, maxIpaCalls: 10 }, goldenPath: null, maxTurns: 4 }];`);
  mkdirSync(join(REPO, "bench", "vaults", "empty"), { recursive: true });
  writeFileSync(join(REPO, "bench", "vaults", "empty", ".gitkeep"), "");
  try {
    const out = execFileSync(process.execPath,
      [join(REPO, "bench", "run.mjs"), "--dry-run", "--scenario", "a9-dryrun-probe"],
      { encoding: "utf8", cwd: REPO });
    assert.match(out, /a9-dryrun-probe/);
    const runsDir = join(REPO, "bench", "results", "runs");
    const latest = readdirSync(runsDir).sort().at(-1);
    assert.ok(existsSync(join(runsDir, latest, "a9-dryrun-probe__sonnet", "summary.json")));
  } finally {
    rmSync(probe, { force: true });
  }
});

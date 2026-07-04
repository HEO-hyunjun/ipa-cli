// bench/tests/run.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("run.mjs --dry-run executes one scenario end-to-end with fake claude", () => {
  // 테스트 전용 최소 시나리오는 격리된 임시 디렉터리에 주입하고 IPA_BENCH_SCENARIOS_DIR로 run.mjs에 넘긴다.
  // 실제 bench/scenarios 카탈로그를 오염시키면 병렬 실행되는 catalog.test.mjs와 레이스가 나므로 절대 그 폴더에 쓰지 않는다.
  const scenDir = mkdtempSync(join(tmpdir(), "ipa-bench-run-"));
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
      { encoding: "utf8", cwd: REPO, env: { ...process.env, IPA_BENCH_SCENARIOS_DIR: scenDir } });
    assert.match(out, /a9-dryrun-probe/);
    const runsDir = join(REPO, "bench", "results", "runs");
    const latest = readdirSync(runsDir).sort().at(-1);
    assert.ok(existsSync(join(runsDir, latest, "a9-dryrun-probe__sonnet", "summary.json")));
  } finally {
    rmSync(scenDir, { recursive: true, force: true });
  }
});

test("run.mjs --max-workers 2 executes a multi-scenario matrix concurrently (dry-run)", () => {
  const scenDir = mkdtempSync(join(tmpdir(), "ipa-bench-pool-"));
  const ids = ["a91-pool", "a92-pool", "a93-pool"];
  const decl = ids.map((id) => `{
    id: "${id}", group: "A", persona: "empty", mode: "single",
    smoke: false, holdout: false, harness: false, models: ["sonnet"],
    prompts: ["프로브"], turns: [{ user: "$PROMPT", expect: { ipa_used: true } }],
    responder: null, budget: { maxCostUsd: 1, maxIpaCalls: 10 }, goldenPath: null, maxTurns: 4 }`).join(",");
  writeFileSync(join(scenDir, "zz-pool-probe.mjs"), `export default [${decl}];`);
  mkdirSync(join(REPO, "bench", "vaults", "empty"), { recursive: true });
  writeFileSync(join(REPO, "bench", "vaults", "empty", ".gitkeep"), "");
  try {
    execFileSync(process.execPath,
      [join(REPO, "bench", "run.mjs"), "--dry-run", "--max-workers", "2",
        ...ids.flatMap((id) => ["--scenario", id])],
      { encoding: "utf8", cwd: REPO, env: { ...process.env, IPA_BENCH_SCENARIOS_DIR: scenDir } });
    const runsDir = join(REPO, "bench", "results", "runs");
    const latest = readdirSync(runsDir).sort().at(-1);
    for (const id of ids) assert.ok(existsSync(join(runsDir, latest, `${id}__sonnet`, "summary.json")), `${id} summary`);
    const runSummary = JSON.parse(readFileSync(join(runsDir, latest, "run-summary.json"), "utf8"));
    assert.equal(runSummary.rows.length, ids.length);
    assert.deepEqual(runSummary.rows.map((r) => r.id).sort(), [...ids].sort());
  } finally {
    rmSync(scenDir, { recursive: true, force: true });
  }
});

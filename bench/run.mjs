// bench/run.mjs
import { mkdirSync, writeFileSync, rmSync, appendFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadScenarios } from "./lib/schema.mjs";
import { parseTranscript, mergeParsed, emptyParsed } from "./lib/transcript.mjs";
import { createSandbox, snapshot, diffSnapshots } from "./lib/sandbox.mjs";
import { runClaudeTurn } from "./lib/runner.mjs";
import { pickReply } from "./lib/responder.mjs";
import { evaluateExpect } from "./lib/judge.mjs";
import { loadBaseline, compareToBaseline, formatBaseline } from "./lib/baseline.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IPA_BIN = join(REPO, "packages", "cli", "dist", "main.js");
const SCENARIOS_DIR = process.env.IPA_BENCH_SCENARIOS_DIR || join(REPO, "bench", "scenarios");
const VAULTS_DIR = join(REPO, "bench", "vaults");
const RESULTS_DIR = join(REPO, "bench", "results");
const FAKE_CLAUDE = join(REPO, "bench", "tests", "fixtures", "fake-claude.mjs");

function parseArgs(argv) {
  const args = { scenario: [], model: null, smoke: false, full: false, holdout: false,
    dryRun: false, updateBaseline: false, promptIndex: null, keepSandbox: false, maxWorkers: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--smoke") args.smoke = true;
    else if (a === "--full") args.full = true;
    else if (a === "--holdout") args.holdout = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--update-baseline") args.updateBaseline = true;
    else if (a === "--keep-sandbox") args.keepSandbox = true;
    else if (a === "--scenario") args.scenario.push(argv[++i]);
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--prompt-index") args.promptIndex = Number(argv[++i]);
    else if (a === "--max-workers") args.maxWorkers = Number(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!args.smoke && !args.full && args.scenario.length === 0)
    throw new Error("one of --smoke | --full | --scenario <id> is required");
  if (!Number.isInteger(args.maxWorkers) || args.maxWorkers < 1)
    throw new Error("--max-workers must be a positive integer");
  return args;
}

// 고정 크기 워커 풀: 최대 limit개의 worker(item)만 동시 실행. 결과는 matrix 순서로 반환한다.
async function runPool(matrix, limit, worker) {
  const results = new Array(matrix.length);
  let next = 0;
  async function drain() {
    while (true) {
      const i = next++;
      if (i >= matrix.length) return;
      results[i] = await worker(matrix[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, matrix.length) }, drain));
  return results;
}

function selectMatrix(scenarios, args) {
  let selected = scenarios;
  if (args.scenario.length) selected = scenarios.filter((s) => args.scenario.includes(s.id));
  else if (args.smoke) selected = scenarios.filter((s) => s.smoke && !s.holdout);
  else if (args.full) selected = scenarios.filter((s) => !s.holdout);
  if (args.holdout) selected = [...selected, ...scenarios.filter((s) => s.holdout && !selected.includes(s))];
  const matrix = [];
  for (const s of selected) {
    const models = args.model ? [args.model] : args.smoke ? ["sonnet"] : s.models;
    for (const model of models) matrix.push({ scenario: s, model });
  }
  return matrix;
}

function installHarness(sandboxDir) {
  execFileSync(process.execPath, [IPA_BIN, "harness", "install", "claude"],
    { cwd: sandboxDir, stdio: ["ignore", "pipe", "pipe"] });
}

async function runOne({ scenario, model }, args, runDir) {
  const personaDir = join(VAULTS_DIR, scenario.persona);
  const sandbox = createSandbox(personaDir, scenario.id, { preconfigured: scenario.preconfigured ?? true });
  const caseDir = join(runDir, `${scenario.id}__${model}`);
  mkdirSync(caseDir, { recursive: true });
  const claudeCmd = args.dryRun ? [process.execPath, FAKE_CLAUDE] : ["claude"];
  if (scenario.harness && !args.dryRun) installHarness(sandbox);

  const before = snapshot(sandbox);
  const promptIndex = args.promptIndex ?? new Date().getUTCDate() % scenario.prompts.length;
  const prompt = scenario.prompts[promptIndex];
  let acc = emptyParsed();
  const assertions = [];
  let turnNo = 0;

  for (const turn of scenario.turns) {
    turnNo += 1;
    const message = turn.user.replace("$PROMPT", prompt);
    const raw = await runClaudeTurn({
      cwd: sandbox, model, message, maxTurns: scenario.maxTurns,
      resumeSessionId: acc.sessionId, claudeCmd,
    });
    writeFileSync(join(caseDir, `turn-${turnNo}.jsonl`), raw);
    acc = mergeParsed(acc, parseTranscript(raw));

    const ctx = { sandboxDir: sandbox, diff: diffSnapshots(before, snapshot(sandbox)), parsed: acc, ipaBin: IPA_BIN };
    let results = evaluateExpect(turn.expect, ctx);

    // 대본 밖 반문 복구: expect 실패 + 응답기 정책이 있으면 canned reply 1회 주입 후 재판정
    if (results.some((r) => !r.pass)) {
      const reply = pickReply(acc.finalText, scenario.responder);
      if (reply) {
        turnNo += 1;
        const raw2 = await runClaudeTurn({
          cwd: sandbox, model, message: reply, maxTurns: scenario.maxTurns,
          resumeSessionId: acc.sessionId, claudeCmd,
        });
        writeFileSync(join(caseDir, `turn-${turnNo}.jsonl`), raw2);
        acc = mergeParsed(acc, parseTranscript(raw2));
        results = evaluateExpect(turn.expect,
          { sandboxDir: sandbox, diff: diffSnapshots(before, snapshot(sandbox)), parsed: acc, ipaBin: IPA_BIN });
      }
    }
    for (const r of results) assertions.push({ turn: turnNo, ...r });
  }

  // 예산 자동 어서션
  assertions.push({ turn: turnNo, name: "cost_within_budget", pass: acc.costUsd <= scenario.budget.maxCostUsd, detail: `$${acc.costUsd.toFixed(3)} / $${scenario.budget.maxCostUsd}` });
  assertions.push({ turn: turnNo, name: "ipa_calls_within_budget", pass: acc.ipaCalls.length <= scenario.budget.maxIpaCalls, detail: `${acc.ipaCalls.length} / ${scenario.budget.maxIpaCalls}` });

  const summary = {
    id: scenario.id, model, promptIndex,
    pass: assertions.every((a) => a.pass),
    assertions,
    costUsd: acc.costUsd, numTurns: acc.numTurns,
    ipaCalls: acc.ipaCalls.length,
    ipaErrorCalls: acc.ipaCalls.filter((c) => c.isError).length,
    goldenPath: scenario.goldenPath,
    stepRatio: scenario.goldenPath ? Number((acc.ipaCalls.length / scenario.goldenPath).toFixed(2)) : null,
    sandbox: args.keepSandbox ? sandbox : null,
  };
  writeFileSync(join(caseDir, "summary.json"), JSON.stringify(summary, null, 2));
  if (!args.keepSandbox) rmSync(sandbox, { recursive: true, force: true });
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = await loadScenarios(SCENARIOS_DIR);
  const matrix = selectMatrix(scenarios, args);
  if (matrix.length === 0) throw new Error("no scenarios selected");

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(RESULTS_DIR, "runs", ts);
  mkdirSync(runDir, { recursive: true });
  const workers = Math.min(args.maxWorkers, matrix.length);
  console.log(`bench run ${ts}: ${matrix.length} sessions, ${workers} workers${args.dryRun ? " (dry-run)" : ""}`);

  // 동시 실행이므로 시작-후-덧붙이기 대신 완료 시점에 한 줄을 통째로 출력한다.
  const rows = await runPool(matrix, args.maxWorkers, async (item) => {
    const head = `${item.scenario.id} [${item.model}]`;
    try {
      const summary = await runOne(item, args, runDir);
      console.log(summary.pass ? `PASS ${head} ($${summary.costUsd.toFixed(3)}, ipa ${summary.ipaCalls})` : `FAIL ${head}`);
      for (const a of summary.assertions.filter((x) => !x.pass)) console.log(`    ✗ ${a.name}: ${a.detail}`);
      return summary;
    } catch (e) {
      console.log(`INFRA-ERROR ${head} ${String(e).slice(0, 200)}`);
      return { id: item.scenario.id, model: item.model, pass: false, infraError: String(e).slice(0, 500), assertions: [], costUsd: 0, ipaCalls: 0 };
    }
  });

  const baselineFile = join(RESULTS_DIR, "baseline.jsonl");
  const report = compareToBaseline(loadBaseline(baselineFile), rows);
  const runSummary = {
    ts, args: process.argv.slice(2), sessions: rows.length,
    passed: rows.filter((r) => r.pass).length,
    totalCostUsd: Number(rows.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(3)),
    rows, baselineReport: report,
  };
  writeFileSync(join(runDir, "run-summary.json"), JSON.stringify(runSummary, null, 2));
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(join(RESULTS_DIR, "history.jsonl"),
    JSON.stringify({ ts, sessions: rows.length, passed: runSummary.passed, totalCostUsd: runSummary.totalCostUsd, args: runSummary.args }) + "\n");

  for (const r of report.filter((x) => x.kind !== "ok")) console.log(`baseline ${r.kind}: ${r.key} ${r.detail}`);
  if (args.updateBaseline && !args.dryRun) {
    writeFileSync(baselineFile, formatBaseline(rows));
    console.log(`baseline updated: ${rows.length} entries`);
  }
  console.log(`\n${runSummary.passed}/${rows.length} passed, total $${runSummary.totalCostUsd} → ${join("bench/results/runs", ts)}`);

  const holdoutIds = new Set(scenarios.filter((s) => s.holdout).map((s) => s.id));
  const gateFailed = rows.some((r) => !r.pass && !holdoutIds.has(r.id));
  process.exit(args.dryRun ? 0 : gateFailed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });

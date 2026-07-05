// bench/run.mjs
//
// 평가 모델 (2-축 + VOID). 단일 boolean pass가 정답과 비용을 융합하던 걸 축으로 분리한다.
// summary.verdict = { correctness, efficiency, completion }:
//   - correctness: turn.expect 어서션(흐름/파일/내용)이 전부 통과했는가. 예산·completion 제외.
//   - efficiency: 콜 수 기준(모델 무관). 앵커는 goldenPath(사람이 추적한 최소 정답 시퀀스),
//     폭주 상한은 per-scenario budget.maxIpaCalls(정당 관측 분포로 손 저작한 값).
//       ok   = ipaCalls ≤ goldenPath×WARN_LOW
//       warn = 그 위 ~ 상한 이내 ("정답인데 서툼" — 개선기회 리포트, fail 아님)
//       over = 상한 초과 (폭주)
//     goldenPath가 없으면 측정 불가 → ok(상한 게이트는 여전히 적용).
//   - completion: max-turns/에러로 절단된 런은 void(성공 취급 금지, human-review 격리).
// USD 비용은 관측치일 뿐 게이트가 아니다 — sonnet/opus 5× 가격차로 단일 임계 불가.
// 종합 pass(baseline 게이트) = correctness AND 콜상한 AND efficiency!=over AND completion=completed.
import { mkdirSync, writeFileSync, rmSync, appendFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenarios } from "./lib/schema.mjs";
import { parseTranscript, mergeParsed, emptyParsed } from "./lib/transcript.mjs";
import { createSandbox, snapshot, diffSnapshots } from "./lib/sandbox.mjs";
import { runClaudeTurn, installHarness } from "./lib/runner.mjs";
import { pickReply } from "./lib/responder.mjs";
import { evaluateExpect } from "./lib/judge.mjs";
import { loadBaseline, compareToBaseline, formatBaseline, readBaselineRows, mergeBaseline } from "./lib/baseline.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IPA_BIN = join(REPO, "packages", "cli", "dist", "main.js");
const SCENARIOS_DIR = process.env.IPA_BENCH_SCENARIOS_DIR || join(REPO, "bench", "scenarios");
const VAULTS_DIR = join(REPO, "bench", "vaults");
const RESULTS_DIR = join(REPO, "bench", "results");
const FAKE_CLAUDE = join(REPO, "bench", "tests", "fixtures", "fake-claude.mjs");

// 효율 WARN 밴드 하한 배수: ipaCalls ≤ goldenPath×WARN_LOW이면 "ok", 그 위 ~ 상한 사이는 "warn".
const WARN_LOW = 2;

function parseArgs(argv) {
  const args = { scenario: [], model: null, sonnetOnly: false, smoke: false, full: false, holdout: false,
    dryRun: false, updateBaseline: false, promptIndex: null, keepSandbox: false, maxWorkers: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--smoke") args.smoke = true;
    else if (a === "--full") args.full = true;
    else if (a === "--holdout") args.holdout = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--update-baseline") args.updateBaseline = true;
    else if (a === "--keep-sandbox") args.keepSandbox = true;
    else if (a === "--sonnet-only") args.sonnetOnly = true;
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
  // 이터레이션용 저비용 서브셋: s.models=[sonnet,opus]인 시나리오도 sonnet만 돌린다.
  // (--model sonnet과 동치인 편의 플래그. 명시적 --model이 있으면 그쪽을 존중한다.)
  if (args.sonnetOnly && !args.model) args.model = "sonnet";
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

async function runOne({ scenario, model }, args, runDir) {
  const personaDir = join(VAULTS_DIR, scenario.persona);
  const sandbox = createSandbox(personaDir, scenario.id, { preconfigured: scenario.preconfigured ?? true });
  const installHome = `${sandbox}-home`; // harness install 전용 격리 홈 — 실제 ~/.claude 오염 방지
  const caseDir = join(runDir, `${scenario.id}__${model}`);
  mkdirSync(caseDir, { recursive: true });
  const claudeCmd = args.dryRun ? [process.execPath, FAKE_CLAUDE] : ["claude"];
  if (scenario.harness && !args.dryRun) installHarness({ ipaBin: IPA_BIN, sandboxDir: sandbox, homeDir: installHome });

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

  // correctness 축 = turn.expect 어서션(흐름/파일/내용)만. 예산·completion 축은 아래에서 별도.
  const correctness = assertions.every((a) => a.pass);

  // 예산 축: ipa 콜 상한(maxIpaCalls)은 폭주 하드 게이트, USD는 관측치(게이트 아님).
  // cost_within_budget은 가시성 위해 어서션으로 남기되 종합 pass엔 넣지 않는다 —
  // sonnet/opus 5× 가격차로 단일 USD 임계를 전 모델에 적용할 수 없다.
  const calls = acc.ipaCalls.length;
  const ceilingPass = calls <= scenario.budget.maxIpaCalls;
  const costPass = acc.costUsd <= scenario.budget.maxCostUsd;
  assertions.push({ turn: turnNo, name: "cost_within_budget", pass: costPass, detail: `$${acc.costUsd.toFixed(3)} / $${scenario.budget.maxCostUsd} (observational)` });
  assertions.push({ turn: turnNo, name: "ipa_calls_within_budget", pass: ceilingPass, detail: `${calls} / ${scenario.budget.maxIpaCalls}` });

  // 효율 축: stepRatio = ipaCalls/goldenPath. goldenPath 없으면 측정 불가 → "ok".
  //   ok   = goldenPath×WARN_LOW 이내(정답 최소 시퀀스에 근접)
  //   warn = 그 위 ~ 상한 이내("정답인데 서툼" — 개선기회, fail 아님)
  //   over = 상한(maxIpaCalls) 초과(폭주)
  let efficiency;
  if (!scenario.goldenPath) efficiency = "ok";
  else if (calls > scenario.budget.maxIpaCalls) efficiency = "over";
  else if (calls <= scenario.goldenPath * WARN_LOW) efficiency = "ok";
  else efficiency = "warn";

  // completion 축: max-turns/에러로 절단된 런은 VOID(성공 취급 금지, human-review로 격리).
  const completion = acc.truncated ? "void" : "completed";
  if (acc.truncated) assertions.push({ turn: turnNo, name: "completion", pass: false, detail: "VOID: hit max-turns / error — needs human review" });

  const verdict = { correctness, efficiency, completion };
  // 종합 pass = 정답 AND 폭주상한(ipa콜) AND 효율!=over AND completion=completed.
  // USD(costPass)는 관측치라 게이트에서 제외한다. baseline.mjs가 읽는 boolean.
  const pass = correctness && ceilingPass && efficiency !== "over" && completion === "completed";

  const summary = {
    id: scenario.id, model, promptIndex,
    pass,
    verdict,
    assertions,
    costUsd: acc.costUsd, numTurns: acc.numTurns,
    ipaCalls: calls,
    ipaErrorCalls: acc.ipaCalls.filter((c) => c.isError).length,
    nonIpaVaultTouches: acc.nonIpaVaultTouches,
    truncated: acc.truncated,
    goldenPath: scenario.goldenPath,
    stepRatio: scenario.goldenPath ? Number((calls / scenario.goldenPath).toFixed(2)) : null,
    sandbox: args.keepSandbox ? sandbox : null,
  };
  writeFileSync(join(caseDir, "summary.json"), JSON.stringify(summary, null, 2));
  if (!args.keepSandbox) {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(installHome, { recursive: true, force: true });
    rmSync(`${sandbox}-xdg`, { recursive: true, force: true });
  }
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
      const v = summary.verdict;
      const vtag = `correct=${v.correctness} eff=${v.efficiency} compl=${v.completion}`;
      console.log(summary.pass ? `PASS ${head} ($${summary.costUsd.toFixed(3)}, ipa ${summary.ipaCalls}) [${vtag}]` : `FAIL ${head} [${vtag}]`);
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
    const merged = mergeBaseline(readBaselineRows(baselineFile), rows);
    writeFileSync(baselineFile, formatBaseline(merged));
    console.log(`baseline updated: ${rows.length} upserted, ${merged.length} total entries`);
  }
  console.log(`\n${runSummary.passed}/${rows.length} passed, total $${runSummary.totalCostUsd} → ${join("bench/results/runs", ts)}`);

  const holdoutIds = new Set(scenarios.filter((s) => s.holdout).map((s) => s.id));
  const gateFailed = rows.some((r) => !r.pass && !holdoutIds.has(r.id));
  process.exit(args.dryRun ? 0 : gateFailed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });

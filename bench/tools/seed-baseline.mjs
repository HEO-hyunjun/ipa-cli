// bench/tools/seed-baseline.mjs
// 과거 run-summary.json의 row로 baseline.jsonl을 시드/병합한다 (새 라이브 실행 없이 베이스라인 구성).
// 실행: node bench/tools/seed-baseline.mjs <run-summary.json> [baseline.jsonl]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatBaseline, readBaselineRows, mergeBaseline } from "../lib/baseline.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function seedBaseline(summaryPath, baselineFile) {
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  const rows = Array.isArray(summary.rows) ? summary.rows : [];
  const merged = mergeBaseline(readBaselineRows(baselineFile), rows);
  mkdirSync(dirname(baselineFile), { recursive: true });
  writeFileSync(baselineFile, formatBaseline(merged));
  return { upserted: rows.length, total: merged.length };
}

// import 시에는 실행하지 않는다 (테스트가 seedBaseline을 직접 호출).
if (import.meta.url === `file://${process.argv[1]}`) {
  const summaryPath = process.argv[2];
  if (!summaryPath) { console.error("usage: node bench/tools/seed-baseline.mjs <run-summary.json> [baseline.jsonl]"); process.exit(1); }
  const baselineFile = process.argv[3] || join(REPO, "bench", "results", "baseline.jsonl");
  const { upserted, total } = seedBaseline(summaryPath, baselineFile);
  console.log(`seeded baseline: ${upserted} upserted, ${total} total → ${baselineFile}`);
}

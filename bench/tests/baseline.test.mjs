// bench/tests/baseline.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBaseline, compareToBaseline, formatBaseline, readBaselineRows, mergeBaseline } from "../lib/baseline.mjs";
import { seedBaseline } from "../tools/seed-baseline.mjs";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const rows = [
  { id: "a1-x", model: "sonnet", pass: true, costUsd: 0.1, ipaCalls: 2 },
  { id: "b5-y", model: "sonnet", pass: false, costUsd: 0.2, ipaCalls: 9 },
];

test("round-trip: format → load", () => {
  const dir = mkdtempSync(join(tmpdir(), "bl-"));
  const f = join(dir, "baseline.jsonl");
  writeFileSync(f, formatBaseline(rows));
  const m = loadBaseline(f);
  assert.equal(m.get("a1-x::sonnet").costUsd, 0.1);
});

test("compare flags regressions and cost spikes", () => {
  const dir = mkdtempSync(join(tmpdir(), "bl-"));
  const f = join(dir, "baseline.jsonl");
  writeFileSync(f, formatBaseline([{ id: "a1-x", model: "sonnet", pass: true, costUsd: 0.1, ipaCalls: 2 }]));
  const base = loadBaseline(f);
  const report = compareToBaseline(base, [
    { id: "a1-x", model: "sonnet", pass: false, costUsd: 0.3, ipaCalls: 2 }, // pass→fail
    { id: "z9-new", model: "sonnet", pass: true, costUsd: 0.1, ipaCalls: 1 }, // 신규
  ]);
  assert.equal(report.find((r) => r.key === "a1-x::sonnet").kind, "regressed");
  assert.equal(report.find((r) => r.key === "z9-new::sonnet").kind, "new");
});

test("cost_up when cost exceeds 1.5x baseline but still passing", () => {
  const base = new Map([["a1-x::sonnet", { pass: true, costUsd: 0.1, ipaCalls: 2 }]]);
  const report = compareToBaseline(base, [{ id: "a1-x", model: "sonnet", pass: true, costUsd: 0.2, ipaCalls: 2 }]);
  assert.equal(report[0].kind, "cost_up");
});

test("missing baseline file yields empty map", () => {
  assert.equal(loadBaseline("/nonexistent/baseline.jsonl").size, 0);
});

test("mergeBaseline upserts run rows, preserves others, and sorts by key", () => {
  const existing = [
    { id: "a1-x", model: "sonnet", pass: true, costUsd: 0.1, ipaCalls: 2 },
    { id: "z9-z", model: "opus", pass: true, costUsd: 0.9, ipaCalls: 5 },
  ];
  const merged = mergeBaseline(existing, [
    { id: "a1-x", model: "sonnet", pass: false, costUsd: 0.3, ipaCalls: 4 }, // upsert
    { id: "b5-y", model: "sonnet", pass: true, costUsd: 0.2, ipaCalls: 1 },  // new
  ]);
  assert.deepEqual(merged.map((r) => `${r.id}::${r.model}`), ["a1-x::sonnet", "b5-y::sonnet", "z9-z::opus"]);
  assert.equal(merged.find((r) => r.id === "a1-x").pass, false); // 덮어써짐
  assert.equal(merged.find((r) => r.id === "z9-z").costUsd, 0.9); // 보존됨
});

test("readBaselineRows round-trips full rows and tolerates missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "bl-"));
  const f = join(dir, "baseline.jsonl");
  writeFileSync(f, formatBaseline(rows));
  const back = readBaselineRows(f);
  assert.equal(back.length, 2);
  assert.equal(back[0].id, "a1-x");
  assert.deepEqual(readBaselineRows(join(dir, "none.jsonl")), []);
});

test("seedBaseline merges rows from a run-summary.json into baseline.jsonl", () => {
  const dir = mkdtempSync(join(tmpdir(), "seed-"));
  const baselineFile = join(dir, "baseline.jsonl");
  writeFileSync(baselineFile, formatBaseline([{ id: "keep-me", model: "opus", pass: true, costUsd: 0.5, ipaCalls: 3 }]));
  const summaryPath = join(dir, "run-summary.json");
  writeFileSync(summaryPath, JSON.stringify({ ts: "t", rows: [
    { id: "a1-x", model: "sonnet", pass: true, costUsd: 0.1, ipaCalls: 2, extra: "ignored" },
    { id: "keep-me", model: "opus", pass: false, costUsd: 0.7, ipaCalls: 4 }, // upsert existing
  ] }));
  const res = seedBaseline(summaryPath, baselineFile);
  assert.deepEqual(res, { upserted: 2, total: 2 });
  const loaded = loadBaseline(baselineFile);
  assert.equal(loaded.get("a1-x::sonnet").costUsd, 0.1);
  assert.equal(loaded.get("keep-me::opus").pass, false); // 요약 rows가 기존 항목을 덮어씀
});

// bench/tests/baseline.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBaseline, compareToBaseline, formatBaseline } from "../lib/baseline.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
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

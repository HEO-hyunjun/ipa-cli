// bench/tests/schema.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateScenario, loadScenarios } from "../lib/schema.mjs";

const valid = () => ({
  id: "a1-unrelated-coding", group: "A", persona: "canonical", mode: "single",
  smoke: false, holdout: false, harness: true, models: ["sonnet"],
  prompts: ["질문 하나"], turns: [{ user: "$PROMPT", expect: { no_ipa_calls: true } }],
  responder: null, budget: { maxCostUsd: 0.5, maxIpaCalls: 8 }, goldenPath: null, maxTurns: 12,
});

test("valid scenario passes", () => {
  assert.deepEqual(validateScenario(valid()), []);
});

test("single mode must have exactly one turn", () => {
  const s = { ...valid(), turns: [...valid().turns, { user: "둘째 턴", expect: {} }] };
  assert.ok(validateScenario(s).some((e) => e.includes("single")));
});

test("first turn user must be $PROMPT", () => {
  const s = { ...valid(), turns: [{ user: "고정 문자열", expect: {} }] };
  assert.ok(validateScenario(s).length > 0);
});

test("bad persona / model / id are rejected", () => {
  assert.ok(validateScenario({ ...valid(), persona: "nope" }).length > 0);
  assert.ok(validateScenario({ ...valid(), models: ["gpt"] }).length > 0);
  assert.ok(validateScenario({ ...valid(), id: "bad id" }).length > 0);
});

test("loadScenarios loads dir and rejects duplicate ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-schema-"));
  writeFileSync(join(dir, "one.mjs"),
    `export default [${JSON.stringify(valid())}];`);
  const loaded = await loadScenarios(dir);
  assert.equal(loaded.length, 1);
  writeFileSync(join(dir, "two.mjs"),
    `export default [${JSON.stringify(valid())}];`); // 같은 id 중복
  await assert.rejects(() => loadScenarios(dir), /duplicate/);
});

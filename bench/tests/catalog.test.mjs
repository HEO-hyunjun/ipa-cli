// bench/tests/catalog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenarios } from "../lib/schema.mjs";

const DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "scenarios");

test("catalog: 21 scenarios, 9 multi, 6 smoke, 2 holdout, groups A-F covered", async () => {
  const all = await loadScenarios(DIR);
  assert.equal(all.length, 21);
  assert.equal(all.filter((s) => s.mode === "multi").length, 9);
  assert.equal(all.filter((s) => s.smoke).length, 6);
  assert.equal(all.filter((s) => s.holdout).length, 2);
  assert.deepEqual([...new Set(all.map((s) => s.group))].sort(), ["A", "B", "C", "D", "E", "F"]);
  for (const s of all) assert.ok(s.prompts.length >= 2, `${s.id}: paraphrase pool needs >= 2 prompts`);
});

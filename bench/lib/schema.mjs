// bench/lib/schema.mjs
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PERSONAS = new Set(["canonical", "divergent", "messy", "pre-ipa", "empty"]);
const MODELS = new Set(["sonnet", "opus", "haiku"]);
const GROUPS = new Set(["A", "B", "C", "D", "E", "F", "G"]);

export function validateScenario(s) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(`${s?.id ?? "(no id)"}: ${msg}`); };
  need(typeof s?.id === "string" && /^[a-g]\d+-[a-z0-9-]+$/.test(s.id), "id must match <group><n>-<slug>");
  need(GROUPS.has(s?.group), "group must be A-G");
  need(PERSONAS.has(s?.persona), `unknown persona: ${s?.persona}`);
  need(s?.mode === "single" || s?.mode === "multi", "mode must be single|multi");
  for (const flag of ["smoke", "holdout", "harness"]) need(typeof s?.[flag] === "boolean", `${flag} must be boolean`);
  need(s?.preconfigured === undefined || typeof s.preconfigured === "boolean", "preconfigured must be boolean when set");
  need(Array.isArray(s?.models) && s.models.length > 0 && s.models.every((m) => MODELS.has(m)), "models invalid");
  need(Array.isArray(s?.prompts) && s.prompts.length >= 1 && s.prompts.every((p) => typeof p === "string" && p.trim()), "prompts pool required");
  need(Array.isArray(s?.turns) && s.turns.length >= 1, "turns required");
  if (Array.isArray(s?.turns) && s.turns.length > 0) {
    if (s.mode === "single") need(s.turns.length === 1, "single mode must have exactly 1 turn");
    need(s.turns[0]?.user === "$PROMPT", "first turn user must be $PROMPT");
    for (const t of s.turns) {
      need(typeof t?.user === "string" && t.user.trim(), "turn.user must be non-empty string");
      need(t?.expect && typeof t.expect === "object" && !Array.isArray(t.expect), "turn.expect must be object");
    }
  }
  need(s?.responder === null || s?.responder === "approve" || s?.responder === "decline"
    || (typeof s?.responder === "string" && s.responder.startsWith("detail:")), "responder invalid");
  need(s?.budget && typeof s.budget.maxCostUsd === "number" && s.budget.maxCostUsd > 0
    && Number.isInteger(s.budget.maxIpaCalls) && s.budget.maxIpaCalls >= 0, "budget invalid");
  need(s?.goldenPath === null || (Number.isInteger(s.goldenPath) && s.goldenPath >= 0), "goldenPath must be int|null");
  need(Number.isInteger(s?.maxTurns) && s.maxTurns >= 1 && s.maxTurns <= 40, "maxTurns must be 1-40");
  return errors;
}

export async function loadScenarios(scenariosDir) {
  const files = readdirSync(scenariosDir).filter((f) => f.endsWith(".mjs") && !f.startsWith("_")).sort();
  const all = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(join(scenariosDir, file)).href);
    const list = mod.default;
    if (!Array.isArray(list)) throw new Error(`${file}: default export must be an array`);
    all.push(...list);
  }
  const errors = all.flatMap(validateScenario);
  const seen = new Set();
  for (const s of all) {
    if (seen.has(s.id)) errors.push(`duplicate id: ${s.id}`);
    seen.add(s.id);
  }
  if (errors.length) throw new Error(`scenario validation failed:\n${errors.join("\n")}`);
  return all;
}

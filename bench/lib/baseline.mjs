// bench/lib/baseline.mjs
import { existsSync, readFileSync } from "node:fs";

export function loadBaseline(file) {
  const map = new Map();
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    try {
      const row = JSON.parse(line);
      map.set(`${row.id}::${row.model}`, { pass: row.pass, costUsd: row.costUsd, ipaCalls: row.ipaCalls });
    } catch { /* skip broken line */ }
  }
  return map;
}

export function formatBaseline(rows) {
  return rows.map((r) => JSON.stringify({ id: r.id, model: r.model, pass: r.pass, costUsd: r.costUsd, ipaCalls: r.ipaCalls })).join("\n") + "\n";
}

export function compareToBaseline(baseMap, rows) {
  return rows.map((r) => {
    const key = `${r.id}::${r.model}`;
    const base = baseMap.get(key);
    if (!base) return { key, kind: "new", detail: "no baseline entry" };
    if (base.pass && !r.pass) return { key, kind: "regressed", detail: "pass → fail" };
    if (r.pass && base.costUsd > 0 && r.costUsd > base.costUsd * 1.5)
      return { key, kind: "cost_up", detail: `$${base.costUsd.toFixed(3)} → $${r.costUsd.toFixed(3)}` };
    return { key, kind: "ok", detail: "" };
  });
}

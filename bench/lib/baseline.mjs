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

// baseline.jsonl을 원본 row 배열로 읽는다 (loadBaseline은 id/model을 키에 흡수해 병합에 부적합).
export function readBaselineRows(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// 기존 baseline에 새 run의 row를 id::model 키로 upsert하고, 나머지는 보존한 채 키 순으로 정렬한다.
// (덮어쓰기가 아닌 병합 — 부분 재실행이 다른 항목을 지우지 않게 한다.)
export function mergeBaseline(existingRows, newRows) {
  const pick = (r) => ({ id: r.id, model: r.model, pass: r.pass, costUsd: r.costUsd, ipaCalls: r.ipaCalls });
  const map = new Map();
  for (const r of existingRows) map.set(`${r.id}::${r.model}`, pick(r));
  for (const r of newRows) map.set(`${r.id}::${r.model}`, pick(r));
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
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

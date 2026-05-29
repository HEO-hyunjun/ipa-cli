import { readFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = [
  "packages/core/src",
  "packages/cli/src",
  "packages/builtin-rules/src",
  "packages/obsidian/src"
];
const issues = [];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

for (const root of roots) {
  for (const file of walk(root)) {
    const text = await readFile(file, "utf8");
    if (text.includes("\t")) issues.push(`${file}: tab character`);
    if (!text.endsWith("\n")) issues.push(`${file}: missing trailing newline`);
  }
}

if (issues.length) {
  console.error(issues.join("\n"));
  process.exit(1);
}

console.log("lint ok");

// bench/lib/sandbox.mjs
import { cpSync, mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

const SKIP_DIRS = new Set([".git", "node_modules"]);

export function createSandbox(personaDir, label, { preconfigured = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `ipa-bench-${label}-`));
  cpSync(personaDir, dir, { recursive: true });
  if (preconfigured) writeFileSync(join(dir, ".ipa-config"), `vault_path: ${dir}\n`);
  return dir;
}

export function snapshot(dir) {
  const map = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else map.set(relative(dir, full).split(sep).join("/").normalize("NFC"),
        createHash("sha1").update(readFileSync(full)).digest("hex"));
    }
  };
  walk(dir);
  return map;
}

export function diffSnapshots(before, after) {
  return {
    added: [...after.keys()].filter((k) => !before.has(k)).sort(),
    removed: [...before.keys()].filter((k) => !after.has(k)).sort(),
    modified: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)).sort(),
  };
}

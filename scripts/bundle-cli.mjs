// Release bundling: packages/cli/src/main.ts → dist/release/ipa-cli.js.
// scripts/build.mjs's copied dist needs node_modules; this produces the
// single-file asset attached to GitHub releases.
import { mkdir, chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import esbuild from "esbuild";

// main.ts imports core via ../../core/dist/index.js — refresh dist first
// so the bundle never captures stale copies (build.mjs runs on import).
await import("./build.mjs");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
let commit = "";
try {
  commit = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
} catch {}
const outDir = join(root, "dist", "release");
const outfile = join(outDir, "ipa-cli.js");
// Wrapper entry: main.ts starts with a shebang, which esbuild would emit
// below the banner — a mid-file `#!` is a syntax error in ESM output.
const entry = join(outDir, "entry.mjs");

await mkdir(outDir, { recursive: true });
await writeFile(entry, `import ${JSON.stringify(join(root, "packages", "cli", "src", "main.ts"))};\n`, "utf8");

await esbuild.build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  define: {
    "process.env.IPA_BUNDLE_VERSION": JSON.stringify(version),
    "process.env.IPA_BUNDLE_COMMIT": JSON.stringify(commit),
  },
  banner: {
    // CJS deps (commander, cli-table3) require() node builtins at runtime;
    // give the ESM bundle a working require.
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
  logLevel: "info",
});

await chmod(outfile, 0o755);

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";

const root = dirname(fileURLToPath(import.meta.url)) + "/..";
const packages = ["core", "cli", "builtin-rules"];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

for (const name of packages) {
  const pkg = join(root, "packages", name);
  await mkdir(join(pkg, "dist"), { recursive: true });
  for (const source of walk(join(pkg, "src"))) {
    const rel = relative(join(pkg, "src"), source).replace(/\.ts$/, ".js");
    const target = join(pkg, "dist", rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(source, "utf8"), "utf8");
  }
}

await chmod(join(root, "packages", "cli", "dist", "main.js"), 0o755);

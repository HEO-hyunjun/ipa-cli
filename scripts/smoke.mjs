import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url)) + "/..";
const work = await mkdtemp(join(tmpdir(), "ipa-js-smoke-"));
const vault = join(work, "vault");
const xdg = join(work, "xdg");
await cp(join(root, "packages", "test-vaults", "fixtures", "mini-vault"), vault, {
  recursive: true
});
await mkdir(join(xdg, "ipa"), { recursive: true });
await writeFile(
  join(xdg, "ipa", "profile.yaml"),
  `profiles:\n  ipa-test:\n    vault_path: ${vault}\n    default: true\n`,
  "utf8"
);
await mkdir(join(vault, ".ipa", "plugins", "search"), { recursive: true });
await mkdir(join(vault, ".ipa", "plugins", "rules"), { recursive: true });
await writeFile(
  join(vault, ".ipa", "plugins", "search", "sample.js"),
  `export async function search(query, notes) {
    return notes.filter((note) => note.id.includes(query)).map((note) => ({ note: note.id, score: 1 }));
  }\n`,
  "utf8"
);
await writeFile(
  join(vault, ".ipa", "plugins", "rules", "sample.js"),
  `export const rules = [{
    code: "sample.issue",
    severity: "warn",
    check(note) {
      return [{ message: "sample issue", note: note.id }];
    },
    fix(note) {
      return [{ note: note.id, line: 1, replacement: "X" }];
    }
  }];\n`,
  "utf8"
);
await writeFile(join(work, "new-note.md"), "# New Note\n\nBody.\n", "utf8");

const cli = join(root, "packages", "cli", "dist", "main.js");
const env = { ...process.env, XDG_CONFIG_HOME: xdg, IPA_HARNESS_HOME: work };
const commands = [
  ["--profile", "ipa-test", "search", "Alpha", "--json"],
  ["--profile", "ipa-test", "view", "Alpha", "--full"],
  ["--profile", "ipa-test", "view", "Alpha", "--section", "Details"],
  ["--profile", "ipa-test", "traversal", "--up", "Alpha"],
  ["--profile", "ipa-test", "traversal", "--down", "🔖 Topic Index"],
  ["--profile", "ipa-test", "traversal", "--siblings", "Alpha"],
  ["--profile", "ipa-test", "traversal", "--root", "Alpha"],
  ["--profile", "ipa-test", "validator", "--json"],
  ["--profile", "ipa-test", "refactor", "tag-add", "migration_test", "--json"],
  ["--profile", "ipa-test", "doctor", "--json"],
  ["--profile", "ipa-test", "doctor", "--fix-dirs", "--json"],
  ["--profile", "ipa-test", "context", "Alpha", "--by-note", "--format", "json"],
  ["--profile", "ipa-test", "rename", "Alpha", "Alpha Renamed", "--json"],
  ["--profile", "ipa-test", "move", "Alpha", "02 Archive", "--json"],
  ["--profile", "ipa-test", "add", join(work, "new-note.md"), "--title", "Inbox Added", "--ref", "🔖 Topic Index", "--tag", "note", "--json"],
  ["--profile", "ipa-test", "list-channels", "--json"],
  ["--profile", "ipa-test", "list-rules", "--json"],
  ["--profile", "ipa-test", "list-refactors", "--json"],
  ["--profile", "ipa-test", "config", "show", "--json"],
  ["profile", "list", "--json"],
  ["profile", "current", "--json"],
  ["--profile", "ipa-test", "engine", "channels", "--json"],
  ["--profile", "ipa-test", "engine", "search", "Alpha", "--json"],
  ["--profile", "ipa-test", "convention", "check", "--json"],
  ["--profile", "ipa-test", "formatter", "plan", "--json"],
  ["--profile", "ipa-test", "formatter", "plan", "--note", "Alpha", "--json"],
  ["--profile", "ipa-test", "formatter", "plan", "--note", "Alpha", "Beta", "--json"],
  ["--profile", "ipa-test", "formatter", "apply", "--json"],
  ["--profile", "ipa-test", "inbox", "triage", "--json"],
  ["--profile", "ipa-test", "cache", "rebuild", "--json"],
  ["--profile", "ipa-test", "cache", "status", "--json"],
  ["--profile", "ipa-test", "cache", "inspect", "--note", "Alpha", "--json"],
  ["--profile", "ipa-test", "cache", "doctor", "--json"],
  ["--profile", "ipa-test", "link", "suggest", "Alpha", "--json"],
  ["--profile", "ipa-test", "link", "plan", "--scope", "inbox", "--output", ".ipa/plans/link-test.json", "--json"],
  ["--profile", "ipa-test", "link", "apply", ".ipa/plans/link-test.json", "--json"],
  ["--profile", "ipa-test", "review", "all", "--json"],
  ["--profile", "ipa-test", "review", "inbox", "--json"],
  ["--profile", "ipa-test", "review", "index", "--json"],
  ["--profile", "ipa-test", "review", "tags", "--json"],
  ["--profile", "ipa-test", "review", "duplicates", "--json"],
  ["--profile", "ipa-test", "review", "convention", "--json"],
  ["--profile", "ipa-test", "contract", "list", "--json"],
  ["--profile", "ipa-test", "contract", "validate", ".ipa/config.yaml", "--json"],
  ["--profile", "ipa-test", "contract", "export-fixtures", "--target", ".ipa/fixtures/contracts", "--json"],
  ["--profile", "ipa-test", "contract", "validate-output", "context", ".ipa/fixtures/contracts/context.json", "--json"],
  ["--profile", "ipa-test", "plugin", "list", "--json"],
  ["--profile", "ipa-test", "plugin", "doctor", "--json"],
  ["--profile", "ipa-test", "plugin", "validate", ".ipa/plugins/search/sample.js", "--json"],
  ["--profile", "ipa-test", "plugin", "dry-run", "search", ".ipa/plugins/search/sample.js", "--query", "Alpha", "--json"],
  ["--profile", "ipa-test", "plugin", "validate", ".ipa/plugins/rules/sample.js", "--json"],
  ["--profile", "ipa-test", "plugin", "dry-run", "rules", ".ipa/plugins/rules/sample.js", "--note", "Alpha", "--json"],
  ["--profile", "ipa-test", "harness", "status", "--json"],
  ["--profile", "ipa-test", "harness", "install", "codex", "--json"],
  ["--profile", "ipa-test", "harness", "uninstall", "codex", "--json"],
  ["--profile", "ipa-test", "harness", "doctor", "--json"],
  ["--profile", "ipa-test", "harness", "guard", "status", "--json"],
  ["--profile", "ipa-test", "harness", "guard", "check", "00 Inbox/New.md", "--json"],
  ["--profile", "ipa-test", "tune", "eval"],
  ["--profile", "ipa-test", "tune", "--trials", "2", "--json"],
  ["--profile", "ipa-test", "tune", "list", "--json"],
  ["--profile", "ipa-test", "tune", "use", "missing.json", "--json"],
  ["--profile", "ipa-test", "tune", "analyze", "--json"],
  ["--profile", "ipa-test", "tune", "replay", "--json"],
  ["--profile", "ipa-test", "tune", "label", "--json"],
  ["--profile", "ipa-test", "tune", "log", "--json"],
  ["--profile", "ipa-test", "tune", "testset", "draft", "--json"],
  ["--profile", "ipa-test", "tune", "pack", "list", "--json"],
  ["--profile", "ipa-test", "tune", "pack", "eval", "ipa-cli-core"]
];

for (const args of commands) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    console.error(`command failed: ipa ${args.join(" ")}`);
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(result.status ?? 1);
  }
}

console.log(`smoke ok (${commands.length} commands)`);

import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url)) + "/../../..";
const cli = join(root, "packages", "cli", "dist", "main.js");

async function fixtureProfile() {
  const work = await mkdtemp(join(tmpdir(), "ipa-cli-test-"));
  const vault = join(work, "vault");
  const xdg = join(work, "xdg");
  await cp(join(root, "packages", "test-vaults", "fixtures", "mini-vault"), vault, { recursive: true });
  await mkdir(join(xdg, "ipa"), { recursive: true });
  await writeFile(
    join(xdg, "ipa", "profile.yaml"),
    `profiles:\n  ipa-test:\n    vault_path: ${vault}\n    default: true\n`,
    "utf8"
  );
  return { vault, env: { ...process.env, XDG_CONFIG_HOME: xdg } };
}

function run(env, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test("CLI help and key smoke commands run through ipa-test profile", async () => {
  const { env } = await fixtureProfile();
  const help = run(env, ["--help"]);
  assert.match(help, /Usage: ipa/);
  assert.match(help, /Core commands:/);
  const channels = run(env, ["--profile", "ipa-test", "list-channels"]);
  assert.match(channels, /search channels \(9\)/);
  assert.match(channels, /body_match\s+0\.3630/);
  const rules = run(env, ["--profile", "ipa-test", "list-rules"]);
  assert.match(rules, /validator rules \(13\)/);
  assert.match(rules, /ipa\.link\.wikilink_target_missing/);
  const refactors = run(env, ["--profile", "ipa-test", "list-refactors"]);
  assert.match(refactors, /refactor commands \(7\)/);
  assert.match(refactors, /wikilink-replace\s+본문 wikilink 치환/);
  const search = JSON.parse(run(env, ["--profile", "ipa-test", "search", "Alpha", "--json"]));
  assert.equal(search.results[0].note, "Alpha");
  const humanSearch = run(env, ["--profile", "ipa-test", "search", "Alpha"]);
  assert.match(humanSearch, /Search results for 'Alpha'/);
  assert.match(humanSearch, /\[note \] Alpha  ref→ 🔖 Topic Index/);
  assert.match(humanSearch, /결과 노트들의 소속 인덱스\/ref 분포/);
  const fullView = run(env, ["--profile", "ipa-test", "view", "Alpha", "--full"]);
  assert.match(fullView, /=== Alpha \[note\] ===/);
  assert.match(fullView, /연결: ↗ outlinks 0  ↩ backlinks 2  ⇄ siblings 1/);
  assert.match(fullView, /다음:/);
  assert.match(run(env, ["--profile", "ipa-test", "traversal", "--up", "Alpha"]), /Topic Root/);
  const down = run(env, ["--profile", "ipa-test", "traversal", "--down", "🔖 Topic Index"]);
  assert.match(down, /Tree from '🔖 Topic Index':/);
  assert.match(down, /📄 Alpha/);
  const root = run(env, ["--profile", "ipa-test", "traversal", "--root", "Alpha"]);
  assert.match(root, /Root\(s\) for 'Alpha':/);
  const context = JSON.parse(run(env, ["--profile", "ipa-test", "context", "Alpha", "--by-note", "--format", "json"]));
  assert.equal(context.notes[0].id, "Alpha");
  const doctor = JSON.parse(run(env, ["--profile", "ipa-test", "doctor", "--json"]));
  assert.equal(doctor.status, "ok");
  const tune = run(env, ["--profile", "ipa-test", "tune", "pack", "eval", "ipa-cli-core"]);
  assert.match(tune, /Tune evaluation/);
  assert.match(tune, /Misses: 0/);
});

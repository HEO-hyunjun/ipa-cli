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
  const search = JSON.parse(run(env, ["--profile", "ipa-test", "search", "Alpha", "--json"]));
  assert.equal(search.results[0].note, "Alpha");
  const humanSearch = run(env, ["--profile", "ipa-test", "search", "Alpha"]);
  assert.match(humanSearch, /Search results/);
  assert.match(humanSearch, /Rank\s+Note\s+Type\s+Score\s+Path/);
  assert.match(run(env, ["--profile", "ipa-test", "traversal", "--up", "Alpha"]), /Topic Root/);
  const context = JSON.parse(run(env, ["--profile", "ipa-test", "context", "Alpha", "--by-note", "--format", "json"]));
  assert.equal(context.notes[0].id, "Alpha");
  const doctor = JSON.parse(run(env, ["--profile", "ipa-test", "doctor", "--json"]));
  assert.equal(doctor.status, "ok");
  const tune = run(env, ["--profile", "ipa-test", "tune", "pack", "eval", "ipa-cli-core"]);
  assert.match(tune, /Tune evaluation/);
  assert.match(tune, /Misses: 0/);
});

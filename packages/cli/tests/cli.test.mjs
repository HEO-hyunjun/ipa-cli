import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url)) + "/../../..";
const cli = join(root, "packages", "cli", "dist", "main.js");

async function fixtureProfile(fixture = "mini-vault") {
  const work = await mkdtemp(join(tmpdir(), "ipa-cli-test-"));
  const vault = join(work, "vault");
  const xdg = join(work, "xdg");
  await cp(join(root, "packages", "test-vaults", "fixtures", fixture), vault, { recursive: true });
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
  const tuneHelp = run(env, ["tune", "--help"]);
  assert.match(tuneHelp, /Usage: ipa \[OPTIONS\] tune/);
  assert.match(tuneHelp, /ipa tune --trials 100/);
  assert.match(tuneHelp, /Progress:/);
  const channels = run(env, ["--profile", "ipa-test", "list-channels"]);
  assert.match(channels, /search channels \(9\)/);
  assert.match(channels, /body_match\s+0\.3630/);
  const rules = run(env, ["--profile", "ipa-test", "list-rules"]);
  assert.match(rules, /validator rules \(11\)/);
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
  const humanContext = run(env, ["--profile", "ipa-test", "context", "Alpha", "--by-note"]);
  assert.match(humanContext, /Context/);
  assert.match(humanContext, /Alpha\s+note\s+00 Inbox\/Alpha\.md/);
  assert.doesNotMatch(humanContext, /"edges"/);
  const doctor = JSON.parse(run(env, ["--profile", "ipa-test", "doctor", "--json"]));
  assert.equal(doctor.status, "ok");
  const tune = run(env, ["--profile", "ipa-test", "tune", "pack", "eval", "ipa-cli-core"]);
  assert.match(tune, /Tune evaluation/);
  assert.match(tune, /Misses: 0/);
});

test("legacy surface fixture is covered by JS fixtures", async () => {
  const { env } = await fixtureProfile("legacy-surface");
  const profile = ["--profile", "ipa-test"];

  const search = run(env, [...profile, "search", "Note"]);
  assert.match(search, /Search results for 'Note': 6 notes \(threshold 0\.3\)/);
  assert.match(search, /\[note \] Note A  ref→ 🔖 Sample Index/);
  assert.match(search, /\[index\] 🔖 Sample Index  ref→ 🏷️ Sample Root/);
  assert.match(search, /결과 노트들의 소속 인덱스\/ref 분포/);
  assert.match(search, /4건  🔖 Sample Index/);

  const overview = run(env, [...profile, "view", "Note A"]);
  assert.match(overview, /=== Note A \[note\] ===/);
  assert.match(overview, /## Structure/);
  assert.match(overview, /\[H2\] Section X/);
  assert.match(overview, /연결: ↗ outlinks 1  ↩ backlinks 3  ⇄ siblings 3/);
  assert.match(overview, /ipa view "Note A" --full/);
  assert.doesNotMatch(overview, /--related/);
  assert.doesNotMatch(overview, /--backlinks/);

  const full = run(env, [...profile, "view", "Note A", "--full"]);
  assert.match(full, /↑ ref: 🔖 Sample Index → 🏷️ Sample Root/);
  assert.match(full, /date_created: 2026\/01\/04 \(Sun\) 00:00:00/);
  assert.match(full, /Content under section Y referencing \[\[Note B\]\]/);
  assert.match(full, /🏷 tags:/);
  assert.match(full, /ipa traversal --up "Note A"/);
  assert.match(full, /ipa context "Note A" --by-note/);
  assert.doesNotMatch(full, /--backlinks "Note A"/);

  const section = run(env, [...profile, "view", "Note A", "--section", "Section X", "--full"]);
  assert.match(section, /## Section X/);
  assert.match(section, /Content under section X/);
  assert.doesNotMatch(section, /Section Y/);
  assert.doesNotMatch(section, /다음:/);

  const up = run(env, [...profile, "traversal", "--up", "Note A"]);
  assert.match(up, /Upward paths from 'Note A':/);
  assert.match(up, /Note A → 🔖 Sample Index → 🏷️ Sample Root/);
  const down = run(env, [...profile, "traversal", "--down", "🔖 Sample Index"]);
  assert.match(down, /Tree from '🔖 Sample Index':/);
  assert.match(down, /📄 Note A/);
  assert.match(down, /🔖 Sub Index\n    📄 Note D/);
  const root = run(env, [...profile, "traversal", "--root", "Note A"]);
  assert.match(root, /Root\(s\) for 'Note A':/);
  assert.match(root, /- 🏷️ Sample Root/);

  const channels = run(env, [...profile, "list-channels"]);
  assert.match(channels, /search channels \(9\)/);
  assert.match(channels, /fuzzy\s+0\.2680\s+0\.2680\s+Graded fuzzy match/);
  assert.match(channels, /project\s+0\.0330\s+0\.0330\s+Project folder\/ref boost/);
  const rules = run(env, [...profile, "list-rules"]);
  assert.match(rules, /validator rules \(11\)/);
  assert.match(rules, /ipa\.heading\.no_h1\s+heading\s+info\s+note/);
  const refactors = run(env, [...profile, "list-refactors"]);
  assert.match(refactors, /refactor commands \(7\)/);
  assert.match(refactors, /ref-replace\s+ref 교체/);
  assert.match(refactors, /ref-remove\s+특정 노트에서 ref 제거/);
});

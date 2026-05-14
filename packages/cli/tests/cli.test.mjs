import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url)) + "/../../..";
const cli = join(root, "packages", "cli", "dist", "main.js");

function testEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.IPA_PROFILE;
  delete env.IPA_VAULT_PATH;
  return env;
}

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
  return { vault, env: testEnv({ XDG_CONFIG_HOME: xdg }) };
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

function runRaw(env, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8"
  });
}

test("CLI help and key smoke commands run through ipa-test profile", async () => {
  const { vault, env } = await fixtureProfile();
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
  assert.match(rules, /validator rules \(15\)/);
  assert.match(rules, /ipa\.link\.wikilink_target_missing/);
  await writeFile(join(vault, "00 Inbox", "Broken.md"), "# Broken\n", "utf8");
  const validator = run(env, ["--profile", "ipa-test", "validator"]);
  assert.match(validator, /Severity\s+Code\s+Note\s+Path\s+Message/);
  assert.match(validator, /00 Inbox\/Broken\.md/);
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
  assert.equal(context.mode, "by-note");
  assert.ok(context.notes[0].backlinks.some((note) => note.id === "Beta"));
  assert.ok(Object.keys(context.edges).length < 6);
  const humanContext = run(env, ["--profile", "ipa-test", "context", "Alpha", "--by-note"]);
  assert.match(humanContext, /Context/);
  assert.match(humanContext, /Search results/);
  assert.match(humanContext, /Alpha\s+inbox\s+00 Inbox\/Alpha\.md\s+🔖 Topic Index \[project\]/);
  assert.match(humanContext, /Ref distribution/);
  assert.match(humanContext, /Tag distribution/);
  assert.match(humanContext, /location: inbox/);
  assert.match(humanContext, /refs: 🔖 Topic Index \[project\]/);
  assert.match(humanContext, /traversal:/);
  assert.match(humanContext, /Alpha \[inbox\] -> 🔖 Topic Index \[project\] -> 🏷️ Topic Root \[project\]/);
  assert.match(humanContext, /overview:/);
  assert.match(humanContext, /H2 Details/);
  assert.doesNotMatch(humanContext, /excerpt:/);
  assert.doesNotMatch(humanContext, /backlinks:/);
  assert.doesNotMatch(humanContext, /siblings:/);
  assert.match(humanContext, /Next commands:/);
  assert.match(humanContext, /ipa search "Alpha"/);
  assert.doesNotMatch(humanContext, /"edges"/);
  const largeContext = run(env, ["--profile", "ipa-test", "context", "Alpha", "--by-note", "--size", "large"]);
  assert.match(largeContext, /body:/);
  assert.match(largeContext, /Alpha mentions Beta/);
  const doctor = JSON.parse(run(env, ["--profile", "ipa-test", "doctor", "--json"]));
  assert.equal(doctor.status, "ok");
  const tune = run(env, ["--profile", "ipa-test", "tune", "pack", "eval", "ipa-cli-core"]);
  assert.match(tune, /Tune evaluation/);
  assert.match(tune, /Misses: 0/);
  const packs = JSON.parse(run(env, ["--profile", "ipa-test", "tune", "pack", "--json"]));
  assert.deepEqual(packs.packs, ["ipa-cli-core"]);
  const unknownPackCommand = runRaw(env, ["--profile", "ipa-test", "tune", "pack", "foo", "--json"]);
  assert.notEqual(unknownPackCommand.status, 0);
  assert.match(unknownPackCommand.stderr, /too many arguments|unknown command/i);
});

test("profile init and new manage machine-local profile registry", async () => {
  const work = await mkdtemp(join(tmpdir(), "ipa-cli-profile-"));
  const xdg = join(work, "xdg");
  const vault = join(work, "ipa");
  const workVault = join(work, "work-vault");
  const updatedVault = join(work, "updated-work-vault");
  await mkdir(vault, { recursive: true });
  await mkdir(workVault, { recursive: true });
  await mkdir(updatedVault, { recursive: true });
  const env = testEnv({ XDG_CONFIG_HOME: xdg });

  const init = JSON.parse(run(env, ["--json", "profile", "init", "--vault", vault]));
  assert.equal(init.profile, "ipa");
  assert.equal(init.vault_path, vault);
  assert.equal(init.default, true);
  assert.equal(init.created, true);
  assert.equal(init.updated, false);

  const current = JSON.parse(run(env, ["profile", "current"]));
  assert.equal(current.current, "ipa");
  const config = run(env, ["config", "show"]);
  assert.match(config, /profile\s+ipa/);
  assert.match(config, new RegExp(`vault_path\\s+${vault.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(config, /source\s+default-profile/);

  const repeated = JSON.parse(run(env, ["--json", "profile", "init", "--vault", vault]));
  assert.equal(repeated.created, false);
  assert.equal(repeated.updated, false);

  const secondInit = runRaw(env, ["profile", "init", "--name", "other", "--vault", workVault]);
  assert.notEqual(secondInit.status, 0);
  assert.match(secondInit.stderr, /profile registry already initialized/);

  const added = JSON.parse(run(env, ["--json", "profile", "new", "work", workVault, "--default"]));
  assert.equal(added.profile, "work");
  assert.equal(added.vault_path, workVault);
  assert.equal(added.default, true);
  assert.equal(added.created, true);

  const list = JSON.parse(run(env, ["profile", "list"]));
  assert.equal(list.profiles.ipa.default, false);
  assert.equal(list.profiles.work.default, true);

  const duplicate = runRaw(env, ["profile", "new", "work", workVault]);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /profile already exists: work/);

  const updated = JSON.parse(run(env, ["--json", "profile", "new", "work", updatedVault, "--force"]));
  assert.equal(updated.vault_path, updatedVault);
  assert.equal(updated.default, true);
  assert.equal(updated.created, false);
  assert.equal(updated.updated, true);
});

test("plugin init scaffolds typed vault-local plugin authoring files", async () => {
  const { vault, env } = await fixtureProfile();

  const scaffold = JSON.parse(run(env, ["--profile", "ipa-test", "--json", "plugin", "init"]));
  assert.equal(scaffold.plugin_root, ".ipa/plugins");
  assert.equal(scaffold.examples, true);
  assert.ok(scaffold.created.includes(".ipa/plugins/jsconfig.json"));
  assert.ok(scaffold.created.includes(".ipa/plugins/types/ipa-plugin.d.ts"));
  assert.ok(scaffold.created.includes(".ipa/plugins/rules/_example-title-length.js"));
  assert.ok(scaffold.created.includes(".ipa/plugins/search/_example-heading-search.js"));

  const jsconfig = await readFile(join(vault, ".ipa", "plugins", "jsconfig.json"), "utf8");
  assert.match(jsconfig, /"checkJs": true/);
  assert.match(jsconfig, /"types\/\*\*\/\*\.d\.ts"/);
  const types = await readFile(join(vault, ".ipa", "plugins", "types", "ipa-plugin.d.ts"), "utf8");
  assert.match(types, /export interface Rule/);
  assert.match(types, /export interface SearchHit/);
  const ruleExample = await readFile(join(vault, ".ipa", "plugins", "rules", "_example-title-length.js"), "utf8");
  assert.match(ruleExample, /@ts-check/);
  assert.match(ruleExample, /import\("\.\.\/types\/ipa-plugin"\)\.Rule/);

  const plugins = JSON.parse(run(env, ["--profile", "ipa-test", "--json", "plugin", "list"]));
  assert.deepEqual(plugins.plugins, []);
  const validation = JSON.parse(run(env, ["--profile", "ipa-test", "--json", "plugin", "validate", ".ipa/plugins/rules/_example-title-length.js"]));
  assert.deepEqual(validation.issues, []);
  const repeated = JSON.parse(run(env, ["--profile", "ipa-test", "--json", "plugin", "init"]));
  assert.ok(repeated.existing.includes(".ipa/plugins/jsconfig.json"));
});

test("tune testset init creates a default testset and config pointer", async () => {
  const { vault, env } = await fixtureProfile();
  await writeFile(
    join(vault, ".ipa", "config.yaml"),
    `mapping:\n  fields:\n    note_type: type\n    refs: ref\n    tags: tags\n    created_at: date_created\n    updated_at: date_modified\n    aliases: aliases\n  folders:\n    inbox: 00 Inbox\n    project: 01 Project\n    archive: 02 Archive\n`,
    "utf8"
  );

  const init = JSON.parse(run(env, ["--profile", "ipa-test", "--json", "tune", "testset", "init", "--file", "cli.json"]));
  assert.equal(init.file, ".ipa/tune/testsets/cli.json");
  assert.equal(init.active, ".ipa/tune/testsets/cli.json");
  assert.equal(init.created, true);
  assert.equal(init.config_updated, true);
  assert.deepEqual(JSON.parse(await readFile(join(vault, ".ipa", "tune", "testsets", "cli.json"), "utf8")), {
    cases: [],
    scenario_cases: []
  });

  const config = await readFile(join(vault, ".ipa", "config.yaml"), "utf8");
  assert.match(config, /test:\n  file: \.ipa\/tune\/testsets\/cli\.json/);
  const list = JSON.parse(run(env, ["--profile", "ipa-test", "--json", "tune", "testset", "list"]));
  assert.equal(list.active, ".ipa/tune/testsets/cli.json");

  run({ ...env, IPA_SEARCH_LOG: "1" }, ["--profile", "ipa-test", "search", "Alpha"]);
  const log = JSON.parse(run(env, ["--profile", "ipa-test", "--json", "tune", "log", "--query", "Alpha"]));
  assert.equal(log.count, 1);
  assert.equal(log.events[0].query, "Alpha");
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
  assert.match(rules, /validator rules \(15\)/);
  assert.match(rules, /ipa\.heading\.no_h1\s+heading\s+info\s+note\s+yes\s+on\s+builtin/);
  const refactors = run(env, [...profile, "list-refactors"]);
  assert.match(refactors, /refactor commands \(7\)/);
  assert.match(refactors, /ref-replace\s+ref 교체/);
  assert.match(refactors, /ref-remove\s+특정 노트에서 ref 제거/);
});

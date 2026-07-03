import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
  assert.match(help, /list-channels \/ list-rules \/ list-refactors/);
  const tuneHelp = run(env, ["tune", "--help"]);
  assert.match(tuneHelp, /Usage: ipa \[OPTIONS\] tune/);
  assert.match(tuneHelp, /ipa tune --trials 100/);
  assert.match(tuneHelp, /ipa tune label --query Q --target NOTE/);
  assert.match(tuneHelp, /testset add --query Q --target NOTE/);
  assert.match(tuneHelp, /Progress:/);
  const contextHelp = run(env, ["context", "--help"]);
  assert.match(contextHelp, /--include MODE/);
  const inboxHelp = run(env, ["inbox", "--help"]);
  assert.match(inboxHelp, /add --ref REF/);
  assert.match(inboxHelp, /triage --apply/);
  const linkHelp = run(env, ["link", "--help"]);
  assert.match(linkHelp, /plan --output PATH/);
  const refactorHelp = run(env, ["refactor", "--help"]);
  assert.match(refactorHelp, /ipa refactor tag-remove TAG/);
  assert.match(refactorHelp, /ipa refactor tag-add TAG/);
  assert.match(refactorHelp, /ipa refactor ref-add REF/);
  assert.match(refactorHelp, /`refactor` is vault-wide/);
  assert.match(refactorHelp, /ipa list-refactors/);
  const reviewHelp = run(env, ["review", "--help"]);
  assert.match(reviewHelp, /--content/);
  const contractHelp = run(env, ["contract", "--help"]);
  assert.match(contractHelp, /export-fixtures --target DIR/);
  const noteHelp = run(env, ["note", "--help"]);
  assert.match(noteHelp, /Usage: ipa \[OPTIONS\] note replace/);
  assert.match(noteHelp, /--old-file PATH/);
  assert.match(noteHelp, /--allow-multiple/);
  const channels = run(env, ["--profile", "ipa-test", "list-channels"]);
  assert.match(channels, /search channels \(9\)/);
  assert.match(channels, /body_match\s+0\.3630/);
  const rules = run(env, ["--profile", "ipa-test", "list-rules"]);
  assert.match(rules, /validator rules \(16\)/);
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
  const linkSuggest = run(env, ["--profile", "ipa-test", "link", "suggest", "Alpha"]);
  assert.match(linkSuggest, /Link suggestions/);
  assert.match(linkSuggest, /Suggestion\s+Score/);
  assert.match(linkSuggest, /Beta\s+1/);
  assert.doesNotMatch(linkSuggest, /Note\s+Path/);
  const linkSuggestJson = JSON.parse(run(env, ["--profile", "ipa-test", "--json", "link", "suggest", "Alpha"]));
  assert.equal(linkSuggestJson.suggestions[0].target, "Beta");
  assert.equal(linkSuggestJson.suggestions[0].score, 1);
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
  const oldFile = join(vault, "..", "old.txt");
  const newFile = join(vault, "..", "new.txt");
  await writeFile(oldFile, "Alpha mentions Beta", "utf8");
  await writeFile(newFile, "Alpha mentions Gamma", "utf8");
  const replacePreview = run(env, ["--profile", "ipa-test", "note", "replace", "Alpha", "--old-file", oldFile, "--new-file", newFile]);
  assert.match(replacePreview, /applied\s+false/);
  assert.doesNotMatch(await readFile(join(vault, "00 Inbox", "Alpha.md"), "utf8"), /Gamma/);
  const replaceApply = JSON.parse(run(env, ["--profile", "ipa-test", "--json", "note", "replace", "Alpha", "--old-file", oldFile, "--new-file", newFile, "--apply"]));
  assert.equal(replaceApply.operation, "replace-in-note");
  assert.equal(replaceApply.matches, 1);
  assert.match(await readFile(join(vault, "00 Inbox", "Alpha.md"), "utf8"), /Alpha mentions Gamma/);
  const oldMetaFile = join(vault, "..", "old-meta.txt");
  const newMetaFile = join(vault, "..", "new-meta.txt");
  await writeFile(oldMetaFile, "date_created: 2026/05/10 (Sun) 00:00:00", "utf8");
  await writeFile(newMetaFile, "date_created: 2026/05/11 (Mon) 00:00:00", "utf8");
  const replaceFrontmatter = JSON.parse(run(env, ["--profile", "ipa-test", "--json", "note", "replace", "Alpha", "--old-file", oldMetaFile, "--new-file", newMetaFile, "--apply"]));
  assert.equal(replaceFrontmatter.matches, 1);
  assert.match(await readFile(join(vault, "00 Inbox", "Alpha.md"), "utf8"), /date_created: 2026\/05\/11 \(Mon\) 00:00:00/);
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
  assert.match(rules, /validator rules \(16\)/);
  assert.match(rules, /ipa\.heading\.no_h1\s+heading\s+info\s+note\s+yes\s+on\s+builtin/);
  const refactors = run(env, [...profile, "list-refactors"]);
  assert.match(refactors, /refactor commands \(7\)/);
  assert.match(refactors, /ref-replace\s+frontmatter ref 교체 \(전체 vault\)/);
  assert.match(refactors, /ref-remove\s+frontmatter ref 제거 \(전체 vault\)/);
});

test("harness help lists opencode target, selector options, and default full install", async () => {
  const { env } = await fixtureProfile();
  const help = run(env, ["harness", "--help"]);
  assert.match(help, /ipa harness install opencode/);
  assert.match(help, /ipa harness install opencode --without hook:evidence/);
  assert.match(help, /ipa harness install opencode --only skill,prompt/);
  assert.match(help, /ipa harness install codex --only hook:guard/);
  assert.match(help, /--only <component\.\.\.>/);
  assert.match(help, /--with <component\.\.\.>/);
  assert.match(help, /--without <component\.\.\.>/);
  assert.match(help, /default full install/i);
});

test("harness install accepts component selectors for opencode and codex", async () => {
  const { env } = await fixtureProfile();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const harnessEnv = { ...env, IPA_HARNESS_HOME: home };

  // JSON: install opencode --only skill,prompt --with hook:evidence
  const onlyWith = JSON.parse(
    run(harnessEnv, ["--json", "harness", "install", "opencode", "--only", "skill,prompt", "--with", "hook:evidence"])
  );
  assert.equal(onlyWith.status, "ok");
  assert.equal(onlyWith.target, "opencode");
  assert.equal(onlyWith.installed, true);

  // JSON: install opencode --without hook:evidence
  const without = JSON.parse(
    run(harnessEnv, ["--json", "harness", "install", "opencode", "--without", "hook:evidence"])
  );
  assert.equal(without.status, "ok");
  assert.equal(without.target, "opencode");
  assert.equal(without.installed, true);

  // JSON: install codex --only hook:guard
  const codexOnly = JSON.parse(
    run(harnessEnv, ["--json", "harness", "install", "codex", "--only", "hook:guard"])
  );
  assert.equal(codexOnly.status, "ok");
  assert.equal(codexOnly.target, "codex");
  assert.equal(codexOnly.installed, true);

  // Invalid selector: nonzero exit with unknown component error
  const invalid = runRaw(harnessEnv, ["--json", "harness", "install", "opencode", "--only", "nope"]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /unknown harness component: nope/);
});

test("agent-efficiency surface: snippets, digest, multi-view, note set, replace cleanup", async () => {
  const { vault, env } = await fixtureProfile();

  // search results carry modified date + snippet in JSON and human output.
  const search = JSON.parse(run(env, ["--profile", "ipa-test", "search", "Alpha", "--json"]));
  assert.equal(search.results[0].note, "Alpha");
  assert.equal(search.results[0].modified, "2026/05/10 (Sun) 00:00:00");
  assert.match(search.results[0].snippet, /Alpha mentions Beta/);
  const humanSearch = run(env, ["--profile", "ipa-test", "search", "Alpha"]);
  assert.match(humanSearch, /└ 2026\/05\/10 · Alpha mentions Beta/);

  // digest summarizes an index's children in one call.
  const digest = run(env, ["--profile", "ipa-test", "digest", "🔖 Topic Index"]);
  assert.match(digest, /Digest for '🔖 Topic Index' \[index\]/);
  assert.match(digest, /- Alpha {2}\[note\] {2}\(2026\/05\/10\)/);
  assert.match(digest, /Alpha mentions Beta in plain text\./);
  const digestJson = JSON.parse(run(env, ["--profile", "ipa-test", "--json", "digest", "🔖 Topic Index", "--max", "1"]));
  assert.equal(digestJson.children_shown, 1);
  assert.ok(digestJson.children_total >= 2);
  assert.ok(digestJson.items[0].headings.length >= 1);

  // view accepts several titles in one call.
  const multi = run(env, ["--profile", "ipa-test", "view", "Alpha", "Beta"]);
  assert.match(multi, /=== Alpha \[note\] ===/);
  assert.match(multi, /=== Beta \[note\] ===/);

  // note set edits frontmatter without exact-match blocks and syncs date_modified.
  const setOut = run(env, ["--profile", "ipa-test", "note", "set", "Alpha", "--field", "tags", "--add", "extra", "--apply"]);
  assert.match(setOut, /operation\s+set-note-field/);
  assert.match(setOut, /updated_at_synced\s+true/);
  let alpha = await readFile(join(vault, "00 Inbox", "Alpha.md"), "utf8");
  assert.match(alpha, /extra/);
  assert.doesNotMatch(alpha, /date_modified: "?2026\/05\/10/);

  const scalarOut = run(env, ["--profile", "ipa-test", "note", "set", "Alpha", "--field", "obsidianUIMode", "--value", "source", "--apply"]);
  assert.match(scalarOut, /applied\s+true/);
  alpha = await readFile(join(vault, "00 Inbox", "Alpha.md"), "utf8");
  assert.match(alpha, /obsidianUIMode: source/);

  // note set on refs wraps values as wikilinks.
  run(env, ["--profile", "ipa-test", "note", "set", "Beta", "--field", "ref", "--add", "🔖 Topic Index", "--apply"]);
  const beta = await readFile(join(vault, "00 Inbox", "Beta.md"), "utf8");
  assert.match(beta, /\[\[🔖 Topic Index\]\]/);

  // note replace --apply removes consumed .tmp files; preview keeps them.
  const tmpDir = join(vault, ".tmp");
  await mkdir(tmpDir, { recursive: true });
  const oldFile = join(tmpDir, "old.txt");
  const newFile = join(tmpDir, "new.txt");
  await writeFile(oldFile, "Alpha mentions Beta in plain text.", "utf8");
  await writeFile(newFile, "Alpha mentions Beta and Gamma in plain text.", "utf8");
  const preview = run(env, ["--profile", "ipa-test", "note", "replace", "Alpha", "--old-file", oldFile, "--new-file", newFile]);
  assert.match(preview, /applied\s+false/);
  assert.equal(existsSync(oldFile), true);
  assert.equal(existsSync(newFile), true);
  const applied = run(env, ["--profile", "ipa-test", "note", "replace", "Alpha", "--old-file", oldFile, "--new-file", newFile, "--apply"]);
  assert.match(applied, /applied\s+true/);
  // updated_at may already equal "now" from the note set writes in the same
  // second, so only assert the field is reported, not its value.
  assert.match(applied, /updated_at_synced/);
  assert.match(applied, /cleaned_files/);
  assert.equal(existsSync(oldFile), false);
  assert.equal(existsSync(newFile), false);
  alpha = await readFile(join(vault, "00 Inbox", "Alpha.md"), "utf8");
  assert.match(alpha, /Alpha mentions Beta and Gamma/);

  // --keep-files preserves the inputs.
  await writeFile(oldFile, "Alpha mentions Beta and Gamma in plain text.", "utf8");
  await writeFile(newFile, "Alpha mentions Beta in plain text.", "utf8");
  run(env, ["--profile", "ipa-test", "note", "replace", "Alpha", "--old-file", oldFile, "--new-file", newFile, "--apply", "--keep-files"]);
  assert.equal(existsSync(oldFile), true);

  // formatter plan surfaces apply-gated rule patches without writing.
  const planHelp = run(env, ["digest", "--help"]);
  assert.match(planHelp, /Summarize an index\/root note/);
});

test("multi-title set/digest, note redirect, and cascade run through the CLI", async () => {
  const { vault, env } = await fixtureProfile();

  const multiSet = run(env, ["--profile", "ipa-test", "note", "set", "Alpha", "Beta", "--field", "tags", "--add", "shared", "--apply"]);
  assert.ok((multiSet.match(/operation\s+set-note-field/g) ?? []).length === 2);
  assert.match(await readFile(join(vault, "00 Inbox", "Alpha.md"), "utf8"), /shared/);
  assert.match(await readFile(join(vault, "00 Inbox", "Beta.md"), "utf8"), /shared/);

  const multiDigest = run(env, ["--profile", "ipa-test", "digest", "🔖 Topic Index", "🏷️ Topic Root"]);
  assert.match(multiDigest, /Digest for '🔖 Topic Index'/);
  assert.match(multiDigest, /Digest for '🏷️ Topic Root'/);

  const cascade = run(env, ["--profile", "ipa-test", "cascade", "plan", "--note", "Beta"]);
  assert.match(cascade, /Cascade \(plan\) for 'Beta'/);

  const preview = run(env, ["--profile", "ipa-test", "note", "redirect", "Alpha", "--to", "Beta"]);
  assert.match(preview, /Note redirect \(preview\)/);
  assert.match(preview, /--apply/);
  const applied = run(env, ["--profile", "ipa-test", "note", "redirect", "Alpha", "--to", "Beta", "--archive", "--apply"]);
  assert.match(applied, /Note redirect \(applied\)/);
  assert.equal(existsSync(join(vault, "02 Archive", "Alpha.md")), true);
  assert.doesNotMatch(await readFile(join(vault, "01 Project", "🔖 Topic Index.md"), "utf8"), /\[\[Alpha\]\]/);

  const reviewOut = run(env, ["--profile", "ipa-test", "review", "sot"]);
  assert.match(reviewOut, /Issues|No issues\./);
});

test("--version prints the workspace version with commit hash", async () => {
  const { env } = await fixtureProfile();
  const out = run(env, ["--version"]);
  assert.match(out, /^ipa \d+\.\d+\.\d+/);
  const json = JSON.parse(run(env, ["--json", "--version"]));
  assert.match(json.version, /^\d+\.\d+\.\d+/);
  assert.ok(json.repo_root);
});

test("update plans against an IPA_UPDATE_REPO_ROOT checkout without modifying it", async () => {
  const { env } = await fixtureProfile();
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const work = await mkdtemp(join(tmpdir(), "ipa-cli-update-"));
  const origin = join(work, "origin");
  await mkdir(origin, { recursive: true });
  git(origin, "init", "-b", "main");
  git(origin, "config", "user.email", "test@example.com");
  git(origin, "config", "user.name", "test");
  await writeFile(join(origin, "README.md"), "v1\n", "utf8");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "first");
  const clone = join(work, "clone");
  git(work, "clone", origin, clone);
  await writeFile(join(origin, "README.md"), "v2\n", "utf8");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "second");

  const plan = JSON.parse(run({ ...env, IPA_UPDATE_REPO_ROOT: clone }, ["--json", "update"]));
  assert.equal(plan.mode, "plan");
  assert.equal(plan.behind, 1);
  assert.equal(plan.up_to_date, false);
  assert.deepEqual(plan.commands, ["git pull --ff-only", "pnpm install", "pnpm run build"]);
  assert.equal(await readFile(join(clone, "README.md"), "utf8"), "v1\n", "plan must not modify the checkout");

  const help = run(env, ["help", "update"]);
  assert.match(help, /git pull --ff-only/);
  assert.match(help, /ipa harness update/);
});

test("harness status flags stale components and harness update reinstalls them via CLI", async () => {
  const { env } = await fixtureProfile();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const harnessEnv = { ...env, IPA_HARNESS_HOME: home };
  run(harnessEnv, ["--json", "harness", "install", "codex"]);

  const hook = join(home, ".codex", "hooks", "ipa-inbox-guard.mjs");
  await writeFile(hook, `${await readFile(hook, "utf8")}\n// stale\n`, "utf8");
  const status = JSON.parse(run(harnessEnv, ["--json", "harness", "status"]));
  assert.deepEqual(status.outdated, { codex: ["hook:guard"] });
  assert.match(status.update_hint, /ipa harness update codex/);

  const updated = JSON.parse(run(harnessEnv, ["--json", "harness", "update", "codex"]));
  assert.equal(updated.status, "ok");
  assert.equal(updated.updated, true);
  const statusAfter = JSON.parse(run(harnessEnv, ["--json", "harness", "status"]));
  assert.deepEqual(statusAfter.outdated, {});
  assert.equal(statusAfter.update_hint, null);

  const missing = runRaw(harnessEnv, ["--json", "harness", "update", "claude"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /not_installed/);
});

test("validator --note restricts reported issues to the edited notes", async () => {
  const { vault, env } = await fixtureProfile();
  await writeFile(
    join(vault, "00 Inbox", "Scoped.md"),
    `---\ndate_created: 2026/05/10 (Sun) 00:00:00\ndate_modified: 2026/05/10 (Sun) 00:00:00\nref: ["[[🔖 Topic Index]]"]\ntags: ["BadTag"]\ntype: note\n---\n# Scoped\n\nBody\n`,
    "utf8"
  );
  const scoped = JSON.parse(run(env, ["--json", "validator", "--note", "Scoped"]));
  assert.deepEqual(scoped.scope_notes, ["Scoped"]);
  assert.ok(scoped.issues.length >= 1);
  assert.ok(scoped.issues.every((item) => item.note === "Scoped" || (item.path ?? "").includes("Scoped")));
  const help = run(env, ["help", "validator"]);
  assert.match(help, /--note NOTE/);
});

test("vault-wide validator text output is capped per code with a summary table", async () => {
  const { vault, env } = await fixtureProfile();
  for (let i = 0; i < 35; i += 1) {
    await writeFile(
      join(vault, "00 Inbox", `Noisy ${i}.md`),
      `---\ndate_created: 2026/05/10 (Sun) 00:00:00\ndate_modified: 2026/05/10 (Sun) 00:00:00\nref: ["[[🔖 Topic Index]]"]\ntags: ["BadTag${i}"]\ntype: note\n---\n# Noisy ${i}\n\nBody\n`,
      "utf8"
    );
  }
  const text = run(env, ["validator"]);
  assert.match(text, /more issue\(s\) hidden/);
  assert.match(text, /Count/);
  const rowCount = (text.match(/ipa\.tag\.snake_case/g) ?? []).length;
  assert.ok(rowCount <= 7, `snake_case rows should be capped, got ${rowCount}`);

  const json = JSON.parse(run(env, ["--json", "validator"]));
  assert.ok(json.issues.filter((item) => item.code === "ipa.tag.snake_case").length >= 35, "--json keeps the full list");
});

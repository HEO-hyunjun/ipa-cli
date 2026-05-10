import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildContext,
  cacheStatus,
  formatVault,
  loadNotes,
  linkApply,
  linkPlan,
  listPlugins,
  pluginDryRun,
  readVaultConfig,
  refactorVault,
  resolveSettings,
  rebuildCache,
  reviewVault,
  searchVault,
  traversal,
  tuneEval,
  tuneRun,
  tuneUse,
  validateVault,
  viewNote
} from "../dist/index.js";

const root = dirname(fileURLToPath(import.meta.url)) + "/../../..";

async function fixtureVault() {
  const work = await mkdtemp(join(tmpdir(), "ipa-core-test-"));
  const vault = join(work, "vault");
  await cp(join(root, "packages", "test-vaults", "fixtures", "mini-vault"), vault, { recursive: true });
  return vault;
}

test("loads declarative config mapping and parses notes", async () => {
  const vault = await fixtureVault();
  const { mapping } = await readVaultConfig(vault);
  const notes = await loadNotes(vault, mapping);
  assert.equal(mapping.refs, "ref");
  assert.equal(notes.length, 4);
  assert.deepEqual(notes.find((note) => note.id === "Alpha").refs, ["🔖 Topic Index"]);
});

test("profile and vault overrides resolve in the documented priority order", async () => {
  const vault = await fixtureVault();
  const other = await fixtureVault();
  const xdg = await mkdtemp(join(tmpdir(), "ipa-profile-test-"));
  await mkdir(join(xdg, "ipa"), { recursive: true });
  await writeFile(
    join(xdg, "ipa", "profile.yaml"),
    `profiles:\n  ipa-test:\n    vault_path: ${vault}\n    default: true\n  other:\n    vault_path: ${other}\n`,
    "utf8"
  );
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousVault = process.env.IPA_VAULT_PATH;
  const previousProfile = process.env.IPA_PROFILE;
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.IPA_VAULT_PATH = other;
  process.env.IPA_PROFILE = "other";
  try {
    assert.equal((await resolveSettings({ profile: "ipa-test" })).vaultPath, vault);
    assert.equal((await resolveSettings({ vault })).vaultPath, vault);
    assert.equal((await resolveSettings({})).vaultPath, other);
    await assert.rejects(() => resolveSettings({ profile: "missing-profile" }), /unknown profile: missing-profile/);
    process.env.IPA_PROFILE = "missing-profile";
    await assert.rejects(() => resolveSettings({}), /unknown profile: missing-profile/);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    if (previousVault === undefined) delete process.env.IPA_VAULT_PATH;
    else process.env.IPA_VAULT_PATH = previousVault;
    if (previousProfile === undefined) delete process.env.IPA_PROFILE;
    else process.env.IPA_PROFILE = previousProfile;
  }
});

test("link plan records a content hash and apply rejects stale files", async () => {
  const vault = await fixtureVault();
  const plan = await linkPlan(vault, { note: "Alpha" });
  assert.equal(plan.changes[0].target, "Beta");
  assert.ok(plan.changes[0].sha256);
  await writeFile(join(vault, "00 Inbox", "Alpha.md"), "changed", "utf8");
  await writeFile(join(vault, ".ipa", "plans", "link.json"), JSON.stringify(plan), "utf8").catch(async () => {
    await mkdir(join(vault, ".ipa", "plans"), { recursive: true });
    await writeFile(join(vault, ".ipa", "plans", "link.json"), JSON.stringify(plan), "utf8");
  });
  await assert.rejects(() => linkApply(vault, ".ipa/plans/link.json"), /hash guard failed/);
});

test("search, view, traversal and context work in the JS runtime", async () => {
  const vault = await fixtureVault();
  const search = await searchVault(vault, "Alpha", { threshold: 0, maxResults: 3 });
  assert.equal(search.results[0].note, "Alpha");
  const overview = await viewNote(vault, "Alpha");
  assert.match(overview, /## Structure/);
  assert.match(overview, /다음:/);
  const full = await viewNote(vault, "Alpha", { full: true });
  assert.match(full, /=== Alpha \[note\] ===/);
  assert.match(full, /Path:/);
  assert.match(full, /Alpha mentions Beta/);
  assert.match(full, /연결: ↗ outlinks 0  ↩ backlinks 2  ⇄ siblings 1/);
  assert.match(full, /다음:/);
  const section = await viewNote(vault, "Alpha", { section: "Details", full: true });
  assert.match(section, /## Details/);
  assert.doesNotMatch(section, /# Alpha/);
  assert.doesNotMatch(section, /다음:/);
  const up = await traversal(vault, "up", "Alpha");
  assert.deepEqual(up.paths[0], ["Alpha", "🔖 Topic Index", "🏷️ Topic Root"]);
  const down = await traversal(vault, "down", "🔖 Topic Index");
  assert.deepEqual(down.tree.children.map((child) => child.note), ["Alpha", "Beta"]);
  const context = await buildContext(vault, "Alpha", { byNote: true });
  assert.equal(context.notes[0].id, "Alpha");
});

test("validator, cache, review and tune contracts are available", async () => {
  const vault = await fixtureVault();
  const validation = await validateVault(vault);
  assert.equal(validation.status, "ok");
  const cache = await rebuildCache(vault);
  assert.equal(cache.manifest.file_count, 4);
  assert.deepEqual((await cacheStatus(vault)).stale, []);
  const review = await reviewVault(vault, "all");
  assert.equal(review.status, "ok");
  const evalResult = await tuneEval(vault, "ipa-cli-core");
  assert.equal(evalResult.total, 3);
  assert.equal(evalResult.misses, 0);
  const runResult = await tuneRun(vault, { trials: 3 });
  assert.equal(runResult.optimizer, "tpe-lite");
  const history = await readFile(join(vault, ".ipa", "tune", "history.jsonl"), "utf8");
  assert.equal(history.trim().split("\n").length, 3);
});

test("activated tune results are applied to search defaults", async () => {
  const vault = await fixtureVault();
  await mkdir(join(vault, ".ipa", "tune", "results"), { recursive: true });
  await writeFile(
    join(vault, ".ipa", "tune", "results", "active.json"),
    JSON.stringify({ best: { params: { threshold: 2, cap: 1, weights: { filename: 0 } } } }),
    "utf8"
  );
  await tuneUse(vault, "active.json");
  assert.equal((await searchVault(vault, "Alpha")).count, 0);
  const override = await searchVault(vault, "Alpha", { threshold: 0, maxResults: 3, weights: {} });
  assert.equal(override.results[0].note, "Alpha");
});

test("no-op refactor does not rewrite every note", async () => {
  const vault = await fixtureVault();
  const alphaPath = join(vault, "00 Inbox", "Alpha.md");
  const before = await readFile(alphaPath, "utf8");
  const result = await refactorVault(vault, "tag-remove", ["missing_tag"], { apply: true });
  assert.deepEqual(result.changed, []);
  assert.equal(await readFile(alphaPath, "utf8"), before);
});

test("vault-local JS plugins run in search, validation and formatter paths", async () => {
  const vault = await fixtureVault();
  await mkdir(join(vault, ".ipa", "plugins", "search"), { recursive: true });
  await mkdir(join(vault, ".ipa", "plugins", "lint"), { recursive: true });
  await mkdir(join(vault, ".ipa", "plugins", "formatter"), { recursive: true });
  await writeFile(
    join(vault, ".ipa", "plugins", "search", "sample.js"),
    `export async function search(query, notes) {
      if (query !== "plugin-only") return [];
      return [{ note: "Beta", score: 3, reason: { matched: "plugin" } }];
    }\n`,
    "utf8"
  );
  await writeFile(
    join(vault, ".ipa", "plugins", "lint", "sample.js"),
    `export async function lint(note) {
      return note.id === "Alpha" ? [{ code: "sample.alpha", severity: "warn", message: "plugin lint issue" }] : [];
    }\n`,
    "utf8"
  );
  await writeFile(
    join(vault, ".ipa", "plugins", "formatter", "sample.js"),
    `export async function format(note) {
      return note.id === "Alpha" ? [{ line: 1, replacement: "formatted" }] : [];
    }\n`,
    "utf8"
  );
  assert.equal((await listPlugins(vault)).plugins.length, 3);
  const dryRun = await pluginDryRun(vault, "search", ".ipa/plugins/search/sample.js", { query: "Alpha" });
  assert.deepEqual(dryRun.results, []);
  const search = await searchVault(vault, "plugin-only");
  assert.equal(search.results[0].note, "Beta");
  assert.equal(search.results[0].reasons["plugin:sample.js"].matched, "plugin");
  const validation = await validateVault(vault);
  assert.ok(validation.issues.some((item) => item.code === "sample.alpha" && item.plugin === ".ipa/plugins/lint/sample.js"));
  const format = await formatVault(vault);
  assert.ok(format.patches.some((item) => item.note === "Alpha" && item.plugin === ".ipa/plugins/formatter/sample.js"));
  await writeFile(
    join(vault, ".ipa", "config.yaml"),
    `mapping:\n  fields:\n    note_type: type\n    refs: ref\n    tags: tags\n    created_at: date_created\n    updated_at: date_modified\n    aliases: aliases\n  folders:\n    inbox: 00 Inbox\n    project: 01 Project\n    archive: 02 Archive\nplugins:\n  search: false\n`,
    "utf8"
  );
  assert.equal((await listPlugins(vault)).plugins.length, 2);
  await writeFile(
    join(vault, ".ipa", "config.yaml"),
    `mapping:\n  fields:\n    note_type: type\n    refs: ref\n    tags: tags\n    created_at: date_created\n    updated_at: date_modified\n    aliases: aliases\n  folders:\n    inbox: 00 Inbox\n    project: 01 Project\n    archive: 02 Archive\nplugins: false\n`,
    "utf8"
  );
  assert.equal((await listPlugins(vault)).plugins.length, 0);
});

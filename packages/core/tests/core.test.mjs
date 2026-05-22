import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildContext,
  cacheStatus,
  formatVault,
  inboxAdd,
  IpaNoteDocument,
  isExcalidrawMarkdownFile,
  loadNotes,
  MarkdownDocument,
  linkApply,
  linkPlan,
  listPlugins,
  listRules,
  listSearchChannels,
  pluginDryRun,
  readVaultConfig,
  refactorVault,
  replaceInNote,
  resolveSettings,
  rewriteNote,
  rebuildCache,
  reviewVault,
  searchVault,
  scoreNote,
  traversal,
  harnessDoctor,
  harnessGuardCheck,
  harnessInstall,
  harnessStatus,
  harnessUninstall,
  tuneAnalyze,
  tuneEval,
  tuneLabel,
  tuneLog,
  tuneReplay,
  tuneRun,
  tuneTestsetAdd,
  tuneTestsetDraft,
  tuneTestsetInit,
  tuneTestsetList,
  tuneTestsetShow,
  tuneTestsetValidate,
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

test("project search channel follows configured folder mapping", async () => {
  const vault = await fixtureVault();
  await mkdir(join(vault, "20 Active"), { recursive: true });
  await writeFile(
    join(vault, ".ipa", "config.yaml"),
    `mapping:\n  fields:\n    note_type: type\n    refs: ref\n    tags: tags\n    created_at: date_created\n    updated_at: date_modified\n    aliases: aliases\n  folders:\n    inbox: 00 Inbox\n    project: 20 Active\n    archive: 02 Archive\n`,
    "utf8"
  );
  await writeFile(
    join(vault, "20 Active", "Custom Project Index.md"),
    `---\ndate_created: 2026-05-10T00:00:00.000Z\ndate_modified: 2026-05-10T00:00:00.000Z\ntype: index\nref: []\ntags: [custom]\n---\n# Custom Project Index\n`,
    "utf8"
  );

  const { mapping } = await readVaultConfig(vault);
  const notes = await loadNotes(vault, mapping);
  const note = notes.find((item) => item.id === "Custom Project Index");
  assert.ok(note);
  assert.equal(scoreNote(note, "Custom", notes, {}, mapping).channelScores.project, 1);
  assert.equal(scoreNote(note, "Custom", notes, {}, { ...mapping, project_dir: "01 Project" }).channelScores.project, 0);
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
    const project = await mkdtemp(join(tmpdir(), "ipa-local-profile-"));
    await writeFile(join(project, ".ipa-profile"), "ipa-test\n", "utf8");
    const projectWithConfig = await mkdtemp(join(tmpdir(), "ipa-local-config-"));
    await writeFile(join(projectWithConfig, ".ipa-config"), `vault_path: ${vault}\n`, "utf8");
    const projectWithOtherConfig = await mkdtemp(join(tmpdir(), "ipa-local-config-"));
    await writeFile(join(projectWithOtherConfig, ".ipa-config"), `vault_path: ${other}\n`, "utf8");
    assert.equal((await resolveSettings({ profile: "ipa-test" })).vaultPath, vault);
    assert.equal((await resolveSettings({ profile: "ipa-test", cwd: projectWithOtherConfig })).vaultPath, vault);
    assert.equal((await resolveSettings({ vault })).vaultPath, vault);
    assert.equal((await resolveSettings({ vault: "~/ipa" })).vaultPath, join(homedir(), "ipa"));
    assert.equal((await resolveSettings({ cwd: project })).vaultPath, vault);
    assert.equal((await resolveSettings({ cwd: projectWithConfig })).vaultPath, vault);
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
  assert.equal(context.mode, "by-note");
  assert.equal(context.size, "medium");
  assert.equal(context.notes[0].location.kind, "inbox");
  assert.equal(context.notes[0].ref_details[0].location.kind, "project");
  assert.ok(context.notes[0].overview.headings.some((heading) => heading.title === "Details"));
  assert.equal(context.notes[0].excerpt, undefined);
  assert.ok(context.search_results[0].location.kind === "inbox");
  assert.ok(context.ref_distribution.some((item) => item.ref === "🔖 Topic Index" && item.location.kind === "project"));
  assert.ok(context.tag_distribution.some((item) => item.tag === "note"));
  assert.ok(context.notes[0].upward_paths.some((path) => path.join(" -> ") === "Alpha -> 🔖 Topic Index -> 🏷️ Topic Root"));
  assert.ok(context.notes[0].backlinks.some((note) => note.id === "Beta"));
  assert.ok(context.notes[0].siblings.some((note) => note.id === "Beta"));
  assert.deepEqual(context.edges.Alpha, ["🔖 Topic Index"]);
  assert.ok(context.next_commands.includes('ipa search "Alpha"'));
  const largeContext = await buildContext(vault, "Alpha", { byNote: true, size: "large" });
  assert.equal(largeContext.notes[0].content_mode, "full");
  assert.match(largeContext.notes[0].body, /Alpha mentions Beta/);
  assert.equal(largeContext.notes[0].overview, undefined);
});

test("view uses a fresh note cache and falls back after cache stales", async () => {
  const vault = await fixtureVault();
  await rebuildCache(vault);
  const betaPath = join(vault, "00 Inbox", "Beta.md");

  await chmod(betaPath, 0o000);
  try {
    const cached = await viewNote(vault, "Alpha", { full: true });
    assert.match(cached, /연결: ↗ outlinks 0  ↩ backlinks 2  ⇄ siblings 1/);
  } finally {
    await chmod(betaPath, 0o600);
  }

  await writeFile(
    betaPath,
    `---\ndate_created: 2026/05/10 (Sun) 00:00:00\ndate_modified: 2026/05/10 (Sun) 00:00:00\nref:\n  - "[[🔖 Topic Index]]"\nobsidianUIMode: preview\ntags:\n  - note\ntype: note\n---\n# Beta\n\nBeta no longer links back.\n`,
    "utf8"
  );
  const staleFallback = await viewNote(vault, "Alpha", { full: true });
  assert.match(staleFallback, /연결: ↗ outlinks 0  ↩ backlinks 1  ⇄ siblings 1/);
  const status = await cacheStatus(vault);
  assert.deepEqual(status.stale, []);
  assert.equal(status.manifest.rebuild_mode, "incremental");
  assert.equal(status.manifest.changes.changed, 1);
});

test("cache rebuild updates changed notes without reparsing unchanged files", async () => {
  const vault = await fixtureVault();
  await rebuildCache(vault);
  const alphaPath = join(vault, "00 Inbox", "Alpha.md");
  const betaPath = join(vault, "00 Inbox", "Beta.md");
  await writeFile(
    betaPath,
    `---\ndate_created: 2026/05/10 (Sun) 00:00:00\ndate_modified: 2026/05/10 (Sun) 00:00:00\nref:\n  - "[[🔖 Topic Index]]"\nobsidianUIMode: preview\ntags:\n  - note\ntype: note\n---\n# Beta\n\nBeta changed after cache build.\n`,
    "utf8"
  );

  await chmod(alphaPath, 0o000);
  try {
    const result = await rebuildCache(vault);
    assert.equal(result.mode, "incremental");
    assert.deepEqual(result.cache_changes, { added: 0, changed: 1, deleted: 0 });
    assert.deepEqual((await cacheStatus(vault)).stale, []);
  } finally {
    await chmod(alphaPath, 0o600);
  }
});

test("note-name search and lookup ignore emoji markers but preserve display names", async () => {
  const vault = await fixtureVault();
  const search = await searchVault(vault, "Topic Index", { threshold: 0, maxResults: 5 });
  assert.ok(search.results.some((hit) => hit.note === "🔖 Topic Index"));
  assert.match(await viewNote(vault, "Topic Index", { full: true }), /^=== 🔖 Topic Index \[index\]/);
  assert.equal((await traversal(vault, "down", "Topic Index")).note, "🔖 Topic Index");

  await writeFile(
    join(vault, "00 Inbox", "No Emoji Ref.md"),
    `---\ndate_created: 2026-05-10T00:00:00.000Z\ndate_modified: 2026-05-10T00:00:00.000Z\ntype: note\nref: ["[[Topic Index]]"]\ntags: [lookup]\n---\n# No Emoji Ref\n`,
    "utf8"
  );
  assert.equal((await validateVault(vault)).status, "ok");
  const down = await traversal(vault, "down", "🔖 Topic Index");
  assert.ok(down.tree.children.some((child) => child.note === "No Emoji Ref"));
});

test("core note rewrite helpers resolve notes before editing", async () => {
  const vault = await fixtureVault();
  const dryRun = await rewriteNote(vault, "Alpha", (document) => document.text.replace("Alpha mentions Beta", "Alpha mentions Gamma"), { apply: false });
  assert.equal(dryRun.changed, true);
  assert.equal(dryRun.applied, false);
  assert.doesNotMatch(await readFile(join(vault, "00 Inbox", "Alpha.md"), "utf8"), /Gamma/);

  const applied = await replaceInNote(vault, "Alpha", "Alpha mentions Beta", "Alpha mentions Gamma");
  assert.equal(applied.operation, "replace-in-note");
  assert.equal(applied.matches, 1);
  assert.equal(applied.applied, true);
  assert.match(await readFile(join(vault, "00 Inbox", "Alpha.md"), "utf8"), /Alpha mentions Gamma/);

  const frontmatterApplied = await replaceInNote(
    vault,
    "Alpha",
    "date_created: 2026/05/10 (Sun) 00:00:00",
    "date_created: 2026/05/11 (Mon) 00:00:00"
  );
  assert.equal(frontmatterApplied.matches, 1);
  assert.match(await readFile(join(vault, "00 Inbox", "Alpha.md"), "utf8"), /date_created: 2026\/05\/11 \(Mon\) 00:00:00/);
});

test("indentless YAML sequences parse as lists instead of object refs", async () => {
  const vault = await fixtureVault();
  await writeFile(
    join(vault, "00 Inbox", "Indentless Ref.md"),
    `---\ndate_created: 2026-05-10T00:00:00.000Z\ndate_modified: 2026-05-10T00:00:00.000Z\ntype: note\nref:\n- '[[🔖 Topic Index]]'\ntags:\n- yaml\n---\n# Indentless Ref\n`,
    "utf8"
  );

  const notes = await loadNotes(vault, (await readVaultConfig(vault)).mapping);
  const note = notes.find((item) => item.id === "Indentless Ref");
  assert.deepEqual(note.refs, ["🔖 Topic Index"]);
  assert.deepEqual(note.tags, ["yaml"]);
  const search = await searchVault(vault, "Indentless Ref", { threshold: 0, maxResults: 1 });
  assert.deepEqual(search.results[0].refs, ["🔖 Topic Index"]);
});

test("note lookup and graph matching normalize macOS decomposed filenames", async () => {
  const vault = await fixtureVault();
  const indexName = "🔖 한글 인덱스";
  const noteName = "한글 노트";
  await writeFile(
    join(vault, "01 Project", `${indexName.normalize("NFD")}.md`),
    `---\ndate_created: 2026-05-10T00:00:00.000Z\ndate_modified: 2026-05-10T00:00:00.000Z\ntype: index\nref: ["[[🏷️ Topic Root]]"]\ntags: [unicode_test]\n---\n# ${indexName}\n`,
    "utf8"
  );
  await writeFile(
    join(vault, "00 Inbox", `${noteName.normalize("NFD")}.md`),
    `---\ndate_created: 2026-05-10T00:00:00.000Z\ndate_modified: 2026-05-10T00:00:00.000Z\ntype: note\nref: ["[[${indexName}]]"]\ntags: [unicode_test]\n---\n# ${noteName}\n\n[[${indexName}]]\n`,
    "utf8"
  );

  const notes = await loadNotes(vault, (await readVaultConfig(vault)).mapping);
  assert.ok(notes.some((note) => note.id === noteName));
  assert.match(await viewNote(vault, noteName, { full: true }), new RegExp(`# ${noteName}`));
  assert.deepEqual((await traversal(vault, "down", indexName)).tree.children.map((child) => child.note), [noteName]);
  assert.equal((await validateVault(vault)).status, "ok");
});

test("configured file excludes and code fences keep validator focused on notes", async () => {
  const vault = await fixtureVault();
  const configPath = join(vault, ".ipa", "config.yaml");
  await mkdir(join(vault, "99 Fixtures"), { recursive: true });
  await mkdir(join(vault, "00 Inbox", "Utility"), { recursive: true });
  await writeFile(join(vault, "AGENTS.md"), "# Agent instructions without IPA frontmatter\n", "utf8");
  await writeFile(join(vault, "99 Fixtures", "Excluded Target.md"), "# Excluded target\n", "utf8");
  await writeFile(join(vault, "00 Inbox", "Utility", "🏠 Home.md"), "# Home dashboard\n", "utf8");
  await writeFile(
    join(vault, "00 Inbox", "Utility", "Home.md"),
    `---\ndate_created: 2026-05-10T00:00:00.000Z\ndate_modified: 2026-05-10T00:00:00.000Z\ntype: note\nref: ["[[🔖 Topic Index]]"]\ntags: [utility]\n---\n# Home\n`,
    "utf8"
  );
  await writeFile(
    join(vault, "00 Inbox", "Code Fence Example.md"),
    `---\ndate_created: 2026-05-10T00:00:00.000Z\ndate_modified: 2026-05-10T00:00:00.000Z\ntype: note\nref: ["[[🔖 Topic Index]]", "[[Excluded Target]]", "[[Home]]"]\ntags: [parser]\n---\n# Code Fence Example\n\n[[Excluded Target]]\n[[Home]]\n\n\`\`\`md\n[[Missing Target In Code]]\n\`\`\`\n`,
    "utf8"
  );
  await writeFile(
    configPath,
    `${await readFile(configPath, "utf8")}\nfiles:\n  exclude:\n    - AGENTS.md\n    - 99 Fixtures/**\n    - "**/🏠 *"\n`,
    "utf8"
  );

  const notes = await loadNotes(vault, (await readVaultConfig(vault)).mapping);
  assert.equal(notes.some((note) => note.id === "AGENTS"), false);
  assert.equal(notes.some((note) => note.id === "Excluded Target"), false);
  assert.equal(notes.some((note) => note.id === "🏠 Home"), false);
  assert.equal(notes.some((note) => note.id === "Home"), true);
  assert.equal((await searchVault(vault, "Home", { threshold: 0.2, maxResults: 5 })).results.some((hit) => hit.note === "🏠 Home"), false);
  const validation = await validateVault(vault);
  assert.equal(validation.status, "ok");
  assert.equal(validation.issues.some((item) => item.message.includes("Excluded Target") || item.message.includes("Home")), false);
});

test("excalidraw markdown scenes are excluded from active note operations", async () => {
  const vault = await fixtureVault();
  const sketchPath = join(vault, "00 Inbox", "Sketch.excalidraw.md");
  const embeddedPath = join(vault, "00 Inbox", "Embedded Drawing.md");
  const rawScenePath = join(vault, "00 Inbox", "Raw Scene.md");
  await writeFile(
    sketchPath,
    `---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---\n==⚠ Switch to EXCALIDRAW VIEW. ⚠==\n\n# Excalidraw Data\n## Text Elements\nhello ^abc\n\n## Drawing\n~~~compressed-json\nabc\n~~~\n`,
    "utf8"
  );
  await writeFile(
    embeddedPath,
    `---\ndate_created: 2026/05/10 (Sun) 00:00:00\ndate_modified: 2026/05/10 (Sun) 00:00:00\ntype: note\nref: ["[[Sketch.excalidraw]]"]\ntags: [note]\n---\n# Embedded Drawing\n\n[[Sketch.excalidraw]]\n`,
    "utf8"
  );
  await writeFile(
    rawScenePath,
    `{"type":"excalidraw","version":2,"source":"https://github.com/excalidraw/excalidraw","elements":[],"appState":{}}\n`,
    "utf8"
  );

  assert.equal(isExcalidrawMarkdownFile("00 Inbox/Sketch.excalidraw.md", await readFile(sketchPath, "utf8")), true);
  assert.equal(isExcalidrawMarkdownFile("00 Inbox/Raw Scene.md", await readFile(rawScenePath, "utf8")), true);
  assert.equal(isExcalidrawMarkdownFile("00 Inbox/Embedded Drawing.md", await readFile(embeddedPath, "utf8")), false);

  const { mapping } = await readVaultConfig(vault);
  const notes = await loadNotes(vault, mapping);
  assert.equal(notes.some((note) => note.id === "Sketch.excalidraw"), false);
  assert.equal(notes.some((note) => note.id === "Raw Scene"), false);
  assert.equal(notes.some((note) => note.id === "Embedded Drawing"), true);

  const search = await searchVault(vault, "Sketch", { threshold: 0, maxResults: 20 });
  assert.equal(search.results.some((row) => row.note === "Sketch.excalidraw"), false);
  const validation = await validateVault(vault);
  assert.equal(validation.issues.some((issue) => issue.path?.endsWith("Sketch.excalidraw.md")), false);
  assert.equal(validation.issues.some((issue) => issue.message?.includes("Sketch.excalidraw")), false);
  const cache = await rebuildCache(vault, { full: true });
  assert.equal(cache.files.some((file) => file.path.includes("Sketch.excalidraw.md")), false);
  assert.equal(cache.files.some((file) => file.path.includes("Raw Scene.md")), false);
  await assert.rejects(() => formatVault(vault, false, { note: "Sketch.excalidraw" }), /note not found/);
});

test("empty-frontmatter inbox markdown is reported as raw capture without failing validation", async () => {
  const vault = await fixtureVault();
  await writeFile(join(vault, "00 Inbox", "Raw Capture.md"), "quick capture\n\n[[Alpha]]\n", "utf8");
  const validation = await validateVault(vault);
  assert.equal(validation.status, "ok");
  assert.ok(validation.issues.some((item) => item.code === "ipa.inbox.raw_capture" && item.note === "Raw Capture"));
});

test("mapped vault writes use mapped updated field without core-specific metadata", async () => {
  const vault = await fixtureVault();
  await writeFile(
    join(vault, ".ipa", "config.yaml"),
    `mapping:\n  fields:\n    note_type: kind\n    refs: parents\n    tags: tags\n    created_at: created\n    updated_at: updated\n    aliases: aliases\n  folders:\n    inbox: 00 Inbox\n    project: 01 Project\n    archive: 02 Archive\n`,
    "utf8"
  );
  const source = join(vault, "source.md");
  await writeFile(source, "---\naliases: [Mapped Source]\nstage: inbox\n---\n# Mapped Add\n", "utf8");
  await inboxAdd(vault, source, { title: "Mapped Add", refs: ["🔖 Topic Index"], tags: ["mapped"] });
  const addedPath = join(vault, "00 Inbox", "Mapped Add.md");
  const added = await readFile(addedPath, "utf8");
  assert.match(added, /kind: note/);
  assert.match(added, /parents: \["\[\[🔖 Topic Index\]\]"\]/);
  assert.match(added, /aliases: \[Mapped Source\]/);
  assert.match(added, /stage: inbox/);
  assert.doesNotMatch(added, /obsidianUIMode/);

  await refactorVault(vault, "tag-add", ["extra"], { apply: true });
  const refactored = await readFile(addedPath, "utf8");
  assert.match(refactored, /updated:/);
  assert.doesNotMatch(refactored, /date_modified:/);
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
  const progress = [];
  const progressResult = await tuneRun(vault, { trials: 3, onProgress: (event) => progress.push(event) });
  assert.equal(progressResult.optimizer, "tpe-lite");
  assert.equal(progress.length, 3);
  assert.equal(progress[2].completed, 3);
  assert.equal(progress[2].trials, 3);
  const runResult = await tuneRun(vault, { trials: 3 });
  assert.equal(runResult.optimizer, "tpe-lite");
  assert.equal(runResult.pack, ".ipa/tune/testsets/ipa-cli-core.json");
  assert.ok(runResult.elapsed_ms >= 0);
  const history = await readFile(join(vault, ".ipa", "tune", "history.jsonl"), "utf8");
  assert.equal(history.trim().split("\n").length, 3);
});

test("builtin linter rules are listed, applied and configurable", async () => {
  const vault = await fixtureVault();
  const configPath = join(vault, ".ipa", "config.yaml");
  await mkdir(join(vault, "01 Project", "Empty Project"), { recursive: true });
  await writeFile(
    join(vault, "00 Inbox", "Bad Note.md"),
    `---\ndate_created: bad-date\ntype: note\nref: ["[[Missing Target]]"]\ntags: ["Bad Tag"]\n---\n# Bad Note\n\n[[Missing Link]]\n`,
    "utf8"
  );
  await writeFile(
    join(vault, "01 Project", "Plain Index.md"),
    `---\ndate_created: 2026/05/10 (Sun) 00:00:00\ndate_modified: 2026/05/10 (Sun) 00:00:00\ntype: index\nref: ["[[🏷️ Topic Root]]"]\ntags: [project]\n---\n## Plain Index\n`,
    "utf8"
  );
  await writeFile(
    join(vault, "01 Project", "Plain Root Node.md"),
    `---\ndate_created: 2026/05/10 (Sun) 00:00:00\ndate_modified: 2026/05/10 (Sun) 00:00:00\ntype: root\nref: []\ntags: [project]\n---\n## Plain Root\n`,
    "utf8"
  );

  const listed = await listRules(vault);
  assert.equal(listed.rules.length, 15);
  assert.equal(listed.rules.find((item) => item.code === "ipa.title.index_prefix").enabled, true);

  const issues = (await validateVault(vault)).issues;
  const codes = new Set(issues.map((item) => item.code));
  for (const code of [
    "ipa.frontmatter.required_field",
    "ipa.frontmatter.date_format",
    "ipa.tag.snake_case",
    "ipa.title.index_prefix",
    "ipa.title.root_prefix",
    "ipa.title.root_suffix",
    "ipa.link.ref_target_missing",
    "ipa.link.wikilink_target_missing",
    "ipa.root_folder.missing",
    "ipa.heading.no_h1"
  ]) {
    assert.ok(codes.has(code), `expected ${code}`);
  }

  await writeFile(
    configPath,
    `${await readFile(configPath, "utf8")}\nrules:\n  enabled: true\n  builtin: true\n  plugins: true\n  items:\n    title: false\n    ipa.heading.no_h1: false\n`,
    "utf8"
  );
  const disabled = await listRules(vault);
  assert.equal(disabled.rules.find((item) => item.code === "ipa.title.index_prefix").enabled, false);
  assert.equal(disabled.rules.find((item) => item.code === "ipa.heading.no_h1").enabled, false);
  const nextCodes = new Set((await validateVault(vault)).issues.map((item) => item.code));
  assert.equal(nextCodes.has("ipa.title.index_prefix"), false);
  assert.equal(nextCodes.has("ipa.heading.no_h1"), false);
  assert.equal(nextCodes.has("ipa.link.ref_target_missing"), true);
});

test("builtin formatter uses reusable markdown and IPA note utilities", async () => {
  const vault = await fixtureVault();
  await writeFile(
    join(vault, "00 Inbox", "Needs Format.md"),
    `---\ndate_modified: 2026/05/10 (Sun) 00:00:00\nref: ["[[🔖 Topic Index]]"]\ntags: [format]\n---\n# Needs Format\n\nBody\n`,
    "utf8"
  );
  const { mapping } = await readVaultConfig(vault);
  const note = (await loadNotes(vault, mapping)).find((item) => item.id === "Needs Format");
  const document = IpaNoteDocument.fromNote(note, mapping);
  assert.equal(document.hasDuplicateTitleH1(), true);
  assert.deepEqual(document.refs, ["🔖 Topic Index"]);

  const plan = await formatVault(vault, false, { note: "Needs Format" });
  assert.equal(plan.patches.length, 1);
  assert.equal(plan.patches[0].plugin, "rules");
  assert.deepEqual(plan.patches[0].rules, [
    "ipa.frontmatter.required_field",
    "ipa.heading.no_h1"
  ]);

  const applied = await formatVault(vault, true, { note: "Needs Format" });
  assert.deepEqual(applied.applied, [{ note: "Needs Format", path: "00 Inbox/Needs Format.md", patches: 1 }]);
  const text = await readFile(join(vault, "00 Inbox", "Needs Format.md"), "utf8");
  assert.match(text, /date_created: \d{4}\/\d{2}\/\d{2} \([A-Z][a-z]{2}\) \d{2}:\d{2}:\d{2}/);
  assert.match(text, /type: note/);
  assert.doesNotMatch(text, /^# Needs Format/m);
});

test("MarkdownDocument exposes Obsidian structures for plugin rules", () => {
  const doc = new MarkdownDocument(`---\ntags: [doc]\n---\n## Graph\n\n\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\`\n\n- item\n- [x] done\n\n> [!note]- Folded\n> quote\n>   indented quote\n\n> plain quote\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n$$\nx = 1\n$$\n\n![[Image.png]]\n[[Target#Part|Alias]]\nhttps://example.com/path\n#inline_tag\n`);

  assert.deepEqual(doc.frontmatterField("tags"), ["doc"]);
  assert.equal(doc.headings()[0].title, "Graph");
  assert.equal(doc.sections()[0].blankAfterHeading, true);
  assert.equal(doc.mermaidBlocks()[0].content.split("\n")[1].startsWith("  "), true);
  assert.equal(doc.listBlocks()[0].items.length, 2);
  assert.equal(doc.taskItems()[0].checked, true);
  assert.equal(doc.callouts()[0].type, "note");
  assert.match(doc.callouts()[0].content, /indented quote/);
  assert.equal(doc.blockquotes()[0].content, "plain quote");
  assert.deepEqual(doc.tables()[0].headers, ["A", "B"]);
  assert.match(doc.mathBlocks()[0].content, /x = 1/);
  assert.equal(doc.embeds()[0].target, "Image.png");
  assert.equal(doc.vaultLinks().some((link) => link.target === "Target" && link.heading === "Part"), true);
  assert.equal(doc.externalLinks()[0].url, "https://example.com/path");
  assert.equal(doc.inlineTags()[0].tag, "inline_tag");
});

test("tune eval uses the vault-local configured testset by default", async () => {
  const vault = await fixtureVault();
  await mkdir(join(vault, ".ipa", "tune", "testsets"), { recursive: true });
  await writeFile(
    join(vault, ".ipa", "tune", "testsets", "testset.json"),
    JSON.stringify({
      cases: [
        { queries: ["Alpha"], target_filename: "Alpha" },
        { queries: ["Topic"], target_filename: "Topic Index" }
      ]
    }),
    "utf8"
  );
  await writeFile(
    join(vault, ".ipa", "config.yaml"),
    `${await readFile(join(vault, ".ipa", "config.yaml"), "utf8")}\ntest:\n  file: .ipa/tune/testsets/testset.json\n`,
    "utf8"
  );
  const result = await tuneEval(vault);
  assert.equal(result.pack, ".ipa/tune/testsets/testset.json");
  assert.equal(result.total, 2);
  assert.equal(result.misses, 0);
});

test("tune loss preserves regression and scenario weights", async () => {
  const vault = await fixtureVault();
  await mkdir(join(vault, ".ipa", "tune", "testsets"), { recursive: true });
  await writeFile(
    join(vault, ".ipa", "tune", "testsets", "testset.json"),
    JSON.stringify({
      cases: [
        { id: "C1", queries: ["Alpha"], target_filename: "Alpha" }
      ],
      scenario_cases: [
        { id: "S1", queries: ["zzzz-no-hit"], target_filename: "Beta", recall_mode: "top5" }
      ]
    }),
    "utf8"
  );
  await writeFile(
    join(vault, ".ipa", "config.yaml"),
    `${await readFile(join(vault, ".ipa", "config.yaml"), "utf8")}\ntest:\n  file: .ipa/tune/testsets/testset.json\n`,
    "utf8"
  );

  const shown = await tuneTestsetShow(vault);
  assert.equal(shown.cases, 2);
  assert.equal(shown.rows[1].kind, "scenario");

  const result = await tuneEval(vault);
  assert.equal(result.total, 2);
  assert.equal(result.groups.regression.misses, 0);
  assert.equal(result.groups.scenario.misses, 1);
  assert.equal(result.loss, 51);
});

test("tune analyze, replay and testset commands are functional", async () => {
  const vault = await fixtureVault();
  const list = await tuneTestsetList(vault);
  assert.deepEqual(list.testsets, [".ipa/tune/testsets/ipa-cli-core.json"]);
  assert.equal(list.active, ".ipa/tune/testsets/ipa-cli-core.json");

  const shown = await tuneTestsetShow(vault);
  assert.equal(shown.cases, 3);
  assert.equal(shown.queries, 3);
  assert.equal((await tuneTestsetValidate(vault)).status, "ok");

  const analysis = await tuneAnalyze(vault, { thresholds: [0, 0.3] });
  assert.equal(analysis.pack, ".ipa/tune/testsets/ipa-cli-core.json");
  assert.equal(analysis.thresholds.length, 2);
  assert.ok(analysis.target_scores.every((row) => row.rank !== null));

  const runResult = await tuneRun(vault, { trials: 2 });
  assert.equal(runResult.history.length, 2);
  const replay = await tuneReplay(vault);
  assert.equal(replay.replayed, 2);
  assert.equal(replay.rows[0].misses, 0);

  const added = await tuneTestsetAdd(vault, { query: "Beta alias", target: "Beta" });
  assert.equal(added.cases, 4);
  assert.equal((await tuneTestsetShow(vault)).queries, 4);

  await mkdir(join(vault, ".ipa", "tune", "logs"), { recursive: true });
  const searchCwd = join(vault, "..", "workspace-a");
  const searchCwdKey = createHash("sha256").update(searchCwd).digest("hex").slice(0, 16);
  await writeFile(
    join(vault, ".ipa", "tune", "logs", "current-prompt.json"),
    JSON.stringify({
      event_id: "prompt_other_session",
      event_type: "prompt",
      ts: new Date().toISOString(),
      agent: "codex",
      session_id: "other_session",
      turn_id: "other_turn",
      source_prompt: "Wrong prompt from another session",
      prompt: "Wrong prompt from another session",
      ttl_seconds: 1800
    }, null, 2),
    "utf8"
  );
  await writeFile(
    join(vault, ".ipa", "tune", "logs", `current-prompt-${searchCwdKey}.json`),
    JSON.stringify({
      event_id: "prompt_test",
      event_type: "prompt",
      ts: new Date().toISOString(),
      agent: "codex",
      session_id: "session_test",
      turn_id: "turn_test",
      source_prompt: "Find the Alpha note",
      prompt: "Find the Alpha note",
      cwd: searchCwd,
      ttl_seconds: 1800
    }, null, 2),
    "utf8"
  );
  const previousSearchLog = process.env.IPA_SEARCH_LOG;
  const previousTuneLogSearch = process.env.IPA_TUNE_LOG_SEARCH;
  delete process.env.IPA_SEARCH_LOG;
  delete process.env.IPA_TUNE_LOG_SEARCH;
  try {
    await searchVault(vault, "Alpha", { logCwd: searchCwd });
    const log = await tuneLog(vault);
    assert.equal(log.count, 1);
    assert.equal(log.events[0].event_type, "search");
    assert.equal(log.events[0].query, "Alpha");
    assert.equal(log.events[0].generated_query, "Alpha");
    assert.equal(log.events[0].source_prompt, "Find the Alpha note");
    assert.equal(log.events[0].prompt_event_id, "prompt_test");
    assert.equal(log.events[0].agent, "codex");
    assert.equal(log.events[0].session_id, "session_test");
    assert.equal(log.events[0].turn_id, "turn_test");
    assert.equal(log.events[0].cwd, searchCwd);
    assert.equal(log.events[0].results[0].note, "Alpha");
  } finally {
    if (previousSearchLog === undefined) delete process.env.IPA_SEARCH_LOG;
    else process.env.IPA_SEARCH_LOG = previousSearchLog;
    if (previousTuneLogSearch === undefined) delete process.env.IPA_TUNE_LOG_SEARCH;
    else process.env.IPA_TUNE_LOG_SEARCH = previousTuneLogSearch;
  }

  assert.equal((await tuneLabel(vault, { query: "Alpha", target: "Alpha" })).count, 1);
  assert.equal((await tuneLabel(vault)).labels[0].target, "Alpha");
  assert.equal((await tuneTestsetDraft(vault)).cases, 0);
});

test("tune defaults require a vault-local testset instead of a sample convention pack", async () => {
  const vault = await fixtureVault();
  await writeFile(
    join(vault, ".ipa", "config.yaml"),
    `mapping:\n  fields:\n    note_type: type\n    refs: ref\n    tags: tags\n    created_at: date_created\n    updated_at: date_modified\n    aliases: aliases\n  folders:\n    inbox: 00 Inbox\n    project: 01 Project\n    archive: 02 Archive\n`,
    "utf8"
  );

  await assert.rejects(() => tuneEval(vault), /tune testset not configured/);
  await assert.rejects(() => tuneRun(vault, { trials: 1 }), /tune testset not configured/);

  const init = await tuneTestsetInit(vault);
  assert.equal(init.file, ".ipa/tune/testsets/testset.json");
  assert.equal(init.created, true);
  assert.equal(init.config_updated, true);
  assert.deepEqual(JSON.parse(await readFile(join(vault, ".ipa", "tune", "testsets", "testset.json"), "utf8")), {
    cases: [],
    scenario_cases: []
  });
  assert.equal((await tuneTestsetList(vault)).active, ".ipa/tune/testsets/testset.json");
  assert.equal((await tuneTestsetValidate(vault)).status, "ok");
  assert.equal((await tuneEval(vault)).total, 0);
});

test("activated tune results are applied to search defaults", async () => {
  const vault = await fixtureVault();
  await mkdir(join(vault, ".ipa", "tune", "results"), { recursive: true });
  await writeFile(
    join(vault, ".ipa", "tune", "results", "active.json"),
    JSON.stringify({ best: { params: { threshold: 2, cap: 1, weights: { fuzzy: 0 } } } }),
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

test("harness install, doctor and guard enforce inbox-only new markdown writes", async () => {
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const options = { homeDir: home, profile: "ipa-test" };
  assert.deepEqual((await harnessStatus(vault, options)).installed, []);
  const install = await harnessInstall(vault, "codex", options);
  assert.equal(install.installed, true);
  assert.ok(install.files.includes(".agents/skills/ipa-rule/SKILL.md"));
  assert.ok(install.files.includes(".agents/skills/ipa-config/SKILL.md"));
  assert.ok(install.files.includes(".agents/skills/ipa-tune/SKILL.md"));
  assert.ok(install.plugin_init.created.includes(".ipa/plugins/jsconfig.json"));
  assert.ok(install.plugin_init.created.includes(".ipa/plugins/types/ipa-plugin.d.ts"));
  assert.match(await readFile(join(vault, ".ipa", "plugins", "rules", "_example-title-length.js"), "utf8"), /@ts-check/);
  assert.ok(install.global_files.some((file) => file.endsWith(".codex/skills/ipa/SKILL.md")));
  assert.ok(install.global_files.some((file) => file.endsWith(".codex/hooks/ipa-session-env.mjs")));
  assert.ok(install.global_files.some((file) => file.endsWith(".codex/hooks/ipa-formatter-gate.mjs")));
  const status = await harnessStatus(vault, options);
  assert.deepEqual(status.installed, ["codex"]);
  assert.equal(status.global.codex.session_env_hook, true);
  assert.equal(status.global.codex.formatter_gate_hook, true);
  assert.equal(status.plugin_scaffold.types, true);
  assert.equal((await harnessDoctor(vault, options)).status, "ok");
  const skill = await readFile(join(home, ".codex", "skills", "ipa", "SKILL.md"), "utf8");
  assert.ok(skill.startsWith("---\nname: ipa\n"), "skill YAML frontmatter must be first");
  assert.match(skill, /ipa context "keyword" --size medium --format markdown/);
  assert.match(skill, /ipa search "keyword"/);
  assert.match(skill, /current prompt context/);
  assert.doesNotMatch(skill, /IPA_SEARCH_LOG=1 ipa search "keyword"/);
  assert.doesNotMatch(skill, /Use `search` only when/);
  assert.doesNotMatch(skill, /ipa --profile ipa-test search/);
  assert.match(skill, /formatter plan --note "Note A" "Note B"/);
  assert.match(skill, /formatter apply --note "Note A" "Note B"/);
  assert.match(skill, /Core-Backed Scripted Edits/);
  assert.match(skill, /ipa note replace "Note Title"/);
  assert.match(skill, /including YAML frontmatter/);
  const globalPrompt = await readFile(join(home, ".codex", "AGENTS.md"), "utf8");
  assert.match(globalPrompt, /Evidence-Based Work/);
  assert.match(globalPrompt, /IPA: user knowledge base/);
  assert.match(globalPrompt, /Workspace: current local reality/);
  assert.match(globalPrompt, /Web: external reality/);
  assert.match(globalPrompt, /Do not answer from memory/);
  assert.match(await readFile(join(home, ".codex", "hooks", "ipa-inbox-guard.mjs"), "utf8"), /shared IPA inbox creation guard/);
  const markdownNudge = await readFile(join(home, ".codex", "hooks", "ipa-md-write-nudge.mjs"), "utf8");
  assert.match(markdownNudge, /formatter apply --note/);
  assert.match(markdownNudge, /Do not stop at formatter plan/);
  const sessionEnvHook = join(home, ".codex", "hooks", "ipa-session-env.mjs");
  const envFile = join(home, "codex-session.env");
  const sessionEnv = spawnSync(process.execPath, [sessionEnvHook], {
    input: "{}",
    env: { ...process.env, CODEX_ENV_FILE: envFile },
    encoding: "utf8"
  });
  assert.equal(sessionEnv.status, 0);
  assert.match(await readFile(envFile, "utf8"), /export IPA_SEARCH_LOG='1'/);
  const promptHook = join(home, ".codex", "hooks", "ipa-user-prompt-nudge.mjs");
  const promptHookSource = await readFile(promptHook, "utf8");
  assert.match(promptHookSource, /\[Evidence nudge\]/);
  assert.doesNotMatch(promptHookSource, /Required workflow/);
  const agentsPrompt = await readFile(join(vault, "AGENTS.md"), "utf8");
  assert.match(agentsPrompt, /IPA CLI Harness/);
  assert.match(agentsPrompt, /Vault Operation Workflow/);
  assert.match(agentsPrompt, /Convention And JS Rule Workflow/);
  assert.match(agentsPrompt, /Vault-Local Helper Skills/);
  assert.match(agentsPrompt, /\.agents\/skills/);
  assert.match(agentsPrompt, /plugin dry-run search/);
  assert.match(agentsPrompt, /ipa config show/);
  assert.match(agentsPrompt, /ipa note replace "Note Title"/);
  const ruleSkill = await readFile(join(vault, ".agents", "skills", "ipa-rule", "SKILL.md"), "utf8");
  assert.match(ruleSkill, /name: ipa-rule/);
  assert.match(ruleSkill, /Use this skill whenever the user mentions IPA rules/);
  assert.match(ruleSkill, /ipa plugin validate/);
  const configSkill = await readFile(join(vault, ".agents", "skills", "ipa-config", "SKILL.md"), "utf8");
  assert.match(configSkill, /Use this skill whenever the user asks about ipa config show/);
  assert.match(configSkill, /ipa profile current/);
  assert.match(configSkill, /\.ipa\/config\.yaml/);
  const tuneSkill = await readFile(join(vault, ".agents", "skills", "ipa-tune", "SKILL.md"), "utf8");
  assert.match(tuneSkill, /Use this skill whenever the user wants better IPA search results/);
  assert.match(tuneSkill, /ipa tune log --limit 50/);
  assert.match(tuneSkill, /ipa tune testset list/);
  assert.match(tuneSkill, /prompt context is recorded automatically/);
  assert.doesNotMatch(tuneSkill, /IPA_SEARCH_LOG=1 ipa search "keyword"/);
  assert.match(tuneSkill, /Label Confirmation Protocol/);
  assert.match(tuneSkill, /Do not run the optimizer by default/);
  const hooks = await readFile(join(home, ".codex", "hooks.json"), "utf8");
  assert.match(hooks, /ipa-session-env\.mjs/);
  assert.match(hooks, /SessionStart/);
  assert.match(hooks, /ipa-inbox-guard\.mjs/);
  assert.match(hooks, /ipa-user-prompt-nudge\.mjs/);
  assert.match(hooks, /ipa-md-write-nudge\.mjs/);
  assert.match(hooks, /ipa-formatter-gate\.mjs/);
  assert.match(hooks, /Stop/);
  const promptCwd = join(home, "workspace");
  const promptNudge = spawnSync(process.execPath, [promptHook], {
    input: JSON.stringify({
      cwd: promptCwd,
      prompt: "/Users/mac/Downloads/sales_graph\\ \\(1\\).mmd /Users/mac/Downloads/sales_graph_mapping\\ \\(1\\).yaml"
    }),
    encoding: "utf8"
  });
  assert.equal(promptNudge.status, 0);
  const promptContext = JSON.parse(promptNudge.stdout).hookSpecificOutput.additionalContext;
  assert.match(promptContext, /\[Evidence nudge\]/);
  assert.match(promptContext, /ipa context "keyword" --size medium --format markdown/);
  assert.match(promptContext, /ipa search "keyword"/);
  assert.match(promptContext, /Answer with evidence, not memory/);
  assert.match(promptContext, /IPA = prior work\/user knowledge/);
  assert.match(promptContext, /workspace = current files\/tests\/state/);
  assert.match(promptContext, /web = external\/current facts/);
  assert.match(promptContext, /did not explicitly ask to search\/view/);
  assert.match(promptContext, /workspace inspection\/commands/);
  assert.match(promptContext, /web\/official docs/);
  assert.match(promptContext, /ipa view "Note Title" --full/);
  assert.doesNotMatch(promptContext, /IPA_SEARCH_LOG=1 ipa search "keyword"/);
  assert.match(promptContext, /not raw paths\/full prompts/);
  assert.match(promptContext, /note replace/);
  assert.match(promptContext, /frontmatter fixes/);
  assert.match(promptContext, /formatter apply --note/);
  assert.doesNotMatch(promptContext, /Required workflow/);
  assert.doesNotMatch(promptContext, /Triggers \(not exhaustive\)/);
  assert.doesNotMatch(promptContext, /Downloads/);
  assert.doesNotMatch(promptContext, /sales_graph/);
  assert.doesNotMatch(promptContext, /Possible related notes/);
  const promptLog = await tuneLog(vault);
  assert.equal(promptLog.count, 1);
  assert.equal(promptLog.events[0].event_type, "prompt");
  assert.equal(promptLog.events[0].agent, "codex");
  assert.ok(promptLog.events[0].event_id.startsWith("prompt_"));
  assert.equal(promptLog.events[0].turn_id, promptLog.events[0].event_id);
  assert.equal(promptLog.events[0].source_prompt, promptLog.events[0].prompt);
  assert.equal(promptLog.events[0].generated_query, null);
  assert.equal(promptLog.events[0].cwd, promptCwd);
  assert.match(promptLog.events[0].prompt, /sales_graph/);
  const currentPrompt = JSON.parse(await readFile(join(vault, ".ipa", "tune", "logs", "current-prompt.json"), "utf8"));
  assert.equal(currentPrompt.event_id, promptLog.events[0].event_id);
  assert.equal(currentPrompt.ttl_seconds, 1800);
  const promptCwdKey = createHash("sha256").update(promptCwd).digest("hex").slice(0, 16);
  const scopedPrompt = JSON.parse(await readFile(join(vault, ".ipa", "tune", "logs", `current-prompt-${promptCwdKey}.json`), "utf8"));
  assert.equal(scopedPrompt.event_id, promptLog.events[0].event_id);
  const guardScript = join(home, ".codex", "hooks", "ipa-inbox-guard.mjs");
  const blocked = spawnSync(process.execPath, [guardScript], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(vault, "02 Archive", "New.md") } }),
    encoding: "utf8"
  });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /IPA guard blocked/);
  const allowed = spawnSync(process.execPath, [guardScript], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(vault, "00 Inbox", "New.md") } }),
    encoding: "utf8"
  });
  assert.equal(allowed.status, 0);
  const nudge = spawnSync(process.execPath, [join(home, ".codex", "hooks", "ipa-md-write-nudge.mjs")], {
    input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(vault, "00 Inbox", "Alpha.md") } }),
    encoding: "utf8"
  });
  assert.equal(nudge.status, 0);
  const nudgePayload = JSON.parse(nudge.stdout);
  assert.equal(nudgePayload.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(nudge.stdout, /formatter plan --note \\"Alpha\\"/);
  assert.match(nudge.stdout, /formatter apply --note \\"Alpha\\"/);
  assert.match(nudge.stdout, /Do not stop at formatter plan/);
  const pendingPath = join(vault, ".ipa", "harness", "formatter-pending.json");
  assert.match(await readFile(pendingPath, "utf8"), /Alpha/);

  await writeFile(
    join(vault, "00 Inbox", "Needs Format.md"),
    `---\ndate_modified: 2026/05/10 (Sun) 00:00:00\nref: ["[[🔖 Topic Index]]"]\ntags: [format]\n---\n# Needs Format\n\nBody\n`,
    "utf8"
  );
  const needsFormatNudge = spawnSync(process.execPath, [join(home, ".codex", "hooks", "ipa-md-write-nudge.mjs")], {
    input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(vault, "00 Inbox", "Needs Format.md") } }),
    encoding: "utf8"
  });
  assert.equal(needsFormatNudge.status, 0);
  const formatterGate = join(home, ".codex", "hooks", "ipa-formatter-gate.mjs");
  const blockedFormatter = spawnSync(process.execPath, [formatterGate], {
    input: "{}",
    encoding: "utf8"
  });
  assert.equal(blockedFormatter.status, 2);
  assert.match(blockedFormatter.stderr, /Formatter gate blocked final response/);
  assert.match(blockedFormatter.stdout, /formatter apply --note/);

  await formatVault(vault, true, { notes: ["Alpha", "Needs Format"] });
  const passedFormatter = spawnSync(process.execPath, [formatterGate], {
    input: "{}",
    encoding: "utf8"
  });
  assert.equal(passedFormatter.status, 0);
  assert.equal(existsSync(pendingPath), false);

  const claudeInstall = await harnessInstall(vault, "claude", options);
  assert.equal(claudeInstall.installed, true);
  assert.ok(claudeInstall.files.includes(".claude/skills/ipa-rule/SKILL.md"));
  assert.ok(claudeInstall.files.includes(".claude/skills/ipa-config/SKILL.md"));
  assert.ok(claudeInstall.files.includes(".claude/skills/ipa-tune/SKILL.md"));
  assert.match(await readFile(join(home, ".claude", "skills", "ipa", "SKILL.md"), "utf8"), /IPA CLI Skill/);
  assert.match(await readFile(join(vault, "CLAUDE.md"), "utf8"), /IPA CLI Harness/);
  const claudeTuneSkill = await readFile(join(vault, ".claude", "skills", "ipa-tune", "SKILL.md"), "utf8");
  assert.match(claudeTuneSkill, /name: ipa-tune/);
  assert.match(claudeTuneSkill, /Label Confirmation Protocol/);

  assert.equal((await harnessGuardCheck(vault, "00 Inbox/New.md")).allowed, true);
  const denied = await harnessGuardCheck(vault, "02 Archive/New.md");
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /inbox/);
  assert.equal((await harnessGuardCheck(vault, "02 Archive/Topic.md", { action: "edit" })).allowed, true);

  const uninstall = await harnessUninstall(vault, "codex", options);
  assert.equal(uninstall.installed, false);
  assert.ok(uninstall.removed.includes(".agents/skills/ipa-rule/SKILL.md"));
  await harnessUninstall(vault, "claude", options);
  assert.deepEqual((await harnessStatus(vault, options)).installed, []);
});

test("vault-local JS plugins run in search, validation and formatter paths", async () => {
  const vault = await fixtureVault();
  await mkdir(join(vault, ".ipa", "plugins", "search"), { recursive: true });
  await mkdir(join(vault, ".ipa", "plugins", "rules"), { recursive: true });
  await writeFile(
    join(vault, ".ipa", "plugins", "search", "sample.js"),
    `export async function search(query, notes) {
      if (query !== "plugin-only") return [];
      return [{ note: "Beta", score: 3, reason: { matched: "plugin" } }];
    }\n`,
    "utf8"
  );
  await writeFile(
    join(vault, ".ipa", "plugins", "rules", "sample.js"),
    `export const rules = [{
      code: "sample.alpha",
      severity: "warn",
      check(note) {
        return note.id === "Alpha" ? [{ message: "plugin lint issue" }] : [];
      },
      fix(note) {
        return note.id === "Alpha" ? [{ content: note.raw.replace("Alpha mentions Beta", "Alpha formatted Beta") }] : [];
      }
    }];\n`,
    "utf8"
  );
  assert.equal((await listPlugins(vault)).plugins.length, 2);
  const dryRun = await pluginDryRun(vault, "search", ".ipa/plugins/search/sample.js", { query: "Alpha" });
  assert.deepEqual(dryRun.results, []);
  const search = await searchVault(vault, "plugin-only");
  assert.equal(search.results[0].note, "Beta");
  assert.equal(search.results[0].reasons["plugin:sample.js"].matched, "plugin");
  const validation = await validateVault(vault);
  assert.ok(validation.issues.some((item) => item.code === "sample.alpha" && item.plugin === ".ipa/plugins/rules/sample.js"));
  const ruleDryRun = await pluginDryRun(vault, "rules", ".ipa/plugins/rules/sample.js", { note: "Alpha" });
  assert.ok(ruleDryRun.issues.some((item) => item.code === "sample.alpha"));
  assert.equal(ruleDryRun.patches.length, 1);
  await writeFile(
    join(vault, ".ipa", "config.yaml"),
    `${await readFile(join(vault, ".ipa", "config.yaml"), "utf8")}\nrules:\n  enabled: true\n  builtin: false\n  plugins: true\n`,
    "utf8"
  );
  const format = await formatVault(vault);
  assert.ok(format.patches.some((item) => item.note === "Alpha" && item.rules.includes("sample.alpha")));
  const scopedMiss = await formatVault(vault, false, { note: "Beta" });
  assert.equal(scopedMiss.patches.length, 0);
  const scopedHit = await formatVault(vault, false, { note: "Alpha" });
  assert.equal(scopedHit.patches.length, 1);
  const scopedList = await formatVault(vault, false, { notes: ["Alpha", "Beta"] });
  assert.equal(scopedList.patches.length, 1);
  await writeFile(
    join(vault, ".ipa", "config.yaml"),
    `${await readFile(join(vault, ".ipa", "config.yaml"), "utf8")}\nrules:\n  enabled: true\n  builtin: false\n  plugins: true\n  items:\n    sample.alpha: false\n`,
    "utf8"
  );
  assert.equal((await listRules(vault)).rules.find((item) => item.code === "sample.alpha").enabled, false);
  assert.equal((await validateVault(vault)).issues.some((item) => item.code === "sample.alpha"), false);
  assert.equal((await formatVault(vault, false, { note: "Alpha" })).patches.length, 0);
  await writeFile(
    join(vault, ".ipa", "config.yaml"),
    `${await readFile(join(vault, ".ipa", "config.yaml"), "utf8")}\nrules:\n  enabled: true\n  builtin: false\n  plugins: true\n`,
    "utf8"
  );
  await assert.rejects(() => formatVault(vault, false, { note: "Missing" }), /note not found: Missing/);
  await assert.rejects(() => formatVault(vault, false, { notes: ["Alpha", "Missing"] }), /note not found: Missing/);
  const applied = await formatVault(vault, true);
  assert.deepEqual(applied.applied, [{ note: "Alpha", path: "00 Inbox/Alpha.md", patches: 1 }]);
  assert.match(await readFile(join(vault, "00 Inbox", "Alpha.md"), "utf8"), /Alpha formatted Beta/);
  await writeFile(
    join(vault, ".ipa", "config.yaml"),
    `mapping:\n  fields:\n    note_type: type\n    refs: ref\n    tags: tags\n    created_at: date_created\n    updated_at: date_modified\n    aliases: aliases\n  folders:\n    inbox: 00 Inbox\n    project: 01 Project\n    archive: 02 Archive\nplugins:\n  search: false\n`,
    "utf8"
  );
  assert.equal((await listPlugins(vault)).plugins.length, 1);
  await writeFile(
    join(vault, ".ipa", "config.yaml"),
    `mapping:\n  fields:\n    note_type: type\n    refs: ref\n    tags: tags\n    created_at: date_created\n    updated_at: date_modified\n    aliases: aliases\n  folders:\n    inbox: 00 Inbox\n    project: 01 Project\n    archive: 02 Archive\nplugins: false\n`,
    "utf8"
  );
  assert.equal((await listPlugins(vault)).plugins.length, 0);
});

test("search channels can disable builtins and use tunable plugin channels", async () => {
  const vault = await fixtureVault();
  const baseConfig = await readFile(join(vault, ".ipa", "config.yaml"), "utf8");
  await mkdir(join(vault, ".ipa", "plugins", "search"), { recursive: true });
  await writeFile(
    join(vault, ".ipa", "plugins", "search", "channel-only.js"),
    `export const channel = {
      name: "custom_boost",
      defaultWeight: 1,
      description: "custom score channel",
      async search({ query }) {
        return query === "channel-only" ? [{ note: "Beta", score: 1, reason: { matched: "channel" } }] : [];
      }
    };\n`,
    "utf8"
  );
  await writeFile(
    join(vault, ".ipa", "config.yaml"),
    `${baseConfig}\nsearch:\n  channels:\n    builtin: false\n`,
    "utf8"
  );

  const channels = await listSearchChannels(vault);
  assert.equal(channels.channels.find((item) => item.name === "filename").enabled, false);
  assert.equal(channels.channels.find((item) => item.name === "custom_boost").enabled, true);
  assert.equal((await searchVault(vault, "Alpha")).count, 0);
  const pluginHit = await searchVault(vault, "channel-only");
  assert.equal(pluginHit.results[0].note, "Beta");
  assert.equal(pluginHit.results[0].reasons.custom_boost.matched, "channel");
  const dryRun = await pluginDryRun(vault, "search", ".ipa/plugins/search/channel-only.js", { query: "channel-only" });
  assert.equal(dryRun.results[0].note, "Beta");

  await writeFile(
    join(vault, ".ipa", "config.yaml"),
    `${baseConfig}\nsearch:\n  channels:\n    builtin: false\n    plugins:\n      custom_boost: false\n`,
    "utf8"
  );
  const disabledChannels = await listSearchChannels(vault);
  assert.equal(disabledChannels.channels.find((item) => item.name === "custom_boost").enabled, false);
  assert.equal((await searchVault(vault, "channel-only")).count, 0);
});

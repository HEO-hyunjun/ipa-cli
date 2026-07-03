import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildContext,
  cacheStatus,
  cascadeNote,
  cliVersionInfo,
  digestNote,
  doctor,
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
  pluginDoctor,
  pluginDryRun,
  readVaultConfig,
  refactorVault,
  replaceInNote,
  resolveSettings,
  rewriteNote,
  rebuildCache,
  redirectNotes,
  reviewVault,
  searchVault,
  scoreNote,
  setNoteField,
  suggestLinks,
  traversal,
  harnessDoctor,
  harnessGuardCheck,
  harnessInstall,
  harnessStatus,
  harnessUninstall,
  harnessUpdate,
  selfUpdate,
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

test("link plan uses semantic search queries and ignores collapsed transcript noise", async () => {
  const vault = await fixtureVault();
  await mkdir(join(vault, "02 Archive"), { recursive: true });
  await writeFile(
    join(vault, "01 Project", "🔖 빅스데이터 회의.md"),
    `---
date_created: 2026/05/22 (Fri) 00:00:00
date_modified: 2026/05/22 (Fri) 00:00:00
ref: []
tags: []
type: index
---
# 빅스데이터 회의
`,
    "utf8"
  );
  await writeFile(
    join(vault, "01 Project", "🔖 커피.md"),
    `---
date_created: 2026/05/22 (Fri) 00:00:00
date_modified: 2026/05/22 (Fri) 00:00:00
ref: []
tags: [hobby]
type: index
---
# 커피
커피 관련 메모를 모아두는 index.
`,
    "utf8"
  );
  await writeFile(
    join(vault, "00 Inbox", "260522 스크럼.md"),
    `---
date_created: 2026/05/22 (Fri) 09:31:47
date_modified: 2026/05/22 (Fri) 10:38:19
ref: ["[[🔖 빅스데이터 회의]]"]
tags: []
type: note
---
## 요약

- Entity Mapping은 도메인 선택 채팅을 위해 Spring/gRPC 호출부와 OPA 권한 세팅을 진행한다.
- DeployKit/build 파일만 전제로 두지 말고 BIX 빌드와 로컬 개발 환경을 함께 확인한다.
- 신규 노트북 2대 배정은 장비 도착 후 결정한다.

> [!note]- 전사문
> 회의 시작 전에 커피 이야기를 했다.
> 이 잡담은 링크 후보가 되면 안 된다.
`,
    "utf8"
  );
  await writeFile(
    join(vault, "02 Archive", "260521 스프린트 회고.md"),
    `---
date_created: 2026/05/21 (Thu) 09:30:58
date_modified: 2026/05/21 (Thu) 11:07:15
ref: ["[[🔖 빅스데이터 회의]]"]
tags: [bigxdata/sprint]
type: note
---
## 개발 장비

Gateway/OPA/MariaDB/FastAPI/JVM Parser를 함께 띄우면 16GB RAM으로는 부족하므로 팀 노트북은 최소 32GB RAM을 목표로 한다.
`,
    "utf8"
  );
  await writeFile(
    join(vault, "02 Archive", "AI-1354 도메인 선택 기반 Cypher query 제어 구현 결과.md"),
    `---
date_created: 2026/05/18 (Mon) 00:00:00
date_modified: 2026/05/18 (Mon) 00:00:00
ref: []
tags: [multi_domain]
type: note
---
## 회고

도메인 선택 기반 Cypher query 제어는 OPA/Query Gateway와 연결되어야 하며 target domain contract와 guardrail decision을 audit으로 남긴다.
`,
    "utf8"
  );
  await writeFile(
    join(vault, "02 Archive", "agentworks-deploy-kit 사용법 - BIX 빌드와 WAR 배포의 함정.md"),
    `---
date_created: 2026/04/27 (Mon) 16:08:00
date_modified: 2026/05/19 (Tue) 11:01:55
ref: []
tags: [bigxdata/deploy_kit, bigxdata/bix_build]
type: note
---
## BIX 빌드

agentworks-deploy-kit에서 DeployKit, BIX 빌드, WAR 배포, 로컬 개발 환경 문제를 함께 다룬다.
`,
    "utf8"
  );

  const plan = await linkPlan(vault, { note: "260522 스크럼" });
  const targets = plan.changes.map((change) => change.target);
  assert.ok(targets.includes("260521 스프린트 회고"));
  assert.ok(targets.includes("AI-1354 도메인 선택 기반 Cypher query 제어 구현 결과"));
  assert.ok(targets.includes("agentworks-deploy-kit 사용법 - BIX 빌드와 WAR 배포의 함정"));
  assert.ok(!targets.includes("🔖 커피"));
  const semantic = plan.changes.find((change) => change.target === "AI-1354 도메인 선택 기반 Cypher query 제어 구현 결과");
  assert.equal(semantic.reason, "semantic_search_match");
  assert.match(semantic.source_query, /opa|도메인/);
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
  assert.equal(listed.rules.length, 16);
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
  // Hook scripts now resolve the vault via `ipa config show`, which reads env +
  // the global profile registry. Point that resolution at this test's vault so
  // the spawned hooks operate on the fixture instead of the developer's vault.
  const hookEnv = { ...process.env, IPA_VAULT_PATH: vault };
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
  assert.match(skill, /IPA Command Selection/);
  assert.match(skill, /ipa link suggest "Note Title"/);
  assert.match(skill, /ipa <command> --help/);
  assert.match(skill, /within ~3 ipa calls/);
  assert.match(skill, /ipa digest "Index Note"/);
  assert.match(skill, /Never edit `date_created`\/`date_modified` by hand/);
  assert.doesNotMatch(skill, /current prompt context/);
  assert.doesNotMatch(skill, /IPA_SEARCH_LOG=1 ipa search "keyword"/);
  assert.doesNotMatch(skill, /Use `search` only when/);
  assert.doesNotMatch(skill, /ipa --profile ipa-test search/);
  assert.match(skill, /formatter plan --note "Note A" "Note B"/);
  assert.match(skill, /formatter apply --note "Note A" "Note B"/);
  assert.match(skill, /Core-Backed Scripted Edits/);
  assert.match(skill, /ipa note replace "Note Title"/);
  assert.match(skill, /ipa note set "Note Title" --field ref --add "Index Note" --apply/);
  const globalPrompt = await readFile(join(home, ".codex", "AGENTS.md"), "utf8");
  assert.match(globalPrompt, /Evidence-Based Work/);
  assert.match(globalPrompt, /IPA: user knowledge base/);
  assert.match(globalPrompt, /Workspace: current local reality/);
  assert.match(globalPrompt, /Web: external reality/);
  assert.match(globalPrompt, /Do not answer from memory/);
  assert.match(globalPrompt, /IPA Command Selection/);
  assert.match(globalPrompt, /ipa link suggest "Note Title"/);
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
  assert.match(promptHookSource, /link suggest "Note Title"/);
  assert.match(promptHookSource, /\$\{prefix\} <command> --help/);
  assert.doesNotMatch(promptHookSource, /Required workflow/);
  const agentsPrompt = await readFile(join(vault, "AGENTS.md"), "utf8");
  assert.match(agentsPrompt, /IPA CLI Harness/);
  assert.match(agentsPrompt, /Vault Operation Workflow/);
  assert.match(agentsPrompt, /IPA Command Selection/);
  assert.match(agentsPrompt, /ipa link suggest "Note Title"/);
  assert.match(agentsPrompt, /ipa <command> --help/);
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
    env: hookEnv,
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
    env: hookEnv,
    encoding: "utf8"
  });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /IPA guard blocked/);
  const allowed = spawnSync(process.execPath, [guardScript], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(vault, "00 Inbox", "New.md") } }),
    env: hookEnv,
    encoding: "utf8"
  });
  assert.equal(allowed.status, 0);
  const nudge = spawnSync(process.execPath, [join(home, ".codex", "hooks", "ipa-md-write-nudge.mjs")], {
    input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(vault, "00 Inbox", "Alpha.md") } }),
    env: hookEnv,
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
    env: hookEnv,
    encoding: "utf8"
  });
  assert.equal(needsFormatNudge.status, 0);
  const formatterGate = join(home, ".codex", "hooks", "ipa-formatter-gate.mjs");
  const blockedFormatter = spawnSync(process.execPath, [formatterGate], {
    input: "{}",
    env: hookEnv,
    encoding: "utf8"
  });
  assert.equal(blockedFormatter.status, 2);
  assert.match(blockedFormatter.stderr, /Formatter gate blocked final response/);
  assert.match(blockedFormatter.stdout, /formatter apply --note/);

  await formatVault(vault, true, { notes: ["Alpha", "Needs Format"] });
  const passedFormatter = spawnSync(process.execPath, [formatterGate], {
    input: "{}",
    env: hookEnv,
    encoding: "utf8"
  });
  assert.equal(passedFormatter.status, 0);
  assert.equal(existsSync(pendingPath), false);

  // Session-scoped gating: pending notes from another session must not block.
  await writeFile(
    join(vault, "00 Inbox", "Needs Format.md"),
    `---\ndate_modified: 2026/05/10 (Sun) 00:00:00\nref: ["[[🔖 Topic Index]]"]\ntags: [format]\n---\n# Needs Format\n\nBody\n`,
    "utf8"
  );
  const sessionNudge = spawnSync(process.execPath, [join(home, ".codex", "hooks", "ipa-md-write-nudge.mjs")], {
    input: JSON.stringify({
      session_id: "sess-a",
      tool_name: "Edit",
      tool_input: { file_path: join(vault, "00 Inbox", "Needs Format.md") }
    }),
    env: hookEnv,
    encoding: "utf8"
  });
  assert.equal(sessionNudge.status, 0);
  const pendingWithSession = JSON.parse(await readFile(pendingPath, "utf8"));
  assert.equal(pendingWithSession.notes[0].session_id, "sess-a");
  const otherSessionGate = spawnSync(process.execPath, [formatterGate], {
    input: JSON.stringify({ session_id: "sess-b" }),
    env: hookEnv,
    encoding: "utf8"
  });
  assert.equal(otherSessionGate.status, 0);
  assert.equal(existsSync(pendingPath), true);
  const sameSessionGate = spawnSync(process.execPath, [formatterGate], {
    input: JSON.stringify({ session_id: "sess-a" }),
    env: hookEnv,
    encoding: "utf8"
  });
  assert.equal(sameSessionGate.status, 2);
  assert.match(sameSessionGate.stderr, /Formatter gate blocked final response/);
  await formatVault(vault, true, { notes: ["Needs Format"] });
  const sameSessionPass = spawnSync(process.execPath, [formatterGate], {
    input: JSON.stringify({ session_id: "sess-a" }),
    env: hookEnv,
    encoding: "utf8"
  });
  assert.equal(sameSessionPass.status, 0);
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

test("harness install registers home-relative ~ hook paths and migrates legacy/duplicate/other-machine entries", async () => {
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const options = { homeDir: home, profile: "ipa-test" };
  const settingsPath = join(home, ".claude", "settings.json");

  // Pre-seed settings.json the way a synced/multi-machine setup would look:
  // a legacy absolute path for THIS machine, an other-machine absolute path,
  // a duplicate, plus unrelated non-IPA hooks that must survive.
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: `node '${join(home, ".claude", "hooks", "ipa-user-prompt-nudge.mjs")}'` }] },
        { hooks: [{ type: "command", command: "node '/Users/other-machine/.claude/hooks/ipa-user-prompt-nudge.mjs'" }] },
        { hooks: [{ type: "command", command: "~/.claude/hooks/companion-nudge.sh" }] }
      ],
      PostToolUse: [
        { matcher: "Edit|Write", hooks: [{ type: "command", command: "~/.claude/hooks/ruff-lint.sh" }] }
      ]
    }
  }, null, 2) + "\n", "utf8");

  await harnessInstall(vault, "claude", options);
  const config = JSON.parse(await readFile(settingsPath, "utf8"));
  const commandsOf = (cfg) => Object.values(cfg.hooks ?? {})
    .flatMap((groups) => groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command)));
  const allCommands = commandsOf(config);
  const ipaCommands = allCommands.filter((c) => /ipa-[a-z-]+\.mjs/.test(c));

  // Every IPA hook is a home-relative ~ path; no absolute or other-machine path remains.
  assert.ok(ipaCommands.length >= 5);
  for (const command of ipaCommands) {
    assert.match(command, /^node ~\/\.claude\/hooks\/ipa-[a-z-]+\.mjs$/, `expected ~ path, got: ${command}`);
  }
  assert.ok(!ipaCommands.some((c) => c.includes(home)), "absolute home path should be migrated away");
  assert.ok(!ipaCommands.some((c) => c.includes("other-machine")), "other-machine path should be migrated away");

  // Duplicate prompt hooks collapse to exactly one.
  const promptIpa = config.hooks.UserPromptSubmit
    .flatMap((g) => g.hooks).filter((h) => h.command.includes("ipa-user-prompt-nudge.mjs"));
  assert.equal(promptIpa.length, 1);

  // Unrelated non-IPA hooks are preserved.
  assert.ok(allCommands.includes("~/.claude/hooks/companion-nudge.sh"));
  assert.ok(allCommands.includes("~/.claude/hooks/ruff-lint.sh"));

  // Uninstall removes every IPA hook but leaves non-IPA hooks intact.
  await harnessUninstall(vault, "claude", options);
  const afterCommands = commandsOf(JSON.parse(await readFile(settingsPath, "utf8")));
  assert.ok(!afterCommands.some((c) => /ipa-[a-z-]+\.mjs/.test(c)), "all IPA hooks removed on uninstall");
  assert.ok(afterCommands.includes("~/.claude/hooks/companion-nudge.sh"), "non-IPA hooks survive uninstall");
});

test("hook scripts resolve the vault path via homedir() with profile fallback instead of a hard-coded absolute path", async () => {
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const vault = join(home, "notes", "vault");
  await mkdir(join(vault, ".ipa"), { recursive: true });
  await mkdir(join(vault, "00 Inbox"), { recursive: true });
  await writeFile(join(vault, ".ipa", "config.yaml"), "folders:\n  inbox: \"00 Inbox\"\n", "utf8");
  await harnessInstall(vault, "claude", { homeDir: home });

  const scripts = ["ipa-inbox-guard.mjs", "ipa-user-prompt-nudge.mjs", "ipa-md-write-nudge.mjs", "ipa-call-counter.mjs", "ipa-formatter-gate.mjs"];
  for (const name of scripts) {
    const src = await readFile(join(home, ".claude", "hooks", name), "utf8");
    assert.ok(!src.includes(`const vaultPath = "${vault}"`), `${name} must not hard-code the absolute vault path`);
    assert.match(src, /spawnSync\("ipa", \["config", "show", "--json"\]/, `${name} resolves vault via ipa global config first`);
    assert.match(src, /return join\(homedir\(\), "notes\/vault"\)/, `${name} uses a homedir()-relative fallback`);
    assert.match(src, /import \{ homedir \} from "node:os"/, `${name} imports homedir`);
  }

  // session-env hook carries no vault path and must stay untouched.
  const sessionEnv = await readFile(join(home, ".claude", "hooks", "ipa-session-env.mjs"), "utf8");
  assert.doesNotMatch(sessionEnv, /const vaultPath =/);
});

test("harness install opencode creates OpenCode-native managed artifacts and uninstall removes them", async () => {
  // Given: a fixture vault and an isolated home directory.
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const options = { homeDir: home, profile: "ipa-test" };
  const opencodeHome = join(home, ".config", "opencode");

  // Given: no opencode target is installed yet.
  assert.deepEqual((await harnessStatus(vault, options)).installed, []);

  // When: full default install for the opencode target.
  const install = await harnessInstall(vault, "opencode", options);

  // Then: install succeeds and reports OpenCode-native managed artifacts.
  assert.equal(install.installed, true);

  // Then: vault-local helper skills under .opencode/skills.
  assert.ok(install.files.includes(".opencode/skills/ipa-rule/SKILL.md"));
  assert.ok(install.files.includes(".opencode/skills/ipa-config/SKILL.md"));
  assert.ok(install.files.includes(".opencode/skills/ipa-tune/SKILL.md"));

  // Then: plugin scaffold is created.
  assert.ok(install.plugin_init.created.includes(".ipa/plugins/jsconfig.json"));
  assert.ok(install.plugin_init.created.includes(".ipa/plugins/types/ipa-plugin.d.ts"));

  // Then: harness manifest and index exist.
  assert.ok(install.files.includes(".ipa/harness/opencode/manifest.json"));
  assert.ok(install.files.includes(".ipa/harness/manifest.json"));

  // Then: global OpenCode artifacts are written to ~/.config/opencode.
  assert.ok(install.global_files.some((file) => file.endsWith(".config/opencode/AGENTS.md")));
  assert.ok(install.global_files.some((file) => file.endsWith(".config/opencode/skills/ipa/SKILL.md")));
  assert.ok(install.global_files.some((file) => file.endsWith(".config/opencode/plugins/ipa-harness.js")));

  // Then: exact OpenCode global paths exist on disk.
  assert.ok(existsSync(join(opencodeHome, "AGENTS.md")));
  assert.ok(existsSync(join(opencodeHome, "skills", "ipa", "SKILL.md")));
  assert.ok(existsSync(join(opencodeHome, "plugins", "ipa-harness.js")));

  // Then: vault-local AGENTS.md prompt block is present.
  assert.ok(install.files.includes("AGENTS.md"));
  const agentsPrompt = await readFile(join(vault, "AGENTS.md"), "utf8");
  assert.match(agentsPrompt, /IPA CLI Harness/);

  // Then: vault-local OpenCode helper skills exist on disk.
  assert.ok(existsSync(join(vault, ".opencode", "skills", "ipa-rule", "SKILL.md")));
  assert.ok(existsSync(join(vault, ".opencode", "skills", "ipa-config", "SKILL.md")));
  assert.ok(existsSync(join(vault, ".opencode", "skills", "ipa-tune", "SKILL.md")));

  // Then: plugin scaffold type files exist on disk.
  assert.ok(existsSync(join(vault, ".ipa", "plugins", "jsconfig.json")));
  assert.ok(existsSync(join(vault, ".ipa", "plugins", "types", "ipa-plugin.d.ts")));

  // Then: harness manifests exist on disk.
  assert.ok(existsSync(join(vault, ".ipa", "harness", "opencode", "manifest.json")));
  assert.ok(existsSync(join(vault, ".ipa", "harness", "manifest.json")));

  // Then: the global OpenCode skill has IPA frontmatter and command guidance.
  const skill = await readFile(join(opencodeHome, "skills", "ipa", "SKILL.md"), "utf8");
  assert.ok(skill.startsWith("---\nname: ipa\n"), "skill YAML frontmatter must be first");
  assert.match(skill, /ipa context "keyword" --size medium --format markdown/);
  assert.match(skill, /ipa search "keyword"/);

  // Then: the global OpenCode AGENTS.md prompt has evidence-based guidance.
  const globalPrompt = await readFile(join(opencodeHome, "AGENTS.md"), "utf8");
  assert.match(globalPrompt, /Evidence-Based Work/);
  assert.match(globalPrompt, /IPA: user knowledge base/);

  // Then: the OpenCode plugin file is valid JavaScript with the harness marker.
  const pluginSource = await readFile(join(opencodeHome, "plugins", "ipa-harness.js"), "utf8");
  assert.match(pluginSource, /IPA_HARNESS_MANAGED/);

  // Then: status reports opencode as installed.
  const status = await harnessStatus(vault, options);
  assert.deepEqual(status.installed, ["opencode"]);

  // Then: the per-target manifest records default full install components,
  // including hook:evidence (evidence is included by default; excluded only
  // with --without hook:evidence).
  const manifest = JSON.parse(await readFile(join(vault, ".ipa", "harness", "opencode", "manifest.json"), "utf8"));
  assert.equal(manifest.target, "opencode");
  assert.ok(Array.isArray(manifest.components), "manifest must declare components for default full install");
  assert.ok(manifest.components.includes("hook:evidence"), "default full install must include hook:evidence");
  assert.ok(manifest.components.includes("skill"), "default full install must include skill");
  assert.ok(manifest.components.includes("prompt"), "default full install must include prompt");
  assert.ok(manifest.components.includes("opencode-plugin"), "default full install must include opencode-plugin");

  // Then: doctor reports ok for the full install.
  assert.equal((await harnessDoctor(vault, options)).status, "ok");

  // When: uninstall the opencode target.
  const uninstall = await harnessUninstall(vault, "opencode", options);

  // Then: uninstall succeeds and removes managed OpenCode artifacts.
  assert.equal(uninstall.installed, false);
  assert.ok(uninstall.removed.includes(".ipa/harness/opencode"));
  assert.ok(uninstall.removed.some((path) => path.endsWith(".opencode/skills/ipa-rule/SKILL.md")));
  assert.ok(uninstall.removed.some((path) => path.endsWith(".opencode/skills/ipa-config/SKILL.md")));
  assert.ok(uninstall.removed.some((path) => path.endsWith(".opencode/skills/ipa-tune/SKILL.md")));

  // Then: global OpenCode managed artifacts are removed.
  assert.ok(uninstall.global_removed.some((file) => file.endsWith(".config/opencode/AGENTS.md")));
  assert.ok(uninstall.global_removed.some((file) => file.endsWith(".config/opencode/skills/ipa/SKILL.md")));
  assert.ok(uninstall.global_removed.some((file) => file.endsWith(".config/opencode/plugins/ipa-harness.js")));

  // Then: vault-local .opencode/skills files are gone.
  assert.equal(existsSync(join(vault, ".opencode", "skills", "ipa-rule", "SKILL.md")), false);
  assert.equal(existsSync(join(vault, ".opencode", "skills", "ipa-config", "SKILL.md")), false);
  assert.equal(existsSync(join(vault, ".opencode", "skills", "ipa-tune", "SKILL.md")), false);

  // Then: the opencode target is no longer reported as installed.
  assert.deepEqual((await harnessStatus(vault, options)).installed, []);
});

test("harness install with --only skill,prompt creates only selected artifacts plus required dependencies", async () => {
  // Given: a fixture vault and an isolated home directory.
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const options = { homeDir: home, profile: "ipa-test", components: { only: ["skill", "prompt"] } };
  const codexHome = join(home, ".codex");

  // Given: no target is installed yet.
  assert.deepEqual((await harnessStatus(vault, options)).installed, []);

  // When: install codex with only skill and prompt components.
  const install = await harnessInstall(vault, "codex", options);

  // Then: install succeeds.
  assert.equal(install.installed, true);

  // Then: the global skill file is created.
  assert.ok(install.global_files.some((file) => file.endsWith(".codex/skills/ipa/SKILL.md")));
  assert.ok(existsSync(join(codexHome, "skills", "ipa", "SKILL.md")));

  // Then: the global prompt file is created.
  assert.ok(install.global_files.some((file) => file.endsWith(".codex/AGENTS.md")));
  assert.ok(existsSync(join(codexHome, "AGENTS.md")));

  // Then: hook scripts are NOT created because no hook components were selected.
  assert.equal(existsSync(join(codexHome, "hooks", "ipa-session-env.mjs")), false);
  assert.equal(existsSync(join(codexHome, "hooks", "ipa-inbox-guard.mjs")), false);
  assert.equal(existsSync(join(codexHome, "hooks", "ipa-user-prompt-nudge.mjs")), false);
  assert.equal(existsSync(join(codexHome, "hooks", "ipa-md-write-nudge.mjs")), false);
  assert.equal(existsSync(join(codexHome, "hooks", "ipa-formatter-gate.mjs")), false);

  // Then: hooks config does not contain IPA hook commands.
  const hooksConfigPath = join(codexHome, "hooks.json");
  if (existsSync(hooksConfigPath)) {
    const hooksConfig = await readFile(hooksConfigPath, "utf8");
    assert.doesNotMatch(hooksConfig, /ipa-session-env/);
    assert.doesNotMatch(hooksConfig, /ipa-inbox-guard/);
    assert.doesNotMatch(hooksConfig, /ipa-user-prompt-nudge/);
    assert.doesNotMatch(hooksConfig, /ipa-md-write-nudge/);
    assert.doesNotMatch(hooksConfig, /ipa-formatter-gate/);
  }

  // Then: the manifest records exactly the selected components.
  const manifest = JSON.parse(await readFile(join(vault, ".ipa", "harness", "codex", "manifest.json"), "utf8"));
  assert.ok(Array.isArray(manifest.components), "manifest must declare components");
  assert.ok(manifest.components.includes("skill"));
  assert.ok(manifest.components.includes("prompt"));
  assert.ok(!manifest.components.includes("hook:evidence"), "evidence must not be selected with only skill,prompt");
  assert.ok(!manifest.components.includes("hook:guard"), "guard must not be selected with only skill,prompt");
  assert.ok(!manifest.components.includes("hook:session-env"), "session-env must not be selected with only skill,prompt");

  // Then: status reports selected and omitted components.
  const status = await harnessStatus(vault, options);
  assert.deepEqual(status.installed, ["codex"]);
  assert.ok(status.global.codex.skill, "selected skill must be reported as present");
  assert.ok(status.global.codex.prompt, "selected prompt must be reported as present");
  assert.ok(status.components.selected.includes("skill"), "status must list skill as selected");
  assert.ok(status.components.selected.includes("prompt"), "status must list prompt as selected");
  assert.ok(status.components.omitted.includes("hook:evidence"), "status must list hook:evidence as omitted");

  // Then: doctor is ok because only selected components are required.
  assert.equal((await harnessDoctor(vault, options)).status, "ok");

  await harnessUninstall(vault, "codex", options);
});

test("harness install with --without hook:evidence omits evidence hook while preserving other full-install artifacts", async () => {
  // Given: a fixture vault and an isolated home directory.
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const options = { homeDir: home, profile: "ipa-test", components: { without: ["hook:evidence"] } };
  const codexHome = join(home, ".codex");

  // Given: no target is installed yet.
  assert.deepEqual((await harnessStatus(vault, options)).installed, []);

  // When: install codex with hook:evidence excluded from the default full set.
  const install = await harnessInstall(vault, "codex", options);

  // Then: install succeeds.
  assert.equal(install.installed, true);

  // Then: full-install artifacts other than evidence are present.
  assert.ok(install.global_files.some((file) => file.endsWith(".codex/skills/ipa/SKILL.md")));
  assert.ok(install.global_files.some((file) => file.endsWith(".codex/AGENTS.md")));
  assert.ok(install.global_files.some((file) => file.endsWith(".codex/hooks/ipa-session-env.mjs")));
  assert.ok(install.global_files.some((file) => file.endsWith(".codex/hooks/ipa-inbox-guard.mjs")));
  assert.ok(install.global_files.some((file) => file.endsWith(".codex/hooks/ipa-md-write-nudge.mjs")));
  assert.ok(install.global_files.some((file) => file.endsWith(".codex/hooks/ipa-formatter-gate.mjs")));

  // Then: the evidence hook script is NOT created.
  assert.equal(existsSync(join(codexHome, "hooks", "ipa-user-prompt-nudge.mjs")), false);
  assert.ok(!install.global_files.some((file) => file.endsWith(".codex/hooks/ipa-user-prompt-nudge.mjs")));

  // Then: hooks config does not register the evidence hook.
  const hooksConfig = JSON.parse(await readFile(join(codexHome, "hooks.json"), "utf8"));
  const allCommands = Object.values(hooksConfig.hooks ?? {})
    .flatMap((groups) => groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command)));
  assert.ok(!allCommands.some((c) => /ipa-user-prompt-nudge\.mjs/.test(c)), "evidence hook must not be registered");
  assert.ok(allCommands.some((c) => /ipa-session-env\.mjs/.test(c)), "session-env hook must remain");
  assert.ok(allCommands.some((c) => /ipa-inbox-guard\.mjs/.test(c)), "guard hook must remain");

  // Then: the manifest records hook:evidence as omitted and other full-install components as selected.
  const manifest = JSON.parse(await readFile(join(vault, ".ipa", "harness", "codex", "manifest.json"), "utf8"));
  assert.ok(Array.isArray(manifest.components));
  assert.ok(!manifest.components.includes("hook:evidence"), "evidence must be omitted");
  assert.ok(manifest.components.includes("skill"), "skill must remain in full install minus evidence");
  assert.ok(manifest.components.includes("hook:guard"), "guard must remain in full install minus evidence");
  assert.ok(manifest.components.includes("hook:session-env"), "session-env must remain");

  // Then: status reports hook:evidence as omitted.
  const status = await harnessStatus(vault, options);
  assert.ok(status.components.omitted.includes("hook:evidence"), "status must list hook:evidence as omitted");
  assert.ok(status.components.selected.includes("skill"), "skill must still be selected");

  // Then: doctor is ok because evidence was intentionally omitted.
  assert.equal((await harnessDoctor(vault, options)).status, "ok");

  await harnessUninstall(vault, "codex", options);
});

test("harness install with --only hook:guard creates guard hook and required opencode-plugin dependency for opencode", async () => {
  // Given: a fixture vault and an isolated home directory.
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const options = { homeDir: home, profile: "ipa-test", components: { only: ["hook:guard"] } };
  const opencodeHome = join(home, ".config", "opencode");

  // Given: no target is installed yet.
  assert.deepEqual((await harnessStatus(vault, options)).installed, []);

  // When: install opencode with only the guard hook component.
  const install = await harnessInstall(vault, "opencode", options);

  // Then: install succeeds.
  assert.equal(install.installed, true);

  // Then: the OpenCode plugin file is created as a required dependency of hook:* for opencode.
  assert.ok(install.global_files.some((file) => file.endsWith(".config/opencode/plugins/ipa-harness.js")));
  assert.ok(existsSync(join(opencodeHome, "plugins", "ipa-harness.js")));

  // Then: the global skill is NOT created because only hook:guard was selected.
  assert.equal(existsSync(join(opencodeHome, "skills", "ipa", "SKILL.md")), false);

  // Then: the global prompt is NOT created.
  assert.equal(existsSync(join(opencodeHome, "AGENTS.md")), false);

  // Then: the manifest records exactly hook:guard and opencode-plugin as selected components.
  const manifest = JSON.parse(await readFile(join(vault, ".ipa", "harness", "opencode", "manifest.json"), "utf8"));
  assert.ok(Array.isArray(manifest.components));
  assert.ok(manifest.components.includes("hook:guard"), "guard must be selected");
  assert.ok(manifest.components.includes("opencode-plugin"), "opencode-plugin must be auto-selected as a dependency of hook:*");
  assert.ok(!manifest.components.includes("skill"), "skill must not be selected");
  assert.ok(!manifest.components.includes("hook:evidence"), "evidence must not be selected");
  assert.ok(!manifest.components.includes("prompt"), "prompt must not be selected");

  // Then: status reports hook:guard as selected and skill/prompt as omitted.
  const status = await harnessStatus(vault, options);
  assert.ok(status.components.selected.includes("hook:guard"));
  assert.ok(status.components.omitted.includes("skill"));
  assert.ok(status.components.omitted.includes("prompt"));

  // Then: doctor is ok because only the guard hook is required.
  assert.equal((await harnessDoctor(vault, options)).status, "ok");

  await harnessUninstall(vault, "opencode", options);
});

test("harness install rejects unknown component before writing any managed artifacts", async () => {
  // Given: a fixture vault and an isolated home directory.
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const options = { homeDir: home, profile: "ipa-test", components: { only: ["nope"] } };

  // When: install codex with an invalid component name.
  // Then: it rejects with an error mentioning "unknown harness component".
  await assert.rejects(
    () => harnessInstall(vault, "codex", options),
    /unknown harness component/
  );

  // Then: no target manifest was written.
  assert.equal(existsSync(join(vault, ".ipa", "harness", "codex", "manifest.json")), false);
  assert.equal(existsSync(join(vault, ".ipa", "harness", "manifest.json")), false);

  // Then: no global codex artifacts were written.
  assert.equal(existsSync(join(home, ".codex")), false);

  // Then: the target is not reported as installed.
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

test("opencode plugin hook:evidence records prompt events from tui.prompt.append and message.updated", async () => {
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const options = { homeDir: home, profile: "ipa-test", components: { only: ["hook:evidence"] } };
  const opencodeHome = join(home, ".config", "opencode");
  const previousVaultEnv = process.env.IPA_VAULT_PATH;
  process.env.IPA_VAULT_PATH = vault;

  try {
    await harnessInstall(vault, "opencode", options);

    const pluginPath = join(opencodeHome, "plugins", "ipa-harness.js");
    assert.ok(existsSync(pluginPath), "plugin file must exist for hook:evidence");
    const pluginModule = await import(pathToFileURL(pluginPath).href);
    const plugin = await pluginModule.IPAHarnessPlugin();
    const eventHook = plugin.hooks["event"];
    assert.ok(typeof eventHook === "function", "event hook must be registered for evidence");

    const eventsPath = join(vault, ".ipa", "tune", "logs", "search-events.jsonl");
    assert.equal(existsSync(eventsPath), false);

    await eventHook({ type: "tui.prompt.append", payload: { prompt: "how do I tune ipa search", session_id: "sess-1" } });
    await eventHook({ type: "message.updated", data: { message: "second prompt text", session_id: "sess-1" } });

    assert.ok(existsSync(eventsPath), "evidence prompt log must be created after prompt events");
    const log = (await readFile(eventsPath, "utf8")).trim().split("\n");
    assert.equal(log.length, 2, "two prompt events must be recorded");
    const first = JSON.parse(log[0]);
    assert.equal(first.event_type, "prompt");
    assert.equal(first.agent, "opencode");
    assert.equal(first.source, "harness");
    assert.equal(first.prompt, "how do I tune ipa search");
    const second = JSON.parse(log[1]);
    assert.equal(second.prompt, "second prompt text");

    await harnessUninstall(vault, "opencode", options);
  } finally {
    if (previousVaultEnv === undefined) delete process.env.IPA_VAULT_PATH;
    else process.env.IPA_VAULT_PATH = previousVaultEnv;
  }
});

test("opencode plugin default full install composes formatter-gate and evidence event handlers", async () => {
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  // Default full install: no components option, so all components including
  // hook:formatter-gate and hook:evidence are selected simultaneously.
  const options = { homeDir: home, profile: "ipa-test" };
  const opencodeHome = join(home, ".config", "opencode");
  const previousVaultEnv = process.env.IPA_VAULT_PATH;
  process.env.IPA_VAULT_PATH = vault;

  try {
    await harnessInstall(vault, "opencode", options);

    const pluginPath = join(opencodeHome, "plugins", "ipa-harness.js");
    assert.ok(existsSync(pluginPath), "plugin file must exist for default full install");
    const pluginModule = await import(pathToFileURL(pluginPath).href);
    const plugin = await pluginModule.IPAHarnessPlugin();
    const eventHook = plugin.hooks["event"];
    assert.ok(typeof eventHook === "function", "event hook must be registered for default full install");

    const eventsPath = join(vault, ".ipa", "tune", "logs", "search-events.jsonl");
    assert.equal(existsSync(eventsPath), false, "no evidence log before prompt events");

    // When: a prompt event arrives. The evidence handler must record it even
    // though the formatter-gate handler is also registered on the same event hook.
    await eventHook({ type: "tui.prompt.append", payload: { prompt: "composes both handlers", session_id: "sess-compose" } });

    // Then: the evidence prompt log is created, proving the evidence handler
    // was not discarded by the formatter-gate handler assignment.
    assert.ok(existsSync(eventsPath), "evidence prompt log must be created when both formatter-gate and evidence are selected");
    const log = (await readFile(eventsPath, "utf8")).trim().split("\n");
    assert.equal(log.length, 1, "one prompt event must be recorded");
    const first = JSON.parse(log[0]);
    assert.equal(first.event_type, "prompt");
    assert.equal(first.agent, "opencode");
    assert.equal(first.prompt, "composes both handlers");

    // When: a session.idle event arrives. The formatter-gate handler must
    // still be callable in the same composed hook. With no pending formatter
    // notes, runFormatterGate returns early without throwing.
    await eventHook({ type: "session.idle" });

    await harnessUninstall(vault, "opencode", options);
  } finally {
    if (previousVaultEnv === undefined) delete process.env.IPA_VAULT_PATH;
    else process.env.IPA_VAULT_PATH = previousVaultEnv;
  }
});

test("opencode plugin hook:session-env injects IPA_SEARCH_LOG=1 via shell.env", async () => {
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const options = { homeDir: home, profile: "ipa-test", components: { only: ["hook:session-env"] } };
  const opencodeHome = join(home, ".config", "opencode");
  const previousVaultEnv = process.env.IPA_VAULT_PATH;
  process.env.IPA_VAULT_PATH = vault;

  try {
    await harnessInstall(vault, "opencode", options);

    const pluginPath = join(opencodeHome, "plugins", "ipa-harness.js");
    const pluginModule = await import(pathToFileURL(pluginPath).href);
    const plugin = await pluginModule.IPAHarnessPlugin();
    const envHook = plugin.hooks["shell.env"];
    assert.ok(typeof envHook === "function", "shell.env hook must be registered for session-env");
    const result = await envHook();
    assert.equal(result.env.IPA_SEARCH_LOG, "1");

    await harnessUninstall(vault, "opencode", options);
  } finally {
    if (previousVaultEnv === undefined) delete process.env.IPA_VAULT_PATH;
    else process.env.IPA_VAULT_PATH = previousVaultEnv;
  }
});

test("opencode plugin hook:markdown-nudge records pending formatter state after tool execute", async () => {
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const options = { homeDir: home, profile: "ipa-test", components: { only: ["hook:markdown-nudge"] } };
  const opencodeHome = join(home, ".config", "opencode");
  const previousVaultEnv = process.env.IPA_VAULT_PATH;
  process.env.IPA_VAULT_PATH = vault;

  try {
    await harnessInstall(vault, "opencode", options);

    const pluginPath = join(opencodeHome, "plugins", "ipa-harness.js");
    const pluginModule = await import(pathToFileURL(pluginPath).href);
    const plugin = await pluginModule.IPAHarnessPlugin();
    const afterHook = plugin.hooks["tool.execute.after"];
    assert.ok(typeof afterHook === "function", "tool.execute.after hook must be registered for markdown-nudge");

    const inboxNoteRel = "00 Inbox/DraftNote.md";
    const inboxNoteAbs = join(vault, inboxNoteRel);
    await mkdir(dirname(inboxNoteAbs), { recursive: true });
    await writeFile(inboxNoteAbs, "# DraftNote\n", "utf8");

    await afterHook({ output: { args: { filePath: inboxNoteAbs } }, cwd: vault });

    const pendingPath = join(vault, ".ipa", "harness", "formatter-pending.json");
    assert.ok(existsSync(pendingPath), "formatter-pending.json must be created after markdown edit");
    const pending = JSON.parse(await readFile(pendingPath, "utf8"));
    assert.ok(pending.notes.some((item) => item.title === "DraftNote"), "DraftNote must be in pending list");

    await harnessUninstall(vault, "opencode", options);
  } finally {
    if (previousVaultEnv === undefined) delete process.env.IPA_VAULT_PATH;
    else process.env.IPA_VAULT_PATH = previousVaultEnv;
  }
});

test("opencode plugin hook:guard blocks new markdown outside inbox on tool.execute.before", async () => {
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const options = { homeDir: home, profile: "ipa-test", components: { only: ["hook:guard"] } };
  const opencodeHome = join(home, ".config", "opencode");
  const previousVaultEnv = process.env.IPA_VAULT_PATH;
  process.env.IPA_VAULT_PATH = vault;

  try {
    await harnessInstall(vault, "opencode", options);

    const pluginPath = join(opencodeHome, "plugins", "ipa-harness.js");
    const pluginModule = await import(pathToFileURL(pluginPath).href);
    const plugin = await pluginModule.IPAHarnessPlugin();
    const beforeHook = plugin.hooks["tool.execute.before"];
    assert.ok(typeof beforeHook === "function", "tool.execute.before hook must be registered for guard");

    const outsideInboxRel = "01 Project/OutsideNote.md";
    const outsideAbs = join(vault, outsideInboxRel);
    const decision = await beforeHook({ output: { args: { filePath: outsideAbs } }, cwd: vault });
    assert.equal(decision.decision, "block", "guard must block new markdown outside inbox");
    assert.match(decision.reason, /IPA guard blocked/);

    const inboxRel = "00 Inbox/InboxNote.md";
    const inboxAbs = join(vault, inboxRel);
    const allowed = await beforeHook({ output: { args: { filePath: inboxAbs } }, cwd: vault });
    assert.notEqual(allowed.decision, "block", "guard must not block new markdown inside inbox");

    await harnessUninstall(vault, "opencode", options);
  } finally {
    if (previousVaultEnv === undefined) delete process.env.IPA_VAULT_PATH;
    else process.env.IPA_VAULT_PATH = previousVaultEnv;
  }
});

test("opencode plugin --without hook:evidence generates no evidence behavior", async () => {
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const options = { homeDir: home, profile: "ipa-test", components: { without: ["hook:evidence"] } };
  const opencodeHome = join(home, ".config", "opencode");
  const previousVaultEnv = process.env.IPA_VAULT_PATH;
  process.env.IPA_VAULT_PATH = vault;

  try {
    await harnessInstall(vault, "opencode", options);

    const pluginPath = join(opencodeHome, "plugins", "ipa-harness.js");
    const pluginSource = await readFile(pluginPath, "utf8");
    assert.match(pluginSource, /IPA_HARNESS_MANAGED/);
    assert.doesNotMatch(pluginSource, /evidenceHandler/, "evidence handler must be absent when hook:evidence is omitted");

    const pluginModule = await import(pathToFileURL(pluginPath).href);
    const plugin = await pluginModule.IPAHarnessPlugin();
    const eventHook = plugin.hooks["event"];
    if (eventHook) {
      await eventHook({ type: "tui.prompt.append", payload: { prompt: "should not be recorded" } });
    }
    const eventsPath = join(vault, ".ipa", "tune", "logs", "search-events.jsonl");
    assert.equal(existsSync(eventsPath), false, "no evidence log must be created when hook:evidence is omitted");

    await harnessUninstall(vault, "opencode", options);
  } finally {
    if (previousVaultEnv === undefined) delete process.env.IPA_VAULT_PATH;
    else process.env.IPA_VAULT_PATH = previousVaultEnv;
  }
});

test("opencode full install reports plugin-backed hook components as present in status and doctor", async () => {
  // Given: a fixture vault and an isolated home directory.
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const options = { homeDir: home, profile: "ipa-test" };

  // When: full default install for the opencode target.
  await harnessInstall(vault, "opencode", options);

  // Then: status reports all selected hook components as present via the plugin file.
  const status = await harnessStatus(vault, options);
  const components = status.global.opencode.components;
  assert.equal(components["hook:session-env"], true, "hook:session-env must be present via plugin");
  assert.equal(components["hook:guard"], true, "hook:guard must be present via plugin");
  assert.equal(components["hook:markdown-nudge"], true, "hook:markdown-nudge must be present via plugin");
  assert.equal(components["hook:formatter-gate"], true, "hook:formatter-gate must be present via plugin");
  assert.equal(components["hook:evidence"], true, "hook:evidence must be present via plugin");

  // Then: doctor reports no false-positive missing hook script warnings for plugin-backed hooks.
  const doctor = await harnessDoctor(vault, options);
  const hookMissingIssues = (doctor.issues ?? []).filter(
    (issue) => typeof issue.code === "string" && issue.code.includes("_hook_missing")
  );
  assert.equal(hookMissingIssues.length, 0, "doctor must not report false-positive hook_missing warnings for plugin-backed OpenCode hooks");

  await harnessUninstall(vault, "opencode", options);
});

test("call-counter hook counts ipa Bash calls per session and nudges at the threshold", async () => {
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const options = { homeDir: home, profile: "ipa-test" };
  await harnessInstall(vault, "claude", options);

  const script = join(home, ".claude", "hooks", "ipa-call-counter.mjs");
  assert.equal(existsSync(script), true);
  const hookEnv = { ...process.env, IPA_VAULT_PATH: vault };
  const runHook = (command, sessionId = "sess-counter") => spawnSync(process.execPath, [script], {
    input: JSON.stringify({ session_id: sessionId, tool_name: "Bash", tool_input: { command } }),
    env: hookEnv,
    encoding: "utf8"
  });

  // Non-ipa commands are ignored entirely.
  const ignored = runHook("git status");
  assert.equal(ignored.status, 0);
  assert.equal(ignored.stdout.trim(), "");
  assert.equal(existsSync(join(vault, ".ipa", "harness", "call-counter.json")), false);

  // ipa calls 1..9 count silently; the 10th emits a convergence nudge.
  for (let index = 1; index <= 9; index += 1) {
    const silent = runHook(`ipa search "query ${index}"`);
    assert.equal(silent.status, 0);
    assert.equal(silent.stdout.trim(), "", `call ${index} must stay silent`);
  }
  const nudged = runHook('ipa view "Some Note" --full');
  assert.equal(nudged.status, 0);
  const payload = JSON.parse(nudged.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(payload.hookSpecificOutput.additionalContext, /10 ipa calls/);
  assert.match(payload.hookSpecificOutput.additionalContext, /converging/);

  // Counts are per session: a different session starts from zero.
  const otherSession = runHook('ipa search "other"', "sess-other");
  assert.equal(otherSession.stdout.trim(), "");

  // The claude settings registration uses the Bash matcher on PostToolUse.
  const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
  const counterGroups = (settings.hooks.PostToolUse ?? []).filter((group) =>
    (group.hooks ?? []).some((hook) => hook.command.includes("ipa-call-counter.mjs"))
  );
  assert.equal(counterGroups.length, 1);
  assert.equal(counterGroups[0].matcher, "Bash");

  await harnessUninstall(vault, "claude", options);
  assert.equal(existsSync(script), false);
});

test("core-backed writes sync the mapped updated_at field automatically", async () => {
  const vault = await fixtureVault();
  const before = await readFile(join(vault, "00 Inbox", "Alpha.md"), "utf8");
  assert.match(before, /date_modified: 2026\/05\/10/);

  const result = await replaceInNote(vault, "Alpha", "Alpha mentions Beta in plain text.", "Alpha mentions Beta loudly.", { apply: true });
  assert.equal(result.applied, true);
  assert.equal(result.updated_at_synced, true);
  const after = await readFile(join(vault, "00 Inbox", "Alpha.md"), "utf8");
  assert.doesNotMatch(after, /date_modified: "?2026\/05\/10/);
  assert.match(after, /date_created: 2026\/05\/10/);

  // Preview writes nothing and reports what would change.
  const preview = await replaceInNote(vault, "Alpha", "Alpha mentions Beta loudly.", "Alpha whispers.", { apply: false });
  assert.equal(preview.applied, false);
  const untouched = await readFile(join(vault, "00 Inbox", "Alpha.md"), "utf8");
  assert.match(untouched, /Alpha mentions Beta loudly\./);
});

test("setNoteField edits scalars and lists without exact matching", async () => {
  const vault = await fixtureVault();

  const scalar = await setNoteField(vault, "Alpha", "obsidianUIMode", { value: "source", apply: true });
  assert.equal(scalar.applied, true);
  assert.match(await readFile(join(vault, "00 Inbox", "Alpha.md"), "utf8"), /obsidianUIMode: source/);

  const missing = await setNoteField(vault, "Alpha", "brand-new-field", { value: "hello", apply: true });
  assert.equal(missing.applied, true);
  assert.match(await readFile(join(vault, "00 Inbox", "Alpha.md"), "utf8"), /brand-new-field: hello/);

  const refs = await setNoteField(vault, "Beta", "ref", { add: ["🏷️ Topic Root"], apply: true });
  assert.equal(refs.applied, true);
  assert.match(await readFile(join(vault, "00 Inbox", "Beta.md"), "utf8"), /\[\[🏷️ Topic Root\]\]/);

  await assert.rejects(() => setNoteField(vault, "Alpha", "tags", { apply: true }), /requires --value, --add, or --remove/);
  await assert.rejects(() => setNoteField(vault, "Alpha", "tags", { value: "x", add: ["y"], apply: true }), /cannot combine/);
});

test("digestNote returns children with snippets and dates in one call", async () => {
  const vault = await fixtureVault();
  const digest = await digestNote(vault, "🔖 Topic Index");
  assert.equal(digest.operation, "digest");
  assert.ok(digest.children_total >= 2);
  const alpha = digest.items.find((item) => item.id === "Alpha");
  assert.ok(alpha, "Alpha child present");
  assert.match(alpha.snippet, /Alpha mentions Beta/);
  assert.equal(alpha.modified, "2026/05/10 (Sun) 00:00:00");
  assert.ok(alpha.headings.length >= 1);

  const capped = await digestNote(vault, "🔖 Topic Index", { max: 1 });
  assert.equal(capped.children_shown, 1);
  assert.equal(capped.children_total, digest.children_total);
});

test("redirectNotes rewires wikilinks and refs to the target and archives sources", async () => {
  const vault = await fixtureVault();

  const preview = await redirectNotes(vault, ["Alpha"], "Beta", { archive: true });
  assert.equal(preview.apply, false);
  assert.ok(preview.changes.some((item) => item.note === "🔖 Topic Index" && item.links));
  assert.match(await readFile(join(vault, "01 Project", "🔖 Topic Index.md"), "utf8"), /\[\[Alpha\]\]/);
  assert.equal(existsSync(join(vault, "00 Inbox", "Alpha.md")), true);

  const applied = await redirectNotes(vault, ["Alpha"], "Beta", { archive: true, apply: true });
  assert.equal(applied.apply, true);
  const index = await readFile(join(vault, "01 Project", "🔖 Topic Index.md"), "utf8");
  assert.doesNotMatch(index, /\[\[Alpha\]\]/);
  assert.match(index, /\[\[Beta\]\]/);
  const beta = await readFile(join(vault, "00 Inbox", "Beta.md"), "utf8");
  assert.doesNotMatch(beta, /Beta links to \[\[Alpha\]\]/);
  assert.equal(existsSync(join(vault, "00 Inbox", "Alpha.md")), false);
  assert.equal(existsSync(join(vault, "02 Archive", "Alpha.md")), true);

  await assert.rejects(() => redirectNotes(vault, ["Beta"], "Beta", { apply: false }), /source equals target/);
});

test("cascadeNote plans ref/link wiring and reports overlaps without editing content", async () => {
  const vault = await fixtureVault();
  await writeFile(
    join(vault, "00 Inbox", "Gamma.md"),
    "---\ndate_created: 2026/05/10 (Sun) 00:00:00\ndate_modified: 2026/05/10 (Sun) 00:00:00\nref: []\ntags: []\ntype: note\n---\n# Gamma\n\nGamma extends Alpha with new findings.\n\n## Details\n\nMore on the topic index subject.\n",
    "utf8"
  );

  const plan = await cascadeNote(vault, "Gamma");
  assert.equal(plan.apply, false);
  assert.ok(plan.forward_links.some((item) => item.target === "Alpha"), "plain-text Alpha mention becomes a forward link");
  assert.ok(plan.ref_suggestions.some((item) => item.ref === "🔖 Topic Index"), "ref suggestion from related notes");
  assert.ok(Array.isArray(plan.overlaps));
  const untouched = await readFile(join(vault, "00 Inbox", "Gamma.md"), "utf8");
  assert.doesNotMatch(untouched, /\[\[Alpha\]\]/);

  const applied = await cascadeNote(vault, "Gamma", { apply: true, only: ["refs", "links"] });
  assert.ok(applied.applied.length >= 2);
  const gamma = await readFile(join(vault, "00 Inbox", "Gamma.md"), "utf8");
  assert.match(gamma, /\[\[Alpha\]\]/);
  assert.match(gamma, /\[\[🔖 Topic Index\]\]/);
});

test("write paths stamp vault-format dates and formatter fixes mixed ISO pollution", async () => {
  const vault = await fixtureVault();

  await refactorVault(vault, "tag-add", ["fresh"], { apply: true });
  const alpha = await readFile(join(vault, "00 Inbox", "Alpha.md"), "utf8");
  const stamp = alpha.match(/date_modified: (.*)/)[1];
  assert.match(stamp, /^"?\d{4}\/\d{2}\/\d{2} \([A-Z][a-z]{2}\) \d{2}:\d{2}:\d{2}"?$/, `vault format expected, got ${stamp}`);

  // Simulate legacy ISO pollution in one field only (mixed formats).
  await writeFile(
    join(vault, "00 Inbox", "Mixed.md"),
    "---\ndate_created: 2026/05/10 (Sun) 00:00:00\ndate_modified: 2026-06-23T06:48:04.214Z\nref: [\"[[🔖 Topic Index]]\"]\ntags: []\ntype: note\n---\n# Mixed\n\nBody\n",
    "utf8"
  );
  const plan = await formatVault(vault, false, { notes: ["Mixed"], ruleApply: true });
  assert.ok(plan.patches.some((patch) => patch.rules.includes("ipa.frontmatter.date_format")));
  await formatVault(vault, true, { notes: ["Mixed"] });
  const mixed = await readFile(join(vault, "00 Inbox", "Mixed.md"), "utf8");
  assert.doesNotMatch(mixed, /date_modified: 2026-06-23T/);
  // apply re-stamps updated_at at write time, so only the format is asserted.
  assert.match(mixed, /date_modified: "?\d{4}\/\d{2}\/\d{2} \([A-Z][a-z]{2}\)/);
});

test("absolute_path rule is config-gated and fixes aliased paths", async () => {
  const vault = await fixtureVault();
  await writeFile(
    join(vault, "00 Inbox", "Paths.md"),
    "---\ndate_created: 2026/05/10 (Sun) 00:00:00\ndate_modified: 2026/05/10 (Sun) 00:00:00\nref: [\"[[🔖 Topic Index]]\"]\ntags: []\ntype: note\n---\n# Paths\n\nSee /Users/someone/workspace/acme/packages/core/index.ts for details.\n",
    "utf8"
  );

  // Without path_aliases config the rule stays silent.
  const silent = await validateVault(vault);
  assert.ok(!silent.issues.some((item) => item.code === "ipa.content.absolute_path"));

  const configPath = join(vault, ".ipa", "config.yaml");
  await writeFile(configPath, (await readFile(configPath, "utf8")) + "path_aliases:\n  acme: /Users/someone/workspace/acme\n", "utf8");

  const flagged = await validateVault(vault);
  assert.ok(flagged.issues.some((item) => item.code === "ipa.content.absolute_path" && item.note === "Paths"));

  await formatVault(vault, true, { notes: ["Paths"] });
  const fixed = await readFile(join(vault, "00 Inbox", "Paths.md"), "utf8");
  assert.doesNotMatch(fixed, /\/Users\/someone\/workspace\/acme/);
  assert.match(fixed, /See acme\/packages\/core\/index\.ts/);
});

test("review sot is config-gated and flags report-style pileups under one index", async () => {
  const vault = await fixtureVault();
  for (const title of ["AI-1 구현 계획", "AI-1 구현 결과", "AI-2 검증 결과", "AI-2 최종 보고서"]) {
    await writeFile(
      join(vault, "00 Inbox", `${title}.md`),
      `---\ndate_created: 2026/05/10 (Sun) 00:00:00\ndate_modified: 2026/05/10 (Sun) 00:00:00\nref: ["[[🔖 Topic Index]]"]\ntags: []\ntype: note\n---\n# ${title}\n\nBody\n`,
      "utf8"
    );
  }
  // The report-title vocabulary is operating policy: without config the scope
  // stays silent.
  const silent = await reviewVault(vault, "sot");
  assert.equal(silent.issues.filter((item) => item.code === "review.sot.consolidation_candidate").length, 0);

  const configPath = join(vault, ".ipa", "config.yaml");
  await writeFile(
    configPath,
    `${await readFile(configPath, "utf8")}review:\n  sot:\n    title_patterns: [계획, 결과, 보고서?, report]\n    min: 4\n`,
    "utf8"
  );
  const review = await reviewVault(vault, "sot");
  const candidate = review.issues.find((item) => item.code === "review.sot.consolidation_candidate");
  assert.ok(candidate, "consolidation candidate reported");
  assert.equal(candidate.note, "🔖 Topic Index");
  assert.ok(candidate.notes.length >= 4);
});

test("formatter apply keeps plan clean afterwards even when non-date patches move mtime", async () => {
  const vault = await fixtureVault();
  // Note with a spacing violation the obsidian rules would fix — but the
  // fixture vault has no plugin rules, so simulate with a mixed-ISO date
  // (date_format fix) plus verify updated_at is stamped at write time.
  await writeFile(
    join(vault, "00 Inbox", "Converge.md"),
    "---\ndate_created: 2026/05/10 (Sun) 00:00:00\ndate_modified: 2026-06-23T06:48:04.214Z\nref: [\"[[🔖 Topic Index]]\"]\ntags: []\ntype: note\n---\n# Converge\n\nBody\n",
    "utf8"
  );
  const first = await formatVault(vault, true, { notes: ["Converge"] });
  assert.ok(first.applied.length >= 1);
  const after = await formatVault(vault, false, { notes: ["Converge"], ruleApply: true });
  assert.equal(after.summary.patches, 0, JSON.stringify(after.patches));
  const raw = await readFile(join(vault, "00 Inbox", "Converge.md"), "utf8");
  assert.match(raw, /date_modified: "?\d{4}\/\d{2}\/\d{2}/);
});

function gitCmd(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("cliVersionInfo reports workspace version, commit, and repo root", () => {
  const info = cliVersionInfo();
  assert.match(info.version, /^\d+\.\d+\.\d+/);
  assert.ok(info.repo_root && existsSync(join(info.repo_root, "package.json")));
  assert.match(info.commit ?? "", /^[0-9a-f]{6,}$/);
});

test("selfUpdate plans behind commits and applies a fast-forward pull on a fixture checkout", async () => {
  const work = await mkdtemp(join(tmpdir(), "ipa-update-test-"));
  const origin = join(work, "origin");
  await mkdir(origin, { recursive: true });
  gitCmd(origin, "init", "-b", "main");
  gitCmd(origin, "config", "user.email", "test@example.com");
  gitCmd(origin, "config", "user.name", "test");
  await writeFile(join(origin, "README.md"), "v1\n", "utf8");
  gitCmd(origin, "add", ".");
  gitCmd(origin, "commit", "-m", "first");
  const clone = join(work, "clone");
  gitCmd(work, "clone", origin, clone);
  await writeFile(join(origin, "README.md"), "v2\n", "utf8");
  gitCmd(origin, "add", ".");
  gitCmd(origin, "commit", "-m", "second change");

  const plan = await selfUpdate({ repoRoot: clone });
  assert.equal(plan.mode, "plan");
  assert.equal(plan.behind, 1);
  assert.equal(plan.up_to_date, false);
  assert.match(plan.changes[0], /second change/);
  assert.deepEqual(plan.commands, ["git pull --ff-only", "pnpm install", "pnpm run build"]);
  assert.match(plan.hint, /ipa update --apply/);

  await writeFile(join(clone, "local.txt"), "dirty\n", "utf8");
  const dirty = await selfUpdate({ repoRoot: clone, apply: true, steps: [["git", "pull", "--ff-only"]] });
  assert.equal(dirty.status, "error");
  assert.equal(dirty.reason, "dirty_worktree");
  await rm(join(clone, "local.txt"));

  const applied = await selfUpdate({ repoRoot: clone, apply: true, steps: [["git", "pull", "--ff-only"]] });
  assert.equal(applied.applied, true);
  assert.equal(applied.steps.length, 1);
  assert.equal(applied.steps[0].ok, true);
  assert.match(applied.commit_after ?? "", /^[0-9a-f]{6,}$/);
  assert.match(applied.next, /ipa harness update/);

  const after = await selfUpdate({ repoRoot: clone, apply: true });
  assert.equal(after.up_to_date, true);
  assert.equal(after.applied, false);
});

test("harness status/doctor flag outdated components and harness update reinstalls with preserved selection", async () => {
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const options = { homeDir: home, profile: "ipa-test" };
  await harnessInstall(vault, "codex", { ...options, components: { without: ["hook:evidence"] } });

  let status = await harnessStatus(vault, options);
  assert.deepEqual(status.outdated, {});
  assert.equal(status.update_hint, null);
  assert.match(status.global.codex.cli_version ?? "", /^\d+\.\d+\.\d+/);

  // Simulate files written by an older CLI: managed marker intact, content stale.
  const guardHook = join(home, ".codex", "hooks", "ipa-inbox-guard.mjs");
  await writeFile(guardHook, `${await readFile(guardHook, "utf8")}\n// stale template line\n`, "utf8");
  const localPrompt = join(vault, "AGENTS.md");
  const promptText = await readFile(localPrompt, "utf8");
  await writeFile(localPrompt, promptText.replace("<!-- IPA_HARNESS_MANAGED_BEGIN:ipa-harness -->", "<!-- IPA_HARNESS_MANAGED_BEGIN:ipa-harness -->\nSTALE"), "utf8");

  status = await harnessStatus(vault, options);
  assert.deepEqual([...status.outdated.codex].sort(), ["hook:guard", "local-prompt"]);
  assert.match(status.update_hint, /ipa harness update codex/);
  assert.deepEqual(status.global.codex.outdated_components.sort(), ["hook:guard", "local-prompt"]);
  const doctorReport = await harnessDoctor(vault, options);
  const outdatedIssues = doctorReport.issues.filter((issue) => issue.code === "harness.component_outdated");
  assert.equal(outdatedIssues.length, 2);
  assert.match(outdatedIssues[0].message, /ipa harness update codex/);

  const updated = await harnessUpdate(vault, "codex", options);
  assert.equal(updated.status, "ok");
  assert.equal(updated.updated, true);
  assert.ok(!updated.components.includes("hook:evidence"));
  assert.deepEqual(updated.omitted_components, ["hook:evidence"]);

  status = await harnessStatus(vault, options);
  assert.deepEqual(status.outdated, {});
  assert.equal(existsSync(join(home, ".codex", "hooks", "ipa-user-prompt-nudge.mjs")), false, "omitted evidence hook must stay uninstalled after update");
  assert.equal(existsSync(guardHook), true);

  const missing = await harnessUpdate(vault, "claude", options);
  assert.equal(missing.status, "error");
  assert.equal(missing.reason, "not_installed");
});

test("harness guard check allows paths excluded from note indexing", async () => {
  const vault = await fixtureVault();
  const configPath = join(vault, ".ipa", "config.yaml");
  const config = await readFile(configPath, "utf8");
  await writeFile(configPath, `${config.trimEnd()}\nfiles:\n  exclude:\n    - .tmp/**\n`, "utf8");

  const tmp = await harnessGuardCheck(vault, ".tmp/scratch.md", { action: "create" });
  assert.equal(tmp.allowed, true, JSON.stringify(tmp));
  const nested = await harnessGuardCheck(vault, ".tmp/deep/plan.md", { action: "create" });
  assert.equal(nested.allowed, true, JSON.stringify(nested));
  const ipaDir = await harnessGuardCheck(vault, ".ipa/plans/plan.md", { action: "create" });
  assert.equal(ipaDir.allowed, true, JSON.stringify(ipaDir));

  const blocked = await harnessGuardCheck(vault, "01 Project/New Note.md", { action: "create" });
  assert.equal(blocked.allowed, false, JSON.stringify(blocked));
});

test("doctor --check runs a single check and rejects unknown names", async () => {
  const vault = await fixtureVault();
  await rm(join(vault, ".ipa", "config.yaml"), { force: true });
  await mkdir(join(vault, ".ipa", "cache"), { recursive: true });
  await writeFile(join(vault, ".ipa", "cache", "stale.json"), JSON.stringify({ path: vault }), "utf8");

  const full = await doctor(vault);
  assert.ok(full.issues.some((issue) => issue.code === "doctor.config.missing"));
  assert.ok(full.issues.some((issue) => issue.code === "doctor.cache.absolute_path"));

  const cacheOnly = await doctor(vault, { check: "cache" });
  assert.ok(cacheOnly.issues.length >= 1);
  assert.ok(cacheOnly.issues.every((issue) => issue.code.startsWith("doctor.cache.")));

  const configOnly = await doctor(vault, { check: "config" });
  assert.deepEqual(configOnly.issues.map((issue) => issue.code), ["doctor.config.missing"]);

  await assert.rejects(doctor(vault, { check: "nope" }), /unknown doctor check: nope/);
});

test("plugin doctor attributes issues to the failing plugin path", async () => {
  const vault = await fixtureVault();
  await mkdir(join(vault, ".ipa", "plugins", "rules"), { recursive: true });
  await writeFile(join(vault, ".ipa", "plugins", "rules", "broken.js"), "export const nope = {", "utf8");
  const report = await pluginDoctor(vault);
  assert.equal(report.status, "error");
  const broken = report.issues.find((issue) => issue.code === "plugin.load_failed");
  assert.ok(broken, JSON.stringify(report.issues));
  assert.match(broken.path ?? "", /broken\.js/);
});

test("harness doctor flags installed hook scripts that lost their hooks-config registration", async () => {
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const options = { homeDir: home, profile: "ipa-test" };
  await harnessInstall(vault, "codex", options);

  let report = await harnessDoctor(vault, options);
  assert.ok(
    report.issues.every((issue) => !issue.code.includes("_hook_unregistered") && issue.code !== "harness.hooks_config_invalid"),
    JSON.stringify(report.issues)
  );

  const hooksConfigPath = join(home, ".codex", "hooks.json");
  const config = JSON.parse(await readFile(hooksConfigPath, "utf8"));
  config.hooks.PreToolUse = (config.hooks.PreToolUse ?? []).filter(
    (group) => !(group.hooks ?? []).some((hook) => (hook.command ?? "").includes("ipa-inbox-guard.mjs"))
  );
  await writeFile(hooksConfigPath, JSON.stringify(config, null, 2), "utf8");

  report = await harnessDoctor(vault, options);
  const unregistered = report.issues.filter((issue) => issue.code === "harness.global_guard_hook_unregistered");
  assert.equal(unregistered.length, 1, JSON.stringify(report.issues));
  assert.equal(unregistered[0].target, "codex");
  assert.match(unregistered[0].message, /ipa harness update codex/);

  await writeFile(hooksConfigPath, "{ not json", "utf8");
  report = await harnessDoctor(vault, options);
  assert.ok(report.issues.some((issue) => issue.code === "harness.hooks_config_invalid"));
  assert.equal(report.status, "error");
});

test("harness doctor detects a removed vault-local prompt block", async () => {
  const vault = await fixtureVault();
  const home = await mkdtemp(join(tmpdir(), "ipa-harness-home-"));
  const options = { homeDir: home, profile: "ipa-test" };
  await harnessInstall(vault, "codex", options);

  const localPrompt = join(vault, "AGENTS.md");
  const text = await readFile(localPrompt, "utf8");
  await writeFile(
    localPrompt,
    text.replace(/<!-- IPA_HARNESS_MANAGED_BEGIN:ipa-harness -->[\s\S]*?<!-- IPA_HARNESS_MANAGED_END:ipa-harness -->/, ""),
    "utf8"
  );

  const report = await harnessDoctor(vault, options);
  const missing = report.issues.filter((issue) => issue.code === "harness.local_prompt_missing");
  assert.equal(missing.length, 1, JSON.stringify(report.issues));
  assert.match(missing[0].message, /IPA harness block/);
});

test("mapping.date_format drives all core date stamps", async () => {
  const vault = await fixtureVault();
  const configPath = join(vault, ".ipa", "config.yaml");
  await writeFile(
    configPath,
    (await readFile(configPath, "utf8")).replace("  folders:", "  date_format: \"YYYY-MM-DD HH:mm:ss\"\n  folders:"),
    "utf8"
  );
  const draft = join(vault, ".tmp-draft.md");
  await writeFile(draft, "# Custom Date\n\nBody\n", "utf8");
  await inboxAdd(vault, draft, { title: "Custom Date" });
  const { mapping } = await readVaultConfig(vault);
  const raw = await readFile(join(vault, "00 Inbox", "Custom Date.md"), "utf8");
  assert.match(raw, new RegExp(`${mapping.created_at}: "?\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}`));
  assert.match(raw, new RegExp(`${mapping.updated_at}: "?\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}`));

  // note set syncs updated_at through the same configured format
  await setNoteField(vault, "Custom Date", "ref", { add: ["🔖 Topic Index"], apply: true });
  const after = await readFile(join(vault, "00 Inbox", "Custom Date.md"), "utf8");
  assert.match(after, new RegExp(`${mapping.updated_at}: "?\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}`));
});

test("link.ignored_headings and link.stopwords extend link-suggest vocabulary from config", async () => {
  const vault = await fixtureVault();
  const body = (heading) => `---\ndate_created: 2026/05/10 (Sun) 00:00:00\ndate_modified: 2026/05/10 (Sun) 00:00:00\nref: ["[[🔖 Topic Index]]"]\ntags: []\ntype: note\n---\n# Source Note\n\n## ${heading}\n\nGamma Delta uniquefeature pipeline orchestration details repeated here for weighting.\n`;
  await writeFile(join(vault, "00 Inbox", "Vocab Target.md"),
    `---\ndate_created: 2026/05/10 (Sun) 00:00:00\ndate_modified: 2026/05/10 (Sun) 00:00:00\nref: ["[[🔖 Topic Index]]"]\ntags: []\ntype: note\n---\n# Vocab Target\n\nGamma Delta uniquefeature pipeline orchestration reference document.\n`, "utf8");
  await writeFile(join(vault, "00 Inbox", "Vocab Source.md"), body("업무 메모"), "utf8");

  const before = await suggestLinks(vault, "Vocab Source");
  const hadTarget = before.suggestions.some((item) => item.target === "Vocab Target");
  assert.equal(hadTarget, true, "semantic suggestion should surface before heading is ignored");

  const configPath = join(vault, ".ipa", "config.yaml");
  await writeFile(configPath, `${await readFile(configPath, "utf8")}link:\n  ignored_headings: [업무 메모]\n`, "utf8");
  const after = await suggestLinks(vault, "Vocab Source");
  const semanticAfter = after.suggestions.filter((item) => item.target === "Vocab Target" && item.sources.some((source) => source.reason === "semantic_search_match"));
  assert.equal(semanticAfter.length, 0, "ignored heading must drop semantic suggestions sourced under it");
});

test("plugin rules receive the vault config through RuleContext", async () => {
  const vault = await fixtureVault();
  await mkdir(join(vault, ".ipa", "plugins", "rules"), { recursive: true });
  const rulePath = join(vault, ".ipa", "plugins", "rules", "config-probe.js");
  await writeFile(rulePath, `
export default {
  code: "vault.test.config_probe",
  severity: "info",
  checkNote(note, ctx) {
    if (note.id !== "Alpha") return null;
    const probe = ctx.config?.test?.file ? "config-present" : "config-missing";
    return { message: probe };
  }
};
`, "utf8");
  const result = await pluginDryRun(vault, "rules", ".ipa/plugins/rules/config-probe.js", { note: "Alpha" });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].message, "config-present");
});

test("validateVault --note scoping filters issues to the requested notes", async () => {
  const vault = await fixtureVault();
  // A note with a guaranteed issue: tag not in snake_case
  await writeFile(
    join(vault, "00 Inbox", "Scoped.md"),
    `---\ndate_created: 2026/05/10 (Sun) 00:00:00\ndate_modified: 2026/05/10 (Sun) 00:00:00\nref: ["[[🔖 Topic Index]]"]\ntags: ["BadTag"]\ntype: note\n---\n# Scoped\n\nBody\n`,
    "utf8"
  );
  const scoped = await validateVault(vault, null, { notes: ["Scoped"] });
  assert.deepEqual(scoped.scope_notes, ["Scoped"]);
  assert.ok(scoped.issues.length >= 1, "scoped note issues reported");
  assert.ok(scoped.issues.every((item) => item.note === "Scoped" || item.path?.includes("Scoped")), JSON.stringify(scoped.issues));

  const other = await validateVault(vault, null, { notes: ["Alpha"] });
  assert.equal(other.issues.some((item) => item.note === "Scoped"), false, "other-note scope must not include Scoped issues");

  await assert.rejects(() => validateVault(vault, null, { notes: ["존재하지 않는 노트"] }), /note not found/);
});

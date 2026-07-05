// bench/tests/judge.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { evaluateExpect } from "../lib/judge.mjs";
import { emptyParsed } from "../lib/transcript.mjs";
import { createSandbox, snapshot, diffSnapshots } from "../lib/sandbox.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IPA_BIN = join(REPO, "packages", "cli", "dist", "main.js");
const MINI_VAULT = join(REPO, "packages", "test-vaults", "fixtures", "mini-vault");

const baseCtx = (over = {}) => ({
  sandboxDir: mkdtempSync(join(tmpdir(), "judge-")),
  diff: { added: [], removed: [], modified: [] },
  parsed: emptyParsed(),
  ipaBin: IPA_BIN,
  ...over,
});

const allPass = (rs) => rs.every((r) => r.pass);

test("call assertions", () => {
  const parsed = { ...emptyParsed(), ipaCalls: [{ id: "1", command: 'ipa note set "A" --add tags x', isError: false }] };
  assert.ok(allPass(evaluateExpect({ ipa_used: true, used_command: "note set", not_used_command: "refactor" }, baseCtx({ parsed }))));
  assert.ok(!allPass(evaluateExpect({ no_ipa_calls: true }, baseCtx({ parsed }))));
});

test("command_flow matches ordered subsequence of ipa calls", () => {
  const parsed = { ...emptyParsed(), ipaCalls: [
    { id: "1", command: 'ipa search "커피" "드립"', isError: false },
    { id: "2", command: 'ipa validator --note "Alpha"', isError: false },
    { id: "3", command: 'ipa view "V60 15g 240g 기본 레시피" --full', isError: false },
  ] };
  // 순서대로 매칭 (중간에 다른 호출이 끼어도 부분수열이면 통과)
  assert.ok(allPass(evaluateExpect({ command_flow: ["search", "view.*V60"] }, baseCtx({ parsed }))));
  // 역순은 실패
  assert.ok(!allPass(evaluateExpect({ command_flow: ["view", "search"] }, baseCtx({ parsed }))));
  // 없는 스텝은 실패
  assert.ok(!allPass(evaluateExpect({ command_flow: ["search", "note set"] }, baseCtx({ parsed }))));
});

test("diff assertions ignore harness md and .ipa internals", () => {
  const diff = { added: ["00 Inbox/새 메모.md", "CLAUDE.md", ".ipa/cache/files.jsonl"], removed: [], modified: ["01 Project/기존.md"] };
  const rs = evaluateExpect({
    md_changed_max: 2,
    notes_added: { folder: "00 Inbox", min: 1, title_regex: "메모" },
    file_added: "새 메모",
    md_changes_within: ["00 Inbox", "01 Project"],
  }, baseCtx({ diff }));
  assert.ok(allPass(rs), JSON.stringify(rs));
});

test("changedMd excludes .claude/ harness skills written by harness install", () => {
  // `ipa harness install claude`가 샌드박스에 쓰는 볼트-로컬 스킬은 볼트 노트가 아니다.
  const diff = { added: [".claude/skills/ipa-config/SKILL.md", ".claude/skills/ipa-tune/SKILL.md", "00 Inbox/진짜 노트.md"], removed: [], modified: [] };
  const rs = evaluateExpect({ md_changed_max: 1 }, baseCtx({ diff }));
  assert.ok(allPass(rs), JSON.stringify(rs)); // .claude/* 3개는 세지 않고 실제 노트 1개만 카운트
});

test("file_removed matches a deleted path (rename drops the old title)", () => {
  const diff = { added: ["01 Project/커피/☕ 새.md"], removed: ["01 Project/커피/🔖 옛.md"], modified: [] };
  assert.ok(allPass(evaluateExpect({ file_removed: "🔖 옛\\.md" }, baseCtx({ diff }))));
  assert.ok(!allPass(evaluateExpect({ file_removed: "없는파일" }, baseCtx({ diff }))));
});

test("notes_moved_max counts basename pairs across removed/added", () => {
  const diff = {
    removed: ["00 Inbox/Alpha.md", "00 Inbox/Beta.md"],
    added: ["02 Archive/Alpha.md", "02 Archive/Beta.md", "00 Inbox/새 노트.md"], // 2개 이동 + 1개 신규
    modified: ["01 Project/기존.md"],
  };
  assert.ok(allPass(evaluateExpect({ notes_moved_max: 2 }, baseCtx({ diff }))));
  assert.ok(!allPass(evaluateExpect({ notes_moved_max: 1 }, baseCtx({ diff }))));
});

test("file_contains reads sandbox files", () => {
  const ctx = baseCtx();
  mkdirSync(join(ctx.sandboxDir, ".ipa"), { recursive: true });
  writeFileSync(join(ctx.sandboxDir, ".ipa", "config.yaml"), "mapping:\n  folders:\n    inbox: Inbox\n");
  assert.ok(allPass(evaluateExpect({ file_contains: { path: ".ipa/config.yaml", regex: "inbox" } }, ctx)));
});

test("formatter_pending_empty runs real formatter against mini-vault copy", () => {
  const sb = createSandbox(MINI_VAULT, "judge");
  // Alpha는 no_h1 상시 패치를 안고 있어, 본문만 바꾼 변경도 통과하도록 먼저 적용해 정리한다.
  execFileSync(process.execPath, [IPA_BIN, "--vault", sb, "formatter", "apply", "--note", "Alpha"],
    { cwd: sb, stdio: "ignore" });
  const before = snapshot(sb);
  const alpha = join(sb, "00 Inbox", "Alpha.md");
  writeFileSync(alpha, readFileSync(alpha, "utf8") + "\n추가 줄\n");
  const cleanDiff = diffSnapshots(before, snapshot(sb));
  const passRs = evaluateExpect({ formatter_pending_empty: true }, baseCtx({ sandboxDir: sb, diff: cleanDiff }));
  assert.equal(passRs.length, 1);
  assert.ok(passRs[0].pass, passRs[0].detail); // 적용 후 본문만 바뀐 노트는 미적용 패치 0

  // date_modified만 ISO 타임스탬프로 바꿔 mixed-ISO 패치를 실제로 만든다 → 실패해야 한다.
  writeFileSync(alpha, readFileSync(alpha, "utf8").replace(/date_modified: .*/, "date_modified: 2026-05-10T00:00:00Z"));
  const dirtyDiff = { added: [], removed: [], modified: ["00 Inbox/Alpha.md"] };
  const failRs = evaluateExpect({ formatter_pending_empty: true }, baseCtx({ sandboxDir: sb, diff: dirtyDiff }));
  assert.equal(failRs.length, 1);
  assert.ok(!failRs[0].pass, failRs[0].detail);
  assert.match(failRs[0].detail, /patches pending in Alpha/);
});

test("formatter_pending_empty skips titles that don't resolve as notes", () => {
  const sb = createSandbox(MINI_VAULT, "judge");
  execFileSync(process.execPath, [IPA_BIN, "--vault", sb, "formatter", "apply", "--note", "Alpha"],
    { cwd: sb, stdio: "ignore" });
  const alpha = join(sb, "00 Inbox", "Alpha.md");
  writeFileSync(alpha, readFileSync(alpha, "utf8") + "\n추가 줄\n");
  // Meta/ 노트는 디스크에 쓰지 않아 formatter plan이 "note not found"로 실패 → 에러가 아니라 skip.
  const diff = { added: ["Meta/설명 문서.md"], removed: [], modified: ["00 Inbox/Alpha.md"] };
  const rs = evaluateExpect({ formatter_pending_empty: true }, baseCtx({ sandboxDir: sb, diff }));
  assert.equal(rs.length, 1);
  assert.ok(rs[0].pass, rs[0].detail);
  assert.match(rs[0].detail, /1 skipped: not indexed/);
});

test("unknown assertion key fails loudly", () => {
  const rs = evaluateExpect({ no_ipa_callz: true }, baseCtx());
  assert.equal(rs[0].pass, false);
  assert.match(rs[0].detail, /unknown/);
});

test("validator_clean_changed runs real CLI against mini-vault copy", () => {
  const sb = createSandbox(MINI_VAULT, "judge");
  const before = snapshot(sb);
  const alpha = join(sb, "00 Inbox", "Alpha.md");
  writeFileSync(alpha, readFileSync(alpha, "utf8") + "\n추가 줄\n");
  const diff = diffSnapshots(before, snapshot(sb));
  const rs = evaluateExpect({ validator_clean_changed: true }, baseCtx({ sandboxDir: sb, diff }));
  assert.equal(rs.length, 1);
  assert.ok(rs[0].pass, rs[0].detail); // mini-vault Alpha 수정은 error 이슈가 없어야 한다
});

test("validator_clean_changed skips titles that don't resolve as notes", () => {
  const sb = createSandbox(MINI_VAULT, "judge");
  const alpha = join(sb, "00 Inbox", "Alpha.md");
  writeFileSync(alpha, readFileSync(alpha, "utf8") + "\n추가 줄\n");
  // Meta/ 노트는 디스크에 쓰지 않아 validator가 "note not found"로 실패 → 에러가 아니라 skip.
  const diff = { added: ["Meta/설명 문서.md"], removed: [], modified: ["00 Inbox/Alpha.md"] };
  const rs = evaluateExpect({ validator_clean_changed: true }, baseCtx({ sandboxDir: sb, diff }));
  assert.equal(rs.length, 1);
  assert.ok(rs[0].pass, rs[0].detail);
  assert.match(rs[0].detail, /1 skipped: not indexed/);
});

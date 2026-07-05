// bench/tests/transcript.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTranscript, emptyParsed, mergeParsed } from "../lib/transcript.mjs";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample-transcript.jsonl");

test("parseTranscript extracts session, cost, calls", () => {
  const p = parseTranscript(readFileSync(FIXTURE, "utf8"));
  assert.equal(p.sessionId, "sess-fixture-1");
  assert.equal(p.costUsd, 0.042);
  assert.equal(p.numTurns, 3);
  assert.equal(p.isError, false);
  assert.equal(p.bashCalls.length, 3);
  assert.equal(p.bashCalls.find((c) => c.id === "t2").isError, true);
  // ipa 호출 감지: 단독 실행 + 체이닝(cd .. && ipa) 모두, ls는 제외
  assert.deepEqual(p.ipaCalls.map((c) => c.id), ["t1", "t3"]);
  assert.equal(p.finalText, "정리했습니다.");
});

function bashTranscript(command) {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command } }] } }) + "\n";
}

function toolTranscript(name, input) {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "u1", name, input }] } }) + "\n";
}

test("ipaCall detection: cd-chained ipa", () => {
  const p = parseTranscript(bashTranscript('cd "/x" && ipa inbox add "t"'));
  assert.equal(p.ipaCalls.length, 1);
  assert.match(p.ipaCalls[0].command, /inbox add/);
});

test("ipaCall detection: heredoc body then chained ipa", () => {
  const p = parseTranscript(bashTranscript("mkdir -p .tmp && cat > .tmp/x << 'EOF'\n> [!abstract]\n내용\nEOF\nipa inbox add \"t\""));
  assert.equal(p.ipaCalls.length, 1);
  assert.match(p.ipaCalls[0].command, /inbox add/);
});

test("ipaCall detection: plain non-ipa command", () => {
  const p = parseTranscript(bashTranscript("ls -la"));
  assert.equal(p.ipaCalls.length, 0);
});

test("truncated: result subtype error_max_turns marks the run truncated", () => {
  const raw = JSON.stringify({ type: "result", subtype: "error_max_turns", session_id: "s", total_cost_usd: 0.02, num_turns: 12, is_error: true, result: "" }) + "\n";
  const p = parseTranscript(raw);
  assert.equal(p.truncated, true);
});

test("truncated: normal success result is not truncated", () => {
  const p = parseTranscript(readFileSync(FIXTURE, "utf8"));
  assert.equal(p.truncated, false);
});

test("truncated: propagates through mergeParsed", () => {
  const a = { ...emptyParsed(), truncated: false };
  const b = { ...emptyParsed(), truncated: true };
  assert.equal(mergeParsed(a, b).truncated, true);
});

test("parseTranscript survives garbage lines", () => {
  const p = parseTranscript('not-json\n{"type":"result","total_cost_usd":0.01,"num_turns":1,"is_error":false,"result":"ok","session_id":"s"}\n');
  assert.equal(p.costUsd, 0.01);
});

test("mergeParsed accumulates across turns", () => {
  const a = { ...emptyParsed(), costUsd: 0.01, numTurns: 2, ipaCalls: [{ id: "x", command: "ipa search a", isError: false }], bashCalls: [], finalText: "첫" , sessionId: "s1"};
  const b = { ...emptyParsed(), costUsd: 0.02, numTurns: 1, finalText: "둘", sessionId: "s1" };
  const m = mergeParsed(a, b);
  assert.equal(m.costUsd, 0.03);
  assert.equal(m.numTurns, 3);
  assert.equal(m.ipaCalls.length, 1);
  assert.equal(m.finalText, "둘");
});

test("non-Bash tool_use captured with paths; Edit on vault note counts as touch", () => {
  const p = parseTranscript(toolTranscript("Edit", { file_path: "00 Inbox/X.md" }));
  assert.equal(p.toolCalls.length, 1);
  assert.deepEqual(p.toolCalls[0], { name: "Edit", path: "00 Inbox/X.md" });
  assert.ok(p.nonIpaVaultTouches >= 1);
});

test("nonIpaVaultTouches excludes .ipa/ config edits", () => {
  const p = parseTranscript(toolTranscript("Edit", { file_path: ".ipa/config.yaml" }));
  assert.equal(p.toolCalls.length, 1);
  assert.equal(p.nonIpaVaultTouches, 0);
});

test("Read of a vault note is captured but not a touch; Grep path field used", () => {
  const raw = toolTranscript("Read", { file_path: "00 Inbox/X.md" })
    + toolTranscript("Grep", { pattern: "todo", path: "01 Project/Y.md" });
  const p = parseTranscript(raw);
  assert.equal(p.toolCalls.length, 2);
  assert.equal(p.toolCalls.find((t) => t.name === "Grep").path, "01 Project/Y.md");
  // Read는 비파괴 조회라 touch 아님, Grep의 .md 경로는 touch로 잡힌다.
  assert.equal(p.nonIpaVaultTouches, 1);
});

test("mergeParsed carries toolCalls and sums nonIpaVaultTouches", () => {
  const a = { ...emptyParsed(), toolCalls: [{ name: "Edit", path: "a.md" }], nonIpaVaultTouches: 1 };
  const b = { ...emptyParsed(), toolCalls: [{ name: "Write", path: "b.md" }], nonIpaVaultTouches: 1 };
  const m = mergeParsed(a, b);
  assert.equal(m.toolCalls.length, 2);
  assert.equal(m.nonIpaVaultTouches, 2);
});

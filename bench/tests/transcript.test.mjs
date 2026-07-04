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

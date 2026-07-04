// bench/tests/runner.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { runClaudeTurn } from "../lib/runner.mjs";
import { pickReply } from "../lib/responder.mjs";
import { parseTranscript } from "../lib/transcript.mjs";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");
const CMD = [process.execPath, FAKE];

test("runClaudeTurn returns raw jsonl with a result event", async () => {
  const out = await runClaudeTurn({ cwd: tmpdir(), model: "sonnet", message: "안녕", claudeCmd: CMD });
  const parsed = parseTranscript(out);
  assert.equal(parsed.sessionId, "sess-fake-1");
  assert.equal(parsed.ipaCalls.length, 1);
});

test("runClaudeTurn passes --resume for follow-up turns", async () => {
  const out = await runClaudeTurn({ cwd: tmpdir(), model: "sonnet", message: "이어서", resumeSessionId: "sess-fake-1", claudeCmd: CMD });
  assert.match(parseTranscript(out).finalText, /마무리/);
});

test("pickReply answers questions per policy and stays silent otherwise", () => {
  assert.equal(pickReply("이렇게 진행할까요?", "approve"), "응, 그렇게 진행해줘.");
  assert.equal(pickReply("완료했습니다.", "approve"), null);
  assert.equal(pickReply("어떤 걸 선택할까요?", "detail:커피 폴더만 해줘"), "커피 폴더만 해줘");
  assert.equal(pickReply("진행할까요?", null), null);
});

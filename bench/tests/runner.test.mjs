// bench/tests/runner.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { existsSync, readFileSync, mkdtempSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { runClaudeTurn, installHarness } from "../lib/runner.mjs";
import { pickReply } from "../lib/responder.mjs";
import { parseTranscript } from "../lib/transcript.mjs";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");
const CMD = [process.execPath, FAKE];
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IPA_BIN = join(REPO, "packages", "cli", "dist", "main.js");
const MINI_VAULT = join(REPO, "packages", "test-vaults", "fixtures", "mini-vault");

test("runClaudeTurn returns raw jsonl with a result event", async () => {
  const out = await runClaudeTurn({ cwd: tmpdir(), model: "sonnet", message: "안녕", claudeCmd: CMD });
  const parsed = parseTranscript(out);
  assert.equal(parsed.sessionId, "sess-fake-1");
  assert.equal(parsed.ipaCalls.length, 1);
});

test("runClaudeTurn overrides child HOME when homeDir is passed, and leaves it untouched otherwise", async () => {
  const probe = join(mkdtempSync(join(tmpdir(), "bench-probe-")), "home");
  process.env.IPA_BENCH_ENV_PROBE = probe;
  try {
    // homeDir 지정 → 자식 HOME이 격리 디렉터리로 덮어써진다 (install 단계가 의존하는 격리 메커니즘)
    const iso = mkdtempSync(join(tmpdir(), "bench-home-"));
    await runClaudeTurn({ cwd: tmpdir(), model: "sonnet", message: "안녕", claudeCmd: CMD, homeDir: iso });
    assert.equal(readFileSync(probe, "utf8"), iso);
    assert.match(iso, new RegExp(tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // homeDir 미지정 → 실제 HOME 그대로 (세션 경로: macOS 인증 유지)
    await runClaudeTurn({ cwd: tmpdir(), model: "sonnet", message: "안녕", claudeCmd: CMD });
    assert.equal(readFileSync(probe, "utf8"), process.env.HOME);
  } finally {
    delete process.env.IPA_BENCH_ENV_PROBE;
  }
});

test("runClaudeTurn passes --resume for follow-up turns", async () => {
  const out = await runClaudeTurn({ cwd: tmpdir(), model: "sonnet", message: "이어서", resumeSessionId: "sess-fake-1", claudeCmd: CMD });
  assert.match(parseTranscript(out).finalText, /마무리/);
});

test("installHarness writes the global harness into the isolated home, not the real HOME", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "bench-inst-sb-"));
  cpSync(MINI_VAULT, sandbox, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), "bench-inst-home-"));
  installHarness({ ipaBin: IPA_BIN, sandboxDir: sandbox, homeDir: home });
  // 전역 하네스(스킬)는 격리 홈 아래에 떨어진다 — 실제 ~/.claude를 건드리지 않는다.
  assert.ok(existsSync(join(home, ".claude", "skills", "ipa", "SKILL.md")), "global skill under isolated home");
  // 볼트-로컬 스킬은 cwd(sandbox) 아래에 떨어진다.
  assert.ok(existsSync(join(sandbox, ".claude", "skills", "ipa-config", "SKILL.md")), "vault-local skill under sandbox");
});

test("pickReply answers questions per policy and stays silent otherwise", () => {
  assert.equal(pickReply("이렇게 진행할까요?", "approve"), "응, 그렇게 진행해줘.");
  assert.equal(pickReply("완료했습니다.", "approve"), null);
  assert.equal(pickReply("어떤 걸 선택할까요?", "detail:커피 폴더만 해줘"), "커피 폴더만 해줘");
  assert.equal(pickReply("진행할까요?", null), null);
});

// bench/tests/hooks-e2e.test.mjs
// PostToolUse 훅은 stream-json transcript에 안 남으므로(라이브 세션에선 부작용 파일만 증거) 훅 레이어를
// 결정적으로 검증한다: `ipa harness install`이 실제로 떨어뜨린 훅 스크립트를 합성 PostToolUse 입력으로
// 직접 구동해 부작용 파일(call-counter.json / mutation-pending.json)을 만들고, 새 judge 어서션이 그
// 파일을 읽는지까지 확인한다. 라이브 세션 없이 훅 발화→기록→판정 경로 전체를 고정하는 회귀 가드.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { existsSync, readFileSync, mkdtempSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { installHarness } from "../lib/runner.mjs";
import { evaluateExpect } from "../lib/judge.mjs";
import { emptyParsed } from "../lib/transcript.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IPA_BIN = join(REPO, "packages", "cli", "dist", "main.js");
const MINI_VAULT = join(REPO, "packages", "test-vaults", "fixtures", "mini-vault");

// mini-vault 샌드박스 + 격리 홈에 하네스를 설치해 실제 훅 스크립트 경로를 얻는다.
function installedHooks() {
  const sandbox = mkdtempSync(join(tmpdir(), "hooks-e2e-sb-"));
  cpSync(MINI_VAULT, sandbox, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), "hooks-e2e-home-"));
  const configDir = installHarness({ ipaBin: IPA_BIN, sandboxDir: sandbox, homeDir: home });
  return { sandbox, hooksDir: join(configDir, "hooks") };
}

// 훅 스크립트를 합성 PostToolUse 페이로드(stdin)로 구동한다. 볼트는 IPA_VAULT_PATH로 고정.
function fireHook(script, sandbox, command, sessionId) {
  return execFileSync(process.execPath, [script], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, session_id: sessionId }),
    env: { ...process.env, IPA_VAULT_PATH: sandbox },
    encoding: "utf8",
  });
}

test("mutation-ledger hook records a dry-run move and mutation_pending reads it; --apply clears it", () => {
  const { sandbox, hooksDir } = installedHooks();
  const script = join(hooksDir, "ipa-mutation-ledger.mjs");
  const pending = join(sandbox, ".ipa", "harness", "mutation-pending.json");
  const ctx = { sandboxDir: sandbox, diff: { added: [], removed: [], modified: [] }, parsed: emptyParsed(), ipaBin: IPA_BIN };

  // dry-run(--apply 없음) move → pending 엔트리가 생겨야 한다 (mutation-ledger PostToolUse 훅 발화).
  fireHook(script, sandbox, 'ipa move "🔖 공부-git명령어" "01 Project"', "s1");
  assert.ok(existsSync(pending), "mutation-pending.json written on dry-run move");
  const entries = JSON.parse(readFileSync(pending, "utf8")).mutations;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].command, "move");
  // 새 judge 어서션이 이 부작용 파일을 실제로 읽어 판정한다.
  const rs = evaluateExpect({ mutation_pending: { command: "move" } }, ctx);
  assert.equal(rs.length, 1);
  assert.ok(rs[0].pass, rs[0].detail);

  // 같은 명령을 --apply로 밟으면 매칭 pending이 지워지고(엔트리 0) 파일이 삭제된다.
  fireHook(script, sandbox, 'ipa move "🔖 공부-git명령어" "01 Project" --apply', "s1");
  assert.ok(!existsSync(pending), "mutation-pending.json removed after --apply clears the only entry");
  assert.equal(evaluateExpect({ mutation_pending: true }, ctx)[0].pass, false, "no pending after apply");
});

test("call-counter hook counts each ipa call once and hook_call_count reads the un-doubled total", () => {
  const { sandbox, hooksDir } = installedHooks();
  const script = join(hooksDir, "ipa-call-counter.mjs");
  const counter = join(sandbox, ".ipa", "harness", "call-counter.json");

  const N = 12;
  for (let i = 0; i < N; i++) fireHook(script, sandbox, `ipa search "q${i}"`, "s1");
  assert.ok(existsSync(counter), "call-counter.json written");
  const total = Object.values(JSON.parse(readFileSync(counter, "utf8")).sessions).reduce((s, e) => s + e.count, 0);
  assert.equal(total, N, "single-fire: hook count equals number of ipa calls (not 2N)");

  // transcript ipaCalls도 N개면 ratio 1.0 → min/max_ratio 게이트 통과.
  const parsed = { ...emptyParsed(), ipaCalls: Array.from({ length: N }, (_, i) => ({ id: String(i), command: "ipa search x", isError: false })) };
  const ctx = { sandboxDir: sandbox, diff: { added: [], removed: [], modified: [] }, parsed, ipaBin: IPA_BIN };
  assert.ok(evaluateExpect({ hook_call_count: { min: 10, max_ratio: 1.5 } }, ctx)[0].pass, "un-doubled count passes the ratio gate");
});

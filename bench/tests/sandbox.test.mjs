// bench/tests/sandbox.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSandbox, snapshot, diffSnapshots } from "../lib/sandbox.mjs";

function makePersona() {
  const dir = mkdtempSync(join(tmpdir(), "bench-persona-"));
  mkdirSync(join(dir, "00 Inbox"), { recursive: true });
  writeFileSync(join(dir, "00 Inbox", "Alpha.md"), "# Alpha\n");
  writeFileSync(join(dir, "note.md"), "root note\n");
  return dir;
}

test("createSandbox copies persona and writes .ipa-config", () => {
  const persona = makePersona();
  const sb = createSandbox(persona, "test");
  assert.ok(existsSync(join(sb, "00 Inbox", "Alpha.md")));
  assert.match(readFileSync(join(sb, ".ipa-config"), "utf8"), new RegExp(`vault_path: ${sb}`));
});

test("createSandbox with preconfigured:false skips .ipa-config", () => {
  const sb = createSandbox(makePersona(), "test", { preconfigured: false });
  assert.ok(!existsSync(join(sb, ".ipa-config")));
});

test("snapshot + diffSnapshots detect add/modify/remove", () => {
  const persona = makePersona();
  const sb = createSandbox(persona, "test");
  const before = snapshot(sb);
  writeFileSync(join(sb, "00 Inbox", "Beta.md"), "new\n");            // added
  writeFileSync(join(sb, "note.md"), "changed\n");                     // modified
  rmSync(join(sb, "00 Inbox", "Alpha.md"));                            // removed
  const d = diffSnapshots(before, snapshot(sb));
  assert.deepEqual(d.added, ["00 Inbox/Beta.md"]);
  assert.deepEqual(d.removed, ["00 Inbox/Alpha.md"]);
  assert.deepEqual(d.modified, ["note.md"]);
});

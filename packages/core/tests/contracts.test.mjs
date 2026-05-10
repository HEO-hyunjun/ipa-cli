import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  contractExportFixtures,
  contractList,
  contractValidateOutput
} from "../dist/index.js";

const root = dirname(fileURLToPath(import.meta.url)) + "/../../..";

async function fixtureVault() {
  const work = await mkdtemp(join(tmpdir(), "ipa-contract-test-"));
  const vault = join(work, "vault");
  await cp(join(root, "packages", "test-vaults", "fixtures", "mini-vault"), vault, { recursive: true });
  return vault;
}

test("contract list and exported output schemas validate", async () => {
  const vault = await fixtureVault();
  const listed = await contractList();
  assert.ok(listed.contracts.includes("context"));
  const exported = await contractExportFixtures(vault, ".ipa/fixtures/contracts");
  assert.ok(exported.exported.includes(".ipa/fixtures/contracts/context.json"));
  const valid = await contractValidateOutput("context", join(vault, ".ipa", "fixtures", "contracts", "context.json"));
  assert.equal(valid.valid, true);
});

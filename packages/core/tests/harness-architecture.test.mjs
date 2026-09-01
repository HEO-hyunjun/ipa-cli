import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessProviders } from "../dist/harness/registry.js";
import { resolveHarnessComponents } from "../dist/harness/model.js";

const root = dirname(fileURLToPath(import.meta.url)) + "/../../..";

test("harness provider registry exposes complete, independent adapters", () => {
  const providers = harnessProviders();
  assert.deepEqual(providers.map((provider) => provider.id), ["codex", "claude", "opencode"]);
  assert.equal(new Set(providers.map((provider) => provider.id)).size, providers.length);

  const codex = providers.find((provider) => provider.id === "codex");
  const claude = providers.find((provider) => provider.id === "claude");
  const opencode = providers.find((provider) => provider.id === "opencode");
  assert.equal(codex.targetSpec("/tmp/home").hooksConfig, "/tmp/home/.codex/hooks.json");
  assert.equal(claude.targetSpec("/tmp/home").hooksConfig, "/tmp/home/.claude/settings.json");
  assert.equal(opencode.targetSpec("/tmp/home").pluginFile, "/tmp/home/.config/opencode/plugins/ipa-harness.js");
  assert.equal(codex.hookRegistration("hook:vault-ref").event, "UserPromptSubmit");
  assert.equal(claude.hookRegistration("hook:formatter-gate").event, "Stop");
  assert.equal(opencode.hookRegistration("hook:guard"), null);

  assert.equal(codex.userPromptOutput("message"), '{ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: message } }');
  assert.equal(codex.stopBlockOutput("message"), '{ decision: "block", reason: message }');
  assert.equal(codex.stopNoticeOutput("message"), '{ systemMessage: message }');
  assert.match(claude.stopBlockOutput("message"), /hookSpecificOutput/);
});

test("harness component selection delegates provider dependencies to the adapter", () => {
  const providers = Object.fromEntries(harnessProviders().map((provider) => [provider.id, provider]));
  const opencode = resolveHarnessComponents(providers.opencode, { components: { only: ["hook:guard"] } });
  assert.deepEqual(opencode.selected, ["hook:guard", "opencode-plugin"]);
  assert.throws(
    () => resolveHarnessComponents(providers.codex, { components: { only: ["permissions"] } }),
    /unknown harness component: permissions/
  );
  assert.ok(resolveHarnessComponents(providers.claude).selected.includes("permissions"));
});

test("common harness layers contain no provider-name conditionals", async () => {
  const files = [
    "packages/core/src/harness/index.ts",
    "packages/core/src/harness/model.ts",
    "packages/core/src/harness/artifacts.ts",
    "packages/core/src/harness/lifecycle.ts",
    "packages/core/src/harness/managedFiles.ts",
    "packages/core/src/harness/manifest.ts",
    "packages/core/src/harness/gate.ts",
    "packages/core/src/harness/guard.ts",
    "packages/core/src/harness/shared/hookConfig.ts",
    "packages/core/src/harness/shared/hookTemplates.ts",
    "packages/core/src/harness/shared/templates.ts"
  ];
  const forbidden = /\b(?:agent|name|spec\.name|target)\s*(?:===|!==)\s*["'](?:codex|claude|opencode)["']/;
  for (const file of files) {
    const source = await readFile(join(root, file), "utf8");
    assert.doesNotMatch(source, forbidden, `${file} must delegate provider differences to adapters`);
  }
});

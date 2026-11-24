import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// ipaClient.ts is TypeScript importing @ipa/core: bundle it with core swapped
// for globalThis.__ipaCoreStub, which each test sets before importing.
async function loadIpaClient() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/core/ipaClient.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    plugins: [{
      name: "core-stub",
      setup(b) {
        b.onResolve({ filter: /^@ipa\/core$/ }, () => ({ path: "core", namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = globalThis.__ipaCoreStub;" }));
      }
    }]
  });
  const file = join(await mkdtemp(join(tmpdir(), "ipa-client-")), "ipaClient.mjs");
  await writeFile(file, result.outputFiles[0].text);
  return (await import(pathToFileURL(file).href)).IpaClient;
}

test("a note load overtaken by a vault edit is not cached", async () => {
  let release;
  const loads = [new Promise((resolve) => (release = resolve)), Promise.resolve([{ relPath: "after.md" }])];
  globalThis.__ipaCoreStub = {
    readVaultConfig: async () => ({ mapping: {} }),
    loadNotesForView: () => loads.shift()
  };
  const IpaClient = await loadIpaClient();
  const client = new IpaClient(() => "/vault");

  const inFlight = client.loadNotesCached();
  client.invalidateNotes(); // the edit lands while the first load is still reading
  release([{ relPath: "before.md" }]);

  assert.deepEqual(await inFlight, [{ relPath: "before.md" }]);
  assert.deepEqual(await client.loadNotesCached(), [{ relPath: "after.md" }]);
  assert.deepEqual(await client.loadNotesCached(), [{ relPath: "after.md" }], "the fresh load is cached");
});

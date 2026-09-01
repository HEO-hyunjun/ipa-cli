import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import { opencodeAdapter } from "./adapters/opencode.js";
import { normalizeHarnessTarget } from "./model.js";
import { assertHarnessProviderAdapter } from "./ports.js";

const registered = [codexAdapter, claudeAdapter, opencodeAdapter].map(assertHarnessProviderAdapter);

const adapters = new Map([
  ...registered.map((adapter) => [adapter.id, adapter])
]);

export function harnessProvider(target = "codex") {
  const name = normalizeHarnessTarget(target);
  const adapter = adapters.get(name);
  if (!adapter) throw new Error(`unsupported harness target: ${name}. Expected ${[...adapters.keys()].join(", ")}`);
  return adapter;
}

export function harnessProviders() {
  return [...adapters.values()];
}

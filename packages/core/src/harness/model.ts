export const HARNESS_COMPONENTS = [
  "skill",
  "prompt",
  "local-prompt",
  "local-skills",
  "plugin-scaffold",
  "opencode-plugin",
  "permissions",
  "hook:session-env",
  "hook:guard",
  "hook:markdown-nudge",
  "hook:call-counter",
  "hook:mutation-ledger",
  "hook:formatter-gate",
  "hook:vault-ref",
  "hook:evidence"
];

export const HARNESS_HOOK_COMPONENT_TO_SCRIPT = {
  "hook:session-env": "ipa-session-env.mjs",
  "hook:guard": "ipa-inbox-guard.mjs",
  "hook:markdown-nudge": "ipa-md-write-nudge.mjs",
  "hook:call-counter": "ipa-call-counter.mjs",
  "hook:mutation-ledger": "ipa-mutation-ledger.mjs",
  "hook:formatter-gate": "ipa-formatter-gate.mjs",
  "hook:vault-ref": "ipa-vault-ref-nudge.mjs",
  "hook:evidence": "ipa-prompt-evidence.mjs"
};

export function normalizeHarnessTarget(target = "codex") {
  const value = String(target || "codex").trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(value)) throw new Error(`invalid harness target: ${target}`);
  return value;
}

export function componentSelected(selected, component) {
  return selected.includes(component);
}

export function normalizeComponentList(input) {
  if (!input) return [];
  return input
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function resolveHarnessComponents(adapter, options = {}) {
  const valid = adapter.validComponents;
  const validSet = new Set(valid);
  const only = normalizeComponentList(options.components?.only);
  const withList = normalizeComponentList(options.components?.with);
  const without = normalizeComponentList(options.components?.without);
  for (const component of [...only, ...withList, ...without]) {
    if (!validSet.has(component)) throw new Error(`unknown harness component: ${component}`);
  }
  let selected = only.length > 0 ? [...new Set(only)] : [...adapter.defaultComponents];
  for (const component of withList) {
    if (!selected.includes(component)) selected.push(component);
  }
  selected = selected.filter((component) => !without.includes(component));
  selected = adapter.completeSelection(selected);
  const selectedSet = new Set(selected);
  return {
    selected,
    omitted: valid.filter((component) => !selectedSet.has(component))
  };
}

export const HOOK_REGISTRATIONS = {
  "hook:session-env": { event: "SessionStart", matcher: null, statusMessage: "Setting IPA search logging environment...", timeout: 5 },
  "hook:guard": { event: "PreToolUse", matcher: "Write|Edit|MultiEdit", statusMessage: "Checking IPA inbox write policy...", timeout: 5 },
  "hook:markdown-nudge": { event: "PostToolUse", matcher: "Write|Edit|MultiEdit", statusMessage: null, timeout: 5 },
  "hook:call-counter": { event: "PostToolUse", matcher: "Bash", statusMessage: null, timeout: 5 },
  "hook:formatter-gate": { event: "Stop", matcher: null, statusMessage: "Checking IPA formatter apply gate...", timeout: 20 },
  "hook:vault-ref": { event: "UserPromptSubmit", matcher: null, statusMessage: null, timeout: 5 },
  "hook:evidence": { event: "UserPromptSubmit", matcher: null, statusMessage: null, timeout: 5 }
};

export function hookRegistration(component) {
  return HOOK_REGISTRATIONS[component] ?? null;
}

export function hookSpecificOutput(event, messageExpression) {
  return `{ hookSpecificOutput: { hookEventName: ${JSON.stringify(event)}, additionalContext: ${messageExpression} } }`;
}

export const IPA_MANAGED_HOOK_SCRIPTS = [
  "ipa-session-env.mjs",
  "ipa-inbox-guard.mjs",
  "ipa-user-prompt-nudge.mjs",
  "ipa-md-write-nudge.mjs",
  "ipa-call-counter.mjs",
  "ipa-mutation-ledger.mjs",
  "ipa-formatter-gate.mjs",
  "ipa-vault-ref-nudge.mjs",
  "ipa-prompt-evidence.mjs"
];

function hookHasCommand(config, event, command) {
  return (config.hooks?.[event] ?? []).some((group) =>
    (group.hooks ?? []).some((hook) => hook.command === command)
  );
}

export function addHookCommand(config, event, matcher, command, statusMessage, timeout = null) {
  config.hooks = config.hooks || {};
  config.hooks[event] = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
  if (hookHasCommand(config, event, command)) return;
  const hook = { type: "command", command };
  if (timeout !== null) hook.timeout = timeout;
  if (statusMessage) hook.statusMessage = statusMessage;
  const group = { hooks: [hook] };
  if (matcher) group.matcher = matcher;
  config.hooks[event].push(group);
}

function isManagedHookCommand(command) {
  return typeof command === "string" && IPA_MANAGED_HOOK_SCRIPTS.some((name) => command.includes(name));
}

export function removeManagedHookCommands(config) {
  if (!config.hooks) return;
  for (const event of Object.keys(config.hooks)) {
    config.hooks[event] = (config.hooks[event] ?? [])
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isManagedHookCommand(hook.command)) }))
      .filter((group) => group.hooks.length);
    if (!config.hooks[event].length) delete config.hooks[event];
  }
}

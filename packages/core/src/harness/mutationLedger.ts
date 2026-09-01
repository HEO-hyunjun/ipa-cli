import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MUTATION_TTL_MS = 48 * 60 * 60 * 1000;

function activeSessionId(options = {}) {
  return options.session ?? process.env.IPA_SESSION_ID ?? process.env.CODEX_SESSION_ID ?? process.env.CLAUDE_SESSION_ID ?? null;
}

// The CLI owns mutation intent because it already knows whether a command was
// a preview or an apply. This avoids reparsing shell text in a PostToolUse hook
// and works identically for every provider that launches the ipa executable.
export async function recordHarnessMutation(vaultPath, command, applied, options = {}) {
  const sessionId = activeSessionId(options);
  if (!sessionId) return { recorded: false, reason: "no_session" };

  const statePath = join(vaultPath, ".ipa", "harness", "mutation-pending.json");
  let entries = [];
  if (existsSync(statePath)) {
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      if (Array.isArray(parsed.mutations)) entries = parsed.mutations;
    } catch {
      entries = [];
    }
  }

  const cutoff = Date.now() - MUTATION_TTL_MS;
  entries = entries.filter((item) => {
    const stamp = Date.parse(item?.ts ?? "");
    return Number.isNaN(stamp) || stamp >= cutoff;
  });
  entries = entries.filter((item) => !(item.command === command && item.session_id === sessionId));
  if (!applied) entries.push({ command, session_id: sessionId, ts: new Date().toISOString() });

  try {
    if (entries.length) {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, JSON.stringify({ version: 1, mutations: entries }, null, 2) + "\n", "utf8");
    } else if (existsSync(statePath)) {
      await rm(statePath);
    }
  } catch {
    return { recorded: false, reason: "write_failed" };
  }
  return { recorded: true, pending: !applied, command, session_id: sessionId };
}

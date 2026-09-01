import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { componentSelected } from "../model.js";
import { HARNESS_MARKER } from "../managedFiles.js";

function harnessHomeBase(options = {}) {
  return resolve(options.homeDir ?? process.env.IPA_HARNESS_HOME ?? homedir());
}

function sessionEnvScript(options = {}) {
  const env = { IPA_SEARCH_LOG: "1", ...(options.env ?? {}) };
  return `#!/usr/bin/env node
// ${HARNESS_MARKER}: IPA session environment defaults.
import { appendFileSync, readFileSync } from "node:fs";

const envFiles = [...new Set([process.env.CLAUDE_ENV_FILE, process.env.CODEX_ENV_FILE].filter(Boolean))];
const env = ${JSON.stringify(env)};

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
const sessionId = [input.session_id, input.sessionId, input.conversation_id, input.conversationId]
  .find((value) => typeof value === "string" && value.trim());
if (sessionId) env.IPA_SESSION_ID = sessionId;

function shellEscape(value) {
  return \`'\${String(value).replace(/'/g, \`'"'"'\`)}'\`;
}

for (const envFile of envFiles) {
  for (const [name, value] of Object.entries(env)) {
    appendFileSync(envFile, \`export \${name}=\${shellEscape(value)}\\n\`, "utf8");
  }
}
`;
}


function vaultResolverSnippet(vaultPath, options = {}) {
  const home = harnessHomeBase(options);
  const rel = relative(home, vaultPath);
  const fallbackExpr = rel && !rel.startsWith("..") && !isAbsolute(rel)
    ? `join(homedir(), ${JSON.stringify(rel.split(sep).join("/"))})`
    : JSON.stringify(vaultPath);
  return `(() => {
  if (process.env.IPA_VAULT_PATH) {
    const v = process.env.IPA_VAULT_PATH;
    return v === "~" ? homedir() : v.startsWith("~/") ? join(homedir(), v.slice(2)) : v;
  }
  try {
    const result = spawnSync("ipa", ["config", "show", "--json"], { encoding: "utf8" });
    if (result.status === 0) {
      const resolved = JSON.parse(result.stdout).vault_path;
      if (resolved) return resolved.startsWith("~/") ? join(homedir(), resolved.slice(2)) : resolved;
    }
  } catch {}
  return ${fallbackExpr};
})()`;
}

function inboxGuardScript(vaultPath, inboxDir, options = {}) {
  return `#!/usr/bin/env node
// ${HARNESS_MARKER}: shared IPA inbox creation guard.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const vaultPath = ${vaultResolverSnippet(vaultPath, options)};
const fallbackInbox = ${JSON.stringify(inboxDir)};

function readInput() {
  try {
    return JSON.parse(awaitStdin());
  } catch {
    return {};
  }
}

function awaitStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function toVaultRelative(filePath, cwd) {
  const absolute = resolve(cwd || process.cwd(), filePath);
  const rel = relative(vaultPath, absolute);
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/")) return null;
  return { absolute, rel: rel.split(sep).join("/") };
}

function fallbackVerdict(rel, action) {
  const inbox = fallbackInbox.replace(/^\\/+/, "");
  if (action !== "create") return true;
  if (rel.split("/").some((segment) => segment.startsWith("."))) return true;
  return rel === inbox || rel.startsWith(inbox + "/");
}

const input = readInput();
const toolInput = input.tool_input ?? input.toolInput ?? input.input ?? {};
const filePath = firstString([toolInput.file_path, toolInput.path, input.file_path, input.path]);
if (!filePath) process.exit(0);

const target = toVaultRelative(filePath, input.cwd);
if (!target || !target.rel.toLowerCase().endsWith(".md")) process.exit(0);

const action = existsSync(target.absolute) ? "edit" : "create";
let allowed = fallbackVerdict(target.rel, action);
let reason = allowed ? "allowed by fallback policy" : "new markdown files must be created under the configured inbox folder";

const result = spawnSync("ipa", ["--vault", vaultPath, "harness", "guard", "check", target.rel, "--action", action, "--json"], {
  encoding: "utf8",
  timeout: 4000
});
if (result.status === 0 && result.stdout) {
  try {
    const parsed = JSON.parse(result.stdout);
    allowed = parsed.allowed !== false;
    reason = parsed.reason || reason;
  } catch {
    // Keep fallback verdict.
  }
}

if (!allowed) {
  const message = \`IPA guard blocked \${target.rel}: \${reason}. Use ipa inbox add or create the file under \${fallbackInbox}.\`;
  process.stderr.write(message + "\\n");
  process.stdout.write(JSON.stringify({ decision: "block", reason: message }) + "\\n");
  process.exit(2);
}
`;
}

// UserPromptSubmit nudge for sessions running OUTSIDE the vault: when the
// prompt references a vault note by path (mapped folder name + "/", or the
// vault's absolute path), inject a pointer to the ipa skill/CLI so the agent
// resolves the note through `ipa view` instead of raw file reads. Inside the
// vault the local prompt surfaces already cover this, so the hook stays silent.
function vaultRefNudgeScript(vaultPath, mapping, options = {}) {
  const folders = JSON.stringify([mapping.inbox_dir, mapping.project_dir, mapping.archive_dir].filter(Boolean));
  return `#!/usr/bin/env node
// ${HARNESS_MARKER}: IPA vault path-reference nudge.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const vaultPath = ${vaultResolverSnippet(vaultPath, options)};
const folders = ${folders};
let input = {};
try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
const prompt = [input.prompt, input.user_prompt, input.message, input.text]
  .find((value) => typeof value === "string" && value.trim()) ?? "";
if (!prompt) process.exit(0);

const cwdRaw = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : process.cwd();
const cwd = resolve(cwdRaw);
const vaultRoot = resolve(vaultPath);
if (cwd === vaultRoot || cwd.startsWith(vaultRoot + sep)) process.exit(0);

const mentionsVault = folders.some((name) => prompt.includes(name + "/")) || prompt.includes(vaultPath);
if (!mentionsVault) process.exit(0);

const message = [
  "[IPA] This prompt references a note path in the IPA vault (" + vaultPath + ").",
  "Resolve it through the ipa CLI (global ipa skill) instead of reading the file directly:",
  '- Note title = filename without the folder and ".md": ipa view "Note Title" (--full for the whole note).',
  '- Surrounding context: ipa search "keyword", ipa digest "Index Note".',
  "- Any vault edit goes through ipa commands and ends with the note-scoped validator/formatter loop."
].join("\\n");

process.stdout.write(JSON.stringify(${options.provider.userPromptOutput("message")}) + "\\n");
`;
}

// Pure tune-evidence recorder: appends every user prompt as a prompt event and
// refreshes the per-cwd current-prompt sidecar so in-CLI search events can be
// correlated back to the prompt that caused them (prompt_event_id /
// source_prompt). The per-turn context injection this hook once carried was
// removed after the 2026-07 A/B benchmark showed no behavioral benefit.
function promptEvidenceScript(vaultPath, options = {}) {
  return `#!/usr/bin/env node
// ${HARNESS_MARKER}: IPA prompt evidence recorder.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const vaultPath = ${vaultResolverSnippet(vaultPath, options)};
const agent = ${JSON.stringify(options.agent ?? "unknown")};

function inputJson() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function normalizeCwd(cwd) {
  const value = firstString([cwd]);
  if (!value) return null;
  return resolve(value);
}

function promptContextPathForCwd(cwd) {
  const normalized = normalizeCwd(cwd);
  if (!normalized) return null;
  const key = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(vaultPath, ".ipa", "tune", "logs", \`current-prompt-\${key}.json\`);
}

function recordPromptEvent(input) {
  const prompt = firstString([
    input.prompt,
    input.user_prompt,
    input.userPrompt,
    input.message,
    input.text,
    input.tool_input?.prompt,
    input.input?.prompt
  ]);
  if (!prompt) return;
  const path = join(vaultPath, ".ipa", "tune", "logs", "search-events.jsonl");
  const ts = new Date().toISOString();
  const eventId = firstString([input.event_id, input.eventId, input.prompt_event_id, input.promptEventId]) || \`prompt_\${randomUUID()}\`;
  const sessionId = firstString([
    input.session_id,
    input.sessionId,
    input.conversation_id,
    input.conversationId,
    input.transcript_path,
    input.transcriptPath,
    process.env.IPA_SESSION_ID,
    process.env.CODEX_SESSION_ID,
    process.env.CLAUDE_SESSION_ID,
    process.env.TERM_SESSION_ID
  ]) || \`\${agent}:unknown\`;
  const turnId = firstString([input.turn_id, input.turnId, input.turnID]) || eventId;
  const cwd = normalizeCwd(firstString([
    input.cwd,
    input.project_dir,
    input.projectDir,
    input.workspace_root,
    input.workspaceRoot
  ]));
  const event = {
    schema_version: 1,
    event_id: eventId,
    event_type: "prompt",
    ts,
    source: "harness",
    agent,
    session_id: sessionId,
    turn_id: turnId,
    query: prompt,
    prompt,
    source_prompt: prompt,
    generated_query: null,
    cwd,
    prompt_length: prompt.length
  };
  const currentPath = join(vaultPath, ".ipa", "tune", "logs", "current-prompt.json");
  const workspaceCurrentPath = promptContextPathForCwd(cwd);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + "\\n", "utf8");
  writeFileSync(currentPath, JSON.stringify({ ...event, ttl_seconds: 1800 }, null, 2) + "\\n", "utf8");
  if (workspaceCurrentPath) {
    writeFileSync(workspaceCurrentPath, JSON.stringify({ ...event, ttl_seconds: 1800 }, null, 2) + "\\n", "utf8");
  }
}

const input = inputJson();
recordPromptEvent(input);
`;
}

function markdownWriteNudgeScript(vaultPath, mapping, options = {}) {
  return `#!/usr/bin/env node
// ${HARNESS_MARKER}: silently track IPA vault Markdown edits for the Stop gate.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const vaultPath = ${vaultResolverSnippet(vaultPath, options)};
const noteRoots = ${JSON.stringify([mapping.inbox_dir, mapping.project_dir, mapping.archive_dir].filter(Boolean))};
const pendingPath = join(vaultPath, ".ipa", "harness", "formatter-pending.json");

function inputJson() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function inNoteRoot(rel) {
  return noteRoots.some((root) => rel === root || rel.startsWith(root.replace(/\\/+$/, "") + "/"));
}

function sessionIdFrom(input) {
  return firstString([
    input.session_id,
    input.sessionId,
    input.conversation_id,
    input.conversationId,
    input.transcript_path,
    input.transcriptPath,
    process.env.IPA_SESSION_ID,
    process.env.CODEX_SESSION_ID,
    process.env.CLAUDE_SESSION_ID,
    process.env.TERM_SESSION_ID
  ]);
}

// Entries from sessions that ended without clearing the gate are pruned by age.
const PENDING_TTL_MS = 48 * 60 * 60 * 1000;

function freshNotes(notes) {
  const cutoff = Date.now() - PENDING_TTL_MS;
  return notes.filter((item) => {
    const ts = Date.parse(item?.updated_at ?? "");
    return Number.isNaN(ts) || ts >= cutoff;
  });
}

function readPending() {
  if (!existsSync(pendingPath)) return { version: 1, notes: [] };
  try {
    const parsed = JSON.parse(readFileSync(pendingPath, "utf8"));
    return { version: 1, notes: freshNotes(Array.isArray(parsed.notes) ? parsed.notes : []) };
  } catch {
    return { version: 1, notes: [] };
  }
}

function writePending(pending) {
  mkdirSync(dirname(pendingPath), { recursive: true });
  writeFileSync(pendingPath, JSON.stringify(pending, null, 2) + "\\n", "utf8");
}

const input = inputJson();
const toolInput = input.tool_input ?? input.toolInput ?? input.input ?? {};
const filePath = firstString([toolInput.file_path, toolInput.path, input.file_path, input.path]);
if (!filePath) process.exit(0);

const absolute = resolve(input.cwd || process.cwd(), filePath);
const rel = relative(vaultPath, absolute);
if (rel === "" || rel.startsWith("..") || rel.startsWith("/") || !rel.toLowerCase().endsWith(".md")) process.exit(0);

const note = rel.split(sep).join("/");
if (!inNoteRoot(note)) process.exit(0);
const noteTitle = note.split("/").pop().replace(/\\.md$/i, "");
const sessionId = sessionIdFrom(input);
const pending = readPending();
pending.notes = pending.notes.filter((item) => item.path !== note && item.title !== noteTitle);
pending.notes.push({ title: noteTitle, path: note, session_id: sessionId ?? null, updated_at: new Date().toISOString() });
pending.updated_at = new Date().toISOString();
writePending(pending);
`;
}

// Read the call-counter thresholds from vault config so install and the
// outdated-check re-render the exact same baked constants (a mismatch would make
// the outdated diff false-positive every time).
export function harnessTemplateOptions(config) {
  return {
    callCounter: {
      warnAt: config?.harness?.call_counter?.warn_at ?? 10,
      repeatEvery: config?.harness?.call_counter?.repeat_every ?? 6
    },
    recallMode: config?.harness?.recall === "contextual" ? "contextual" : "explicit"
  };
}

function callCounterScript(vaultPath, options = {}) {
  // Thresholds are baked at generation time (not parsed from YAML at runtime) so
  // the generated script stays self-contained; a config change surfaces as
  // harness.component_outdated and is remediated by `ipa harness update`, like
  // every other baked value. Coerce to a positive integer so an invalid config
  // value can never emit a non-numeric literal into the generated script.
  const warnAtRaw = Number(options.callCounter?.warnAt);
  const repeatEveryRaw = Number(options.callCounter?.repeatEvery);
  const warnAt = Number.isFinite(warnAtRaw) && warnAtRaw > 0 ? Math.floor(warnAtRaw) : 10;
  const repeatEvery = Number.isFinite(repeatEveryRaw) && repeatEveryRaw > 0 ? Math.floor(repeatEveryRaw) : 6;
  return `#!/usr/bin/env node
// ${HARNESS_MARKER}: nudge convergence when a session runs many ipa calls.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const vaultPath = ${vaultResolverSnippet(vaultPath, options)};
const statePath = join(vaultPath, ".ipa", "harness", "call-counter.json");
const WARN_AT = ${warnAt};
const REPEAT_EVERY = ${repeatEvery};
const TTL_MS = 48 * 60 * 60 * 1000;

function inputJson() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

const input = inputJson();
const toolInput = input.tool_input ?? input.toolInput ?? input.input ?? {};
const command = firstString([toolInput.command, input.command]);
function ipaCommandCount(value) {
  let total = 0;
  for (const segment of String(value ?? "").split(/&&|\\|\\||;/)) {
    total += [...segment.matchAll(/(?:^|\\n)\\s*ipa\\s+[a-z-]/g)].length;
  }
  return total;
}
const commandCount = ipaCommandCount(command);
if (!commandCount) process.exit(0);

const sessionId = firstString([
  input.session_id,
  input.sessionId,
  input.conversation_id,
  input.conversationId,
  input.transcript_path,
  input.transcriptPath,
  process.env.IPA_SESSION_ID,
  process.env.CODEX_SESSION_ID,
  process.env.CLAUDE_SESSION_ID,
  process.env.TERM_SESSION_ID
]) ?? "unknown";

let state = { version: 1, sessions: {} };
if (existsSync(statePath)) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (parsed && typeof parsed.sessions === "object" && parsed.sessions) {
      state = { version: 1, sessions: parsed.sessions };
    }
  } catch {
    // corrupt state — start over
  }
}
const cutoff = Date.now() - TTL_MS;
for (const key of Object.keys(state.sessions)) {
  const stamp = Date.parse(state.sessions[key]?.updated_at ?? "");
  if (Number.isNaN(stamp) || stamp < cutoff) delete state.sessions[key];
}
const entry = state.sessions[sessionId] ?? { count: 0 };
const previousCount = entry.count;
entry.count += commandCount;
entry.updated_at = new Date().toISOString();
state.sessions[sessionId] = entry;
try {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n", "utf8");
} catch {
  // counting is best-effort
}

const count = entry.count;
const nextNudgeAt = previousCount < WARN_AT
  ? WARN_AT
  : WARN_AT + (Math.floor((previousCount - WARN_AT) / REPEAT_EVERY) + 1) * REPEAT_EVERY;
if (count < nextNudgeAt) process.exit(0);

const message = [
  \`[IPA CLI] This session has run \${count} ipa calls.\`,
  "Exploration should be converging now: you likely have enough evidence, so compose the answer from the notes you have already read — do not open more or add a late \`ipa digest\` pass over notes you already read.",
  "If coverage is genuinely incomplete, name the single missing note or keyword, check only that, and state what was not checked instead of continuing to explore."
].join("\\n");

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: message
  }
}) + "\\n");
`;
}

// Stop hook: thin client of \`ipa harness gate\`. All gate policy (builtin
// formatter check + vault-owned gate plugins) lives in core so vaults can
// extend the Stop gate without forking this script.
function formatterGateScript(vaultPath, options = {}) {
  return `#!/usr/bin/env node
// ${HARNESS_MARKER}: block final response until the IPA session gate passes.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const vaultPath = ${vaultResolverSnippet(vaultPath, options)};
const agent = ${JSON.stringify(options.agent ?? "unknown")};

function inputJson() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function sessionIdFrom(input) {
  return firstString([
    input.session_id,
    input.sessionId,
    input.conversation_id,
    input.conversationId,
    input.transcript_path,
    input.transcriptPath,
    process.env.IPA_SESSION_ID,
    process.env.CODEX_SESSION_ID,
    process.env.CLAUDE_SESSION_ID,
    process.env.TERM_SESSION_ID
  ]);
}

function block(message) {
  process.stderr.write(message + "\\n");
  const output = ${options.provider.stopBlockOutput("message")};
  process.stdout.write(JSON.stringify(output) + "\\n");
  process.exit(2);
}

const input = inputJson();
const sessionId = sessionIdFrom(input);

// Fast path: nothing pending and no gate plugins installed — skip the CLI spawn.
const pendingPath = join(vaultPath, ".ipa", "harness", "formatter-pending.json");
const gatesDir = join(vaultPath, ".ipa", "plugins", "gates");
if (!existsSync(pendingPath) && !existsSync(gatesDir)) process.exit(0);

const args = ["--vault", vaultPath, "--json", "harness", "gate"];
if (sessionId) args.push("--session", sessionId);
const result = spawnSync("ipa", args, { encoding: "utf8", timeout: 30000 });

// The CLI exits 1 when the gate blocks, so judge by the JSON payload, not the
// exit code; only an unparseable stdout means the gate itself could not run.
let parsed = null;
try {
  parsed = JSON.parse(result.stdout);
} catch {
  parsed = null;
}
if (!parsed) {
  block([
    "[IPA CLI] Session gate could not verify pending vault work.",
    (result.stderr || result.stdout || "ipa harness gate failed").trim(),
    "Run: ipa harness gate"
  ].join("\\n"));
}

if (parsed && parsed.block) {
  const messages = (parsed.blocks ?? []).map((item) => item.message).filter(Boolean);
  block(["[IPA CLI] Session gate blocked final response.", ...messages].join("\\n\\n"));
}

// A gate plugin that threw is reported by \`ipa harness gate\` in parsed.errors,
// and a gate returning {block:false, message} is reported in parsed.warnings.
// Neither blocks (fail safe). Surface both as a single non-blocking
// additionalContext so a broken or advisory gate does not fail 100% silently.
const notices = [];
if (parsed && Array.isArray(parsed.errors) && parsed.errors.length) {
  notices.push("[IPA CLI] Session gate plugin error(s) (not blocking):");
  for (const item of parsed.errors) notices.push(\`- \${item.source || "gate"}: \${item.message || "gate plugin error"}\`);
}
if (parsed && Array.isArray(parsed.warnings) && parsed.warnings.length) {
  notices.push("[IPA CLI] Session gate warning(s) (not blocking):");
  for (const item of parsed.warnings) notices.push(\`- \${item.source || "gate"}: \${item.message || "gate warning"}\`);
}
if (notices.length) {
  const message = notices.join("\\n");
  const output = ${options.provider.stopNoticeOutput("message")};
  process.stdout.write(JSON.stringify(output) + "\\n");
}
`;
}

export function opencodePluginScript(vaultPath, mapping, selected, options = {}) {
  const has = (component) => componentSelected(selected, component);
  const sessionEnv = has("hook:session-env");
  const guard = has("hook:guard");
  const markdownNudge = has("hook:markdown-nudge");
  const formatterGate = has("hook:formatter-gate");
  const evidence = has("hook:evidence");
  const vaultResolver = vaultResolverSnippet(vaultPath, options);
  const inboxDir = JSON.stringify(mapping.inbox_dir);
  const noteRoots = JSON.stringify([mapping.inbox_dir, mapping.project_dir, mapping.archive_dir].filter(Boolean));
  return `// ${HARNESS_MARKER}: OpenCode IPA harness plugin.
// Generated by ipa harness install opencode. Node-compatible ESM only.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const vaultPath = ${vaultResolver};
const inboxDir = ${inboxDir};
const noteRoots = ${noteRoots};
const pendingPath = join(vaultPath, ".ipa", "harness", "formatter-pending.json");
const eventsPath = join(vaultPath, ".ipa", "tune", "logs", "search-events.jsonl");
const PENDING_TTL_MS = 48 * 60 * 60 * 1000;

function firstString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function normalizeCwd(cwd) {
  const value = firstString([cwd]);
  if (!value) return null;
  return resolve(value);
}

function promptContextPathForCwd(cwd) {
  const normalized = normalizeCwd(cwd);
  if (!normalized) return null;
  const key = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(vaultPath, ".ipa", "tune", "logs", \`current-prompt-\${key}.json\`);
}

function sessionIdFrom(input) {
  return firstString([
    input?.session_id,
    input?.sessionId,
    input?.conversation_id,
    input?.conversationId,
    input?.transcript_path,
    input?.transcriptPath,
    process.env.IPA_SESSION_ID,
    process.env.CODEX_SESSION_ID,
    process.env.CLAUDE_SESSION_ID,
    process.env.TERM_SESSION_ID
  ]);
}

function freshNotes(notes) {
  const cutoff = Date.now() - PENDING_TTL_MS;
  return notes.filter((item) => {
    const ts = Date.parse(item?.updated_at ?? "");
    return Number.isNaN(ts) || ts >= cutoff;
  });
}

function readPending() {
  if (!existsSync(pendingPath)) return { version: 1, notes: [] };
  try {
    const parsed = JSON.parse(readFileSync(pendingPath, "utf8"));
    return { version: 1, notes: freshNotes(Array.isArray(parsed.notes) ? parsed.notes : []) };
  } catch {
    return { version: 1, notes: [] };
  }
}

function writePending(pending) {
  mkdirSync(dirname(pendingPath), { recursive: true });
  writeFileSync(pendingPath, JSON.stringify(pending, null, 2) + "\\n", "utf8");
}

function toVaultRelative(filePath, cwd) {
  const absolute = resolve(cwd || process.cwd(), filePath);
  const rel = relative(vaultPath, absolute);
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/")) return null;
  return { absolute, rel: rel.split(sep).join("/") };
}

function inNoteRoot(rel) {
  return noteRoots.some((root) => rel === root || rel.startsWith(root.replace(/\\/+$/, "") + "/"));
}

function recordPromptEvent(input) {
  const prompt = firstString([
    input?.prompt,
    input?.user_prompt,
    input?.userPrompt,
    input?.message,
    input?.text,
    input?.tool_input?.prompt,
    input?.input?.prompt
  ]);
  if (!prompt) return;
  const ts = new Date().toISOString();
  const eventId = firstString([input?.event_id, input?.eventId, input?.prompt_event_id, input?.promptEventId]) || \`prompt_\${randomUUID()}\`;
  const sessionId = sessionIdFrom(input) || "opencode:unknown";
  const turnId = firstString([input?.turn_id, input?.turnId, input?.turnID]) || eventId;
  const cwd = normalizeCwd(firstString([input?.cwd, input?.project_dir, input?.projectDir, input?.workspace_root, input?.workspaceRoot]));
  const event = {
    schema_version: 1,
    event_id: eventId,
    event_type: "prompt",
    ts,
    source: "harness",
    agent: "opencode",
    session_id: sessionId,
    turn_id: turnId,
    query: prompt,
    prompt,
    source_prompt: prompt,
    generated_query: null,
    cwd,
    prompt_length: prompt.length
  };
  const currentPath = join(vaultPath, ".ipa", "tune", "logs", "current-prompt.json");
  const workspaceCurrentPath = promptContextPathForCwd(cwd);
  mkdirSync(dirname(eventsPath), { recursive: true });
  appendFileSync(eventsPath, JSON.stringify(event) + "\\n", "utf8");
  writeFileSync(currentPath, JSON.stringify({ ...event, ttl_seconds: 1800 }, null, 2) + "\\n", "utf8");
  if (workspaceCurrentPath) {
    writeFileSync(workspaceCurrentPath, JSON.stringify({ ...event, ttl_seconds: 1800 }, null, 2) + "\\n", "utf8");
  }
}

function extractFilePath(output) {
  const args = output?.args ?? output?.input ?? output?.tool_input ?? output?.toolInput ?? {};
  return firstString([args.filePath, args.file_path, args.path, output?.filePath, output?.file_path, output?.path]);
}

// Session gate on OpenCode: spawn the CLI as the single source of truth so
// vault-owned gate plugins (and the builtin formatter check) run here exactly as
// they do on the claude/codex Stop hook. Blocking results throw (the OpenCode
// way to hold the response); gate-plugin errors are logged, never blocking. Any
// spawn/parse failure fails safe (does not block).
function runSessionGate(block) {
  const sessionId = sessionIdFrom({});
  const args = ["--vault", vaultPath, "--json", "harness", "gate"];
  if (sessionId) args.push("--session", sessionId);
  const result = spawnSync("ipa", args, { encoding: "utf8", timeout: 30000 });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  if (!parsed) return;
  if (parsed.block) {
    const messages = (parsed.blocks ?? []).map((item) => item.message).filter(Boolean);
    block(["[IPA CLI] Session gate blocked final response.", ...messages].join("\\n\\n"));
    return;
  }
  if (Array.isArray(parsed.errors) && parsed.errors.length) {
    for (const item of parsed.errors) {
      console.warn(\`[IPA CLI] session gate plugin error (not blocking): \${item.source || "gate"}: \${item.message || "gate plugin error"}\`);
    }
  }
  if (Array.isArray(parsed.warnings) && parsed.warnings.length) {
    for (const item of parsed.warnings) {
      console.warn(\`[IPA CLI] session gate warning (not blocking): \${item.source || "gate"}: \${item.message || "gate warning"}\`);
    }
  }
}

export const IPAHarnessPlugin = async () => {
  const hooks = {};
  ${sessionEnv ? `
  hooks["shell.env"] = () => {
    return { env: { IPA_SEARCH_LOG: "1" } };
  };` : ""}
  ${guard ? `
  hooks["tool.execute.before"] = async (ctx) => {
    const output = ctx?.output ?? ctx?.tool ?? ctx;
    const filePath = extractFilePath(output);
    if (!filePath) return { decision: "allow" };
    const cwd = ctx?.cwd ?? ctx?.project_dir ?? process.cwd();
    const target = toVaultRelative(filePath, cwd);
    if (!target || !target.rel.toLowerCase().endsWith(".md")) return { decision: "allow" };
    const action = existsSync(target.absolute) ? "edit" : "create";
    if (action !== "create") return { decision: "allow" };
    const result = spawnSync("ipa", ["--vault", vaultPath, "harness", "guard", "check", target.rel, "--action", action, "--json"], { encoding: "utf8", timeout: 4000 });
    if (result.status === 0 && result.stdout) {
      try {
        const parsed = JSON.parse(result.stdout);
        if (parsed.allowed === false) {
          const message = \`IPA guard blocked \${target.rel}: \${parsed.reason || "blocked"}. Use ipa inbox add or create the file under \${inboxDir}.\`;
          return { decision: "block", reason: message };
        }
      } catch {}
    }
    return { decision: "allow" };
  };` : ""}
  ${markdownNudge ? `
  hooks["tool.execute.after"] = async (ctx) => {
    const output = ctx?.output ?? ctx?.tool ?? ctx;
    const filePath = extractFilePath(output);
    if (!filePath) return {};
    const cwd = ctx?.cwd ?? ctx?.project_dir ?? process.cwd();
    const target = toVaultRelative(filePath, cwd);
    if (!target || !target.rel.toLowerCase().endsWith(".md")) return {};
    if (!inNoteRoot(target.rel)) return {};
    const noteTitle = target.rel.split("/").pop().replace(/\\.md$/i, "");
    const sessionId = sessionIdFrom(ctx ?? {});
    const pending = readPending();
    pending.notes = pending.notes.filter((item) => item.path !== target.rel && item.title !== noteTitle);
    pending.notes.push({ title: noteTitle, path: target.rel, session_id: sessionId ?? null, updated_at: new Date().toISOString() });
    pending.updated_at = new Date().toISOString();
    writePending(pending);
    return {};
  };` : ""}
  ${formatterGate ? `
  hooks["event"] = async (ctx) => {
    const type = ctx?.type ?? ctx?.event ?? ctx?.name;
    if (type === "session.idle") {
      runSessionGate((message) => {
        throw new Error(message);
      });
    }
    return {};
  };` : ""}
  ${evidence ? `
  const evidenceHandler = async (ctx) => {
    const type = ctx?.type ?? ctx?.event ?? ctx?.name;
    if (type === "tui.prompt.append" || type === "message.updated") {
      const payload = ctx?.payload ?? ctx?.data ?? ctx;
      recordPromptEvent(payload);
    }
    return {};
  };
  const previousEvent = hooks["event"];
  hooks["event"] = previousEvent
    ? async (ctx) => {
        await previousEvent(ctx);
        return evidenceHandler(ctx);
      }
    : evidenceHandler;` : ""}
  return { name: "ipa-harness", hooks };
};

export default IPAHarnessPlugin;
`;
}

// Vault-owned prompt fragments (.ipa/harness/fragments/<name>.md) let a vault
// inject its own operating rules into managed prompt surfaces without forking
// them. Fragment names: "skill" (global skill), "prompt" (global prompt
// block), "local-prompt" (vault prompt block), or a vault-local skill name
// (e.g. "ipa-rule"). The fragment is inlined as a "## Vault Operating Rules"
// section when artifacts are rendered, so install writes it and doctor/status
// compare installed files against template+fragment — vault customization via
// fragments is never flagged as outdated. Editing a fragment then shows up as
// component_outdated until `ipa harness update <target>` re-applies it.

export function harnessHookScriptContent(component, vaultPath, spec, mapping, options = {}) {
  switch (component) {
    case "hook:session-env": return sessionEnvScript();
    case "hook:guard": return inboxGuardScript(vaultPath, mapping.inbox_dir, options);
    case "hook:vault-ref": return vaultRefNudgeScript(vaultPath, mapping, { ...options, provider: spec.adapter });
    case "hook:evidence": return promptEvidenceScript(vaultPath, { ...options, agent: spec.name });
    case "hook:markdown-nudge": return markdownWriteNudgeScript(vaultPath, mapping, options);
    case "hook:call-counter": return callCounterScript(vaultPath, options);
    case "hook:formatter-gate": return formatterGateScript(vaultPath, { ...options, agent: spec.name, provider: spec.adapter });
    default: return null;
  }
}

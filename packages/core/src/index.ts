import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

export const DEFAULT_MAPPING = {
  note_type: "type",
  refs: "ref",
  tags: "tags",
  created_at: "date_created",
  updated_at: "date_modified",
  aliases: "aliases",
  inbox_dir: "00 Inbox",
  project_dir: "01 Project",
  archive_dir: "02 Archive"
};

export const CHANNELS = [
  { name: "filename", defaultWeight: 0.26, description: "Filename and alias exact/partial match" },
  { name: "fuzzy", defaultWeight: 0.18, description: "Ordered character fuzzy match" },
  { name: "sequence", defaultWeight: 0.12, description: "Token sequence match" },
  { name: "keyword", defaultWeight: 0.16, description: "Frontmatter and body keyword match" },
  { name: "body", defaultWeight: 0.18, description: "Body term coverage" },
  { name: "related", defaultWeight: 0.07, description: "Shared refs/tags with direct query hits" },
  { name: "project", defaultWeight: 0.03, description: "Project folder/ref boost" },
  { name: "child-body", defaultWeight: 0.04, description: "Index/root child body match" }
];

export const RULES = [
  { code: "ipa.frontmatter.required", severity: "error" },
  { code: "ipa.frontmatter.type", severity: "error" },
  { code: "ipa.frontmatter.ref_required", severity: "warn" },
  { code: "ipa.tag.snake_case", severity: "warn" },
  { code: "K001", severity: "warn" },
  { code: "K002", severity: "warn" }
];

export const REFACTORS = [
  "ref-replace",
  "tag-rename",
  "tag-remove",
  "tag-add",
  "wikilink-replace",
  "ref-add",
  "ref-remove"
];

export function nowIso() {
  return new Date().toISOString();
}

export function toPosix(path) {
  return path.split(sep).join("/");
}

export function stableJson(value) {
  return JSON.stringify(value, Object.keys(value).sort(), 2);
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function splitCsv(value) {
  const out = [];
  let current = "";
  let quote = null;
  for (const ch of value) {
    if ((ch === "'" || ch === "\"") && quote === null) {
      quote = ch;
      current += ch;
      continue;
    }
    if (quote === ch) {
      quote = null;
      current += ch;
      continue;
    }
    if (ch === "," && quote === null) {
      out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function parseScalar(raw) {
  let value = String(raw ?? "").trim();
  if (value === "") return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner ? splitCsv(inner).map(parseScalar) : [];
  }
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith("\"") && value.endsWith("\""))
  ) {
    return value.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function countIndent(line) {
  return line.match(/^ */)[0].length;
}

function parseYamlBlock(lines, start, indent) {
  let i = start;
  while (i < lines.length && !lines[i].trim()) i += 1;
  const isArray = i < lines.length && countIndent(lines[i]) === indent && lines[i].trim().startsWith("- ");
  const container = isArray ? [] : {};

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i += 1;
      continue;
    }
    const currentIndent = countIndent(line);
    if (currentIndent < indent) break;
    if (currentIndent > indent) break;
    const trim = line.trim();
    if (isArray) {
      if (!trim.startsWith("- ")) break;
      container.push(parseScalar(trim.slice(2)));
      i += 1;
      continue;
    }
    const idx = trim.indexOf(":");
    if (idx === -1) {
      i += 1;
      continue;
    }
    const key = trim.slice(0, idx).trim();
    const rest = trim.slice(idx + 1).trim();
    if (rest) {
      container[key] = parseScalar(rest);
      i += 1;
    } else {
      const parsed = parseYamlBlock(lines, i + 1, indent + 2);
      container[key] = parsed.value;
      i = parsed.next;
    }
  }
  return { value: container, next: i };
}

export function parseYaml(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  return parseYamlBlock(lines, 0, 0).value ?? {};
}

function yamlScalar(value) {
  if (Array.isArray(value)) return `[${value.map(yamlScalar).join(", ")}]`;
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value);
  if (!text || /[:#\[\]{}'",\n]/.test(text) || text.startsWith(" ") || text.endsWith(" ")) {
    return JSON.stringify(text);
  }
  return text;
}

export function dumpYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    return value.map((item) => `${pad}- ${yamlScalar(item)}`).join("\n");
  }
  return Object.entries(value)
    .map(([key, item]) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return `${pad}${key}:\n${dumpYaml(item, indent + 2)}`;
      }
      if (Array.isArray(item) && item.length > 2) {
        return `${pad}${key}:\n${dumpYaml(item, indent + 2)}`;
      }
      return `${pad}${key}: ${yamlScalar(item)}`;
    })
    .join("\n");
}

export function readFrontmatter(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: normalized };
  const yaml = normalized.slice(4, end);
  const bodyStart = normalized.indexOf("\n", end + 4);
  return {
    frontmatter: parseYaml(yaml),
    body: bodyStart === -1 ? "" : normalized.slice(bodyStart + 1)
  };
}

export function writeFrontmatter(frontmatter, body) {
  return `---\n${dumpYaml(frontmatter)}\n---\n${body.replace(/^\n+/, "")}`;
}

function asList(value) {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

export function stripWiki(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]$/);
  return (match ? match[1] : text).trim();
}

export function extractWikilinks(text) {
  const out = [];
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = re.exec(String(text ?? "")))) out.push(match[1].trim());
  return out;
}

export function normalizeMapping(config = {}) {
  const mapping = { ...DEFAULT_MAPPING };
  const raw = config.mapping;
  if (!raw) return mapping;
  if (raw.fields) {
    for (const [key, value] of Object.entries(raw.fields)) {
      if (key in mapping) mapping[key] = value;
    }
  }
  if (raw.folders) {
    if (raw.folders.inbox) mapping.inbox_dir = raw.folders.inbox;
    if (raw.folders.project) mapping.project_dir = raw.folders.project;
    if (raw.folders.archive) mapping.archive_dir = raw.folders.archive;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "fields" && key !== "folders" && key in mapping) mapping[key] = value;
  }
  for (const required of ["note_type", "refs", "tags", "created_at", "updated_at"]) {
    if (!mapping[required]) throw new Error(`mapping missing required field: ${required}`);
  }
  return mapping;
}

export async function readVaultConfig(vaultPath) {
  const path = join(vaultPath, ".ipa", "config.yaml");
  if (!existsSync(path)) return { config: {}, mapping: { ...DEFAULT_MAPPING }, path };
  const config = parseYaml(await readFile(path, "utf8"));
  return { config, mapping: normalizeMapping(config), path };
}

async function walkFiles(root, predicate, base = root) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".cache" || entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    const rel = toPosix(relative(base, path));
    if (entry.isDirectory()) {
      if (rel === ".ipa" || rel.startsWith(".ipa/")) continue;
      out.push(...await walkFiles(path, predicate, base));
    } else if (predicate(path, rel)) {
      out.push(path);
    }
  }
  return out;
}

function parseHeadings(body) {
  return body
    .split("\n")
    .map((line, index) => {
      const match = line.match(/^(#{1,6})\s+(.+)$/);
      return match ? { level: match[1].length, title: match[2].trim(), line: index + 1 } : null;
    })
    .filter(Boolean);
}

export async function loadNotes(vaultPath, mapping = DEFAULT_MAPPING) {
  const files = await walkFiles(vaultPath, (path) => extname(path).toLowerCase() === ".md");
  const notes = [];
  for (const path of files.sort()) {
    const raw = await readFile(path, "utf8");
    const relPath = toPosix(relative(vaultPath, path));
    const { frontmatter, body } = readFrontmatter(raw);
    const id = basename(path, ".md");
    const refs = asList(frontmatter[mapping.refs]).map(stripWiki).filter(Boolean);
    const tags = asList(frontmatter[mapping.tags]).map((tag) => String(tag).replace(/^#/, ""));
    const aliases = mapping.aliases ? asList(frontmatter[mapping.aliases]) : [];
    notes.push({
      id,
      path,
      relPath,
      folder: toPosix(dirname(relPath)),
      raw,
      frontmatter,
      body,
      type: frontmatter[mapping.note_type] || "",
      refs,
      tags,
      aliases,
      links: extractWikilinks(body),
      headings: parseHeadings(body)
    });
  }
  return notes;
}

export function indexNotes(notes) {
  return new Map(notes.map((note) => [note.id, note]));
}

export function buildGraph(notes) {
  const ids = new Set(notes.map((note) => note.id));
  const edges = {};
  const backlinks = {};
  for (const note of notes) {
    const targets = [...new Set([...note.refs, ...note.links].filter((target) => ids.has(target)))];
    edges[note.id] = targets;
    for (const target of targets) {
      if (!backlinks[target]) backlinks[target] = [];
      backlinks[target].push(note.id);
    }
  }
  return { edges, backlinks };
}

function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function subsequenceScore(needle, haystack) {
  const q = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (!q) return 0;
  if (h.includes(q)) return q.length / Math.max(h.length, q.length);
  let j = 0;
  for (let i = 0; i < h.length && j < q.length; i += 1) {
    if (h[i] === q[j]) j += 1;
  }
  return j / q.length * 0.7;
}

export function scoreNote(note, query, notes, weights = {}) {
  const raw = String(query ?? "").trim();
  const lower = raw.toLowerCase();
  const tokens = tokenize(raw);
  const names = [note.id, ...note.aliases];
  const reasons = {};
  const channelScores = {};

  const bestName = Math.max(0, ...names.map((name) => {
    const n = name.toLowerCase();
    if (n === lower) return 1;
    if (n.includes(lower)) return 0.78;
    return 0;
  }));
  channelScores.filename = bestName;
  if (bestName) reasons.filename = { matched: names.find((name) => name.toLowerCase().includes(lower)) ?? note.id };

  const fuzzy = Math.max(0, ...names.map((name) => subsequenceScore(lower, name)));
  channelScores.fuzzy = fuzzy;
  if (fuzzy) reasons.fuzzy = { score: fuzzy };

  const bodyTokens = tokenize(`${note.id} ${note.aliases.join(" ")} ${note.body}`);
  const coverage = tokens.length ? tokens.filter((token) => bodyTokens.includes(token)).length / tokens.length : 0;
  channelScores.sequence = coverage;
  if (coverage) reasons.sequence = { coverage };

  const keywordText = `${note.refs.join(" ")} ${note.tags.join(" ")} ${note.aliases.join(" ")} ${note.body}`.toLowerCase();
  const keyword = tokens.length ? tokens.filter((token) => keywordText.includes(token)).length / tokens.length : 0;
  channelScores.keyword = keyword;
  if (keyword) reasons.keyword = { coverage: keyword };

  const bodyLower = note.body.toLowerCase();
  const body = tokens.length ? tokens.filter((token) => bodyLower.includes(token)).length / tokens.length : 0;
  channelScores.body = body;
  if (body) reasons.body = { coverage: body };

  const directHits = notes.filter((candidate) => candidate.id.toLowerCase().includes(lower));
  const shared = directHits.some((candidate) =>
    candidate.id !== note.id &&
    (candidate.refs.some((ref) => note.refs.includes(ref)) || candidate.tags.some((tag) => note.tags.includes(tag)))
  );
  channelScores.related = shared ? 0.5 : 0;
  if (shared) reasons.related = { shared: true };

  channelScores.project = note.folder.includes(DEFAULT_MAPPING.project_dir) ? 0.35 : 0;
  channelScores["child-body"] = note.type === "index" || note.type === "root" ? body * 0.5 : 0;

  let score = 0;
  for (const channel of CHANNELS) {
    const weight = weights[channel.name] ?? channel.defaultWeight;
    score += (channelScores[channel.name] ?? 0) * weight;
  }
  return { score, reasons, channelScores };
}

async function activeSearchParams(vaultPath) {
  const { config } = await readVaultConfig(vaultPath);
  const file = config.weights?.file;
  if (!file) return {};
  const path = tuneResultPath(vaultPath, file);
  if (!existsSync(path)) return {};
  const payload = JSON.parse(await readFile(path, "utf8"));
  const params = payload.best?.params ?? payload.params ?? payload;
  return {
    threshold: params.threshold,
    cap: params.cap ?? params.max_results,
    weights: params.weights
  };
}

function tuneResultPath(vaultPath, filename) {
  if (String(filename).startsWith("/") || String(filename).startsWith(".ipa/")) {
    return resolve(vaultPath, filename);
  }
  return join(vaultPath, ".ipa", "tune", "results", filename);
}

export async function searchVault(vaultPath, query, options = {}) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const active = await activeSearchParams(vaultPath);
  const threshold = options.showAll ? 0 : options.threshold ?? active.threshold ?? 0.05;
  const cap = options.maxResults ?? options.cap ?? active.cap ?? 10;
  const weights = options.weights ?? active.weights ?? {};
  const hitsByNote = new Map();
  for (const note of notes) {
    const scored = scoreNote(note, query, notes, weights);
    hitsByNote.set(note.id, {
        note: note.id,
        path: note.relPath,
        type: note.type || "?",
        score: Number(scored.score.toFixed(6)),
        reasons: scored.reasons
    });
  }
  for (const hit of await runSearchPlugins(vaultPath, query, notes, mapping)) {
    const note = findNote(notes, hit.note);
    if (!note) continue;
    const current = hitsByNote.get(note.id) ?? {
      note: note.id,
      path: note.relPath,
      type: note.type || "?",
      score: 0,
      reasons: {}
    };
    current.score = Number((current.score + hit.score).toFixed(6));
    current.reasons[`plugin:${basename(hit.plugin)}`] = hit.reason ?? { score: hit.score };
    hitsByNote.set(note.id, current);
  }
  const hits = [...hitsByNote.values()]
    .filter((hit) => options.showAll || hit.score >= threshold)
    .sort((a, b) => b.score - a.score || a.note.localeCompare(b.note))
    .slice(0, cap);
  return { query, threshold, max_results: cap, count: hits.length, results: hits };
}

async function runSearchPlugins(vaultPath, query, notes, mapping) {
  const plugins = await loadPluginModules(vaultPath, "search");
  const hits = [];
  for (const plugin of plugins) {
    const output = await plugin.module.search(query, notes, { notes, mapping, vaultPath });
    hits.push(...normalizeSearchPluginOutput(output, plugin.path));
  }
  return hits;
}

function normalizeSearchPluginOutput(output, pluginPath) {
  if (!output) return [];
  if (!Array.isArray(output) && typeof output === "object") {
    return Object.entries(output).map(([note, score]) => ({
      note,
      score: Number(score) || 0,
      plugin: pluginPath
    }));
  }
  return (Array.isArray(output) ? output : [output])
    .map((item) => {
      const note = item.note?.id ?? item.note ?? item.id ?? item.name;
      return {
        note,
        score: Number(item.score ?? 1) || 0,
        reason: item.reason,
        plugin: pluginPath
      };
    })
    .filter((item) => item.note);
}

export async function viewNote(vaultPath, noteName, options = {}) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const note = findNote(notes, noteName);
  if (!note) throw new Error(`note not found: ${noteName}`);
  if (options.full) return note.raw;
  if (options.section) {
    return extractSection(note.body, options.section) ?? "";
  }
  const lines = [
    `=== ${note.id} [${note.type || "?"}] ===`,
    `path: ${note.relPath}`,
    `refs: ${note.refs.join(", ") || "-"}`,
    `tags: ${note.tags.join(", ") || "-"}`,
    "",
    note.body.split("\n").find((line) => line.trim()) ?? ""
  ];
  if (note.headings.length) {
    lines.push("", "headings:");
    for (const heading of note.headings) lines.push(`${"#".repeat(heading.level)} ${heading.title}`);
  }
  return lines.join("\n");
}

export function extractSection(body, title) {
  const lines = body.split("\n");
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match && match[2].trim() === title) {
      start = i;
      level = match[1].length;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{1,6})\s+/);
    if (match && match[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export function findNote(notes, noteName) {
  const query = String(noteName).toLowerCase();
  return notes.find((note) => note.id === noteName) ??
    notes.find((note) => note.id.toLowerCase() === query) ??
    notes.find((note) => note.aliases.some((alias) => alias.toLowerCase() === query)) ??
    null;
}

export async function traversal(vaultPath, mode, noteName) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const note = findNote(notes, noteName);
  if (!note) throw new Error(`note not found: ${noteName}`);
  const graph = buildGraph(notes);
  if (mode === "up") return { paths: upwardPaths(note, notes) };
  if (mode === "down") return { tree: downwardTree(note.id, graph, notes) };
  if (mode === "siblings") return { siblings: siblings(note, notes).map((item) => item.id) };
  if (mode === "root") return { roots: upwardPaths(note, notes).map((path) => path[path.length - 1]).filter(Boolean) };
  throw new Error(`unknown traversal mode: ${mode}`);
}

function upwardPaths(note, notes, seen = new Set()) {
  if (seen.has(note.id)) return [[note.id]];
  seen.add(note.id);
  if (!note.refs.length) return [[note.id]];
  const paths = [];
  for (const ref of note.refs) {
    const parent = findNote(notes, ref);
    if (!parent) paths.push([note.id, ref]);
    else for (const path of upwardPaths(parent, notes, new Set(seen))) paths.push([note.id, ...path]);
  }
  return paths;
}

function downwardTree(noteId, graph, notes, seen = new Set()) {
  if (seen.has(noteId)) return { note: noteId, children: [] };
  seen.add(noteId);
  const children = (graph.backlinks[noteId] ?? [])
    .sort()
    .map((child) => downwardTree(child, graph, notes, new Set(seen)));
  return { note: noteId, children };
}

function siblings(note, notes) {
  if (!note.refs.length) return [];
  return notes.filter((candidate) => candidate.id !== note.id && candidate.refs.some((ref) => note.refs.includes(ref)));
}

export async function validateVault(vaultPath) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const ids = new Set(notes.map((note) => note.id));
  const issues = [];
  for (const note of notes) {
    for (const field of [mapping.created_at, mapping.updated_at, mapping.tags, mapping.note_type]) {
      if (note.frontmatter[field] === undefined) {
        issues.push(issue("ipa.frontmatter.required", "error", note, `missing frontmatter field: ${field}`));
      }
    }
    if (!["note", "index", "root"].includes(String(note.type))) {
      issues.push(issue("ipa.frontmatter.type", "error", note, `invalid type: ${note.type || "(empty)"}`));
    }
    if (note.type !== "root" && note.refs.length === 0) {
      issues.push(issue("ipa.frontmatter.ref_required", "warn", note, "note/index should have at least one ref"));
    }
    for (const tag of note.tags) {
      if (!/^[a-z0-9_/-]+$/.test(tag)) {
        issues.push(issue("ipa.tag.snake_case", "warn", note, `tag should be snake_case: ${tag}`));
      }
    }
    for (const ref of note.refs) {
      if (!ids.has(ref)) issues.push(issue("K001", "warn", note, `ref target missing: ${ref}`));
    }
    for (const link of note.links) {
      if (!ids.has(link)) issues.push(issue("K002", "warn", note, `wikilink target missing: ${link}`));
    }
  }
  for (const plugin of await loadPluginModules(vaultPath, "lint")) {
    for (const note of notes) {
      const pluginIssues = await plugin.module.lint(note, { notes, mapping, vaultPath });
      for (const item of normalizePluginIssues(pluginIssues, plugin.path, note)) issues.push(item);
    }
  }
  return { notes: notes.length, issues, status: issues.some((item) => item.severity === "error") ? "error" : "ok" };
}

function issue(code, severity, note, message) {
  return { code, severity, note: note.id, path: note.relPath, message };
}

function normalizePluginIssues(pluginIssues, pluginPath, note) {
  return (Array.isArray(pluginIssues) ? pluginIssues : pluginIssues ? [pluginIssues] : [])
    .map((item) => ({
      code: item.code ?? `plugin.${basename(pluginPath)}`,
      severity: item.severity ?? "warn",
      note: item.note ?? note.id,
      path: item.path ?? note.relPath,
      message: item.message ?? "plugin issue",
      plugin: pluginPath
    }));
}

export async function formatVault(vaultPath, apply = false) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const validation = await validateVault(vaultPath);
  const patches = [];
  for (const plugin of await loadPluginModules(vaultPath, "formatter")) {
    for (const note of notes) {
      const output = await plugin.module.format(note, { notes, mapping, vaultPath, apply });
      patches.push(...normalizeFormatterPatches(output, plugin.path, note));
    }
  }
  return {
    summary: { issues: validation.issues.length, patches: patches.length },
    patches,
    applied: apply ? [] : undefined,
    issues: validation.issues
  };
}

function normalizeFormatterPatches(output, pluginPath, note) {
  return (Array.isArray(output) ? output : output ? [output] : [])
    .map((item) => ({
      ...item,
      note: item.note ?? note.id,
      path: item.path ?? note.relPath,
      plugin: pluginPath
    }));
}

export async function doctor(vaultPath, options = {}) {
  if (options.fixDirs) {
    for (const rel of [".ipa", ".ipa/cache", ".ipa/tune", ".ipa/plugins", ".ipa/plans", ".ipa/fixtures/contracts"]) {
      await mkdir(join(vaultPath, rel), { recursive: true });
    }
  }
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const issues = [];
  if (!existsSync(join(vaultPath, ".ipa", "config.yaml"))) {
    issues.push({ code: "doctor.config.missing", severity: "warn", message: ".ipa/config.yaml missing" });
  }
  const cacheRoot = join(vaultPath, ".ipa", "cache");
  if (existsSync(cacheRoot)) {
    const files = await walkAll(cacheRoot);
    for (const file of files) {
      const text = await readFile(file, "utf8").catch(() => "");
      if (text.includes(vaultPath)) {
        issues.push({
          code: "doctor.cache.absolute_path",
          severity: "error",
          path: toPosix(relative(vaultPath, file)),
          message: "cache contains absolute vault path"
        });
      }
    }
  }
  return {
    status: issues.some((item) => item.severity === "error") ? "error" : "ok",
    checks: {
      vault: toPosix(vaultPath),
      notes: notes.length,
      config: existsSync(join(vaultPath, ".ipa", "config.yaml")),
      cache: existsSync(cacheRoot)
    },
    issues
  };
}

async function walkAll(root) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...await walkAll(path));
    else out.push(path);
  }
  return out;
}

export async function buildContext(vaultPath, query, options = {}) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const search = options.byNote
    ? { results: [{ note: findNote(notes, query)?.id, score: 1 }].filter((item) => item.note) }
    : await searchVault(vaultPath, query, { maxResults: options.maxResults ?? 5, threshold: 0 });
  const selected = search.results.map((hit) => findNote(notes, hit.note)).filter(Boolean);
  const graph = buildGraph(notes);
  return {
    query,
    notes: selected.map((note) => ({
      id: note.id,
      path: note.relPath,
      type: note.type,
      refs: note.refs,
      tags: note.tags,
      body: options.full ? note.body : note.body.slice(0, 500)
    })),
    edges: graph.edges,
    sources: selected.map((note) => note.relPath),
    warnings: []
  };
}

export async function rebuildCache(vaultPath) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const cacheDir = join(vaultPath, ".ipa", "cache");
  await mkdir(cacheDir, { recursive: true });
  const files = [];
  for (const note of notes) {
    files.push({
      path: note.relPath,
      sha256: sha256(note.raw),
      size: note.raw.length
    });
  }
  const graph = buildGraph(notes);
  const manifest = {
    version: 1,
    generated_at: nowIso(),
    file_count: files.length,
    plugin_fingerprint: await pluginFingerprint(vaultPath)
  };
  await writeFile(join(cacheDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(join(cacheDir, "files.jsonl"), files.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  await writeFile(join(cacheDir, "graph.json"), JSON.stringify(graph, null, 2), "utf8");
  return { manifest, files, graph };
}

export async function cacheStatus(vaultPath) {
  const manifestPath = join(vaultPath, ".ipa", "cache", "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, "utf8")) : null;
  const currentFingerprint = await pluginFingerprint(vaultPath);
  const stale = [];
  if (!manifest) stale.push({ reason: "missing_manifest" });
  else if (manifest.plugin_fingerprint !== currentFingerprint) stale.push({ reason: "plugin_fingerprint_changed" });
  return { manifest, stale, current_plugin_fingerprint: currentFingerprint };
}

export async function cacheDoctor(vaultPath) {
  const report = await doctor(vaultPath);
  return {
    status: report.status,
    issues: report.issues.filter((item) => item.code.startsWith("doctor.cache.")),
    checks: report.checks
  };
}

export async function cacheClean(vaultPath) {
  const cache = join(vaultPath, ".ipa", "cache");
  await rm(cache, { recursive: true, force: true });
  await mkdir(cache, { recursive: true });
  return { cleaned: [".ipa/cache"] };
}

export async function cacheInspect(vaultPath, noteName) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const note = findNote(notes, noteName);
  if (!note) throw new Error(`note not found: ${noteName}`);
  return { note: note.id, path: note.relPath, sha256: sha256(note.raw), links: note.links, refs: note.refs };
}

async function pluginFingerprint(vaultPath) {
  const root = join(vaultPath, ".ipa", "plugins");
  const files = await walkAll(root);
  const hash = createHash("sha256");
  for (const file of files.filter((item) => item.endsWith(".js")).sort()) {
    hash.update(toPosix(relative(vaultPath, file)));
    hash.update(await readFile(file, "utf8"));
  }
  return hash.digest("hex");
}

export async function suggestLinks(vaultPath, noteName = null) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const selected = noteName ? [findNote(notes, noteName)].filter(Boolean) : notes;
  const suggestions = [];
  for (const note of selected) {
    for (const other of notes) {
      if (other.id === note.id || note.links.includes(other.id)) continue;
      if (note.body.includes(other.id)) {
        suggestions.push({ note: note.id, target: other.id, reason: "plain_text_title_match" });
      }
    }
  }
  return { suggestions };
}

export async function linkPlan(vaultPath, options = {}) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const suggestions = await suggestLinks(vaultPath, options.note ?? null);
  const plan = {
    version: 1,
    kind: "link",
    created_at: nowIso(),
    changes: suggestions.suggestions.map((item) => {
      const note = findNote(notes, item.note);
      return {
        note: item.note,
        path: note?.relPath,
        sha256: note ? sha256(note.raw) : null,
        target: item.target,
        replacement: `[[${item.target}]]`,
        reason: item.reason
      };
    })
  };
  if (options.output) {
    const path = resolve(vaultPath, options.output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(plan, null, 2), "utf8");
  }
  return plan;
}

export async function linkApply(vaultPath, planPath) {
  const plan = JSON.parse(await readFile(resolve(vaultPath, planPath), "utf8"));
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const changed = [];
  for (const change of plan.changes ?? []) {
    const note = findNote(notes, change.note);
    if (!note || note.links.includes(change.target)) continue;
    if (change.sha256 && sha256(note.raw) !== change.sha256) {
      throw new Error(`hash guard failed for ${note.id}`);
    }
    const next = note.raw.replace(change.target, `[[${change.target}]]`);
    if (next !== note.raw) {
      await writeFile(note.path, next, "utf8");
      changed.push(note.relPath);
    }
  }
  return { applied: changed };
}

export async function renameNote(vaultPath, oldName, newName, apply = false) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const note = findNote(notes, oldName);
  if (!note) throw new Error(`note not found: ${oldName}`);
  const target = join(dirname(note.path), `${newName}.md`);
  if (existsSync(target)) throw new Error(`target already exists: ${newName}`);
  const changes = [{ from: note.relPath, to: toPosix(relative(vaultPath, target)) }];
  for (const item of notes) {
    if (item.raw.includes(`[[${oldName}]]`) || item.raw.includes(oldName)) {
      changes.push({ path: item.relPath, replace: oldName, with: newName });
    }
  }
  if (apply) {
    await rename(note.path, target);
    for (const item of notes) {
      if (item.id === oldName) continue;
      const next = item.raw.replaceAll(`[[${oldName}]]`, `[[${newName}]]`).replaceAll(oldName, newName);
      if (next !== item.raw) await writeFile(item.path, next, "utf8");
    }
  }
  return { kind: "rename", old: oldName, new: newName, apply, changes };
}

export async function moveNote(vaultPath, noteName, targetFolder, apply = false) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const note = findNote(notes, noteName);
  if (!note) throw new Error(`note not found: ${noteName}`);
  const target = join(vaultPath, targetFolder, `${note.id}.md`);
  if (apply) {
    await mkdir(dirname(target), { recursive: true });
    await rename(note.path, target);
  }
  return { kind: "move", note: note.id, from: note.relPath, to: toPosix(relative(vaultPath, target)), apply };
}

export async function refactorVault(vaultPath, command, args, options = {}) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const changed = [];
  for (const note of notes) {
    let next = note.raw;
    if (command === "tag-rename") next = rewriteListValue(next, mapping.tags, (items) => items.map((tag) => tag === args[0] ? args[1] : tag));
    if (command === "tag-remove") next = rewriteListValue(next, mapping.tags, (items) => items.filter((tag) => tag !== args[0]));
    if (command === "tag-add") next = rewriteListValue(next, mapping.tags, (items) => [...new Set([...items, args[0]])]);
    if (command === "ref-replace") next = rewriteListValue(next, mapping.refs, (items) => items.map((ref) => stripWiki(ref) === args[0] ? `[[${args[1]}]]` : ref));
    if (command === "ref-add") next = rewriteListValue(next, mapping.refs, (items) => [...new Set([...items, `[[${args[0]}]]`])]);
    if (command === "ref-remove") next = rewriteListValue(next, mapping.refs, (items) => items.filter((ref) => stripWiki(ref) !== args[0]));
    if (command === "wikilink-replace") next = next.replaceAll(`[[${args[0]}]]`, `[[${args[1]}]]`);
    if (next !== note.raw) {
      changed.push(note.relPath);
      if (options.apply) await writeFile(note.path, next, "utf8");
    }
  }
  return { command, apply: Boolean(options.apply), changed };
}

function rewriteListValue(text, key, rewrite) {
  const parsed = readFrontmatter(text);
  const current = asList(parsed.frontmatter[key]);
  const next = rewrite(current).map(String);
  if (current.length === next.length && current.every((item, index) => item === next[index])) {
    return text;
  }
  parsed.frontmatter[key] = next;
  parsed.frontmatter.date_modified = nowIso();
  return writeFrontmatter(parsed.frontmatter, parsed.body);
}

export async function inboxAdd(vaultPath, sourcePath, options = {}) {
  const { mapping } = await readVaultConfig(vaultPath);
  const source = await readFile(sourcePath, "utf8");
  const title = options.title ?? basename(sourcePath, extname(sourcePath));
  const target = join(vaultPath, mapping.inbox_dir, `${title}.md`);
  if (existsSync(target) && !options.force) throw new Error(`target exists: ${title}`);
  const parsed = readFrontmatter(source);
  const frontmatter = {
    [mapping.created_at]: parsed.frontmatter[mapping.created_at] ?? nowIso(),
    [mapping.updated_at]: parsed.frontmatter[mapping.updated_at] ?? nowIso(),
    [mapping.refs]: options.refs?.map((ref) => `[[${stripWiki(ref)}]]`) ?? asList(parsed.frontmatter[mapping.refs]),
    obsidianUIMode: parsed.frontmatter.obsidianUIMode ?? "preview",
    [mapping.tags]: options.tags ?? asList(parsed.frontmatter[mapping.tags]),
    [mapping.note_type]: parsed.frontmatter[mapping.note_type] ?? "note"
  };
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, writeFrontmatter(frontmatter, parsed.body || source), "utf8");
  return { path: toPosix(relative(vaultPath, target)), title };
}

export async function inboxTriage(vaultPath, apply = false, noteName = null) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const inboxNotes = notes.filter((note) => note.folder === mapping.inbox_dir && (!noteName || note.id === noteName));
  const recommendations = inboxNotes.map((note) => ({
    note: note.id,
    path: note.relPath,
    target_folder: note.refs.length ? mapping.archive_dir : mapping.inbox_dir,
    applyable: note.refs.length > 0
  }));
  const moved = [];
  if (apply) {
    for (const item of recommendations.filter((row) => row.applyable)) {
      const note = findNote(notes, item.note);
      const target = join(vaultPath, item.target_folder, `${note.id}.md`);
      await mkdir(dirname(target), { recursive: true });
      await rename(note.path, target);
      moved.push(toPosix(relative(vaultPath, target)));
    }
    return { moved, recommendations };
  }
  return recommendations;
}

export async function reviewVault(vaultPath, scope = "all", options = {}) {
  const validation = await validateVault(vaultPath);
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const issues = [];
  if (scope === "all" || scope === "convention") issues.push(...validation.issues);
  if (scope === "all" || scope === "inbox") {
    for (const note of notes.filter((item) => item.folder === mapping.inbox_dir && item.refs.length > 0)) {
      issues.push({ code: "review.inbox.archive_candidate", severity: "info", note: note.id, message: "Inbox note has refs and can be triaged" });
    }
  }
  if (scope === "all" || scope === "duplicates") {
    const seen = new Map();
    for (const note of notes) {
      if (seen.has(note.id)) issues.push({ code: "review.duplicate.basename", severity: "warn", note: note.id, message: `duplicate basename: ${note.id}` });
      seen.set(note.id, note);
    }
  }
  if (scope === "all" || scope === "tags") {
    const counts = {};
    for (const note of notes) for (const tag of note.tags) counts[tag] = (counts[tag] ?? 0) + 1;
    for (const [tag, count] of Object.entries(counts)) {
      if (count === 1) issues.push({ code: "review.tag.low_usage", severity: "info", tag, message: "tag appears once" });
    }
  }
  if (options.suggestRefactor) {
    for (const item of issues) {
      if (item.code === "ipa.tag.snake_case") item.refactor = `ipa refactor tag-rename ${item.message.split(": ").pop()} <snake_case>`;
    }
  }
  return { scope, issues, status: issues.some((item) => item.severity === "error") ? "error" : "ok" };
}

export async function contractList() {
  return {
    contracts: ["config", "cache-manifest", "graph", "search-event", "testset", "querypack", "plan", "plugin", "context", "review"]
  };
}

export async function contractValidate(path) {
  const text = await readFile(path, "utf8");
  let payload;
  if (path.endsWith(".json")) payload = JSON.parse(text);
  else payload = parseYaml(text);
  return { path, valid: payload && typeof payload === "object", issues: [] };
}

export async function contractValidateOutput(kind, path) {
  const payload = JSON.parse(await readFile(path, "utf8"));
  const issues = [];
  if (kind === "context" && !Array.isArray(payload.notes)) issues.push({ path: "notes", message: "notes must be array" });
  if (kind === "review" && !Array.isArray(payload.issues)) issues.push({ path: "issues", message: "issues must be array" });
  return { kind, path, valid: issues.length === 0, issues };
}

export async function contractExportFixtures(vaultPath, targetRel) {
  const target = resolve(vaultPath, targetRel);
  await mkdir(target, { recursive: true });
  const context = await buildContext(vaultPath, "Alpha", { byNote: true });
  const review = await reviewVault(vaultPath);
  const cache = await rebuildCache(vaultPath);
  const link = await linkPlan(vaultPath);
  const files = {
    "context.json": context,
    "review.json": review,
    "cache-manifest.json": cache.manifest,
    "link-plan.json": link
  };
  for (const [name, payload] of Object.entries(files)) {
    await writeFile(join(target, name), JSON.stringify(payload, null, 2), "utf8");
  }
  return { exported: Object.keys(files).map((name) => toPosix(relative(vaultPath, join(target, name)))) };
}

export async function listPlugins(vaultPath) {
  const { config } = await readVaultConfig(vaultPath);
  const root = join(vaultPath, ".ipa", "plugins");
  const entries = [];
  for (const kind of ["search", "lint", "formatter"]) {
    const dir = join(root, kind);
    const files = existsSync(dir) ? await readdir(dir) : [];
    for (const file of files.filter((name) => name.endsWith(".js") && !name.startsWith("_")).sort()) {
      const relPath = toPosix(relative(vaultPath, join(dir, file)));
      if (pluginEnabled(config, kind, relPath)) entries.push({ kind, path: relPath });
    }
  }
  return { plugins: entries };
}

export function pluginEnabled(config, kind, relPath) {
  const settings = [
    config.plugins,
    config.search?.plugins,
    kind === "lint" ? config.convention?.plugins : undefined,
    kind === "formatter" ? config.formatter?.plugins : undefined
  ];
  let enabled = true;
  for (const setting of settings) {
    if (setting === undefined || setting === null) continue;
    enabled = applyPluginSetting(enabled, setting, kind, relPath);
  }
  return enabled;
}

function applyPluginSetting(current, setting, kind, relPath) {
  if (typeof setting === "boolean") return setting;
  if (Array.isArray(setting)) {
    return setting.includes(kind) || setting.includes(relPath) || setting.includes(basename(relPath));
  }
  if (typeof setting !== "object") return current;
  let enabled = current;
  if (typeof setting[kind] === "boolean") enabled = setting[kind];
  if (typeof setting[relPath] === "boolean") enabled = setting[relPath];
  if (typeof setting[basename(relPath)] === "boolean") enabled = setting[basename(relPath)];
  const only = asList(setting.only);
  const ignore = asList(setting.ignore);
  if (only.length) enabled = only.includes(kind) || only.includes(relPath) || only.includes(basename(relPath));
  if (ignore.includes(kind) || ignore.includes(relPath) || ignore.includes(basename(relPath))) enabled = false;
  return enabled;
}

async function loadPluginModules(vaultPath, kind) {
  const plugins = (await listPlugins(vaultPath)).plugins.filter((item) => item.kind === kind);
  const modules = [];
  for (const plugin of plugins) {
    const path = resolve(vaultPath, plugin.path);
    modules.push({
      ...plugin,
      module: await import(pathToFileURL(path).href + `?t=${Date.now()}`)
    });
  }
  return modules;
}

export async function pluginDoctor(vaultPath) {
  const plugins = (await listPlugins(vaultPath)).plugins;
  const issues = [];
  for (const item of plugins) {
    const report = await validatePlugin(join(vaultPath, item.path), item.kind);
    issues.push(...report.issues);
  }
  return { status: issues.some((item) => item.severity === "error") ? "error" : "ok", plugins, issues };
}

export async function validatePlugin(path, kind = null) {
  const issues = [];
  try {
    const mod = await import(pathToFileURL(path).href + `?t=${Date.now()}`);
    if ((kind === "search" || path.includes("/search/")) && typeof mod.search !== "function") {
      issues.push({ code: "plugin.contract", severity: "error", message: "search plugin must export search()" });
    }
    if ((kind === "lint" || path.includes("/lint/")) && typeof mod.lint !== "function") {
      issues.push({ code: "plugin.contract", severity: "error", message: "lint plugin must export lint()" });
    }
    if ((kind === "formatter" || path.includes("/formatter/")) && typeof mod.format !== "function") {
      issues.push({ code: "plugin.contract", severity: "error", message: "formatter plugin must export format()" });
    }
  } catch (error) {
    issues.push({ code: "plugin.load_failed", severity: "error", message: error.message });
  }
  return { path, kind, issues };
}

export async function pluginDryRun(vaultPath, kind, pluginRelPath, options = {}) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const mod = await import(pathToFileURL(resolve(vaultPath, pluginRelPath)).href + `?t=${Date.now()}`);
  if (kind === "search") {
    const results = await mod.search(options.query ?? "", notes);
    return { kind, plugin: pluginRelPath, query: options.query, results };
  }
  const note = findNote(notes, options.note);
  if (!note) throw new Error(`note not found: ${options.note}`);
  if (kind === "lint") return { kind, plugin: pluginRelPath, note: note.id, issues: await mod.lint(note, { notes, mapping }) };
  if (kind === "formatter") return { kind, plugin: pluginRelPath, note: note.id, patches: await mod.format(note, { notes, mapping }) };
  throw new Error(`unknown plugin dry-run kind: ${kind}`);
}

export function builtinQueryPack(name) {
  if (name !== "ipa-cli-core") return null;
  return {
    name,
    queries: [
      { query: "Alpha", target: "Alpha" },
      { query: "Beta", target: "Beta" },
      { query: "Topic", target: "🔖 Topic Index" }
    ]
  };
}

export async function tuneEval(vaultPath, packName = "ipa-cli-core", params = {}) {
  const pack = builtinQueryPack(packName);
  if (!pack) throw new Error(`query pack not found: ${packName}`);
  const rows = [];
  for (const item of pack.queries) {
    const searchOptions = {
      threshold: params.threshold,
      maxResults: params.cap
    };
    if (Object.hasOwn(params, "weights")) searchOptions.weights = params.weights;
    const result = await searchVault(vaultPath, item.query, searchOptions);
    const rank = result.results.findIndex((hit) => hit.note === item.target) + 1;
    rows.push({ query: item.query, target: item.target, rank: rank || null, hit: rank > 0 });
  }
  const hits = rows.filter((row) => row.hit).length;
  const avgRank = hits ? rows.filter((row) => row.rank).reduce((sum, row) => sum + row.rank, 0) / hits : null;
  return { pack: packName, total: rows.length, hits, misses: rows.length - hits, avg_rank: avgRank, rows };
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

export async function tuneRun(vaultPath, options = {}) {
  const trials = Number(options.trials ?? 20);
  const rng = seeded(Number(options.seed ?? 42));
  const history = [];
  let best = null;
  const startupTrials = Math.max(1, Math.min(30, Math.floor(trials / 4) || 1));
  for (let i = 0; i < trials; i += 1) {
    const params = i < startupTrials ? randomTuneParams(rng) : sampleTpeLite(history, rng);
    const evaluation = await tuneEval(vaultPath, "ipa-cli-core", params);
    const loss = evaluation.misses * 100 + (evaluation.avg_rank ?? 99);
    const trial = { trial: i, optimizer: "tpe-lite", params, loss, metrics: evaluation };
    history.push(trial);
    if (!best || loss < best.loss) best = trial;
  }
  const result = { optimizer: "tpe-lite", trials, best, history };
  const dir = join(vaultPath, ".ipa", "tune", "results");
  await mkdir(dir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(join(dir, name), JSON.stringify(result, null, 2), "utf8");
  const historyPath = join(vaultPath, ".ipa", "tune", "history.jsonl");
  await writeFile(historyPath, history.map((trial) => JSON.stringify(trial)).join("\n") + "\n", "utf8");
  return { ...result, result_file: `.ipa/tune/results/${name}` };
}

function randomTuneParams(rng) {
  return {
    threshold: Number((0.05 + rng() * 0.5).toFixed(4)),
    cap: 5 + Math.floor(rng() * 26),
    weights: Object.fromEntries(CHANNELS.map((channel) => [channel.name, Number((rng() * 0.4).toFixed(4))]))
  };
}

function sampleTpeLite(history, rng) {
  const sorted = [...history].sort((a, b) => a.loss - b.loss);
  const goodCount = Math.max(1, Math.ceil(sorted.length * 0.2));
  const good = sorted.slice(0, goodCount);
  const bad = sorted.slice(goodCount);
  let bestCandidate = randomTuneParams(rng);
  let bestScore = -Infinity;
  for (let i = 0; i < 24; i += 1) {
    const candidate = sampleAroundGood(good, rng);
    const score = densityRatio(candidate, good, bad.length ? bad : sorted);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }
  return bestCandidate;
}

function sampleAroundGood(good, rng) {
  const threshold = clamp(sampleNormal(mean(good.map((trial) => trial.params.threshold)), std(good.map((trial) => trial.params.threshold)) || 0.08, rng), 0.05, 0.55);
  const cap = Math.round(clamp(sampleNormal(mean(good.map((trial) => trial.params.cap)), std(good.map((trial) => trial.params.cap)) || 4, rng), 5, 30));
  const weights = {};
  for (const channel of CHANNELS) {
    const values = good.map((trial) => trial.params.weights[channel.name] ?? channel.defaultWeight);
    weights[channel.name] = Number(clamp(sampleNormal(mean(values), std(values) || 0.06, rng), 0, 0.4).toFixed(4));
  }
  return { threshold: Number(threshold.toFixed(4)), cap, weights };
}

function densityRatio(candidate, good, bad) {
  const params = flattenParams(candidate);
  let goodDensity = 1;
  let badDensity = 1;
  for (const [key, value] of Object.entries(params)) {
    const goodValues = good.map((trial) => flattenParams(trial.params)[key]);
    const badValues = bad.map((trial) => flattenParams(trial.params)[key]);
    goodDensity *= gaussianDensity(value, mean(goodValues), std(goodValues) || 0.05);
    badDensity *= gaussianDensity(value, mean(badValues), std(badValues) || 0.05);
  }
  return goodDensity / Math.max(badDensity, 1e-12);
}

function flattenParams(params) {
  return {
    threshold: params.threshold,
    cap: params.cap,
    ...Object.fromEntries(Object.entries(params.weights ?? {}).map(([key, value]) => [`w:${key}`, value]))
  };
}

function sampleNormal(mu, sigma, rng) {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = Math.max(rng(), 1e-12);
  return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function gaussianDensity(x, mu, sigma) {
  const s = Math.max(sigma, 1e-6);
  const z = (x - mu) / s;
  return Math.exp(-0.5 * z * z) / (s * Math.sqrt(2 * Math.PI));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function std(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export async function tuneList(vaultPath) {
  const dir = join(vaultPath, ".ipa", "tune", "results");
  const files = existsSync(dir) ? (await readdir(dir)).filter((name) => name.endsWith(".json")).sort().reverse() : [];
  return { results: files };
}

export async function tuneUse(vaultPath, filename) {
  const configPath = join(vaultPath, ".ipa", "config.yaml");
  const text = existsSync(configPath) ? await readFile(configPath, "utf8") : "";
  const config = parseYaml(text);
  config.weights = config.weights || {};
  config.weights.file = filename;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, dumpYaml(config) + "\n", "utf8");
  return { active: filename };
}

export async function tuneLog(vaultPath) {
  const path = join(vaultPath, ".ipa", "tune", "logs", "search-events.jsonl");
  if (!existsSync(path)) return { events: [] };
  const events = (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { events };
}

export async function resolveSettings(options = {}) {
  const profileName = options.profile ?? process.env.IPA_PROFILE;
  const registry = await readProfileRegistry();
  if (profileName && !registry.profiles?.[profileName]) {
    throw new Error(`unknown profile: ${profileName}`);
  }
  if (options.vault) return { profile: profileName ?? null, vaultPath: resolve(options.vault), source: "cli" };
  if (profileName && registry.profiles?.[profileName]) {
    return { profile: profileName, vaultPath: resolve(registry.profiles[profileName].vault_path), source: "profile" };
  }
  if (process.env.IPA_VAULT_PATH) return { profile: profileName ?? null, vaultPath: resolve(process.env.IPA_VAULT_PATH), source: "env" };
  const selected = Object.entries(registry.profiles ?? {}).find(([, item]) => item.default === true)?.[0];
  if (selected) return { profile: selected, vaultPath: resolve(registry.profiles[selected].vault_path), source: "default-profile" };
  throw new Error("vault not resolved. Use --vault, --profile, IPA_PROFILE, or IPA_VAULT_PATH");
}

export function profileRegistryPath() {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "ipa", "profile.yaml");
}

export async function readProfileRegistry() {
  const path = profileRegistryPath();
  if (!existsSync(path)) return { profiles: {} };
  return parseYaml(await readFile(path, "utf8"));
}

export async function writeProfileRegistry(registry) {
  const path = profileRegistryPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, dumpYaml(registry) + "\n", "utf8");
  return path;
}

export async function listProfiles() {
  return readProfileRegistry();
}

export async function setDefaultProfile(name) {
  const registry = await readProfileRegistry();
  if (!registry.profiles?.[name]) throw new Error(`profile not found: ${name}`);
  for (const key of Object.keys(registry.profiles)) registry.profiles[key].default = key === name;
  await writeProfileRegistry(registry);
  return { current: name };
}

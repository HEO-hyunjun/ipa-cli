import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  archive_dir: "02 Archive",
  exclude: []
};

export const CHANNELS = [
  { name: "fuzzy", defaultWeight: 0.268, description: "Graded fuzzy match on note id and aliases" },
  { name: "keyword", defaultWeight: 0.055, description: "Token AND match against note id, aliases, refs, tags, and body" },
  { name: "filename", defaultWeight: 0.2, description: "Exact, case-insensitive, substring, and no-space match on note id and aliases" },
  { name: "sequence_match", defaultWeight: 0.078, description: "All query tokens appear in normalized note id or aliases" },
  { name: "filename_partial", defaultWeight: 0.15, description: "Partial token match on normalized note id or aliases" },
  { name: "body_match", defaultWeight: 0.363, description: "Body term coverage over note id, aliases, and body" },
  { name: "child_body_match", defaultWeight: 0.169, description: "Index/root inherits child body match from notes that ref it" },
  { name: "related", defaultWeight: 0.032, description: "Graph-neighbor expansion from filename-matched seeds" },
  { name: "project", defaultWeight: 0.033, description: "Project folder/ref boost" }
];

export const RULES = [
  { code: "ipa.frontmatter.required_field", category: "frontmatter", severity: "warn", scope: "note" },
  { code: "ipa.frontmatter.date_format", category: "frontmatter", severity: "warn", scope: "note" },
  { code: "ipa.frontmatter.invalid_type", category: "frontmatter", severity: "error", scope: "note" },
  { code: "ipa.frontmatter.missing_ref", category: "frontmatter", severity: "warn", scope: "note" },
  { code: "ipa.inbox.raw_capture", category: "inbox", severity: "warn", scope: "note" },
  { code: "ipa.location.type_mismatch", category: "location", severity: "warn", scope: "note" },
  { code: "ipa.link.ref_target_missing", category: "link", severity: "warn", scope: "vault" },
  { code: "ipa.link.wikilink_target_missing", category: "link", severity: "warn", scope: "vault" },
  { code: "ipa.root_folder.duplicate", category: "root_folder", severity: "warn", scope: "vault" },
  { code: "ipa.root_folder.missing", category: "root_folder", severity: "warn", scope: "vault" },
  { code: "ipa.heading.no_h1", category: "heading", severity: "info", scope: "note" }
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
      let childIndent = indent + 2;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (!lines[j].trim() || lines[j].trim().startsWith("#")) continue;
        if (countIndent(lines[j]) === indent && lines[j].trim().startsWith("- ")) childIndent = indent;
        break;
      }
      const parsed = parseYamlBlock(lines, i + 1, childIndent);
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
  if (Array.isArray(value)) return value.flatMap(asList);
  if (typeof value === "object") return Object.values(value).flatMap(asList);
  return [String(value)];
}

export function stripWiki(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]$/);
  return normalizeTitle(match ? match[1] : text);
}

export function extractWikilinks(text) {
  const out = [];
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let inCodeBlock = false;
  for (const line of String(text ?? "").split("\n")) {
    if (isCodeFence(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    let match;
    while ((match = re.exec(line))) out.push(normalizeTitle(match[1]));
  }
  return out;
}

function normalizeTitle(value) {
  return String(value ?? "").trim().normalize("NFC");
}

const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D]/gu;

function searchableTitle(value) {
  return normalizeTitle(value).replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
}

function searchableKey(value) {
  return searchableTitle(value).toLowerCase();
}

function sameNoteName(left, right) {
  const leftTitle = normalizeTitle(left);
  const rightTitle = normalizeTitle(right);
  if (!leftTitle || !rightTitle) return false;
  if (leftTitle === rightTitle || leftTitle.toLowerCase() === rightTitle.toLowerCase()) return true;
  const leftKey = searchableKey(leftTitle);
  const rightKey = searchableKey(rightTitle);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function hasNoteName(values, target) {
  return values.some((value) => sameNoteName(value, target));
}

function shareNoteNames(leftValues, rightValues) {
  return leftValues.some((left) => hasNoteName(rightValues, left));
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
  mapping.exclude = asList(config.files?.exclude ?? config.notes?.exclude ?? raw.exclude);
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
  const excludes = asList(mapping.exclude);
  const files = await walkFiles(vaultPath, (path, relPath) =>
    extname(path).toLowerCase() === ".md" && !isExcludedPath(relPath, excludes)
  );
  const notes = [];
  for (const path of files.sort()) {
    const raw = await readFile(path, "utf8");
    const relPath = toPosix(relative(vaultPath, path));
    const { frontmatter, body } = readFrontmatter(raw);
    const id = normalizeTitle(basename(path, ".md"));
    const refs = asList(frontmatter[mapping.refs]).map(stripWiki).filter(Boolean);
    const tags = asList(frontmatter[mapping.tags]).map((tag) => String(tag).replace(/^#/, ""));
    const aliases = mapping.aliases ? asList(frontmatter[mapping.aliases]).map(normalizeTitle) : [];
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

function isExcludedPath(relPath, patterns) {
  const rel = toPosix(relPath).normalize("NFC");
  return patterns.some((pattern) => {
    const raw = toPosix(String(pattern ?? "").trim()).replace(/^\/+/, "").normalize("NFC");
    return matchesPathPattern(rel, raw);
  });
}

function matchesPathPattern(rel, pattern) {
  if (!pattern) return false;
  if (pattern.endsWith("/**")) {
    const dir = pattern.slice(0, -3);
    return rel === dir || rel.startsWith(`${dir}/`);
  }
  if (pattern.endsWith("/")) return rel.startsWith(pattern);
  if (pattern.includes("*")) return globToRegExp(pattern).test(rel);
  return rel === pattern || rel.startsWith(`${pattern}/`);
}

function globToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else {
      source += ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function indexNotes(notes) {
  return new Map(notes.map((note) => [note.id, note]));
}

export function buildGraph(notes) {
  const edges = {};
  const backlinks = {};
  for (const note of notes) {
    const targets = [...new Set(
      [...note.refs, ...note.links]
        .map((target) => findNote(notes, target)?.id)
        .filter(Boolean)
    )];
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

export function scoreNote(note, query, notes, weights = {}, mapping = DEFAULT_MAPPING) {
  const raw = searchableTitle(query);
  const lower = raw.toLowerCase();
  const tokens = tokenize(raw);
  const names = [note.id, ...note.aliases];
  const searchNames = names.map(searchableTitle).filter(Boolean);
  const reasons = {};
  const channelScores = {};

  const bestName = lower ? Math.max(0, ...searchNames.map((name) => {
    const n = name.toLowerCase();
    if (n === lower) return 1;
    if (n.includes(lower)) return 0.78;
    return 0;
  })) : 0;
  channelScores.filename = bestName;
  if (bestName) reasons.filename = { matched: names.find((name) => searchableKey(name).includes(lower)) ?? note.id };

  const fuzzy = lower ? Math.max(0, ...searchNames.map((name) => subsequenceScore(lower, name))) : 0;
  channelScores.fuzzy = fuzzy;
  if (fuzzy) reasons.fuzzy = { score: fuzzy };

  const bodyTokens = tokenize(`${searchNames.join(" ")} ${searchableTitle(note.body)}`);
  const coverage = tokens.length ? tokens.filter((token) => bodyTokens.includes(token)).length / tokens.length : 0;
  channelScores.sequence_match = tokens.length && tokens.every((token) => searchNames.some((name) => name.toLowerCase().includes(token))) ? 1 : 0;
  if (channelScores.sequence_match) reasons.sequence_match = { coverage: 1 };

  const partialMatches = tokens.length
    ? tokens.filter((token) => searchNames.some((name) => name.toLowerCase().includes(token))).length / tokens.length
    : 0;
  channelScores.filename_partial = partialMatches > 0 && partialMatches < 1 ? partialMatches : 0;
  if (channelScores.filename_partial) reasons.filename_partial = { coverage: channelScores.filename_partial };

  const keywordText = searchableTitle(`${note.refs.join(" ")} ${note.tags.join(" ")} ${note.aliases.join(" ")} ${note.body}`).toLowerCase();
  const keyword = tokens.length ? tokens.filter((token) => keywordText.includes(token)).length / tokens.length : 0;
  channelScores.keyword = keyword;
  if (keyword) reasons.keyword = { coverage: keyword };

  const bodyLower = searchableTitle(note.body).toLowerCase();
  const body = tokens.length ? tokens.filter((token) => bodyLower.includes(token)).length / tokens.length : 0;
  channelScores.body_match = Math.max(body, coverage);
  if (channelScores.body_match) reasons.body_match = { coverage: channelScores.body_match };

  const directHits = lower ? notes.filter((candidate) => searchableKey(candidate.id).includes(lower)) : [];
  const shared = directHits.some((candidate) =>
    candidate.id !== note.id &&
    (shareNoteNames(candidate.refs, note.refs) || candidate.tags.some((tag) => note.tags.includes(tag)))
  );
  channelScores.related = shared ? 0.5 : 0;
  if (shared) reasons.related = { shared: true };

  const projectDir = mapping.project_dir ?? DEFAULT_MAPPING.project_dir;
  channelScores.project = note.folder === projectDir || note.folder.startsWith(`${projectDir}/`) ? 0.35 : 0;
  const childBody = note.type === "index" || note.type === "root"
    ? Math.max(0, ...notes.filter((candidate) => hasNoteName(candidate.refs, note.id)).map((candidate) => {
        const candidateBody = searchableTitle(candidate.body).toLowerCase();
        return tokens.length ? tokens.filter((token) => candidateBody.includes(token)).length / tokens.length : 0;
      }))
    : 0;
  channelScores.child_body_match = childBody;
  if (childBody) reasons.child_body_match = { coverage: childBody };

  let score = 0;
  for (const channel of CHANNELS) {
    const weight = weights[channel.name] ?? channel.defaultWeight;
    score += (channelScores[channel.name] ?? 0) * weight;
  }
  return { score, reasons, channelScores };
}

function prepareSearchNotes(notes, mapping = DEFAULT_MAPPING) {
  const projectDir = mapping.project_dir ?? DEFAULT_MAPPING.project_dir;
  const prepared = notes.map((note) => {
    const names = [note.id, ...note.aliases];
    const searchNames = names.map(searchableTitle).filter(Boolean);
    const bodySearch = searchableTitle(note.body);
    return {
      note,
      names,
      searchNames,
      searchNameLowers: searchNames.map((name) => name.toLowerCase()),
      idKey: searchableKey(note.id),
      bodyLower: bodySearch.toLowerCase(),
      bodyTokenSet: new Set(tokenize(`${searchNames.join(" ")} ${bodySearch}`)),
      keywordText: searchableTitle(`${note.refs.join(" ")} ${note.tags.join(" ")} ${note.aliases.join(" ")} ${note.body}`).toLowerCase(),
      isProject: note.folder === projectDir || note.folder.startsWith(`${projectDir}/`),
      childBodyLowers: []
    };
  });
  for (const item of prepared) {
    if (item.note.type !== "index" && item.note.type !== "root") continue;
    item.childBodyLowers = prepared
      .filter((candidate) => hasNoteName(candidate.note.refs, item.note.id))
      .map((candidate) => candidate.bodyLower);
  }
  return prepared;
}

function prepareSearchQuery(query, preparedNotes) {
  const raw = searchableTitle(query);
  const lower = raw.toLowerCase();
  return {
    raw,
    lower,
    tokens: tokenize(raw),
    directHits: lower ? preparedNotes.filter((candidate) => candidate.idKey.includes(lower)) : []
  };
}

function scorePreparedNote(prepared, query, weights = {}) {
  const { note } = prepared;
  const reasons = {};
  const channelScores = {};

  const bestName = query.lower ? Math.max(0, ...prepared.searchNameLowers.map((name) => {
    if (name === query.lower) return 1;
    if (name.includes(query.lower)) return 0.78;
    return 0;
  })) : 0;
  channelScores.filename = bestName;
  if (bestName) reasons.filename = { matched: prepared.names.find((name) => searchableKey(name).includes(query.lower)) ?? note.id };

  const fuzzy = query.lower ? Math.max(0, ...prepared.searchNames.map((name) => subsequenceScore(query.lower, name))) : 0;
  channelScores.fuzzy = fuzzy;
  if (fuzzy) reasons.fuzzy = { score: fuzzy };

  const coverage = query.tokens.length
    ? query.tokens.filter((token) => prepared.bodyTokenSet.has(token)).length / query.tokens.length
    : 0;
  channelScores.sequence_match = query.tokens.length && query.tokens.every((token) =>
    prepared.searchNameLowers.some((name) => name.includes(token))
  ) ? 1 : 0;
  if (channelScores.sequence_match) reasons.sequence_match = { coverage: 1 };

  const partialMatches = query.tokens.length
    ? query.tokens.filter((token) => prepared.searchNameLowers.some((name) => name.includes(token))).length / query.tokens.length
    : 0;
  channelScores.filename_partial = partialMatches > 0 && partialMatches < 1 ? partialMatches : 0;
  if (channelScores.filename_partial) reasons.filename_partial = { coverage: channelScores.filename_partial };

  const keyword = query.tokens.length
    ? query.tokens.filter((token) => prepared.keywordText.includes(token)).length / query.tokens.length
    : 0;
  channelScores.keyword = keyword;
  if (keyword) reasons.keyword = { coverage: keyword };

  const body = query.tokens.length
    ? query.tokens.filter((token) => prepared.bodyLower.includes(token)).length / query.tokens.length
    : 0;
  channelScores.body_match = Math.max(body, coverage);
  if (channelScores.body_match) reasons.body_match = { coverage: channelScores.body_match };

  const shared = query.directHits.some((candidate) =>
    candidate.note.id !== note.id &&
    (shareNoteNames(candidate.note.refs, note.refs) || candidate.note.tags.some((tag) => note.tags.includes(tag)))
  );
  channelScores.related = shared ? 0.5 : 0;
  if (shared) reasons.related = { shared: true };

  channelScores.project = prepared.isProject ? 0.35 : 0;
  const childBody = note.type === "index" || note.type === "root"
    ? Math.max(0, ...prepared.childBodyLowers.map((candidateBody) =>
        query.tokens.length
          ? query.tokens.filter((token) => candidateBody.includes(token)).length / query.tokens.length
          : 0
      ))
    : 0;
  channelScores.child_body_match = childBody;
  if (childBody) reasons.child_body_match = { coverage: childBody };

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
  return searchWithContext(await prepareSearchContext(vaultPath), query, options);
}

async function prepareSearchContext(vaultPath) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const active = await activeSearchParams(vaultPath);
  const plugins = await loadPluginModules(vaultPath, "search");
  return { vaultPath, mapping, notes, active, plugins, preparedNotes: prepareSearchNotes(notes, mapping) };
}

async function searchWithContext(context, query, options = {}) {
  const { vaultPath, mapping, notes, active, plugins, preparedNotes } = context;
  const threshold = options.showAll ? 0 : options.threshold ?? active.threshold ?? 0.3;
  const cap = options.maxResults ?? options.cap ?? active.cap ?? 10;
  const weights = options.weights ?? active.weights ?? {};
  const searchQuery = prepareSearchQuery(query, preparedNotes);
  const hitsByNote = new Map();
  for (const prepared of preparedNotes) {
    const { note } = prepared;
    const scored = scorePreparedNote(prepared, searchQuery, weights);
    hitsByNote.set(note.id, {
        note: note.id,
        path: note.relPath,
        type: note.type || "?",
        refs: note.refs,
        score: Number(scored.score.toFixed(6)),
        reasons: scored.reasons
    });
  }
  for (const hit of await runSearchPlugins(vaultPath, query, notes, mapping, plugins)) {
    const note = findNote(notes, hit.note);
    if (!note) continue;
    const current = hitsByNote.get(note.id) ?? {
      note: note.id,
      path: note.relPath,
      type: note.type || "?",
      refs: note.refs,
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
  const refCounts = {};
  for (const hit of hits) {
    for (const ref of hit.refs ?? []) refCounts[ref] = (refCounts[ref] ?? 0) + 1;
  }
  const ref_distribution = Object.entries(refCounts)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([ref, count]) => ({ ref, count }));
  return { query, threshold, max_results: cap, count: hits.length, results: hits, ref_distribution };
}

async function runSearchPlugins(vaultPath, query, notes, mapping, plugins = null) {
  const modules = plugins ?? await loadPluginModules(vaultPath, "search");
  const hits = [];
  for (const plugin of modules) {
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
  if (options.section) {
    return renderSectionNote(note, options.section);
  }
  if (options.full) return renderFullNote(note, notes, vaultPath);
  return renderOverviewNote(note, notes, vaultPath);
}

function renderOverviewNote(note, notes, vaultPath) {
  const lines = [...renderContextHeader(note, notes, vaultPath), ...renderFrontmatter(note), ""];
  const sections = bodySections(note.body);
  if (sections.length) {
    lines.push("## Structure");
    for (const section of sections) {
      const indent = "  ".repeat(Math.max(0, section.level - 1));
      if (section.kind === "header") lines.push(`${indent}[H${section.level}] ${section.title}`);
      else lines.push(`${indent}[!${section.calloutType}${section.collapsed ? "-" : ""}] ${section.title}`);
    }
  } else if (note.body.trim()) {
    lines.push("(structure unavailable - body exists)");
  } else {
    lines.push("(empty body)");
  }
  lines.push(...renderActionFooter(note, notes, true));
  return lines.join("\n");
}

function renderFullNote(note, notes, vaultPath) {
  const lines = [
    ...renderContextHeader(note, notes, vaultPath),
    ...renderFrontmatter(note),
    "",
    ...renderFullBody(note.body)
  ];
  lines.push(...renderActionFooter(note, notes));
  return lines.join("\n");
}

function renderSectionNote(note, title) {
  const sections = bodySections(note.body);
  const query = String(title ?? "").toLowerCase();
  const matches = sections.filter((section) => section.title === title);
  const selected = matches.length
    ? matches
    : sections.filter((section) => section.title.toLowerCase() === query || section.title.toLowerCase().includes(query));
  if (!selected.length) {
    const available = sections.map((section) => section.kind === "header"
      ? `  [H${section.level}] ${section.title}`
      : `  [!${section.calloutType}] ${section.title}`).join("\n") || "  (no sections)";
    return `Section not found: '${title}'\n\nAvailable sections:\n${available}`;
  }
  return selected.map((section) => section.rendered).join("\n\n");
}

function renderContextHeader(note, notes, vaultPath) {
  const folder = formatFolderLabel(note, vaultPath);
  const folderLabel = folder ? `  📁 ${folder}` : "";
  const lines = [`=== ${note.id} [${note.type || "?"}]${folderLabel} ===`];
  const paths = upwardPaths(note, notes).map((path) => path.slice(1)).filter((path) => path.length);
  if (paths.length) {
    for (const path of paths) lines.push(`↑ ref: ${path.join(" → ")}`);
  } else if (note.type === "root") {
    lines.push("↑ ref: (root — 최상위)");
  } else if (note.type === "index") {
    lines.push("↑ ref: (독립 index — root 없음)");
  }
  if (note.aliases.length) lines.push(`aliases: ${note.aliases.join(", ")}`);
  lines.push(`Path: ${note.path}`);
  return lines;
}

function formatFolderLabel(note, vaultPath) {
  const envVault = process.env.IPA_VAULT_PATH ? resolve(process.env.IPA_VAULT_PATH) : null;
  if (!envVault || resolve(vaultPath) !== envVault) return "";
  const rel = toPosix(relative(envVault, note.path));
  return rel && !rel.startsWith("..") ? rel.split("/")[0] : "";
}

function renderFrontmatter(note) {
  if (!Object.keys(note.frontmatter).length) return [];
  return ["---", ...Object.entries(note.frontmatter).map(([key, value]) => `${key}: ${formatFrontmatterValue(value)}`), "---"];
}

function formatFrontmatterValue(value) {
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderFullBody(body) {
  const text = String(body ?? "").replace(/^\n+/, "");
  if (!text.trim()) return ["(empty body)"];
  const lines = text.split("\n");
  const out = [];
  let inCodeBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isCodeFence(line)) {
      inCodeBlock = !inCodeBlock;
      out.push(line);
      continue;
    }
    if (!inCodeBlock && isCollapsedCallout(line)) {
      let count = 0;
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith(">")) {
        count += 1;
        j += 1;
      }
      out.push(line, `> (...collapsed, ${count} lines)`);
      i = j - 1;
      continue;
    }
    out.push(line);
  }
  return out;
}

function bodySections(body) {
  const lines = String(body ?? "").replace(/^\n+/, "").split("\n");
  const sections = [];
  let inCodeBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isCodeFence(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const header = line.match(/^(#{1,6})\s+(.+)$/);
    const callout = line.match(/^>\s*\[!(\w+)\]([+-]?)\s*(.*)$/);
    if (!header && !callout) continue;
    const level = header ? header[1].length : 1;
    const title = header ? header[2].trim() : (callout[3].trim() || callout[1]);
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const nextHeader = lines[j].match(/^(#{1,6})\s+(.+)$/);
      const nextCallout = lines[j].match(/^>\s*\[!(\w+)\]([+-]?)\s*(.*)$/);
      if (nextHeader && nextHeader[1].length <= level) {
        end = j;
        break;
      }
      if (!header && nextCallout) {
        end = j;
        break;
      }
    }
    sections.push({
      kind: header ? "header" : "callout",
      level,
      title,
      calloutType: callout?.[1] ?? "",
      collapsed: callout?.[2] === "-",
      rendered: renderFullBody(lines.slice(i, end).join("\n")).join("\n")
    });
  }
  return sections;
}

function isCodeFence(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

function isCollapsedCallout(line) {
  const match = line.match(/^>\s*\[!(\w+)\]([+-]?)\s*(.*)$/);
  return Boolean(match && match[2] === "-");
}

function renderActionFooter(note, notes, isOverview = false) {
  const outlinks = new Set(note.links).size;
  const backlinks = countBacklinks(note, notes);
  const peerNotes = siblings(note, notes);
  const lines = ["", "────────────────"];

  if (note.type === "index" || note.type === "root") {
    lines.push(`연결: ↘ 하위 ${countChildren(note, notes)}  ↗ outlinks ${outlinks}  ↩ backlinks ${backlinks}  ⇄ 형제 ${peerNotes.length}`);
  } else {
    lines.push(`연결: ↗ outlinks ${outlinks}  ↩ backlinks ${backlinks}  ⇄ siblings ${peerNotes.length}`);
  }

  lines.push(...formatTagDistribution(note, notes));
  lines.push(...renderActionHints(note, isOverview));
  return lines;
}

function countBacklinks(note, notes) {
  return notes.filter((candidate) =>
    candidate.id !== note.id && hasNoteName([...candidate.refs, ...candidate.links], note.id)
  ).length;
}

function countChildren(note, notes) {
  return notes.filter((candidate) => hasNoteName(candidate.refs, note.id)).length;
}

function formatTagDistribution(note, notes) {
  if (!note.tags.length) return [];
  const sorted = note.tags
    .map((tag) => ({
      tag,
      peers: notes.filter((candidate) => candidate.id !== note.id && candidate.tags.includes(tag))
    }))
    .sort((a, b) => b.peers.length - a.peers.length)
    .slice(0, 3);
  const width = Math.max(...sorted.map((item) => item.tag.length));
  const lines = ["🏷 tags:"];
  for (const item of sorted) {
    const refs = {};
    for (const peer of item.peers) {
      for (const ref of peer.refs) refs[ref] = (refs[ref] ?? 0) + 1;
    }
    const refText = Object.entries(refs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([ref, count]) => `${ref} (${count})`)
      .join(", ");
    let warn = "";
    if (item.peers.length === 0) warn = "  ⚠ 고립(이 tag는 이 노트만)";
    else if (item.peers.length === 1) warn = "  ⚠ 동행 1건(시그널 약함)";
    else if (Object.keys(refs).length <= 1) warn = "  ⚠ 미가로지름(같은 인덱스에만 분포)";
    lines.push(`  ${item.tag.padEnd(width)}  (${String(item.peers.length).padStart(3)})${refText ? `  → ${refText}` : ""}${warn}`);
  }
  return lines;
}

function renderActionHints(note, isOverview) {
  const commands = note.type === "index" || note.type === "root"
    ? [
        [`ipa traversal --down "${note.id}"`, "하위 트리"],
        [`ipa traversal --siblings "${note.id}"`, "같은 부모 아래 형제"],
        [`ipa context "${note.id}" --by-note`, "이 노트 중심 context"]
      ]
    : [
        [`ipa traversal --up "${note.id}"`, "상위 인덱스 → root 경로"],
        [`ipa traversal --siblings "${note.id}"`, "같은 부모 아래 형제"],
        [`ipa context "${note.id}" --by-note`, "이 노트 중심 context"]
      ];
  if (note.tags[0]) commands.push([`ipa search "${note.tags[0]}"`, "태그/본문 검색"]);
  if (isOverview) commands.push([`ipa view "${note.id}" --full`, "이 노트의 본문 전체 보기"]);
  const width = Math.max(...commands.map(([command]) => command.length));
  return ["다음:", ...commands.map(([command, hint]) => `  ${command.padEnd(width)}  # ${hint}`)];
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

function noteNameScore(note, noteName) {
  const query = searchableKey(noteName);
  if (!query) return 0;
  const compactQuery = query.replace(/\s+/g, "");
  const names = [note.id, ...note.aliases].map(searchableKey).filter(Boolean);
  return Math.max(0, ...names.map((name) => {
    const compactName = name.replace(/\s+/g, "");
    if (name === query) return 1;
    if (compactName === compactQuery) return 0.98;
    if (query.length >= 2 && name.includes(query)) return 0.9;
    if (query.length >= 2 && compactName.includes(compactQuery)) return 0.82;
    return query.length >= 3 ? subsequenceScore(query, name) : 0;
  }));
}

export function findNote(notes, noteName) {
  const normalized = normalizeTitle(noteName);
  const query = normalized.toLowerCase();
  const exact = notes.find((note) => note.id === normalized) ??
    notes.find((note) => note.id.toLowerCase() === query) ??
    notes.find((note) => note.aliases.some((alias) => alias.toLowerCase() === query));
  if (exact) return exact;
  const scored = notes
    .map((note) => ({ note, score: noteNameScore(note, normalized) }))
    .filter((item) => item.score >= 0.65)
    .sort((a, b) => b.score - a.score || a.note.id.localeCompare(b.note.id));
  return scored[0]?.note ?? null;
}

export async function traversal(vaultPath, mode, noteName) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const note = findNote(notes, noteName);
  if (!note) throw new Error(`note not found: ${noteName}`);
  if (mode === "up") return { mode, note: note.id, paths: upwardPaths(note, notes) };
  if (mode === "down") return { mode, note: note.id, tree: downwardTree(note.id, notes) };
  if (mode === "siblings") return { mode, note: note.id, siblings: siblings(note, notes).map((item) => item.id) };
  if (mode === "root") return { mode, note: note.id, roots: upwardPaths(note, notes).map((path) => path[path.length - 1]).filter(Boolean) };
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

function downwardTree(noteId, notes, seen = new Set()) {
  const note = findNote(notes, noteId);
  const id = note?.id ?? noteId;
  if (seen.has(id)) return { note: id, type: note?.type ?? "", children: [] };
  seen.add(id);
  const children = notes
    .filter((candidate) => hasNoteName(candidate.refs, id))
    .map((candidate) => candidate.id)
    .sort()
    .map((child) => downwardTree(child, notes, new Set(seen)));
  return { note: id, type: note?.type ?? "", children };
}

function siblings(note, notes) {
  if (!note.refs.length) return [];
  return notes.filter((candidate) => candidate.id !== note.id && shareNoteNames(candidate.refs, note.refs));
}

export async function validateVault(vaultPath) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const excludedTitles = await loadExcludedMarkdownTitles(vaultPath, mapping);
  const markdownTitles = await loadActiveMarkdownTitles(vaultPath, mapping);
  const issues = [];
  for (const note of notes) {
    if (note.folder === mapping.inbox_dir && Object.keys(note.frontmatter).length === 0) {
      issues.push(issue("ipa.inbox.raw_capture", "warn", note, "raw inbox capture without frontmatter"));
      continue;
    }
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
      if (!findNote(notes, ref) && !markdownTitleExists(excludedTitles, ref)) {
        issues.push(issue("K001", "warn", note, `ref target missing: ${ref}`));
      }
    }
    for (const link of note.links) {
      if (!markdownTitleExists(markdownTitles, link) && !markdownTitleExists(excludedTitles, link)) {
        issues.push(issue("K002", "warn", note, `wikilink target missing: ${link}`));
      }
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

async function loadActiveMarkdownTitles(vaultPath, mapping) {
  const excludes = asList(mapping.exclude);
  const files = await walkFiles(vaultPath, (path, relPath) =>
    extname(path).toLowerCase() === ".md" && !isExcludedPath(relPath, excludes)
  );
  return markdownTitleSet(files);
}

async function loadExcludedMarkdownTitles(vaultPath, mapping) {
  const excludes = asList(mapping.exclude);
  const files = await walkFiles(vaultPath, (path, relPath) =>
    extname(path).toLowerCase() === ".md" && isExcludedPath(relPath, excludes)
  );
  return markdownTitleSet(files);
}

function markdownTitleSet(files) {
  const titles = new Set();
  for (const path of files) {
    const title = normalizeTitle(basename(path, ".md"));
    titles.add(title);
    titles.add(title.toLowerCase());
    const key = searchableKey(title);
    if (key) titles.add(key);
  }
  return titles;
}

function markdownTitleExists(titles, title) {
  const normalized = normalizeTitle(title);
  return titles.has(normalized) || titles.has(normalized.toLowerCase()) || titles.has(searchableKey(normalized));
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

export async function formatVault(vaultPath, apply = false, options = {}) {
  const { mapping } = await readVaultConfig(vaultPath);
  const allNotes = await loadNotes(vaultPath, mapping);
  const requested = asList(options.notes ?? options.note);
  const targets = [];
  for (const noteName of requested) {
    const note = findNote(allNotes, noteName);
    if (!note) throw new Error(`note not found: ${noteName}`);
    if (!targets.some((item) => item.id === note.id)) targets.push(note);
  }
  const targetIds = new Set(targets.map((note) => note.id));
  const notes = targets.length ? targets : allNotes;
  const validation = await validateVault(vaultPath);
  const issues = targetIds.size
    ? validation.issues.filter((item) => targetIds.has(item.note) || notes.some((note) => note.relPath === item.path))
    : validation.issues;
  const patches = [];
  for (const plugin of await loadPluginModules(vaultPath, "formatter")) {
    for (const note of notes) {
      const output = await plugin.module.format(note, {
        notes: allNotes,
        mapping,
        vaultPath,
        apply,
        target: targetIds.size ? note.id : null,
        options: {
          note: targets.length === 1 ? targets[0].id : null,
          notes: targets.map((item) => item.id)
        }
      });
      patches.push(...normalizeFormatterPatches(output, plugin.path, note));
    }
  }
  const applied = apply ? await applyFormatterPatches(notes, patches) : undefined;
  return {
    summary: { issues: issues.length, patches: patches.length },
    patches,
    applied,
    issues
  };
}

async function applyFormatterPatches(notes, patches) {
  const byNote = new Map(notes.map((note) => [note.id, { note, patches: [] }]));
  for (const patch of patches) {
    const entry = byNote.get(patch.note);
    if (entry) entry.patches.push(patch);
  }
  const applied = [];
  for (const { note, patches: notePatches } of byNote.values()) {
    if (!notePatches.length) continue;
    let text = note.raw;
    for (const patch of notePatches) {
      text = applyFormatterPatch(text, patch);
    }
    if (text !== note.raw) {
      await writeFile(note.path, text, "utf8");
      applied.push({ note: note.id, path: note.relPath, patches: notePatches.length });
    }
  }
  return applied;
}

function applyFormatterPatch(text, patch) {
  if (typeof patch.content === "string") return patch.content;
  if (Number.isInteger(patch.line) && typeof patch.replacement === "string") {
    const lines = String(text ?? "").split("\n");
    const index = Math.max(0, patch.line - 1);
    lines.splice(index, 1, patch.replacement);
    return lines.join("\n");
  }
  return text;
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
    const bodyKey = searchableTitle(note.body).toLowerCase();
    for (const other of notes) {
      if (other.id === note.id || hasNoteName(note.links, other.id)) continue;
      const otherKey = searchableKey(other.id);
      if (note.body.includes(other.id) || (otherKey && bodyKey.includes(otherKey))) {
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
    if (!note || hasNoteName(note.links, change.target)) continue;
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
    if (command === "tag-rename") next = rewriteListValue(next, mapping.tags, (items) => items.map((tag) => tag === args[0] ? args[1] : tag), mapping.updated_at);
    if (command === "tag-remove") next = rewriteListValue(next, mapping.tags, (items) => items.filter((tag) => tag !== args[0]), mapping.updated_at);
    if (command === "tag-add") next = rewriteListValue(next, mapping.tags, (items) => [...new Set([...items, args[0]])], mapping.updated_at);
    if (command === "ref-replace") next = rewriteListValue(next, mapping.refs, (items) => items.map((ref) => stripWiki(ref) === args[0] ? `[[${args[1]}]]` : ref), mapping.updated_at);
    if (command === "ref-add") next = rewriteListValue(next, mapping.refs, (items) => [...new Set([...items, `[[${args[0]}]]`])], mapping.updated_at);
    if (command === "ref-remove") next = rewriteListValue(next, mapping.refs, (items) => items.filter((ref) => stripWiki(ref) !== args[0]), mapping.updated_at);
    if (command === "wikilink-replace") next = next.replaceAll(`[[${args[0]}]]`, `[[${args[1]}]]`);
    if (next !== note.raw) {
      changed.push(note.relPath);
      if (options.apply) await writeFile(note.path, next, "utf8");
    }
  }
  return { command, apply: Boolean(options.apply), changed };
}

function rewriteListValue(text, key, rewrite, updatedKey = DEFAULT_MAPPING.updated_at) {
  const parsed = readFrontmatter(text);
  const current = asList(parsed.frontmatter[key]);
  const next = rewrite(current).map(String);
  if (current.length === next.length && current.every((item, index) => item === next[index])) {
    return text;
  }
  parsed.frontmatter[key] = next;
  if (updatedKey) parsed.frontmatter[updatedKey] = nowIso();
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
    ...parsed.frontmatter,
    [mapping.created_at]: parsed.frontmatter[mapping.created_at] ?? nowIso(),
    [mapping.updated_at]: parsed.frontmatter[mapping.updated_at] ?? nowIso(),
    [mapping.refs]: options.refs?.map((ref) => `[[${stripWiki(ref)}]]`) ?? asList(parsed.frontmatter[mapping.refs]),
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
  if (kind === "formatter") {
    return {
      kind,
      plugin: pluginRelPath,
      note: note.id,
      patches: await mod.format(note, {
        notes,
        mapping,
        vaultPath,
        apply: false,
        target: note.id,
        options: { note: note.id }
      })
    };
  }
  throw new Error(`unknown plugin dry-run kind: ${kind}`);
}

export function builtinQueryPack(name) {
  if (name !== "ipa-cli-core") return null;
  return {
    name,
    queries: [
      { query: "Alpha", target: "Alpha" },
      { query: "Beta", target: "Beta" },
      { query: "Topic", target: "Topic Index" }
    ]
  };
}

async function configuredQueryPack(vaultPath) {
  const { config } = await readVaultConfig(vaultPath);
  const file = config.test?.file;
  if (!file) return null;
  const path = resolve(vaultPath, file);
  if (!existsSync(path)) return null;
  const payload = JSON.parse(await readFile(path, "utf8"));
  const queries = [];
  for (const item of payload.cases ?? payload.queries ?? []) {
    const target = normalizeTitle(item.target_filename ?? item.target ?? item.note ?? item.expected);
    const itemQueries = Array.isArray(item.queries) ? item.queries : [item.query];
    for (const query of itemQueries.filter(Boolean)) {
      if (target) queries.push({ query, target });
    }
  }
  return { name: file, queries };
}

async function resolveTunePack(vaultPath, packName = null) {
  let pack = packName ? builtinQueryPack(packName) : await configuredQueryPack(vaultPath);
  if (!pack) {
    throw new Error(packName
      ? `query pack not found: ${packName}`
      : "tune testset not configured: set test.file in .ipa/config.yaml");
  }
  return pack;
}

async function evaluateTunePack(searchContext, pack, params = {}) {
  const rows = [];
  for (const item of pack.queries) {
    const searchOptions = {
      threshold: params.threshold,
      maxResults: params.cap
    };
    if (Object.hasOwn(params, "weights")) searchOptions.weights = params.weights;
    const result = await searchWithContext(searchContext, item.query, searchOptions);
    const rank = result.results.findIndex((hit) => sameNoteName(hit.note, item.target)) + 1;
    rows.push({ query: item.query, target: item.target, rank: rank || null, hit: rank > 0 });
  }
  const hits = rows.filter((row) => row.hit).length;
  const avgRank = hits ? rows.filter((row) => row.rank).reduce((sum, row) => sum + row.rank, 0) / hits : null;
  return { pack: pack.name, total: rows.length, hits, misses: rows.length - hits, avg_rank: avgRank, rows };
}

export async function tuneEval(vaultPath, packName = null, params = {}) {
  return evaluateTunePack(await prepareSearchContext(vaultPath), await resolveTunePack(vaultPath, packName), params);
}

function tuneLoss(evaluation) {
  return evaluation.misses * 100 + (evaluation.avg_rank ?? 99);
}

export async function tuneAnalyze(vaultPath, options = {}) {
  const packName = options.packName ?? null;
  const pack = await resolveTunePack(vaultPath, packName);
  const searchContext = await prepareSearchContext(vaultPath);
  const thresholds = (options.thresholds ?? [0, 0.1, 0.2, 0.3, 0.4, 0.5])
    .map(Number)
    .filter((value, index, values) => Number.isFinite(value) && values.indexOf(value) === index)
    .sort((a, b) => a - b);
  const thresholdRows = [];
  for (const threshold of thresholds) {
    const evaluation = await evaluateTunePack(searchContext, pack, { threshold, cap: options.cap });
    thresholdRows.push({
      threshold,
      hits: evaluation.hits,
      misses: evaluation.misses,
      avg_rank: evaluation.avg_rank,
      loss: tuneLoss(evaluation)
    });
  }
  const targetScores = [];
  for (const item of pack.queries) {
    const result = await searchWithContext(searchContext, item.query, { threshold: 0, maxResults: options.maxResults ?? 50, showAll: true });
    const index = result.results.findIndex((hit) => sameNoteName(hit.note, item.target));
    const hit = index >= 0 ? result.results[index] : null;
    targetScores.push({
      query: item.query,
      target: item.target,
      rank: hit ? index + 1 : null,
      score: hit?.score ?? null
    });
  }
  const scoredHits = targetScores.map((item) => item.score).filter((value) => value !== null);
  const suggestedThreshold = scoredHits.length ? Number(Math.max(0, Math.min(...scoredHits) - 0.0001).toFixed(4)) : null;
  const best = [...thresholdRows].sort((a, b) => a.loss - b.loss || a.threshold - b.threshold)[0] ?? null;
  return {
    pack: pack.name,
    thresholds: thresholdRows,
    target_scores: targetScores,
    suggested_threshold: suggestedThreshold,
    best_threshold: best?.threshold ?? null
  };
}

export async function tuneReplay(vaultPath, options = {}) {
  const source = options.file ?? ".ipa/tune/history.jsonl";
  const path = tuneSourcePath(vaultPath, source);
  if (!existsSync(path)) throw new Error(`tune replay source not found: ${source}`);
  const trials = await readTuneTrials(path);
  const pack = await resolveTunePack(vaultPath, options.packName ?? null);
  const searchContext = await prepareSearchContext(vaultPath);
  const rows = [];
  for (const trial of trials) {
    const evaluation = await evaluateTunePack(searchContext, pack, trial.params ?? {});
    const loss = tuneLoss(evaluation);
    rows.push({
      trial: trial.trial ?? rows.length,
      previous_loss: trial.loss ?? null,
      loss,
      changed: trial.loss !== undefined ? Number(trial.loss) !== Number(loss) : null,
      hits: evaluation.hits,
      misses: evaluation.misses,
      avg_rank: evaluation.avg_rank
    });
  }
  return {
    source: toPosix(relative(vaultPath, path)),
    replayed: rows.length,
    changed: rows.filter((row) => row.changed).length,
    rows
  };
}

function tuneSourcePath(vaultPath, source) {
  if (String(source).startsWith("/") || String(source).startsWith(".ipa/")) return resolve(vaultPath, source);
  if (String(source).endsWith(".json") || String(source).endsWith(".jsonl")) {
    const direct = resolve(vaultPath, source);
    if (existsSync(direct)) return direct;
  }
  return tuneResultPath(vaultPath, source);
}

async function readTuneTrials(path) {
  const text = await readFile(path, "utf8");
  if (path.endsWith(".jsonl")) {
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
  const payload = JSON.parse(text);
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.history)) return payload.history;
  if (payload.best) return [payload.best];
  return [payload];
}

function configuredTestsetPath(vaultPath, requested = null) {
  if (requested) {
    if (String(requested).startsWith("/") || String(requested).startsWith(".ipa/")) return resolve(vaultPath, requested);
    return resolve(vaultPath, ".ipa", "tune", "testsets", requested);
  }
  return null;
}

async function activeTestsetPath(vaultPath, requested = null) {
  const explicit = configuredTestsetPath(vaultPath, requested);
  if (explicit) return explicit;
  const { config } = await readVaultConfig(vaultPath);
  if (config.test?.file) return resolve(vaultPath, config.test.file);
  return resolve(vaultPath, ".ipa", "tune", "testsets", "testset.json");
}

function normalizeTestsetPayload(payload) {
  const cases = payload.cases ?? payload.queries ?? [];
  return Array.isArray(cases) ? cases : [];
}

export async function tuneTestsetList(vaultPath) {
  const dir = join(vaultPath, ".ipa", "tune", "testsets");
  const files = existsSync(dir) ? (await readdir(dir)).filter((name) => name.endsWith(".json")).sort() : [];
  const { config } = await readVaultConfig(vaultPath);
  return {
    active: config.test?.file ?? null,
    testsets: files.map((file) => `.ipa/tune/testsets/${file}`)
  };
}

export async function tuneTestsetShow(vaultPath, file = null) {
  const path = await activeTestsetPath(vaultPath, file);
  if (!existsSync(path)) throw new Error(`testset not found: ${toPosix(relative(vaultPath, path))}`);
  const payload = JSON.parse(await readFile(path, "utf8"));
  const cases = normalizeTestsetPayload(payload);
  const rows = [];
  for (const item of cases) {
    const queries = Array.isArray(item.queries) ? item.queries : [item.query].filter(Boolean);
    rows.push({
      target: item.target_filename ?? item.target ?? item.note ?? item.expected ?? null,
      queries
    });
  }
  return {
    file: toPosix(relative(vaultPath, path)),
    cases: rows.length,
    queries: rows.reduce((sum, item) => sum + item.queries.length, 0),
    rows
  };
}

export async function tuneTestsetValidate(vaultPath, file = null) {
  const path = await activeTestsetPath(vaultPath, file);
  const issues = [];
  if (!existsSync(path)) {
    return { file: toPosix(relative(vaultPath, path)), status: "error", issues: [{ severity: "error", code: "testset.missing", message: "testset file does not exist" }] };
  }
  let payload;
  try {
    payload = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    return { file: toPosix(relative(vaultPath, path)), status: "error", issues: [{ severity: "error", code: "testset.json", message: error.message }] };
  }
  const cases = normalizeTestsetPayload(payload);
  const notes = await loadNotes(vaultPath, (await readVaultConfig(vaultPath)).mapping);
  cases.forEach((item, index) => {
    const queries = Array.isArray(item.queries) ? item.queries : [item.query].filter(Boolean);
    const target = item.target_filename ?? item.target ?? item.note ?? item.expected;
    if (!queries.length) issues.push({ severity: "error", code: "testset.query", case: index, message: "case must include query or queries" });
    if (!target) issues.push({ severity: "error", code: "testset.target", case: index, message: "case must include target_filename, target, note, or expected" });
    else if (!findNote(notes, target)) issues.push({ severity: "warn", code: "testset.target_missing", case: index, target, message: `target note not found: ${target}` });
  });
  return {
    file: toPosix(relative(vaultPath, path)),
    status: issues.some((item) => item.severity === "error") ? "error" : "ok",
    cases: cases.length,
    issues
  };
}

export async function tuneTestsetAdd(vaultPath, options = {}) {
  if (!options.query) throw new Error("tune testset add requires --query");
  if (!options.target) throw new Error("tune testset add requires --target");
  const path = await activeTestsetPath(vaultPath, options.file ?? null);
  await mkdir(dirname(path), { recursive: true });
  const payload = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : { cases: [] };
  payload.cases = normalizeTestsetPayload(payload);
  payload.cases.push({ queries: [options.query], target_filename: options.target });
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
  const { config } = await readVaultConfig(vaultPath);
  if (!config.test?.file) {
    const configPath = join(vaultPath, ".ipa", "config.yaml");
    config.test = config.test || {};
    config.test.file = toPosix(relative(vaultPath, path));
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, dumpYaml(config) + "\n", "utf8");
  }
  return {
    file: toPosix(relative(vaultPath, path)),
    added: { query: options.query, target: options.target },
    cases: payload.cases.length
  };
}

export async function tuneTestsetDraft(vaultPath, options = {}) {
  const log = await tuneLog(vaultPath);
  const cases = [];
  for (const event of log.events) {
    const query = event.query ?? event.q ?? event.user_utterance;
    const target = event.target ?? event.note ?? event.selected ?? event.clicked;
    if (query && target) cases.push({ queries: [String(query)], target_filename: String(target) });
  }
  const payload = { cases };
  let file = null;
  if (options.file) {
    const path = await activeTestsetPath(vaultPath, options.file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
    file = toPosix(relative(vaultPath, path));
  }
  return {
    events: log.events.length,
    cases: cases.length,
    file,
    rows: cases
  };
}

export async function tuneLabel(vaultPath, options = {}) {
  const path = join(vaultPath, ".ipa", "tune", "logs", "labels.jsonl");
  await mkdir(dirname(path), { recursive: true });
  if (options.query && options.target) {
    const row = {
      created_at: nowIso(),
      query: options.query,
      target: options.target,
      hit: options.hit ?? true
    };
    await writeFile(path, `${existsSync(path) ? await readFile(path, "utf8") : ""}${JSON.stringify(row)}\n`, "utf8");
  }
  const labels = existsSync(path)
    ? (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { labels, count: labels.length };
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
  const startedAt = Date.now();
  const pack = await resolveTunePack(vaultPath, options.packName ?? null);
  const searchContext = await prepareSearchContext(vaultPath);
  const startupTrials = Math.max(1, Math.min(30, Math.floor(trials / 4) || 1));
  for (let i = 0; i < trials; i += 1) {
    const params = i < startupTrials ? randomTuneParams(rng) : sampleTpeLite(history, rng);
    const evaluation = await evaluateTunePack(searchContext, pack, params);
    const loss = evaluation.misses * 100 + (evaluation.avg_rank ?? 99);
    const trial = { trial: i, optimizer: "tpe-lite", params, loss, metrics: evaluation };
    history.push(trial);
    if (!best || loss < best.loss) best = trial;
    const completed = i + 1;
    const elapsedMs = Date.now() - startedAt;
    const rate = elapsedMs > 0 ? completed / (elapsedMs / 1000) : 0;
    options.onProgress?.({
      completed,
      trials,
      trial: i,
      loss,
      best_loss: best.loss,
      best_trial: best.trial,
      hits: evaluation.hits,
      misses: evaluation.misses,
      elapsed_ms: elapsedMs,
      eta_ms: rate > 0 ? Math.round((trials - completed) / rate * 1000) : null
    });
  }
  const elapsedMs = Date.now() - startedAt;
  const result = { optimizer: "tpe-lite", trials, pack: pack.name, best, history, elapsed_ms: elapsedMs };
  const dir = join(vaultPath, ".ipa", "tune", "results");
  await mkdir(dir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(join(dir, name), JSON.stringify(result, null, 2), "utf8");
  const historyPath = join(vaultPath, ".ipa", "tune", "history.jsonl");
  await writeFile(historyPath, history.map((trial) => JSON.stringify(trial)).join("\n") + "\n", "utf8");
  const resultFile = `.ipa/tune/results/${name}`;
  const active = options.apply ? await tuneUse(vaultPath, resultFile) : null;
  return { ...result, result_file: resultFile, active: active?.active ?? null };
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

function harnessRoot(vaultPath) {
  return join(vaultPath, ".ipa", "harness");
}

const HARNESS_MARKER = "IPA_HARNESS_MANAGED";
const HARNESS_MANAGED_BLOCK = "ipa-harness";

function normalizeHarnessTarget(target = "codex") {
  const value = String(target || "codex").trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(value)) throw new Error(`invalid harness target: ${target}`);
  return value;
}

function harnessHomeBase(options = {}) {
  return resolve(options.homeDir ?? process.env.IPA_HARNESS_HOME ?? homedir());
}

function harnessTargetSpec(target = "codex", options = {}) {
  const name = normalizeHarnessTarget(target);
  if (!["codex", "claude"].includes(name)) {
    throw new Error(`unsupported harness target: ${name}. Expected codex or claude`);
  }
  const home = join(harnessHomeBase(options), name === "claude" ? ".claude" : ".codex");
  return {
    name,
    home,
    skillFile: join(home, "skills", "ipa", "SKILL.md"),
    hooksDir: join(home, "hooks"),
    hooksConfig: name === "claude" ? join(home, "settings.json") : join(home, "hooks.json"),
    localPrompt: name === "claude" ? "CLAUDE.md" : "AGENTS.md"
  };
}

function profileRegistryDisplay() {
  return process.env.XDG_CONFIG_HOME ? "$XDG_CONFIG_HOME/ipa/profile.yaml" : "~/.config/ipa/profile.yaml";
}

function commandPrefix(vaultPath, options = {}, local = false) {
  return "ipa";
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function readJsonObject(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to parse ${path}: ${error.message}`);
  }
}

async function writeJsonObject(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function hookCommand(path) {
  return `node ${shellQuote(path)}`;
}

function hookHasCommand(config, event, command) {
  return (config.hooks?.[event] ?? []).some((group) =>
    (group.hooks ?? []).some((hook) => hook.command === command)
  );
}

function addHookCommand(config, event, matcher, command, statusMessage, timeout = null) {
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

function removeHookCommand(config, command) {
  if (!config.hooks) return;
  for (const event of Object.keys(config.hooks)) {
    config.hooks[event] = (config.hooks[event] ?? [])
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => hook.command !== command) }))
      .filter((group) => group.hooks.length);
    if (!config.hooks[event].length) delete config.hooks[event];
  }
}

async function writeManagedFile(path, content, files) {
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const previous = await readFile(path, "utf8");
    if (previous === content) {
      files.push(path);
      return;
    }
    if (!previous.includes(HARNESS_MARKER)) {
      const stamp = nowIso().replace(/[:.]/g, "-");
      await writeFile(`${path}.bak-${stamp}`, previous, "utf8");
    }
  }
  await writeFile(path, content, "utf8");
  files.push(path);
}

async function removeManagedFile(path, removed) {
  if (!existsSync(path)) return;
  const text = await readFile(path, "utf8");
  if (!text.includes(HARNESS_MARKER)) return;
  await rm(path, { force: true });
  removed.push(path);
}

async function upsertManagedBlock(path, body) {
  const begin = `<!-- ${HARNESS_MARKER}_BEGIN:${HARNESS_MANAGED_BLOCK} -->`;
  const end = `<!-- ${HARNESS_MARKER}_END:${HARNESS_MANAGED_BLOCK} -->`;
  const block = `${begin}\n${body.trim()}\n${end}`;
  const previous = existsSync(path) ? await readFile(path, "utf8") : "";
  const pattern = new RegExp(`${begin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  const next = pattern.test(previous)
    ? previous.replace(pattern, block)
    : [previous.trimEnd(), block].filter(Boolean).join("\n\n") + "\n";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");
}

async function removeManagedBlock(path) {
  if (!existsSync(path)) return false;
  const begin = `<!-- ${HARNESS_MARKER}_BEGIN:${HARNESS_MANAGED_BLOCK} -->`;
  const end = `<!-- ${HARNESS_MARKER}_END:${HARNESS_MANAGED_BLOCK} -->`;
  const previous = await readFile(path, "utf8");
  const pattern = new RegExp(`\\n?${begin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`);
  if (!pattern.test(previous)) return false;
  await writeFile(path, previous.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n", "utf8");
  return true;
}

function harnessSkillContent(vaultPath, spec, options = {}) {
  const prefix = commandPrefix(vaultPath, options);
  return `---
name: ipa
description: Use the IPA CLI to search, view, validate, format, and safely write IPA vault notes.
---

<!-- ${HARNESS_MARKER} -->

# IPA CLI Skill

Use this skill when a task mentions IPA, a vault note, inbox capture, note search, note validation, or note formatting.

## Active Vault

- Target: ${spec.name}
- Vault: ${vaultPath}
- Profile registry: ${profileRegistryDisplay()}
- Vault config: .ipa/config.yaml

## Read First

\`\`\`bash
${prefix} search "keyword"
${prefix} view "Note Title" --full
${prefix} traversal --up "Note Title"
\`\`\`

Search before answering IPA/vault questions. If search returns a relevant note, inspect it with \`view --full\` before relying on memory.

## Safe Writes

New Markdown notes belong in the configured inbox. Prefer:

\`\`\`bash
${prefix} inbox add ./draft.md --title "Title" --ref "Index Note" --tag "topic"
\`\`\`

After editing vault Markdown, run validation and formatting checks:

\`\`\`bash
${prefix} validator
${prefix} formatter plan --note "Edited Note"
${prefix} formatter apply --note "Edited Note"
\`\`\`

For multiple edited notes, pass the note titles after one \`--note\`, for example:
\`${prefix} formatter plan --note "Note A" "Note B"\`.
`;
}

function localPromptContent(vaultPath, spec, mapping, options = {}) {
  const prefix = commandPrefix(vaultPath, options, true);
  return `## IPA CLI Harness

This vault has an IPA CLI harness installed for ${spec.name}.

- Profile registry: ${profileRegistryDisplay()}
- Vault config: .ipa/config.yaml
- Inbox folder: ${mapping.inbox_dir}
- Project folder: ${mapping.project_dir}
- Archive folder: ${mapping.archive_dir}

Use the IPA CLI for vault-aware operations:

\`\`\`bash
${prefix} search "keyword"
${prefix} view "Note Title" --full
${prefix} validator
${prefix} formatter plan --note "Edited Note"
\`\`\`

Create new Markdown notes under the configured inbox, or import drafts with \`${prefix} inbox add <file>\`. Existing Markdown notes may be edited in place. After editing vault Markdown, run lint/validation and note-scoped formatter planning before finishing. Formatter commands accept multiple notes as \`${prefix} formatter plan --note "Note A" "Note B"\`.
`;
}

function inboxGuardScript(vaultPath, inboxDir) {
  return `#!/usr/bin/env node
// ${HARNESS_MARKER}: shared IPA inbox creation guard.
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const vaultPath = ${JSON.stringify(vaultPath)};
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
  return action !== "create" || rel === inbox || rel.startsWith(inbox + "/");
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

function userPromptNudgeScript(vaultPath, options = {}) {
  return `#!/usr/bin/env node
// ${HARNESS_MARKER}: IPA UserPromptSubmit context nudge.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const vaultPath = ${JSON.stringify(vaultPath)};
const prefix = "ipa";

function inputJson() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

const input = inputJson();
const prompt = String(input.prompt ?? input.user_prompt ?? "").trim();
const lines = [
  "[IPA CLI]",
  "Use plain ipa commands; project-local .ipa-profile/.ipa-config can select the vault.",
  "Before answering IPA/vault questions, search the vault and view relevant notes.",
  \`Search: \${prefix} search "keyword"\`,
  \`View:   \${prefix} view "Note Title" --full\`
];

if (prompt.length >= 8) {
  const result = spawnSync("ipa", ["--vault", vaultPath, "search", prompt.slice(0, 120), "--json", "--max", "5"], {
    encoding: "utf8",
    timeout: 4000
  });
  if (result.status === 0 && result.stdout) {
    try {
      const parsed = JSON.parse(result.stdout);
      const hits = (parsed.results || []).slice(0, 5).map((item) => \`- \${item.note} (\${Number(item.score || 0).toFixed(2)})\`);
      if (hits.length) lines.push("", "Possible related notes:", ...hits);
    } catch {
      // Ignore malformed search output.
    }
  }
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: lines.join("\\n")
  }
}) + "\\n");
`;
}

function markdownWriteNudgeScript(vaultPath, options = {}) {
  return `#!/usr/bin/env node
// ${HARNESS_MARKER}: prompt nudge after IPA vault Markdown edits.
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const vaultPath = ${JSON.stringify(vaultPath)};
const prefix = "ipa";

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
const filePath = firstString([toolInput.file_path, toolInput.path, input.file_path, input.path]);
if (!filePath) process.exit(0);

const absolute = resolve(input.cwd || process.cwd(), filePath);
const rel = relative(vaultPath, absolute);
if (rel === "" || rel.startsWith("..") || rel.startsWith("/") || !rel.toLowerCase().endsWith(".md")) process.exit(0);

const note = rel.split(sep).join("/");
const noteTitle = note.split("/").pop().replace(/\\.md$/i, "");
const noteArg = JSON.stringify(noteTitle);
const message = [
  \`[IPA CLI] Vault Markdown changed: \${note}\`,
  "Before finishing, lint/validate and run a note-scoped format plan:",
  \`  \${prefix} validator\`,
  \`  \${prefix} formatter plan --note \${noteArg}\`,
  "For multiple edited notes, use one --note followed by the note titles."
].join("\\n");

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    additionalContext: message
  }
}) + "\\n");
`;
}

async function installGlobalHarness(vaultPath, spec, mapping, options = {}) {
  const files = [];
  const guardPath = join(spec.hooksDir, "ipa-inbox-guard.mjs");
  const promptPath = join(spec.hooksDir, "ipa-user-prompt-nudge.mjs");
  const writeNudgePath = join(spec.hooksDir, "ipa-md-write-nudge.mjs");
  await writeManagedFile(spec.skillFile, harnessSkillContent(vaultPath, spec, options), files);
  await writeManagedFile(guardPath, inboxGuardScript(vaultPath, mapping.inbox_dir), files);
  await writeManagedFile(promptPath, userPromptNudgeScript(vaultPath, options), files);
  await writeManagedFile(writeNudgePath, markdownWriteNudgeScript(vaultPath, options), files);

  const config = await readJsonObject(spec.hooksConfig);
  addHookCommand(config, "PreToolUse", "Write|Edit|MultiEdit", hookCommand(guardPath), "Checking IPA inbox write policy...", 5);
  addHookCommand(config, "PostToolUse", "Write|Edit|MultiEdit", hookCommand(writeNudgePath), "Reminding IPA lint/format checks...", 5);
  addHookCommand(config, "UserPromptSubmit", null, hookCommand(promptPath), null, 5);
  await writeJsonObject(spec.hooksConfig, config);
  files.push(spec.hooksConfig);
  return files;
}

async function uninstallGlobalHarness(spec) {
  const removed = [];
  const scripts = [
    join(spec.hooksDir, "ipa-inbox-guard.mjs"),
    join(spec.hooksDir, "ipa-user-prompt-nudge.mjs"),
    join(spec.hooksDir, "ipa-md-write-nudge.mjs")
  ];
  for (const path of [spec.skillFile, ...scripts]) await removeManagedFile(path, removed);
  if (existsSync(spec.hooksConfig)) {
    const config = await readJsonObject(spec.hooksConfig);
    for (const path of scripts) removeHookCommand(config, hookCommand(path));
    await writeJsonObject(spec.hooksConfig, config);
    removed.push(spec.hooksConfig);
  }
  return removed;
}

function hasManagedFile(path) {
  if (!existsSync(path)) return false;
  try {
    return existsSync(path) && readFileSyncText(path).includes(HARNESS_MARKER);
  } catch {
    return false;
  }
}

function readFileSyncText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

async function readHarnessIndex(vaultPath) {
  const path = join(harnessRoot(vaultPath), "manifest.json");
  if (!existsSync(path)) return { version: 1, targets: {} };
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeHarnessIndex(vaultPath, index) {
  const path = join(harnessRoot(vaultPath), "manifest.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(index, null, 2) + "\n", "utf8");
}

export async function harnessStatus(vaultPath, options = {}) {
  const index = await readHarnessIndex(vaultPath);
  const global = {};
  for (const target of Object.keys(index.targets ?? {})) {
    const spec = harnessTargetSpec(target, options);
    global[target] = {
      skill: hasManagedFile(spec.skillFile),
      guard_hook: hasManagedFile(join(spec.hooksDir, "ipa-inbox-guard.mjs")),
      prompt_hook: hasManagedFile(join(spec.hooksDir, "ipa-user-prompt-nudge.mjs")),
      markdown_nudge_hook: hasManagedFile(join(spec.hooksDir, "ipa-md-write-nudge.mjs")),
      hooks_config: existsSync(spec.hooksConfig)
    };
  }
  return {
    status: "ok",
    installed: Object.keys(index.targets ?? {}),
    manifest: existsSync(join(harnessRoot(vaultPath), "manifest.json")) ? ".ipa/harness/manifest.json" : null,
    global,
    guard: await harnessGuardStatus(vaultPath)
  };
}

export async function harnessInstall(vaultPath, target = "codex", options = {}) {
  const spec = harnessTargetSpec(target, options);
  const name = spec.name;
  const { mapping } = await readVaultConfig(vaultPath);
  const root = harnessRoot(vaultPath);
  const dir = join(root, name);
  const manifest = {
    version: 1,
    target: name,
    installed_at: nowIso(),
    scope: ["global", "vault-local"],
    local_prompt: spec.localPrompt,
    global: {
      home: `~/.${name}`,
      skill: `~/.${name}/skills/ipa/SKILL.md`,
      hooks_config: name === "claude" ? "~/.claude/settings.json" : "~/.codex/hooks.json"
    },
    hooks: {
      guard: {
        command: "ipa harness guard check <vault-relative-path>",
        policy: "new markdown files must be created under the configured inbox folder"
      },
      prompt_submit: {
        policy: "nudge the agent to search/view IPA notes before answering vault questions"
      },
      markdown_write_nudge: {
        policy: "nudge the agent to run validator and note-scoped formatter plan after vault Markdown edits"
      }
    }
  };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await writeFile(
    join(dir, "guard.mjs"),
    [
      "#!/usr/bin/env node",
      "import { spawnSync } from 'node:child_process';",
      "const target = process.argv[2] ?? '';",
      "const result = spawnSync('ipa', ['harness', 'guard', 'check', target, '--json'], { stdio: 'inherit' });",
      "process.exit(result.status ?? 1);",
      ""
    ].join("\n"),
    "utf8"
  );
  await upsertManagedBlock(join(vaultPath, spec.localPrompt), localPromptContent(vaultPath, spec, mapping, options));
  const globalFiles = await installGlobalHarness(vaultPath, spec, mapping, options);
  const index = await readHarnessIndex(vaultPath);
  index.targets = index.targets || {};
  index.targets[name] = {
    path: `.ipa/harness/${name}/manifest.json`,
    installed_at: manifest.installed_at,
    local_prompt: spec.localPrompt
  };
  await writeHarnessIndex(vaultPath, index);
  return {
    status: "ok",
    target: name,
    installed: true,
    files: [`.ipa/harness/${name}/manifest.json`, `.ipa/harness/${name}/guard.mjs`, ".ipa/harness/manifest.json", spec.localPrompt],
    global_files: globalFiles
  };
}

export async function harnessUninstall(vaultPath, target = "codex", options = {}) {
  const spec = harnessTargetSpec(target, options);
  const name = spec.name;
  await rm(join(harnessRoot(vaultPath), name), { recursive: true, force: true });
  await removeManagedBlock(join(vaultPath, spec.localPrompt));
  const globalRemoved = await uninstallGlobalHarness(spec);
  const index = await readHarnessIndex(vaultPath);
  if (index.targets) delete index.targets[name];
  await writeHarnessIndex(vaultPath, index);
  return { status: "ok", target: name, installed: false, removed: [`.ipa/harness/${name}`, spec.localPrompt], global_removed: globalRemoved };
}

export async function harnessDoctor(vaultPath, options = {}) {
  const index = await readHarnessIndex(vaultPath);
  const issues = [];
  for (const [target, entry] of Object.entries(index.targets ?? {})) {
    const spec = harnessTargetSpec(target, options);
    if (!existsSync(resolve(vaultPath, entry.path))) {
      issues.push({ severity: "error", code: "harness.manifest_missing", target, message: `missing ${entry.path}` });
    }
    if (!existsSync(join(harnessRoot(vaultPath), target, "guard.mjs"))) {
      issues.push({ severity: "warn", code: "harness.guard_missing", target, message: "guard script is missing" });
    }
    if (!hasManagedFile(spec.skillFile)) {
      issues.push({ severity: "warn", code: "harness.global_skill_missing", target, message: `missing managed IPA skill at ~/.${target}/skills/ipa/SKILL.md` });
    }
    for (const [code, file] of [
      ["harness.global_guard_hook_missing", join(spec.hooksDir, "ipa-inbox-guard.mjs")],
      ["harness.global_prompt_hook_missing", join(spec.hooksDir, "ipa-user-prompt-nudge.mjs")],
      ["harness.global_markdown_nudge_missing", join(spec.hooksDir, "ipa-md-write-nudge.mjs")]
    ]) {
      if (!hasManagedFile(file)) issues.push({ severity: "warn", code, target, message: `missing managed hook ${basename(file)}` });
    }
    if (!existsSync(join(vaultPath, entry.local_prompt ?? spec.localPrompt))) {
      issues.push({ severity: "warn", code: "harness.local_prompt_missing", target, message: `missing ${entry.local_prompt ?? spec.localPrompt}` });
    }
  }
  return {
    status: issues.some((item) => item.severity === "error") ? "error" : "ok",
    installed: Object.keys(index.targets ?? {}),
    issues
  };
}

export async function harnessGuardStatus(vaultPath) {
  const { mapping } = await readVaultConfig(vaultPath);
  return {
    policy: "new_markdown_requires_inbox",
    inbox_dir: mapping.inbox_dir,
    project_dir: mapping.project_dir,
    archive_dir: mapping.archive_dir
  };
}

function isInsideVault(vaultPath, absolutePath) {
  const rel = relative(vaultPath, absolutePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("/"));
}

function pathInFolder(relPath, folder) {
  const rel = toPosix(relPath).replace(/^\/+/, "");
  const dir = toPosix(folder).replace(/^\/+/, "");
  return rel === dir || rel.startsWith(`${dir}/`);
}

export async function harnessGuardCheck(vaultPath, relPath, options = {}) {
  if (!relPath) throw new Error("harness guard check requires a vault-relative path");
  const { mapping } = await readVaultConfig(vaultPath);
  const normalized = toPosix(relPath).replace(/^\/+/, "");
  const absolute = resolve(vaultPath, normalized);
  if (!isInsideVault(vaultPath, absolute)) {
    return { allowed: false, reason: "path escapes vault", path: normalized };
  }
  const action = options.action ?? (existsSync(absolute) ? "edit" : "create");
  if (extname(normalized).toLowerCase() !== ".md") {
    return { allowed: true, reason: "non-markdown file", path: normalized, action };
  }
  if (action !== "create") {
    return { allowed: true, reason: "existing markdown edit", path: normalized, action };
  }
  if (pathInFolder(normalized, mapping.inbox_dir)) {
    return { allowed: true, reason: "new markdown is under inbox", path: normalized, action, inbox_dir: mapping.inbox_dir };
  }
  return {
    allowed: false,
    reason: "new markdown files must be created under the configured inbox folder",
    path: normalized,
    action,
    inbox_dir: mapping.inbox_dir
  };
}

export async function resolveSettings(options = {}) {
  const registry = await readProfileRegistry();
  const localSelection = await readLocalSelection(options.cwd ?? process.cwd());
  if (options.profile && !registry.profiles?.[options.profile]) {
    throw new Error(`unknown profile: ${options.profile}`);
  }
  if (options.vault) return { profile: options.profile ?? null, vaultPath: expandUserPath(options.vault), source: "cli" };
  if (options.profile) {
    return { profile: options.profile, vaultPath: expandUserPath(registry.profiles[options.profile].vault_path), source: "profile" };
  }
  const profileName = options.profile ?? localSelection.profile ?? process.env.IPA_PROFILE;
  if (profileName && !registry.profiles?.[profileName]) {
    throw new Error(`unknown profile: ${profileName}`);
  }
  if (localSelection.vault) return { profile: profileName ?? null, vaultPath: expandUserPath(localSelection.vault), source: localSelection.source };
  if (profileName && registry.profiles?.[profileName]) {
    return { profile: profileName, vaultPath: expandUserPath(registry.profiles[profileName].vault_path), source: profileName === localSelection.profile ? localSelection.source : "profile" };
  }
  if (process.env.IPA_VAULT_PATH) return { profile: profileName ?? null, vaultPath: expandUserPath(process.env.IPA_VAULT_PATH), source: "env" };
  const selected = Object.entries(registry.profiles ?? {}).find(([, item]) => item.default === true)?.[0];
  if (selected) return { profile: selected, vaultPath: expandUserPath(registry.profiles[selected].vault_path), source: "default-profile" };
  throw new Error("vault not resolved. Use --vault, --profile, IPA_PROFILE, or IPA_VAULT_PATH");
}

async function readLocalSelection(startDir) {
  const configPath = findUp(startDir, ".ipa-config");
  if (configPath) {
    const raw = (await readFile(configPath, "utf8")).trim();
    const config = parseYaml(raw);
    const profile = config.profile ? String(config.profile).trim() : null;
    const vault = config.vault_path ?? config.vault ?? null;
    const resolvedVault = vault ? resolveLocalPath(dirname(configPath), vault) : null;
    if (profile || resolvedVault) return { profile, vault: resolvedVault, source: ".ipa-config" };
    if (raw && !raw.includes(":")) return { profile: raw.split(/\r?\n/)[0].trim(), vault: null, source: ".ipa-config" };
  }
  const profilePath = findUp(startDir, ".ipa-profile");
  if (profilePath) {
    const profile = (await readFile(profilePath, "utf8")).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (profile) return { profile, vault: null, source: ".ipa-profile" };
  }
  return { profile: null, vault: null, source: null };
}

function resolveLocalPath(baseDir, value) {
  const text = String(value ?? "").trim();
  if (!text || text === "~" || text.startsWith("~/") || isAbsolute(text)) return text;
  return resolve(baseDir, text);
}

function findUp(startDir, filename) {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function expandUserPath(value) {
  const text = String(value ?? "");
  if (text === "~") return homedir();
  if (text.startsWith("~/")) return join(homedir(), text.slice(2));
  return resolve(text);
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

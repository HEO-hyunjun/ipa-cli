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
  { code: "ipa.frontmatter.required_field", category: "frontmatter", severity: "warn", scope: "note", fixable: true },
  { code: "ipa.frontmatter.date_format", category: "frontmatter", severity: "warn", scope: "note" },
  { code: "ipa.frontmatter.invalid_type", category: "frontmatter", severity: "error", scope: "note" },
  { code: "ipa.frontmatter.missing_ref", category: "frontmatter", severity: "warn", scope: "note" },
  { code: "ipa.inbox.raw_capture", category: "inbox", severity: "warn", scope: "note" },
  { code: "ipa.tag.snake_case", category: "tag", severity: "warn", scope: "note" },
  { code: "ipa.title.root_prefix", category: "title", severity: "warn", scope: "note" },
  { code: "ipa.title.root_suffix", category: "title", severity: "warn", scope: "note" },
  { code: "ipa.title.index_prefix", category: "title", severity: "warn", scope: "note" },
  { code: "ipa.location.type_mismatch", category: "location", severity: "warn", scope: "note" },
  { code: "ipa.link.ref_target_missing", category: "link", severity: "warn", scope: "vault" },
  { code: "ipa.link.wikilink_target_missing", category: "link", severity: "warn", scope: "vault" },
  { code: "ipa.root_folder.duplicate", category: "root_folder", severity: "warn", scope: "vault" },
  { code: "ipa.root_folder.missing", category: "root_folder", severity: "warn", scope: "vault" },
  { code: "ipa.heading.no_h1", category: "heading", severity: "info", scope: "note", fixable: true }
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

function parseHeadings(body, offsetLine = 1) {
  const headings = [];
  let inCodeBlock = false;
  const lines = String(body ?? "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isCodeFence(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) headings.push({ kind: "heading", level: match[1].length, title: match[2].trim(), line: offsetLine + index });
  }
  return headings;
}

function bodyStartLine(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return 1;
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return 1;
  return normalized.slice(0, end + 4).split("\n").length + 1;
}

function isBlankLine(line) {
  return String(line ?? "").trim() === "";
}

function parseCodeBlocks(body, offsetLine = 1, options = {}) {
  const lines = String(body ?? "").split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = lines[i].match(/^(\s*)(```|~~~)\s*([^`~]*)$/);
    if (!open) continue;
    const fence = open[2];
    const info = open[3].trim();
    const language = info.split(/\s+/).filter(Boolean)[0] ?? "";
    const contentStart = i + 1;
    let end = lines.length - 1;
    for (let j = contentStart; j < lines.length; j += 1) {
      if (lines[j].trimStart().startsWith(fence)) {
        end = j;
        break;
      }
    }
    const block = {
      kind: "code",
      language,
      info,
      fence,
      indent: open[1].length,
      startLine: offsetLine + i,
      endLine: offsetLine + end,
      contentStartLine: offsetLine + contentStart,
      contentEndLine: offsetLine + Math.max(contentStart, end) - 1,
      raw: lines.slice(i, end + 1).join("\n"),
      content: lines.slice(contentStart, end).join("\n")
    };
    if (!options.language || block.language === options.language) blocks.push(block);
    i = end;
  }
  return blocks;
}

function parseListBlocks(body, offsetLine = 1) {
  const lines = String(body ?? "").split("\n");
  const blocks = [];
  let inCodeBlock = false;
  let current = null;
  const close = (endIndex) => {
    if (!current) return;
    current.endLine = offsetLine + endIndex;
    current.raw = lines.slice(current.startIndex, endIndex + 1).join("\n");
    current.blankAfter = endIndex + 1 >= lines.length ? true : isBlankLine(lines[endIndex + 1]);
    delete current.startIndex;
    blocks.push(current);
    current = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isCodeFence(line)) {
      if (current) close(i - 1);
      inCodeBlock = !inCodeBlock;
      continue;
    }
    const match = !inCodeBlock ? line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/) : null;
    if (!match) {
      if (current) close(i - 1);
      continue;
    }
    if (!current) {
      current = {
        kind: "list",
        startIndex: i,
        startLine: offsetLine + i,
        endLine: offsetLine + i,
        blankBefore: i === 0 ? true : isBlankLine(lines[i - 1]),
        blankAfter: true,
        items: []
      };
    }
    current.items.push({
      line: offsetLine + i,
      indent: match[1].length,
      marker: match[2],
      text: match[3]
    });
  }
  if (current) close(lines.length - 1);
  return blocks;
}

function parseCallouts(body, offsetLine = 1) {
  const lines = String(body ?? "").split("\n");
  const callouts = [];
  let inCodeBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isCodeFence(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const match = line.match(/^>\s*\[!(\w+)\]([+-]?)\s*(.*)$/);
    if (!match) continue;
    let end = i;
    while (end + 1 < lines.length && lines[end + 1].startsWith(">")) end += 1;
    const rawLines = lines.slice(i, end + 1);
    const quoteLines = rawLines.map((item) => item.replace(/^>\s?/, ""));
    callouts.push({
      kind: "callout",
      type: match[1].toLowerCase(),
      title: match[3].trim(),
      folded: match[2] === "+" || match[2] === "-",
      collapsed: match[2] === "-",
      startLine: offsetLine + i,
      endLine: offsetLine + end,
      raw: rawLines.join("\n"),
      content: quoteLines.slice(1).join("\n"),
      quoteLines
    });
    i = end;
  }
  return callouts;
}

function parseVaultLinks(body, offsetLine = 1) {
  const links = [];
  let inCodeBlock = false;
  const lines = String(body ?? "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isCodeFence(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const re = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
    let match;
    while ((match = re.exec(line))) {
      const embed = line[match.index - 1] === "!";
      links.push({
        kind: "vault",
        raw: embed ? `!${match[0]}` : match[0],
        target: normalizeTitle(match[1]),
        heading: match[2] ? normalizeTitle(match[2]) : "",
        alias: match[3] ? normalizeTitle(match[3]) : "",
        embed,
        line: offsetLine + index,
        column: embed ? match.index : match.index + 1
      });
    }
  }
  return links;
}

function parseExternalLinks(body, offsetLine = 1) {
  const links = [];
  let inCodeBlock = false;
  const lines = String(body ?? "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isCodeFence(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const re = /\bhttps?:\/\/[^\s<>)\]]+/g;
    let match;
    while ((match = re.exec(line))) {
      links.push({
        kind: "external",
        url: match[0].replace(/[.,;:!?]+$/, ""),
        raw: match[0],
        line: offsetLine + index,
        column: match.index + 1
      });
    }
  }
  return links;
}

function parseEmbeds(body, offsetLine = 1) {
  return parseVaultLinks(body, offsetLine)
    .filter((link) => link.embed)
    .map((link) => ({ ...link, kind: "embed" }));
}

function parseInlineTags(body, offsetLine = 1) {
  const tags = [];
  let inCodeBlock = false;
  const lines = String(body ?? "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isCodeFence(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock || /^#{1,6}\s+/.test(line)) continue;
    const re = /(^|[\s([{])#([A-Za-z0-9_/-]+)/g;
    let match;
    while ((match = re.exec(line))) {
      tags.push({
        kind: "tag",
        tag: match[2],
        raw: `#${match[2]}`,
        line: offsetLine + index,
        column: match.index + match[1].length + 1
      });
    }
  }
  return tags;
}

function parseTaskItems(body, offsetLine = 1) {
  return parseListBlocks(body, offsetLine).flatMap((block) =>
    block.items
      .map((item) => {
        const match = item.text.match(/^\[([ xX-])\]\s*(.*)$/);
        if (!match) return null;
        return {
          kind: "task",
          line: item.line,
          indent: item.indent,
          marker: item.marker,
          checked: match[1].toLowerCase() === "x",
          status: match[1],
          text: match[2]
        };
      })
      .filter(Boolean)
  );
}

function parseBlockquotes(body, offsetLine = 1) {
  const lines = String(body ?? "").split("\n");
  const blocks = [];
  let inCodeBlock = false;
  let start = null;
  const close = (end) => {
    if (start === null) return;
    const rawLines = lines.slice(start, end + 1);
    blocks.push({
      kind: "blockquote",
      startLine: offsetLine + start,
      endLine: offsetLine + end,
      raw: rawLines.join("\n"),
      content: rawLines.map((line) => line.replace(/^>\s?/, "")).join("\n")
    });
    start = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isCodeFence(line)) {
      close(index - 1);
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (!inCodeBlock && /^>\s*\[!\w+\]/.test(line)) {
      close(index - 1);
      while (index + 1 < lines.length && lines[index + 1].startsWith(">")) index += 1;
      continue;
    }
    if (!inCodeBlock && line.startsWith(">") && !/^>\s*\[!\w+\]/.test(line)) {
      if (start === null) start = index;
    } else {
      close(index - 1);
    }
  }
  close(lines.length - 1);
  return blocks;
}

function parseMathBlocks(body, offsetLine = 1) {
  const lines = String(body ?? "").split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "$$") continue;
    let end = lines.length - 1;
    for (let j = index + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === "$$") {
        end = j;
        break;
      }
    }
    blocks.push({
      kind: "math",
      startLine: offsetLine + index,
      endLine: offsetLine + end,
      content: lines.slice(index + 1, end).join("\n"),
      raw: lines.slice(index, end + 1).join("\n")
    });
    index = end;
  }
  return blocks;
}

function parseTables(body, offsetLine = 1) {
  const lines = String(body ?? "").split("\n");
  const tables = [];
  let inCodeBlock = false;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index];
    if (isCodeFence(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock || !line.includes("|")) continue;
    const separator = lines[index + 1];
    if (!/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator)) continue;
    let end = index + 1;
    while (end + 1 < lines.length && lines[end + 1].includes("|") && !isBlankLine(lines[end + 1])) end += 1;
    const splitRow = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    tables.push({
      kind: "table",
      startLine: offsetLine + index,
      endLine: offsetLine + end,
      raw: lines.slice(index, end + 1).join("\n"),
      headers: splitRow(line),
      rows: lines.slice(index + 2, end + 1).map(splitRow)
    });
    index = end;
  }
  return tables;
}

export class MarkdownDocument {
  constructor(text = "") {
    this.text = String(text ?? "").replace(/\r\n/g, "\n");
    const parsed = readFrontmatter(this.text);
    this.frontmatter = parsed.frontmatter;
    this.body = parsed.body;
    this.bodyStartLine = bodyStartLine(this.text);
  }

  get hasFrontmatter() {
    return hasFrontmatterBlock(this.text);
  }

  headings() {
    return parseHeadings(this.body, this.bodyStartLine);
  }

  h1Headings() {
    return this.headings().filter((heading) => heading.level === 1);
  }

  hasH1() {
    return this.h1Headings().length > 0;
  }

  wikilinks() {
    return extractWikilinks(this.body);
  }

  frontmatterEntries() {
    return Object.entries(this.frontmatter).map(([key, value]) => ({ key, value }));
  }

  frontmatterField(key) {
    return this.frontmatter[key];
  }

  codeBlocks(options = {}) {
    return parseCodeBlocks(this.body, this.bodyStartLine, options);
  }

  mermaidBlocks() {
    return this.codeBlocks({ language: "mermaid" });
  }

  listBlocks() {
    return parseListBlocks(this.body, this.bodyStartLine);
  }

  taskItems() {
    return parseTaskItems(this.body, this.bodyStartLine);
  }

  callouts() {
    return parseCallouts(this.body, this.bodyStartLine);
  }

  blockquotes() {
    return parseBlockquotes(this.body, this.bodyStartLine);
  }

  mathBlocks() {
    return parseMathBlocks(this.body, this.bodyStartLine);
  }

  tables() {
    return parseTables(this.body, this.bodyStartLine);
  }

  vaultLinks() {
    return parseVaultLinks(this.body, this.bodyStartLine);
  }

  embeds() {
    return parseEmbeds(this.body, this.bodyStartLine);
  }

  externalLinks() {
    return parseExternalLinks(this.body, this.bodyStartLine);
  }

  inlineTags() {
    return parseInlineTags(this.body, this.bodyStartLine);
  }

  links() {
    return [...this.vaultLinks(), ...this.externalLinks()].sort((a, b) => a.line - b.line || a.column - b.column);
  }

  blocks() {
    return [
      ...this.headings(),
      ...this.codeBlocks(),
      ...this.listBlocks(),
      ...this.callouts(),
      ...this.blockquotes(),
      ...this.mathBlocks(),
      ...this.tables()
    ].sort((a, b) => (a.startLine ?? a.line) - (b.startLine ?? b.line));
  }

  sections() {
    const headings = this.headings();
    const bodyLines = this.body.split("\n");
    return headings.map((heading) => {
      const headingIndex = heading.line - this.bodyStartLine;
      const next = headings.find((candidate) => candidate.line > heading.line && candidate.level <= heading.level);
      const endIndex = next ? next.line - this.bodyStartLine - 1 : bodyLines.length - 1;
      const contentStartIndex = headingIndex + 1;
      const content = bodyLines.slice(contentStartIndex, endIndex + 1).join("\n");
      const contentStartLine = heading.line + 1;
      return {
        kind: "section",
        title: heading.title,
        level: heading.level,
        startLine: heading.line,
        contentStartLine,
        endLine: this.bodyStartLine + endIndex,
        content,
        blankAfterHeading: contentStartIndex >= bodyLines.length ? true : isBlankLine(bodyLines[contentStartIndex]),
        headings: parseHeadings(content, contentStartLine),
        codeBlocks: parseCodeBlocks(content, contentStartLine),
        listBlocks: parseListBlocks(content, contentStartLine),
        taskItems: parseTaskItems(content, contentStartLine),
        callouts: parseCallouts(content, contentStartLine),
        blockquotes: parseBlockquotes(content, contentStartLine),
        vaultLinks: parseVaultLinks(content, contentStartLine),
        externalLinks: parseExternalLinks(content, contentStartLine)
      };
    });
  }

  section(title) {
    const normalized = normalizeTitle(title);
    return this.sections().find((section) => sameNoteName(section.title, normalized)) ?? null;
  }

  withBody(body) {
    return replaceBody(this.text, body);
  }

  withFrontmatterField(key, value) {
    return insertFrontmatterField(this.text, key, value);
  }

  removeH1Matching(title) {
    return removeDuplicateH1(this.text, title);
  }
}

export class IpaNoteDocument extends MarkdownDocument {
  constructor(note, mapping = DEFAULT_MAPPING) {
    super(note.raw);
    this.note = note;
    this.mapping = mapping;
  }

  static fromNote(note, mapping = DEFAULT_MAPPING) {
    return new IpaNoteDocument(note, mapping);
  }

  get id() {
    return this.note.id;
  }

  get path() {
    return this.note.path;
  }

  get relPath() {
    return this.note.relPath;
  }

  get folder() {
    return this.note.folder;
  }

  get type() {
    return this.frontmatter[this.mapping.note_type] || "";
  }

  get refs() {
    return asList(this.frontmatter[this.mapping.refs]).map(stripWiki).filter(Boolean);
  }

  get tags() {
    return asList(this.frontmatter[this.mapping.tags]).map((tag) => String(tag).replace(/^#/, ""));
  }

  get aliases() {
    return this.mapping.aliases ? asList(this.frontmatter[this.mapping.aliases]).map(normalizeTitle) : [];
  }

  hasDuplicateTitleH1() {
    return this.h1Headings().some((heading) => sameNoteName(heading.title, this.id));
  }

  withoutDuplicateTitleH1() {
    return this.removeH1Matching(this.id);
  }
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

function jamoTrigrams(text) {
  const chars = Array.from(String(text ?? "").toLowerCase().normalize("NFD"));
  if (chars.length < 3) return [];
  const out = [];
  for (let i = 0; i <= chars.length - 3; i += 1) {
    out.push(chars.slice(i, i + 3).join(""));
  }
  return out;
}

function fuzzyNameScore(queryLower, name) {
  if (!queryLower) return 0;
  const rawName = String(name ?? "");
  const lower = rawName.toLowerCase();
  if (lower === queryLower) return 1;
  if (lower.includes(queryLower)) return 1;
  const noSpace = queryLower.replace(/\s+/g, "");
  if (noSpace && lower.replace(/\s+/g, "").includes(noSpace)) return 1;
  const queryTrigrams = new Set(jamoTrigrams(queryLower));
  if (queryTrigrams.size) {
    const nameTrigrams = new Set(jamoTrigrams(name));
    if (nameTrigrams.size) {
      let overlap = 0;
      for (const item of queryTrigrams) {
        if (nameTrigrams.has(item)) overlap += 1;
      }
      const score = overlap / queryTrigrams.size;
      if (score >= 0.4) return score;
    }
  }
  return subsequenceScore(queryLower, name);
}

function buildBm25Index(notes) {
  const corpus = notes.map((note) => ({
    note,
    tokens: jamoTrigrams(note.body ? `${note.id}\n${note.body}` : note.id)
  }));
  const termToIndex = new Map();
  for (const doc of corpus) {
    for (const token of doc.tokens) {
      if (!termToIndex.has(token)) termToIndex.set(token, termToIndex.size);
    }
  }
  const docTf = [];
  const docLen = [];
  for (const doc of corpus) {
    const tf = new Map();
    for (const token of doc.tokens) {
      const index = termToIndex.get(token);
      tf.set(index, (tf.get(index) ?? 0) + 1);
    }
    docTf.push(tf);
    docLen.push(doc.tokens.length);
  }
  const docFreq = new Map();
  for (const tf of docTf) {
    for (const index of tf.keys()) docFreq.set(index, (docFreq.get(index) ?? 0) + 1);
  }
  const nDocs = corpus.length;
  const avgdl = docLen.reduce((sum, value) => sum + value, 0) / Math.max(nDocs, 1);
  const idf = new Map();
  for (const [index, count] of docFreq.entries()) {
    idf.set(index, Math.log(1 + (nDocs - count + 0.5) / (count + 0.5)));
  }
  return { termToIndex, docTf, docLen, avgdl, idf, nDocs, k1: 1.5, b: 0.75 };
}

function bm25Score(index, queryTokens, docIndex) {
  const tf = index.docTf[docIndex];
  if (!tf) return 0;
  const dl = index.docLen[docIndex] ?? 0;
  let score = 0;
  for (const token of queryTokens) {
    const tokenIndex = index.termToIndex.get(token);
    if (tokenIndex === undefined) continue;
    const frequency = tf.get(tokenIndex);
    if (!frequency) continue;
    const idf = index.idf.get(tokenIndex) ?? 0;
    const denom = frequency + index.k1 * (1 - index.b + index.b * dl / Math.max(index.avgdl, 1));
    score += idf * frequency * (index.k1 + 1) / Math.max(denom, 1e-9);
  }
  return score;
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

  const fuzzy = lower ? Math.max(0, ...searchNames.map((name) => fuzzyNameScore(lower, name))) : 0;
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
  const childBody = note.type === "index" || note.type === "root" || note.id.startsWith("🔖")
    ? Math.max(0, ...notes
      .filter((candidate) => candidate.type !== "index" && candidate.type !== "root" && !candidate.id.startsWith("🔖"))
      .filter((candidate) => hasNoteName(candidate.refs, note.id))
      .map((candidate) => {
        const candidateBody = searchableTitle(candidate.body).toLowerCase();
        return tokens.length ? tokens.filter((token) => candidateBody.includes(token)).length / tokens.length : 0;
      }))
    : 0;
  channelScores.child_body_match = childBody;
  if (childBody) reasons.child_body_match = { coverage: childBody };

  const hasSearchSignal = Object.entries(channelScores).some(([key, value]) => key !== "project" && value > 0);
  const hasProjectContext = note.folder === projectDir ||
    note.folder.startsWith(`${projectDir}/`) ||
    note.refs.some((ref) => {
      const target = findNote(notes, ref);
      return target && (target.folder === projectDir || target.folder.startsWith(`${projectDir}/`));
    });
  channelScores.project = hasSearchSignal && hasProjectContext ? 1 : 0;
  if (channelScores.project) reasons.project = { context: true };

  let score = 0;
  for (const channel of CHANNELS) {
    const weight = weights[channel.name] ?? channel.defaultWeight;
    score += (channelScores[channel.name] ?? 0) * weight;
  }
  return { score, reasons, channelScores };
}

function prepareSearchNotes(notes, mapping = DEFAULT_MAPPING) {
  const projectDir = mapping.project_dir ?? DEFAULT_MAPPING.project_dir;
  const noteById = new Map(notes.map((note) => [note.id, note]));
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
      hasProjectContext: note.folder === projectDir ||
        note.folder.startsWith(`${projectDir}/`) ||
        note.refs.some((ref) => {
          const target = findNote(notes, ref);
          return target && (target.folder === projectDir || target.folder.startsWith(`${projectDir}/`));
        }),
      childBodyLowers: []
    };
  });
  for (const item of prepared) {
    if (item.note.type !== "index" && item.note.type !== "root" && !item.note.id.startsWith("🔖")) continue;
    item.childBodyLowers = prepared
      .filter((candidate) => candidate.note.type !== "index" && candidate.note.type !== "root" && !candidate.note.id.startsWith("🔖"))
      .filter((candidate) => hasNoteName(candidate.note.refs, item.note.id))
      .map((candidate) => candidate.bodyLower);
  }
  prepared.notes = notes;
  prepared.noteById = noteById;
  prepared.bm25 = buildBm25Index(notes);
  prepared.relatedCandidatesBySeed = buildRelatedCandidateIndex(notes);
  return prepared;
}

function prepareSearchQuery(query, preparedNotes) {
  const raw = searchableTitle(query);
  const lower = raw.toLowerCase();
  const trigrams = jamoTrigrams(raw);
  const bm25Scores = new Map();
  const childBm25Scores = new Map();
  if (trigrams.length && preparedNotes.bm25?.nDocs > 0) {
    const rawScores = preparedNotes.map((_, index) => bm25Score(preparedNotes.bm25, trigrams, index));
    const maxRaw = Math.max(0, ...rawScores);
    if (maxRaw > 0) {
      rawScores.forEach((score, index) => {
        if (score > 0) bm25Scores.set(preparedNotes[index].note.id, score / maxRaw);
      });
      rawScores.forEach((score, index) => {
        if (score <= 0) return;
        const child = preparedNotes[index].note;
        if (child.type === "index" || child.type === "root") return;
        for (const ref of child.refs) {
          const target = findNote(preparedNotes.notes ?? [], ref);
          if (!target || (target.type !== "index" && target.type !== "root" && !target.id.startsWith("🔖"))) continue;
          childBm25Scores.set(target.id, Math.max(childBm25Scores.get(target.id) ?? 0, score / maxRaw));
        }
      });
    }
  }
  return {
    raw,
    lower,
    tokens: tokenize(raw),
    directHits: lower ? preparedNotes.filter((candidate) => candidate.idKey.includes(lower)) : [],
    bm25Scores,
    childBm25Scores
  };
}

function scorePreparedChannels(prepared, query) {
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

  const fuzzy = query.lower ? Math.max(0, ...prepared.searchNames.map((name) => fuzzyNameScore(query.lower, name))) : 0;
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
  channelScores.body_match = query.bm25Scores.get(note.id) ?? Math.max(body, coverage);
  if (channelScores.body_match) reasons.body_match = { coverage: channelScores.body_match };

  const childBody = note.type === "index" || note.type === "root" || note.id.startsWith("🔖")
    ? (query.childBm25Scores.get(note.id) ?? Math.max(0, ...prepared.childBodyLowers.map((candidateBody) =>
        query.tokens.length
          ? query.tokens.filter((token) => candidateBody.includes(token)).length / query.tokens.length
          : 0
      )))
    : 0;
  channelScores.child_body_match = childBody;
  if (childBody) reasons.child_body_match = { coverage: childBody };

  return { reasons, channelScores };
}

function weightedScore(channelScores, weights = {}, channels = CHANNELS) {
  let score = 0;
  for (const channel of channels) {
    const weight = weights[channel.name] ?? channel.defaultWeight;
    score += (channelScores[channel.name] ?? 0) * weight;
  }
  return score;
}

function scorePreparedNote(prepared, query, weights = {}) {
  const scored = scorePreparedChannels(prepared, query);
  return { ...scored, score: weightedScore(scored.channelScores, weights) };
}

const BUILTIN_CHANNEL_PHASES = {
  fuzzy: "base",
  keyword: "base",
  filename: "base",
  sequence_match: "base",
  filename_partial: "base",
  body_match: "base",
  child_body_match: "base",
  related: "related",
  project: "project"
};

const BUILTIN_SEARCH_CHANNELS = CHANNELS.map((channel) => ({
  ...channel,
  source: "builtin",
  phase: BUILTIN_CHANNEL_PHASES[channel.name] ?? "base"
}));

function publicChannel(channel, enabled = true) {
  return {
    name: channel.name,
    defaultWeight: channel.defaultWeight,
    description: channel.description,
    source: channel.source,
    path: channel.path,
    enabled
  };
}

function searchChannelEnabled(config, group, channel) {
  const channelConfig = config.search?.channels;
  const settings = [
    channelConfig,
    group === "builtin" ? channelConfig?.builtin : undefined,
    group === "plugins" ? channelConfig?.plugins : undefined
  ];
  let enabled = true;
  for (const setting of settings) {
    if (setting === undefined || setting === null) continue;
    enabled = applyChannelSetting(enabled, setting, channel);
  }
  return enabled;
}

function applyChannelSetting(current, setting, channel) {
  if (typeof setting === "boolean") return setting;
  if (Array.isArray(setting)) {
    return setting.includes(channel.name) || setting.includes(channel.path) || setting.includes(basename(channel.path ?? ""));
  }
  if (typeof setting !== "object") return current;
  let enabled = current;
  const keys = [channel.name, channel.path, basename(channel.path ?? "")].filter(Boolean);
  if (typeof setting.enabled === "boolean") enabled = setting.enabled;
  for (const key of keys) {
    if (typeof setting[key] === "boolean") enabled = setting[key];
    if (setting[key] && typeof setting[key] === "object" && typeof setting[key].enabled === "boolean") enabled = setting[key].enabled;
  }
  const only = asList(setting.only);
  const ignore = asList(setting.ignore);
  if (only.length) enabled = keys.some((key) => only.includes(key));
  if (keys.some((key) => ignore.includes(key))) enabled = false;
  return enabled;
}

function resolveSearchChannels(config, pluginChannels = []) {
  const builtins = BUILTIN_SEARCH_CHANNELS
    .filter((channel) => searchChannelEnabled(config, "builtin", channel));
  const plugins = pluginChannels
    .filter((channel) => searchChannelEnabled(config, "plugins", channel));
  return [...builtins, ...plugins];
}

function allSearchChannels(config, pluginChannels = []) {
  return [
    ...BUILTIN_SEARCH_CHANNELS.map((channel) => publicChannel(channel, searchChannelEnabled(config, "builtin", channel))),
    ...pluginChannels.map((channel) => publicChannel(channel, searchChannelEnabled(config, "plugins", channel)))
  ];
}

function buildRootSets(notes) {
  const rootSets = new Map();
  const visit = (note, seen = new Set()) => {
    if (!note || seen.has(note.id)) return new Set();
    if (rootSets.has(note.id)) return new Set(rootSets.get(note.id));
    seen.add(note.id);
    if (note.type === "root") {
      const roots = new Set([note.id]);
      rootSets.set(note.id, roots);
      return new Set(roots);
    }
    const roots = new Set();
    for (const ref of note.refs) {
      const target = findNote(notes, ref);
      for (const root of visit(target, seen)) roots.add(root);
    }
    rootSets.set(note.id, roots);
    return new Set(roots);
  };
  for (const note of notes) visit(note);
  return rootSets;
}

function buildRelatedCandidateIndex(notes) {
  const rootSets = buildRootSets(notes);
  const bySeed = new Map();
  for (const seed of notes) {
    const seedRoots = rootSets.get(seed.id) ?? new Set();
    const related = [];
    for (const candidate of notes) {
      if (candidate.id === seed.id) continue;
      let score = 0;
      if (shareNoteNames(seed.refs, candidate.refs)) score += 3;
      const candidateRoots = rootSets.get(candidate.id) ?? new Set();
      if ([...seedRoots].some((root) => candidateRoots.has(root))) score += 2;
      score += seed.tags.filter((tag) => candidate.tags.includes(tag)).length;
      if (hasNoteName(candidate.links, seed.id) || hasNoteName(seed.links, candidate.id)) score += 2;
      if (score > 0) related.push({ note: candidate.id, score });
    }
    bySeed.set(seed.id, related);
  }
  return bySeed;
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
  const { config, mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const active = await activeSearchParams(vaultPath);
  const searchPlugins = await loadPluginModules(vaultPath, "search");
  const pluginChannels = [];
  const plugins = [];
  for (const plugin of searchPlugins) {
    const channel = normalizeSearchChannelPlugin(plugin);
    if (channel) pluginChannels.push(channel);
    else plugins.push(plugin);
  }
  const channels = resolveSearchChannels(config, pluginChannels);
  return { vaultPath, mapping, notes, active, plugins, channels, preparedNotes: prepareSearchNotes(notes, mapping), queryScoreCache: new Map() };
}

async function searchWithContext(context, query, options = {}) {
  const { active } = context;
  const threshold = options.showAll ? 0 : options.threshold ?? active.threshold ?? 0.3;
  const cap = options.maxResults ?? options.cap ?? active.cap ?? 10;
  const weights = options.weights ?? active.weights ?? {};
  const channels = context.channels ?? BUILTIN_SEARCH_CHANNELS;
  const baseRows = await baseSearchRows(context, query);
  const rowsByNote = new Map(baseRows.map((row) => [row.note, {
    ...row,
    channelScores: { ...row.channelScores },
    reasons: { ...row.reasons },
    pluginReasons: { ...row.pluginReasons }
  }]));
  if (channels.some((channel) => channel.name === "related")) {
    applyRelatedScores(rowsByNote, context.preparedNotes.relatedCandidatesBySeed, weights, channels);
  }
  if (channels.some((channel) => channel.name === "project")) {
    applyProjectScores(rowsByNote);
  }
  const hits = [...rowsByNote.values()]
    .map((row) => ({
      note: row.note,
      path: row.path,
      type: row.type,
      refs: row.refs,
      score: Number((weightedScore(row.channelScores, weights, channels) + row.pluginScore).toFixed(6)),
      reasons: { ...row.reasons, ...row.pluginReasons }
    }))
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

async function baseSearchRows(context, query) {
  if (context.queryScoreCache?.has(query)) return context.queryScoreCache.get(query);
  const { vaultPath, mapping, notes, plugins, preparedNotes, channels = BUILTIN_SEARCH_CHANNELS } = context;
  const searchQuery = prepareSearchQuery(query, preparedNotes);
  const enabledBaseBuiltins = new Set(channels
    .filter((channel) => channel.source === "builtin" && channel.phase === "base")
    .map((channel) => channel.name));
  const rowsByNote = new Map();
  for (const prepared of preparedNotes) {
    const { note } = prepared;
    const scored = scorePreparedChannels(prepared, searchQuery);
    for (const key of Object.keys(scored.channelScores)) {
      if (!enabledBaseBuiltins.has(key)) {
        delete scored.channelScores[key];
        delete scored.reasons[key];
      }
    }
    rowsByNote.set(note.id, {
      note: note.id,
      source: note,
      path: note.relPath,
      type: note.type || "?",
      refs: note.refs,
      channelScores: scored.channelScores,
      reasons: scored.reasons,
      hasProjectContext: prepared.hasProjectContext,
      pluginScore: 0,
      pluginReasons: {}
    });
  }
  await applyPluginSearchChannels(rowsByNote, channels, { vaultPath, mapping, notes, query, searchQuery });
  for (const hit of await runSearchPlugins(vaultPath, query, notes, mapping, plugins)) {
    const note = findNote(notes, hit.note);
    if (!note) continue;
    const current = rowsByNote.get(note.id) ?? {
      note: note.id,
      source: note,
      path: note.relPath,
      type: note.type || "?",
      refs: note.refs,
      channelScores: {},
      reasons: {},
      hasProjectContext: note.folder === (mapping.project_dir ?? DEFAULT_MAPPING.project_dir) ||
        note.folder.startsWith(`${mapping.project_dir ?? DEFAULT_MAPPING.project_dir}/`),
      pluginScore: 0,
      pluginReasons: {}
    };
    current.pluginScore = Number((current.pluginScore + hit.score).toFixed(6));
    current.pluginReasons[`plugin:${basename(hit.plugin)}`] = hit.reason ?? { score: hit.score };
    rowsByNote.set(note.id, current);
  }
  const rows = [...rowsByNote.values()];
  context.queryScoreCache?.set(query, rows);
  return rows;
}

function channelWeight(name, weights = {}, channels = CHANNELS) {
  const channel = channels.find((item) => item.name === name) ?? CHANNELS.find((item) => item.name === name);
  return weights[name] ?? channel?.defaultWeight ?? 0;
}

function applyRelatedScores(rowsByNote, relatedCandidatesBySeed = new Map(), weights = {}, channels = CHANNELS) {
  const preRelatedChannels = ["filename", "fuzzy", "sequence_match", "filename_partial", "keyword"];
  const preSignal = (row) =>
    preRelatedChannels.some((channel) => (row.channelScores[channel] ?? 0) > 0);
  const seedScore = (row) =>
    preRelatedChannels.reduce((sum, channel) =>
      sum + (row.channelScores[channel] ?? 0) * channelWeight(channel, weights, channels), 0);
  const seeds = [...rowsByNote.values()]
    .filter(preSignal)
    .sort((a, b) => seedScore(b) - seedScore(a) || a.note.localeCompare(b.note))
    .slice(0, 3);
  const related = [];
  for (const seed of seeds) {
    for (const candidate of relatedCandidatesBySeed.get(seed.note) ?? []) {
      const row = rowsByNote.get(candidate.note);
      if (!row || preSignal(row)) continue;
      if (candidate.score > 0) related.push({ row, score: candidate.score, seed: seed.note });
    }
  }
  const maxScore = Math.max(0, ...related.map((item) => item.score));
  if (!maxScore) return;
  for (const item of related) {
    const normalized = item.score / maxScore;
    if (normalized > (item.row.channelScores.related ?? 0)) {
      item.row.channelScores.related = normalized;
      item.row.reasons.related = { seed: item.seed, score: normalized };
    }
  }
}

function applyProjectScores(rowsByNote) {
  for (const row of rowsByNote.values()) {
    const hasSearchSignal = Object.entries(row.channelScores).some(([key, value]) => key !== "project" && value > 0);
    if (hasSearchSignal && row.hasProjectContext) {
      row.channelScores.project = 1;
      row.reasons.project = { context: true };
    } else {
      delete row.channelScores.project;
      delete row.reasons.project;
    }
  }
}

async function applyPluginSearchChannels(rowsByNote, channels, context) {
  for (const channel of channels.filter((item) => item.source === "plugin" && item.phase === "base")) {
    const output = await channel.search({
      query: context.query,
      preparedQuery: context.searchQuery,
      notes: context.notes,
      mapping: context.mapping,
      vaultPath: context.vaultPath
    });
    for (const hit of normalizeSearchChannelOutput(output, channel.path)) {
      const note = findNote(context.notes, hit.note);
      if (!note) continue;
      const row = rowsByNote.get(note.id);
      if (!row) continue;
      row.channelScores[channel.name] = Math.max(row.channelScores[channel.name] ?? 0, hit.score);
      row.reasons[channel.name] = hit.reason ?? { plugin: channel.path, score: hit.score };
    }
  }
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

function normalizeSearchChannelPlugin(plugin) {
  const mod = plugin.module;
  const descriptor = mod.channel ?? mod.default?.channel;
  const search = descriptor?.search ?? mod.searchChannel ?? mod.score;
  if (!descriptor && typeof mod.searchChannel !== "function" && typeof mod.score !== "function") return null;
  if (typeof search !== "function") return null;
  const rawName = descriptor?.name ?? mod.name ?? basename(plugin.path, ".js");
  const name = String(rawName ?? "").trim();
  if (!name) return null;
  const defaultWeight = Number(descriptor?.defaultWeight ?? descriptor?.default_weight ?? mod.defaultWeight ?? mod.default_weight ?? 0.1);
  return {
    name,
    defaultWeight: Number.isFinite(defaultWeight) ? defaultWeight : 0.1,
    description: descriptor?.description ?? mod.description ?? `Search channel plugin ${basename(plugin.path)}`,
    source: "plugin",
    phase: "base",
    path: plugin.path,
    search
  };
}

function normalizeSearchChannelOutput(output, pluginPath) {
  if (!output) return [];
  const payload = output.scores ?? output;
  if (!Array.isArray(payload) && payload instanceof Map) {
    return [...payload.entries()].map(([note, score]) => ({ note, score: Number(score) || 0, reason: { plugin: pluginPath } }));
  }
  if (!Array.isArray(payload) && typeof payload === "object") {
    const reasons = output.reasons ?? {};
    return Object.entries(payload).map(([note, score]) => ({
      note,
      score: Number(score) || 0,
      reason: reasons[note] ?? { plugin: pluginPath }
    }));
  }
  return (Array.isArray(payload) ? payload : [payload])
    .map((item) => {
      const note = item.note?.id ?? item.note ?? item.id ?? item.name;
      return {
        note,
        score: Number(item.score ?? item.raw ?? 1) || 0,
        reason: item.reason ?? { plugin: pluginPath }
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

const RULE_BY_CODE = new Map(RULES.map((rule) => [rule.code, rule]));
const VALID_NOTE_TYPES = new Set(["note", "index", "root"]);
const IPA_DATE_RE = /^\d{4}\/\d{2}\/\d{2} \([A-Z][a-z]{2}\) \d{2}:\d{2}:\d{2}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function ruleMeta(code) {
  return RULE_BY_CODE.get(code) ?? { code, category: "custom", severity: "warn", scope: "note" };
}

function registryEnabled(current, setting, aliases) {
  if (setting === undefined || setting === null) return current;
  if (typeof setting === "boolean") return setting;
  const keys = aliases.filter(Boolean);
  if (Array.isArray(setting)) return keys.some((key) => setting.includes(key));
  if (typeof setting !== "object") return current;
  let enabled = current;
  for (const key of keys) {
    if (typeof setting[key] === "boolean") enabled = setting[key];
  }
  const only = asList(setting.only);
  const ignore = asList(setting.ignore);
  if (only.length) enabled = keys.some((key) => only.includes(key));
  if (keys.some((key) => ignore.includes(key))) enabled = false;
  return enabled;
}

function builtinRuleEnabled(config, rule) {
  if (config.rules?.enabled === false) return false;
  const convention = config.convention ?? {};
  if (convention.enabled === false) return false;
  const aliases = [rule.code, rule.category, rule.scope];
  let enabled = true;
  enabled = registryEnabled(enabled, convention.builtin, aliases);
  enabled = registryEnabled(enabled, convention.rules, aliases);
  enabled = registryEnabled(enabled, config.rules?.builtin, aliases);
  enabled = registryEnabled(enabled, config.rules, aliases);
  enabled = registryEnabled(enabled, config.rules?.items, aliases);
  return enabled;
}

function ruleEnabled(config, rule) {
  if (config.rules?.enabled === false) return false;
  if (!rule.plugin) return builtinRuleEnabled(config, rule);
  const aliases = [rule.code, rule.category, rule.scope, rule.plugin, basename(rule.plugin)];
  let enabled = true;
  enabled = registryEnabled(enabled, config.rules, aliases);
  enabled = registryEnabled(enabled, config.rules?.items, aliases);
  return enabled;
}

function activeBuiltinRules(config) {
  return BUILTIN_RULES.filter((rule) => builtinRuleEnabled(config, rule));
}

function isInFolder(noteOrPath, folder) {
  const value = typeof noteOrPath === "string" ? noteOrPath : noteOrPath.folder;
  const normalized = toPosix(String(value ?? "")).replace(/\/+$/, "");
  const target = toPosix(String(folder ?? "")).replace(/\/+$/, "");
  return Boolean(target && (normalized === target || normalized.startsWith(`${target}/`)));
}

function isRawInboxCapture(note, mapping) {
  return isInFolder(note, mapping.inbox_dir) && Object.keys(note.frontmatter).length === 0;
}

function validDateValue(value) {
  const text = String(value ?? "").trim();
  return IPA_DATE_RE.test(text) || ISO_DATE_RE.test(text);
}

function noteIssue(code, note, message, extra = {}) {
  const meta = ruleMeta(code);
  return { ...issue(code, meta.severity, note, message), ...extra };
}

function vaultIssue(code, path, message, extra = {}) {
  const meta = ruleMeta(code);
  return { code, severity: meta.severity, path, message, ...extra };
}

function builtinRule(code, handlers) {
  return { ...ruleMeta(code), source: "builtin", ...handlers };
}

const BUILTIN_RULES = [
  builtinRule("ipa.inbox.raw_capture", {
    checkNote(note, ctx) {
      return isRawInboxCapture(note, ctx.mapping)
        ? [noteIssue(this.code, note, "raw inbox capture without frontmatter")]
        : [];
    }
  }),
  builtinRule("ipa.frontmatter.required_field", {
    checkNote(note, ctx) {
      return [ctx.mapping.created_at, ctx.mapping.updated_at, ctx.mapping.tags, ctx.mapping.note_type]
        .filter((field) => note.frontmatter[field] === undefined)
        .map((field) => noteIssue(this.code, note, `missing frontmatter field: ${field}`));
    },
    async fixNote(note, ctx) {
      if (!hasFrontmatterBlock(note.raw)) return note.raw;
      let text = note.raw;
      const required = [
        [ctx.mapping.created_at, async () => {
          const fileStat = await stat(note.path).catch(() => null);
          return formatVaultDate(fileStat?.birthtime ?? new Date());
        }],
        [ctx.mapping.updated_at, () => formatVaultDate(new Date())],
        [ctx.mapping.tags, () => []],
        [ctx.mapping.note_type, () => inferNoteType(note.id)]
      ];
      for (const [field, valueFactory] of required) {
        const current = readFrontmatter(text).frontmatter;
        if (current[field] !== undefined) continue;
        text = insertFrontmatterField(text, field, await valueFactory());
      }
      return text;
    }
  }),
  builtinRule("ipa.frontmatter.date_format", {
    checkNote(note, ctx) {
      return [ctx.mapping.created_at, ctx.mapping.updated_at]
        .filter((field) => note.frontmatter[field] !== undefined && !validDateValue(note.frontmatter[field]))
        .map((field) => noteIssue(this.code, note, `invalid date format in ${field}: ${note.frontmatter[field]}`));
    }
  }),
  builtinRule("ipa.frontmatter.invalid_type", {
    checkNote(note) {
      return note.type && !VALID_NOTE_TYPES.has(String(note.type))
        ? [noteIssue(this.code, note, `invalid type: ${note.type}`)]
        : [];
    }
  }),
  builtinRule("ipa.frontmatter.missing_ref", {
    checkNote(note) {
      return ["note", "index"].includes(String(note.type)) && note.refs.length === 0
        ? [noteIssue(this.code, note, "note/index should have at least one ref")]
        : [];
    }
  }),
  builtinRule("ipa.tag.snake_case", {
    checkNote(note) {
      return note.tags
        .filter((tag) => !/^[a-z0-9_/-]+$/.test(tag))
        .map((tag) => noteIssue(this.code, note, `tag should be snake_case: ${tag}`));
    }
  }),
  builtinRule("ipa.title.root_prefix", {
    checkNote(note) {
      return note.type === "root" && !note.id.startsWith("🏷️")
        ? [noteIssue(this.code, note, "root title should start with 🏷️")]
        : [];
    }
  }),
  builtinRule("ipa.title.root_suffix", {
    checkNote(note) {
      return note.type === "root" && !note.id.endsWith("Root")
        ? [noteIssue(this.code, note, "root title should end with Root")]
        : [];
    }
  }),
  builtinRule("ipa.title.index_prefix", {
    checkNote(note) {
      return note.type === "index" && !note.id.startsWith("🔖")
        ? [noteIssue(this.code, note, "index title should start with 🔖")]
        : [];
    }
  }),
  builtinRule("ipa.location.type_mismatch", {
    checkNote(note, ctx) {
      if (note.type === "note" && !isInFolder(note, ctx.mapping.inbox_dir) && !isInFolder(note, ctx.mapping.archive_dir)) {
        return [noteIssue(this.code, note, `note type should live under ${ctx.mapping.inbox_dir} or ${ctx.mapping.archive_dir}`)];
      }
      if (["index", "root"].includes(String(note.type)) && !isInFolder(note, ctx.mapping.project_dir) && !isInFolder(note, ctx.mapping.archive_dir)) {
        return [noteIssue(this.code, note, `index/root type should live under ${ctx.mapping.project_dir} or ${ctx.mapping.archive_dir}`)];
      }
      return [];
    }
  }),
  builtinRule("ipa.link.ref_target_missing", {
    checkNote(note, ctx) {
      return note.refs
        .filter((ref) => !noteTitleExists(ctx.notes, ref) && !markdownTitleExists(ctx.excludedTitles, ref))
        .map((ref) => noteIssue(this.code, note, `ref target missing: ${ref}`));
    }
  }),
  builtinRule("ipa.link.wikilink_target_missing", {
    checkNote(note, ctx) {
      return note.links
        .filter((link) =>
          !markdownTitleExists(ctx.markdownTitles, link) &&
          !markdownTitleExists(ctx.excludedTitles, link) &&
          !markdownTitleExists(ctx.attachmentTitles, link)
        )
        .map((link) => noteIssue(this.code, note, `wikilink target missing: ${link}`));
    }
  }),
  builtinRule("ipa.root_folder.duplicate", {
    checkVault(ctx) {
      const byFolder = rootNotesByProjectFolder(ctx.notes, ctx.mapping);
      const issues = [];
      for (const [folder, notes] of byFolder.entries()) {
        if (notes.length > 1) {
          for (const note of notes) issues.push(noteIssue(this.code, note, `multiple root notes in project folder: ${folder}`));
        }
      }
      return issues;
    }
  }),
  builtinRule("ipa.root_folder.missing", {
    async checkVault(ctx) {
      const byFolder = rootNotesByProjectFolder(ctx.notes, ctx.mapping);
      const projectRoot = join(ctx.vaultPath, ctx.mapping.project_dir);
      if (!existsSync(projectRoot)) return [];
      const entries = await readdir(projectRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => toPosix(relative(ctx.vaultPath, join(projectRoot, entry.name))))
        .filter((folder) => !byFolder.has(folder))
        .map((folder) => vaultIssue(this.code, folder, `project folder has no root note: ${folder}`));
    }
  }),
  builtinRule("ipa.heading.no_h1", {
    checkNote(note) {
      return IpaNoteDocument.fromNote(note).hasH1()
        ? [noteIssue(this.code, note, "note body should not contain H1 headings")]
        : [];
    },
    fixNote(note, ctx) {
      return IpaNoteDocument.fromNote(note, ctx.mapping).withoutDuplicateTitleH1();
    }
  })
];

function rootNotesByProjectFolder(notes, mapping) {
  const byFolder = new Map();
  for (const note of notes) {
    if (note.type !== "root" || !isInFolder(note, mapping.project_dir)) continue;
    const list = byFolder.get(note.folder) ?? [];
    list.push(note);
    byFolder.set(note.folder, list);
  }
  return byFolder;
}

function noteTitleExists(notes, title) {
  return notes.some((note) => sameNoteName(note.id, title) || note.aliases.some((alias) => sameNoteName(alias, title)));
}

function normalizeRulePlugin(plugin) {
  const exported = plugin.module.rules ?? plugin.module.rule ?? plugin.module.default ?? (
    plugin.module.check || plugin.module.fix || plugin.module.checkNote || plugin.module.fixNote ? plugin.module : []
  );
  const descriptors = Array.isArray(exported) ? exported : exported ? [exported] : [];
  return descriptors.map((descriptor, index) => {
    const code = descriptor.code ?? descriptor.id ?? `${basename(plugin.path, ".js")}.${index + 1}`;
    const meta = ruleMeta(code);
    return {
      ...meta,
      code,
      category: descriptor.category ?? meta.category,
      severity: descriptor.severity ?? meta.severity,
      scope: descriptor.scope ?? meta.scope,
      fixable: Boolean(descriptor.fixNote ?? descriptor.fix),
      plugin: plugin.path,
      source: "plugin",
      checkNote: descriptor.checkNote ?? descriptor.check,
      checkVault: descriptor.checkVault,
      fixNote: descriptor.fixNote ?? descriptor.fix
    };
  });
}

async function activeRulesForVault(vaultPath, config) {
  if (config.rules?.enabled === false) return [];
  const plugins = await loadPluginModules(vaultPath, "rules");
  return [
    ...activeBuiltinRules(config),
    ...plugins.flatMap((plugin) => normalizeRulePlugin(plugin)).filter((rule) => ruleEnabled(config, rule))
  ];
}

function normalizeRuleIssues(output, rule, note = null) {
  return (Array.isArray(output) ? output : output ? [output] : [])
    .map((item) => ({
      code: item.code ?? rule.code,
      severity: item.severity ?? rule.severity ?? "warn",
      note: item.note ?? note?.id,
      path: item.path ?? note?.relPath,
      message: item.message ?? "rule issue",
      plugin: item.plugin ?? rule.plugin
    }));
}

export async function validateVault(vaultPath) {
  const { config, mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const ctx = {
    config,
    mapping,
    notes,
    vaultPath,
    excludedTitles: await loadExcludedMarkdownTitles(vaultPath, mapping),
    markdownTitles: await loadActiveMarkdownTitles(vaultPath, mapping),
    attachmentTitles: await loadAttachmentTitles(vaultPath, mapping)
  };
  const rules = await activeRulesForVault(vaultPath, config);
  const issues = [];
  const rawCaptureRule = rules.find((rule) => rule.code === "ipa.inbox.raw_capture");
  const noteRules = rules.filter((rule) => rule.checkNote && rule.code !== "ipa.inbox.raw_capture");
  const vaultRules = rules.filter((rule) => rule.checkVault);

  for (const note of notes) {
    if (isRawInboxCapture(note, mapping)) {
      if (rawCaptureRule) issues.push(...normalizeRuleIssues(await rawCaptureRule.checkNote(note, ctx), rawCaptureRule, note));
      continue;
    }
    for (const rule of noteRules) issues.push(...normalizeRuleIssues(await rule.checkNote(note, ctx), rule, note));
  }
  for (const rule of vaultRules) {
    if (rule.checkVault) issues.push(...normalizeRuleIssues(await rule.checkVault(ctx), rule));
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

async function loadAttachmentTitles(vaultPath, mapping) {
  const excludes = asList(mapping.exclude);
  const files = await walkFiles(vaultPath, (path, relPath) =>
    extname(path).toLowerCase() !== ".md" && !isExcludedPath(relPath, excludes)
  );
  const titles = new Set();
  for (const path of files) {
    for (const title of [basename(path), basename(path, extname(path))]) {
      const normalized = normalizeTitle(title);
      titles.add(normalized);
      titles.add(normalized.toLowerCase());
      const key = searchableKey(normalized);
      if (key) titles.add(key);
    }
  }
  return titles;
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

function hasFrontmatterBlock(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  return normalized.startsWith("---\n") && normalized.indexOf("\n---", 4) !== -1;
}

function insertFrontmatterField(text, key, value) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  const end = normalized.indexOf("\n---", 4);
  if (!normalized.startsWith("---\n") || end === -1) return normalized;
  const rendered = typeof value === "string" && IPA_DATE_RE.test(value) ? value : yamlScalar(value);
  const line = `${key}: ${rendered}\n`;
  return `${normalized.slice(0, end + 1)}${line}${normalized.slice(end + 1)}`;
}

function inferNoteType(title) {
  if (String(title).startsWith("🏷️") || String(title).endsWith("Root")) return "root";
  if (String(title).startsWith("🔖")) return "index";
  return "note";
}

function formatVaultDate(date) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} (${days[date.getDay()]}) ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function removeDuplicateH1(text, title) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  const parsed = readFrontmatter(normalized);
  const lines = parsed.body.split("\n");
  let removed = false;
  const nextLines = lines.filter((line) => {
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (!removed && match && sameNoteName(match[1], title)) {
      removed = true;
      return false;
    }
    return true;
  });
  if (!removed) return normalized;
  return replaceBody(normalized, nextLines.join("\n").replace(/^\n+/, ""));
}

function replaceBody(text, body) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return body;
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return body;
  const bodyStart = normalized.indexOf("\n", end + 4);
  if (bodyStart === -1) return `${normalized}\n${body}`;
  return `${normalized.slice(0, bodyStart + 1)}${body}`;
}

function noteFromRaw(note, raw, mapping) {
  const { frontmatter, body } = readFrontmatter(raw);
  return {
    ...note,
    raw,
    frontmatter,
    body,
    type: frontmatter[mapping.note_type] || "",
    refs: asList(frontmatter[mapping.refs]).map(stripWiki).filter(Boolean),
    tags: asList(frontmatter[mapping.tags]).map((tag) => String(tag).replace(/^#/, "")),
    aliases: mapping.aliases ? asList(frontmatter[mapping.aliases]).map(normalizeTitle) : [],
    links: extractWikilinks(body),
    headings: parseHeadings(body)
  };
}

function applyRuleFixOutput(text, output) {
  let next = text;
  for (const item of Array.isArray(output) ? output : output ? [output] : []) {
    if (typeof item === "string") next = item;
    else next = applyFormatterPatch(next, item);
  }
  return next;
}

async function ruleFixPatches(notes, ctx, rules) {
  const patches = [];
  for (const note of notes) {
    let text = note.raw;
    const applied = [];
    for (const rule of rules.filter((item) => item.fixNote)) {
      const workingNote = noteFromRaw(note, text, ctx.mapping);
      const next = applyRuleFixOutput(text, await rule.fixNote(workingNote, { ...ctx, note: workingNote }));
      if (next !== text) {
        text = next;
        applied.push(rule.code);
      }
    }
    if (text !== note.raw) {
      patches.push({
        note: note.id,
        path: note.relPath,
        plugin: "rules",
        rules: applied,
        content: text
      });
    }
  }
  return patches;
}

export async function formatVault(vaultPath, apply = false, options = {}) {
  const { config, mapping } = await readVaultConfig(vaultPath);
  const allNotes = await loadNotes(vaultPath, mapping);
  const rules = await activeRulesForVault(vaultPath, config);
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
  const ruleContext = {
    config,
    notes: allNotes,
    mapping,
    vaultPath,
    apply,
    MarkdownDocument,
    IpaNoteDocument,
    options: {
      note: targets.length === 1 ? targets[0].id : null,
      notes: targets.map((item) => item.id)
    }
  };
  patches.push(...await ruleFixPatches(notes, ruleContext, rules));
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

const CONTEXT_SIZE_PRESETS = {
  small: { maxChars: 4000, maxNotes: 2, targetExcerpt: 700, relatedExcerpt: 120, neighborLimit: 3 },
  medium: { maxChars: 10000, maxNotes: 3, targetExcerpt: 1200, relatedExcerpt: 220, neighborLimit: 5 },
  large: { maxChars: 25000, maxNotes: 5, targetExcerpt: 2500, relatedExcerpt: 500, neighborLimit: 8 },
  full: { maxChars: 60000, maxNotes: 5, targetExcerpt: 12000, relatedExcerpt: 1000, neighborLimit: 12 }
};

function contextPreset(options = {}) {
  const key = options.full && !options.size ? "full" : String(options.size ?? "medium").toLowerCase();
  const preset = CONTEXT_SIZE_PRESETS[key] ?? CONTEXT_SIZE_PRESETS.medium;
  return {
    name: CONTEXT_SIZE_PRESETS[key] ? key : "medium",
    maxChars: Number(options.maxChars ?? preset.maxChars),
    maxNotes: Number(options.maxNotes ?? preset.maxNotes),
    targetExcerpt: preset.targetExcerpt,
    relatedExcerpt: preset.relatedExcerpt,
    neighborLimit: preset.neighborLimit
  };
}

function uniqueNotes(notes) {
  const seen = new Set();
  return notes.filter((note) => {
    if (!note || seen.has(note.id)) return false;
    seen.add(note.id);
    return true;
  });
}

function noteRef(note, query, excerptChars = 0) {
  const item = {
    id: note.id,
    type: note.type,
    path: note.relPath
  };
  if (excerptChars > 0) item.excerpt = excerptText(note.body, excerptChars, query);
  return item;
}

function noteRefs(items, query, limit, excerptChars) {
  return uniqueNotes(items)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((note) => noteRef(note, query, excerptChars));
}

function backlinkNotes(note, notes) {
  return notes.filter((candidate) =>
    candidate.id !== note.id && hasNoteName([...candidate.refs, ...candidate.links], note.id)
  );
}

function outlinkNotes(note, notes) {
  return uniqueNotes(note.links.map((link) => findNote(notes, link)).filter(Boolean));
}

function childNotes(note, notes) {
  return notes.filter((candidate) => candidate.id !== note.id && hasNoteName(candidate.refs, note.id));
}

function contextNote(note, notes, query, hit, preset) {
  const limit = preset.neighborLimit;
  const relatedExcerpt = preset.relatedExcerpt;
  return {
    id: note.id,
    path: note.relPath,
    type: note.type,
    refs: note.refs,
    tags: note.tags,
    score: hit?.score ?? null,
    reason: hit?.reason ?? null,
    upward_paths: upwardPaths(note, notes).slice(0, limit),
    backlinks: noteRefs(backlinkNotes(note, notes), query, limit, relatedExcerpt),
    siblings: noteRefs(siblings(note, notes), query, limit, relatedExcerpt),
    outlinks: noteRefs(outlinkNotes(note, notes), query, limit, relatedExcerpt),
    children: noteRefs(childNotes(note, notes), query, limit, relatedExcerpt),
    excerpt: excerptText(note.body, preset.targetExcerpt, query),
    body: excerptText(note.body, preset.targetExcerpt, query)
  };
}

function excerptText(text, maxChars, query = "") {
  const clean = String(text ?? "").replace(/^\s+/, "").trimEnd();
  if (!clean) return "";
  if (!Number.isFinite(maxChars) || maxChars <= 0 || clean.length <= maxChars) return clean;
  const lower = clean.toLowerCase();
  const tokens = String(query ?? "").toLowerCase().split(/\s+/).filter((token) => token.length >= 2);
  const hit = tokens.map((token) => lower.indexOf(token)).find((index) => index >= 0);
  const start = hit === undefined ? 0 : Math.max(0, hit - Math.floor(maxChars / 3));
  const end = Math.min(clean.length, start + maxChars);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < clean.length ? "..." : "";
  return `${prefix}${clean.slice(start, end).trim()}${suffix}`;
}

function contextSubgraph(contextNotes, notes) {
  const ids = new Set();
  for (const item of contextNotes) {
    ids.add(item.id);
    for (const group of [item.backlinks, item.siblings, item.outlinks, item.children]) {
      for (const ref of group ?? []) ids.add(ref.id);
    }
  }
  const edges = {};
  for (const note of notes.filter((candidate) => ids.has(candidate.id))) {
    const targets = uniqueNotes([...note.refs, ...note.links].map((target) => findNote(notes, target)).filter(Boolean))
      .map((target) => target.id)
      .filter((id) => ids.has(id));
    edges[note.id] = targets;
  }
  return edges;
}

function contextCommands(contextNotes) {
  const first = contextNotes[0];
  if (!first) return [];
  const commands = [
    `ipa view "${first.id}" --full`,
    first.type === "index" || first.type === "root"
      ? `ipa traversal --down "${first.id}"`
      : `ipa traversal --up "${first.id}"`,
    `ipa traversal --siblings "${first.id}"`
  ];
  if (first.tags?.[0]) commands.push(`ipa search "${first.tags[0]}"`);
  return commands;
}

export async function buildContext(vaultPath, query, options = {}) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const preset = contextPreset(options);
  const search = options.byNote
    ? { results: [{ note: findNote(notes, query)?.id, score: 1 }].filter((item) => item.note) }
    : await searchVault(vaultPath, query, { maxResults: options.maxResults ?? preset.maxNotes, threshold: 0 });
  const selected = uniqueNotes(search.results.map((hit) => findNote(notes, hit.note)).filter(Boolean)).slice(0, preset.maxNotes);
  const contextNotes = selected.map((note) =>
    contextNote(note, notes, query, search.results.find((hit) => sameNoteName(hit.note, note.id)), preset)
  );
  const warnings = [];
  if (options.byNote && !selected.length) warnings.push({ code: "context.note_not_found", message: `note not found: ${query}` });
  if (!options.byNote && !selected.length) warnings.push({ code: "context.no_search_results", message: `no notes found for query: ${query}` });
  return {
    query,
    mode: options.byNote ? "by-note" : "search",
    size: preset.name,
    budget: {
      max_chars: preset.maxChars,
      max_notes: preset.maxNotes
    },
    notes: contextNotes,
    edges: contextSubgraph(contextNotes, notes),
    sources: selected.map((note) => note.relPath),
    next_commands: contextCommands(contextNotes),
    warnings
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
  for (const kind of ["search", "rules"]) {
    const dir = join(root, kind);
    const files = existsSync(dir) ? await readdir(dir) : [];
    for (const file of files.filter((name) => name.endsWith(".js") && !name.startsWith("_")).sort()) {
      const relPath = toPosix(relative(vaultPath, join(dir, file)));
      if (pluginEnabled(config, kind, relPath)) entries.push({ kind, path: relPath });
    }
  }
  return { plugins: entries };
}

export async function listSearchChannels(vaultPath) {
  const { config } = await readVaultConfig(vaultPath);
  const searchPlugins = await loadPluginModules(vaultPath, "search");
  const pluginChannels = searchPlugins.map((plugin) => normalizeSearchChannelPlugin(plugin)).filter(Boolean);
  return { channels: allSearchChannels(config, pluginChannels) };
}

export async function listRules(vaultPath) {
  const { config } = await readVaultConfig(vaultPath);
  const plugins = await loadPluginModules(vaultPath, "rules");
  const pluginRules = plugins.flatMap((plugin) => normalizeRulePlugin(plugin));
  return {
    rules: [
      ...RULES.map((rule) => ({ ...rule, enabled: builtinRuleEnabled(config, rule), source: "builtin" })),
      ...pluginRules.map((rule) => ({
        code: rule.code,
        category: rule.category,
        severity: rule.severity,
        scope: rule.scope,
        fixable: Boolean(rule.fixNote),
        enabled: ruleEnabled(config, rule),
        source: "plugin",
        plugin: rule.plugin
      }))
    ]
  };
}

export function pluginEnabled(config, kind, relPath) {
  const settings = [
    config.plugins,
    config.search?.plugins,
    kind === "rules" ? config.rules?.plugins : undefined
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
    if ((kind === "search" || path.includes("/search/")) && typeof mod.search !== "function" && !normalizeSearchChannelPlugin({ path, module: mod })) {
      issues.push({ code: "plugin.contract", severity: "error", message: "search plugin must export search() or a channel descriptor" });
    }
    if (kind === "rules" || path.includes("/rules/")) {
      const rules = normalizeRulePlugin({ path, module: mod });
      if (!rules.length) {
        issues.push({ code: "plugin.contract", severity: "error", message: "rules plugin must export rule(s) with check/checkNote/checkVault or fix/fixNote" });
      }
      for (const rule of rules) {
        if (!rule.checkNote && !rule.checkVault && !rule.fixNote) {
          issues.push({ code: "plugin.contract", severity: "error", message: `rule has no check or fix: ${rule.code}` });
        }
      }
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
    const channel = normalizeSearchChannelPlugin({ path: pluginRelPath, module: mod });
    const results = channel
      ? normalizeSearchChannelOutput(await channel.search({ query: options.query ?? "", notes, mapping, vaultPath }), pluginRelPath)
      : await mod.search(options.query ?? "", notes);
    return { kind, plugin: pluginRelPath, query: options.query, results };
  }
  const note = findNote(notes, options.note);
  if (!note) throw new Error(`note not found: ${options.note}`);
  if (kind === "rules") {
    const rules = normalizeRulePlugin({ path: pluginRelPath, module: mod });
    const ctx = { notes, mapping, vaultPath, apply: false, MarkdownDocument, IpaNoteDocument, options: { note: note.id } };
    const issues = [];
    for (const rule of rules.filter((item) => item.checkNote)) {
      issues.push(...normalizeRuleIssues(await rule.checkNote(note, ctx), rule, note));
    }
    return {
      kind,
      plugin: pluginRelPath,
      note: note.id,
      issues,
      patches: await ruleFixPatches([note], ctx, rules)
    };
  }
  throw new Error(`unknown plugin dry-run kind: ${kind}`);
}

export function builtinQueryPack(name) {
  if (name !== "ipa-cli-core") return null;
  return tunePack(name, [
    { queries: ["Alpha"], targets: ["Alpha"], kind: "query" },
    { queries: ["Beta"], targets: ["Beta"], kind: "query" },
    { queries: ["Topic"], targets: ["Topic Index"], kind: "query" }
  ]);
}

async function configuredQueryPack(vaultPath) {
  const { config } = await readVaultConfig(vaultPath);
  const file = config.test?.file;
  if (!file) return null;
  const path = resolve(vaultPath, file);
  if (!existsSync(path)) return null;
  const payload = JSON.parse(await readFile(path, "utf8"));
  return tunePack(file, normalizeTuneCases(payload));
}

function tunePack(name, cases) {
  return {
    name,
    cases,
    queries: cases.flatMap((item) => item.queries.map((query) => ({
      query,
      target: item.targets[0] ?? null,
      kind: item.kind
    })))
  };
}

function normalizeTuneCases(payload) {
  const cases = [];
  for (const { item, kind } of tuneTestsetEntries(payload)) {
    const normalized = normalizeTuneCase(item, kind);
    if (normalized) cases.push(normalized);
  }
  return cases;
}

function tuneTestsetEntries(payload) {
  return [
    ...normalizeTestsetPayload({ cases: payload.cases ?? payload.queries ?? [] }).map((item) => ({ item, kind: "regression" })),
    ...normalizeTestsetPayload({ cases: payload.scenario_cases ?? [] }).map((item) => ({ item, kind: "scenario" }))
  ];
}

function normalizeTuneCase(item, fallbackKind = "query") {
  const queries = (Array.isArray(item.queries) ? item.queries : [item.query]).filter(Boolean).map(String);
  const targetValues = tuneTargetValues(item);
  const targets = targetValues.map((target) => normalizeTitle(target)).filter(Boolean);
  if (!queries.length || !targets.length) return null;
  const kind = tuneCaseKind(item, fallbackKind);
  const recallLimit = tuneRecallLimit(item);
  return {
    id: item.id ?? null,
    kind,
    category: item.category ?? item.tag ?? null,
    queries,
    targets,
    recall_mode: item.recall_mode ?? `top${recallLimit}`,
    recall_limit: recallLimit,
    recall_threshold: Math.max(1, Number(item.recall_threshold ?? 1) || 1)
  };
}

function tuneTargetValues(item) {
  return Array.isArray(item.target_filenames)
    ? item.target_filenames
    : [item.target_filename ?? item.target ?? item.note ?? item.expected].filter(Boolean);
}

function tuneCaseKind(item, fallbackKind) {
  const raw = String(item.kind ?? item.type ?? item.scope ?? item.group ?? "").toLowerCase();
  if (raw.includes("scenario") || raw === "scn") return "scenario";
  if (raw.includes("regression") || raw === "reg") return "regression";
  if (String(item.id ?? "").startsWith("S")) return "scenario";
  if (String(item.id ?? "").startsWith("C")) return "regression";
  return fallbackKind;
}

function tuneRecallLimit(item) {
  const mode = String(item.recall_mode ?? item.recallMode ?? "top10").toLowerCase();
  const match = mode.match(/top(\d+)/);
  return match ? Number(match[1]) : 10;
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
  for (const item of pack.cases ?? []) rows.push(await evaluateTuneCase(searchContext, item, params));
  const hits = rows.filter((row) => row.hit).length;
  const avgRank = hits ? rows.filter((row) => row.rank).reduce((sum, row) => sum + row.rank, 0) / hits : null;
  const evaluation = {
    pack: pack.name,
    total: rows.length,
    hits,
    misses: rows.length - hits,
    avg_rank: avgRank,
    groups: tuneGroups(rows),
    rows
  };
  return { ...evaluation, loss: tuneLoss(evaluation) };
}

async function evaluateTuneCase(searchContext, item, params = {}) {
  const recallLimit = Number(params.recallLimit ?? item.recall_limit ?? 10) || 10;
  const requestedMax = Number(params.cap ?? 0) || 0;
  const searchOptions = {
    threshold: params.threshold,
    maxResults: Math.max(requestedMax, recallLimit),
    showAll: params.showAll
  };
  if (Object.hasOwn(params, "weights")) searchOptions.weights = params.weights;

  const matched = new Set();
  let bestRank = null;
  let bestScore = null;
  for (const query of item.queries) {
    const result = await searchWithContext(searchContext, query, searchOptions);
    const scoped = result.results.slice(0, recallLimit);
    for (const target of item.targets) {
      const index = scoped.findIndex((hit) => sameNoteName(hit.note, target));
      if (index < 0) continue;
      matched.add(target);
      const rank = index + 1;
      const score = scoped[index].score ?? null;
      if (bestRank === null || rank < bestRank) bestRank = rank;
      if (score !== null && (bestScore === null || score > bestScore)) bestScore = score;
    }
  }
  const recallThreshold = Math.max(1, Number(item.recall_threshold ?? 1) || 1);
  const hit = matched.size >= recallThreshold;
  return {
    id: item.id,
    kind: item.kind,
    category: item.category,
    query: item.queries.join(" | "),
    queries: item.queries,
    target: item.targets[0] ?? null,
    targets: item.targets,
    recall_mode: item.recall_mode,
    recall_threshold: recallThreshold,
    matched: matched.size,
    rank: hit ? bestRank : null,
    score: hit ? bestScore : null,
    hit
  };
}

function tuneGroups(rows) {
  const groups = {};
  for (const row of rows) {
    const key = row.kind ?? "query";
    groups[key] ??= { total: 0, hits: 0, misses: 0, avg_rank: null, ranks: [] };
    groups[key].total += 1;
    if (row.hit) {
      groups[key].hits += 1;
      if (row.rank) groups[key].ranks.push(row.rank);
    }
  }
  for (const group of Object.values(groups)) {
    group.misses = group.total - group.hits;
    group.avg_rank = group.ranks.length ? group.ranks.reduce((sum, rank) => sum + rank, 0) / group.ranks.length : null;
    delete group.ranks;
  }
  return groups;
}

export async function tuneEval(vaultPath, packName = null, params = {}) {
  return evaluateTunePack(await prepareSearchContext(vaultPath), await resolveTunePack(vaultPath, packName), params);
}

function tuneLoss(evaluation) {
  if (evaluation.groups?.regression || evaluation.groups?.scenario) {
    const regressionMisses = evaluation.groups.regression?.misses ?? 0;
    const scenarioMisses = evaluation.groups.scenario?.misses ?? 0;
    const groupedMisses = regressionMisses + scenarioMisses;
    const otherMisses = Math.max(0, evaluation.misses - groupedMisses);
    return regressionMisses * 100 + scenarioMisses * 50 + otherMisses * 100 + (evaluation.avg_rank ?? 99);
  }
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
  for (const item of pack.cases ?? []) {
    const row = await evaluateTuneCase(searchContext, item, {
      threshold: 0,
      cap: options.maxResults ?? 50,
      recallLimit: options.maxResults ?? 50,
      showAll: true
    });
    targetScores.push({
      id: row.id,
      kind: row.kind,
      query: row.query,
      target: row.targets.length > 1 ? row.targets.join(", ") : row.target,
      rank: row.rank,
      score: row.score
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
  const rows = normalizeTuneCases(payload).map((item) => ({
    id: item.id,
    kind: item.kind,
    target: item.targets.length > 1 ? item.targets.join(", ") : item.targets[0],
    targets: item.targets,
    queries: item.queries,
    recall_mode: item.recall_mode,
    recall_threshold: item.recall_threshold
  }));
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
  const entries = tuneTestsetEntries(payload);
  const notes = await loadNotes(vaultPath, (await readVaultConfig(vaultPath)).mapping);
  entries.forEach(({ item, kind }, index) => {
    const queries = Array.isArray(item.queries) ? item.queries : [item.query].filter(Boolean);
    const targets = tuneTargetValues(item);
    if (!queries.length) issues.push({ severity: "error", code: "testset.query", case: index, kind, message: "case must include query or queries" });
    if (!targets.length) issues.push({ severity: "error", code: "testset.target", case: index, kind, message: "case must include target_filename, target_filenames, target, note, or expected" });
    for (const target of targets) {
      if (!findNote(notes, target)) issues.push({ severity: "warn", code: "testset.target_missing", case: index, kind, target, message: `target note not found: ${target}` });
    }
  });
  return {
    file: toPosix(relative(vaultPath, path)),
    status: issues.some((item) => item.severity === "error") ? "error" : "ok",
    cases: entries.length,
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
  const tuneChannels = searchContext.channels ?? BUILTIN_SEARCH_CHANNELS;
  const startupTrials = Math.max(1, Math.min(30, Math.floor(trials / 4) || 1));
  for (let i = 0; i < trials; i += 1) {
    const params = i < startupTrials ? randomTuneParams(rng, tuneChannels) : sampleTpeLite(history, rng, tuneChannels);
    const evaluation = await evaluateTunePack(searchContext, pack, params);
    const loss = tuneLoss(evaluation);
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

function randomTuneParams(rng, channels = CHANNELS) {
  return {
    threshold: Number((0.05 + rng() * 0.5).toFixed(4)),
    cap: 5 + Math.floor(rng() * 26),
    weights: Object.fromEntries(channels.map((channel) => [channel.name, Number((rng() * 0.4).toFixed(4))]))
  };
}

function sampleTpeLite(history, rng, channels = CHANNELS) {
  const sorted = [...history].sort((a, b) => a.loss - b.loss);
  const goodCount = Math.max(1, Math.ceil(sorted.length * 0.2));
  const good = limitPool(sorted.slice(0, goodCount), 64);
  const bad = limitPool(sorted.slice(goodCount), 128);
  const fallbackBad = limitPool(sorted, 128);
  const goodStats = paramStats(good);
  const badStats = paramStats(bad.length ? bad : fallbackBad);
  let bestCandidate = randomTuneParams(rng, channels);
  let bestScore = -Infinity;
  for (let i = 0; i < 24; i += 1) {
    const candidate = sampleAroundGood(good, rng, channels);
    const score = densityRatio(candidate, goodStats, badStats);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }
  return bestCandidate;
}

function sampleAroundGood(good, rng, channels = CHANNELS) {
  const threshold = clamp(sampleNormal(mean(good.map((trial) => trial.params.threshold)), std(good.map((trial) => trial.params.threshold)) || 0.08, rng), 0.05, 0.55);
  const cap = Math.round(clamp(sampleNormal(mean(good.map((trial) => trial.params.cap)), std(good.map((trial) => trial.params.cap)) || 4, rng), 5, 30));
  const weights = {};
  for (const channel of channels) {
    const values = good.map((trial) => trial.params.weights[channel.name] ?? channel.defaultWeight);
    weights[channel.name] = Number(clamp(sampleNormal(mean(values), std(values) || 0.06, rng), 0, 0.4).toFixed(4));
  }
  return { threshold: Number(threshold.toFixed(4)), cap, weights };
}

function limitPool(items, maxItems) {
  if (items.length <= maxItems) return items;
  if (maxItems <= 1) return [items[0]];
  const out = [];
  const step = (items.length - 1) / (maxItems - 1);
  for (let i = 0; i < maxItems; i += 1) {
    out.push(items[Math.round(i * step)]);
  }
  return out;
}

function paramStats(trials) {
  const rows = trials.map((trial) => flattenParams(trial.params));
  const keys = new Set(rows.flatMap((row) => Object.keys(row)));
  const stats = {};
  for (const key of keys) {
    const values = rows.map((row) => row[key]).filter((value) => Number.isFinite(value));
    stats[key] = { mean: mean(values), std: std(values) || 0.05 };
  }
  return stats;
}

function densityRatio(candidate, goodStats, badStats) {
  const params = flattenParams(candidate);
  let goodDensity = 1;
  let badDensity = 1;
  for (const [key, value] of Object.entries(params)) {
    const good = goodStats[key] ?? { mean: value, std: 0.05 };
    const bad = badStats[key] ?? { mean: value, std: 0.05 };
    goodDensity *= gaussianDensity(value, good.mean, good.std);
    badDensity *= gaussianDensity(value, bad.mean, bad.std);
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
${prefix} context "keyword" --size medium --format markdown
${prefix} view "Note Title" --full
${prefix} search "keyword"
\`\`\`

Start IPA/vault tasks with \`context\` to gather a compact note-centered pack. Use \`view --full\` for selected notes. Use \`search\` only when the topic changes, context is missing, or additional notes may be relevant.

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
${prefix} context "keyword" --size medium --format markdown
${prefix} view "Note Title" --full
${prefix} search "keyword"
${prefix} validator
${prefix} formatter plan --note "Edited Note"
\`\`\`

Start IPA/vault work with \`${prefix} context "keyword" --size medium --format markdown\`. Use \`search\` only when the topic changes, context is insufficient, or you need discovery beyond the current context.

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

const vaultPath = ${JSON.stringify(vaultPath)};
const prefix = "ipa";

const lines = [
  "[IPA CLI]",
  "Use plain ipa commands; project-local .ipa-profile/.ipa-config can select the vault.",
  "For a new IPA/vault task, start with a compact context pack. Continue from existing conversation context when it is sufficient.",
  "Use search only when the topic changed, context is missing, or additional notes may be relevant.",
  "Do not paste raw file paths or the full user prompt into context. Pick a short keyword or an exact note title.",
  \`Bootstrap: \${prefix} context "keyword" --size small --format markdown\`,
  \`Known note: \${prefix} context "Note Title" --by-note --size small --format markdown\`,
  \`View:      \${prefix} view "Note Title" --full\`,
  \`Discover:  \${prefix} search "keyword"\`
];

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

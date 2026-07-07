import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import {
  appendFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  date_format: "YYYY/MM/DD (ddd) HH:mm:ss",
  exclude: []
};

const CACHE_SCHEMA = "notes-v2";

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
  { code: "ipa.frontmatter.date_format", category: "frontmatter", severity: "warn", scope: "note", fixable: true },
  { code: "ipa.content.absolute_path", category: "content", severity: "warn", scope: "note", fixable: true },
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

function isValidExcalidrawData(data) {
  return Boolean(
    data &&
    typeof data === "object" &&
    data.type === "excalidraw" &&
    (!data.elements || Array.isArray(data.elements)) &&
    (!data.appState || (typeof data.appState === "object" && !Array.isArray(data.appState)))
  );
}

function isExcalidrawJsonDocument(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    return isValidExcalidrawData(JSON.parse(trimmed));
  } catch {
    return false;
  }
}

function hasExcalidrawMarkdownSections(body) {
  const normalized = String(body ?? "").replace(/\r\n/g, "\n");
  return /^#\s+Excalidraw Data\s*$/im.test(normalized) &&
    /^##\s+Drawing\s*$/im.test(normalized);
}

function isExcalidrawMarkdownPath(relPath) {
  return toPosix(String(relPath ?? "")).toLowerCase().endsWith(".excalidraw.md");
}

export function isExcalidrawMarkdownFile(relPath, raw) {
  const text = String(raw ?? "").replace(/\r\n/g, "\n");
  const { frontmatter, body } = readFrontmatter(text);
  return isExcalidrawMarkdownPath(relPath) ||
    Object.hasOwn(frontmatter, "excalidraw-plugin") ||
    Object.hasOwn(frontmatter, "excalidraw") ||
    hasExcalidrawMarkdownSections(body) ||
    isExcalidrawJsonDocument(body);
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

function renderDefaultConfigYaml(folders) {
  const m = DEFAULT_MAPPING;
  return [
    "# .ipa/config.yaml — IPA 볼트 설정 (mechanism in CLI, policy in vault)",
    "# 폴더 이름을 볼트에 맞추세요 — 볼트를 폴더 이름에 맞추지 마세요.",
    "# 아래 folders/fields 값은 볼트의 기존 구조를 그대로 적어 넣는 자리입니다.",
    "",
    "mapping:",
    "  # frontmatter 필드 이름 — 볼트가 이미 쓰는 키로 바꾸세요.",
    "  fields:",
    `    note_type: ${yamlScalar(m.note_type)}`,
    `    refs: ${yamlScalar(m.refs)}`,
    `    tags: ${yamlScalar(m.tags)}`,
    `    created_at: ${yamlScalar(m.created_at)}`,
    `    updated_at: ${yamlScalar(m.updated_at)}`,
    `    aliases: ${yamlScalar(m.aliases)}`,
    "  # 최상위 폴더 이름 — 볼트의 실제 폴더명으로 바꾸세요 (예: Inbox, Projects, Archive).",
    "  folders:",
    `    inbox: ${yamlScalar(folders.inbox)}`,
    `    project: ${yamlScalar(folders.project)}`,
    `    archive: ${yamlScalar(folders.archive)}`,
    "  # 날짜 표기 형식.",
    `  date_format: ${yamlScalar(m.date_format)}`,
    "files:",
    "  # 검색/검증에서 제외할 glob 목록.",
    "  exclude: []",
    ""
  ].join("\n");
}

export async function configInit(vaultPath, options = {}) {
  const configPath = join(vaultPath, ".ipa", "config.yaml");
  const rel = toPosix(relative(vaultPath, configPath));
  const exists = existsSync(configPath);
  if (exists && !options.force) {
    throw new Error(`${rel} already exists. Pass --force to overwrite.`);
  }
  const folders = {
    inbox: options.inbox || DEFAULT_MAPPING.inbox_dir,
    project: options.project || DEFAULT_MAPPING.project_dir,
    archive: options.archive || DEFAULT_MAPPING.archive_dir
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, renderDefaultConfigYaml(folders), "utf8");
  // Seed the operating-rules fragment so onboarding has a place to write vault
  // policy that has no config slot. Never overwrite an existing one — it is
  // vault-owned and re-rendered into managed prompts via `ipa harness update`.
  const fragmentPath = join(harnessFragmentsRoot(vaultPath), "prompt.md");
  const fragmentExists = existsSync(fragmentPath);
  if (!fragmentExists) {
    await mkdir(dirname(fragmentPath), { recursive: true });
    await writeFile(fragmentPath, operatingRulesFragmentTemplate(), "utf8");
  }
  return {
    operation: "config-init",
    path: rel,
    created: !exists,
    overwritten: exists,
    inbox: folders.inbox,
    project: folders.project,
    archive: folders.archive,
    fragment_path: toPosix(relative(vaultPath, fragmentPath)),
    fragment_created: !fragmentExists,
    next_steps: ["ipa doctor", "ipa convention"]
  };
}

function operatingRulesFragmentTemplate() {
  return [
    "## Vault Operating Rules",
    "<!-- 이 볼트만의 운영 규칙. `ipa harness update <target>`로 관리 프롬프트에 반영됩니다.",
    "     아래 예시 중 해당하는 것만 남기고 나머지는 지우거나 새로 쓰세요. -->",
    "<!-- 예) 작업/임시 문서는 `99 Workbench/{프로젝트}/`에 둔다 -->",
    "<!-- 예) 폴더 이름은 볼트에 맞춘다 — 볼트를 폴더 이름에 맞추지 않는다 (폴더 rename·대량 이동 금지) -->",
    "<!-- 예) 마이그레이션·정리는 소수 노트 시범 후 확인받고 진행한다 -->",
    "<!-- 예) 제목에 날짜 프리픽스를 붙이지 않는다 -->",
    ""
  ].join("\n");
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
  const files = await activeMarkdownFiles(vaultPath, mapping);
  const notes = [];
  for (const file of files) {
    notes.push(noteFromFile(vaultPath, file.path, file.raw, mapping));
  }
  return notes;
}

function noteFromFile(vaultPath, path, raw, mapping = DEFAULT_MAPPING) {
  const relPath = toPosix(relative(vaultPath, path));
  const { frontmatter, body } = readFrontmatter(raw);
  const id = normalizeTitle(basename(path, ".md"));
  const refs = asList(frontmatter[mapping.refs]).map(stripWiki).filter(Boolean);
  const tags = asList(frontmatter[mapping.tags]).map((tag) => String(tag).replace(/^#/, ""));
  const aliases = mapping.aliases ? asList(frontmatter[mapping.aliases]).map(normalizeTitle) : [];
  return {
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
  };
}

async function activeMarkdownFileStats(vaultPath, mapping = DEFAULT_MAPPING) {
  const excludes = asList(mapping.exclude);
  const files = await walkFiles(vaultPath, (path, relPath) =>
    extname(path).toLowerCase() === ".md" && !isExcludedPath(relPath, excludes)
  );
  const rows = [];
  for (const path of files.sort()) {
    const relPath = toPosix(relative(vaultPath, path));
    if (isExcalidrawMarkdownPath(relPath)) continue;
    try {
      const raw = await readFile(path, "utf8");
      if (isExcalidrawMarkdownFile(relPath, raw)) continue;
    } catch {
      // Cache diff can rely on stat metadata for unchanged unreadable files.
    }
    const fileStat = await stat(path);
    rows.push({
      path,
      relPath,
      byteSize: fileStat.size,
      mtimeMs: fileStat.mtimeMs
    });
  }
  return rows;
}

async function activeMarkdownFiles(vaultPath, mapping = DEFAULT_MAPPING) {
  const excludes = asList(mapping.exclude);
  const files = await walkFiles(vaultPath, (path, relPath) =>
    extname(path).toLowerCase() === ".md" && !isExcludedPath(relPath, excludes)
  );
  const rows = [];
  for (const path of files.sort()) {
    const relPath = toPosix(relative(vaultPath, path));
    const raw = await readFile(path, "utf8");
    if (isExcalidrawMarkdownFile(relPath, raw)) continue;
    rows.push({
      path,
      relPath,
      raw
    });
  }
  return rows;
}

async function excludedMarkdownFiles(vaultPath, mapping = DEFAULT_MAPPING) {
  const excludes = asList(mapping.exclude);
  const files = await walkFiles(vaultPath, (path, relPath) =>
    extname(path).toLowerCase() === ".md" && isExcludedPath(relPath, excludes)
  );
  const maybeActive = await walkFiles(vaultPath, (path, relPath) =>
    extname(path).toLowerCase() === ".md" && !isExcludedPath(relPath, excludes)
  );
  for (const path of maybeActive.sort()) {
    const relPath = toPosix(relative(vaultPath, path));
    const raw = await readFile(path, "utf8");
    if (isExcalidrawMarkdownFile(relPath, raw)) files.push(path);
  }
  return files.sort();
}

function cacheFileEntry(note, fileStat = null) {
  return {
    note: note.id,
    path: note.relPath,
    sha256: sha256(note.raw),
    size: note.raw.length,
    byte_size: fileStat?.byteSize,
    mtime_ms: fileStat?.mtimeMs,
    type: note.type,
    refs: note.refs,
    tags: note.tags,
    aliases: note.aliases,
    links: note.links
  };
}

function noteSummaryFromCacheEntry(vaultPath, entry) {
  const relPath = toPosix(String(entry.path ?? ""));
  const notePath = join(vaultPath, relPath);
  return {
    id: normalizeTitle(entry.note ?? basename(relPath, ".md")),
    path: notePath,
    relPath,
    folder: toPosix(dirname(relPath)),
    raw: "",
    frontmatter: {},
    body: "",
    type: String(entry.type ?? ""),
    refs: asList(entry.refs).map(stripWiki).filter(Boolean),
    tags: asList(entry.tags).map((tag) => String(tag).replace(/^#/, "")),
    aliases: asList(entry.aliases).map(normalizeTitle),
    links: asList(entry.links).map(normalizeTitle).filter(Boolean),
    headings: []
  };
}

function hasViewCacheMetadata(entry) {
  return Boolean(
    entry &&
    typeof entry.path === "string" &&
    typeof entry.note === "string" &&
    Number.isFinite(Number(entry.byte_size)) &&
    Number.isFinite(Number(entry.mtime_ms)) &&
    Array.isArray(entry.refs) &&
    Array.isArray(entry.tags) &&
    Array.isArray(entry.aliases) &&
    Array.isArray(entry.links)
  );
}

function sameMtime(left, right) {
  return Math.abs(Number(left) - Number(right)) < 1;
}

async function readCacheFileEntries(vaultPath) {
  const filesPath = join(vaultPath, ".ipa", "cache", "files.jsonl");
  if (!existsSync(filesPath)) return null;
  const lines = (await readFile(filesPath, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const entries = [];
  try {
    for (const line of lines) entries.push(JSON.parse(line));
  } catch {
    return null;
  }
  if (!entries.every(hasViewCacheMetadata)) return null;
  return entries;
}

async function cacheFileDiff(vaultPath, mapping = DEFAULT_MAPPING, entries = null) {
  const cachedEntries = entries ?? await readCacheFileEntries(vaultPath);
  if (!cachedEntries) return null;
  const currentFiles = await activeMarkdownFileStats(vaultPath, mapping);
  const entriesByPath = new Map(cachedEntries.map((entry) => [toPosix(entry.path).normalize("NFC"), entry]));
  const currentByPath = new Map(currentFiles.map((file) => [file.relPath.normalize("NFC"), file]));
  const added = [];
  const changed = [];
  const deleted = [];
  const unchanged = [];

  for (const file of currentFiles) {
    const entry = entriesByPath.get(file.relPath.normalize("NFC"));
    if (!entry) {
      added.push(file);
    } else if (Number(entry.byte_size) !== file.byteSize || !sameMtime(entry.mtime_ms, file.mtimeMs)) {
      changed.push(file);
    } else {
      unchanged.push(file);
    }
  }
  for (const entry of cachedEntries) {
    const relPath = toPosix(entry.path).normalize("NFC");
    if (!currentByPath.has(relPath)) deleted.push(entry);
  }

  return { entries: cachedEntries, currentFiles, added, changed, deleted, unchanged };
}

function hasCacheFileChanges(diff) {
  return Boolean(diff && (diff.added.length || diff.changed.length || diff.deleted.length));
}

function cacheChangeSummary(diff) {
  return {
    added: diff?.added.length ?? 0,
    changed: diff?.changed.length ?? 0,
    deleted: diff?.deleted.length ?? 0
  };
}

async function loadCachedNoteSummaries(vaultPath, mapping = DEFAULT_MAPPING) {
  const manifest = await readCacheManifest(vaultPath);
  if (manifest?.cache_schema !== CACHE_SCHEMA) return null;
  if (manifest?.mapping_fingerprint !== mappingFingerprint(mapping)) return null;
  if (manifest?.plugin_fingerprint !== await pluginFingerprint(vaultPath)) return null;
  const entries = await readCacheFileEntries(vaultPath);
  if (!entries) return null;
  const diff = await cacheFileDiff(vaultPath, mapping, entries);
  if (!diff || hasCacheFileChanges(diff)) return null;
  return entries.map((entry) => noteSummaryFromCacheEntry(vaultPath, entry));
}

export async function loadNotesForView(vaultPath, mapping = DEFAULT_MAPPING) {
  return await loadCachedNoteSummaries(vaultPath, mapping) ??
    await refreshCachedNoteSummaries(vaultPath, mapping) ??
    await loadNotes(vaultPath, mapping);
}

async function refreshCachedNoteSummaries(vaultPath, mapping = DEFAULT_MAPPING) {
  const result = await rebuildCache(vaultPath, { allowFull: false });
  if (!result) return null;
  return await loadCachedNoteSummaries(vaultPath, mapping);
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

function fuzzyNameScore(queryLower, name, precomputedQueryTrigrams = null, precomputedNameTrigrams = null) {
  if (!queryLower) return 0;
  const rawName = String(name ?? "");
  const lower = rawName.toLowerCase();
  if (lower === queryLower) return 1;
  if (lower.includes(queryLower)) return 1;
  const noSpace = queryLower.replace(/\s+/g, "");
  if (noSpace && lower.replace(/\s+/g, "").includes(noSpace)) return 1;
  const queryTrigrams = precomputedQueryTrigrams ?? new Set(jamoTrigrams(queryLower));
  if (queryTrigrams.size) {
    const nameTrigrams = precomputedNameTrigrams ?? new Set(jamoTrigrams(name));
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

// BM25 over jamo trigrams as an inverted index (term -> postings of
// [docIndex, tf] pairs). Building it tokenizes every note body, which
// dominates search startup, so the built index is persisted under
// .ipa/cache/bm25.bin and reloaded while the vault files are unchanged.
function bm25TokenizeNote(note, termToIndex) {
  const tokens = jamoTrigrams(note.body ? `${note.id}\n${note.body}` : note.id);
  const tf = new Map();
  for (const token of tokens) {
    let termIndex = termToIndex.get(token);
    if (termIndex === undefined) {
      termIndex = termToIndex.size;
      termToIndex.set(token, termIndex);
    }
    tf.set(termIndex, (tf.get(termIndex) ?? 0) + 1);
  }
  return { tf, length: tokens.length };
}

function assembleBm25(notes, docTfs, docLen, termToIndex) {
  const nTerms = termToIndex.size;
  const df = new Uint32Array(nTerms);
  let totalEntries = 0;
  for (const tf of docTfs) {
    totalEntries += tf.size;
    for (const termIndex of tf.keys()) df[termIndex] += 1;
  }
  const postingsOffsets = new Uint32Array(nTerms + 1);
  for (let i = 0; i < nTerms; i += 1) postingsOffsets[i + 1] = postingsOffsets[i] + df[i];
  const postings = new Uint32Array(totalEntries * 2);
  const cursor = Uint32Array.from(postingsOffsets.subarray(0, nTerms));
  for (let docIndex = 0; docIndex < docTfs.length; docIndex += 1) {
    for (const [termIndex, count] of docTfs[docIndex]) {
      const slot = cursor[termIndex] * 2;
      postings[slot] = docIndex;
      postings[slot + 1] = count;
      cursor[termIndex] += 1;
    }
  }
  const nDocs = notes.length;
  let totalLen = 0;
  for (const len of docLen) totalLen += len;
  const avgdl = totalLen / Math.max(nDocs, 1);
  const idf = new Float64Array(nTerms);
  for (let i = 0; i < nTerms; i += 1) {
    idf[i] = Math.log(1 + (nDocs - df[i] + 0.5) / (df[i] + 0.5));
  }
  return {
    termToIndex,
    docIds: notes.map((note) => note.id),
    docPaths: notes.map((note) => note.relPath),
    postingsOffsets,
    postings,
    docLen,
    idf,
    avgdl,
    nDocs,
    k1: 1.5,
    b: 0.75
  };
}

function buildBm25Index(notes) {
  const termToIndex = new Map();
  const docTfs = [];
  const docLen = new Uint32Array(notes.length);
  for (let docIndex = 0; docIndex < notes.length; docIndex += 1) {
    const { tf, length } = bm25TokenizeNote(notes[docIndex], termToIndex);
    docTfs.push(tf);
    docLen[docIndex] = length;
  }
  return assembleBm25(notes, docTfs, docLen, termToIndex);
}

// Rebuild the index after a partial vault change without re-tokenizing
// unchanged notes: their term frequencies are recovered from the previous
// index's postings (term indices stay stable because the old term table is
// extended, never reordered). Only changed/new notes run the tokenizer, which
// dominates full-build cost. Produces scores identical to a full rebuild.
function rebuildBm25Incremental(cached, notes, statsByPath) {
  const oldIndex = cached.index;
  const oldDocByPath = new Map();
  for (let i = 0; i < cached.docPaths.length; i += 1) oldDocByPath.set(cached.docPaths[i], i);
  const oldSigByPath = new Map(cached.files.map(([path, mtime, size]) => [path, `${mtime}:${size}`]));
  const reusedNewByOld = new Map();
  for (let newIndex = 0; newIndex < notes.length; newIndex += 1) {
    const note = notes[newIndex];
    const stat = statsByPath.get(note.relPath);
    const oldDoc = oldDocByPath.get(note.relPath);
    if (oldDoc !== undefined && stat && oldSigByPath.get(note.relPath) === `${stat[0]}:${stat[1]}`) {
      reusedNewByOld.set(oldDoc, newIndex);
    }
  }
  const termToIndex = new Map(oldIndex.termToIndex);
  const docTfs = notes.map(() => null);
  const docLen = new Uint32Array(notes.length);
  // Recover reused docs' term frequencies in one pass over the old postings.
  const nOldTerms = oldIndex.postingsOffsets.length - 1;
  for (let term = 0; term < nOldTerms; term += 1) {
    for (let p = oldIndex.postingsOffsets[term]; p < oldIndex.postingsOffsets[term + 1]; p += 1) {
      const oldDoc = oldIndex.postings[p * 2];
      const newIndex = reusedNewByOld.get(oldDoc);
      if (newIndex === undefined) continue;
      let tf = docTfs[newIndex];
      if (!tf) {
        tf = new Map();
        docTfs[newIndex] = tf;
      }
      tf.set(term, oldIndex.postings[p * 2 + 1]);
    }
  }
  for (const [oldDoc, newIndex] of reusedNewByOld) {
    docLen[newIndex] = oldIndex.docLen[oldDoc];
    if (!docTfs[newIndex]) docTfs[newIndex] = new Map();
  }
  for (let newIndex = 0; newIndex < notes.length; newIndex += 1) {
    if (docTfs[newIndex]) continue;
    const { tf, length } = bm25TokenizeNote(notes[newIndex], termToIndex);
    docTfs[newIndex] = tf;
    docLen[newIndex] = length;
  }
  return assembleBm25(notes, docTfs, docLen, termToIndex);
}

// One pass over the postings of each query term; returns raw scores per
// docIndex (aligned with index.docIds).
function bm25QueryScores(index, queryTokens) {
  const scores = new Float64Array(index.nDocs);
  const avgdl = Math.max(index.avgdl, 1);
  const seen = new Set();
  for (const token of queryTokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    let repeats = 0;
    for (const item of queryTokens) if (item === token) repeats += 1;
    const termIndex = index.termToIndex.get(token);
    if (termIndex === undefined) continue;
    const idf = index.idf[termIndex];
    for (let p = index.postingsOffsets[termIndex]; p < index.postingsOffsets[termIndex + 1]; p += 1) {
      const docIndex = index.postings[p * 2];
      const frequency = index.postings[p * 2 + 1];
      const denom = frequency + index.k1 * (1 - index.b + index.b * index.docLen[docIndex] / avgdl);
      scores[docIndex] += repeats * idf * frequency * (index.k1 + 1) / Math.max(denom, 1e-9);
    }
  }
  return scores;
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

const BM25_CACHE_VERSION = 2;

function bm25CachePath(vaultPath) {
  return join(vaultPath, ".ipa", "cache", "bm25.bin");
}

// Freshness signature: the cached index is valid only while every note file
// is byte-identical (same path set, mtime, size) to the files the index was
// built from. Stat calls are cheap next to re-tokenizing the vault.
function bm25NoteStats(notes) {
  const stats = new Map();
  for (const note of notes) {
    try {
      const stat = statSync(note.path);
      stats.set(note.relPath, [Math.round(stat.mtimeMs), stat.size]);
    } catch {
      return null;
    }
  }
  return stats;
}

function bm25FileSignature(statsByPath) {
  const files = [...statsByPath.entries()].map(([path, [mtime, size]]) => [path, mtime, size]);
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return files;
}

function bm25SignaturesEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i][0] !== right[i][0] || left[i][1] !== right[i][1] || left[i][2] !== right[i][2]) return false;
  }
  return true;
}

function copyTypedSection(buffer, offset, byteLength, TypedArray) {
  // Uint8Array#slice copies into a fresh, aligned ArrayBuffer; Buffer#slice
  // would alias the (possibly unaligned) pool allocation.
  const bytes = Uint8Array.prototype.slice.call(buffer, offset, offset + byteLength);
  return new TypedArray(bytes.buffer);
}

function writeBm25Cache(vaultPath, index, files) {
  try {
    const header = Buffer.from(JSON.stringify({
      version: BM25_CACHE_VERSION,
      nDocs: index.nDocs,
      avgdl: index.avgdl,
      k1: index.k1,
      b: index.b,
      docIds: index.docIds,
      docPaths: index.docPaths,
      nTerms: index.postingsOffsets.length - 1,
      postingsLength: index.postings.length,
      terms: [...index.termToIndex.keys()],
      files
    }), "utf8");
    const headerLength = Buffer.alloc(4);
    headerLength.writeUInt32LE(header.length, 0);
    const payload = Buffer.concat([
      headerLength,
      header,
      Buffer.from(index.postingsOffsets.buffer, index.postingsOffsets.byteOffset, index.postingsOffsets.byteLength),
      Buffer.from(index.postings.buffer, index.postings.byteOffset, index.postings.byteLength),
      Buffer.from(index.docLen.buffer, index.docLen.byteOffset, index.docLen.byteLength),
      Buffer.from(index.idf.buffer, index.idf.byteOffset, index.idf.byteLength)
    ]);
    const path = bm25CachePath(vaultPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, payload);
    renameSync(`${path}.tmp`, path);
  } catch {
    // Persisting the index is an optimization; never fail the search over it.
  }
}

function loadBm25Cache(vaultPath) {
  const path = bm25CachePath(vaultPath);
  if (!existsSync(path)) return null;
  try {
    const buffer = readFileSync(path);
    const headerLength = buffer.readUInt32LE(0);
    const header = JSON.parse(buffer.toString("utf8", 4, 4 + headerLength));
    if (header.version !== BM25_CACHE_VERSION) return null;
    if (!Array.isArray(header.docPaths) || header.docPaths.length !== header.nDocs) return null;
    let offset = 4 + headerLength;
    const postingsOffsets = copyTypedSection(buffer, offset, (header.nTerms + 1) * 4, Uint32Array);
    offset += (header.nTerms + 1) * 4;
    const postings = copyTypedSection(buffer, offset, header.postingsLength * 4, Uint32Array);
    offset += header.postingsLength * 4;
    const docLen = copyTypedSection(buffer, offset, header.nDocs * 4, Uint32Array);
    offset += header.nDocs * 4;
    const idf = copyTypedSection(buffer, offset, header.nTerms * 8, Float64Array);
    const terms = Array.isArray(header.terms) ? header.terms : [];
    if (terms.length !== header.nTerms) return null;
    const termToIndex = new Map();
    for (let i = 0; i < terms.length; i += 1) termToIndex.set(terms[i], i);
    return {
      index: {
        termToIndex,
        docIds: header.docIds,
        docPaths: header.docPaths,
        postingsOffsets,
        postings,
        docLen,
        idf,
        avgdl: header.avgdl,
        nDocs: header.nDocs,
        k1: header.k1,
        b: header.b
      },
      files: header.files,
      docPaths: header.docPaths
    };
  } catch {
    return null;
  }
}

function resolveBm25Index(vaultPath, notes) {
  if (!vaultPath) return buildBm25Index(notes);
  const statsByPath = bm25NoteStats(notes);
  const cached = loadBm25Cache(vaultPath);
  if (cached && statsByPath && cached.index.nDocs === notes.length && bm25SignaturesEqual(cached.files, bm25FileSignature(statsByPath))) {
    return cached.index;
  }
  // A stale cache still carries every unchanged note's postings — rebuild
  // incrementally instead of re-tokenizing the whole vault.
  const index = cached && statsByPath
    ? rebuildBm25Incremental(cached, notes, statsByPath)
    : buildBm25Index(notes);
  if (statsByPath) writeBm25Cache(vaultPath, index, bm25FileSignature(statsByPath));
  return index;
}

function prepareSearchNotes(notes, mapping = DEFAULT_MAPPING, options = {}) {
  const projectDir = mapping.project_dir ?? DEFAULT_MAPPING.project_dir;
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const lookup = makeNoteLookup(notes);
  const inProjectDir = (folder) => folder === projectDir || folder.startsWith(`${projectDir}/`);
  const prepared = notes.map((note) => {
    const names = [note.id, ...note.aliases];
    const searchNames = names.map(searchableTitle).filter(Boolean);
    const bodySearch = searchableTitle(note.body);
    return {
      note,
      names,
      searchNames,
      searchNameLowers: searchNames.map((name) => name.toLowerCase()),
      nameTrigramSets: searchNames.map((name) => new Set(jamoTrigrams(name))),
      idKey: searchableKey(note.id),
      bodyLower: bodySearch.toLowerCase(),
      bodyTokenSet: new Set(tokenize(`${searchNames.join(" ")} ${bodySearch}`)),
      keywordText: searchableTitle(`${note.refs.join(" ")} ${note.tags.join(" ")} ${note.aliases.join(" ")} ${note.body}`).toLowerCase(),
      isProject: inProjectDir(note.folder),
      hasProjectContext: inProjectDir(note.folder) ||
        note.refs.some((ref) => {
          const target = lookup(ref);
          return target && inProjectDir(target.folder);
        }),
      childBodyLowers: []
    };
  });
  // Map each index/root note to its children via an inverted ref index instead
  // of filtering all prepared notes for every index note (was O(index * n)).
  const isIndexLike = (note) => note.type === "index" || note.type === "root" || note.id.startsWith("🔖");
  const childrenByRefKey = new Map();
  for (const item of prepared) {
    if (isIndexLike(item.note)) continue;
    for (const refKey of new Set(item.note.refs.map((ref) => searchableKey(ref)))) {
      let list = childrenByRefKey.get(refKey);
      if (!list) { list = []; childrenByRefKey.set(refKey, list); }
      list.push(item);
    }
  }
  for (const item of prepared) {
    if (!isIndexLike(item.note)) continue;
    const children = childrenByRefKey.get(searchableKey(item.note.id)) ?? [];
    item.childBodyLowers = children.map((candidate) => candidate.bodyLower);
  }
  prepared.notes = notes;
  prepared.noteById = noteById;
  prepared.lookup = lookup;
  prepared.bm25 = resolveBm25Index(options.vaultPath ?? null, notes);
  // The related channel is the only consumer of this index; skip the build
  // when the channel is disabled for the vault.
  prepared.relatedCandidatesBySeed = options.related === false ? new Map() : buildRelatedCandidateIndex(notes);
  return prepared;
}

function prepareSearchQuery(query, preparedNotes) {
  const raw = searchableTitle(query);
  const lower = raw.toLowerCase();
  const trigrams = jamoTrigrams(raw);
  const bm25Scores = new Map();
  const childBm25Scores = new Map();
  const bm25 = preparedNotes.bm25;
  if (trigrams.length && bm25?.nDocs > 0) {
    const rawScores = bm25QueryScores(bm25, trigrams);
    let maxRaw = 0;
    for (const score of rawScores) if (score > maxRaw) maxRaw = score;
    if (maxRaw > 0) {
      const lookup = preparedNotes.lookup ?? ((name) => findNote(preparedNotes.notes ?? [], name));
      for (let docIndex = 0; docIndex < rawScores.length; docIndex += 1) {
        const score = rawScores[docIndex];
        if (score <= 0) continue;
        const child = preparedNotes.noteById?.get(bm25.docIds[docIndex]);
        if (!child) continue;
        bm25Scores.set(child.id, score / maxRaw);
        if (child.type === "index" || child.type === "root") continue;
        for (const ref of child.refs) {
          const target = lookup(ref);
          if (!target || (target.type !== "index" && target.type !== "root" && !target.id.startsWith("🔖"))) continue;
          childBm25Scores.set(target.id, Math.max(childBm25Scores.get(target.id) ?? 0, score / maxRaw));
        }
      }
    }
  }
  return {
    raw,
    lower,
    tokens: tokenize(raw),
    trigramSet: new Set(trigrams),
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

  const fuzzy = query.lower
    ? Math.max(0, ...prepared.searchNames.map((name, index) =>
        fuzzyNameScore(query.lower, name, query.trigramSet, prepared.nameTrigramSets?.[index])))
    : 0;
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

// Exact note lookup (id / id-lower / alias-lower) as O(1) maps, with the same
// fuzzy fallback as findNote. Reused across root/related index building so those
// passes don't call findNote (a full O(n) scan) inside per-note loops.
function makeNoteLookup(notes) {
  const byId = new Map();
  const byIdLower = new Map();
  const byAliasLower = new Map();
  for (const note of notes) {
    if (!byId.has(note.id)) byId.set(note.id, note);
    const idLower = note.id.toLowerCase();
    if (!byIdLower.has(idLower)) byIdLower.set(idLower, note);
    for (const alias of note.aliases) {
      const aliasLower = String(alias).toLowerCase();
      if (!byAliasLower.has(aliasLower)) byAliasLower.set(aliasLower, note);
    }
  }
  return (noteName) => {
    const normalized = normalizeTitle(noteName);
    const query = normalized.toLowerCase();
    const exact = byId.get(normalized) ?? byIdLower.get(query) ?? byAliasLower.get(query);
    if (exact) return exact;
    const scored = notes
      .map((note) => ({ note, score: noteNameScore(note, normalized) }))
      .filter((item) => item.score >= 0.65)
      .sort((a, b) => b.score - a.score || a.note.id.localeCompare(b.note.id));
    return scored[0]?.note ?? null;
  };
}

function buildRootSets(notes, lookup = null) {
  const find = lookup ?? makeNoteLookup(notes);
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
      const target = find(ref);
      for (const root of visit(target, seen)) roots.add(root);
    }
    rootSets.set(note.id, roots);
    return new Set(roots);
  };
  for (const note of notes) visit(note);
  return rootSets;
}

function buildRelatedCandidateIndex(notes) {
  const lookup = makeNoteLookup(notes);
  const rootSets = buildRootSets(notes, lookup);
  const key = (value) => searchableKey(value);

  // Inverted indexes so each seed only visits candidates that actually share a
  // feature, instead of scanning all notes (was O(n^2)). Grouping by
  // searchableKey exactly reproduces sameNoteName/shareNoteNames/hasNoteName.
  const refKeyToNotes = new Map();
  const rootToNotes = new Map();
  const tagToNotes = new Map();
  const linkKeyToNotes = new Map();
  const idKeyToNotes = new Map();
  const add = (map, mapKey, id) => {
    let set = map.get(mapKey);
    if (!set) { set = new Set(); map.set(mapKey, set); }
    set.add(id);
  };
  for (const note of notes) {
    for (const ref of note.refs) add(refKeyToNotes, key(ref), note.id);
    for (const root of rootSets.get(note.id) ?? []) add(rootToNotes, root, note.id);
    for (const tag of note.tags) add(tagToNotes, tag, note.id);
    for (const link of note.links) add(linkKeyToNotes, key(link), note.id);
    add(idKeyToNotes, key(note.id), note.id);
  }

  const orderById = new Map(notes.map((note, index) => [note.id, index]));
  const bySeed = new Map();
  for (const seed of notes) {
    const scores = new Map();
    const bump = (id, delta) => {
      if (id === seed.id) return;
      scores.set(id, (scores.get(id) ?? 0) + delta);
    };
    // +3 when refs share a name (boolean, like shareNoteNames)
    const refCandidates = new Set();
    for (const ref of seed.refs) for (const id of refKeyToNotes.get(key(ref)) ?? []) refCandidates.add(id);
    for (const id of refCandidates) bump(id, 3);
    // +2 when root sets intersect (boolean)
    const rootCandidates = new Set();
    for (const root of rootSets.get(seed.id) ?? []) for (const id of rootToNotes.get(root) ?? []) rootCandidates.add(id);
    for (const id of rootCandidates) bump(id, 2);
    // +1 per shared tag (count, matching seed.tags.filter(...).length)
    for (const tag of seed.tags) for (const id of tagToNotes.get(tag) ?? []) bump(id, 1);
    // +2 when either note links to the other (boolean)
    const linkCandidates = new Set();
    for (const id of linkKeyToNotes.get(key(seed.id)) ?? []) linkCandidates.add(id);
    for (const link of seed.links) for (const id of idKeyToNotes.get(key(link)) ?? []) linkCandidates.add(id);
    for (const id of linkCandidates) bump(id, 2);

    // Emit in notes order so the result matches the previous nested-loop
    // output — sort the sparse candidate set instead of scanning all notes.
    const related = [];
    for (const [id, score] of scores) {
      if (score > 0) related.push({ note: id, score });
    }
    related.sort((a, b) => (orderById.get(a.note) ?? 0) - (orderById.get(b.note) ?? 0));
    bySeed.set(seed.id, related);
  }
  return bySeed;
}

async function activeSearchParams(vaultPath, providedConfig = null) {
  const config = providedConfig ?? (await readVaultConfig(vaultPath)).config;
  const file = config.weights?.file;
  if (!file) return {};
  const path = tuneResultPath(vaultPath, file);
  if (!existsSync(path)) return {};
  // Tune result files carry full trial histories (tens of MB); parsing one on
  // every search just to read three params dominates startup. Cache the
  // extracted params keyed by the source file identity.
  const stat = statSync(path);
  const cachePath = join(vaultPath, ".ipa", "cache", "active-params.json");
  try {
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, "utf8"));
      if (cached.source === String(file) && cached.mtime_ms === Math.round(stat.mtimeMs) && cached.size === stat.size) {
        return cached.params ?? {};
      }
    }
  } catch {
    // Unreadable sidecar: fall through to the full parse below.
  }
  const payload = JSON.parse(await readFile(path, "utf8"));
  const params = payload.best?.params ?? payload.params ?? payload;
  const extracted = {
    threshold: params.threshold,
    cap: params.cap ?? params.max_results,
    weights: params.weights
  };
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({
      source: String(file),
      mtime_ms: Math.round(stat.mtimeMs),
      size: stat.size,
      params: extracted
    }, null, 2) + "\n", "utf8");
  } catch {
    // Best-effort cache; never fail the search over it.
  }
  return extracted;
}

function tuneResultPath(vaultPath, filename) {
  if (String(filename).startsWith("/") || String(filename).startsWith(".ipa/")) {
    return resolve(vaultPath, filename);
  }
  return join(vaultPath, ".ipa", "tune", "results", filename);
}

export async function searchVault(vaultPath, query, options = {}) {
  // options.notes lets callers that already loaded the vault (e.g.
  // buildContext) skip a second full disk load and parse.
  const context = await prepareSearchContext(vaultPath, options.notes ?? null);
  const result = await searchWithContext(context, query, options);
  await maybeRecordSearchEvent(vaultPath, result, options);
  return result;
}

// Several queries against one prepared context: the vault is loaded and the
// indexes are prepared once, then each query pays only its own scoring pass.
export async function searchVaultMany(vaultPath, queries, options = {}) {
  const context = await prepareSearchContext(vaultPath, options.notes ?? null);
  const results = [];
  for (const query of queries) {
    const result = await searchWithContext(context, query, options);
    await maybeRecordSearchEvent(vaultPath, result, options);
    results.push(result);
  }
  return { status: "ok", count: results.length, queries: results };
}

function envFlag(name) {
  const value = process.env[name];
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function hasPromptContext(context) {
  return Boolean(firstNonEmpty([
    context?.event_id,
    context?.prompt_event_id,
    context?.source_prompt,
    context?.prompt,
    context?.query
  ]));
}

function shouldRecordSearchEvent(options = {}, promptContext = {}) {
  if (options.logSearch !== undefined) return Boolean(options.logSearch);
  return envFlag("IPA_SEARCH_LOG") || envFlag("IPA_TUNE_LOG_SEARCH") || hasPromptContext(promptContext);
}

function tuneSearchLogPath(vaultPath) {
  return join(vaultPath, ".ipa", "tune", "logs", "search-events.jsonl");
}

function firstNonEmpty(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizePromptCwd(cwd) {
  const value = firstNonEmpty([cwd]);
  if (!value) return null;
  return resolve(value);
}

function promptContextKey(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function currentPromptContextPath(vaultPath, key = null) {
  const name = key ? `current-prompt-${key}.json` : "current-prompt.json";
  return join(vaultPath, ".ipa", "tune", "logs", name);
}

function currentPromptContextCandidates(vaultPath, options = {}) {
  const cwd = normalizePromptCwd(options.logCwd ?? options.cwd);
  const candidates = [];
  if (cwd) candidates.push({ path: currentPromptContextPath(vaultPath, promptContextKey(cwd)), scoped: true });
  candidates.push({ path: currentPromptContextPath(vaultPath), scoped: false });
  return candidates;
}

function runtimeSessionId(options = {}) {
  return firstNonEmpty([
    options.sessionId,
    process.env.IPA_SESSION_ID,
    process.env.CODEX_SESSION_ID,
    process.env.CLAUDE_SESSION_ID
  ]);
}

function promptContextMatchesRuntime(context, options = {}, scoped = false) {
  if (scoped) return true;
  const sessionId = runtimeSessionId(options);
  return Boolean(sessionId && context?.session_id === sessionId);
}

async function readCurrentPromptContext(path) {
  if (!existsSync(path)) return {};
  try {
    const context = JSON.parse(await readFile(path, "utf8"));
    const timestamp = Date.parse(context.ts ?? context.created_at ?? "");
    const ttlMs = Number(context.ttl_seconds ?? 1800) * 1000;
    if (Number.isFinite(timestamp) && Number.isFinite(ttlMs) && ttlMs > 0 && Date.now() - timestamp > ttlMs) {
      return {};
    }
    return context && typeof context === "object" ? context : {};
  } catch {
    return {};
  }
}

async function currentPromptContext(vaultPath, options = {}) {
  for (const candidate of currentPromptContextCandidates(vaultPath, options)) {
    const context = await readCurrentPromptContext(candidate.path);
    if (hasPromptContext(context) && promptContextMatchesRuntime(context, options, candidate.scoped)) {
      return context;
    }
  }
  return {};
}

async function maybeRecordSearchEvent(vaultPath, result, options = {}) {
  const promptContext = await currentPromptContext(vaultPath, options);
  if (!shouldRecordSearchEvent(options, promptContext)) return;
  const path = tuneSearchLogPath(vaultPath);
  const cwd = firstNonEmpty([options.logCwd, options.cwd, promptContext.cwd]);
  const agent = firstNonEmpty([
    options.agent,
    options.logAgent,
    process.env.IPA_SEARCH_ACTOR,
    process.env.IPA_AGENT,
    promptContext.agent
  ]);
  const sessionId = firstNonEmpty([
    options.sessionId,
    process.env.IPA_SESSION_ID,
    process.env.CODEX_SESSION_ID,
    process.env.CLAUDE_SESSION_ID,
    promptContext.session_id
  ]);
  const promptEventId = firstNonEmpty([
    options.promptEventId,
    process.env.IPA_PROMPT_EVENT_ID,
    promptContext.event_id,
    promptContext.prompt_event_id
  ]);
  const turnId = firstNonEmpty([
    options.turnId,
    process.env.IPA_TURN_ID,
    promptContext.turn_id,
    promptEventId
  ]);
  const sourcePrompt = firstNonEmpty([
    options.sourcePrompt,
    process.env.IPA_SOURCE_PROMPT,
    promptContext.source_prompt,
    promptContext.prompt,
    promptContext.query
  ]);
  const event = {
    schema_version: 1,
    event_id: `search_${randomUUID()}`,
    event_type: "search",
    ts: nowIso(),
    source: options.logSource ?? "search",
    agent,
    session_id: sessionId,
    turn_id: turnId,
    prompt_event_id: promptEventId,
    source_prompt: sourcePrompt,
    generated_query: result.query,
    cwd,
    query: result.query,
    threshold: result.threshold,
    max_results: result.max_results,
    count: result.count,
    results: (result.results ?? []).map((hit) => ({
      note: hit.note,
      score: hit.score,
      type: hit.type,
      path: hit.path
    }))
  };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(event) + "\n", "utf8");
}

export async function prepareSearchContext(vaultPath, notes = null) {
  const { config, mapping } = await readVaultConfig(vaultPath);
  if (!notes) notes = await loadNotes(vaultPath, mapping);
  const active = await activeSearchParams(vaultPath, config);
  const searchPlugins = await loadPluginModules(vaultPath, "search");
  const pluginChannels = [];
  const plugins = [];
  for (const plugin of searchPlugins) {
    const channel = normalizeSearchChannelPlugin(plugin);
    if (channel) pluginChannels.push(channel);
    else plugins.push(plugin);
  }
  const channels = resolveSearchChannels(config, pluginChannels);
  const preparedNotes = prepareSearchNotes(notes, mapping, {
    vaultPath,
    related: channels.some((channel) => channel.name === "related")
  });
  // A module may export postRank alongside search/channel exports.
  const postRankPlugins = searchPlugins.filter((plugin) => typeof plugin.module?.postRank === "function");
  return { vaultPath, config, mapping, notes, active, plugins, channels, preparedNotes, postRankPlugins, queryScoreCache: new Map() };
}

export async function searchWithContext(context, query, options = {}) {
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
  // Plugin channels may declare phase "related"/"project" to run after the
  // builtin passes of the same phase, mirroring BUILTIN_CHANNEL_PHASES.
  for (const phase of ["related", "project"]) {
    if (!channels.some((channel) => channel.source === "plugin" && channel.phase === phase)) continue;
    await applyPluginSearchChannels(rowsByNote, channels, {
      vaultPath: context.vaultPath,
      mapping: context.mapping,
      notes: context.notes,
      query,
      searchQuery: null,
      config: context.config ?? {},
      lookup: context.preparedNotes?.lookup ?? null,
      prepared: context.preparedNotes ?? null
    }, phase);
  }
  const notesById = context.preparedNotes?.noteById ?? new Map((context.notes ?? []).map((note) => [note.id, note]));
  const updatedKey = context.mapping?.updated_at ?? DEFAULT_MAPPING.updated_at;
  let hits = [...rowsByNote.values()]
    .map((row) => ({
      note: row.note,
      path: row.path,
      type: row.type,
      refs: row.refs,
      score: Number((weightedScore(row.channelScores, weights, channels) + row.pluginScore).toFixed(6)),
      reasons: { ...row.reasons, ...row.pluginReasons }
    }))
    .filter((hit) => options.showAll || hit.score >= threshold)
    .sort((a, b) => b.score - a.score || a.note.localeCompare(b.note));
  // Post-rank hook: plugins exporting postRank(hits, ctx) may re-order, drop,
  // or annotate the weighted hits before the cap is applied. The returned
  // array order is trusted as-is.
  for (const plugin of context.postRankPlugins ?? []) {
    const output = await plugin.module.postRank(hits, {
      query,
      notes: context.notes,
      mapping: context.mapping,
      vaultPath: context.vaultPath,
      config: context.config ?? {},
      lookup: context.preparedNotes?.lookup ?? null,
      threshold,
      cap,
      weights
    });
    if (Array.isArray(output)) hits = output;
  }
  hits = hits
    .slice(0, cap)
    .map((hit) => {
      const source = notesById.get(hit.note);
      return {
        ...hit,
        modified: source?.frontmatter?.[updatedKey] ?? null,
        snippet: source ? noteSnippet(source, 100) : null
      };
    });
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
  const pluginContext = {
    vaultPath,
    mapping,
    notes,
    query,
    searchQuery,
    config: context.config ?? {},
    lookup: preparedNotes.lookup ?? null,
    prepared: preparedNotes
  };
  await applyPluginSearchChannels(rowsByNote, channels, pluginContext);
  const resolveHitNote = preparedNotes.lookup ?? ((name) => findNote(notes, name));
  for (const hit of await runSearchPlugins(vaultPath, query, notes, mapping, plugins, pluginContext)) {
    const note = resolveHitNote(hit.note);
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

async function applyPluginSearchChannels(rowsByNote, channels, context, phase = "base") {
  for (const channel of channels.filter((item) => item.source === "plugin" && item.phase === phase)) {
    const output = await channel.search({
      query: context.query,
      preparedQuery: context.searchQuery,
      notes: context.notes,
      mapping: context.mapping,
      vaultPath: context.vaultPath,
      config: context.config ?? {},
      lookup: context.lookup ?? null,
      prepared: context.prepared ?? null
    });
    for (const hit of normalizeSearchChannelOutput(output, channel.path)) {
      const note = (context.lookup ?? ((name) => findNote(context.notes, name)))(hit.note);
      if (!note) continue;
      const row = rowsByNote.get(note.id);
      if (!row) continue;
      row.channelScores[channel.name] = Math.max(row.channelScores[channel.name] ?? 0, hit.score);
      row.reasons[channel.name] = hit.reason ?? { plugin: channel.path, score: hit.score };
    }
  }
}

async function runSearchPlugins(vaultPath, query, notes, mapping, plugins = null, extras = {}) {
  const modules = plugins ?? await loadPluginModules(vaultPath, "search");
  const hits = [];
  for (const plugin of modules) {
    if (typeof plugin.module?.search !== "function") continue;
    const output = await plugin.module.search(query, notes, {
      query,
      notes,
      mapping,
      vaultPath,
      config: extras.config ?? {},
      lookup: extras.lookup ?? null,
      prepared: extras.prepared ?? null
    });
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
  const rawPhase = String(descriptor?.phase ?? mod.phase ?? "base").trim();
  return {
    name,
    defaultWeight: Number.isFinite(defaultWeight) ? defaultWeight : 0.1,
    description: descriptor?.description ?? mod.description ?? `Search channel plugin ${basename(plugin.path)}`,
    source: "plugin",
    // Plugin channels may target the later scoring passes like the builtin
    // related/project channels do; anything unrecognized runs as base.
    phase: rawPhase === "related" || rawPhase === "project" ? rawPhase : "base",
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
  const notes = options.notes ?? await loadNotesForView(vaultPath, mapping);
  const note = findNote(notes, noteName);
  if (!note) throw new Error(`note not found: ${noteName}`);
  const raw = await readFile(note.path, "utf8");
  const target = noteFromRaw(note, raw, mapping);
  if (options.section) {
    return renderSectionNote(target, options.section);
  }
  if (options.full) return renderFullNote(target, notes, vaultPath);
  return renderOverviewNote(target, notes, vaultPath);
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

// Graph helpers surfaced on every rule context (validate / dry-run / formatter
// fix). A checkNote/checkVault rule counts an index's children or a note's
// inbound references without reimplementing the title-normalized matching (NFC
// + case-insensitive + emoji/whitespace) that countChildren/countBacklinks
// already apply, so CLI and the Obsidian host inherit identical semantics.
function ruleGraphContext(notes) {
  return {
    childCount: (note) => countChildren(note, notes),
    backlinkCount: (note) => countBacklinks(note, notes)
  };
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

export async function resolveNote(vaultPath, noteName) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const note = findNote(notes, noteName);
  if (!note) throw new Error(`note not found: ${noteName}`);
  return { note, mapping, notes };
}

export async function rewriteNote(vaultPath, noteName, rewrite, options = {}) {
  if (typeof rewrite !== "function") throw new Error("rewriteNote requires a rewrite function");
  const { note, mapping, notes } = await resolveNote(vaultPath, noteName);
  const document = IpaNoteDocument.fromNote(note, mapping);
  const rewritten = await rewrite(document, { vaultPath, note, mapping, notes });
  const nextText = typeof rewritten === "string"
    ? rewritten
    : typeof rewritten?.text === "string"
      ? rewritten.text
      : null;
  if (nextText === null) throw new Error("rewriteNote callback must return markdown text");
  const changed = nextText !== note.raw;
  const apply = options.apply !== false;
  const finalText = changed && options.syncUpdatedAt !== false
    ? syncUpdatedAtText(nextText, mapping)
    : nextText;
  if (changed && apply) await writeFile(note.path, finalText, "utf8");
  return {
    operation: "rewrite-note",
    note: note.id,
    path: note.relPath,
    changed,
    applied: changed && apply,
    updated_at_synced: finalText !== nextText,
    sha256_before: sha256(note.raw),
    sha256_after: sha256(finalText)
  };
}

function escapeRegExpText(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Core-backed writes keep the mapped updated_at field in sync so agents never
// need to touch time fields by hand. Only rewrites an existing field line.
function syncUpdatedAtText(text, mapping = DEFAULT_MAPPING, now = new Date()) {
  const key = mapping.updated_at;
  if (!key) return text;
  const normalized = String(text ?? "");
  if (!normalized.startsWith("---\n")) return normalized;
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return normalized;
  const head = normalized.slice(0, end + 1);
  const pattern = new RegExp(`^(${escapeRegExpText(key)}:[ \\t]*).*$`, "m");
  if (!pattern.test(head)) return normalized;
  return head.replace(pattern, `$1${JSON.stringify(formatVaultDate(now, mapping.date_format))}`) + normalized.slice(end + 1);
}

function noteSnippet(note, maxChars = 100) {
  const body = String(note.body ?? "");
  let text = "";
  const callout = body.match(/^>\s*\[!\w+\][+-]?[ \t]*([^\n]*)((?:\n>[^\n]*)*)/m);
  if (callout) {
    const block = String(callout[2] ?? "")
      .split("\n")
      .map((line) => line.replace(/^>\s?/, "").replace(/^[-*]\s+/, "").trim())
      .filter(Boolean)
      .join(" ");
    text = [String(callout[1] ?? "").trim(), block].filter(Boolean).join(" — ");
  }
  if (!text) {
    const line = body.split("\n").find((candidate) => {
      const trimmed = candidate.trim();
      return trimmed
        && !trimmed.startsWith("#")
        && !trimmed.startsWith("```")
        && !trimmed.startsWith("---")
        && !trimmed.startsWith("![");
    });
    text = String(line ?? "").trim()
      .replace(/^(?:>\s?)+/, "")
      .replace(/^\[!\w+\][+-]?\s*/, "")
      .replace(/^[-*]\s+/, "");
  }
  text = text
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
  if (text.length > maxChars) text = `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
  return text || null;
}

function setScalarFieldText(text, key, value) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  const end = normalized.startsWith("---\n") ? normalized.indexOf("\n---", 4) : -1;
  if (end === -1) {
    const parsed = readFrontmatter(normalized);
    parsed.frontmatter[key] = value;
    return writeFrontmatter(parsed.frontmatter, parsed.body);
  }
  const head = normalized.slice(0, end + 1);
  const pattern = new RegExp(`^(${escapeRegExpText(key)}:[ \\t]*).*$`, "m");
  if (!pattern.test(head)) return insertFrontmatterField(normalized, key, value);
  const rendered = typeof value === "string" && IPA_DATE_RE.test(value) ? JSON.stringify(value) : yamlScalar(value);
  return head.replace(pattern, `$1${rendered}`) + normalized.slice(end + 1);
}

// Frontmatter-only edits without exact-match text blocks. Scalar fields use a
// line-level rewrite; list fields (ref/tags) reuse the refactor list rewriter.
export async function setNoteField(vaultPath, noteName, field, options = {}) {
  const key = String(field ?? "").trim();
  if (!key) throw new Error("note set requires a frontmatter field name");
  const hasValue = options.value !== undefined;
  const adds = asList(options.add);
  const removes = asList(options.remove);
  if (!hasValue && !adds.length && !removes.length) {
    throw new Error("note set requires --value, --add, or --remove");
  }
  if (hasValue && (adds.length || removes.length)) {
    throw new Error("note set cannot combine --value with --add/--remove");
  }
  const { mapping } = await readVaultConfig(vaultPath);
  const isRefs = key === mapping.refs;
  const result = await rewriteNote(vaultPath, noteName, (document) => {
    if (hasValue) return setScalarFieldText(document.text, key, options.value);
    return rewriteListValue(document.text, key, (items) => {
      let next = [...items.map(String)];
      for (const value of adds) {
        const rendered = isRefs ? `[[${stripWiki(value)}]]` : String(value);
        if (!next.includes(rendered)) next.push(rendered);
      }
      if (removes.length) {
        next = next.filter((item) => {
          const plain = isRefs ? stripWiki(item) : String(item);
          return !removes.some((value) => (isRefs ? stripWiki(value) : String(value)) === plain);
        });
      }
      return next;
    }, null);
  }, {
    apply: options.apply,
    syncUpdatedAt: key === mapping.updated_at ? false : options.syncUpdatedAt
  });
  return { ...result, operation: "set-note-field", field: key };
}

// One call replaces the "traversal --down + view --full per child" loop:
// children of an index with modified date, section titles, and a short snippet.
export async function digestNote(vaultPath, noteName, options = {}) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const note = findNote(notes, noteName);
  if (!note) throw new Error(`note not found: ${noteName}`);
  const max = Number.isFinite(options.max) && options.max > 0 ? Math.floor(options.max) : 30;
  const snippetChars = Number.isFinite(options.snippetChars) && options.snippetChars > 0
    ? Math.floor(options.snippetChars)
    : 240;
  const children = childNotes(note, notes).sort((a, b) => a.id.localeCompare(b.id));
  const items = children.slice(0, max).map((child) => ({
    id: child.id,
    type: child.type,
    modified: child.frontmatter?.[mapping.updated_at] ?? null,
    headings: (child.headings ?? []).slice(0, 6).map((heading) => heading.title),
    snippet: noteSnippet(child, snippetChars)
  }));
  return {
    operation: "digest",
    note: note.id,
    type: note.type,
    snippet: noteSnippet(note, snippetChars),
    children_total: children.length,
    children_shown: items.length,
    items
  };
}

export async function replaceInNote(vaultPath, noteName, oldText, newText, options = {}) {
  const target = String(oldText ?? "");
  if (!target) throw new Error("replaceInNote requires non-empty oldText");
  let matches = 0;
  const result = await rewriteNote(vaultPath, noteName, (document) => {
    matches = document.text.split(target).length - 1;
    if (!matches) throw new Error(`target text not found in note: ${noteName}`);
    if (matches > 1 && !options.allowMultiple) {
      throw new Error(`target text matched ${matches} times in note: ${noteName}`);
    }
    return document.text.split(target).join(String(newText ?? ""));
  }, options);
  return { ...result, operation: "replace-in-note", matches };
}

export async function traversal(vaultPath, mode, noteName, options = {}) {
  const notes = options.notes ?? await loadNotes(vaultPath, (await readVaultConfig(vaultPath)).mapping);
  const note = findNote(notes, noteName);
  if (!note) throw new Error(`note not found: ${noteName}`);
  if (mode === "up") return { mode, note: note.id, paths: upwardPaths(note, notes) };
  if (mode === "down") return { mode, note: note.id, tree: downwardTree(note.id, notes) };
  if (mode === "siblings") return { mode, note: note.id, siblings: siblings(note, notes).map((item) => item.id) };
  if (mode === "root") return { mode, note: note.id, roots: upwardPaths(note, notes).map((path) => path[path.length - 1]).filter(Boolean) };
  throw new Error(`unknown traversal mode: ${mode}`);
}

// Compute up / down / siblings / root in one pass. Callers that already hold the
// parsed notes (e.g. a long-running UI) can pass them to skip loadNotes entirely.
export async function traversalAll(vaultPath, noteName, notes = null) {
  if (!notes) {
    const { mapping } = await readVaultConfig(vaultPath);
    // Use the .ipa/cache summary (refs/type) like viewNote — no full re-parse.
    notes = await loadNotesForView(vaultPath, mapping);
  }
  const note = findNote(notes, noteName);
  if (!note) throw new Error(`note not found: ${noteName}`);
  const paths = upwardPaths(note, notes);
  return {
    note: note.id,
    paths,
    tree: downwardTree(note.id, notes),
    siblings: siblings(note, notes).map((item) => item.id),
    roots: paths.map((path) => path[path.length - 1]).filter(Boolean)
  };
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
// Both formatVaultDate (render) and validDateValue (validate) drive off this one
// token table so a vault's mapping.date_format can never render a stamp that
// fails validation.
const DATE_FORMAT_TOKEN_RE = /YYYY|MM|DD|ddd|HH|mm|ss/g;
const DATE_FORMAT_TOKEN_PATTERNS = {
  YYYY: "\\d{4}",
  MM: "\\d{2}",
  DD: "\\d{2}",
  ddd: "[A-Z][a-z]{2}",
  HH: "\\d{2}",
  mm: "\\d{2}",
  ss: "\\d{2}"
};
const dateFormatRegexCache = new Map();

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

function dateFormatToRegExp(format) {
  const source = String(format || DEFAULT_MAPPING.date_format);
  let cached = dateFormatRegexCache.get(source);
  if (cached !== undefined) return cached;
  let re;
  try {
    const body = escapeRegExpText(source).replace(DATE_FORMAT_TOKEN_RE, (token) => DATE_FORMAT_TOKEN_PATTERNS[token]);
    re = new RegExp(`^${body}$`);
  } catch {
    re = IPA_DATE_RE;
  }
  dateFormatRegexCache.set(source, re);
  return re;
}

function validDateValue(value, format) {
  const text = String(value ?? "").trim();
  return dateFormatToRegExp(format).test(text) || ISO_DATE_RE.test(text);
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

// A note pollutes date formats when one mapped date field follows the vault
// convention while the other is an ISO timestamp. Vaults that use ISO for
// both fields consistently are left alone.
function mixedIsoDateFields(note, mapping) {
  const fields = [mapping.created_at, mapping.updated_at];
  const values = fields.map((field) => String(note.frontmatter?.[field] ?? ""));
  if (!values.some((value) => IPA_DATE_RE.test(value))) return [];
  return fields.filter((field, index) => ISO_DATE_RE.test(values[index]));
}

function pathAliasEntries(config) {
  const aliases = config?.path_aliases;
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) return [];
  return Object.entries(aliases)
    .map(([alias, prefix]) => [String(alias), String(prefix ?? "").replace(/\/+$/, "")])
    .filter(([alias, prefix]) => alias && prefix.startsWith("/"))
    .sort((a, b) => b[1].length - a[1].length);
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
          return formatVaultDate(fileStat?.birthtime ?? new Date(), ctx.mapping.date_format);
        }],
        [ctx.mapping.updated_at, () => formatVaultDate(new Date(), ctx.mapping.date_format)],
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
      const issues = [ctx.mapping.created_at, ctx.mapping.updated_at]
        .filter((field) => note.frontmatter[field] !== undefined && !validDateValue(note.frontmatter[field], ctx.mapping.date_format))
        .map((field) => noteIssue(this.code, note, `invalid date format in ${field}: ${note.frontmatter[field]}`));
      issues.push(...mixedIsoDateFields(note, ctx.mapping)
        .map((field) => noteIssue(this.code, note, `mixed date formats: ${field} is an ISO timestamp; formatter apply rewrites it to the vault date format`)));
      return issues;
    },
    fixNote(note, ctx) {
      if (!hasFrontmatterBlock(note.raw)) return note.raw;
      let text = note.raw;
      for (const field of mixedIsoDateFields(note, ctx.mapping)) {
        const parsed = new Date(String(note.frontmatter[field]));
        if (Number.isNaN(parsed.getTime())) continue;
        text = setScalarFieldText(text, field, formatVaultDate(parsed, ctx.mapping.date_format));
      }
      return text;
    }
  }),
  // Active only when the vault config declares path_aliases, e.g.
  //   path_aliases:
  //     ipa-cli: /Users/me/workspace/ipa-cli
  // Notes then use "ipa-cli/packages/..." instead of machine-specific paths.
  builtinRule("ipa.content.absolute_path", {
    checkNote(note, ctx) {
      const aliases = pathAliasEntries(ctx.config);
      if (!aliases.length) return [];
      const issues = [];
      for (const [alias, prefix] of aliases) {
        if (note.raw.includes(prefix)) {
          issues.push(noteIssue(this.code, note, `absolute path for alias '${alias}': ${prefix}`));
        }
      }
      return issues;
    },
    fixNote(note, ctx) {
      const aliases = pathAliasEntries(ctx.config);
      if (!aliases.length) return note.raw;
      let text = note.raw;
      for (const [alias, prefix] of aliases) {
        text = text.split(`${prefix}/`).join(`${alias}/`);
        text = text.split(prefix).join(alias);
      }
      return text;
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

export async function validateVault(vaultPath, notes = null, options = {}) {
  const { config, mapping } = await readVaultConfig(vaultPath);
  if (!notes) notes = await loadNotes(vaultPath, mapping);
  const ctx = {
    config,
    mapping,
    notes,
    vaultPath,
    ...ruleGraphContext(notes),
    excludedTitles: await loadExcludedMarkdownTitles(vaultPath, mapping),
    markdownTitles: await loadActiveMarkdownTitles(vaultPath, mapping),
    attachmentTitles: await loadAttachmentTitles(vaultPath, mapping)
  };
  const rules = await activeRulesForVault(vaultPath, config);
  let issues = [];
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
  // Note-scoped output: validation still runs vault-wide (vault-scope rules
  // need every note), but only issues attached to the requested notes are
  // returned — keeps agent-facing output proportional to the edit.
  const scopedNames = asList(options.notes ?? options.note);
  let scoped = null;
  if (scopedNames.length) {
    const targets = scopedNames.map((name) => {
      const note = findNote(notes, name);
      if (!note) throw new Error(`note not found: ${name}`);
      return note;
    });
    const targetIds = new Set(targets.map((note) => note.id));
    const targetPaths = new Set(targets.map((note) => note.relPath));
    issues = issues.filter((item) => targetIds.has(item.note) || targetPaths.has(item.path));
    scoped = targets.map((note) => note.id);
  }
  const result = { notes: notes.length, issues, status: issues.some((item) => item.severity === "error") ? "error" : "ok" };
  if (scoped) result.scope_notes = scoped;
  return result;
}

async function loadActiveMarkdownTitles(vaultPath, mapping) {
  const files = await activeMarkdownFiles(vaultPath, mapping);
  return markdownTitleSet(files.map((file) => file.path));
}

async function loadExcludedMarkdownTitles(vaultPath, mapping) {
  return markdownTitleSet(await excludedMarkdownFiles(vaultPath, mapping));
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

function formatVaultDate(date, format = DEFAULT_MAPPING.date_format) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pad = (value) => String(value).padStart(2, "0");
  const tokens = {
    YYYY: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()),
    ddd: days[date.getDay()],
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds())
  };
  return String(format ?? DEFAULT_MAPPING.date_format).replace(DATE_FORMAT_TOKEN_RE, (token) => tokens[token]);
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
  const allNotes = options.loadedNotes ?? await loadNotes(vaultPath, mapping);
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
  const validation = options.patchesOnly ? { issues: [] } : await validateVault(vaultPath, allNotes);
  const issues = targetIds.size
    ? validation.issues.filter((item) => targetIds.has(item.note) || notes.some((note) => note.relPath === item.path))
    : validation.issues;
  const patches = [];
  const ruleContext = {
    config,
    notes: allNotes,
    mapping,
    vaultPath,
    ...ruleGraphContext(allNotes),
    // apply-gated rules (e.g. date_modified) need apply context to emit a patch.
    // ruleApply lets a host run them at plan time even when fs apply is off —
    // Obsidian writes patches via its Vault API, not core's fs writer.
    apply: options.ruleApply ?? apply,
    MarkdownDocument,
    IpaNoteDocument,
    options: {
      note: targets.length === 1 ? targets[0].id : null,
      notes: targets.map((item) => item.id)
    }
  };
  patches.push(...await ruleFixPatches(notes, ruleContext, rules));
  const applied = apply ? await applyFormatterPatches(notes, patches, mapping) : undefined;
  return {
    summary: { issues: issues.length, patches: patches.length },
    patches,
    applied,
    issues
  };
}

async function applyFormatterPatches(notes, patches, mapping = DEFAULT_MAPPING) {
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
      // Stamp updated_at at write time so the post-write mtime stays inside
      // the date rule's tolerance window and the next plan run is clean.
      await writeFile(note.path, syncUpdatedAtText(text, mapping), "utf8");
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

const DOCTOR_CHECKS = ["config", "cache"];

export async function doctor(vaultPath, options = {}) {
  const check = options.check ? String(options.check) : null;
  if (check && !DOCTOR_CHECKS.includes(check)) {
    throw new Error(`unknown doctor check: ${check}. Expected ${DOCTOR_CHECKS.join(" or ")}`);
  }
  if (options.fixDirs) {
    for (const rel of [".ipa", ".ipa/cache", ".ipa/tune", ".ipa/plugins", ".ipa/plans", ".ipa/fixtures/contracts"]) {
      await mkdir(join(vaultPath, rel), { recursive: true });
    }
  }
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const issues = [];
  if ((!check || check === "config") && !existsSync(join(vaultPath, ".ipa", "config.yaml"))) {
    issues.push({ code: "doctor.config.missing", severity: "warn", message: ".ipa/config.yaml missing — run `ipa config init` to create it" });
  }
  const cacheRoot = join(vaultPath, ".ipa", "cache");
  if ((!check || check === "cache") && existsSync(cacheRoot)) {
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
  small: { maxChars: 4000, maxNotes: 2, relatedExcerpt: 120, neighborLimit: 3, contentMode: "overview" },
  medium: { maxChars: 10000, maxNotes: 3, relatedExcerpt: 220, neighborLimit: 5, contentMode: "overview" },
  large: { maxChars: 25000, maxNotes: 5, relatedExcerpt: 500, neighborLimit: 8, contentMode: "full" },
  full: { maxChars: 60000, maxNotes: 5, relatedExcerpt: 1000, neighborLimit: 12, contentMode: "full" }
};

function contextPreset(options = {}) {
  const key = options.full && !options.size ? "full" : String(options.size ?? "medium").toLowerCase();
  const preset = CONTEXT_SIZE_PRESETS[key] ?? CONTEXT_SIZE_PRESETS.medium;
  return {
    name: CONTEXT_SIZE_PRESETS[key] ? key : "medium",
    maxChars: Number(options.maxChars ?? preset.maxChars),
    maxNotes: Number(options.maxNotes ?? preset.maxNotes),
    relatedExcerpt: preset.relatedExcerpt,
    neighborLimit: preset.neighborLimit,
    contentMode: preset.contentMode
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

function noteLocationKind(note, mapping = DEFAULT_MAPPING) {
  if (!note) return "missing";
  if (isInFolder(note, mapping.inbox_dir)) return "inbox";
  if (isInFolder(note, mapping.project_dir)) return "project";
  if (isInFolder(note, mapping.archive_dir)) return "archive";
  return "other";
}

function noteLocation(note, mapping = DEFAULT_MAPPING) {
  if (!note) return { kind: "missing", folder: "", path: "" };
  return {
    kind: noteLocationKind(note, mapping),
    folder: note.folder,
    path: note.relPath
  };
}

function noteRef(note, query, excerptChars = 0, mapping = DEFAULT_MAPPING) {
  const item = {
    id: note.id,
    type: note.type,
    path: note.relPath,
    location: noteLocation(note, mapping)
  };
  if (excerptChars > 0) item.excerpt = excerptText(note.body, excerptChars, query);
  return item;
}

function noteRefs(items, query, limit, excerptChars, mapping = DEFAULT_MAPPING) {
  return uniqueNotes(items)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((note) => noteRef(note, query, excerptChars, mapping));
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

function refDetails(note, notes, mapping = DEFAULT_MAPPING) {
  return note.refs.map((ref) => {
    const target = findNote(notes, ref);
    return {
      id: ref,
      type: target?.type ?? "",
      path: target?.relPath ?? "",
      location: noteLocation(target, mapping)
    };
  });
}

function noteOverview(note) {
  return {
    headings: (note.headings ?? []).map((heading) => ({
      level: heading.level,
      title: heading.title,
      line: heading.line
    }))
  };
}

function traversalPathDetails(paths, notes, mapping = DEFAULT_MAPPING) {
  return paths.map((path) => path.map((id) => {
    const target = findNote(notes, id);
    return {
      id,
      type: target?.type ?? "",
      path: target?.relPath ?? "",
      location: noteLocation(target, mapping)
    };
  }));
}

function contextNote(note, notes, query, hit, preset, mapping = DEFAULT_MAPPING) {
  const limit = preset.neighborLimit;
  const relatedExcerpt = preset.relatedExcerpt;
  const upward = upwardPaths(note, notes).slice(0, limit);
  const item = {
    id: note.id,
    path: note.relPath,
    type: note.type,
    location: noteLocation(note, mapping),
    refs: note.refs,
    ref_details: refDetails(note, notes, mapping),
    tags: note.tags,
    score: hit?.score ?? null,
    reason: hit?.reason ?? null,
    content_mode: preset.contentMode,
    upward_paths: upward,
    traversal: {
      upward: traversalPathDetails(upward, notes, mapping)
    },
    backlinks: noteRefs(backlinkNotes(note, notes), query, limit, relatedExcerpt, mapping),
    siblings: noteRefs(siblings(note, notes), query, limit, relatedExcerpt, mapping),
    outlinks: noteRefs(outlinkNotes(note, notes), query, limit, relatedExcerpt, mapping),
    children: noteRefs(childNotes(note, notes), query, limit, relatedExcerpt, mapping)
  };
  if (preset.contentMode === "full") item.body = String(note.body ?? "").trimEnd();
  else item.overview = noteOverview(note);
  return item;
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

function contextCommands(contextNotes, query = "") {
  const first = contextNotes[0];
  if (!first) return [];
  const searchQuery = String(query ?? "").trim() || first.id;
  const commands = [
    `ipa search "${searchQuery}"`,
    `ipa view "${first.id}" --full`,
    first.type === "index" || first.type === "root"
      ? `ipa traversal --down "${first.id}"`
      : `ipa traversal --up "${first.id}"`,
    `ipa traversal --siblings "${first.id}"`
  ];
  if (first.tags?.[0] && first.tags[0] !== searchQuery) commands.push(`ipa search "${first.tags[0]}"`);
  return commands;
}

function contextSearchResults(results, notes, mapping = DEFAULT_MAPPING) {
  return results.map((hit) => {
    const note = findNote(notes, hit.note);
    return {
      note: hit.note,
      path: note?.relPath ?? hit.path ?? "",
      type: note?.type || hit.type || "?",
      refs: note?.refs ?? hit.refs ?? [],
      ref_details: note ? refDetails(note, notes, mapping) : [],
      tags: note?.tags ?? [],
      location: noteLocation(note, mapping),
      score: hit.score,
      reasons: hit.reasons
    };
  });
}

function contextRefDistribution(items, notes, mapping = DEFAULT_MAPPING) {
  const counts = {};
  for (const note of items) {
    for (const ref of note.refs ?? []) counts[ref] = (counts[ref] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ref, count]) => {
      const target = findNote(notes, ref);
      return {
        ref,
        count,
        type: target?.type ?? "",
        path: target?.relPath ?? "",
        location: noteLocation(target, mapping)
      };
    });
}

function contextTagDistribution(items) {
  const counts = {};
  for (const note of items) {
    for (const tag of note.tags ?? []) counts[tag] = (counts[tag] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));
}

export async function buildContext(vaultPath, query, options = {}) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const preset = contextPreset(options);
  const search = options.byNote
    ? { results: [{ note: findNote(notes, query)?.id, score: 1 }].filter((item) => item.note) }
    : await searchVault(vaultPath, query, { maxResults: options.maxResults ?? preset.maxNotes, threshold: 0, notes });
  const resultNotes = uniqueNotes(search.results.map((hit) => findNote(notes, hit.note)).filter(Boolean));
  const selected = resultNotes.slice(0, preset.maxNotes);
  const contextNotes = selected.map((note) =>
    contextNote(note, notes, query, search.results.find((hit) => sameNoteName(hit.note, note.id)), preset, mapping)
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
    search_results: contextSearchResults(search.results, notes, mapping),
    ref_distribution: contextRefDistribution(resultNotes, notes, mapping),
    tag_distribution: contextTagDistribution(resultNotes),
    edges: contextSubgraph(contextNotes, notes),
    sources: selected.map((note) => note.relPath),
    next_commands: contextCommands(contextNotes, query),
    warnings
  };
}

function mappingFingerprint(mapping) {
  return sha256(JSON.stringify(Object.keys(mapping).sort().map((key) => [key, mapping[key]])));
}

async function readCacheManifest(vaultPath) {
  const path = join(vaultPath, ".ipa", "cache", "manifest.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function writeCachePayload(cacheDir, manifest, files, graph) {
  await writeFile(join(cacheDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(join(cacheDir, "files.jsonl"), files.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  await writeFile(join(cacheDir, "graph.json"), JSON.stringify(graph, null, 2), "utf8");
}

function cacheManifest(payload, mode, fileCount, pluginFingerprintValue, mappingFingerprintValue, changes = null) {
  return {
    version: 1,
    cache_schema: CACHE_SCHEMA,
    generated_at: nowIso(),
    file_count: fileCount,
    plugin_fingerprint: pluginFingerprintValue,
    mapping_fingerprint: mappingFingerprintValue,
    rebuild_mode: mode,
    ...(changes ? { changes } : {}),
    ...payload
  };
}

async function rebuildCacheFull(vaultPath, mapping, cacheDir, pluginFingerprintValue, mappingFingerprintValue) {
  const currentFiles = await activeMarkdownFileStats(vaultPath, mapping);
  const notes = [];
  for (const file of currentFiles) {
    notes.push(noteFromFile(vaultPath, file.path, await readFile(file.path, "utf8"), mapping));
  }
  const fileStatsByPath = new Map(currentFiles.map((item) => [item.relPath, item]));
  const files = [];
  for (const note of notes) {
    files.push(cacheFileEntry(note, fileStatsByPath.get(note.relPath)));
  }
  const graph = buildGraph(notes);
  const manifest = cacheManifest({}, "full", files.length, pluginFingerprintValue, mappingFingerprintValue);
  await writeCachePayload(cacheDir, manifest, files, graph);
  return { manifest, files, graph, mode: "full", cache_changes: { added: files.length, changed: 0, deleted: 0 } };
}

async function rebuildCacheIncremental(vaultPath, mapping, cacheDir, diff, pluginFingerprintValue, mappingFingerprintValue) {
  const entriesByPath = new Map(diff.entries.map((entry) => [toPosix(entry.path).normalize("NFC"), entry]));
  for (const entry of diff.deleted) entriesByPath.delete(toPosix(entry.path).normalize("NFC"));
  for (const file of [...diff.added, ...diff.changed]) {
    const note = noteFromFile(vaultPath, file.path, await readFile(file.path, "utf8"), mapping);
    entriesByPath.set(file.relPath.normalize("NFC"), cacheFileEntry(note, file));
  }

  const files = diff.currentFiles.map((file) => entriesByPath.get(file.relPath.normalize("NFC"))).filter(Boolean);
  if (files.length !== diff.currentFiles.length) {
    return rebuildCacheFull(vaultPath, mapping, cacheDir, pluginFingerprintValue, mappingFingerprintValue);
  }
  const graphNotes = files.map((entry) => noteSummaryFromCacheEntry(vaultPath, entry));
  const graph = buildGraph(graphNotes);
  const changes = cacheChangeSummary(diff);
  const manifest = cacheManifest({}, "incremental", files.length, pluginFingerprintValue, mappingFingerprintValue, changes);
  await writeCachePayload(cacheDir, manifest, files, graph);
  return { manifest, files, graph, mode: "incremental", cache_changes: changes };
}

export async function rebuildCache(vaultPath, options = {}) {
  const { mapping } = await readVaultConfig(vaultPath);
  const cacheDir = join(vaultPath, ".ipa", "cache");
  await mkdir(cacheDir, { recursive: true });
  const currentPluginFingerprint = await pluginFingerprint(vaultPath);
  const currentMappingFingerprint = mappingFingerprint(mapping);
  const manifest = await readCacheManifest(vaultPath);
  const entries = await readCacheFileEntries(vaultPath);
  const canIncremental = Boolean(
    !options.full &&
    manifest?.cache_schema === CACHE_SCHEMA &&
    manifest?.plugin_fingerprint === currentPluginFingerprint &&
    manifest?.mapping_fingerprint === currentMappingFingerprint &&
    entries
  );

  if (canIncremental) {
    const diff = await cacheFileDiff(vaultPath, mapping, entries);
    if (diff) return rebuildCacheIncremental(vaultPath, mapping, cacheDir, diff, currentPluginFingerprint, currentMappingFingerprint);
  }
  if (options.allowFull === false) return null;
  return rebuildCacheFull(vaultPath, mapping, cacheDir, currentPluginFingerprint, currentMappingFingerprint);
}

export async function cacheStatus(vaultPath) {
  const { mapping } = await readVaultConfig(vaultPath);
  const manifest = await readCacheManifest(vaultPath);
  const currentFingerprint = await pluginFingerprint(vaultPath);
  const currentMappingFingerprint = mappingFingerprint(mapping);
  const stale = [];
  let changes = { added: 0, changed: 0, deleted: 0 };
  if (!manifest) stale.push({ reason: "missing_manifest" });
  else {
    if (manifest.cache_schema !== CACHE_SCHEMA) stale.push({ reason: "cache_schema_changed" });
    if (manifest.plugin_fingerprint !== currentFingerprint) stale.push({ reason: "plugin_fingerprint_changed" });
    if (manifest.mapping_fingerprint !== currentMappingFingerprint) stale.push({ reason: "mapping_changed" });
    const diff = await cacheFileDiff(vaultPath, mapping);
    if (!diff) {
      stale.push({ reason: "files_changed_or_metadata_missing" });
    } else {
      changes = cacheChangeSummary(diff);
      if (hasCacheFileChanges(diff)) stale.push({ reason: "files_changed", ...changes });
    }
  }
  return {
    manifest,
    stale,
    cache_changes: changes,
    current_plugin_fingerprint: currentFingerprint,
    current_mapping_fingerprint: currentMappingFingerprint
  };
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

const LINK_SUGGEST_MAX_PER_NOTE = 30;
const LINK_SUGGEST_QUERY_LIMIT = 24;
const LINK_SUGGEST_QUERY_TERMS = 10;
const LINK_SUGGEST_SEARCH_RESULTS_PER_QUERY = 10;
const LINK_SUGGEST_MIN_SEMANTIC_RANK = 0.015;
const LINK_SUGGEST_QUERY_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it", "of", "on", "or", "the", "to", "with",
  "true", "false", "null", "undefined", "todo", "action", "item", "items"
]);

const LINK_SUGGEST_IGNORED_HEADINGS = ["transcript"];

// Vault-specific vocabulary comes from config, merged over the generic
// defaults, e.g.
//   link:
//     stopwords: [참여자, 요약]
//     ignored_headings: [전사문, 교정]
function linkSuggestVocab(config = {}) {
  const stopwords = new Set(LINK_SUGGEST_QUERY_STOPWORDS);
  for (const word of asList(config.link?.stopwords)) stopwords.add(String(word).toLowerCase());
  const ignoredHeadings = [
    ...LINK_SUGGEST_IGNORED_HEADINGS,
    ...asList(config.link?.ignored_headings).map((heading) => searchableKey(heading)).filter(Boolean)
  ];
  return { stopwords, ignoredHeadings };
}

function stripLinkSuggestionSource(body) {
  const out = [];
  let inCodeBlock = false;
  let skipCollapsedCallout = false;
  for (const line of String(body ?? "").split("\n")) {
    if (isCodeFence(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    if (/^>\s*\[![^\]]+\]-/.test(line)) {
      skipCollapsedCallout = true;
      continue;
    }
    if (skipCollapsedCallout) {
      if (/^>/.test(line) || !line.trim()) continue;
      skipCollapsedCallout = false;
    }
    const trimmed = line.trim();
    if (/^!\[\[/.test(trimmed)) continue;
    out.push(line.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, target, alias) => alias || target));
  }
  return out.join("\n");
}

function usefulLinkSuggestionQueryToken(token, stopwords = LINK_SUGGEST_QUERY_STOPWORDS) {
  const value = String(token ?? "").toLowerCase();
  if (!value || value.length < 2) return false;
  if (stopwords.has(value)) return false;
  if (/^\d+$/.test(value)) return false;
  if (/^speaker[_-]?\d+$/.test(value)) return false;
  return true;
}

function linkSuggestionTokenList(text, stopwords = LINK_SUGGEST_QUERY_STOPWORDS) {
  return tokenize(text)
    .map((token) => token.toLowerCase())
    .filter((token) => usefulLinkSuggestionQueryToken(token, stopwords));
}

function buildLinkSuggestionIdf(notes, stopwords = LINK_SUGGEST_QUERY_STOPWORDS) {
  const documentFrequency = new Map();
  for (const note of notes) {
    const text = searchableTitle([
      note.id,
      ...(note.aliases ?? []),
      ...(note.refs ?? []),
      ...(note.tags ?? []),
      ...(note.headings ?? []).map((heading) => heading.title),
      stripLinkSuggestionSource(note.body)
    ].filter(Boolean).join("\n"));
    for (const token of new Set(linkSuggestionTokenList(text, stopwords))) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const idf = new Map();
  for (const [token, count] of documentFrequency.entries()) {
    idf.set(token, Math.log(1 + notes.length / (1 + count)));
  }
  return idf;
}

function ignoredLinkSuggestionHeading(title, ignoredHeadings = LINK_SUGGEST_IGNORED_HEADINGS) {
  const value = searchableKey(title);
  return ignoredHeadings.some((heading) => value.includes(heading));
}

function addLinkSuggestionBlock(blocks, headingStack, text, ignoredHeadings = LINK_SUGGEST_IGNORED_HEADINGS) {
  if (headingStack.some((title) => ignoredLinkSuggestionHeading(title, ignoredHeadings))) return;
  const cleaned = searchableTitle(text);
  if (cleaned.length < 12) return;
  const heading = headingStack.slice(-2).join(" ");
  const queryText = searchableTitle([heading, cleaned].filter(Boolean).join(" "));
  blocks.push({ text: queryText, excerpt: cleaned.slice(0, 160) });
}

function linkSuggestionBlocks(note, ignoredHeadings = LINK_SUGGEST_IGNORED_HEADINGS) {
  const blocks = [];
  const headingStack = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    addLinkSuggestionBlock(blocks, headingStack, paragraph.join(" "), ignoredHeadings);
    paragraph = [];
  };
  for (const rawLine of stripLinkSuggestionSource(note.body).split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      const depth = headingMatch[1].length;
      headingStack.length = depth - 1;
      headingStack[depth - 1] = headingMatch[2].replace(/#+$/, "").trim();
      continue;
    }
    const listMatch = /^(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+\.\s+)(.+)$/.exec(line);
    if (listMatch) {
      flushParagraph();
      addLinkSuggestionBlock(blocks, headingStack, listMatch[1], ignoredHeadings);
      continue;
    }
    if (/^\|.*\|$/.test(line) && !/^\|?\s*:?-{3,}:?/.test(line)) {
      flushParagraph();
      addLinkSuggestionBlock(blocks, headingStack, line.replace(/\|/g, " "), ignoredHeadings);
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

function linkSuggestionQueryScore(tokens, idf) {
  return tokens.length ? tokens.reduce((sum, token) => sum + (idf.get(token) ?? 0), 0) / tokens.length : 0;
}

function linkSuggestionQueriesFromBlock(block, idf, stopwords = LINK_SUGGEST_QUERY_STOPWORDS) {
  const tokens = linkSuggestionTokenList(block.text, stopwords);
  if (tokens.length < 2) return [];
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const selected = new Set([...counts.entries()]
    .map(([token, count]) => ({ token, score: (idf.get(token) ?? 0) * (1 + Math.log(count)) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.token.localeCompare(b.token))
    .slice(0, LINK_SUGGEST_QUERY_TERMS)
    .map((item) => item.token));
  const out = [];
  if (selected.size >= 2) {
    const ordered = [];
    for (const token of tokens) {
      if (selected.has(token) && !ordered.includes(token)) ordered.push(token);
    }
    out.push({ query: ordered.join(" "), score: linkSuggestionQueryScore(ordered, idf), excerpt: block.excerpt });
  }
  const orderedFull = [];
  for (const token of tokens) {
    if (!orderedFull.includes(token)) orderedFull.push(token);
    if (orderedFull.length >= 18) break;
  }
  if (orderedFull.length >= 2) {
    out.push({ query: orderedFull.join(" "), score: linkSuggestionQueryScore(orderedFull, idf) * 0.9, excerpt: block.excerpt });
  }
  const codeLike = [];
  for (const token of tokens) {
    if (!/[a-z]/i.test(token)) continue;
    if (!codeLike.includes(token)) codeLike.push(token);
    if (codeLike.length >= 8) break;
  }
  if (codeLike.length >= 2) {
    out.push({ query: codeLike.join(" "), score: linkSuggestionQueryScore(codeLike, idf) * 1.1, excerpt: block.excerpt });
  }
  return out.filter((item) => item.score > 0);
}

function extractLinkSuggestionQueries(note, idf, vocab = null) {
  const seen = new Set();
  return linkSuggestionBlocks(note, vocab?.ignoredHeadings ?? LINK_SUGGEST_IGNORED_HEADINGS)
    .flatMap((block) => linkSuggestionQueriesFromBlock(block, idf, vocab?.stopwords ?? LINK_SUGGEST_QUERY_STOPWORDS))
    .sort((a, b) => b.score - a.score || a.query.localeCompare(b.query))
    .filter((item) => {
      if (seen.has(item.query)) return false;
      seen.add(item.query);
      return true;
    })
    .slice(0, LINK_SUGGEST_QUERY_LIMIT);
}

function existingLinkTargets(note) {
  return [...note.links, ...note.refs];
}

function rootOverlap(left, right, rootSets) {
  const leftRoots = rootSets.get(left.id) ?? new Set();
  const rightRoots = rootSets.get(right.id) ?? new Set();
  return [...leftRoots].some((root) => rightRoots.has(root));
}

function semanticLinkContextBoost(source, target, rootSets) {
  let boost = 1;
  if (shareNoteNames(source.refs, target.refs)) boost += 0.25;
  if (rootOverlap(source, target, rootSets)) boost += 0.15;
  if (source.tags.some((tag) => target.tags.includes(tag))) boost += 0.1;
  return boost;
}

function addRankedLinkSuggestion(byTarget, target, suggestion) {
  const current = byTarget.get(target.id);
  if (!current || suggestion.rank > current.rank) byTarget.set(target.id, { ...suggestion, target: target.id });
}

function linkSuggestionScore(rank) {
  return Number(rank.toFixed(4));
}

export async function suggestLinks(vaultPath, noteName = null, options = {}) {
  // Long-running hosts (Obsidian) pass their cached search context so a
  // per-note suggestion does not rebuild the whole vault context.
  const context = options.context ?? await prepareSearchContext(vaultPath);
  const { notes } = context;
  const vocab = linkSuggestVocab(context.config);
  const selected = noteName ? [findNote(notes, noteName)].filter(Boolean) : notes;
  const idf = noteName ? buildLinkSuggestionIdf(notes, vocab.stopwords) : null;
  const rootSets = noteName ? buildRootSets(notes) : new Map();
  const suggestions = [];
  for (const note of selected) {
    const byTarget = new Map();
    const sourceBody = stripLinkSuggestionSource(note.body);
    const bodyKey = searchableTitle(sourceBody).toLowerCase();
    const existingTargets = existingLinkTargets(note);
    for (const other of notes) {
      if (other.id === note.id || hasNoteName(existingTargets, other.id)) continue;
      const otherKey = searchableKey(other.id);
      if (sourceBody.includes(other.id) || (otherKey && bodyKey.includes(otherKey))) {
        addRankedLinkSuggestion(byTarget, other, { note: note.id, reason: "plain_text_title_match", rank: 1 });
      }
    }
    if (noteName && idf) {
      for (const query of extractLinkSuggestionQueries(note, idf, vocab)) {
        const result = await searchWithContext(context, query.query, { threshold: 0, maxResults: LINK_SUGGEST_SEARCH_RESULTS_PER_QUERY });
        result.results.forEach((hit, index) => {
          const target = findNote(notes, hit.note);
          if (!target || target.id === note.id || hasNoteName(existingTargets, target.id)) return;
          if (target.type === "index" || target.type === "root" || target.id.startsWith("🔖")) return;
          if ((hit.score ?? 0) <= 0) return;
          const rank = (hit.score ?? 0) * query.score * semanticLinkContextBoost(note, target, rootSets) / (index + 1);
          if (rank < LINK_SUGGEST_MIN_SEMANTIC_RANK) return;
          addRankedLinkSuggestion(byTarget, target, {
            note: note.id,
            reason: "semantic_search_match",
            rank,
            source_query: query.query,
            source_excerpt: query.excerpt
          });
        });
      }
    }
    suggestions.push(...[...byTarget.values()]
      .sort((a, b) => b.rank - a.rank || a.target.localeCompare(b.target))
      .slice(0, LINK_SUGGEST_MAX_PER_NOTE)
      .map(({ rank, ...item }) => ({ ...item, score: linkSuggestionScore(rank) })));
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
        reason: item.reason,
        ...(item.score !== undefined ? { score: item.score } : {}),
        ...(item.source_query ? { source_query: item.source_query } : {}),
        ...(item.source_excerpt ? { source_excerpt: item.source_excerpt } : {})
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
    if (command === "tag-rename") next = rewriteListValue(next, mapping.tags, (items) => items.map((tag) => tag === args[0] ? args[1] : tag), mapping.updated_at, mapping.date_format);
    if (command === "tag-remove") next = rewriteListValue(next, mapping.tags, (items) => items.filter((tag) => tag !== args[0]), mapping.updated_at, mapping.date_format);
    if (command === "tag-add") next = rewriteListValue(next, mapping.tags, (items) => [...new Set([...items, args[0]])], mapping.updated_at, mapping.date_format);
    if (command === "ref-replace") next = rewriteListValue(next, mapping.refs, (items) => items.map((ref) => stripWiki(ref) === args[0] ? `[[${args[1]}]]` : ref), mapping.updated_at, mapping.date_format);
    if (command === "ref-add") next = rewriteListValue(next, mapping.refs, (items) => [...new Set([...items, `[[${args[0]}]]`])], mapping.updated_at, mapping.date_format);
    if (command === "ref-remove") next = rewriteListValue(next, mapping.refs, (items) => items.filter((ref) => stripWiki(ref) !== args[0]), mapping.updated_at, mapping.date_format);
    if (command === "wikilink-replace") next = next.replaceAll(`[[${args[0]}]]`, `[[${args[1]}]]`);
    if (next !== note.raw) {
      changed.push(note.relPath);
      if (options.apply) await writeFile(note.path, next, "utf8");
    }
  }
  return { command, apply: Boolean(options.apply), changed };
}

function rewriteListValue(text, key, rewrite, updatedKey = DEFAULT_MAPPING.updated_at, dateFormat = DEFAULT_MAPPING.date_format) {
  const parsed = readFrontmatter(text);
  const current = asList(parsed.frontmatter[key]);
  const next = rewrite(current).map(String);
  if (current.length === next.length && current.every((item, index) => item === next[index])) {
    return text;
  }
  parsed.frontmatter[key] = next;
  if (updatedKey) parsed.frontmatter[updatedKey] = formatVaultDate(new Date(), dateFormat);
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
    [mapping.created_at]: parsed.frontmatter[mapping.created_at] ?? formatVaultDate(new Date(), mapping.date_format),
    [mapping.updated_at]: parsed.frontmatter[mapping.updated_at] ?? formatVaultDate(new Date(), mapping.date_format),
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

// Repoint every wikilink/ref that targets the source notes to the target
// note. The CLI primitive behind "merge" workflows: content synthesis stays
// with the agent/user; the repetitive rewiring is done here in one pass.
export async function redirectNotes(vaultPath, sourceNames, targetName, options = {}) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const target = findNote(notes, targetName);
  if (!target) throw new Error(`note not found: ${targetName}`);
  const sources = [];
  for (const name of asList(sourceNames)) {
    const note = findNote(notes, name);
    if (!note) throw new Error(`note not found: ${name}`);
    if (note.id === target.id) throw new Error(`redirect source equals target: ${note.id}`);
    if (!sources.some((item) => item.id === note.id)) sources.push(note);
  }
  if (!sources.length) throw new Error("note redirect requires at least one source note");
  const apply = Boolean(options.apply);
  const sourceIds = new Set(sources.map((note) => note.id));
  const changes = [];
  for (const note of notes) {
    if (sourceIds.has(note.id)) continue;
    let next = note.raw;
    for (const source of sources) {
      next = next.split(`[[${source.id}]]`).join(`[[${target.id}]]`);
      next = next.split(`[[${source.id}|`).join(`[[${target.id}|`);
    }
    const linksChanged = next !== note.raw;
    const withRefs = rewriteListValue(next, mapping.refs, (items) => {
      const mapped = items.map((item) => sourceIds.has(stripWiki(item)) ? `[[${target.id}]]` : String(item));
      return [...new Set(mapped)];
    }, null);
    const refsChanged = withRefs !== next;
    next = withRefs;
    if (next === note.raw) continue;
    if (options.syncUpdatedAt !== false) next = syncUpdatedAtText(next, mapping);
    changes.push({ note: note.id, path: note.relPath, links: linksChanged, refs: refsChanged });
    if (apply) await writeFile(note.path, next, "utf8");
  }
  const archived = [];
  if (options.archive) {
    const archiveDir = mapping.archive_dir ?? "02 Archive";
    for (const source of sources) {
      const dest = join(vaultPath, archiveDir, `${source.id}.md`);
      archived.push({ note: source.id, to: toPosix(relative(vaultPath, dest)) });
      if (apply) {
        await mkdir(dirname(dest), { recursive: true });
        await rename(source.path, dest);
      }
    }
  }
  return {
    operation: "redirect-notes",
    sources: sources.map((note) => note.id),
    target: target.id,
    apply,
    changes,
    archived
  };
}

// Staged ripple for a (usually new) note. Tier 1 (appliable): wire refs into
// the graph and wrap plain-text title mentions as wikilinks in both
// directions. Tier 2 (report only): overlap candidates the agent/user can
// merge by hand — the CLI never edits content it did not mechanically derive.
export async function cascadeNote(vaultPath, noteName, options = {}) {
  const context = await prepareSearchContext(vaultPath);
  const { notes, mapping } = context;
  const note = findNote(notes, noteName);
  if (!note) throw new Error(`note not found: ${noteName}`);
  const only = asList(options.only).map(String);
  const wants = (kind) => !only.length || only.includes(kind);
  const apply = Boolean(options.apply);

  const suggestions = wants("refs") || wants("links")
    ? (await suggestLinks(vaultPath, note.id)).suggestions
    : [];

  const refSuggestions = [];
  if (wants("refs")) {
    const counts = new Map();
    for (const item of suggestions) {
      const related = findNote(notes, item.target);
      for (const ref of related?.refs ?? []) {
        if (hasNoteName(note.refs, ref)) continue;
        counts.set(ref, (counts.get(ref) ?? 0) + 1);
      }
    }
    refSuggestions.push(...[...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([ref, count]) => ({ ref, count })));
  }

  const forwardLinks = wants("links")
    ? suggestions
      .filter((item) => !hasNoteName(note.links, item.target) && note.body.includes(item.target))
      .map((item) => ({ note: note.id, target: item.target, reason: item.reason }))
    : [];
  const reverseLinks = [];
  if (wants("links")) {
    for (const other of notes) {
      if (other.id === note.id) continue;
      if (hasNoteName([...other.links, ...other.refs], note.id)) continue;
      if (other.body.includes(note.id)) {
        reverseLinks.push({ note: other.id, target: note.id, reason: "plain_text_title_match" });
      }
    }
  }

  const overlaps = [];
  if (wants("overlaps")) {
    const queries = [note.id, ...(note.headings ?? []).slice(0, 5).map((heading) => heading.title)];
    const seen = new Set();
    for (const query of queries) {
      const result = await searchWithContext(context, query, { threshold: 0, maxResults: 4 });
      for (const hit of result.results) {
        if (hit.note === note.id || seen.has(hit.note) || (hit.score ?? 0) <= 0) continue;
        seen.add(hit.note);
        overlaps.push({ note: hit.note, score: hit.score, matched_query: query, snippet: hit.snippet ?? null });
      }
    }
    overlaps.sort((a, b) => b.score - a.score);
    overlaps.splice(options.maxOverlaps ?? 8);
  }

  const appliedChanges = [];
  if (apply) {
    if (wants("refs") && !note.refs.length && refSuggestions[0]) {
      await setNoteField(vaultPath, note.id, mapping.refs, { add: [refSuggestions[0].ref], apply: true });
      appliedChanges.push({ note: note.id, kind: "ref", value: refSuggestions[0].ref });
    }
    for (const change of forwardLinks) {
      const current = await resolveNote(vaultPath, change.note);
      const next = current.note.raw.replace(change.target, `[[${change.target}]]`);
      if (next !== current.note.raw) {
        await writeFile(current.note.path, syncUpdatedAtText(next, mapping), "utf8");
        appliedChanges.push({ note: change.note, kind: "link", value: change.target });
      }
    }
    for (const change of reverseLinks) {
      const current = await resolveNote(vaultPath, change.note);
      const next = current.note.raw.replace(note.id, `[[${note.id}]]`);
      if (next !== current.note.raw) {
        await writeFile(current.note.path, syncUpdatedAtText(next, mapping), "utf8");
        appliedChanges.push({ note: change.note, kind: "link", value: note.id });
      }
    }
  }

  return {
    operation: "cascade",
    note: note.id,
    apply,
    ref_suggestions: refSuggestions,
    forward_links: forwardLinks,
    reverse_links: reverseLinks,
    overlaps,
    applied: appliedChanges
  };
}

export async function reviewVault(vaultPath, scope = "all", options = {}) {
  const validation = await validateVault(vaultPath);
  const { config, mapping } = await readVaultConfig(vaultPath);
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
  if (scope === "all" || scope === "sot") {
    // Report-style note pileups under one index usually mean the knowledge
    // has no single source of truth. The report-title vocabulary is an
    // operating policy, so it lives in config; without it this scope is
    // silent, e.g.
    //   review:
    //     sot:
    //       title_patterns: [계획, 결과, 보고서?, report, plan]
    //       min: 4
    const sotConfig = config.review?.sot ?? {};
    const patterns = asList(sotConfig.title_patterns).filter(Boolean);
    if (patterns.length) {
      const reportTitleRe = new RegExp(`(${patterns.join("|")})`, "i");
      const candidateMin = Number(sotConfig.min ?? 4);
      for (const index of notes.filter((item) => item.type === "index" || item.type === "root")) {
        const children = notes.filter((item) => item.id !== index.id && hasNoteName(item.refs, index.id));
        const reports = children.filter((item) => reportTitleRe.test(item.id));
        if (reports.length >= candidateMin) {
          issues.push({
            code: "review.sot.consolidation_candidate",
            severity: "info",
            note: index.id,
            message: `${reports.length} plan/report-style children of ${children.length}; consider consolidating into a single source of truth (ipa note redirect ... --to "SoT")`,
            notes: reports.map((item) => item.id)
          });
        }
      }
    } else if (scope === "sot") {
      issues.push({ code: "review.sot.unconfigured", severity: "info", message: "configure review.sot.title_patterns in .ipa/config.yaml to enable this scope" });
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

const PLUGIN_GATE_EXAMPLE = `// @ts-check
// Example session gate: blocks the end of a session that edited a note titled
// "Blocked Example" — rename the file (drop the leading underscore) to enable.
/** @type {import("../types/ipa-plugin").Gate} */
const gate = {
  name: "example-session-gate",
  check(ctx) {
    const hit = ctx.session.edits.find((edit) => edit.title === "Blocked Example");
    if (!hit) return null;
    return { block: true, message: "example gate: finish the follow-up work for Blocked Example first" };
  }
};
export default gate;
`;

const PLUGIN_GATE_UNAPPLIED_EXAMPLE = `// @ts-check
// Example session gate: warns (without blocking) when this session previewed an
// ipa mutation (link/cascade plan, rename/move/refactor dry-run) but never ran
// its --apply/apply. ctx.session.pending_mutations is command-name granularity
// only — it cannot say which target was previewed. Rename the file (drop the
// leading underscore) to enable. This gate returns block:false, so it is
// advisory; the Stop gate only holds the response on a blocking result, so flip
// block to true if unapplied plans should hard-block the session end.
/** @type {import("../types/ipa-plugin").Gate} */
const gate = {
  name: "example-unapplied-mutation-gate",
  check(ctx) {
    const pending = ctx.session.pending_mutations ?? [];
    if (!pending.length) return null;
    const commands = [...new Set(pending.map((item) => item.command))].join(", ");
    return { block: false, message: \`example gate: previewed but never applied: \${commands}. Re-run with --apply (or ipa link/cascade apply) if the change was intended.\` };
  }
};
export default gate;
`;

const PLUGIN_JSCONFIG = `{
  "compilerOptions": {
    "checkJs": true,
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true
  },
  "include": [
    "rules/**/*.js",
    "search/**/*.js",
    "types/**/*.d.ts"
  ]
}
`;

const PLUGIN_TYPES = `export type Severity = "info" | "warn" | "error";
export type RuleScope = "note" | "vault";

export interface Heading {
  level: number;
  title: string;
  line: number;
}

export interface Note {
  id: string;
  path: string;
  relPath: string;
  folder: string;
  raw: string;
  body: string;
  type: string;
  frontmatter: Record<string, unknown>;
  refs: string[];
  tags: string[];
  aliases: string[];
  links: string[];
  headings: Heading[];
}

export interface Mapping {
  note_type: string;
  refs: string;
  tags: string;
  created_at: string;
  updated_at: string;
  aliases: string;
  inbox_dir: string;
  project_dir: string;
  archive_dir: string;
  date_format: string;
  exclude: string[];
}

export interface RuleContext {
  vaultPath: string;
  /** Parsed .ipa/config.yaml; put rule-specific settings under your own key. */
  config?: Record<string, unknown>;
  mapping: Mapping;
  notes: Note[];
  /**
   * childCount(note): how many notes point at \`note\` (its children in the
   * index graph). Matching is title-normalized (NFC, case-insensitive,
   * emoji/whitespace tolerant), so it catches link variants that a hand-rolled
   * \`ctx.notes.filter(...)\` misses. O(N) over the vault per call — call once
   * per note, not inside a loop.
   */
  childCount: (note: Note) => number;
  /**
   * backlinkCount(note): how many notes reference or link \`note\` (its inbound
   * references). Same title-normalized matching and O(N)-per-call caveat as
   * childCount.
   */
  backlinkCount: (note: Note) => number;
  apply?: boolean;
  options?: {
    note?: string | null;
    notes?: string[];
  };
  MarkdownDocument?: unknown;
  IpaNoteDocument?: unknown;
}

export interface RuleIssue {
  code?: string;
  severity?: Severity;
  note?: string;
  path?: string;
  message: string;
  plugin?: string;
}

export interface FormatterPatch {
  note?: string;
  path?: string;
  content?: string;
  line?: number;
  replacement?: string;
  [key: string]: unknown;
}

export type RuleCheck = (note: Note, ctx: RuleContext) => RuleIssue | RuleIssue[] | null | undefined | Promise<RuleIssue | RuleIssue[] | null | undefined>;
export type VaultRuleCheck = (ctx: RuleContext) => RuleIssue | RuleIssue[] | null | undefined | Promise<RuleIssue | RuleIssue[] | null | undefined>;
export type RuleFix = (note: Note, ctx: RuleContext) => string | FormatterPatch | FormatterPatch[] | null | undefined | Promise<string | FormatterPatch | FormatterPatch[] | null | undefined>;

export interface Rule {
  code: string;
  id?: string;
  category?: string;
  severity?: Severity;
  scope?: RuleScope;
  check?: RuleCheck;
  checkNote?: RuleCheck;
  checkVault?: VaultRuleCheck;
  fix?: RuleFix;
  fixNote?: RuleFix;
}

export interface SearchHit {
  note: string | Note;
  score: number;
  reason?: Record<string, unknown>;
}

// Per-note precomputation shared with the builtin channels: lowercased body,
// token set, keyword text, and normalized names. Score against these instead
// of re-normalizing note.body per query.
export interface PreparedNote {
  note: Note;
  names: string[];
  searchNames: string[];
  searchNameLowers: string[];
  idKey: string;
  bodyLower: string;
  bodyTokenSet: Set<string>;
  keywordText: string;
  isProject: boolean;
  hasProjectContext: boolean;
}

export interface SearchContext {
  query: string;
  notes: Note[];
  mapping: Mapping;
  vaultPath: string;
  /** Vault config (.ipa/config.yaml). Put plugin-specific settings under your own key. */
  config?: Record<string, unknown>;
  /** O(1) note resolution by id/alias with the same fuzzy fallback the core uses. */
  lookup?: ((name: string) => Note | null) | null;
  /** PreparedNote array aligned with notes; also exposes noteById (Map). */
  prepared?: PreparedNote[] | null;
  /** Channel plugins only: normalized query with tokens and bm25 scores. */
  preparedQuery?: unknown;
}

// A search plugin module may export any of:
// - search(query, notes, ctx): legacy scorer. Scores are ADDED to the final
//   weighted score (not affected by channel weights or tuning).
// - channel = { name, defaultWeight, description, phase?, search(ctx) }:
//   weighted channel. Scores are max-merged into the named channel and go
//   through the weights/tune system. phase: "base" (default) | "related" |
//   "project" runs the channel in the matching scoring pass.
// - postRank(hits, ctx): runs after weighting/threshold, before the result
//   cap. Return the (re-ordered/filtered) hits array to replace the ranking.
export type SearchPlugin = (query: string, notes: Note[], ctx: SearchContext) => SearchHit[] | Record<string, number> | Promise<SearchHit[] | Record<string, number>>;
export type SearchChannel = (ctx: SearchContext) => SearchHit[] | Record<string, number> | Map<string, number> | { scores: Record<string, number>; reasons?: Record<string, unknown> } | Promise<SearchHit[] | Record<string, number> | Map<string, number> | { scores: Record<string, number>; reasons?: Record<string, unknown> }>;

export interface SearchChannelDescriptor {
  name: string;
  defaultWeight?: number;
  description?: string;
  phase?: "base" | "related" | "project";
  search: SearchChannel;
}

export interface RankedHit {
  note: string;
  path: string;
  type: string;
  refs: string[];
  score: number;
  reasons: Record<string, unknown>;
}

export type PostRank = (hits: RankedHit[], ctx: SearchContext & { threshold: number; cap: number; weights: Record<string, number> }) => RankedHit[] | void | Promise<RankedHit[] | void>;

/**
 * Session gate plugins live in .ipa/plugins/gates/*.js and run when a harness
 * session tries to end (Stop hook -> \`ipa harness gate\`). ctx.session.edits
 * lists the notes this session created or edited. ctx.session.pending_mutations
 * lists ipa dry-run mutations (link/cascade plan, rename/move/refactor preview)
 * this session ran without a following --apply/apply. Return { block: true,
 * message } to hold the final response until the condition is fixed; return
 * null/undefined/{ block: false } to pass. A gate that throws is reported but
 * never blocks. Enable/disable via \`gates.plugins\` in .ipa/config.yaml.
 */
export interface GateSessionEdit {
  title: string;
  path: string | null;
  updated_at: string | null;
}

/**
 * A recorded dry-run mutation that was not followed by an apply. Granularity is
 * the command name only ("link", "cascade", "rename", "move", "refactor") — the
 * ledger does not correlate a plan with the specific target note/args, so a gate
 * can tell that *some* rename was previewed and not applied, not which one.
 */
export interface GatePendingMutation {
  command: string;
  ts: string | null;
}

export interface GateContext {
  vaultPath: string;
  config: Record<string, unknown>;
  mapping: Mapping;
  notes: Note[];
  lookup: (ref: string) => Note | null;
  session: { id: string | null; edits: GateSessionEdit[]; pending_mutations: GatePendingMutation[] };
}

/**
 * Returned by a gate's check(). block:true hard-blocks the session end and
 * surfaces message to the agent as the blocking reason. block:false with a
 * message is a non-blocking warning: it is surfaced to the agent at session end
 * (Stop-hook additionalContext on claude/codex, console.warn on OpenCode) but
 * never holds the response. Return null/undefined when the gate has nothing to
 * say.
 */
export interface GateResult {
  block: boolean;
  message?: string;
}

export interface Gate {
  name: string;
  description?: string;
  check: (ctx: GateContext) => GateResult | null | undefined | Promise<GateResult | null | undefined>;
}
`;

const PLUGIN_RULE_EXAMPLE = `// @ts-check

/** @type {import("../types/ipa-plugin").Rule[]} */
export const rules = [{
  code: "vault.short_title",
  severity: "info",
  check(note) {
    if ((note.id ?? "").trim().length >= 6) return [];
    return [{
      message: "note title is very short for this vault convention"
    }];
  }
}];
`;

const PLUGIN_RULE_OVERFULL_INDEX_EXAMPLE = `// @ts-check

// Vault policy — tune me. An index note with more children than this is
// "over-full" and probably wants splitting. The threshold is convention, so it
// lives here in the vault, never in the ipa core.
const MAX_CHILDREN = 20;

/** @type {import("../types/ipa-plugin").Rule[]} */
export const rules = [{
  code: "vault.index.over_full",
  severity: "info",
  // checkNote runs per note, so it fires under
  // \`ipa plugin dry-run rules <file> --note "Some Index"\` — instant feedback.
  checkNote(note, ctx) {
    if (note.type !== "index") return [];
    const children = ctx.childCount(note);
    if (children <= MAX_CHILDREN) return [];
    return [{
      message: \`index has \${children} children (over \${MAX_CHILDREN}); consider splitting it\`
    }];
  }
}];
`;

const PLUGIN_SEARCH_EXAMPLE = `// @ts-check

/** @type {import("../types/ipa-plugin").SearchPlugin} */
export async function search(query, notes) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return notes
    .filter((note) => note.body.toLowerCase().includes(\`# \${q}\`) || note.body.toLowerCase().includes(\`## \${q}\`))
    .map((note) => ({
      note: note.id,
      score: 1,
      reason: { matched: "heading" }
    }));
}
`;

async function writePluginScaffoldFile(vaultPath, relPath, content, force, result) {
  const path = join(vaultPath, relPath);
  await mkdir(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    await writeFile(path, content, "utf8");
    result.created.push(relPath);
    return;
  }
  const previous = await readFile(path, "utf8");
  if (previous === content) {
    result.existing.push(relPath);
    return;
  }
  if (!force) {
    result.skipped.push(relPath);
    return;
  }
  await writeFile(path, content, "utf8");
  result.updated.push(relPath);
}

export async function pluginInit(vaultPath, options = {}) {
  const root = ".ipa/plugins";
  const result = {
    plugin_root: root,
    created: [],
    updated: [],
    skipped: [],
    existing: [],
    examples: Boolean(options.examples ?? true)
  };
  for (const rel of [root, `${root}/rules`, `${root}/search`, `${root}/gates`, `${root}/types`]) {
    await mkdir(join(vaultPath, rel), { recursive: true });
  }
  const force = Boolean(options.force);
  await writePluginScaffoldFile(vaultPath, `${root}/jsconfig.json`, PLUGIN_JSCONFIG, force, result);
  await writePluginScaffoldFile(vaultPath, `${root}/types/ipa-plugin.d.ts`, PLUGIN_TYPES, force, result);
  if (result.examples) {
    await writePluginScaffoldFile(vaultPath, `${root}/rules/_example-title-length.js`, PLUGIN_RULE_EXAMPLE, force, result);
    await writePluginScaffoldFile(vaultPath, `${root}/rules/_example-overfull-index.js`, PLUGIN_RULE_OVERFULL_INDEX_EXAMPLE, force, result);
    await writePluginScaffoldFile(vaultPath, `${root}/search/_example-heading-search.js`, PLUGIN_SEARCH_EXAMPLE, force, result);
    await writePluginScaffoldFile(vaultPath, `${root}/gates/_example-session-gate.js`, PLUGIN_GATE_EXAMPLE, force, result);
    await writePluginScaffoldFile(vaultPath, `${root}/gates/_example-unapplied-mutation-gate.js`, PLUGIN_GATE_UNAPPLIED_EXAMPLE, force, result);
  }
  return result;
}

function pluginScaffoldStatus(vaultPath) {
  const root = join(vaultPath, ".ipa", "plugins");
  return {
    root: existsSync(root),
    jsconfig: existsSync(join(root, "jsconfig.json")),
    types: existsSync(join(root, "types", "ipa-plugin.d.ts")),
    rules_dir: existsSync(join(root, "rules")),
    search_dir: existsSync(join(root, "search")),
    gates_dir: existsSync(join(root, "gates"))
  };
}

export async function listPlugins(vaultPath) {
  const { config } = await readVaultConfig(vaultPath);
  const root = join(vaultPath, ".ipa", "plugins");
  const entries = [];
  for (const kind of ["search", "rules", "gates"]) {
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
    kind === "rules" ? config.rules?.plugins : undefined,
    kind === "gates" ? config.gates?.plugins : undefined
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

// Hosts that cannot import file:// ESM (e.g. the Obsidian renderer) may install
// globalThis.__ipaImportPlugin to load a vault module their own way (blob URL,
// etc.). The CLI leaves it unset and uses a normal dynamic import.
async function importVaultModule(path) {
  if (typeof globalThis.__ipaImportPlugin === "function") {
    return globalThis.__ipaImportPlugin(path);
  }
  return import(pathToFileURL(path).href + `?t=${Date.now()}`);
}

// Session gate plugins ({ name, check(ctx) }) run at the harness Stop gate.
// check() returns { block, message } to hold the final response, or null/false
// to pass. A gate that throws is reported but never blocks — a broken plugin
// must not lock the session shut.
function normalizeGatePlugin(plugin) {
  const mod = plugin.module ?? {};
  const candidate = typeof mod.check === "function" ? mod
    : mod.gate && typeof mod.gate.check === "function" ? mod.gate
    : mod.default && typeof mod.default.check === "function" ? mod.default
    : null;
  if (!candidate) return null;
  const fallback = basename(plugin.path ?? "gate", ".js");
  return {
    name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : fallback,
    path: plugin.path ?? null,
    check: (ctx) => candidate.check(ctx)
  };
}

async function loadPluginModules(vaultPath, kind) {
  const plugins = (await listPlugins(vaultPath)).plugins.filter((item) => item.kind === kind);
  const modules = [];
  for (const plugin of plugins) {
    const path = resolve(vaultPath, plugin.path);
    try {
      modules.push({
        ...plugin,
        module: await importVaultModule(path)
      });
    } catch (error) {
      // With an injected loader (Obsidian) skip a plugin that fails to load so
      // builtin rules still run; the CLI keeps fail-fast behaviour.
      if (typeof globalThis.__ipaImportPlugin === "function") continue;
      throw error;
    }
  }
  return modules;
}

export async function pluginDoctor(vaultPath) {
  const plugins = (await listPlugins(vaultPath)).plugins;
  const issues = [];
  for (const item of plugins) {
    const report = await validatePlugin(join(vaultPath, item.path), item.kind);
    issues.push(...report.issues.map((issue) => ({ ...issue, path: issue.path ?? item.path })));
  }
  return { status: issues.some((item) => item.severity === "error") ? "error" : "ok", plugins, issues };
}

export async function validatePlugin(path, kind = null) {
  const issues = [];
  try {
    const mod = await importVaultModule(path);
    if ((kind === "search" || path.includes("/search/")) && typeof mod.search !== "function" && !normalizeSearchChannelPlugin({ path, module: mod })) {
      issues.push({ code: "plugin.contract", severity: "error", message: "search plugin must export search() or a channel descriptor" });
    }
    if ((kind === "gates" || path.includes("/gates/")) && !normalizeGatePlugin({ path, module: mod })) {
      issues.push({ code: "plugin.contract", severity: "error", message: "gate plugin must export { name, check(ctx) } (default export or module-level)" });
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
  const { config, mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const mod = await importVaultModule(resolve(vaultPath, pluginRelPath));
  if (kind === "search") {
    // Dry-run must hand plugins the same context shape as a live search so a
    // plugin that reads ctx behaves identically in both paths.
    const preparedNotes = prepareSearchNotes(notes, mapping, { vaultPath, related: false });
    const pluginContext = {
      query: options.query ?? "",
      notes,
      mapping,
      vaultPath,
      config,
      lookup: preparedNotes.lookup,
      prepared: preparedNotes
    };
    const channel = normalizeSearchChannelPlugin({ path: pluginRelPath, module: mod });
    const results = channel
      ? normalizeSearchChannelOutput(await channel.search({ ...pluginContext, preparedQuery: prepareSearchQuery(options.query ?? "", preparedNotes) }), pluginRelPath)
      : normalizeSearchPluginOutput(await mod.search(options.query ?? "", notes, pluginContext), pluginRelPath);
    return { kind, plugin: pluginRelPath, query: options.query, results };
  }
  if (kind === "gates") {
    const gate = normalizeGatePlugin({ path: pluginRelPath, module: mod });
    if (!gate) throw new Error("gate plugin must export { name, check(ctx) }");
    const editTitles = asList(options.notes ?? options.note);
    const edits = editTitles.map((title) => {
      const found = findNote(notes, title);
      if (!found) throw new Error(`note not found: ${title}`);
      return { title: found.id, path: found.relPath, updated_at: new Date().toISOString() };
    });
    const pendingMutations = asList(options.mutations).map((command) => ({ command: String(command), ts: null }));
    const ctx = {
      vaultPath,
      config,
      mapping,
      notes,
      lookup: (ref) => findNote(notes, ref) ?? null,
      session: { id: options.session ?? "dry-run", edits, pending_mutations: pendingMutations }
    };
    const result = await gate.check(ctx);
    return { kind, plugin: pluginRelPath, gate: gate.name, edits: edits.map((item) => item.title), result: result ?? null };
  }
  const note = findNote(notes, options.note);
  if (!note) throw new Error(`note not found: ${options.note}`);
  if (kind === "rules") {
    const rules = normalizeRulePlugin({ path: pluginRelPath, module: mod });
    const ctx = { config, notes, mapping, vaultPath, ...ruleGraphContext(notes), apply: false, MarkdownDocument, IpaNoteDocument, options: { note: note.id } };
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

async function writeActiveTestsetConfig(vaultPath, file) {
  const { config } = await readVaultConfig(vaultPath);
  const rel = toPosix(relative(vaultPath, file));
  if (config.test?.file === rel) return false;
  const configPath = join(vaultPath, ".ipa", "config.yaml");
  config.test = config.test || {};
  config.test.file = rel;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, dumpYaml(config) + "\n", "utf8");
  return true;
}

function normalizeTestsetPayload(payload) {
  const cases = payload.cases ?? payload.queries ?? [];
  return Array.isArray(cases) ? cases : [];
}

export async function tuneTestsetInit(vaultPath, options = {}) {
  const { config } = await readVaultConfig(vaultPath);
  const requested = options.file ?? config.test?.file ?? null;
  const path = await activeTestsetPath(vaultPath, requested);
  const rel = toPosix(relative(vaultPath, path));
  await mkdir(dirname(path), { recursive: true });
  const exists = existsSync(path);
  const force = Boolean(options.force);
  if (!exists || force) {
    const payload = {
      cases: [],
      scenario_cases: []
    };
    await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
  }
  const shouldActivate = Boolean(options.activate) || !config.test?.file;
  const configUpdated = shouldActivate ? await writeActiveTestsetConfig(vaultPath, path) : false;
  return {
    file: rel,
    active: shouldActivate ? rel : config.test?.file ?? null,
    created: !exists,
    updated: exists && force,
    existing: exists && !force,
    config_updated: configUpdated,
    cases: 0
  };
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
    await writeActiveTestsetConfig(vaultPath, path);
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

export async function tuneLog(vaultPath, options = {}) {
  const path = join(vaultPath, ".ipa", "tune", "logs", "search-events.jsonl");
  if (!existsSync(path)) return { file: toPosix(relative(vaultPath, path)), count: 0, events: [] };
  let events = (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  if (options.query) {
    const needle = String(options.query).toLowerCase();
    events = events.filter((event) => String(event.query ?? event.q ?? "").toLowerCase().includes(needle));
  }
  if (Number.isFinite(Number(options.limit))) {
    events = events.slice(Math.max(0, events.length - Number(options.limit)));
  }
  return { file: toPosix(relative(vaultPath, path)), count: events.length, events };
}

function findRepoRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function gitOutput(repoRoot, args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

export function cliVersionInfo() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(here);
  let version = null;
  for (const pkgPath of [repoRoot ? join(repoRoot, "package.json") : null, resolve(here, "..", "package.json")]) {
    if (!pkgPath || !existsSync(pkgPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (parsed.version) {
        version = parsed.version;
        break;
      }
    } catch {
      // fall through to the next candidate
    }
  }
  const commit = repoRoot ? gitOutput(repoRoot, ["rev-parse", "--short", "HEAD"]) : null;
  return { version, commit, repo_root: repoRoot };
}

const OBSIDIAN_PLUGIN_ASSETS = ["main.js", "manifest.json", "styles.css", "versions.json"];

// Deploy the built Obsidian plugin bundle into a vault's
// .obsidian/plugins/ipa-obsidian/. Only the release assets are copied —
// data.json (user settings) is never touched. Without { install: true } an
// uninstalled vault is left alone, so generic users are never surprised by a
// plugin appearing in their Obsidian.
// The `operation` discriminator keeps the CLI from duck-typing this payload
// into the harness install/uninstall renderer (whose `installed` field means
// "is installed now", not "was this an install run").
export async function obsidianPluginSync(vaultPath, options = {}) {
  const repoRoot = options.repoRoot ?? process.env.IPA_UPDATE_REPO_ROOT ?? cliVersionInfo().repo_root;
  if (!repoRoot) {
    return { operation: "obsidian-sync", status: "error", reason: "not_a_git_checkout", message: "could not locate the ipa-cli git checkout from the running binary" };
  }
  const sourceDir = join(repoRoot, "packages", "obsidian", "dist");
  const missing = OBSIDIAN_PLUGIN_ASSETS.filter((file) => !existsSync(join(sourceDir, file)));
  if (missing.length) {
    return { operation: "obsidian-sync", status: "error", reason: "dist_missing", source: sourceDir, message: `obsidian plugin bundle is not built (missing: ${missing.join(", ")}); run pnpm run build first` };
  }
  const targetDir = join(vaultPath, ".obsidian", "plugins", "ipa-obsidian");
  if (!existsSync(targetDir) && !options.install) {
    return { operation: "obsidian-sync", status: "ok", synced: false, reason: "not_installed", target: targetDir, hint: "run ipa obsidian install to install the plugin into this vault" };
  }
  await mkdir(targetDir, { recursive: true });
  for (const file of OBSIDIAN_PLUGIN_ASSETS) {
    await cp(join(sourceDir, file), join(targetDir, file));
  }
  return { operation: "obsidian-sync", status: "ok", synced: true, installed: Boolean(options.install), target: targetDir, files: OBSIDIAN_PLUGIN_ASSETS };
}

const SELF_UPDATE_STEPS = [
  ["git", "pull", "--ff-only"],
  ["pnpm", "install"],
  ["pnpm", "run", "build"]
];

export async function selfUpdate(options = {}) {
  const info = cliVersionInfo();
  const repoRoot = options.repoRoot ?? process.env.IPA_UPDATE_REPO_ROOT ?? info.repo_root;
  if (!repoRoot) {
    return {
      status: "error",
      reason: "not_a_git_checkout",
      message: "could not locate the ipa-cli git checkout from the running binary"
    };
  }
  const fetchResult = spawnSync("git", ["-C", repoRoot, "fetch", "--quiet"], { encoding: "utf8" });
  const fetchOk = !fetchResult.error && fetchResult.status === 0;
  const branch = gitOutput(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const upstream = gitOutput(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) ?? "origin/main";
  const behind = Number(gitOutput(repoRoot, ["rev-list", "--count", `HEAD..${upstream}`]) ?? 0);
  const ahead = Number(gitOutput(repoRoot, ["rev-list", "--count", `${upstream}..HEAD`]) ?? 0);
  const dirty = (gitOutput(repoRoot, ["status", "--porcelain"]) ?? "") !== "";
  const changes = behind > 0
    ? (gitOutput(repoRoot, ["log", "--oneline", `HEAD..${upstream}`]) ?? "").split("\n").filter(Boolean).slice(0, 20)
    : [];
  const commands = SELF_UPDATE_STEPS.map((cmd) => cmd.join(" "));
  const base = {
    status: "ok",
    repo_root: repoRoot,
    version: info.version,
    commit: info.commit,
    branch,
    upstream,
    fetch_ok: fetchOk,
    behind,
    ahead,
    dirty,
    up_to_date: behind === 0,
    changes,
    commands
  };
  if (!options.apply) {
    return { ...base, mode: "plan", hint: behind > 0 ? "run `ipa update --apply` or the commands above from the repo root" : null };
  }
  if (dirty) {
    return { ...base, mode: "apply", status: "error", reason: "dirty_worktree", message: "commit or stash local changes before updating" };
  }
  if (behind === 0) {
    return { ...base, mode: "apply", applied: false, steps: [], message: "already up to date" };
  }
  if (ahead > 0) {
    return { ...base, mode: "apply", status: "error", reason: "diverged", message: `local branch is ahead of ${upstream}; fast-forward pull is not possible` };
  }
  const stepsToRun = options.steps ?? SELF_UPDATE_STEPS;
  const steps = [];
  for (const cmd of stepsToRun) {
    const run = spawnSync(cmd[0], cmd.slice(1), {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: options.stream ? ["ignore", "inherit", "inherit"] : undefined
    });
    const ok = !run.error && run.status === 0;
    const step = { command: cmd.join(" "), ok };
    if (!ok && !options.stream) step.output = `${run.stdout ?? ""}${run.stderr ?? ""}`.slice(-2000);
    steps.push(step);
    if (!ok) {
      return { ...base, mode: "apply", status: "error", reason: "step_failed", steps, message: `command failed: ${cmd.join(" ")}` };
    }
  }
  return {
    ...base,
    mode: "apply",
    applied: true,
    steps,
    commit_after: gitOutput(repoRoot, ["rev-parse", "--short", "HEAD"]),
    next: "run `ipa harness status` to check for outdated harness components, then `ipa harness update <target>` if needed"
  };
}

function harnessRoot(vaultPath) {
  return join(vaultPath, ".ipa", "harness");
}

const HARNESS_MARKER = "IPA_HARNESS_MANAGED";
const HARNESS_MANAGED_BLOCK = "ipa-harness";

const HARNESS_COMPONENTS = [
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

const HARNESS_HOOK_COMPONENT_TO_SCRIPT = {
  "hook:session-env": "ipa-session-env.mjs",
  "hook:guard": "ipa-inbox-guard.mjs",
  "hook:markdown-nudge": "ipa-md-write-nudge.mjs",
  "hook:call-counter": "ipa-call-counter.mjs",
  "hook:mutation-ledger": "ipa-mutation-ledger.mjs",
  "hook:formatter-gate": "ipa-formatter-gate.mjs",
  "hook:vault-ref": "ipa-vault-ref-nudge.mjs",
  "hook:evidence": "ipa-prompt-evidence.mjs"
};

const HARNESS_HOOK_COMPONENT_TO_EVENT = {
  "hook:session-env": "SessionStart",
  "hook:guard": "PreToolUse",
  "hook:markdown-nudge": "PostToolUse",
  "hook:call-counter": "PostToolUse",
  "hook:mutation-ledger": "PostToolUse",
  "hook:formatter-gate": "Stop",
  "hook:vault-ref": "UserPromptSubmit",
  "hook:evidence": "UserPromptSubmit"
};

const HARNESS_HOOK_COMPONENT_TO_MATCHER = {
  "hook:session-env": null,
  "hook:guard": "Write|Edit|MultiEdit",
  "hook:markdown-nudge": "Write|Edit|MultiEdit",
  "hook:call-counter": "Bash",
  "hook:mutation-ledger": "Bash",
  "hook:formatter-gate": null,
  "hook:vault-ref": null,
  "hook:evidence": null
};

const HARNESS_HOOK_COMPONENT_TO_PLUGIN_MARKER = {
  "hook:session-env": 'hooks["shell.env"]',
  "hook:guard": 'hooks["tool.execute.before"]',
  "hook:markdown-nudge": 'hooks["tool.execute.after"]',
  "hook:call-counter": "callCounterHandler",
  "hook:formatter-gate": "runSessionGate",
  "hook:evidence": "evidenceHandler"
};

function componentsValidForTarget(name) {
  // The Bash call counter, the Bash mutation ledger, and the vault
  // path-reference nudge are claude/codex hooks; the opencode plugin has no
  // equivalent handlers yet (mutation-ledger on OpenCode is a documented
  // follow-up). The permissions component registers a Claude Code allow rule,
  // so it only applies to claude.
  if (name === "opencode") return HARNESS_COMPONENTS.filter((component) => component !== "hook:call-counter" && component !== "hook:mutation-ledger" && component !== "hook:vault-ref" && component !== "permissions");
  if (name === "claude") return HARNESS_COMPONENTS.filter((component) => component !== "opencode-plugin");
  return HARNESS_COMPONENTS.filter((component) => component !== "opencode-plugin" && component !== "permissions");
}

function defaultComponentsForTarget(name) {
  // hook:evidence is a pure prompt-event recorder for the tune workflow. The
  // per-turn context injection it once carried was removed after the 2026-07
  // A/B benchmark (no behavioral benefit); recording costs nothing per turn,
  // so the recorder ships in the default set.
  return componentsValidForTarget(name);
}

function resolveHarnessComponents(name, options = {}) {
  const valid = componentsValidForTarget(name);
  const validSet = new Set(valid);
  const normalizeList = (input) => {
    if (!input) return [];
    return input
      .flatMap((item) => String(item).split(","))
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  };
  const only = normalizeList(options.components?.only);
  const withList = normalizeList(options.components?.with);
  const without = normalizeList(options.components?.without);
  const allRequested = [...only, ...withList, ...without];
  for (const component of allRequested) {
    if (!validSet.has(component)) {
      throw new Error(`unknown harness component: ${component}`);
    }
  }
  let selected;
  if (only.length > 0) {
    selected = [...new Set(only)];
    for (const component of withList) {
      if (!selected.includes(component)) selected.push(component);
    }
  } else {
    selected = defaultComponentsForTarget(name);
    for (const component of withList) {
      if (!selected.includes(component)) selected.push(component);
    }
  }
  for (const component of without) {
    selected = selected.filter((item) => item !== component);
  }
  if (name === "opencode") {
    const hasHook = selected.some((component) => component.startsWith("hook:"));
    if (hasHook && !selected.includes("opencode-plugin")) {
      selected.push("opencode-plugin");
    }
  }
  const selectedSet = new Set(selected);
  const omitted = valid.filter((component) => !selectedSet.has(component));
  return { selected, omitted };
}

function componentSelected(selected, component) {
  return selected.includes(component);
}

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
  if (!["codex", "claude", "opencode"].includes(name)) {
    throw new Error(`unsupported harness target: ${name}. Expected codex, claude, or opencode`);
  }
  if (name === "opencode") {
    const home = join(harnessHomeBase(options), ".config", "opencode");
    return {
      name,
      home,
      skillFile: join(home, "skills", "ipa", "SKILL.md"),
      hooksDir: join(home, "hooks"),
      hooksConfig: join(home, "settings.json"),
      localPrompt: "AGENTS.md",
      globalPromptFile: join(home, "AGENTS.md"),
      pluginFile: join(home, "plugins", "ipa-harness.js")
    };
  }
  const home = join(harnessHomeBase(options), name === "claude" ? ".claude" : ".codex");
  return {
    name,
    home,
    skillFile: join(home, "skills", "ipa", "SKILL.md"),
    hooksDir: join(home, "hooks"),
    hooksConfig: name === "claude" ? join(home, "settings.json") : join(home, "hooks.json"),
    localPrompt: name === "claude" ? "CLAUDE.md" : "AGENTS.md",
    globalPromptFile: join(home, name === "claude" ? "CLAUDE.md" : "AGENTS.md"),
    pluginFile: null
  };
}

function ipaCommandSelection(prefix = "ipa", mapping = DEFAULT_MAPPING) {
  return `## IPA Command Selection

- Exact note title known: \`${prefix} view "Note Title"\` (overview first), then \`--section\`/\`--full\` for the parts you actually need. Several notes: \`${prefix} view "A" "B" --full\` in one call.
- Index/root summary: \`${prefix} digest "Index Note"\` (children + snippets + dates), then \`view --full\` on at most the 2-3 most relevant children — never open every child.
- Count or list an index's children/backlinks: \`${prefix} digest "Index Note"\` or \`${prefix} traversal --down "Index Note"\` — read the count from their output instead of hand-rolling \`view | grep\` loops.
- Broad prior context or user-specific background: \`${prefix} context "keyword" --size medium --format markdown\`; widen with \`${prefix} search "other angle"\` only when context missed something. Several search angles go in one call — \`${prefix} search "A" "B" "C"\` (vault loads once). Results already carry snippets and dates — judge relevance from them before opening notes. Center context on one note instead of a free-text query with \`${prefix} context --by-note "Note Title"\`.
- Relate a note to an index (make it belong): \`${prefix} note set "Note" --field ${mapping.refs} --add "Index Note" --apply\` — the reliable belongs-to mechanism. \`${prefix} link apply\`/\`${prefix} cascade apply\` only wikify a title already present verbatim in the note body (a silent no-op otherwise); when the body has no plaintext mention of the target, use \`note set --field ${mapping.refs} --add\`. Read-only discovery only: \`${prefix} link suggest "Note Title"\` for candidate targets, \`${prefix} traversal --up|--down|--siblings "Note Title"\` for graph shape.
- New/empty vault with no \`.ipa/config.yaml\`: \`${prefix} config init\` (absorb existing folders with \`--inbox/--project/--archive\`, then edit to match), verify with \`${prefix} doctor\`. Closing setup: optionally confirm folder/field mapping (config.yaml) and operating rules (\`.ipa/harness/fragments/prompt.md\` → \`${prefix} harness update <target>\`) — the ipa-config skill has the interview. Never rename the user's folders or do vault-wide moves/backfills to fit defaults; absorb existing structure via mapping.
- New note: \`${prefix} inbox add ...\`. Body edit: \`${prefix} note replace ...\`. Frontmatter edit: \`${prefix} note set "Note" --field ${mapping.refs} --add "Index Note" --apply\`.
- Rename a note/index (note stays, inbound ${mapping.refs}/wikilinks auto-rewired): \`${prefix} rename "Old" "New" --apply\` (drop \`--apply\` for preview). Only when merging several notes into one: \`${prefix} note redirect\`.
- Reactivate an archived topic (move its root/index back to the project folder): \`${prefix} move "Note" "${mapping.project_dir}" --apply\` — inbound wikilinks keep resolving (they are folder-independent, so nothing needs rewiring; unlike rename, move does not rewrite link text).
- During note work always scope \`validator\`/\`formatter plan\` with \`--note\`; without it they are vault-wide maintenance sweeps.
- Unsure command or syntax: \`${prefix} help\` or \`${prefix} <command> --help\`.
`;
}

// The global prompt block is loaded into every session, vault-related or not,
// so it stays pointer-level: when to reach for ipa, where the detail lives
// (skill, --help, ipa convention), and the two guard rails that hooks enforce.
function globalPromptContent(spec) {
  const tool = spec.name === "claude" ? "Claude Code" : spec.name === "opencode" ? "OpenCode" : "Codex";
  const skillPath = spec.name === "opencode" ? "~/.config/opencode/skills/ipa/SKILL.md" : `~/.${spec.name}/skills/ipa/SKILL.md`;
  return `## IPA Vault — Evidence-Based Work

This ${tool} environment has the IPA CLI installed for the user's IPA note vault (prior work, decisions, project history, user-specific context).

- When a request touches the vault, vault notes, or the user's prior work/decisions, answer from vault evidence: drive the work through \`ipa\` commands from the first turn instead of answering from memory or reading vault files directly.
- Entry points: \`ipa search "keyword"\` (discovery; several quoted queries in one call: \`ipa search "A" "B"\`), \`ipa view "Note Title"\` (read), \`ipa context "keyword" --size medium --format markdown\` (broad/history bootstrap). Full workflow: the \`ipa\` skill at \`${skillPath}\`; exact syntax: \`ipa <command> --help\`.
- On an index or root note, run \`ipa digest\` before opening any child, then read at most 2-3 in full — and once you already have enough evidence, converge on the answer instead of opening more notes or digesting ones you already read.
- IPA concepts and this vault's operating rules: \`ipa convention\`.
- Create new vault notes only through \`ipa inbox add\` — a guard hook blocks new markdown outside the inbox.
- After editing vault markdown, finish the note-scoped loop: \`ipa validator --note ...\`, \`ipa formatter plan --note ...\`, \`ipa formatter apply --note ...\`. A Stop gate blocks final responses while formatter patches remain.`;
}

function profileRegistryDisplay() {
  return process.env.XDG_CONFIG_HOME ? "$XDG_CONFIG_HOME/ipa/profile.yaml" : "~/.config/ipa/profile.yaml";
}

function commandPrefix(vaultPath, options = {}, local = false) {
  return "ipa";
}

const VAULT_LOCAL_SKILLS = [
  {
    name: "ipa-rule",
    description: "Create, modify, review, and debug IPA vault convention rules using .ipa/plugins/rules/*.js and formatter fixes. Use this skill whenever the user mentions IPA rules, vault conventions, frontmatter requirements, title/tag/ref validation, folder/type policy, validator warnings, formatter rule fixes, or wants the vault to enforce a custom convention.",
    body: (mapping) => `# IPA Rule Skill

Use this skill when the user wants to add, change, review, or debug IPA vault conventions such as frontmatter rules, note title rules, folder/type rules, tag rules, or formatter fixes.

## Workflow

1. Inspect the active convention surface with \`ipa list-rules\` and \`ipa validator\`.
2. Scaffold plugin authoring files with \`ipa plugin init\` if \`.ipa/plugins\` is missing; it drops runnable \`_example-*.js\` rules to copy from.
3. Read \`.ipa/plugins/types/ipa-plugin.d.ts\` for the \`Note\` and \`RuleContext\` field shapes — read it to learn the field shapes before writing check logic. Use \`// @ts-check\` and \`import("../types/ipa-plugin").Rule\` in each rule file.
4. Write the check as a \`checkNote(note, ctx)\` rule under \`.ipa/plugins/rules/*.js\`. Count an index's children with \`ctx.childCount(note)\` and a note's inbound references (notes pointing at it through \`${mapping.refs}\`) with \`ctx.backlinkCount(note)\` — both apply the vault's title-normalized matching. Reserve \`checkVault(ctx)\` / \`scope: "vault"\` for whole-vault aggregates; those are exercised by \`ipa validator\`, not by dry-run.
5. Verify instantly with \`ipa plugin dry-run rules .ipa/plugins/rules/<rule>.js --note "Note Title"\` — a \`checkNote\` rule fires per note here, so you see it the moment you save.
6. Validate the plugin shape with \`ipa plugin validate .ipa/plugins/rules/<rule>.js\`, then re-run \`ipa list-rules\` and \`ipa validator\` after enabling it.
7. If the rule has a safe fix, verify the formatter loop with \`ipa formatter plan --note "Note Title"\` and \`ipa formatter apply --note "Note Title"\`.

Inspect and debug installed plugins with \`ipa plugin list\` and \`ipa plugin doctor\`.

Keep rules narrow and convention-focused. Do not use rule plugins for search ranking; use an IPA search plugin or the ipa-tune workflow instead.`
  },
  {
    name: "ipa-config",
    description: "Configure IPA vault and profile settings in .ipa/config.yaml and the global IPA profile registry. Use this skill whenever the user asks about ipa config init, ipa config show, IPA_PROFILE, profile init/new/use/list/current, vault selection, bootstrapping a new/empty vault, folder/field mapping, files.exclude, plugin enablement, search channels, test.file, weights.file, or profile/config troubleshooting.",
    body: `# IPA Config Skill

Use this skill when the user wants to inspect or change IPA profile selection, vault mappings, folder names, plugin policy, search channels, active tune results, or \`.ipa/config.yaml\`.

## Workflow

1. Resolve the active context first with \`ipa config show\`.
2. If \`.ipa/config.yaml\` is missing (new/empty vault), create it with \`ipa config init\` — absorb an existing folder layout via \`--inbox/--project/--archive\`, then edit \`mapping\` so folder/field names match the vault. Match the config to the vault, not the vault to the defaults.
3. Propose the setup plan from a quick structural scan — the folder layout plus a handful of sample notes' frontmatter. Do not exhaustively enumerate every note or every frontmatter key before proposing; refine after the user confirms.
4. Inspect profile state with \`ipa profile current\` and \`ipa profile list\`.
5. Create or update profiles with \`ipa profile init --vault <path>\`, \`ipa profile new <name> <path>\`, or \`ipa profile use <name>\`.
6. Keep machine-global profile concerns in the profile registry and vault-specific policy in \`.ipa/config.yaml\`.
7. For vault-local config, prefer minimal edits to mapping, folders, files.exclude, plugins, search channel toggles, test.file, and weights.file.
8. After changing \`mapping\` fields or folder names, re-render the installed harness with \`ipa harness update <target>\` (for example \`ipa harness update claude\`): prompt blocks and skills print the mapped field/folder names, so they stay stale until re-rendered.
9. Verify config-sensitive behavior with \`ipa config show\`, \`ipa list-rules\`, \`ipa list-channels\`, \`ipa validator\`, and a focused \`ipa search "keyword"\`.

## Onboarding Close

Before finishing a fresh setup, optionally (offer it; the user may skip) confirm two categories of vault policy. The organizing principle: CLI에 담을 칸이 있으면 config.yaml, 없으면 fragment.

- **Mapping — has a config slot.** Existing folder names → inbox/project/archive and frontmatter field names go in \`.ipa/config.yaml\` via \`ipa config init --inbox/--project/--archive\` (then edit \`mapping\`). Absorb the vault's real structure; do not reshape the vault to the defaults.
- **Operating rules — no config slot, pure policy.** Ask up to four short questions: ⓐ where work/scratch docs go, ⓑ auto-migrate/organize vs confirm each time, ⓒ folders/notes never to touch, ⓓ title/tag conventions. Write the answers into \`.ipa/harness/fragments/prompt.md\` (\`ipa config init\` seeds an empty template there), then \`ipa harness update <target>\` to inline them into managed prompts.

Hard rule regardless of answers: never rename the user's folders or run vault-wide changes (mass move/backfill) without asking — absorb the existing structure through mapping instead.

Do not hard-code one user's absolute vault path into vault-local files. Use project-local selectors, profiles, or documented setup commands instead.`
  },
  {
    name: "ipa-tune",
    description: "Guide IPA search tuning from recent search logs to labelled testsets, tune result analysis, and safe activation. Use this skill whenever the user wants better IPA search results, says a search result was wrong, asks to review tune logs, sample cases, label correct notes, build or validate a testset, analyze weights/threshold/cap, or apply a tune result.",
    body: `# IPA Tune Skill

Use this skill when the user wants to improve IPA search quality, review misses, create search evaluation cases, analyze tune results, or apply tuned weights.

## Rules

- Treat prompt and search logs as evidence, not labels. A prompt event tells you what the user asked; it does not prove the correct note.
- In harness sessions, prompts and search calls are logged automatically (\`prompt_event_id\`/\`source_prompt\` connect them); use plain \`ipa search "keyword"\` for evidence collection. \`IPA_SEARCH_LOG=1\` remains a compatibility fallback for non-harness searches.
- Use \`prompt_event_id\`, \`turn_id\`, \`source_prompt\`, and \`generated_query\` to connect prompt/search pairs. If a prompt has no matching search event, treat it as "no query was run" rather than inferring one from nearby timestamps.
- Do not run the optimizer by default. Present the command and wait unless the user explicitly asks you to execute it.
- Do not activate a tune result just because it is newest. Activate only a reviewed artifact that improves the target cases without obvious regressions.

## Workflow

1. Confirm the active tune surface before changing anything:
   - Run \`ipa config show\` when vault/profile selection might matter.
   - Run \`ipa tune testset list\` to see the configured \`.ipa/config.yaml\` \`test.file\`.
   - Run \`ipa tune testset show\` or \`ipa tune testset show <file>\` to inspect the current cases and query count.
   - If no vault-local testset exists, initialize one with \`ipa tune testset init --file testset.json\`. Do not use the sample \`ipa-cli-core\` pack unless the user explicitly asks for a fixture/demo pack.
2. Gather evidence from recent activity:
   - Inspect recent events with \`ipa tune log --limit 50\`.
   - Narrow noisy logs with \`ipa tune log --query "keyword"\`.
   - If the log only has prompt events or lacks result lists, rerun focused \`ipa search "keyword"\` checks before drafting labels.
   - Preserve the user's natural query text when it is the query being evaluated; do not replace it with an internal summary unless you are creating a separate variant case.
3. Draft or fetch candidate test cases:
   - Use \`ipa tune testset draft --file testset.json\` to convert logged events that already contain explicit targets into a draft file.
   - Expect \`draft\` to produce zero cases when logs contain only prompts/search results without a \`target\`, \`note\`, \`selected\`, or \`clicked\` field.
   - After drafting, run \`ipa tune testset show testset.json\` and review every row. Do not bulk-accept draft rows without checking the query and target.
4. Confirm labels with the user before adding cases:
   - Show the original request/context, exact search query, observed top results, and the proposed target note.
   - Ask which note should be the correct target when the query failed, was ambiguous, or came from a prompt event.
   - Do not infer a label from an "obvious" top result. No explicit confirmation means no \`testset add\`.
5. Add confirmed cases deliberately:
   - Use \`ipa tune testset add --file testset.json --query "user query" --target "Correct Note"\` for each confirmed regression case.
   - Use the exact note title accepted by IPA search/view, not a raw path.
   - If the user wants an audit trail, also record \`ipa tune label --query "user query" --target "Correct Note"\`; this does not replace adding the case to the testset.
   - Keep scenario or multi-target cases as manual JSON edits only when needed, then validate immediately.
6. Validate and baseline before tuning:
   - Run \`ipa tune testset validate testset.json\` and resolve missing targets or malformed cases first.
   - Run \`ipa tune eval\` to establish baseline loss, miss count, average rank, and the active pack path.
   - For important misses, run focused \`ipa search "keyword"\` checks so the user can see the current behavior.
7. Propose the tune run:
   - Recommend a command such as \`ipa tune --trials 200\` for a small/medium testset or \`ipa tune --trials 500 --quiet\` for a broader one.
   - Use \`--apply\` only when the user explicitly wants the new result activated immediately.
   - Otherwise, present the command and wait for the user to run it.
8. Review tune artifacts after a run:
   - Run \`ipa tune list\` to identify the newest result and the active marker.
   - Run \`ipa tune analyze\` to inspect threshold/cap behavior and score distribution.
   - Run \`ipa tune replay <result.json>\` when comparing a saved artifact against the current vault/testset.
   - Summarize weight, threshold, cap, loss, hit/miss, and average-rank changes. Call out likely regressions.
9. Activate only a reviewed result:
   - Use \`ipa tune use <result.json>\` only for the artifact the user chose.
   - Run \`ipa tune eval\` after activation to confirm the active weights behave as expected.
   - Re-run focused \`ipa search "keyword"\` checks for the original problem queries and any regression-sensitive queries.
10. Close the loop:
   - Report what was added to the testset, which result was reviewed or activated, and which searches verify the behavior.
   - If the result is weak, recommend more representative labels instead of simply increasing trial count.

## Label Confirmation Protocol

Before adding any testset case, present candidates in this form:

\`\`\`text
Original request/context: ...
Search query: ...
Observed results:
1. Note A
2. Note B
3. Note C

Which note should be the correct target for this query?
\`\`\`

If the user has not answered this question, do not run \`ipa tune testset add\` for that case. This applies even when the top result looks correct.

Treat tuning as an evaluation loop, not a one-off command. Prefer better labels and representative cases over simply increasing trial count.`
  },
  {
    name: "ipa-triage",
    description: "Triage IPA inbox notes into the archive: confirm refs/tags, wire wikilinks, validate, and move approved notes. Use this skill whenever the user wants to clean up or empty the inbox, triage notes, confirm refs/tags for new notes, or move finished notes to the archive.",
    body: (mapping) => `# IPA Triage Skill

Move finished inbox notes into the archive: confirm refs/tags → wire links → validate → move after approval. Triage connects and moves notes that are already written; it does not create notes or deepen their content.

When a triage sweep moves or archives several notes at once, surface the full per-note plan (the \`ipa inbox triage\`/\`ipa cascade plan\` dry-run output) and run each \`--apply\` step only after the user confirms; a single-note capture or edit needs no such round-trip.

## Workflow

1. Scan the inbox: \`ipa review inbox\` lists notes and issues (missing refs/tags). If the user named specific notes, triage only those; with 10+ notes, work in batches the user confirms.
2. Confirm refs/tags per note:

\`\`\`bash
ipa view "Note" --full
ipa inbox triage --note "Note"           # ref/tag suggestions
ipa search "keyword"                     # verify suggestions, find candidates
ipa traversal --down "Candidate Index"   # see what already lives under a candidate
\`\`\`

   Refs must point at existing index notes — a note points at an index, not directly at a root. Reuse existing tags; add a new tag only when it cuts across more than one index. If no index fits, ask the user whether to create one. A note that is only a line or two, or clearly unfinished, stays in the inbox — report it as needing enrichment instead of forcing a move.

   Apply confirmed values with \`ipa inbox triage --apply --note "Note"\`, or adjust manually with \`ipa note set "Note" --field ${mapping.refs} --add "Index Note" --apply\`.
3. Wire the note into the graph: \`ipa cascade plan --note "Note"\`, then \`ipa cascade apply --note "Note" --only links\`. Never auto-merge duplicate candidates — compare contents, ask the user, and on an approved merge combine with \`ipa note replace\` then rewire references with \`ipa note redirect --archive --apply\`.
4. Validate: \`ipa validator --note "Note"\` → \`ipa formatter plan --note "Note"\` → \`ipa formatter apply --note "Note"\`.
5. Move after approval: present a summary table (note, refs, tags, action) and ask which notes to move. Move only the approved ones: \`ipa move "Note" "${mapping.archive_dir}" --apply\` (wikilinks update automatically).
6. Report moved notes, held notes with reasons, and recommended follow-ups.

## Must Not

- Move a note to the archive without user approval.
- Edit note bodies beyond wikilink insertion or an approved merge.
- Add a ref to an index that does not exist.
- Auto-merge suspected duplicates.`
  },
  {
    name: "ipa-review",
    description: "Diagnose IPA vault structural health — tag hygiene, index/root structure, link integrity, frontmatter consistency — vault-wide or for one subtree, then fix approved issues. Use this skill whenever the user asks for a vault review, health check, tag cleanup, orphan notes, broken links, index structure, or frontmatter consistency.",
    body: (mapping) => `# IPA Review Skill

Diagnose vault structure, report by category, and fix only what the user approves.

## Workflow

1. Scope: vault-wide by default; when the user names a root/index, limit the review to its subtree (\`ipa traversal --down "Root Note"\`).
2. Scan:

\`\`\`bash
ipa review all --suggest-refactor   # convention, inbox, duplicates, tags, sot
ipa validator                       # frontmatter, broken links, orphan notes
\`\`\`

   The \`sot\` scope (report-style pileups under one index) stays silent until \`review.sot.title_patterns\` is set in \`.ipa/config.yaml\`.
   Categories to cover: tag health (near-duplicate or one-off tags), index structure (overcrowded, empty, or overlapping indexes), root structure (areas missing a root), link health (orphan notes without \`${mapping.refs}\`, broken wikilinks, notes pointing directly at a root), and frontmatter consistency.
3. Report a chat summary per category with issue counts and affected notes, then ask which items to fix.
4. Fix approved items only:

\`\`\`bash
ipa note set "Note" --field ${mapping.tags} --add "tag" --apply     # few notes
ipa move "Note" "${mapping.archive_dir}" --apply                    # relocation
ipa formatter plan --note "Note A" "Note B"                         # then matching apply
ipa refactor ref-replace "Old Index" "New Index" --apply            # bulk changes: plan first (no --apply), then apply
ipa refactor tag-rename old_tag new_tag --apply
ipa refactor wikilink-replace "Old" "New" --apply
\`\`\`

   \`ipa refactor\` also supports \`ref-add\`, \`ref-remove\`, \`tag-remove\`, and \`tag-add\` — see \`ipa refactor --help\`.
5. Summarize the applied changes.

## Must Not

- Edit a single note's body content (that is enrichment work, not review).
- Apply any fix without user approval.
- Create index/root notes without user approval.`
  },
  {
    name: "ipa-consult",
    description: "Consult on the IPA method and this vault's operation: explain IPA concepts and design intent, listen to friction (\"this is inconvenient\", \"the vault feels messy\"), diagnose from vault evidence, and route the fix to the right IPA capability. Use this skill whenever the user asks what IPA/index/root/refs/tags mean, why the vault is organized this way, how to organize something, or complains about vault workflow friction.",
    body: (mapping) => `# IPA Consult Skill

Act as an IPA method consultant: explain concepts with their design intent, and turn workflow friction into a diagnosis plus a concrete lever. This skill advises and routes — it does not apply changes itself; execution belongs to the skill or command it points at.

Difference from ipa-review: review mechanically detects and fixes convention violations; consult handles "why does this hurt and which mechanism fixes it for good".

## Read First

Ground every answer in the vault, not memory:

\`\`\`bash
ipa convention                 # concepts, field/folder mapping, this vault's operating rules
ipa search "IPA"               # vault-local philosophy/decision notes, if any
ipa digest                     # current shape: counts, largest indexes, orphans
\`\`\`

## Core Design Intent

The source of truth for IPA philosophy is the Design Intent section of \`ipa convention\` — read it before answering, and explain the why, not just the definition. The load-bearing ideas: folders express only lifecycle state while classification lives in links (\`${mapping.refs}\` vertical, \`${mapping.tags}\` horizontal — orthogonal, never interchangeable); index/root notes are pure navigation with no content; only the project folder is actively managed; and IPA deliberately covers only "record and retrieve" — requests to shape thinking or drive execution are outside its domain, and saying so is a valid answer.

## Mode 1 — Concept Q&A ("what is an index", "refs vs tags")

\`ipa convention\` is the authoritative source for definitional and concept questions — answer directly from it, using this vault's real field/folder names and explaining the design intent behind the rule. Illustrate with at most one related note found via \`ipa search\`; do not survey the whole vault (\`ipa digest\`, \`ipa review all\`, repeated search/view) to settle a question \`ipa convention\` already answers.

## Mode 2 — Friction Counseling ("X is inconvenient", "how do I organize Y")

1. Clarify the friction first: when does it occur, in which workflow step, how often.
2. Scan for evidence before advising: \`ipa validator\`, \`ipa review all\`, \`ipa traversal --down "Root"\`, \`ipa tune log --limit 20\` — pick what matches the complaint.
3. Name the diagnosis, then route it to the mechanism that removes the friction permanently:

| Friction | Lever |
|---|---|
| "I keep forgetting/violating convention X" | Add a rule plugin — ipa-rule skill |
| "Search does not find the right note" | Label cases and tune — ipa-tune skill |
| "Field or folder names do not fit how I think" | Remap in config — ipa-config skill (then \`ipa harness update\`) |
| "The inbox keeps piling up" | Batch triage — ipa-triage skill |
| "Tags/indexes/links feel messy" | Structural health pass — ipa-review skill |
| "Agents keep doing X wrong in this vault" | Add an operating rule fragment under \`.ipa/harness/fragments/\` |
| "The same manual fix repeats" | Rule plugin with a safe fix so the formatter applies it |

4. Prefer the smallest lever that removes the cause; a one-off manual cleanup that will recur is not a resolution.

Vault operating rules belong in \`.ipa/harness/fragments/prompt.md\` (then \`ipa harness update <target>\`), never in the \`IPA_HARNESS_MANAGED\` block of \`CLAUDE.md\`/\`AGENTS.md\` — doctor flags a hand-edited managed block as drift and \`harness update\` overwrites it.

## Must Not

- Apply fixes, move notes, or edit config in this skill — hand off to the routed skill and say why.
- Answer philosophy questions from general knowledge when \`ipa convention\` or a vault note contradicts it.
- Recommend restructuring beyond what the observed friction justifies.`
  }
];

function vaultLocalSkillRootRel(spec) {
  if (spec.name === "opencode") return ".opencode/skills";
  if (spec.name === "claude") return ".claude/skills";
  return ".agents/skills";
}

function vaultLocalSkillRelPath(spec, name) {
  return `${vaultLocalSkillRootRel(spec)}/${name}/SKILL.md`;
}

function vaultLocalSkillContent(skill, mapping = DEFAULT_MAPPING) {
  const body = typeof skill.body === "function" ? skill.body(mapping) : skill.body;
  return `---
name: ${skill.name}
description: ${JSON.stringify(skill.description)}
---

<!-- ${HARNESS_MARKER} -->

${body.trim()}
`;
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

// Claude Code permission rule that lets `ipa` shell commands run without a
// per-call approval prompt in agent sessions. Registered in the user-owned
// ~/.claude/settings.json under permissions.allow by the "permissions"
// harness component.
const CLAUDE_PERMISSION_RULE = "Bash(ipa *)";

function mergeClaudePermissionRule(config) {
  if (!config.permissions || typeof config.permissions !== "object") config.permissions = {};
  if (!Array.isArray(config.permissions.allow)) config.permissions.allow = [];
  if (!config.permissions.allow.includes(CLAUDE_PERMISSION_RULE)) {
    config.permissions.allow.push(CLAUDE_PERMISSION_RULE);
  }
}

// Mirror removeManagedHookCommands: drop only our own entry and prune the
// containers we own once they go empty, leaving every other permission intact.
function removeClaudePermissionRule(config) {
  if (!config.permissions || !Array.isArray(config.permissions.allow)) return;
  config.permissions.allow = config.permissions.allow.filter((rule) => rule !== CLAUDE_PERMISSION_RULE);
  if (!config.permissions.allow.length) delete config.permissions.allow;
  if (config.permissions && !Object.keys(config.permissions).length) delete config.permissions;
}

function claudePermissionRulePresent(spec) {
  if (spec.name !== "claude") return false;
  try {
    const config = JSON.parse(readFileSyncText(spec.hooksConfig) || "{}");
    return Array.isArray(config.permissions?.allow) && config.permissions.allow.includes(CLAUDE_PERMISSION_RULE);
  } catch {
    return false;
  }
}

function hookCommand(path, spec) {
  const home = spec ? dirname(spec.home) : null;
  if (home) {
    const rel = relative(home, path);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel) && !/\s/.test(rel)) {
      return `node ~/${rel.split(sep).join("/")}`;
    }
  }
  return `node ${shellQuote(path)}`;
}

function sessionEnvScript(options = {}) {
  const env = { IPA_SEARCH_LOG: "1", ...(options.env ?? {}) };
  return `#!/usr/bin/env node
// ${HARNESS_MARKER}: IPA session environment defaults.
import { appendFileSync } from "node:fs";

const envFiles = [...new Set([process.env.CLAUDE_ENV_FILE, process.env.CODEX_ENV_FILE].filter(Boolean))];
const env = ${JSON.stringify(env)};

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

const IPA_MANAGED_HOOK_SCRIPTS = [
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

function isManagedHookCommand(command) {
  return typeof command === "string" && IPA_MANAGED_HOOK_SCRIPTS.some((name) => command.includes(name));
}

// Remove every IPA-managed hook entry regardless of how its path was spelled
// (legacy absolute paths, other-machine home paths, or ~ paths). Matching by
// script basename lets install/uninstall clean up entries this machine could
// not otherwise recognize, so a re-install converges on a single ~ entry.
function removeManagedHookCommands(config) {
  if (!config.hooks) return;
  for (const event of Object.keys(config.hooks)) {
    config.hooks[event] = (config.hooks[event] ?? [])
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isManagedHookCommand(hook.command)) }))
      .filter((group) => group.hooks.length);
    if (!config.hooks[event].length) delete config.hooks[event];
  }
}

async function writeManagedFile(path, content, files, skipped = null) {
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const previous = await readFile(path, "utf8");
    if (previous === content) {
      files.push(path);
      return;
    }
    if (!previous.includes(HARNESS_MARKER)) {
      // A managed-target file without the marker is user-owned (either a
      // pre-existing file or a deliberately forked copy with the marker
      // stripped). Never overwrite it; report it as skipped instead.
      if (skipped) skipped.push(path);
      return;
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

async function writeManagedVaultFile(vaultPath, relPath, content, files, skipped = null) {
  const written = [];
  const skippedAbs = [];
  await writeManagedFile(join(vaultPath, relPath), content, written, skippedAbs);
  if (written.length) files.push(relPath);
  if (skipped && skippedAbs.length) skipped.push(relPath);
}

async function removeManagedVaultFile(vaultPath, relPath, removed) {
  const before = removed.length;
  await removeManagedFile(join(vaultPath, relPath), removed);
  if (removed.length > before) removed[removed.length - 1] = relPath;
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

function harnessSkillContent(vaultPath, spec, mapping = DEFAULT_MAPPING, options = {}) {
  const prefix = commandPrefix(vaultPath, options);
  return `---
name: ipa
description: Entry point for every IPA vault task — search, read, validate, format, and safely write vault notes with the ipa CLI, and route focused work (concept questions, triage, review, tuning, rules, config) to the vault's helper skills. Use when a task mentions IPA, the vault, a vault note, inbox capture, note search, note validation, note formatting, asks what an IPA concept means, or references a note path under the vault folders (\`${mapping.inbox_dir}/\`, \`${mapping.project_dir}/\`, \`${mapping.archive_dir}/\`, or \`.md\` files in ${vaultPath}).
---

<!-- ${HARNESS_MARKER} -->

# IPA CLI Skill

## Active Vault

- Target: ${spec.name}
- Vault: ${vaultPath}
- Profile registry: ${profileRegistryDisplay()}
- Vault config: .ipa/config.yaml
- IPA concepts + vault operating rules: \`${prefix} convention\`

Sessions running outside the vault directory do not load the vault's own \`${spec.localPrompt}\`; before writing or reorganizing notes from such a session, run \`${prefix} convention\` and read \`${vaultPath}/${spec.localPrompt}\` for user-maintained rules outside the managed block.

## Skill Routing

This skill is the single entry point for vault requests from any directory. Focused workflows live as vault-local skills under \`${vaultPath}/${vaultLocalSkillRootRel(spec)}/\`:

- \`ipa-consult\` — IPA concept questions ("what is an index", "refs vs tags") and workflow friction ("the vault feels messy", "X keeps bothering me")
- \`ipa-triage\` — inbox → refs/tags → wikilinks → archive processing
- \`ipa-review\` — vault or subtree structural health checks with approved fixes
- \`ipa-tune\` — search quality complaints, testset labelling, tune analysis
- \`ipa-rule\` — authoring vault convention rule plugins
- \`ipa-config\` — profile/config and field/folder mapping changes

Inside the vault these load as invocable skills — invoke the matching one. Outside the vault they are not auto-loaded: read the matching \`SKILL.md\` at the path above and follow its workflow with \`${prefix}\` commands. If the skill file does not exist, fall back to \`${prefix} convention\` and the commands below.

## Read First

\`\`\`bash
${prefix} view "Note Title"
${prefix} digest "Index Note"
${prefix} context "keyword" --size medium --format markdown
${prefix} search "keyword"
${prefix} search "keyword A" "keyword B" "keyword C"   # several queries, one call
\`\`\`

${ipaCommandSelection(prefix, mapping)}
Keep exploration proportional to the question: simple lookups within ~3 ipa calls, broad questions within ~8. At the budget, answer from the evidence gathered and state what was not checked. Pick short keywords or exact titles — never paste file paths or the full user prompt as a query.

If search results look stale after external (Obsidian) edits, diagnose the index fingerprint with \`${prefix} cache doctor\` and force a rebuild with \`${prefix} cache rebuild\`.

## Safe Writes

Mutating commands preview by default and write only with \`--apply\`. For a single-note mutation the user already asked for, a preview or plan is not the deliverable — re-run the same command with \`--apply\` to actually write. The exception is a multi-note or bulk mutation (a triage sweep, a mass move or refactor) in an interactive session: surface the per-note plan, get the user's confirmation, then run \`--apply\`.

New Markdown notes belong in the configured inbox:

\`\`\`bash
${prefix} inbox add ./draft.md --title "Title" --ref "Index Note" --tag "topic"
\`\`\`

Set refs and tags (frontmatter \`${mapping.refs}\`/\`${mapping.tags}\`) at capture time — do not leave them for later. Reuse the vault's existing tag vocabulary first (\`${prefix} inbox triage --note "Title"\` suggests refs/tags from it). Create a new tag only when it names a perspective that cuts across more than one index; a tag as narrow as a single note or a single index adds no retrieval value — put that meaning in the ref instead.

After editing vault Markdown, finish the note-scoped loop (vault-wide runs are maintenance sweeps — always scope with \`--note\`):

\`\`\`bash
${prefix} validator --note "Edited Note"
${prefix} formatter plan --note "Edited Note"
${prefix} formatter apply --note "Edited Note"
\`\`\`

Multiple edited notes take one \`--note\` followed by all titles: \`${prefix} formatter plan --note "Note A" "Note B"\`, then the matching \`${prefix} formatter apply --note "Note A" "Note B"\`. The harness Stop hook blocks final responses while edited notes still have formatter patches — do not stop at plan-only.

Never edit the time fields (\`${mapping.created_at}\`/\`${mapping.updated_at}\`) by hand: core-backed writes and \`formatter apply\` keep them in sync. A stale-looking date is not a task to fix.

## Scripted Edits

Prefer core-backed commands over scanning vault folders with \`fs\`:

\`\`\`bash
${prefix} note replace "Note Title" --old-file .tmp/old-block.txt --new-file .tmp/new-block.txt --apply
${prefix} note set "Note Title" --field ${mapping.refs} --add "Index Note" --apply
${prefix} note set "Note Title" --field ${mapping.note_type} --value index --apply
\`\`\`

\`note replace --apply\` removes its \`.tmp/\` input files automatically (\`--keep-files\` to keep them). Inside the \`ipa-cli\` workspace, one-off scripts may import core helpers (\`replaceInNote\`, \`rewriteNote\` from \`./packages/core/dist/index.js\`) — never hard-code vault folder paths.

## Vault Convention And Plugins

Vault-specific conventions are code, not prose: convention checks live in \`.ipa/plugins/rules/*.js\`, retrieval boosts in \`.ipa/plugins/search/*.js\`, and session-end policy in \`.ipa/plugins/gates/*.js\` (run by the Stop gate via \`${prefix} harness gate\`). Authoring and verification (\`${prefix} plugin init\` scaffold → \`plugin validate\` → \`plugin dry-run\`) follow the \`ipa-rule\` skill workflow.
`;
}

// The vault-local block carries only vault-specific facts. Generic IPA
// workflow lives in the global skill; concepts and operating rules are
// queryable via `ipa convention` — do not duplicate them here.
function localPromptContent(vaultPath, spec, mapping, options = {}) {
  const prefix = commandPrefix(vaultPath, options, true);
  const skillRoot = vaultLocalSkillRootRel(spec);
  return `## IPA CLI Harness

This vault has an IPA CLI harness installed for ${spec.name}. Vault work goes through the \`${prefix}\` CLI — full workflow and safe-write rules in the global \`ipa\` skill, IPA concepts and this vault's operating rules via \`${prefix} convention\`, exact syntax via \`${prefix} <command> --help\`.

- Folders: inbox \`${mapping.inbox_dir}\`, project \`${mapping.project_dir}\`, archive \`${mapping.archive_dir}\`
- Vault config: .ipa/config.yaml; profile registry: ${profileRegistryDisplay()}
- Vault-specific conventions are enforced by \`.ipa/plugins/rules/*.js\`, retrieval boosts by \`.ipa/plugins/search/*.js\`, session-end policy by \`.ipa/plugins/gates/*.js\`; verify with \`${prefix} plugin validate\` and \`${prefix} plugin dry-run\`.
- In harness sessions plain \`${prefix} search "keyword"\` calls are logged as tune evidence automatically.

Focused workflows live as skills under \`${skillRoot}/\` — routing map in the global \`ipa\` skill.
`;
}

async function uninstallVaultLocalSkills(vaultPath, spec) {
  const removed = [];
  for (const skill of VAULT_LOCAL_SKILLS) {
    await removeManagedVaultFile(vaultPath, vaultLocalSkillRelPath(spec, skill.name), removed);
  }
  return removed;
}

function vaultLocalSkillStatus(vaultPath, spec) {
  return Object.fromEntries(VAULT_LOCAL_SKILLS.map((skill) => [
    skill.name,
    hasManagedFile(join(vaultPath, vaultLocalSkillRelPath(spec, skill.name)))
  ]));
}

// Build a JS expression for the hook script that resolves the vault path at
// runtime instead of hard-coding an absolute path. Priority: (1) `ipa config
// show --json`, which is IPA's own resolution over env vars and the global
// profile registry (~/.config/ipa/profile.yaml) — the single source of truth;
// (2) the install machine's home-relative path as a fallback only when the ipa
// CLI is unavailable. This keeps a synced hook script working across machines
// with different home directories.
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

console.log([
  "[IPA] This prompt references a note path in the IPA vault (" + vaultPath + ").",
  "Resolve it through the ipa CLI (global ipa skill) instead of reading the file directly:",
  '- Note title = filename without the folder and ".md": ipa view "Note Title" (--full for the whole note).',
  '- Surrounding context: ipa search "keyword", ipa digest "Index Note".',
  "- Any vault edit goes through ipa commands and ends with the note-scoped validator/formatter loop."
].join("\\n"));
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
// ${HARNESS_MARKER}: prompt nudge after IPA vault Markdown edits.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const vaultPath = ${vaultResolverSnippet(vaultPath, options)};
const noteRoots = ${JSON.stringify([mapping.inbox_dir, mapping.project_dir, mapping.archive_dir].filter(Boolean))};
const prefix = "ipa";
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
const noteArg = JSON.stringify(noteTitle);
const message = [
  \`[IPA CLI] Vault Markdown changed: \${note}. Before finishing run:\`,
  \`  \${prefix} validator --note \${noteArg}\`,
  \`  \${prefix} formatter plan --note \${noteArg} && \${prefix} formatter apply --note \${noteArg}\`,
  "Do not stop at formatter plan unless it shows unexpected changes. Multiple notes: one --note followed by all titles."
].join("\\n");

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: message
  }
}) + "\\n");
`;
}

// Read the call-counter thresholds from vault config so install and the
// outdated-check re-render the exact same baked constants (a mismatch would make
// the outdated diff false-positive every time).
function callCounterOptions(config) {
  return {
    warnAt: config?.harness?.call_counter?.warn_at ?? 10,
    repeatEvery: config?.harness?.call_counter?.repeat_every ?? 6
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
if (!command || !/(^|[\\s;|&(])ipa\\s/.test(command)) process.exit(0);

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
entry.count += 1;
entry.updated_at = new Date().toISOString();
state.sessions[sessionId] = entry;
try {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n", "utf8");
} catch {
  // counting is best-effort
}

const count = entry.count;
if (count < WARN_AT || (count - WARN_AT) % REPEAT_EVERY !== 0) process.exit(0);

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

// PostToolUse (Bash) hook: record ipa dry-run mutations that were never
// followed by an --apply/apply sighting, so a session-end gate plugin can warn
// about unapplied plans. Recording only — silent on stdout. The ledger is a
// mechanism (a fact the gate can read); whether to warn/block on it is vault
// policy carried by a gate plugin.
function mutationLedgerScript(vaultPath, options = {}) {
  return `#!/usr/bin/env node
// ${HARNESS_MARKER}: track ipa dry-run mutations that were never applied.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const vaultPath = ${vaultResolverSnippet(vaultPath, options)};
const statePath = join(vaultPath, ".ipa", "harness", "mutation-pending.json");
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
if (!command || !/(^|[\\s;|&(])ipa\\s/.test(command)) process.exit(0);

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

// Split the bash line on shell separators so each ipa invocation is judged on
// its own — a chained \`ipa link plan ... && ipa link apply ...\` records then
// clears within one line. \`link\`/\`cascade\` resolve via their \`apply\`
// subcommand; \`rename\`/\`move\`/\`refactor\` resolve via --apply. This is
// command-name granularity only: no per-note or per-target correlation.
function classify(segment) {
  if (!/(^|[\\s(])ipa\\s/.test(segment)) return null;
  if (/(^|[\\s(])ipa\\s+link\\s+apply\\b/.test(segment)) return { command: "link", action: "apply" };
  if (/(^|[\\s(])ipa\\s+link\\s+plan\\b/.test(segment)) return { command: "link", action: "pending" };
  if (/(^|[\\s(])ipa\\s+cascade\\s+apply\\b/.test(segment)) return { command: "cascade", action: "apply" };
  if (/(^|[\\s(])ipa\\s+cascade\\s+plan\\b/.test(segment)) return { command: "cascade", action: "pending" };
  const family = segment.match(/(^|[\\s(])ipa\\s+(rename|move|refactor)\\b/);
  if (family) {
    return { command: family[2], action: /(^|\\s)--apply\\b/.test(segment) ? "apply" : "pending" };
  }
  return null;
}

const actions = command
  .split(/[;&|\\n()]+/)
  .map((segment) => classify(segment))
  .filter(Boolean);
if (!actions.length) process.exit(0);

let entries = [];
if (existsSync(statePath)) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (parsed && Array.isArray(parsed.mutations)) entries = parsed.mutations;
  } catch {
    // corrupt state — start over
  }
}
const cutoff = Date.now() - TTL_MS;
entries = entries.filter((item) => {
  const stamp = Date.parse(item?.ts ?? "");
  return Number.isNaN(stamp) || stamp >= cutoff;
});

for (const action of actions) {
  if (action.action === "apply") {
    entries = entries.filter((item) => !(item.command === action.command && item.session_id === sessionId));
  } else {
    entries.push({ command: action.command, session_id: sessionId, ts: new Date().toISOString() });
  }
}

try {
  if (entries.length) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ version: 1, mutations: entries }, null, 2) + "\\n", "utf8");
  } else if (existsSync(statePath)) {
    unlinkSync(statePath);
  }
} catch {
  // recording is best-effort
}
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
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: message,
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: message
    }
  }) + "\\n");
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
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: notices.join("\\n")
    }
  }) + "\\n");
}
`;
}

function opencodePluginScript(vaultPath, mapping, selected, options = {}) {
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
function harnessFragmentNames() {
  return ["skill", "prompt", "local-prompt", ...VAULT_LOCAL_SKILLS.map((skill) => skill.name)];
}

function harnessFragmentsRoot(vaultPath) {
  return join(harnessRoot(vaultPath), "fragments");
}

function readHarnessFragment(vaultPath, name) {
  const path = join(harnessFragmentsRoot(vaultPath), `${name}.md`);
  if (!existsSync(path)) return null;
  const text = readFileSyncText(path).trim();
  return text.length ? text : null;
}

function withVaultFragment(vaultPath, name, content) {
  const fragment = readHarnessFragment(vaultPath, name);
  if (!fragment) return content;
  const body = `\n## Vault Operating Rules\n\n${fragment}\n`;
  return content.endsWith("\n") ? `${content}${body}` : `${content}\n${body}`;
}

function harnessHookScriptContent(component, vaultPath, spec, mapping, options = {}) {
  switch (component) {
    case "hook:session-env": return sessionEnvScript();
    case "hook:guard": return inboxGuardScript(vaultPath, mapping.inbox_dir, options);
    case "hook:vault-ref": return vaultRefNudgeScript(vaultPath, mapping, options);
    case "hook:evidence": return promptEvidenceScript(vaultPath, { ...options, agent: spec.name });
    case "hook:markdown-nudge": return markdownWriteNudgeScript(vaultPath, mapping, options);
    case "hook:call-counter": return callCounterScript(vaultPath, options);
    case "hook:mutation-ledger": return mutationLedgerScript(vaultPath, options);
    case "hook:formatter-gate": return formatterGateScript(vaultPath, options);
    default: return null;
  }
}

// Single source of truth for every content-bearing harness artifact: install
// writes these entries and the outdated check re-renders them for comparison.
function harnessExpectedArtifacts(vaultPath, spec, mapping, selected, options = {}) {
  const artifacts = [];
  const isOpencode = spec.name === "opencode";
  if (componentSelected(selected, "skill")) {
    artifacts.push({ component: "skill", scope: "global", kind: "file", path: spec.skillFile, content: withVaultFragment(vaultPath, "skill", harnessSkillContent(vaultPath, spec, mapping, options)) });
  }
  if (!isOpencode) {
    for (const [component, script] of Object.entries(HARNESS_HOOK_COMPONENT_TO_SCRIPT)) {
      if (!componentSelected(selected, component)) continue;
      artifacts.push({ component, scope: "global", kind: "file", path: join(spec.hooksDir, script), content: harnessHookScriptContent(component, vaultPath, spec, mapping, options) });
    }
  } else if (spec.pluginFile) {
    const needsPlugin = componentSelected(selected, "opencode-plugin") || selected.some((component) => component.startsWith("hook:"));
    if (needsPlugin) {
      artifacts.push({ component: "opencode-plugin", scope: "global", kind: "file", path: spec.pluginFile, content: opencodePluginScript(vaultPath, mapping, selected, options) });
    }
  }
  if (componentSelected(selected, "prompt")) {
    artifacts.push({ component: "prompt", scope: "global", kind: "block", path: spec.globalPromptFile, content: withVaultFragment(vaultPath, "prompt", globalPromptContent(spec)) });
  }
  if (componentSelected(selected, "local-prompt")) {
    artifacts.push({ component: "local-prompt", scope: "vault", kind: "block", path: join(vaultPath, spec.localPrompt), content: withVaultFragment(vaultPath, "local-prompt", localPromptContent(vaultPath, spec, mapping, options)) });
  }
  if (componentSelected(selected, "local-skills")) {
    for (const skill of VAULT_LOCAL_SKILLS) {
      artifacts.push({ component: "local-skills", scope: "vault", kind: "file", path: join(vaultPath, vaultLocalSkillRelPath(spec, skill.name)), content: withVaultFragment(vaultPath, skill.name, vaultLocalSkillContent(skill, mapping)) });
    }
  }
  return artifacts;
}

function readManagedBlockBody(path) {
  if (!existsSync(path)) return null;
  const begin = `<!-- ${HARNESS_MARKER}_BEGIN:${HARNESS_MANAGED_BLOCK} -->`;
  const end = `<!-- ${HARNESS_MARKER}_END:${HARNESS_MANAGED_BLOCK} -->`;
  const text = readFileSyncText(path);
  const beginIdx = text.indexOf(begin);
  const endIdx = text.indexOf(end);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return null;
  return text.slice(beginIdx + begin.length, endIdx).trim();
}

// Installed-but-different components. Missing artifacts stay out of this list;
// presence is already reported by status/doctor. Files whose HARNESS_MARKER was
// stripped are treated as user-owned and skipped.
function harnessOutdatedComponents(vaultPath, spec, mapping, selected, options = {}) {
  const outdated = new Set();
  for (const artifact of harnessExpectedArtifacts(vaultPath, spec, mapping, selected, options)) {
    if (artifact.kind === "block") {
      const body = readManagedBlockBody(artifact.path);
      if (body !== null && body !== artifact.content.trim()) outdated.add(artifact.component);
    } else if (existsSync(artifact.path)) {
      const text = readFileSyncText(artifact.path);
      if (text.includes(HARNESS_MARKER) && text !== artifact.content) outdated.add(artifact.component);
    }
  }
  return [...outdated];
}

// Components whose managed-target file exists but no longer carries the
// HARNESS_MARKER: the user forked it (or it predates the install). Blocks are
// excluded — they live inside user-owned files by design.
function harnessUserOwnedComponents(vaultPath, spec, mapping, selected, options = {}) {
  const userOwned = new Set();
  for (const artifact of harnessExpectedArtifacts(vaultPath, spec, mapping, selected, options)) {
    if (artifact.kind !== "file") continue;
    if (managedFileState(artifact.path) === "user") userOwned.add(artifact.component);
  }
  return [...userOwned];
}

async function installGlobalHarness(vaultPath, spec, mapping, options = {}) {
  const selected = options.components?.selected
    ? options.components.selected
    : defaultComponentsForTarget(spec.name);
  const files = [];
  const skipped = [];
  const isOpencode = spec.name === "opencode";
  const envPath = join(spec.hooksDir, "ipa-session-env.mjs");
  const guardPath = join(spec.hooksDir, "ipa-inbox-guard.mjs");
  const promptPath = join(spec.hooksDir, "ipa-prompt-evidence.mjs");
  const writeNudgePath = join(spec.hooksDir, "ipa-md-write-nudge.mjs");
  const callCounterPath = join(spec.hooksDir, "ipa-call-counter.mjs");
  const mutationLedgerPath = join(spec.hooksDir, "ipa-mutation-ledger.mjs");
  const formatterGatePath = join(spec.hooksDir, "ipa-formatter-gate.mjs");
  const vaultRefPath = join(spec.hooksDir, "ipa-vault-ref-nudge.mjs");

  for (const artifact of harnessExpectedArtifacts(vaultPath, spec, mapping, selected, options)) {
    if (artifact.scope !== "global") continue;
    if (artifact.kind === "block") {
      await upsertManagedBlock(artifact.path, artifact.content);
      files.push(artifact.path);
    } else {
      await writeManagedFile(artifact.path, artifact.content, files, skipped);
    }
  }

  if (!isOpencode) {
    // The hooks config (and, for claude, the permission rule) live in a
    // user-owned settings file. A hand-edited/unparseable file must never be
    // clobbered: skip registration and report it, leaving the file untouched.
    let config = null;
    try {
      config = await readJsonObject(spec.hooksConfig);
    } catch {
      config = null;
    }
    if (config === null) {
      skipped.push(spec.hooksConfig);
    } else {
      removeManagedHookCommands(config);
      if (componentSelected(selected, "hook:session-env")) {
        addHookCommand(config, "SessionStart", null, hookCommand(envPath, spec), "Setting IPA search logging environment...", 5);
      }
      if (componentSelected(selected, "hook:guard")) {
        addHookCommand(config, "PreToolUse", "Write|Edit|MultiEdit", hookCommand(guardPath, spec), "Checking IPA inbox write policy...", 5);
      }
      if (componentSelected(selected, "hook:markdown-nudge")) {
        addHookCommand(config, "PostToolUse", "Write|Edit|MultiEdit", hookCommand(writeNudgePath, spec), "Reminding IPA lint/format checks...", 5);
      }
      if (componentSelected(selected, "hook:call-counter")) {
        addHookCommand(config, "PostToolUse", "Bash", hookCommand(callCounterPath, spec), null, 5);
      }
      if (componentSelected(selected, "hook:mutation-ledger")) {
        addHookCommand(config, "PostToolUse", "Bash", hookCommand(mutationLedgerPath, spec), null, 5);
      }
      if (componentSelected(selected, "hook:vault-ref")) {
        addHookCommand(config, "UserPromptSubmit", null, hookCommand(vaultRefPath, spec), null, 5);
      }
      if (componentSelected(selected, "hook:evidence")) {
        addHookCommand(config, "UserPromptSubmit", null, hookCommand(promptPath, spec), null, 5);
      }
      if (componentSelected(selected, "hook:formatter-gate")) {
        addHookCommand(config, "Stop", null, hookCommand(formatterGatePath, spec), "Checking IPA formatter apply gate...", 20);
      }
      if (componentSelected(selected, "permissions")) {
        mergeClaudePermissionRule(config);
      }
      await writeJsonObject(spec.hooksConfig, config);
      files.push(spec.hooksConfig);
    }
  }
  return { files, skipped };
}

async function uninstallGlobalHarness(spec) {
  const removed = [];
  const scripts = [
    join(spec.hooksDir, "ipa-session-env.mjs"),
    join(spec.hooksDir, "ipa-inbox-guard.mjs"),
    join(spec.hooksDir, "ipa-user-prompt-nudge.mjs"),
    join(spec.hooksDir, "ipa-prompt-evidence.mjs"),
    join(spec.hooksDir, "ipa-md-write-nudge.mjs"),
    join(spec.hooksDir, "ipa-call-counter.mjs"),
    join(spec.hooksDir, "ipa-mutation-ledger.mjs"),
    join(spec.hooksDir, "ipa-formatter-gate.mjs"),
    join(spec.hooksDir, "ipa-vault-ref-nudge.mjs")
  ];
  for (const path of [spec.skillFile, ...scripts]) await removeManagedFile(path, removed);
  if (spec.pluginFile) await removeManagedFile(spec.pluginFile, removed);
  if (existsSync(spec.hooksConfig)) {
    // Fail safe on an unparseable user-owned settings file: leave it untouched.
    try {
      const config = await readJsonObject(spec.hooksConfig);
      removeManagedHookCommands(config);
      removeClaudePermissionRule(config);
      await writeJsonObject(spec.hooksConfig, config);
      removed.push(spec.hooksConfig);
    } catch {
      // keep the file as-is rather than clobber content we cannot parse
    }
  }
  if (await removeManagedBlock(spec.globalPromptFile)) {
    removed.push(spec.globalPromptFile);
  }
  return removed;
}

function hasManagedFile(path) {
  return managedFileState(path) === "managed";
}

// "managed" = exists with the HARNESS_MARKER, "user" = exists without the
// marker (a pre-existing or deliberately forked user-owned file), "missing" =
// absent or unreadable. install/update never overwrite "user" files and
// doctor does not flag them as missing.
function managedFileState(path) {
  if (!existsSync(path)) return "missing";
  try {
    return readFileSyncText(path).includes(HARNESS_MARKER) ? "managed" : "user";
  } catch {
    return "missing";
  }
}

function opencodeHookComponentPresent(pluginFile, component) {
  if (!hasManagedFile(pluginFile)) return false;
  const marker = HARNESS_HOOK_COMPONENT_TO_PLUGIN_MARKER[component];
  if (!marker) return false;
  try {
    return readFileSyncText(pluginFile).includes(marker);
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

async function readTargetManifest(vaultPath, target) {
  const path = join(harnessRoot(vaultPath), target, "manifest.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function componentPresence(spec, vaultPath, selected) {
  const presence = {};
  for (const component of HARNESS_COMPONENTS) {
    presence[component] = false;
  }
  if (componentSelected(selected, "skill")) presence.skill = hasManagedFile(spec.skillFile);
  if (componentSelected(selected, "prompt")) presence.prompt = hasManagedFile(spec.globalPromptFile);
  if (componentSelected(selected, "local-prompt")) presence["local-prompt"] = existsSync(join(vaultPath, spec.localPrompt));
  if (componentSelected(selected, "local-skills")) {
    const skills = vaultLocalSkillStatus(vaultPath, spec);
    presence["local-skills"] = Object.values(skills).every((value) => value === true);
  }
  if (componentSelected(selected, "plugin-scaffold")) {
    const scaffold = pluginScaffoldStatus(vaultPath);
    presence["plugin-scaffold"] = Boolean(scaffold.jsconfig && scaffold.types && scaffold.rules_dir && scaffold.search_dir);
  }
  if (spec.name === "opencode") {
    if (componentSelected(selected, "opencode-plugin") && spec.pluginFile) {
      presence["opencode-plugin"] = hasManagedFile(spec.pluginFile);
    }
  }
  if (componentSelected(selected, "permissions")) {
    presence.permissions = claudePermissionRulePresent(spec);
  }
  for (const component of Object.keys(HARNESS_HOOK_COMPONENT_TO_SCRIPT)) {
    if (componentSelected(selected, component)) {
      if (spec.name === "opencode" && spec.pluginFile) {
        presence[component] = opencodeHookComponentPresent(spec.pluginFile, component);
      } else {
        const script = HARNESS_HOOK_COMPONENT_TO_SCRIPT[component];
        presence[component] = hasManagedFile(join(spec.hooksDir, script));
      }
    }
  }
  return presence;
}

export async function harnessStatus(vaultPath, options = {}) {
  const index = await readHarnessIndex(vaultPath);
  const { config, mapping } = await readVaultConfig(vaultPath);
  options = { ...options, callCounter: callCounterOptions(config) };
  const global = {};
  const outdatedByTarget = {};
  let aggregateSelected = [];
  let aggregateOmitted = [];
  for (const target of Object.keys(index.targets ?? {})) {
    const spec = harnessTargetSpec(target, options);
    const targetManifest = await readTargetManifest(vaultPath, target);
    const selected = targetManifest?.components ?? defaultComponentsForTarget(target);
    const omitted = targetManifest?.omitted_components ?? [];
    if (targetManifest) {
      aggregateSelected = [...new Set([...aggregateSelected, ...selected])];
      aggregateOmitted = [...new Set([...aggregateOmitted, ...omitted])];
    }
    const outdatedComponents = harnessOutdatedComponents(vaultPath, spec, mapping, selected, options);
    if (outdatedComponents.length) outdatedByTarget[target] = outdatedComponents;
    global[target] = {
      outdated_components: outdatedComponents,
      selected_components: selected,
      omitted_components: omitted,
      user_owned_components: harnessUserOwnedComponents(vaultPath, spec, mapping, selected, options),
      cli_version: targetManifest?.cli_version ?? null,
      cli_commit: targetManifest?.cli_commit ?? null,
      skill: hasManagedFile(spec.skillFile),
      session_env_hook: hasManagedFile(join(spec.hooksDir, "ipa-session-env.mjs")),
      guard_hook: hasManagedFile(join(spec.hooksDir, "ipa-inbox-guard.mjs")),
      prompt_hook: hasManagedFile(join(spec.hooksDir, "ipa-user-prompt-nudge.mjs")),
      markdown_nudge_hook: hasManagedFile(join(spec.hooksDir, "ipa-md-write-nudge.mjs")),
      formatter_gate_hook: hasManagedFile(join(spec.hooksDir, "ipa-formatter-gate.mjs")),
      hooks_config: existsSync(spec.hooksConfig),
      permission_rule: claudePermissionRulePresent(spec),
      prompt: hasManagedFile(spec.globalPromptFile),
      local_skills: vaultLocalSkillStatus(vaultPath, spec),
      opencode_plugin: spec.pluginFile ? hasManagedFile(spec.pluginFile) : false,
      components: componentPresence(spec, vaultPath, selected)
    };
  }
  const outdatedTargets = Object.keys(outdatedByTarget);
  return {
    status: "ok",
    installed: Object.keys(index.targets ?? {}),
    manifest: existsSync(join(harnessRoot(vaultPath), "manifest.json")) ? ".ipa/harness/manifest.json" : null,
    global,
    components: {
      selected: aggregateSelected,
      omitted: aggregateOmitted
    },
    outdated: outdatedByTarget,
    update_hint: outdatedTargets.length
      ? `harness components are older than the installed CLI templates; run: ${outdatedTargets.map((target) => `ipa harness update ${target}`).join(", ")}`
      : null,
    fragments: await listHarnessFragments(vaultPath),
    plugin_scaffold: pluginScaffoldStatus(vaultPath),
    guard: await harnessGuardStatus(vaultPath)
  };
}

export async function harnessInstall(vaultPath, target = "codex", options = {}) {
  const spec = harnessTargetSpec(target, options);
  const name = spec.name;
  const { selected, omitted } = resolveHarnessComponents(name, options);
  const { config, mapping } = await readVaultConfig(vaultPath);
  options = { ...options, callCounter: callCounterOptions(config) };
  const pluginInitResult = componentSelected(selected, "plugin-scaffold")
    ? await pluginInit(vaultPath, { examples: true })
    : { created: [], skipped: [] };
  const root = harnessRoot(vaultPath);
  const dir = join(root, name);
  const globalHome = name === "opencode" ? "~/.config/opencode" : `~/.${name}`;
  const globalSkill = name === "opencode" ? "~/.config/opencode/skills/ipa/SKILL.md" : `~/.${name}/skills/ipa/SKILL.md`;
  const globalPrompt = name === "opencode" ? "~/.config/opencode/AGENTS.md" : `~/.${name}/${spec.localPrompt}`;
  const globalHooksConfig = name === "claude" ? "~/.claude/settings.json" : name === "opencode" ? "~/.config/opencode/settings.json" : "~/.codex/hooks.json";
  const cliInfo = cliVersionInfo();
  const manifest = {
    version: 1,
    target: name,
    installed_at: nowIso(),
    cli_version: cliInfo.version,
    cli_commit: cliInfo.commit,
    scope: ["global", "vault-local"],
    local_prompt: spec.localPrompt,
    components: selected,
    omitted_components: omitted,
    global: {
      home: globalHome,
      skill: globalSkill,
      hooks_config: globalHooksConfig,
      prompt: globalPrompt,
      opencode_plugin: name === "opencode" ? "~/.config/opencode/plugins/ipa-harness.js" : null,
      environment: {
        IPA_SEARCH_LOG: "1"
      }
    },
    local_skills: {
      root: vaultLocalSkillRootRel(spec),
      skills: VAULT_LOCAL_SKILLS.map((skill) => skill.name)
    },
    plugin_scaffold: {
      root: ".ipa/plugins",
      types: ".ipa/plugins/types/ipa-plugin.d.ts",
      rules: ".ipa/plugins/rules/*.js",
      search: ".ipa/plugins/search/*.js"
    },
    hooks: {
      session_start_env: {
        environment: {
          IPA_SEARCH_LOG: "1"
        },
        policy: "enable search-event logging for plain ipa search commands in agent sessions"
      },
      guard: {
        command: "ipa harness guard check <vault-relative-path>",
        policy: "new markdown files must be created under the configured inbox folder"
      },
      prompt_submit: {
        policy: "nudge the agent to search/view IPA notes before answering vault questions"
      },
      markdown_write_nudge: {
        policy: "nudge the agent to run validator, note-scoped formatter plan, and matching formatter apply after vault Markdown edits"
      },
      formatter_gate: {
        policy: "block final response while edited vault notes still have formatter patches"
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
  const files = [`.ipa/harness/${name}/manifest.json`, `.ipa/harness/${name}/guard.mjs`, ".ipa/harness/manifest.json"];
  const skippedUserOwned = [];
  // Vault-scope artifacts come from the same harnessExpectedArtifacts renderer
  // as the global ones, so vault fragments and outdated comparisons always see
  // identical content.
  for (const artifact of harnessExpectedArtifacts(vaultPath, spec, mapping, selected, options)) {
    if (artifact.scope !== "vault") continue;
    const relPath = toPosix(relative(vaultPath, artifact.path));
    if (artifact.kind === "block") {
      await upsertManagedBlock(artifact.path, artifact.content);
      files.push(relPath);
    } else {
      await writeManagedVaultFile(vaultPath, relPath, artifact.content, files, skippedUserOwned);
    }
  }
  const installOptions = { ...options, components: { ...options.components, selected } };
  const { files: globalFiles, skipped: globalSkipped } = await installGlobalHarness(vaultPath, spec, mapping, installOptions);
  skippedUserOwned.push(...globalSkipped);
  const index = await readHarnessIndex(vaultPath);
  index.targets = index.targets || {};
  index.targets[name] = {
    path: `.ipa/harness/${name}/manifest.json`,
    installed_at: manifest.installed_at,
    local_prompt: spec.localPrompt,
    components: selected,
    omitted_components: omitted
  };
  await writeHarnessIndex(vaultPath, index);
  return {
    status: "ok",
    target: name,
    installed: true,
    plugin_init: pluginInitResult,
    files,
    global_files: globalFiles,
    skipped_user_owned: skippedUserOwned
  };
}

export async function harnessUninstall(vaultPath, target = "codex", options = {}) {
  const spec = harnessTargetSpec(target, options);
  const name = spec.name;
  await rm(join(harnessRoot(vaultPath), name), { recursive: true, force: true });
  await removeManagedBlock(join(vaultPath, spec.localPrompt));
  const localSkillRemoved = await uninstallVaultLocalSkills(vaultPath, spec);
  const globalRemoved = await uninstallGlobalHarness(spec);
  const index = await readHarnessIndex(vaultPath);
  if (index.targets) delete index.targets[name];
  await writeHarnessIndex(vaultPath, index);
  return { status: "ok", target: name, installed: false, removed: [`.ipa/harness/${name}`, spec.localPrompt, ...localSkillRemoved], global_removed: globalRemoved };
}

// Session gate: the single check the Stop hook consults before a session may
// end. Combines the builtin formatter check over this session's pending edits
// with vault-owned gate plugins (.ipa/plugins/gates/*.js). On pass, the
// session's ledger entries are cleared. Gate plugin errors are reported but
// never block — a broken plugin must not lock the session shut.
export async function harnessSessionGate(vaultPath, options = {}) {
  const sessionId = options.session ?? null;
  const pendingPath = join(vaultPath, ".ipa", "harness", "formatter-pending.json");
  const ttlMs = 48 * 60 * 60 * 1000;
  let entries = [];
  if (existsSync(pendingPath)) {
    try {
      const parsed = JSON.parse(await readFile(pendingPath, "utf8"));
      entries = Array.isArray(parsed.notes) ? parsed.notes : [];
    } catch {
      entries = [];
    }
  }
  const cutoff = Date.now() - ttlMs;
  entries = entries.filter((item) => {
    const ts = Date.parse(item?.updated_at ?? "");
    return Number.isNaN(ts) || ts >= cutoff;
  });
  const owned = sessionId
    ? entries.filter((item) => !item.session_id || item.session_id === sessionId)
    : entries;
  const ownedTitles = [...new Set(owned
    .map((item) => typeof item.title === "string" ? item.title.trim() : "")
    .filter(Boolean))];
  const blocks = [];
  const errors = [];
  const warnings = [];
  if (ownedTitles.length) {
    const plan = await formatVault(vaultPath, false, { notes: ownedTitles, ruleApply: true });
    if (plan.summary.patches > 0) {
      const noteArgs = ownedTitles.map((title) => JSON.stringify(title)).join(" ");
      blocks.push({
        source: "formatter",
        message: [
          `Formatter gate blocked final response. ${plan.summary.patches} pending formatter patch(es) for: ${ownedTitles.join(", ")}`,
          "Run:",
          `ipa validator --note ${noteArgs}`,
          `ipa formatter plan --note ${noteArgs}`,
          `ipa formatter apply --note ${noteArgs}`,
          "Do not stop at formatter plan; run formatter apply after reviewing the plan."
        ].join("\n")
      });
    }
  }
  const gatePlugins = (await loadPluginModules(vaultPath, "gates"))
    .map((plugin) => normalizeGatePlugin(plugin))
    .filter(Boolean);
  if (gatePlugins.length) {
    const { config, mapping } = await readVaultConfig(vaultPath);
    const notes = await loadNotes(vaultPath, mapping);
    // Mutation ledger: ipa dry-run mutations recorded by the mutation-ledger hook
    // that were never followed by an --apply/apply sighting. Unlike formatter
    // pending, the gate never clears these — only an --apply sighting or the 48h
    // TTL does, so a warning survives across gate runs until the plan is applied.
    const mutationPath = join(vaultPath, ".ipa", "harness", "mutation-pending.json");
    let mutationEntries = [];
    if (existsSync(mutationPath)) {
      try {
        const parsed = JSON.parse(await readFile(mutationPath, "utf8"));
        mutationEntries = Array.isArray(parsed.mutations) ? parsed.mutations : [];
      } catch {
        mutationEntries = [];
      }
    }
    const ownedMutations = (sessionId
      ? mutationEntries.filter((item) => !item.session_id || item.session_id === sessionId)
      : mutationEntries)
      .filter((item) => {
        const ts = Date.parse(item?.ts ?? "");
        return Number.isNaN(ts) || ts >= cutoff;
      });
    const ctx = {
      vaultPath,
      config,
      mapping,
      notes,
      lookup: (ref) => findNote(notes, ref) ?? null,
      session: {
        id: sessionId,
        edits: owned.map((item) => ({ title: item.title, path: item.path ?? null, updated_at: item.updated_at ?? null })),
        pending_mutations: ownedMutations.map((item) => ({ command: item.command, ts: item.ts ?? null }))
      }
    };
    for (const gate of gatePlugins) {
      try {
        const result = await gate.check(ctx);
        if (result && result.block) {
          blocks.push({ source: gate.name, message: String(result.message ?? `gate ${gate.name} blocked the session`) });
        } else if (result) {
          // A non-blocking gate result (block falsy) carrying a message/warn is
          // an advisory warning: surface it to the agent without holding the
          // response, so a block:false gate is not silently dropped.
          const warn = [result.message, result.warn].find((value) => typeof value === "string" && value.trim());
          if (warn) warnings.push({ source: gate.name, message: warn });
        }
      } catch (error) {
        errors.push({ source: gate.name, message: error.message });
      }
    }
  }
  if (!blocks.length) {
    // Owned entries are formatter-clean here (a dirty owned note blocks above), so
    // they leave the ledger. Foreign entries (a different non-null session_id) are
    // re-checked against the formatter and dropped when clean too — ownership must
    // not strand a clean note until the 48h TTL, or a multi-turn --resume that
    // rotates the session id would let it resurface and wrongly gate a later turn.
    // Only genuinely pending foreign work is kept.
    const ownedSet = new Set(owned);
    const foreign = entries.filter((item) => !ownedSet.has(item));
    const foreignTitles = [...new Set(foreign
      .map((item) => typeof item.title === "string" ? item.title.trim() : "")
      .filter(Boolean))];
    let foreignDirty = new Set(foreignTitles);
    if (foreignTitles.length) {
      try {
        const plan = await formatVault(vaultPath, false, { notes: foreignTitles, ruleApply: true });
        foreignDirty = new Set(plan.patches.map((patch) => patch.note));
      } catch {
        // Fail-safe: if the foreign notes can't be verified, keep them rather than
        // risk dropping real pending work.
      }
    }
    const remaining = foreign.filter((item) =>
      foreignDirty.has(typeof item.title === "string" ? item.title.trim() : ""));
    if (remaining.length) {
      await writeFile(pendingPath, JSON.stringify({ version: 1, notes: remaining }, null, 2) + "\n", "utf8");
    } else if (existsSync(pendingPath)) {
      await rm(pendingPath, { force: true });
    }
  }
  return {
    status: "ok",
    block: blocks.length > 0,
    session_id: sessionId,
    notes: ownedTitles,
    gates: gatePlugins.map((gate) => gate.name),
    blocks,
    warnings,
    errors
  };
}

export async function harnessUpdate(vaultPath, target = "codex", options = {}) {
  const spec = harnessTargetSpec(target, options);
  const name = spec.name;
  const index = await readHarnessIndex(vaultPath);
  if (!index.targets?.[name]) {
    return { status: "error", target: name, reason: "not_installed", message: `harness target ${name} is not installed; run ipa harness install ${name}` };
  }
  const targetManifest = await readTargetManifest(vaultPath, name);
  const storedSelected = targetManifest?.components ?? index.targets[name].components ?? defaultComponentsForTarget(name);
  const storedOmitted = targetManifest?.omitted_components ?? index.targets[name].omitted_components ?? [];
  const valid = new Set(componentsValidForTarget(name));
  const normalizeList = (input) => !input ? [] : input
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const only = normalizeList(options.components?.only);
  const withList = normalizeList(options.components?.with);
  const without = normalizeList(options.components?.without);
  for (const component of [...only, ...withList, ...without]) {
    if (!valid.has(component)) throw new Error(`unknown harness component: ${component}`);
  }
  // Default components introduced by newer CLI versions join automatically on
  // update; components the user explicitly removed (recorded in
  // omitted_components) stay out. --only/--with/--without refine the result.
  const autoAdded = only.length ? [] : defaultComponentsForTarget(name)
    .filter((component) => !storedSelected.includes(component) && !storedOmitted.includes(component));
  let selected = only.length
    ? [...new Set(only)]
    : [...storedSelected.filter((component) => valid.has(component)), ...autoAdded];
  for (const component of withList) {
    if (!selected.includes(component)) selected.push(component);
  }
  selected = selected.filter((component) => !without.includes(component));
  // Uninstall first so hook scripts renamed or dropped by newer CLI versions do
  // not survive as orphans, then reinstall with the resolved selection.
  const uninstall = await harnessUninstall(vaultPath, name, options);
  const install = await harnessInstall(vaultPath, name, { ...options, components: { only: selected } });
  return {
    status: "ok",
    target: name,
    updated: true,
    components: selected,
    components_added: autoAdded,
    omitted_components: componentsValidForTarget(name).filter((component) => !selected.includes(component)),
    removed: uninstall.removed,
    global_removed: uninstall.global_removed,
    files: install.files,
    global_files: install.global_files,
    skipped_user_owned: install.skipped_user_owned,
    plugin_init: install.plugin_init
  };
}

async function listHarnessFragments(vaultPath) {
  const root = harnessFragmentsRoot(vaultPath);
  if (!existsSync(root)) return [];
  const entries = await readdir(root);
  return entries.filter((entry) => entry.endsWith(".md")).map((entry) => entry.slice(0, -3)).sort();
}

export async function harnessDoctor(vaultPath, options = {}) {
  const index = await readHarnessIndex(vaultPath);
  const { config, mapping } = await readVaultConfig(vaultPath);
  options = { ...options, callCounter: callCounterOptions(config) };
  const issues = [];
  const knownFragments = new Set(harnessFragmentNames());
  for (const fragment of await listHarnessFragments(vaultPath)) {
    if (!knownFragments.has(fragment)) {
      issues.push({ severity: "warn", code: "harness.fragment_unknown", message: `fragment .ipa/harness/fragments/${fragment}.md matches no harness artifact; expected one of: ${[...knownFragments].join(", ")}` });
    }
  }
  // Plugin validity is vault-scoped (not per-target): a syntactically broken
  // rule/search/gate plugin feeds the same hooks harness doctor certifies, so
  // fold plugin doctor's findings in here. Fail-safe: a crashing plugin doctor
  // must never crash harness doctor.
  try {
    const pluginReport = await pluginDoctor(vaultPath);
    for (const issue of pluginReport.issues ?? []) {
      issues.push({
        severity: issue.severity ?? "error",
        code: "harness.plugin_invalid",
        message: `${issue.path ? `${issue.path}: ` : ""}${issue.message ?? "plugin is invalid"}`
      });
    }
  } catch {
    // swallow — doctor must not crash on a broken plugin loader
  }
  for (const [target, entry] of Object.entries(index.targets ?? {})) {
    const spec = harnessTargetSpec(target, options);
    const targetManifest = await readTargetManifest(vaultPath, target);
    const selected = targetManifest?.components ?? entry.components ?? defaultComponentsForTarget(target);
    const omitted = targetManifest?.omitted_components ?? entry.omitted_components ?? [];
    const pendingDefaults = defaultComponentsForTarget(target)
      .filter((component) => !selected.includes(component) && !omitted.includes(component));
    if (pendingDefaults.length) {
      issues.push({ severity: "warn", code: "harness.component_new_default", target, message: `new default components available: ${pendingDefaults.join(", ")}; run ipa harness update ${target}` });
    }
    for (const component of harnessOutdatedComponents(vaultPath, spec, mapping, selected, options)) {
      issues.push({ severity: "warn", code: "harness.component_outdated", target, message: `component ${component} differs from the current CLI template; run ipa harness update ${target}` });
    }
    if (!existsSync(resolve(vaultPath, entry.path))) {
      issues.push({ severity: "error", code: "harness.manifest_missing", target, message: `missing ${entry.path}` });
    }
    if (!existsSync(join(harnessRoot(vaultPath), target, "guard.mjs"))) {
      issues.push({ severity: "warn", code: "harness.guard_missing", target, message: "guard script is missing" });
    }
    // Files in "user" state (marker stripped or pre-existing) are user-owned
    // forks by contract: install/update leave them alone and doctor must not
    // flag them as missing. status lists them under user_owned_components.
    if (componentSelected(selected, "skill") && managedFileState(spec.skillFile) === "missing") {
      const skillPath = target === "opencode" ? "~/.config/opencode/skills/ipa/SKILL.md" : `~/.${target}/skills/ipa/SKILL.md`;
      issues.push({ severity: "warn", code: "harness.global_skill_missing", target, message: `missing managed IPA skill at ${skillPath}` });
    }
    for (const [component, script] of Object.entries(HARNESS_HOOK_COMPONENT_TO_SCRIPT)) {
      if (!componentSelected(selected, component)) continue;
      if (spec.name === "opencode" && spec.pluginFile) {
        if (managedFileState(spec.pluginFile) !== "user" && !opencodeHookComponentPresent(spec.pluginFile, component)) {
          issues.push({ severity: "warn", code: `harness.global_${component.replace("hook:", "")}_hook_missing`, target, message: `missing managed OpenCode plugin behavior for ${component}` });
        }
      } else {
        const file = join(spec.hooksDir, script);
        if (managedFileState(file) === "missing") {
          issues.push({ severity: "warn", code: `harness.global_${component.replace("hook:", "")}_hook_missing`, target, message: `missing managed hook ${script}` });
        }
      }
    }
    if (spec.name !== "opencode") {
      const hooksConfigDisplay = target === "claude" ? "~/.claude/settings.json" : "~/.codex/hooks.json";
      const hookComponents = Object.keys(HARNESS_HOOK_COMPONENT_TO_SCRIPT).filter((component) => componentSelected(selected, component));
      let hooksConfig = null;
      if (hookComponents.length) {
        try {
          hooksConfig = JSON.parse(readFileSyncText(spec.hooksConfig) || "{}");
        } catch (error) {
          issues.push({ severity: "error", code: "harness.hooks_config_invalid", target, message: `cannot parse ${hooksConfigDisplay}: ${error.message}` });
        }
      }
      if (hooksConfig) {
        for (const component of hookComponents) {
          const script = HARNESS_HOOK_COMPONENT_TO_SCRIPT[component];
          // A missing script is already reported above; only flag scripts that
          // exist (managed or user-forked) but lost their hooks-config entry
          // (e.g. settings.json was replaced by a sync tool), because those
          // silently never run.
          if (managedFileState(join(spec.hooksDir, script)) === "missing") continue;
          const event = HARNESS_HOOK_COMPONENT_TO_EVENT[component];
          const registered = (hooksConfig.hooks?.[event] ?? []).some((group) =>
            (group.hooks ?? []).some((hook) => typeof hook.command === "string" && hook.command.includes(script))
          );
          if (!registered) {
            issues.push({ severity: "warn", code: `harness.global_${component.replace("hook:", "")}_hook_unregistered`, target, message: `hook ${script} is installed but not registered under ${event} in ${hooksConfigDisplay}; run ipa harness update ${target}` });
          }
        }
      }
    }
    if (spec.name === "opencode" && spec.pluginFile && componentSelected(selected, "opencode-plugin") && managedFileState(spec.pluginFile) === "missing") {
      issues.push({ severity: "warn", code: "harness.global_opencode_plugin_missing", target, message: "missing managed OpenCode plugin at ~/.config/opencode/plugins/ipa-harness.js" });
    }
    if (componentSelected(selected, "permissions") && !claudePermissionRulePresent(spec)) {
      issues.push({ severity: "warn", code: "harness.permission_rule_missing", target, message: `missing Claude Code permission rule ${CLAUDE_PERMISSION_RULE} in ~/.claude/settings.json; run ipa harness update ${target}` });
    }
    if (componentSelected(selected, "prompt") && !hasManagedFile(spec.globalPromptFile)) {
      const promptPath = target === "opencode" ? "~/.config/opencode/AGENTS.md" : `~/.${target}/${spec.localPrompt}`;
      issues.push({ severity: "warn", code: "harness.global_prompt_missing", target, message: `missing IPA harness block in ${promptPath}` });
    }
    if (componentSelected(selected, "local-prompt") && !hasManagedFile(join(vaultPath, entry.local_prompt ?? spec.localPrompt))) {
      issues.push({ severity: "warn", code: "harness.local_prompt_missing", target, message: `missing IPA harness block in ${entry.local_prompt ?? spec.localPrompt}; run ipa harness update ${target}` });
    }
    if (componentSelected(selected, "local-skills")) {
      for (const skill of VAULT_LOCAL_SKILLS) {
        const relPath = vaultLocalSkillRelPath(spec, skill.name);
        if (managedFileState(join(vaultPath, relPath)) === "missing") {
          issues.push({ severity: "warn", code: "harness.local_skill_missing", target, message: `missing managed vault-local skill ${relPath}` });
        }
      }
    }
    if (componentSelected(selected, "plugin-scaffold")) {
      const scaffold = pluginScaffoldStatus(vaultPath);
      if (!scaffold.jsconfig || !scaffold.types || !scaffold.rules_dir || !scaffold.search_dir) {
        issues.push({ severity: "warn", code: "harness.plugin_scaffold_missing", target, message: "missing .ipa/plugins authoring scaffold; run ipa harness init or ipa plugin init" });
      }
    }
  }
  return {
    status: issues.some((item) => item.severity === "error") ? "error" : "ok",
    installed: Object.keys(index.targets ?? {}),
    issues
  };
}

// Vault-declared guard allowances (.ipa/config.yaml `harness.guard.allow`):
// path patterns where new markdown may be created outside the inbox, e.g. an
// approved-workflow folder that writes directly into the archive.
function guardAllowPatterns(config) {
  return asList(config?.harness?.guard?.allow);
}

export async function harnessGuardStatus(vaultPath) {
  const { config, mapping } = await readVaultConfig(vaultPath);
  return {
    policy: "new_markdown_requires_inbox",
    inbox_dir: mapping.inbox_dir,
    project_dir: mapping.project_dir,
    archive_dir: mapping.archive_dir,
    allow: guardAllowPatterns(config)
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
  const { config, mapping } = await readVaultConfig(vaultPath);
  const normalized = toPosix(relPath).replace(/^\/+/, "");
  const absolute = resolve(vaultPath, normalized);
  if (!isInsideVault(vaultPath, absolute)) {
    return { allowed: false, reason: "path escapes vault", path: normalized };
  }
  const action = options.action ?? (existsSync(absolute) ? "edit" : "create");
  if (extname(normalized).toLowerCase() !== ".md") {
    return { allowed: true, reason: "non-markdown file", path: normalized, action };
  }
  // Paths the note walker never indexes are not vault notes, so the inbox
  // lifecycle policy does not apply to them (.ipa, config files.exclude, etc.).
  const walkerSkipped = normalized === ".ipa" || normalized.startsWith(".ipa/")
    || normalized.split("/").some((segment) => segment === ".git" || segment === ".cache" || segment === "node_modules");
  if (walkerSkipped || isExcludedPath(normalized, asList(mapping.exclude))) {
    return { allowed: true, reason: "path is excluded from note indexing", path: normalized, action };
  }
  if (action !== "create") {
    return { allowed: true, reason: "existing markdown edit", path: normalized, action };
  }
  if (pathInFolder(normalized, mapping.inbox_dir)) {
    return { allowed: true, reason: "new markdown is under inbox", path: normalized, action, inbox_dir: mapping.inbox_dir };
  }
  const allowPatterns = guardAllowPatterns(config);
  if (isExcludedPath(normalized, allowPatterns)) {
    return { allowed: true, reason: "path matches a guard allow pattern from .ipa/config.yaml", path: normalized, action, inbox_dir: mapping.inbox_dir };
  }
  return {
    allowed: false,
    reason: "new markdown files must be created under the configured inbox folder",
    path: normalized,
    action,
    inbox_dir: mapping.inbox_dir
  };
}

// `ipa convention show`: the built-in IPA concepts rendered through the active
// config (real field/folder names) plus the vault's own operating rules from
// .ipa/harness/fragments/ — the same source the harness inlines into prompts.
export async function conventionShow(vaultPath) {
  const { config, mapping } = await readVaultConfig(vaultPath);
  const guardAllow = guardAllowPatterns(config);
  const sections = [
    {
      title: "Concepts",
      body: [
        "IPA organizes knowledge as small atomic notes connected upward: each note",
        `points at its parent index/root notes through the \`${mapping.refs}\` frontmatter`,
        "field (wikilinks). Index notes aggregate children through those backlinks;",
        "they do not maintain child lists by hand. New material enters through the",
        "inbox, gains refs/tags during triage, and then moves to the archive."
      ].join("\n")
    },
    {
      title: "Design Intent",
      body: [
        "IPA (Inbox-Project-Archive) exists to solve one recurring failure of note",
        'systems: "where did I put that? I know I filed it." Folder-based',
        "classification (PARA) hits a fundamental limit — one note can live in only",
        "one folder — so classification itself becomes the time sink and retrieval",
        "degenerates into search anyway. IPA's answer:",
        "",
        `- Folders express only lifecycle state — \`${mapping.inbox_dir}\` (capturing), \`${mapping.project_dir}\` (working), \`${mapping.archive_dir}\` (done). They never classify.`,
        `- Classification lives in links: \`${mapping.refs}\` answers "where does this belong" (vertical, one or many parents), \`${mapping.tags}\` answers "what perspective cuts across it" (horizontal). A note can belong to several contexts at once, so "which folder?" stops being a question.`,
        "- Only the project folder is actively managed; it holds index/root notes only. The archive expands freely without subfolders — thousands of notes are fine because indexes and tags retrieve them.",
        `- Notes flow one way: inbox → (triage) → archive. Reactivating a dormant topic means moving just its root/index back to the project folder (\`ipa move\`); the archived notes follow through their existing links.`,
        "- An index is a conceptual folder: curated links plus automatic backlinks, no content of its own. Indexes may reference other indexes as context, tiny one-note indexes are fine (unused ones simply retire to the archive), and link order is deliberate curation.",
        "",
        'IPA deliberately covers only "record and retrieve". It does not prescribe',
        "how to think (Zettelkasten) or how to execute (PARA): defining content",
        "style reintroduces classification ambiguity, and staying unopinionated is",
        "what keeps the method universal. Requests beyond that scope are outside",
        "IPA's domain, and saying so is a valid answer."
      ].join("\n")
    },
    {
      title: "Note Types",
      body: [
        `\`${mapping.note_type}: note\` — an atomic content note.`,
        `\`${mapping.note_type}: index\` — a hub note; children point at it via \`${mapping.refs}\`.`,
        `\`${mapping.note_type}: root\` — a top-level index that anchors a whole area.`
      ].join("\n")
    },
    {
      title: "Frontmatter Fields",
      body: [
        `\`${mapping.note_type}\` — note | index | root.`,
        `\`${mapping.refs}\` — wikilinks to parent index/root notes, e.g. "[[Index Note]]". Edit with \`ipa note set "Note" --field ${mapping.refs} --add "Index Note" --apply\`.`,
        `\`${mapping.tags}\` — flat keyword list for retrieval. Tags are cross-cutting perspectives that span more than one index: reuse the existing vocabulary first, and never mint a tag so narrow it maps to a single note or single index (that meaning belongs in \`${mapping.refs}\`).`,
        `\`${mapping.aliases}\` — alternative titles used by search.`,
        `\`${mapping.created_at}\` / \`${mapping.updated_at}\` — timestamps in \`${mapping.date_format}\`; maintained automatically by CLI writes and \`ipa formatter apply\`. Never edit them by hand.`
      ].join("\n")
    },
    {
      title: "Folders And Lifecycle",
      body: [
        `\`${mapping.inbox_dir}\` — every new note is created here (\`ipa inbox add\`); the harness guard blocks new markdown elsewhere.`,
        `\`${mapping.project_dir}\` — active project material.`,
        `\`${mapping.archive_dir}\` — triaged notes that carry \`${mapping.refs}\`.`,
        guardAllow.length
          ? `Guard allow patterns from .ipa/config.yaml permit new markdown outside the inbox: ${guardAllow.map((pattern) => `\`${pattern}\``).join(", ")}.`
          : null
      ].filter(Boolean).join("\n")
    },
    {
      title: "Editing Workflow",
      body: [
        "Read with `ipa view`/`ipa digest`, discover with `ipa search`/`ipa context`.",
        "Edit note bodies with `ipa note replace`, frontmatter with `ipa note set`.",
        "After editing, run `ipa validator --note \"Note\"` and finish with",
        "`ipa formatter plan --note ...` + `ipa formatter apply --note ...`.",
        "Vault-specific rule enforcement lives in `.ipa/plugins/rules/*.js`."
      ].join("\n")
    }
  ];
  const fragments = [];
  for (const name of await listHarnessFragments(vaultPath)) {
    const content = readHarnessFragment(vaultPath, name);
    if (content) fragments.push({ name, content });
  }
  if (fragments.length) {
    sections.push({
      title: "Vault Operating Rules",
      body: fragments.map((fragment) => `### ${fragment.name}\n\n${fragment.content}`).join("\n\n")
    });
  }
  return {
    status: "ok",
    convention: true,
    mapping,
    fragments: fragments.map((fragment) => fragment.name),
    sections,
    markdown: sections.map((section) => `## ${section.title}\n\n${section.body}`).join("\n\n") + "\n"
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

function normalizeProfileName(name) {
  const text = String(name ?? "").trim();
  if (!text) throw new Error("profile name is required");
  if (!/^[A-Za-z0-9_.-]+$/.test(text)) {
    throw new Error(`invalid profile name: ${name}. Use letters, numbers, dots, dashes, or underscores`);
  }
  return text;
}

function normalizeProfileVaultPath(vaultPath) {
  const text = String(vaultPath ?? "").trim();
  if (!text) throw new Error("vault path is required");
  if (text === "~" || text.startsWith("~/") || isAbsolute(text)) return text;
  return resolve(text);
}

function markDefaultProfile(registry, name) {
  for (const key of Object.keys(registry.profiles ?? {})) {
    registry.profiles[key].default = key === name;
  }
}

function profileMutationResult(registry, name, path, extra = {}) {
  const profile = registry.profiles[name] ?? {};
  return {
    profile: name,
    vault_path: profile.vault_path,
    default: profile.default === true,
    ...extra,
    path
  };
}

export async function listProfiles() {
  return readProfileRegistry();
}

export async function initProfileRegistry(options = {}) {
  const name = normalizeProfileName(options.name ?? "ipa");
  const vaultPath = normalizeProfileVaultPath(options.vault ?? "~/ipa");
  const registry = await readProfileRegistry();
  registry.profiles = registry.profiles || {};

  const names = Object.keys(registry.profiles);
  const existing = registry.profiles[name] ?? null;
  const force = Boolean(options.force);

  if (names.length && !existing && !force) {
    throw new Error("profile registry already initialized. Use `ipa profile new NAME VAULT` to add another profile");
  }

  if (existing && !force) {
    if (existing.vault_path !== vaultPath) {
      throw new Error(`profile already exists: ${name}. Use --force to update it`);
    }
    return profileMutationResult(registry, name, profileRegistryPath(), {
      created: false,
      updated: false
    });
  }

  const created = !existing;
  registry.profiles[name] = {
    ...(existing ?? {}),
    vault_path: vaultPath
  };
  markDefaultProfile(registry, name);
  const path = await writeProfileRegistry(registry);
  return profileMutationResult(registry, name, path, {
    created,
    updated: !created
  });
}

export async function createProfile(name, vaultPath, options = {}) {
  const profileName = normalizeProfileName(name);
  const normalizedVaultPath = normalizeProfileVaultPath(vaultPath);
  const registry = await readProfileRegistry();
  registry.profiles = registry.profiles || {};

  const existing = registry.profiles[profileName] ?? null;
  const force = Boolean(options.force);
  if (existing && !force) throw new Error(`profile already exists: ${profileName}. Use --force to update it`);

  const hadProfiles = Object.keys(registry.profiles).length > 0;
  const created = !existing;
  const shouldDefault = Boolean(options.default) || !hadProfiles || existing?.default === true;
  registry.profiles[profileName] = {
    ...(existing ?? {}),
    vault_path: normalizedVaultPath
  };
  if (shouldDefault) markDefaultProfile(registry, profileName);
  const path = await writeProfileRegistry(registry);
  return profileMutationResult(registry, profileName, path, {
    created,
    updated: !created
  });
}

export async function setDefaultProfile(name) {
  const registry = await readProfileRegistry();
  if (!registry.profiles?.[name]) throw new Error(`profile not found: ${name}`);
  for (const key of Object.keys(registry.profiles)) registry.profiles[key].default = key === name;
  await writeProfileRegistry(registry);
  return { current: name };
}

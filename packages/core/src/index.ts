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
import { callCounterOptions } from "./harness/shared/hookTemplates.js";
import {
  VAULT_LOCAL_SKILLS,
  vaultLocalSkillRelPath
} from "./harness/shared/templates.js";
import { createHarnessService } from "./harness/index.js";
import {
  harnessExpectedArtifacts,
  harnessFragmentNames,
  harnessFragmentsRoot,
  harnessOutdatedComponents,
  harnessUserOwnedComponents,
  listHarnessFragments,
  readHarnessFragment
} from "./harness/artifacts.js";
import {
  installGlobalHarness,
  uninstallGlobalHarness,
  uninstallVaultLocalSkills,
  vaultLocalSkillStatus
} from "./harness/lifecycle.js";
import { createHarnessSessionGate } from "./harness/gate.js";
import { createHarnessGuard, guardAllowPatterns } from "./harness/guard.js";

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
  { code: "ipa.frontmatter.missing_type", category: "frontmatter", severity: "warn", scope: "note" },
  { code: "ipa.frontmatter.date_format", category: "frontmatter", severity: "warn", scope: "note", fixable: true },
  { code: "ipa.frontmatter.invalid_type", category: "frontmatter", severity: "error", scope: "note" },
  { code: "ipa.frontmatter.missing_ref", category: "frontmatter", severity: "warn", scope: "note" },
  { code: "ipa.inbox.raw_capture", category: "inbox", severity: "warn", scope: "note" },
  { code: "ipa.location.type_mismatch", category: "location", severity: "warn", scope: "note" },
  { code: "ipa.link.ref_target_missing", category: "link", severity: "warn", scope: "vault" },
  { code: "ipa.link.wikilink_target_missing", category: "link", severity: "warn", scope: "vault" }
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

// 아래 판정은 전부 원문에 "excalidraw" 리터럴을 요구한다 — 프론트매터 키,
// `# Excalidraw Data` 헤딩, JSON `type` 값 어디로든. 경로 검사와 이 스캔을
// 먼저 돌려서 일반 노트는 YAML 파싱 없이 빠져나가게 한다.
export function isExcalidrawMarkdownFile(relPath, raw) {
  if (isExcalidrawMarkdownPath(relPath)) return true;
  const text = String(raw ?? "");
  if (!/excalidraw/i.test(text)) return false;
  const { frontmatter, body } = readFrontmatter(text.replace(/\r\n/g, "\n"));
  return Object.hasOwn(frontmatter, "excalidraw-plugin") ||
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

// entries(캐시된 files.jsonl)를 주면 stat만으로 활성 노트를 확정한다: 캐시에는
// 활성 노트만 기록되므로 byte_size/mtime이 그대로면 excalidraw 판정을 위해 본문을
// 다시 읽을 필요가 없다. 캐시에 없는 파일(신규·변경·excalidraw)만 읽어 분류한다 —
// excalidraw 노트는 캐시에 들어가지 않으니 매 diff마다 다시 읽히지만 수가 적다.
async function activeMarkdownFileStats(vaultPath, mapping = DEFAULT_MAPPING, entries = null) {
  const excludes = asList(mapping.exclude);
  const files = await walkFiles(vaultPath, (path, relPath) =>
    extname(path).toLowerCase() === ".md" && !isExcludedPath(relPath, excludes)
  );
  const entriesByPath = entries
    ? new Map(entries.map((entry) => [toPosix(entry.path).normalize("NFC"), entry]))
    : null;
  const rows = [];
  for (const path of files.sort()) {
    const relPath = toPosix(relative(vaultPath, path));
    if (isExcalidrawMarkdownPath(relPath)) continue;
    const fileStat = await stat(path);
    const entry = entriesByPath?.get(relPath.normalize("NFC"));
    const known = Boolean(entry &&
      Number(entry.byte_size) === fileStat.size &&
      sameMtime(entry.mtime_ms, fileStat.mtimeMs));
    if (!known) {
      try {
        const raw = await readFile(path, "utf8");
        if (isExcalidrawMarkdownFile(relPath, raw)) continue;
      } catch {
        // Cache diff can rely on stat metadata for unchanged unreadable files.
      }
    }
    rows.push({
      path,
      relPath,
      byteSize: fileStat.size,
      mtimeMs: fileStat.mtimeMs
    });
  }
  return rows;
}

async function activeMarkdownFiles(vaultPath, mapping = DEFAULT_MAPPING, options = {}) {
  const excludes = asList(mapping.exclude);
  const files = await walkFiles(vaultPath, (path, relPath) =>
    extname(path).toLowerCase() === ".md" && !isExcludedPath(relPath, excludes)
  );
  const rows = [];
  for (const path of files.sort()) {
    const relPath = toPosix(relative(vaultPath, path));
    const raw = await readFile(path, "utf8");
    if (isExcalidrawMarkdownFile(relPath, raw)) continue;
    const row = { path, relPath, raw };
    if (options.stats) {
      const fileStat = await stat(path);
      row.byteSize = fileStat.size;
      row.mtimeMs = fileStat.mtimeMs;
    }
    rows.push(row);
  }
  return rows;
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
  const currentFiles = await activeMarkdownFileStats(vaultPath, mapping, cachedEntries);
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

// 캐시가 살아 있으면 요약을, 파일만 달라졌으면 증분 재빌드 결과를 그대로 돌려준다.
// fingerprint 계산과 볼트 스캔은 각각 한 번만 — 재빌드 후 캐시를 디스크에서
// 다시 읽지 않는다. 쓸 수 없는 캐시는 null이고, 호출자가 loadNotes로 폴백한다.
async function loadCachedNoteSummaries(vaultPath, mapping = DEFAULT_MAPPING) {
  const currentPluginFingerprint = await pluginFingerprint(vaultPath);
  const currentMappingFingerprint = mappingFingerprint(mapping);
  const manifest = await readCacheManifest(vaultPath);
  if (manifest?.cache_schema !== CACHE_SCHEMA) return null;
  if (manifest?.mapping_fingerprint !== currentMappingFingerprint) return null;
  if (manifest?.plugin_fingerprint !== currentPluginFingerprint) return null;
  const entries = await readCacheFileEntries(vaultPath);
  if (!entries) return null;
  const diff = await cacheFileDiff(vaultPath, mapping, entries);
  if (!diff) return null;
  if (!hasCacheFileChanges(diff)) return entries.map((entry) => noteSummaryFromCacheEntry(vaultPath, entry));
  const cacheDir = join(vaultPath, ".ipa", "cache");
  const result = await rebuildCacheIncremental(
    vaultPath, mapping, cacheDir, diff, currentPluginFingerprint, currentMappingFingerprint
  );
  return result.files.map((entry) => noteSummaryFromCacheEntry(vaultPath, entry));
}

export async function loadNotesForView(vaultPath, mapping = DEFAULT_MAPPING) {
  return await loadCachedNoteSummaries(vaultPath, mapping) ??
    await loadNotes(vaultPath, mapping);
}

// Exclude patterns are re-normalized for every scanned file; the raw pattern
// list is tiny and stable, so keep the normalized form (and the compiled glob
// below) around instead of redoing NFC/RegExp work per file.
const excludePatternCache = new Map();
const globRegexCache = new Map();

function normalizeExcludePattern(pattern) {
  const raw = String(pattern ?? "");
  let cached = excludePatternCache.get(raw);
  if (cached === undefined) {
    cached = toPosix(raw.trim()).replace(/^\/+/, "").normalize("NFC");
    excludePatternCache.set(raw, cached);
  }
  return cached;
}

function isExcludedPath(relPath, patterns) {
  const rel = toPosix(relPath).normalize("NFC");
  return patterns.some((pattern) => matchesPathPattern(rel, normalizeExcludePattern(pattern)));
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
  const cached = globRegexCache.get(pattern);
  if (cached !== undefined) return cached;
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
  const re = new RegExp(`^${source}$`);
  globRegexCache.set(pattern, re);
  return re;
}

export function indexNotes(notes) {
  return new Map(notes.map((note) => [note.id, note]));
}

export function buildGraph(notes) {
  const edges = {};
  const backlinks = {};
  // Same resolution order as findNote, but memoized: dangling links repeat
  // across notes and each miss would otherwise pay a full fuzzy scan.
  const lookup = makeNoteLookup(notes);
  for (const note of notes) {
    const targets = [...new Set(
      [...note.refs, ...note.links]
        .map((target) => lookup(target)?.id)
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
  return subsequenceScoreLower(needle.toLowerCase(), haystack.toLowerCase());
}

// 양쪽이 이미 소문자인 호출자용(prepared 검색 경로). toLowerCase는 멱등이라
// subsequenceScore와 결과가 같다.
function subsequenceScoreLower(q, h) {
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
  return fuzzyNameScorePrepared(
    queryLower,
    queryLower.replace(/\s+/g, ""),
    rawName,
    lower,
    lower.replace(/\s+/g, ""),
    precomputedQueryTrigrams,
    precomputedNameTrigrams
  );
}

// 노트/쿼리 한쪽에만 의존하는 소문자·공백제거 형태를 호출자가 미리 만들어 넘기는
// 경로. 순수 함수라 같은 입력에 대해 fuzzyNameScore와 결과가 같다.
function fuzzyNameScorePrepared(queryLower, queryNoSpace, name, nameLower, nameNoSpace, queryTrigramSet, nameTrigramSet) {
  if (!queryLower) return 0;
  if (nameLower === queryLower) return 1;
  if (nameLower.includes(queryLower)) return 1;
  if (queryNoSpace && nameNoSpace.includes(queryNoSpace)) return 1;
  const queryTrigrams = queryTrigramSet ?? new Set(jamoTrigrams(queryLower));
  if (queryTrigrams.size) {
    const nameTrigrams = nameTrigramSet ?? new Set(jamoTrigrams(name));
    if (nameTrigrams.size) {
      let overlap = 0;
      for (const item of queryTrigrams) {
        if (nameTrigrams.has(item)) overlap += 1;
      }
      const score = overlap / queryTrigrams.size;
      if (score >= 0.4) return score;
    }
  }
  return subsequenceScoreLower(queryLower, nameLower);
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
  // One pass to count duplicate query tokens instead of re-scanning the token
  // list per distinct token (was O(tokens^2) on long queries).
  const repeats = new Map();
  for (const token of queryTokens) repeats.set(token, (repeats.get(token) ?? 0) + 1);
  for (const [token, repeat] of repeats) {
    const termIndex = index.termToIndex.get(token);
    if (termIndex === undefined) continue;
    const idf = index.idf[termIndex];
    for (let p = index.postingsOffsets[termIndex]; p < index.postingsOffsets[termIndex + 1]; p += 1) {
      const docIndex = index.postings[p * 2];
      const frequency = index.postings[p * 2 + 1];
      const denom = frequency + index.k1 * (1 - index.b + index.b * index.docLen[docIndex] / avgdl);
      scores[docIndex] += repeat * idf * frequency * (index.k1 + 1) / Math.max(denom, 1e-9);
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
  const childBody = note.type === "index" || note.type === "root"
    ? Math.max(0, ...notes
      .filter((candidate) => candidate.type !== "index" && candidate.type !== "root")
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
  const isIndexLike = (note) => note.type === "index" || note.type === "root";
  const prepared = notes.map((note) => {
    const names = [note.id, ...note.aliases];
    const searchNames = names.map(searchableTitle).filter(Boolean);
    const searchNameLowers = searchNames.map((name) => name.toLowerCase());
    const bodySearch = searchableTitle(note.body);
    const isProject = inProjectDir(note.folder);
    return {
      note,
      names,
      nameKeys: names.map((name) => searchableKey(name)),
      searchNames,
      searchNameLowers,
      searchNameNoSpaces: searchNameLowers.map((name) => name.replace(/\s+/g, "")),
      nameTrigramSets: searchNames.map((name) => new Set(jamoTrigrams(name))),
      isIndexLike: isIndexLike(note),
      idKey: searchableKey(note.id),
      bodyLower: bodySearch.toLowerCase(),
      bodyTokenSet: new Set(tokenize(`${searchNames.join(" ")} ${bodySearch}`)),
      keywordText: searchableTitle(`${note.refs.join(" ")} ${note.tags.join(" ")} ${note.aliases.join(" ")} ${note.body}`).toLowerCase(),
      isProject,
      hasProjectContext: isProject ||
        note.refs.some((ref) => {
          const target = lookup(ref);
          return target && inProjectDir(target.folder);
        }),
      childBodyLowers: []
    };
  });
  // Map each index/root note to its children via an inverted ref index instead
  // of filtering all prepared notes for every index note (was O(index * n)).
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
  // child_body_match의 bm25 전파(자식 점수 -> index/root 부모)에 쓰는 간선은 노트에만
  // 의존하므로, 쿼리마다 refs를 다시 resolve하지 않도록 한 번만 만들어 둔다.
  const indexLikeParentsByNote = new Map();
  for (const note of notes) {
    if (note.type === "index" || note.type === "root") continue;
    const parents = [];
    for (const ref of note.refs) {
      const target = lookup(ref);
      if (target && isIndexLike(target)) parents.push(target.id);
    }
    if (parents.length) indexLikeParentsByNote.set(note.id, parents);
  }
  prepared.indexLikeParentsByNote = indexLikeParentsByNote;
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
      const parentsByNote = preparedNotes.indexLikeParentsByNote;
      for (let docIndex = 0; docIndex < rawScores.length; docIndex += 1) {
        const score = rawScores[docIndex];
        if (score <= 0) continue;
        const child = preparedNotes.noteById?.get(bm25.docIds[docIndex]);
        if (!child) continue;
        bm25Scores.set(child.id, score / maxRaw);
        if (child.type === "index" || child.type === "root") continue;
        for (const parentId of parentsByNote?.get(child.id) ?? []) {
          childBm25Scores.set(parentId, Math.max(childBm25Scores.get(parentId) ?? 0, score / maxRaw));
        }
      }
    }
  }
  return {
    raw,
    lower,
    noSpace: lower.replace(/\s+/g, ""),
    tokens: tokenize(raw),
    trigramSet: new Set(trigrams),
    bm25Scores,
    childBm25Scores
  };
}

// 하위 노트 본문이 많은 index에서 배열 전개(Math.max(0, ...))가 인자 한도에 걸리지
// 않도록 루프로 최대값을 구한다.
function maxChildBodyCoverage(tokens, bodies) {
  if (!tokens.length) return 0;
  let best = 0;
  for (const body of bodies) {
    let hits = 0;
    for (const token of tokens) {
      if (body.includes(token)) hits += 1;
    }
    const coverage = hits / tokens.length;
    if (coverage > best) best = coverage;
  }
  return best;
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
  if (bestName) {
    const matchedIndex = prepared.nameKeys.findIndex((key) => key.includes(query.lower));
    reasons.filename = { matched: matchedIndex >= 0 ? prepared.names[matchedIndex] : note.id };
  }

  const fuzzy = query.lower
    ? Math.max(0, ...prepared.searchNames.map((name, index) =>
        fuzzyNameScorePrepared(query.lower, query.noSpace, name,
          prepared.searchNameLowers[index], prepared.searchNameNoSpaces[index],
          query.trigramSet, prepared.nameTrigramSets?.[index])))
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

  const childBody = prepared.isIndexLike
    ? (query.childBm25Scores.get(note.id) ?? maxChildBodyCoverage(query.tokens, prepared.childBodyLowers))
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

// scorePreparedChannels가 채우는 키 집합과 같다 — 전부 켜져 있으면 비활성 채널
// 제거 루프를 건너뛸 수 있다.
const BASE_BUILTIN_CHANNEL_NAMES = BUILTIN_SEARCH_CHANNELS
  .filter((channel) => channel.phase === "base")
  .map((channel) => channel.name);

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
  // Notes are fixed for a lookup instance, so both hits and misses are cached.
  // Misses matter most: a dangling ref repeated across notes would otherwise
  // pay the fuzzy scan every time.
  const resolved = new Map();
  return (noteName) => {
    if (resolved.has(noteName)) return resolved.get(noteName);
    const normalized = normalizeTitle(noteName);
    const query = normalized.toLowerCase();
    const exact = byId.get(normalized) ?? byIdLower.get(query) ?? byAliasLower.get(query);
    let match = exact ?? null;
    if (!exact) {
      const scored = notes
        .map((note) => ({ note, score: noteNameScore(note, normalized) }))
        .filter((item) => item.score >= 0.65)
        .sort((a, b) => b.score - a.score || a.note.id.localeCompare(b.note.id));
      match = scored[0]?.note ?? null;
    }
    resolved.set(noteName, match);
    return match;
  };
}

const EMPTY_ROOT_SET = new Set();

function buildRootSets(notes, lookup = null) {
  const find = lookup ?? makeNoteLookup(notes);
  const rootSets = new Map();
  // The memoized sets are only ever read (here and by the rootSets consumers),
  // so hand back the cached instance instead of copying it on every hit.
  const visit = (note, seen = new Set()) => {
    if (!note || seen.has(note.id)) return EMPTY_ROOT_SET;
    if (rootSets.has(note.id)) return rootSets.get(note.id);
    seen.add(note.id);
    if (note.type === "root") {
      const roots = new Set([note.id]);
      rootSets.set(note.id, roots);
      return roots;
    }
    const roots = new Set();
    for (const ref of note.refs) {
      const target = find(ref);
      for (const root of visit(target, seen)) roots.add(root);
    }
    rootSets.set(note.id, roots);
    return roots;
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
  const seedById = new Map(notes.map((note) => [note.id, note]));
  const candidatesFor = (seed) => {
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
    return related;
  };

  // 쿼리 하나가 읽는 seed는 최대 3개인데 모든 노트를 seed로 미리 펼치면 후보 쌍이
  // 수십만 개까지 늘어난다. 역인덱스만 미리 만들고 seed별 목록은 첫 요청 때
  // 계산해 캐시한다(get 결과는 eager 버전과 동일).
  const bySeed = new Map();
  return {
    get(seedId) {
      if (bySeed.has(seedId)) return bySeed.get(seedId);
      const seed = seedById.get(seedId);
      const related = seed ? candidatesFor(seed) : undefined;
      bySeed.set(seedId, related);
      return related;
    }
  };
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
  // The prompt context and the log file are the same for every query here, so
  // read it once and write the whole batch at the end.
  const recorded = { promptContext: await currentPromptContext(vaultPath, options), lines: [] };
  const results = [];
  for (const query of queries) {
    const result = await searchWithContext(context, query, options);
    await maybeRecordSearchEvent(vaultPath, result, options, recorded);
    results.push(result);
  }
  await appendSearchEventLines(vaultPath, recorded.lines);
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

async function appendSearchEventLines(vaultPath, lines) {
  if (!lines.length) return;
  const path = tuneSearchLogPath(vaultPath);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, lines.join(""), "utf8");
}

// `recorded` lets a multi-query caller share one prompt-context read and
// collect the event lines for a single append (see searchVaultMany).
async function maybeRecordSearchEvent(vaultPath, result, options = {}, recorded = {}) {
  const promptContext = recorded.promptContext ?? await currentPromptContext(vaultPath, options);
  if (!shouldRecordSearchEvent(options, promptContext)) return;
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
  const line = JSON.stringify(event) + "\n";
  if (recorded.lines) recorded.lines.push(line);
  else await appendSearchEventLines(vaultPath, [line]);
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
  // 임계값을 통과한 행에 대해서만 hit 객체를 만든다 — reasons 병합 비용을 전체
  // 노트가 아니라 살아남은 행에만 낸다.
  let hits = [];
  for (const row of rowsByNote.values()) {
    const score = Number((weightedScore(row.channelScores, weights, channels) + row.pluginScore).toFixed(6));
    if (!(options.showAll || score >= threshold)) continue;
    hits.push({
      note: row.note,
      path: row.path,
      type: row.type,
      refs: row.refs,
      score,
      reasons: { ...row.reasons, ...row.pluginReasons }
    });
  }
  hits.sort((a, b) => b.score - a.score || a.note.localeCompare(b.note));
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

// Each entry holds a row per note, so a long-lived context (Obsidian) must not
// keep every query it has ever seen.
const QUERY_SCORE_CACHE_MAX = 64;

async function baseSearchRows(context, query) {
  if (context.queryScoreCache?.has(query)) {
    const cached = context.queryScoreCache.get(query);
    context.queryScoreCache.delete(query);
    context.queryScoreCache.set(query, cached);
    return cached;
  }
  const { vaultPath, mapping, notes, plugins, preparedNotes, channels = BUILTIN_SEARCH_CHANNELS } = context;
  const searchQuery = prepareSearchQuery(query, preparedNotes);
  // 채널 구성은 context 수명 동안 고정이므로 쿼리마다 다시 만들지 않는다.
  let baseBuiltins = context.baseBuiltinChannels;
  if (!baseBuiltins) {
    const enabled = new Set(channels
      .filter((channel) => channel.source === "builtin" && channel.phase === "base")
      .map((channel) => channel.name));
    baseBuiltins = { enabled, allEnabled: BASE_BUILTIN_CHANNEL_NAMES.every((name) => enabled.has(name)) };
    context.baseBuiltinChannels = baseBuiltins;
  }
  const rowsByNote = new Map();
  for (const prepared of preparedNotes) {
    const { note } = prepared;
    const scored = scorePreparedChannels(prepared, searchQuery);
    if (!baseBuiltins.allEnabled) {
      for (const key of Object.keys(scored.channelScores)) {
        if (!baseBuiltins.enabled.has(key)) {
          delete scored.channelScores[key];
          delete scored.reasons[key];
        }
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
  if (context.queryScoreCache) {
    context.queryScoreCache.set(query, rows);
    while (context.queryScoreCache.size > QUERY_SCORE_CACHE_MAX) {
      context.queryScoreCache.delete(context.queryScoreCache.keys().next().value);
    }
  }
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
  // channelWeight scans the channel list, and the seed score used to be
  // recomputed inside the sort comparator: resolve the weights once and score
  // each row once instead.
  const seedWeights = preRelatedChannels.map((channel) => channelWeight(channel, weights, channels));
  const seedScore = (row) =>
    preRelatedChannels.reduce((sum, channel, index) =>
      sum + (row.channelScores[channel] ?? 0) * seedWeights[index], 0);
  const seeds = [...rowsByNote.values()]
    .filter(preSignal)
    .map((row) => ({ row, score: seedScore(row) }))
    .sort((a, b) => b.score - a.score || a.row.note.localeCompare(b.row.note))
    .slice(0, 3)
    .map((item) => item.row);
  const related = [];
  for (const seed of seeds) {
    for (const candidate of relatedCandidatesBySeed.get(seed.note) ?? []) {
      const row = rowsByNote.get(candidate.note);
      if (!row || preSignal(row)) continue;
      if (candidate.score > 0) related.push({ row, score: candidate.score, seed: seed.note });
    }
  }
  let maxScore = 0;
  for (const item of related) {
    if (item.score > maxScore) maxScore = item.score;
  }
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

// sameNoteName의 동치류 키. 보통은 searchableKey지만 이모지만 있는 제목은 키가 빈
// 문자열이 되고, 그때 sameNoteName은 제목(대소문자 무시) 일치만 인정하므로 키를
// 분리한다 — searchableKey는 trim되므로 공백으로 시작하는 키와 겹치지 않는다.
// 빈 제목은 sameNoteName이 항상 false이므로 키가 없다(null).
function graphKey(value) {
  const key = searchableKey(value);
  if (key) return key;
  const title = normalizeTitle(value);
  return title ? ` ${title.toLowerCase()}` : null;
}

function distinctGraphKeys(values) {
  const keys = new Set();
  for (const value of values) {
    const key = graphKey(value);
    if (key) keys.add(key);
  }
  return keys;
}

// 노트 배열 하나당 한 번만 만드는 그래프 인덱스: refs/links를 동치류 키로 미리 묶어
// 두므로 children/backlinks/siblings/traversal이 노트 수만큼 sameNoteName을 다시
// 돌리지 않는다. view·context 경로는 같은 배열 인스턴스를 계속 넘기므로 WeakMap
// 캐시로 재사용되고, 배열이 버려지면 인덱스도 같이 회수된다.
const noteGraphIndexCache = new WeakMap();

function noteGraphIndex(notes) {
  const cached = noteGraphIndexCache.get(notes);
  if (cached) return cached;
  const childrenByKey = new Map();
  const inboundByKey = new Map();
  const order = new Map();
  const push = (map, key, note) => {
    const list = map.get(key);
    if (list) list.push(note);
    else map.set(key, [note]);
  };
  notes.forEach((note, position) => {
    order.set(note, position);
    for (const key of distinctGraphKeys(note.refs)) push(childrenByKey, key, note);
    for (const key of distinctGraphKeys([...note.refs, ...note.links])) push(inboundByKey, key, note);
  });
  const index = { lookup: makeNoteLookup(notes), childrenByKey, inboundByKey, order };
  noteGraphIndexCache.set(notes, index);
  return index;
}

// 두 목록 모두 notes 순서를 유지한다(예전 notes.filter와 같은 순서).
function childrenOf(note, notes) {
  const key = graphKey(note.id);
  return key ? noteGraphIndex(notes).childrenByKey.get(key) ?? [] : [];
}

function inboundOf(note, notes) {
  const key = graphKey(note.id);
  return key ? noteGraphIndex(notes).inboundByKey.get(key) ?? [] : [];
}

function countBacklinks(note, notes) {
  return inboundOf(note, notes).filter((candidate) => candidate.id !== note.id).length;
}

function countChildren(note, notes) {
  return childrenOf(note, notes).length;
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
  // 태그마다 notes를 훑는 대신 한 번만 훑어 태그별 노트 목록을 만든다. 같은 노트가
  // 같은 태그를 중복으로 달아도 목록에는 한 번만 들어간다(예전 includes 판정과 동일).
  const peersByTag = new Map();
  for (const candidate of notes) {
    if (candidate.id === note.id) continue;
    for (const tag of candidate.tags) {
      const peers = peersByTag.get(tag);
      if (!peers) peersByTag.set(tag, [candidate]);
      else if (peers[peers.length - 1] !== candidate) peers.push(candidate);
    }
  }
  const sorted = note.tags
    .map((tag) => ({ tag, peers: peersByTag.get(tag) ?? [] }))
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

// options.notes: 이미 파싱해 둔 노트 스냅샷(같은 호출 안에서 여러 노트를 다루는
// 경로가 볼트를 매번 다시 읽지 않도록). 노트 해석에만 쓴다.
export async function resolveNote(vaultPath, noteName, options = {}) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = options.notes ?? await loadNotes(vaultPath, mapping);
  const note = findNote(notes, noteName);
  if (!note) throw new Error(`note not found: ${noteName}`);
  return { note, mapping, notes };
}

export async function rewriteNote(vaultPath, noteName, rewrite, options = {}) {
  if (typeof rewrite !== "function") throw new Error("rewriteNote requires a rewrite function");
  const resolved = await resolveNote(vaultPath, noteName, { notes: options.notes });
  const { mapping, notes } = resolved;
  // 스냅샷은 노트 해석 용도이므로 본문은 대상 파일만 다시 읽는다 — 같은 스냅샷으로
  // 같은 노트를 두 번 쓰더라도 앞선 쓰기가 유실되지 않는다.
  const note = options.notes
    ? noteFromRaw(resolved.note, await readFile(resolved.note.path, "utf8"), mapping)
    : resolved.note;
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
  // Body prose first, callout as fallback. Callout-first taught vaults to stuff
  // the whole note into the top callout and leave the body empty; the snippet
  // should reward real body text. Document order already puts the paragraph
  // under H1 before H2, so no explicit heading priority is needed.
  let text = "";
  let inFence = false;
  const paragraph = [];
  for (const raw of body.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```")) {
      if (paragraph.length) break;
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!trimmed) {
      if (paragraph.length) break;
      continue;
    }
    if (trimmed.startsWith("#") || trimmed.startsWith(">") || trimmed.startsWith("---")
      || trimmed.startsWith("![") || trimmed.startsWith("|")) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(trimmed.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, ""));
  }
  text = paragraph.join(" ");
  if (!text) {
    const callout = body.match(/^>\s*\[!\w+\][+-]?[ \t]*([^\n]*)((?:\n>[^\n]*)*)/m);
    if (callout) {
      const block = String(callout[2] ?? "")
        .split("\n")
        .map((line) => line.replace(/^>\s?/, "").replace(/^[-*]\s+/, "").trim())
        .filter(Boolean)
        .join(" ");
      text = [String(callout[1] ?? "").trim(), block].filter(Boolean).join(" — ");
    }
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
    syncUpdatedAt: key === mapping.updated_at ? false : options.syncUpdatedAt,
    notes: options.notes
  });
  return { ...result, operation: "set-note-field", field: key };
}

// One call replaces the "traversal --down + view --full per child" loop:
// children of an index with modified date, section titles, and a short snippet.
export async function digestNote(vaultPath, noteName, options = {}) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = options.notes ?? await loadNotes(vaultPath, mapping);
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
  // 순회는 id/type/ref/alias만 읽으므로 traversalAll과 같이 캐시 요약본으로 충분하다.
  const notes = options.notes ?? await loadNotesForView(vaultPath, (await readVaultConfig(vaultPath)).mapping);
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

export async function graphTopology(vaultPath, noteName, options = {}) {
  const { mapping } = await readVaultConfig(vaultPath);
  const notes = options.notes ?? await loadNotesForView(vaultPath, mapping);
  const center = findNote(notes, noteName);
  if (!center) throw new Error(`note not found: ${noteName}`);

  const depthValue = Number(options.depth ?? 2);
  const maxNodesValue = Number(options.maxNodes ?? 100);
  if (!Number.isFinite(depthValue) || depthValue < 0) throw new Error(`invalid graph depth: ${options.depth}`);
  if (!Number.isFinite(maxNodesValue) || maxNodesValue < 1) throw new Error(`invalid graph maxNodes: ${options.maxNodes}`);
  const depth = Math.floor(depthValue);
  const maxNodes = Math.floor(maxNodesValue);
  const index = noteGraphIndex(notes);
  const reverseRefs = new Map();
  const reverseLinks = new Map();

  const addReverse = (map, target, source) => {
    const key = graphKey(target);
    if (!key) return;
    const list = map.get(key) ?? [];
    if (!list.some((item) => item.id === source.id)) list.push(source);
    map.set(key, list);
  };
  for (const note of notes) {
    for (const ref of note.refs) addReverse(reverseRefs, ref, note);
    for (const link of note.links) addReverse(reverseLinks, link, note);
  }

  const neighborsFor = (note) => {
    const grouped = new Map();
    const add = (target, kind, direction) => {
      const neighbor = typeof target === "string" ? index.lookup(target) : target;
      if (!neighbor || neighbor.id === note.id) return;
      let entry = grouped.get(neighbor.id);
      if (!entry) {
        entry = { note: neighbor, relations: [] };
        grouped.set(neighbor.id, entry);
      }
      if (!entry.relations.some((item) => item.kind === kind && item.direction === direction)) {
        entry.relations.push({ kind, direction });
      }
    };
    for (const ref of note.refs) add(ref, "ref", "out");
    for (const link of note.links) add(link, "link", "out");
    for (const source of reverseRefs.get(graphKey(note.id)) ?? []) add(source, "ref", "in");
    for (const source of reverseLinks.get(graphKey(note.id)) ?? []) add(source, "link", "in");
    return [...grouped.values()];
  };

  const discovered = new Map([[center.id, {
    id: center.id,
    type: center.type || "note",
    distance: 0,
    parent: null,
    relations: []
  }]]);
  const queue = [center];
  const omitted = new Set();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const note = queue[cursor];
    const current = discovered.get(note.id);
    if (current.distance >= depth) continue;
    for (const neighbor of neighborsFor(note)) {
      if (discovered.has(neighbor.note.id)) continue;
      if (discovered.size >= maxNodes) {
        omitted.add(neighbor.note.id);
        continue;
      }
      discovered.set(neighbor.note.id, {
        id: neighbor.note.id,
        type: neighbor.note.type || "note",
        distance: current.distance + 1,
        parent: note.id,
        relations: neighbor.relations
      });
      queue.push(neighbor.note);
    }
  }

  const crossEdges = [];
  const seenPairs = new Set();
  for (const note of queue) {
    const current = discovered.get(note.id);
    if (current.distance >= depth) continue;
    for (const neighbor of neighborsFor(note)) {
      const target = discovered.get(neighbor.note.id);
      if (!target || target.parent === note.id || current.parent === neighbor.note.id) continue;
      const pair = [note.id, neighbor.note.id].sort().join("\u0000");
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      crossEdges.push({
        from: note.id,
        to: neighbor.note.id,
        relations: neighbor.relations
      });
    }
  }

  return {
    operation: "graph",
    center: center.id,
    depth,
    max_nodes: maxNodes,
    nodes: [...discovered.values()],
    cross_edges: crossEdges,
    truncated_nodes: omitted.size
  };
}

// seen은 분기마다 복사하는 대신 하나를 공유하고 재귀에서 돌아올 때 되돌린다 —
// 어느 시점에도 현재 스택 경로의 id만 담기므로 예전 new Set(seen) 복사와 결과가
// 같다(형제 분기가 같은 노트를 각각 펼치는 동작 포함).
function upwardPaths(note, notes, seen = new Set()) {
  if (seen.has(note.id)) return [[note.id]];
  if (!note.refs.length) return [[note.id]];
  const lookup = noteGraphIndex(notes).lookup;
  seen.add(note.id);
  const paths = [];
  for (const ref of note.refs) {
    const parent = lookup(ref);
    if (!parent) paths.push([note.id, ref]);
    else for (const path of upwardPaths(parent, notes, seen)) paths.push([note.id, ...path]);
  }
  seen.delete(note.id);
  return paths;
}

function downwardTree(noteId, notes, seen = new Set()) {
  const index = noteGraphIndex(notes);
  const note = index.lookup(noteId);
  const id = note?.id ?? noteId;
  if (seen.has(id)) return { note: id, type: note?.type ?? "", children: [] };
  seen.add(id);
  const key = graphKey(id);
  const children = (key ? index.childrenByKey.get(key) ?? [] : [])
    .map((candidate) => candidate.id)
    .sort()
    .map((child) => downwardTree(child, notes, seen));
  seen.delete(id);
  return { note: id, type: note?.type ?? "", children };
}

function siblings(note, notes) {
  if (!note.refs.length) return [];
  const index = noteGraphIndex(notes);
  const found = new Set();
  for (const key of distinctGraphKeys(note.refs)) {
    for (const candidate of index.childrenByKey.get(key) ?? []) {
      if (candidate.id !== note.id) found.add(candidate);
    }
  }
  return [...found].sort((a, b) => index.order.get(a) - index.order.get(b));
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

const BUILTIN_RULES = [
  builtinRule("ipa.inbox.raw_capture", {
    checkNote(note, ctx) {
      return isRawInboxCapture(note, ctx.mapping)
        ? [noteIssue(this.code, note, "raw inbox capture without frontmatter")]
        : [];
    }
  }),
  builtinRule("ipa.frontmatter.missing_type", {
    checkNote(note, ctx) {
      return note.frontmatter[ctx.mapping.note_type] === undefined
        ? [noteIssue(this.code, note, `missing frontmatter field: ${ctx.mapping.note_type}`)]
        : [];
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
        .filter((ref) => !markdownTitleExists(ctx.noteTitles, ref) && !markdownTitleExists(ctx.excludedTitles, ref))
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
  })
];

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
  // config/mapping/rules can be supplied by a caller that already resolved them
  // (formatVault), so plugins are not loaded twice for one plan.
  const { config, mapping } = options.config && options.mapping
    ? { config: options.config, mapping: options.mapping }
    : await readVaultConfig(vaultPath);
  if (!notes) notes = await loadNotes(vaultPath, mapping);
  const ctx = {
    config,
    mapping,
    notes,
    vaultPath,
    ...ruleGraphContext(notes),
    noteTitles: noteTitleSet(notes),
    ...await loadLinkTargetTitles(vaultPath, mapping, notes)
  };
  const rules = options.rules ?? await activeRulesForVault(vaultPath, config);
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

// Link-target titles for the validator. One tree walk partitions the vault into
// active markdown / excluded markdown / attachments, and the active titles come
// from the already-loaded notes — so no active file is read a second time.
async function loadLinkTargetTitles(vaultPath, mapping, notes) {
  const excludes = asList(mapping.exclude);
  const files = await walkFiles(vaultPath, () => true);
  const notePaths = new Set(notes.map((note) => note.relPath));
  const activePaths = notes.map((note) => note.path);
  const excludedMarkdown = [];
  const attachments = [];
  const unclassified = [];
  for (const path of files) {
    const relPath = toPosix(relative(vaultPath, path));
    const excluded = isExcludedPath(relPath, excludes);
    if (extname(path).toLowerCase() !== ".md") {
      if (!excluded) attachments.push(path);
    } else if (excluded) {
      excludedMarkdown.push(path);
    } else if (!notePaths.has(relPath)) {
      unclassified.push({ path, relPath });
    }
  }
  // loadNotes drops excalidraw markdown, but its titles still resolve links, so
  // only the active files missing from notes are read to classify them.
  for (const file of unclassified) {
    const raw = await readFile(file.path, "utf8");
    if (isExcalidrawMarkdownFile(file.relPath, raw)) excludedMarkdown.push(file.path);
    else activePaths.push(file.path);
  }
  return {
    markdownTitles: markdownTitleSet(activePaths),
    excludedTitles: markdownTitleSet(excludedMarkdown),
    attachmentTitles: attachmentTitleSet(attachments)
  };
}

function attachmentTitleSet(files) {
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

// Same multi-form Set as markdownTitleSet, over note ids and aliases: a hit is
// equivalent to sameNoteName against any note title (was an O(n) scan per ref).
function noteTitleSet(notes) {
  const titles = new Set();
  for (const note of notes) {
    for (const value of [note.id, ...note.aliases]) {
      const title = normalizeTitle(value);
      if (!title) continue;
      titles.add(title);
      titles.add(title.toLowerCase());
      const key = searchableKey(title);
      if (key) titles.add(key);
    }
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
  const fixRules = rules.filter((item) => item.fixNote);
  const patches = [];
  for (const note of notes) {
    let text = note.raw;
    // 앞 규칙이 본문을 바꾸지 않았으면 같은 파싱 결과를 그대로 다음 규칙에 넘긴다.
    let workingNote = null;
    const applied = [];
    for (const rule of fixRules) {
      if (!workingNote) workingNote = noteFromRaw(note, text, ctx.mapping);
      const next = applyRuleFixOutput(text, await rule.fixNote(workingNote, { ...ctx, note: workingNote }));
      if (next !== text) {
        text = next;
        workingNote = null;
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
  const validation = options.patchesOnly ? { issues: [] } : await validateVault(vaultPath, allNotes, { rules, config, mapping });
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
  const noteCount = (await activeMarkdownFileStats(vaultPath, mapping)).length;
  const issues = [];
  if ((!check || check === "config") && !existsSync(join(vaultPath, ".ipa", "config.yaml"))) {
    issues.push({ code: "doctor.config.missing", severity: "warn", message: ".ipa/config.yaml missing — run `ipa config init` to create it" });
  }
  const cacheRoot = join(vaultPath, ".ipa", "cache");
  if ((!check || check === "cache") && existsSync(cacheRoot)) {
    const files = await walkAll(cacheRoot);
    for (const file of files) {
      // bm25.bin 같은 대용량 바이너리를 문자열로 펼치지 않도록 Buffer로 스캔한다.
      const content = await readFile(file).catch(() => Buffer.alloc(0));
      if (content.includes(vaultPath)) {
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
      notes: noteCount,
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
  return inboundOf(note, notes).filter((candidate) => candidate.id !== note.id);
}

function outlinkNotes(note, notes) {
  const lookup = noteGraphIndex(notes).lookup;
  return uniqueNotes(note.links.map((link) => lookup(link)).filter(Boolean));
}

function childNotes(note, notes) {
  return childrenOf(note, notes).filter((candidate) => candidate.id !== note.id);
}

function refDetails(note, notes, mapping = DEFAULT_MAPPING) {
  const lookup = noteGraphIndex(notes).lookup;
  return note.refs.map((ref) => {
    const target = lookup(ref);
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
  const lookup = noteGraphIndex(notes).lookup;
  return paths.map((path) => path.map((id) => {
    const target = lookup(id);
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
  const lookup = noteGraphIndex(notes).lookup;
  for (const note of notes.filter((candidate) => ids.has(candidate.id))) {
    const targets = uniqueNotes([...note.refs, ...note.links].map((target) => lookup(target)).filter(Boolean))
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
  const lookup = noteGraphIndex(notes).lookup;
  return results.map((hit) => {
    const note = lookup(hit.note);
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
  const lookup = noteGraphIndex(notes).lookup;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ref, count]) => {
      const target = lookup(ref);
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
  // 노트마다 결과 목록을 다시 훑지 않도록 동치류 키로 한 번만 색인한다(먼저 나온
  // 히트가 이긴다 — 예전 find와 같은 선택).
  const hitByKey = new Map();
  for (const hit of search.results) {
    const key = graphKey(hit.note);
    if (key && !hitByKey.has(key)) hitByKey.set(key, hit);
  }
  const contextNotes = selected.map((note) =>
    contextNote(note, notes, query, hitByKey.get(graphKey(note.id)), preset, mapping)
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
  const currentFiles = await activeMarkdownFiles(vaultPath, mapping, { stats: true });
  const notes = [];
  const files = [];
  for (const file of currentFiles) {
    const note = noteFromFile(vaultPath, file.path, file.raw, mapping);
    notes.push(note);
    files.push(cacheFileEntry(note, file));
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
  const { notes, preparedNotes } = context;
  const lookup = preparedNotes.lookup;
  const vocab = linkSuggestVocab(context.config);
  const selected = noteName ? [lookup(noteName)].filter(Boolean) : notes;
  const idf = noteName ? buildLinkSuggestionIdf(notes, vocab.stopwords) : null;
  const rootSets = noteName ? buildRootSets(notes, lookup) : new Map();
  const suggestions = [];
  for (const note of selected) {
    const byTarget = new Map();
    const sourceBody = stripLinkSuggestionSource(note.body);
    const bodyKey = searchableTitle(sourceBody).toLowerCase();
    const existingTargets = existingLinkTargets(note);
    // hasNoteName을 후보마다 부르는 대신 키 집합으로 한 번에 판정한다
    // (sameNoteName은 키가 비지 않는 한 searchableKey 동일성과 같다).
    const existingKeys = new Set(existingTargets.map((value) => searchableKey(value)));
    const alreadyLinked = (target, targetKey) =>
      targetKey ? existingKeys.has(targetKey) : hasNoteName(existingTargets, target);
    for (const prepared of preparedNotes) {
      const other = prepared.note;
      const otherKey = prepared.idKey;
      if (other.id === note.id || alreadyLinked(other.id, otherKey)) continue;
      if (sourceBody.includes(other.id) || (otherKey && bodyKey.includes(otherKey))) {
        addRankedLinkSuggestion(byTarget, other, { note: note.id, reason: "plain_text_title_match", rank: 1 });
      }
    }
    if (noteName && idf) {
      for (const query of extractLinkSuggestionQueries(note, idf, vocab)) {
        const result = await searchWithContext(context, query.query, { threshold: 0, maxResults: LINK_SUGGEST_SEARCH_RESULTS_PER_QUERY });
        result.results.forEach((hit, index) => {
          const target = lookup(hit.note);
          if (!target || target.id === note.id || alreadyLinked(target.id, searchableKey(target.id))) return;
          if (target.type === "index" || target.type === "root") return;
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
  // 컨텍스트 하나로 제안 생성과 계획 작성을 모두 처리한다 — suggestLinks가
  // 자체 컨텍스트를 다시 만들면 볼트를 두 번 읽게 된다.
  const context = await prepareSearchContext(vaultPath);
  const lookup = context.preparedNotes.lookup;
  const suggestions = await suggestLinks(vaultPath, options.note ?? null, { context });
  const shaByNote = new Map();
  const noteSha = (note) => {
    let sha = shaByNote.get(note.id);
    if (sha === undefined) {
      sha = sha256(note.raw);
      shaByNote.set(note.id, sha);
    }
    return sha;
  };
  const plan = {
    version: 1,
    kind: "link",
    created_at: nowIso(),
    changes: suggestions.suggestions.map((item) => {
      const note = lookup(item.note);
      return {
        note: item.note,
        path: note?.relPath,
        sha256: note ? noteSha(note) : null,
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
  const lookup = makeNoteLookup(notes);
  const shaByNote = new Map();
  // 한 노트에 여러 변경이 걸리면 이어지는 치환은 직전 결과 위에 적용해야 한다.
  // 매번 note.raw에서 시작하면 앞선 치환이 덮여 사라진다.
  const textByNote = new Map();
  const changed = [];
  for (const change of plan.changes ?? []) {
    const note = lookup(change.note);
    if (!note || hasNoteName(note.links, change.target)) continue;
    if (change.sha256) {
      let sha = shaByNote.get(note.id);
      if (sha === undefined) {
        sha = sha256(note.raw);
        shaByNote.set(note.id, sha);
      }
      if (sha !== change.sha256) throw new Error(`hash guard failed for ${note.id}`);
    }
    const current = textByNote.get(note.id) ?? note.raw;
    const next = current.replace(change.target, `[[${change.target}]]`);
    if (next !== current) {
      textByNote.set(note.id, next);
      await writeFile(note.path, next, "utf8");
      if (!changed.includes(note.relPath)) changed.push(note.relPath);
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
  // 치환 결과를 계획 단계에서 한 번만 계산하고, apply는 실제로 바뀐 노트만 쓴다.
  const rewrites = [];
  for (const item of notes) {
    if (item.raw.includes(`[[${oldName}]]`) || item.raw.includes(oldName)) {
      changes.push({ path: item.relPath, replace: oldName, with: newName });
      if (item.id === oldName) continue;
      const next = item.raw.replaceAll(`[[${oldName}]]`, `[[${newName}]]`).replaceAll(oldName, newName);
      if (next !== item.raw) rewrites.push({ path: item.path, text: next });
    }
  }
  if (apply) {
    await rename(note.path, target);
    for (const item of rewrites) await writeFile(item.path, item.text, "utf8");
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
    const lookup = makeNoteLookup(notes);
    for (const item of recommendations.filter((row) => row.applyable)) {
      const note = lookup(item.note);
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
      // 본문에 제목이 아예 없으면 두 치환 모두 무의미하므로 문자열 스캔만 하고 넘어간다.
      if (!next.includes(source.id)) continue;
      next = next.split(`[[${source.id}]]`).join(`[[${target.id}]]`);
      next = next.split(`[[${source.id}|`).join(`[[${target.id}|`);
    }
    const linksChanged = next !== note.raw;
    // ref 재작성은 프론트매터를 다시 파싱한다. 링크 치환이 건드리지 않은 문자열
    // 목록이고 중복도 없으면 결과가 입력과 같으므로 파싱 자체를 건너뛴다.
    const currentRefs = asList(note.frontmatter[mapping.refs]);
    const refsNeedRewrite =
      currentRefs.some((item) => typeof item !== "string" || sources.some((source) => item.includes(source.id))) ||
      new Set(currentRefs).size !== currentRefs.length;
    const withRefs = refsNeedRewrite
      ? rewriteListValue(next, mapping.refs, (items) => {
        const mapped = items.map((item) => sourceIds.has(stripWiki(item)) ? `[[${target.id}]]` : String(item));
        return [...new Set(mapped)];
      }, null)
      : next;
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
  const lookup = context.preparedNotes.lookup;
  const note = lookup(noteName);
  if (!note) throw new Error(`note not found: ${noteName}`);
  const only = asList(options.only).map(String);
  const wants = (kind) => !only.length || only.includes(kind);
  const apply = Boolean(options.apply);

  const suggestions = wants("refs") || wants("links")
    ? (await suggestLinks(vaultPath, note.id, { context })).suggestions
    : [];

  const refSuggestions = [];
  if (wants("refs")) {
    const counts = new Map();
    for (const item of suggestions) {
      const related = lookup(item.target);
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
    // 링크를 하나 쓸 때마다 볼트를 통째로 다시 읽는 대신, 노트 해석은 이미 로드한
    // 스냅샷으로 하고 본문만 대상 파일에서 새로 읽는다(앞선 쓰기 반영은 그대로).
    const freshNote = async (noteId) => {
      const resolved = lookup(noteId);
      if (!resolved) throw new Error(`note not found: ${noteId}`);
      return { path: resolved.path, raw: await readFile(resolved.path, "utf8") };
    };
    if (wants("refs") && !note.refs.length && refSuggestions[0]) {
      await setNoteField(vaultPath, note.id, mapping.refs, { add: [refSuggestions[0].ref], apply: true, notes });
      appliedChanges.push({ note: note.id, kind: "ref", value: refSuggestions[0].ref });
    }
    for (const change of forwardLinks) {
      const current = await freshNote(change.note);
      const next = current.raw.replace(change.target, `[[${change.target}]]`);
      if (next !== current.raw) {
        await writeFile(current.path, syncUpdatedAtText(next, mapping), "utf8");
        appliedChanges.push({ note: change.note, kind: "link", value: change.target });
      }
    }
    for (const change of reverseLinks) {
      const current = await freshNote(change.note);
      const next = current.raw.replace(note.id, `[[${note.id}]]`);
      if (next !== current.raw) {
        await writeFile(current.path, syncUpdatedAtText(next, mapping), "utf8");
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

export async function reviewVault(vaultPath, scope = "all") {
  const scopes = new Set(["all", "convention", "inbox", "duplicates"]);
  if (!scopes.has(scope)) throw new Error(`unknown review scope: ${scope}`);
  const { config, mapping } = await readVaultConfig(vaultPath);
  const notes = await loadNotes(vaultPath, mapping);
  const validation = await validateVault(vaultPath, notes, { config, mapping });
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
  // 캐시버스팅 키는 mtime이다: 안 바뀐 플러그인은 ESM 모듈 캐시를 재사용하고
  // (매 호출마다 모듈 레코드가 새로 쌓이는 것을 막는다), tune/dry-run이 플러그인
  // 파일을 고치면 mtime이 바뀌어 재시작 없이 다시 로드된다.
  const version = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
  return import(pathToFileURL(path).href + `?t=${version}`);
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
    await appendFile(path, `${JSON.stringify(row)}\n`, "utf8");
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
  // A local commit (dev machine) leaves the checkout up to date in git terms
  // while the built bundle — what the `ipa` symlink actually runs — is stale.
  // Compare the bundle mtime against the HEAD commit time so `--apply` still
  // rebuilds in that case. A missing bundle is not treated as stale: fixture
  // clones and non-ipa checkouts have no dist at all.
  const distBundle = join(repoRoot, "packages", "cli", "dist", "main.js");
  const headCommitMs = Number(gitOutput(repoRoot, ["log", "-1", "--format=%ct"]) ?? 0) * 1000;
  const distStale = headCommitMs > 0 && existsSync(distBundle) && statSync(distBundle).mtimeMs < headCommitMs;
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
    dist_stale: distStale,
    changes,
    commands
  };
  if (!options.apply) {
    const hint = behind > 0
      ? "run `ipa update --apply` or the commands above from the repo root"
      : distStale
        ? "the built bundle is older than HEAD; run `ipa update --apply` to rebuild"
        : null;
    return { ...base, mode: "plan", hint };
  }
  const runSteps = (stepsToRun) => {
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
      if (!ok) return { steps, failed: cmd.join(" ") };
    }
    return { steps, failed: null };
  };
  const finish = (steps, extra = {}) => ({
    ...base,
    mode: "apply",
    applied: true,
    steps,
    commit_after: gitOutput(repoRoot, ["rev-parse", "--short", "HEAD"]),
    next: "run `ipa harness status` to check for outdated harness components, then `ipa harness update <target>` if needed",
    ...extra
  });
  if (behind === 0) {
    if (!distStale) {
      return { ...base, mode: "apply", applied: false, steps: [], message: "already up to date" };
    }
    // Rebuild-only path: no git pull happens, so a dirty worktree is fine.
    const { steps, failed } = runSteps(options.steps ?? SELF_UPDATE_STEPS.slice(1));
    if (failed) {
      return { ...base, mode: "apply", status: "error", reason: "step_failed", steps, message: `command failed: ${failed}` };
    }
    return finish(steps, { rebuilt: true, message: "already up to date; rebuilt the stale bundle" });
  }
  if (dirty) {
    return { ...base, mode: "apply", status: "error", reason: "dirty_worktree", message: "commit or stash local changes before updating" };
  }
  if (ahead > 0) {
    return { ...base, mode: "apply", status: "error", reason: "diverged", message: `local branch is ahead of ${upstream}; fast-forward pull is not possible` };
  }
  const { steps, failed } = runSteps(options.steps ?? SELF_UPDATE_STEPS);
  if (failed) {
    return { ...base, mode: "apply", status: "error", reason: "step_failed", steps, message: `command failed: ${failed}` };
  }
  return finish(steps);
}

// Session gate: the single check the Stop hook consults before a session may
// end. Combines the builtin formatter check over this session's pending edits
// with vault-owned gate plugins (.ipa/plugins/gates/*.js). On pass, the
// session's ledger entries are cleared. Gate plugin errors are reported but
// never block — a broken plugin must not lock the session shut.
const harnessSessionGateImpl = createHarnessSessionGate({
  formatVault,
  loadPluginModules,
  normalizeGatePlugin,
  readVaultConfig,
  loadNotes,
  makeNoteLookup
});

const harnessGuard = createHarnessGuard({
  readVaultConfig,
  asList,
  toPosix,
  isExcludedPath
});

const harnessApplication = createHarnessService({
  readVaultConfig,
  callCounterOptions,
  vaultLocalSkillStatus,
  pluginScaffoldStatus,
  outdatedComponents: harnessOutdatedComponents,
  userOwnedComponents: harnessUserOwnedComponents,
  guardStatus: harnessGuardStatus,
  pluginInit,
  cliVersionInfo,
  nowIso,
  localSkills: VAULT_LOCAL_SKILLS,
  expectedArtifacts: harnessExpectedArtifacts,
  toPosix,
  installGlobal: installGlobalHarness,
  uninstallLocalSkills: uninstallVaultLocalSkills,
  uninstallGlobal: uninstallGlobalHarness,
  fragmentNames: harnessFragmentNames,
  pluginDoctor,
  vaultLocalSkillRelPath
});

export async function harnessStatus(vaultPath, options = {}) {
  return harnessApplication.status(vaultPath, options);
}

export async function harnessInstall(vaultPath, target = "codex", options = {}) {
  return harnessApplication.install(vaultPath, target, options);
}

export async function harnessUninstall(vaultPath, target = "codex", options = {}) {
  return harnessApplication.uninstall(vaultPath, target, options);
}

export async function harnessUpdate(vaultPath, target = "codex", options = {}) {
  return harnessApplication.update(vaultPath, target, options);
}

export async function harnessDoctor(vaultPath, options = {}) {
  return harnessApplication.doctor(vaultPath, options);
}

export async function harnessSessionGate(vaultPath, options = {}) {
  return harnessSessionGateImpl(vaultPath, options);
}

export async function harnessGuardStatus(vaultPath) {
  return harnessGuard.status(vaultPath);
}

export async function harnessGuardCheck(vaultPath, relPath, options = {}) {
  return harnessGuard.check(vaultPath, relPath, options);
}

// `ipa convention show`: the built-in IPA concepts rendered through the active
// config (real field/folder names) plus the vault's own operating rules from
// .ipa/harness/fragments/ — the same source the harness inlines into prompts.
export async function conventionShow(vaultPath) {
  const { config, mapping } = await readVaultConfig(vaultPath);
  const guardAllow = guardAllowPatterns(config, asList);
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

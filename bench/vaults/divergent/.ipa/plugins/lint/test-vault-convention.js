const REQUIRED_FIELDS = ["created", "updated", "kind", "parents", "tags", "aliases", "stage"];
const LIST_FIELDS = ["parents", "tags", "aliases"];
const LEGACY_FIELDS = ["type", "ref", "date_created", "date_modified", "obsidianUIMode"];
const VALID_KINDS = new Set(["note", "index", "root"]);
const VALID_STAGES = new Set(["inbox", "active", "archived", "meta", "fixture"]);
const EXPECTED_STAGE_BY_TOP_FOLDER = { "00 Inbox": "inbox", "01 Project": "active", "02 Archive": "archived" };

function issue(note, code, severity, message) {
  return { code, severity, note: note.id, path: note.relPath, message };
}

function asList(value) {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function stripWiki(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]$/);
  return (match ? match[1] : text).trim().normalize("NFC");
}

export async function lint(note, context) {
  const fm = note.frontmatter ?? {};
  if (note.folder === context.mapping.inbox_dir && Object.keys(fm).length === 0) return [];

  const issues = [];
  const missing = REQUIRED_FIELDS.filter((field) => fm[field] === undefined);
  if (missing.length) {
    issues.push(issue(note, "ipa_test.frontmatter", "error", "missing test-vault frontmatter fields: " + missing.join(", ")));
  }

  const legacy = LEGACY_FIELDS.filter((field) => fm[field] !== undefined);
  if (legacy.length) {
    issues.push(issue(note, "ipa_test.frontmatter", "error", "uses main-vault frontmatter fields in test vault: " + legacy.join(", ")));
  }

  if (fm.kind !== undefined && !VALID_KINDS.has(fm.kind)) {
    issues.push(issue(note, "ipa_test.frontmatter", "error", "kind must be one of note, index, root"));
  }
  if (fm.stage !== undefined && !VALID_STAGES.has(fm.stage)) {
    issues.push(issue(note, "ipa_test.frontmatter", "error", "stage must be one of inbox, active, archived, meta, fixture"));
  }

  for (const field of LIST_FIELDS) {
    if (fm[field] !== undefined && !Array.isArray(fm[field])) {
      issues.push(issue(note, "ipa_test.frontmatter", "error", field + " must be a YAML list"));
    }
  }

  const parts = note.relPath.split("/");
  const expectedStage = EXPECTED_STAGE_BY_TOP_FOLDER[parts[0]];
  if (expectedStage && fm.stage !== undefined && fm.stage !== expectedStage) {
    issues.push(issue(note, "ipa_test.frontmatter", "error", "stage must be " + expectedStage + " under " + parts[0]));
  }

  if (parts[0] === "01 Project" && fm.kind === "note") {
    issues.push(issue(note, "ipa_test.location", "error", "01 Project may contain root/index only"));
  }
  if (parts[0] === "02 Archive" && parts.length > 2) {
    issues.push(issue(note, "ipa_test.location", "error", "02 Archive must stay flat"));
  }

  if (fm.kind === "note") {
    const rootIds = new Set(context.notes.filter((item) => item.frontmatter?.kind === "root").map((item) => item.id));
    const directRoots = asList(fm.parents).map(stripWiki).filter((parent) => rootIds.has(parent));
    if (directRoots.length) {
      issues.push(issue(note, "ipa_test.note_to_root", "warn", "note must parent an index before root: " + directRoots.join(", ")));
    }
  }

  return issues;
}

import { App, TFile } from "obsidian";

// IPA Flow planner. Computes the convention-driven target folder for a note from
// its type, refs, and current location, reproducing the "Move IPA Convention"
// template as plugin logic. The actual move is performed by core's moveNote so
// links stay consistent.

export interface FlowPlan {
  note: string;
  fromFolder: string;
  targetFolder: string;
  reason: string;
}

export interface FlowError {
  error: string;
}

interface NoteMeta {
  title: string;
  path: string;
  folder: string;
  type: string;
  refs: string[];
  location: "inbox" | "project" | "archive" | "other";
}

const PROJECT = "01 Project";
const ARCHIVE = "02 Archive";
const IPA_TYPES = ["note", "index", "root"];

export class IpaFlow {
  constructor(private readonly app: App) {}

  plan(file: TFile): FlowPlan | FlowError {
    const meta = this.readMeta(file);
    if (!meta) return { error: "Cannot read note frontmatter (type/ref)." };
    if (!IPA_TYPES.includes(meta.type)) {
      return { error: `Unsupported IPA type: "${meta.type || "(none)"}".` };
    }
    if (meta.type === "note" && meta.refs.length === 0) {
      return { error: "An IPA note needs at least one ref before it can move." };
    }

    const index = this.buildIndex();
    const result =
      meta.type === "note"
        ? this.planNote(meta)
        : meta.type === "index"
          ? this.planIndex(meta, index)
          : this.planRoot(meta, index);

    if ("error" in result) return result;
    if (result.targetFolder === meta.folder) {
      return { error: `Note is already in "${meta.folder || "vault root"}".` };
    }
    if (this.hasConflict(result.targetFolder, meta.title, meta.path)) {
      return { error: `"${meta.title}" already exists in ${result.targetFolder}.` };
    }
    return result;
  }

  private planNote(meta: NoteMeta): FlowPlan | FlowError {
    if (meta.location === "archive") return { error: "Note is already in Archive." };
    return { note: meta.title, fromFolder: meta.folder, targetFolder: ARCHIVE, reason: "note → Archive" };
  }

  private planIndex(meta: NoteMeta, index: Map<string, NoteMeta>): FlowPlan | FlowError {
    if (meta.location === "inbox") {
      const parent = this.parentFolder(meta, index, ["index", "root"]);
      return {
        note: meta.title,
        fromFolder: meta.folder,
        targetFolder: parent ?? PROJECT,
        reason: parent ? "index → parent folder" : "index → Project"
      };
    }
    if (meta.location === "project") {
      return { note: meta.title, fromFolder: meta.folder, targetFolder: ARCHIVE, reason: "index retire → Archive" };
    }
    // archive → restore
    const parent = this.parentFolder(meta, index, ["index", "root"]);
    const target = parent && parent.startsWith(PROJECT) ? parent : PROJECT;
    return { note: meta.title, fromFolder: meta.folder, targetFolder: target, reason: "index restore" };
  }

  private planRoot(meta: NoteMeta, index: Map<string, NoteMeta>): FlowPlan | FlowError {
    if (meta.location === "project") {
      if (this.folderHasOtherNotes(meta.folder, meta.path)) {
        return { error: `Cannot retire root: "${meta.folder}" still contains other notes.` };
      }
      return { note: meta.title, fromFolder: meta.folder, targetFolder: ARCHIVE, reason: "root retire → Archive" };
    }
    const folderName = this.rootFolderName(meta.title);
    if (!folderName) return { error: "Cannot derive a folder name from the root title." };
    const parentRoot = this.parentFolder(meta, index, ["root"]);
    const base = parentRoot ?? PROJECT;
    return {
      note: meta.title,
      fromFolder: meta.folder,
      targetFolder: `${base}/${folderName}`,
      reason: "root → Project folder"
    };
  }

  private parentFolder(meta: NoteMeta, index: Map<string, NoteMeta>, types: string[]): string | null {
    for (const ref of meta.refs) {
      const parent = index.get(ref);
      if (parent && types.includes(parent.type)) return parent.folder;
    }
    return null;
  }

  private buildIndex(): Map<string, NoteMeta> {
    const map = new Map<string, NoteMeta>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const meta = this.readMeta(file);
      if (meta) map.set(meta.title, meta);
    }
    return map;
  }

  private readMeta(file: TFile): NoteMeta | null {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter) return null;
    return {
      title: file.basename,
      path: file.path,
      folder: file.parent?.path ?? "",
      type: String(frontmatter.type ?? "").trim(),
      refs: this.parseRefs(frontmatter.ref),
      location: this.locationOf(file.path)
    };
  }

  private parseRefs(raw: unknown): string[] {
    const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return items.map((item) => this.stripWiki(String(item))).filter(Boolean);
  }

  private stripWiki(value: string): string {
    const match = value.match(/\[\[([^\]|#]+)/);
    return (match ? match[1] : value).trim();
  }

  private locationOf(path: string): NoteMeta["location"] {
    const top = path.split("/")[0] ?? "";
    if (/inbox/i.test(top)) return "inbox";
    if (/archive/i.test(top)) return "archive";
    if (/project/i.test(top)) return "project";
    return "other";
  }

  private rootFolderName(title: string): string {
    return title
      .replace(/^🏷️\s*/u, "")
      .replace(/\s*Root$/i, "")
      .trim();
  }

  // A move is blocked if a different note with the same title already exists in
  // the target folder.
  private hasConflict(targetFolder: string, title: string, currentPath: string): boolean {
    const targetPath = targetFolder ? `${targetFolder}/${title}.md` : `${title}.md`;
    if (targetPath === currentPath) return false;
    return this.app.vault.getAbstractFileByPath(targetPath) instanceof TFile;
  }

  // Retiring a root is blocked while its folder still holds other notes.
  private folderHasOtherNotes(folder: string, selfPath: string): boolean {
    if (!folder) return false;
    const prefix = `${folder}/`;
    return this.app.vault
      .getMarkdownFiles()
      .some((file) => file.path !== selfPath && (file.parent?.path === folder || file.path.startsWith(prefix)));
  }
}

import { App, FileSystemAdapter, Notice, TFile, normalizePath } from "obsidian";
import type { EventRef } from "obsidian";

// Wraps Obsidian's app/vault/workspace APIs so core never depends on Obsidian
// directly. Resolves the vault path, the active note, opening notes, reading the
// current selection, and file/leaf change events.
export class ObsidianVaultAdapter {
  constructor(private readonly app: App) {}

  hasFileSystemAccess(): boolean {
    return this.app.vault.adapter instanceof FileSystemAdapter;
  }

  getVaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    throw new Error("IPA requires a desktop vault backed by the file system.");
  }

  getActiveNoteTitle(): string | null {
    return this.app.workspace.getActiveFile()?.basename ?? null;
  }

  getActiveNotePath(): string | null {
    return this.app.workspace.getActiveFile()?.path ?? null;
  }

  getSelection(): string {
    const editor = this.app.workspace.activeEditor?.editor;
    return editor?.getSelection() ?? "";
  }

  private async openFile(file: TFile): Promise<void> {
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async openByPath(relPath: string): Promise<boolean> {
    // core paths can be NFD (macOS fs); Obsidian indexes by NFC.
    const file = this.app.vault.getAbstractFileByPath(normalizePath(relPath).normalize("NFC"));
    if (file instanceof TFile) {
      await this.openFile(file);
      return true;
    }
    return false;
  }

  async openByTitle(title: string): Promise<boolean> {
    const match = this.app.vault.getMarkdownFiles().find((file) => file.basename === title);
    if (match) {
      await this.openFile(match);
      return true;
    }
    return false;
  }

  // Open a note preferring its vault-relative path (returned by core) and
  // falling back to a title lookup.
  async open(relPath: string | null, title: string | null): Promise<void> {
    if (relPath && (await this.openByPath(relPath))) return;
    if (title && (await this.openByTitle(title))) return;
    new Notice(`IPA: could not open note (${title ?? relPath ?? "unknown"})`);
  }

  // Backlinks via the public resolvedLinks graph (getBacklinksForFile is not part
  // of the public API). Returns notes that link to the active file.
  getBacklinks(): Array<{ title: string; path: string }> {
    const active = this.app.workspace.getActiveFile();
    if (!active) return [];
    const resolved = this.app.metadataCache.resolvedLinks ?? {};
    const out: Array<{ title: string; path: string }> = [];
    for (const sourcePath of Object.keys(resolved)) {
      if (sourcePath === active.path) continue;
      if (resolved[sourcePath]?.[active.path]) {
        const file = this.app.vault.getAbstractFileByPath(sourcePath);
        if (file instanceof TFile) out.push({ title: file.basename, path: file.path });
      }
    }
    return out;
  }

  onActiveChange(callback: () => void): EventRef {
    return this.app.workspace.on("active-leaf-change", callback);
  }

  onFileModify(callback: () => void): EventRef {
    return this.app.vault.on("modify", callback);
  }
}

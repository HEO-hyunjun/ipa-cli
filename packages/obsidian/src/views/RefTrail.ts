import { Keymap, MarkdownView, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import type IpaPlugin from "../main";

const REFRESH_DEBOUNCE_MS = 200;
const TRAIL_CLS = "ipa-ref-trail";
const ACTIVE_CLS = "ipa-ref-trail-on";

// Shows each markdown note's ref path ("Root / Index / Note") in the view header
// in place of Obsidian's folder breadcrumb ("02 Archive / Note"): in IPA the
// hierarchy lives in ref links, not in folders. Notes outside the IPA index, and
// notes without refs, keep the folder breadcrumb.
//
// Obsidian owns the header DOM, so the trail is a sibling element it never
// touches; CSS hides the folder breadcrumb only while a trail is present.
export class RefTrail {
  private timer: number | null = null;
  // Last seen frontmatter per file, so body edits (frequent autosaves) do not
  // trigger a recompute; only frontmatter edits such as a changed ref do.
  private frontmatter = new Map<string, string>();

  constructor(private readonly plugin: IpaPlugin) {}

  register(): void {
    const { app } = this.plugin;
    const schedule = () => this.schedule();
    this.plugin.registerEvent(app.workspace.on("layout-change", schedule));
    this.plugin.registerEvent(app.workspace.on("file-open", schedule));
    this.plugin.registerEvent(app.vault.on("rename", schedule));
    this.plugin.registerEvent(
      app.metadataCache.on("changed", (file) => {
        const next = JSON.stringify(app.metadataCache.getFileCache(file)?.frontmatter ?? null);
        const prev = this.frontmatter.get(file.path);
        this.frontmatter.set(file.path, next);
        if (prev !== undefined && prev !== next) schedule();
      })
    );
    app.workspace.onLayoutReady(schedule);
  }

  schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.refreshAll();
    }, REFRESH_DEBOUNCE_MS);
  }

  // Remove every trail and restore the folder breadcrumbs (setting off, unload).
  clear(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const container = this.headerOf(leaf);
      container?.querySelector(`.${TRAIL_CLS}`)?.remove();
      container?.removeClass(ACTIVE_CLS);
    }
  }

  private async refreshAll(): Promise<void> {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      await this.refresh(leaf);
    }
  }

  private headerOf(leaf: WorkspaceLeaf): HTMLElement | null {
    return leaf.view.containerEl.querySelector<HTMLElement>(".view-header-title-container");
  }

  private async refresh(leaf: WorkspaceLeaf): Promise<void> {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const container = this.headerOf(leaf);
    if (!container) return;
    const file = view.file;
    let trail: Array<{ id: string; relPath: string | null }> | null = null;
    if (this.plugin.settings.showRefTrail && file && this.plugin.adapter.hasFileSystemAccess()) {
      try {
        trail = await this.plugin.client.refTrail(file.path);
      } catch {
        trail = null; // fall back to the folder breadcrumb on any core error
      }
    }
    if (view.file !== file) return; // the leaf moved on while core was working

    container.querySelector(`.${TRAIL_CLS}`)?.remove();
    container.toggleClass(ACTIVE_CLS, !!trail && trail.length > 0);
    if (!trail || trail.length === 0) return;

    // Reuse Obsidian's breadcrumb classes so the trail looks like the folder path.
    const el = createDiv({ cls: ["view-header-title-parent", TRAIL_CLS] });
    for (const node of trail) {
      const crumb = el.createSpan({ cls: "view-header-breadcrumb", text: node.id });
      const relPath = node.relPath;
      if (relPath) {
        crumb.setAttr("aria-label", relPath);
        crumb.addEventListener("click", (event) => void this.open(relPath, event));
      } else {
        crumb.addClass("is-unresolved");
      }
      el.createSpan({ cls: "view-header-breadcrumb-separator", text: "/" });
    }
    container.insertBefore(el, container.querySelector(".view-header-title"));
  }

  // Click opens in the current tab; Cmd/Ctrl-click follows Obsidian's new-tab rule.
  private async open(relPath: string, event: MouseEvent): Promise<void> {
    const { app } = this.plugin;
    const file = app.vault.getAbstractFileByPath(normalizePath(relPath).normalize("NFC"));
    if (file instanceof TFile) await app.workspace.getLeaf(Keymap.isModEvent(event)).openFile(file);
  }
}

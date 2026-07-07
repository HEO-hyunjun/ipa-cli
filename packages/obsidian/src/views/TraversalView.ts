import { WorkspaceLeaf } from "obsidian";
import { BaseIpaView } from "./BaseIpaView";
import { TRAVERSAL_TAB_LABELS, VIEW_TYPE_TRAVERSAL } from "../util/constants";
import type { TraversalTab } from "../util/constants";
import { refLabel } from "../util/format";
import type IpaPlugin from "../main";

const REFRESH_DEBOUNCE_MS = 200;
const LIST_LIMIT = 5;

interface TreeNode {
  note?: string;
  id?: string;
  children?: TreeNode[];
}

// Shows up / down / siblings / root / backlinks for the active note together, one
// section each, instead of a single tab at a time.
export class TraversalView extends BaseIpaView {
  private noteTitle: string | null = null;
  private notePath: string | null = null;
  private bodyEl!: HTMLElement;
  private debounceTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: IpaPlugin) {
    super(leaf, plugin);
  }

  getViewType(): string {
    return VIEW_TYPE_TRAVERSAL;
  }

  getDisplayText(): string {
    return "IPA Traversal";
  }

  getIcon(): string {
    return "git-fork";
  }

  async onOpen(): Promise<void> {
    const { body } = this.buildShell("Traversal");
    this.bodyEl = body;
    this.registerEvent(this.adapter.onActiveChange(() => this.scheduleRefresh()));
    await this.refresh(true);
  }

  async onClose(): Promise<void> {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  private async refresh(force = false): Promise<void> {
    const path = this.adapter.getActiveNotePath();

    // Focus / window changes fire active-leaf-change with no active markdown
    // file (or the same one). Keep the current view instead of clearing it, so
    // switching windows or clicking the panel doesn't make it flicker.
    if (!path) {
      if (force) {
        this.notePath = null;
        this.noteTitle = null;
        this.bodyEl.empty();
        this.showEmpty(this.bodyEl, "Open a note to see its IPA graph.");
      }
      return;
    }
    if (!force && path === this.notePath) return;

    if (!this.adapter.hasFileSystemAccess()) {
      this.bodyEl.empty();
      this.showError(this.bodyEl, "IPA requires a desktop vault backed by the file system.");
      return;
    }

    this.notePath = path;
    this.noteTitle = this.adapter.getActiveNoteTitle();
    const title = this.noteTitle ?? "";

    // Excluded (non-IPA-managed) files have no graph: show an empty state
    // instead of letting core throw "note not found" into the error banner.
    if (!(await this.client.isManagedPath(path))) {
      if (this.notePath !== path) return;
      this.bodyEl.empty();
      this.showEmpty(this.bodyEl, "Not an IPA-managed note (excluded from indexing).");
      return;
    }

    try {
      // One load (reused from cache) covers up/down/siblings/root in a single pass.
      const data = await this.client.traversalAll(title);
      // Drop stale results if the active note changed while we were loading.
      if (this.notePath !== path) return;
      const backlinks = this.adapter.getBacklinks();

      const tree = data?.tree;
      const upPaths = Array.isArray(data?.paths) ? data.paths : [];
      const downChildren = Array.isArray(tree?.children) ? tree.children : [];
      const siblingList = Array.isArray(data?.siblings) ? data.siblings : [];
      const rootList = Array.isArray(data?.roots) ? data.roots : [];

      // Swap content in one step after loading (no empty-then-load gap).
      this.bodyEl.empty();
      this.bodyEl.createDiv({ cls: "ipa-item__meta", text: title });
      this.renderSection("up", upPaths.length, (container) => this.renderPaths(container, upPaths));
      this.renderSection("down", downChildren.length, (container) => this.renderTree(container, tree));
      this.renderSection("siblings", siblingList.length, (container) =>
        this.renderList(container, siblingList, "No siblings.")
      );
      this.renderSection("root", rootList.length, (container) => this.renderList(container, rootList, "No root found."));
      this.renderSection("backlinks", backlinks.length, (container) =>
        this.renderList(container, backlinks, "No backlinks.")
      );
    } catch (error) {
      if (this.notePath !== path) return;
      this.bodyEl.empty();
      this.showError(this.bodyEl, error);
    }
  }

  private renderSection(tab: TraversalTab, count: number, render: (container: HTMLElement) => void): void {
    const section = this.bodyEl.createEl("details", { cls: "ipa-section" });
    section.open = true;
    const summary = section.createEl("summary", { cls: "ipa-section__header" });
    summary.createSpan({ cls: "ipa-view__title", text: TRAVERSAL_TAB_LABELS[tab] });
    summary.createSpan({ cls: "ipa-section__count", text: String(count) });
    const body = section.createDiv({ cls: "ipa-section__body" });
    render(body);
  }

  private renderPaths(container: HTMLElement, paths: unknown[], limit = LIST_LIMIT): void {
    if (paths.length === 0) {
      container.createDiv({ cls: "ipa-empty", text: "No upward paths." });
      return;
    }
    const list = container.createEl("ul", { cls: "ipa-list" });
    const renderSlice = (slice: unknown[]) => {
      for (const path of slice) this.renderPathRow(list, path);
    };
    renderSlice(paths.slice(0, limit));
    if (paths.length > limit) {
      this.renderMore(container, paths.length - limit, () => renderSlice(paths.slice(limit)));
    }
  }

  private renderPathRow(list: HTMLElement, path: unknown): void {
    const row = list.createEl("li", { cls: "ipa-path" });
    const nodes = Array.isArray(path) ? path : [path];
    nodes.forEach((node, index) => {
      const link = row.createSpan({ cls: "ipa-path__node", text: refLabel(node) });
      link.addEventListener("click", () => this.openNode(node));
      if (index < nodes.length - 1) row.createSpan({ cls: "ipa-path__sep", text: " → " });
    });
  }

  private renderTree(container: HTMLElement, tree: TreeNode | undefined, limit = LIST_LIMIT): void {
    const children = tree?.children ?? [];
    if (children.length === 0) {
      container.createDiv({ cls: "ipa-empty", text: "No children." });
      return;
    }
    const list = container.createEl("ul", { cls: "ipa-list" });
    const renderSlice = (slice: TreeNode[]) => {
      for (const child of slice) this.renderTreeNode(list, child, 0);
    };
    renderSlice(children.slice(0, limit));
    if (children.length > limit) {
      this.renderMore(container, children.length - limit, () => renderSlice(children.slice(limit)));
    }
  }

  private renderTreeNode(container: HTMLElement, node: TreeNode, depth: number): void {
    const title = node.note ?? node.id ?? "?";
    const row = container.createEl("li", { cls: "ipa-item", attr: { tabindex: "0" } });
    row.style.marginLeft = `${depth * 14}px`;
    row.createDiv({ cls: "ipa-item__title", text: title });
    row.addEventListener("click", () => void this.adapter.open(null, title));
    for (const child of node.children ?? []) {
      this.renderTreeNode(container, child, depth + 1);
    }
  }

  private renderList(container: HTMLElement, items: unknown, emptyMessage: string, limit = LIST_LIMIT): void {
    const entries = Array.isArray(items) ? items : [];
    if (entries.length === 0) {
      container.createDiv({ cls: "ipa-empty", text: emptyMessage });
      return;
    }
    const list = container.createEl("ul", { cls: "ipa-list" });
    const renderSlice = (slice: unknown[]) => {
      for (const entry of slice) this.renderListItem(list, entry);
    };
    renderSlice(entries.slice(0, limit));
    if (entries.length > limit) {
      this.renderMore(container, entries.length - limit, () => renderSlice(entries.slice(limit)));
    }
  }

  private renderListItem(list: HTMLElement, entry: unknown): void {
    const record = entry as { title?: string; id?: string; note?: string; path?: string } | string;
    const title = typeof record === "string" ? record : record.title ?? record.id ?? record.note ?? String(record);
    const path = typeof record === "object" ? record.path ?? null : null;
    const row = list.createEl("li", { cls: "ipa-item", attr: { tabindex: "0", role: "button" } });
    row.createDiv({ cls: "ipa-item__title", text: title });
    const open = () => void this.adapter.open(path, title);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  }

  // Shared "Show N more" link used by every section (paths, tree, lists).
  private renderMore(container: HTMLElement, remaining: number, expand: () => void): void {
    const more = container.createEl("a", { cls: "ipa-more", text: `Show ${remaining} more` });
    more.addEventListener("click", () => {
      expand();
      more.remove();
    });
  }

  private openNode(node: unknown): void {
    const title = typeof node === "string" ? node : ((node as { id?: string })?.id ?? null);
    if (title) void this.adapter.open(null, title);
  }
}

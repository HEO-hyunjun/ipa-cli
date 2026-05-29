import { WorkspaceLeaf } from "obsidian";
import { BaseIpaView } from "./BaseIpaView";
import { VIEW_TYPE_SEARCH } from "../util/constants";
import { locationFromPath, refLabel, scoreLabel } from "../util/format";
import type IpaPlugin from "../main";

interface SearchHit {
  note?: string;
  path?: string;
  type?: string;
  refs?: unknown[];
  score?: number;
}

export class SearchView extends BaseIpaView {
  private inputEl!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private resultsEl!: HTMLElement;
  private pendingQuery = "";

  constructor(leaf: WorkspaceLeaf, plugin: IpaPlugin) {
    super(leaf, plugin);
  }

  getViewType(): string {
    return VIEW_TYPE_SEARCH;
  }

  getDisplayText(): string {
    return "IPA Search";
  }

  getIcon(): string {
    return "search";
  }

  setQuery(query: string, run = false): void {
    this.pendingQuery = query;
    if (this.inputEl) {
      this.inputEl.value = query;
      if (run) void this.runSearch();
    }
  }

  async onOpen(): Promise<void> {
    const { body } = this.buildShell("Search");

    this.inputEl = body.createEl("input", {
      cls: "ipa-search__input",
      attr: { type: "search", placeholder: "Search the vault, then press Enter", spellcheck: "false" }
    });
    this.statusEl = body.createDiv({ cls: "ipa-item__meta" });
    this.resultsEl = body.createDiv();

    // Search runs only on Enter (no search-as-you-type).
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.runSearch();
      }
    });

    if (this.pendingQuery) {
      this.inputEl.value = this.pendingQuery;
      void this.runSearch();
    } else {
      this.showEmpty(this.resultsEl, "Type a query and press Enter.");
    }
    this.inputEl.focus();
  }

  private async runSearch(): Promise<void> {
    const query = this.inputEl.value.trim();
    this.pendingQuery = query;

    if (!query) {
      this.statusEl.setText("");
      this.showEmpty(this.resultsEl, "Type a query and press Enter.");
      return;
    }
    if (!this.adapter.hasFileSystemAccess()) {
      this.showError(this.resultsEl, "IPA requires a desktop vault backed by the file system.");
      return;
    }

    this.statusEl.setText("Searching…");
    try {
      const payload = await this.client.searchCached(query, {
        maxResults: this.plugin.settings.searchResultLimit
      });
      this.renderResults(payload);
    } catch (error) {
      this.statusEl.setText("");
      this.showError(this.resultsEl, error);
    }
  }

  private renderResults(payload: { query?: string; count?: number; threshold?: number; results?: SearchHit[] }): void {
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const count = payload?.count ?? results.length;
    const threshold = payload?.threshold;
    this.statusEl.setText(
      threshold === undefined ? `${count} results` : `${count} results · threshold ${scoreLabel(threshold)}`
    );

    this.resultsEl.empty();
    if (!results.length) {
      this.showEmpty(this.resultsEl, `No results for "${payload?.query ?? this.pendingQuery}".`);
      return;
    }

    const list = this.resultsEl.createEl("ul", { cls: "ipa-list" });
    for (const hit of results) this.renderHit(list, hit);
  }

  private renderHit(list: HTMLElement, hit: SearchHit): void {
    const item = list.createEl("li", { cls: "ipa-item", attr: { tabindex: "0", role: "button" } });
    item.createDiv({ cls: "ipa-item__title", text: hit.note ?? "(untitled)" });

    const meta = item.createDiv({ cls: "ipa-item__meta" });
    if (hit.type) meta.createSpan({ cls: "ipa-badge ipa-badge--type", text: String(hit.type) });
    const location = locationFromPath(hit.path);
    if (location) meta.createSpan({ cls: "ipa-badge", text: location });
    if (this.plugin.settings.showSearchScore) {
      meta.createSpan({ cls: "ipa-badge ipa-badge--score", text: scoreLabel(hit.score) });
    }
    if (Array.isArray(hit.refs) && hit.refs.length) {
      meta.createSpan({ text: `→ ${hit.refs.map(refLabel).join(", ")}` });
    }

    const open = () => void this.adapter.open(hit.path ?? null, hit.note ?? null);
    item.addEventListener("click", open);
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  }
}

import { App, Keymap, SuggestModal } from "obsidian";
import type IpaPlugin from "../main";
import { errorMessage } from "../util/format";
import { SearchHit, renderHitMeta } from "./searchHit";

// A short pause before searching so fast typing does not search every key;
// with a warmed search context one query takes a few milliseconds.
const DEBOUNCE_MS = 150;

// IPA search as a popup like the quick switcher: results follow the typing and
// Enter opens the note (Cmd/Ctrl-click opens it in a new tab). It needs no
// sidebar tab, so it sits beside Obsidian's own search instead of a second
// search panel.
export class SearchModal extends SuggestModal<SearchHit> {
  private timer: number | null = null;
  private pending: ((hits: SearchHit[]) => void) | null = null;
  private latest: SearchHit[] = [];

  constructor(app: App, private readonly plugin: IpaPlugin, private readonly initialQuery = "") {
    super(app);
    this.limit = plugin.settings.searchResultLimit;
    this.setPlaceholder("IPA search");
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: "to open" },
      { command: "esc", purpose: "to dismiss" }
    ]);
  }

  onOpen(): void {
    super.onOpen();
    if (this.initialQuery) {
      this.inputEl.value = this.initialQuery;
      this.inputEl.dispatchEvent(new Event("input"));
    }
  }

  onClose(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.pending?.(this.latest);
    this.pending = null;
  }

  getSuggestions(query: string): SearchHit[] | Promise<SearchHit[]> {
    const text = query.trim();
    if (this.timer !== null) window.clearTimeout(this.timer);
    // A superseded request settles with what is on screen so nothing hangs.
    this.pending?.(this.latest);
    this.pending = null;
    if (!text) {
      this.latest = [];
      return [];
    }
    if (!this.plugin.adapter.hasFileSystemAccess()) {
      this.emptyStateText = "IPA requires a desktop vault backed by the file system.";
      return [];
    }
    return new Promise((resolve) => {
      this.pending = resolve;
      this.timer = window.setTimeout(async () => {
        this.timer = null;
        try {
          const payload = await this.plugin.client.searchCached(text, {
            maxResults: this.plugin.settings.searchResultLimit
          });
          this.latest = Array.isArray(payload?.results) ? payload.results : [];
          this.emptyStateText = `No results for "${text}".`;
        } catch (error) {
          this.latest = [];
          this.emptyStateText = `IPA search failed: ${errorMessage(error)}`;
        }
        if (this.pending === resolve) {
          this.pending = null;
          resolve(this.latest);
        }
      }, DEBOUNCE_MS);
    });
  }

  renderSuggestion(hit: SearchHit, el: HTMLElement): void {
    el.addClass("ipa-search-suggestion");
    el.createDiv({ cls: "suggestion-title", text: hit.note ?? "(untitled)" });
    renderHitMeta(el.createDiv({ cls: "ipa-item__meta" }), hit, this.plugin.settings.showSearchScore);
  }

  onChooseSuggestion(hit: SearchHit, event: MouseEvent | KeyboardEvent): void {
    void this.plugin.adapter.open(hit.path ?? null, hit.note ?? null, Keymap.isModEvent(event));
  }
}

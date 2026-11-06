import { App, Editor, EditorChange, MarkdownView, Notice, Platform, SuggestModal, TFile } from "obsidian";
import type IpaPlugin from "../main";
import { errorMessage, locationFromPath, scoreLabel } from "../util/format";

const DEBOUNCE_MS = 150;
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

// One row: a link suggestion for the note, or an IPA search hit.
interface Candidate {
  target: string;
  type: string;
  path: string | null;
  detail: string;
  score?: number;
  // Section title shown above the first row of each suggestion group.
  header?: string;
}

interface LinkSuggestion {
  target?: string;
  target_type?: string;
  target_path?: string | null;
  reason?: string;
  score?: number;
  source_notes?: string[];
}

export interface AddLinkTarget {
  file: TFile;
  editor: Editor;
  view: MarkdownView | null;
  refsKey: string;
}

type Mode = "ref" | "link";

const isParent = (item: Candidate) => item.type === "index" || item.type === "root";
// What picking a row does unless switched: index/root become a ref, notes a link.
const defaultMode = (item: Candidate): Mode => (isParent(item) ? "ref" : "link");
const flip = (mode: Mode): Mode => (mode === "ref" ? "link" : "ref");
const modeLabel = (mode: Mode) => (mode === "ref" ? "→ ref" : "link");

function suggestionDetail(item: LinkSuggestion): string {
  if (item.reason === "plain_text_title_match") return "mentioned in this note";
  if (item.reason === "neighbor_ref_match" && item.source_notes?.length) return `similar notes: ${item.source_notes.join(", ")}`;
  // A semantic match carries the note's own text that found it; one block often
  // finds every row, so repeating it on each row says nothing.
  return "";
}

// core already orders suggestions project index/root, other index/root, notes.
function fromSuggestions(items: LinkSuggestion[]): Candidate[] {
  let last = "";
  return items
    .filter((item) => typeof item.target === "string")
    .map((item) => {
      const candidate: Candidate = {
        target: item.target as string,
        type: item.target_type || "note",
        path: item.target_path ?? null,
        detail: suggestionDetail(item),
        score: item.score
      };
      const header = !isParent(candidate)
        ? "Notes"
        : locationFromPath(candidate.path) === "project" ? "Project index" : "Archive index";
      if (header !== last) candidate.header = header;
      last = header;
      return candidate;
    });
}

// Pick links for the open note, like the IPA search popup: with an empty query
// it lists the note's link suggestions, and typing searches the vault instead.
// ↵ (or a click) picks a row without closing, Mod+↵ adds every picked one:
// - ref → the note's ref frontmatter (where the note belongs; index/root default)
// - link → its first plain mention wrapped in [[ ]], otherwise [[…]] at the cursor
//   (notes default)
// Shift+↵, a shift-click or a click on the ref/link badge picks the row the other
// way, since a ref may name a parent note too.
export class AddLinkModal extends SuggestModal<Candidate> {
  private readonly picked = new Map<string, { item: Candidate; mode: Mode }>();
  private readonly rows = new Map<string, { box: HTMLInputElement; badge: HTMLElement }>();
  private suggestions: Promise<Candidate[]> | null = null;
  private timer: number | null = null;
  private pending: ((items: Candidate[]) => void) | null = null;
  private latest: Candidate[] = [];
  private pickedEl!: HTMLElement;

  constructor(app: App, private readonly plugin: IpaPlugin, private readonly target: AddLinkTarget) {
    super(app);
    this.limit = 50;
    this.setPlaceholder(`Add links to ${target.file.basename} — type to search`);
    const mod = Platform.isMacOS ? "⌘" : "Ctrl";
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: "to pick" },
      { command: "⇧ ↵", purpose: "to pick as ref ↔ link" },
      { command: `${mod} ↵`, purpose: "to add picked" },
      { command: "esc", purpose: "to dismiss" }
    ]);
    this.scope.register(["Mod"], "Enter", () => {
      void this.apply();
      return false;
    });
    this.scope.register(["Shift"], "Enter", (event) => {
      this.selectActiveSuggestion(event);
      return false;
    });
  }

  onOpen(): void {
    super.onOpen();
    this.pickedEl = createDiv({ cls: "ipa-add-link__picked" });
    this.resultContainerEl.after(this.pickedEl);
    this.renderPicked();
  }

  onClose(): void {
    super.onClose();
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.pending?.(this.latest);
    this.pending = null;
  }

  getSuggestions(query: string): Candidate[] | Promise<Candidate[]> {
    const text = query.trim();
    if (this.timer !== null) window.clearTimeout(this.timer);
    // A superseded request settles with what is on screen so nothing hangs.
    this.pending?.(this.latest);
    this.pending = null;
    if (!this.plugin.adapter.hasFileSystemAccess()) {
      this.emptyStateText = "IPA requires a desktop vault backed by the file system.";
      return [];
    }
    if (!text) return this.loadSuggestions().then((items) => (this.latest = items));
    return new Promise((resolve) => {
      this.pending = resolve;
      this.timer = window.setTimeout(async () => {
        this.timer = null;
        try {
          const payload = await this.plugin.client.searchCached(text, { maxResults: this.limit });
          const hits: Array<{ note?: string; type?: string; path?: string; score?: number }> =
            Array.isArray(payload?.results) ? payload.results : [];
          this.latest = hits
            .filter((hit) => typeof hit.note === "string" && hit.note !== this.target.file.basename)
            .map((hit) => ({ target: hit.note as string, type: hit.type || "note", path: hit.path ?? null, detail: "", score: hit.score }));
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

  // Suggestions are computed once per open; clearing the query shows them again.
  private loadSuggestions(): Promise<Candidate[]> {
    this.emptyStateText = "Finding link suggestions…";
    this.suggestions ??= this.plugin.client.suggestLinks(this.target.file.basename).then(
      (payload) => {
        this.emptyStateText = "No link suggestions. Type to search.";
        return fromSuggestions(Array.isArray(payload?.suggestions) ? payload.suggestions : []);
      },
      (error) => {
        this.emptyStateText = `IPA link suggestion failed: ${errorMessage(error)}`;
        return [];
      }
    );
    return this.suggestions;
  }

  renderSuggestion(item: Candidate, el: HTMLElement): void {
    el.addClass("ipa-search-suggestion", "ipa-add-link");
    if (item.header) el.createDiv({ cls: "ipa-add-link__group", text: item.header });
    const row = el.createDiv({ cls: "ipa-add-link__row" });
    const box = row.createEl("input", { type: "checkbox" });
    box.tabIndex = -1;
    const main = row.createDiv({ cls: "ipa-add-link__main" });
    main.createDiv({ cls: "suggestion-title", text: item.target });
    const meta = main.createDiv({ cls: "ipa-item__meta" });
    meta.createSpan({ cls: "ipa-badge ipa-badge--type", text: item.type });
    const location = locationFromPath(item.path);
    if (location) meta.createSpan({ cls: "ipa-badge", text: location });
    const badge = meta.createSpan({ cls: "ipa-badge ipa-add-link__mode", attr: { "aria-label": "Switch ref / link" } });
    badge.addEventListener("click", (event) => {
      event.stopPropagation();
      this.pick(item, true);
    });
    this.rows.set(item.target, { box, badge });
    this.syncRow(item);
    if (this.plugin.settings.showSearchScore && item.score !== undefined) {
      meta.createSpan({ cls: "ipa-badge ipa-badge--score", text: scoreLabel(item.score) });
    }
    if (item.detail) meta.createSpan({ text: item.detail });
  }

  // Picking keeps the modal open (SuggestModal would close it).
  selectSuggestion(item: Candidate, event: MouseEvent | KeyboardEvent): void {
    this.pick(item, event.shiftKey);
  }

  onChooseSuggestion(item: Candidate, event: MouseEvent | KeyboardEvent): void {
    this.pick(item, event.shiftKey);
  }

  // A plain pick toggles the row in its default mode; a switched pick picks it
  // the other way, or flips the mode of a row already picked.
  private pick(item: Candidate, switched: boolean): void {
    const current = this.picked.get(item.target);
    if (switched) {
      this.picked.set(item.target, { item, mode: flip(current?.mode ?? defaultMode(item)) });
    } else if (current) {
      this.picked.delete(item.target);
    } else {
      this.picked.set(item.target, { item, mode: defaultMode(item) });
    }
    this.syncRow(item);
    this.renderPicked();
  }

  private syncRow(item: Candidate): void {
    const row = this.rows.get(item.target);
    if (!row) return;
    const picked = this.picked.get(item.target);
    row.box.checked = Boolean(picked);
    row.badge.setText(modeLabel(picked?.mode ?? defaultMode(item)));
  }

  private renderPicked(): void {
    this.pickedEl.empty();
    if (!this.picked.size) {
      this.pickedEl.setText("Nothing picked yet.");
      return;
    }
    this.pickedEl.createSpan({ text: `Picked ${this.picked.size}: ` });
    this.pickedEl.createSpan({
      cls: "ipa-add-link__picked-names",
      text: [...this.picked.values()].map(({ item, mode }) => `${item.target} (${mode})`).join(", ")
    });
  }

  private async apply(): Promise<void> {
    const picked = [...this.picked.values()];
    if (!picked.length) {
      new Notice("IPA: pick links with ↵ first.");
      return;
    }
    this.close();
    const parents = picked.filter((entry) => entry.mode === "ref").map((entry) => entry.item.target);
    const notes = picked.filter((entry) => entry.mode === "link").map((entry) => entry.item.target);
    try {
      // Body links go through the editor (one undo step) and are saved before
      // processFrontMatter rewrites the file, so neither edit drops the other.
      const body = insertBodyLinks(this.target.editor, notes);
      if (parents.length) {
        await this.target.view?.save();
        await this.app.fileManager.processFrontMatter(this.target.file, (frontmatter) => {
          frontmatter[this.target.refsKey] = withRefs(frontmatter[this.target.refsKey], parents);
        });
      }
      const parts = [
        parents.length ? `${parents.length} ref(s)` : "",
        body.wrapped ? `${body.wrapped} mention(s) linked` : "",
        body.inserted ? `${body.inserted} link(s) at the cursor` : "",
        body.skipped ? `${body.skipped} already linked` : ""
      ].filter(Boolean);
      new Notice(`IPA: ${parts.join(", ")}.`);
    } catch (error) {
      new Notice(`IPA add link failed: ${errorMessage(error)}`);
    }
  }
}

function linkName(value: unknown): string {
  return String(value ?? "").trim().replace(/^\[\[/, "").replace(/\]\]$/, "").split(/[|#]/)[0].trim().normalize("NFC");
}

// The ref list with each parent appended once, as "[[Title]]" like the CLI writes it.
export function withRefs(current: unknown, parents: string[]): string[] {
  const list = (Array.isArray(current) ? current : current === undefined || current === null || current === "" ? [] : [current])
    .map((value) => String(value));
  const known = new Set(list.map(linkName));
  for (const parent of parents) {
    if (known.has(parent.normalize("NFC"))) continue;
    list.push(`[[${parent}]]`);
    known.add(parent.normalize("NFC"));
  }
  return list;
}

// First occurrence of `title` in the body that is not already inside [[ ]].
export function firstPlainMention(text: string, title: string, from: number): number {
  for (let at = text.indexOf(title, from); at >= 0; at = text.indexOf(title, at + 1)) {
    if (text.lastIndexOf("[[", at) > text.lastIndexOf("]]", at)) continue;
    return at;
  }
  return -1;
}

function insertBodyLinks(editor: Editor, targets: string[]): { wrapped: number; inserted: number; skipped: number } {
  const text = editor.getValue();
  const bodyStart = FRONTMATTER_RE.exec(text)?.[0].length ?? 0;
  const ranges: Array<{ from: number; to: number; target: string }> = [];
  const atCursor: string[] = [];
  let skipped = 0;
  for (const target of targets) {
    if (["]]", "|", "#"].some((end) => text.includes(`[[${target}${end}`))) {
      skipped += 1;
      continue;
    }
    const at = firstPlainMention(text, target, bodyStart);
    if (at >= 0 && !ranges.some((range) => at < range.to && at + target.length > range.from)) {
      ranges.push({ from: at, to: at + target.length, target });
    } else {
      atCursor.push(`[[${target}]]`);
    }
  }
  const changes: EditorChange[] = ranges.map((range) => ({
    from: editor.offsetToPos(range.from),
    to: editor.offsetToPos(range.to),
    text: `[[${range.target}]]`
  }));
  if (atCursor.length) {
    // A cursor inside a mention being wrapped moves to the end of that mention.
    let offset = editor.posToOffset(editor.getCursor());
    offset = ranges.find((range) => offset > range.from && offset < range.to)?.to ?? offset;
    const before = offset > 0 ? text[offset - 1] : "";
    changes.push({ from: editor.offsetToPos(offset), text: `${before && !/\s/.test(before) ? " " : ""}${atCursor.join(", ")}` });
  }
  if (changes.length) editor.transaction({ changes });
  return { wrapped: ranges.length, inserted: atCursor.length, skipped };
}

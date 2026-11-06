import { Keymap, WorkspaceLeaf, setIcon } from "obsidian";
import { BaseIpaView } from "./BaseIpaView";
import { VIEW_TYPE_TRAVERSAL } from "../util/constants";
import type IpaPlugin from "../main";

const REFRESH_DEBOUNCE_MS = 200;
// Two hops of data: the direct neighbours are shown, the second hop starts
// folded under each neighbour. Following a name re-centres on that note.
const GRAPH_DEPTH = 2;
const GRAPH_MAX_NODES = 300;
const SHOWN_PER_LIST = 8;

interface Relation {
  kind: string; // "ref" | "link"
  direction: string; // "out" | "in"
}

interface GraphNode {
  id: string;
  type?: string;
  distance: number;
  parent: string | null;
  relations: Relation[];
}

interface CrossEdge {
  from: string;
  to: string;
  relations: Relation[];
}

interface Graph {
  center: string;
  nodes: GraphNode[];
  cross_edges?: CrossEdge[];
  truncated_nodes?: number;
}

type Entry = { node: GraphNode; relations: Relation[]; cross: boolean };

// Parents (ref →) first, then children (ref ←), then plain links.
const RELATION_RANK: Record<string, number> = { "ref:out": 0, "ref:in": 1, "link:out": 2, "link:in": 3 };
const TYPE_RANK: Record<string, number> = { root: 0, index: 1 };

function relationRank(relations: Relation[]): number {
  return Math.min(4, ...relations.map((r) => RELATION_RANK[`${r.kind}:${r.direction}`] ?? 4));
}

// Same wording as `ipa graph`: "ref →", "link ←", "ref → · link ↔".
function relationLabel(relations: Relation[]): string {
  const kinds = [...new Set(relations.map((r) => r.kind))];
  return kinds
    .map((kind) => {
      const directions = new Set(relations.filter((r) => r.kind === kind).map((r) => r.direction));
      const arrow = directions.has("out") && directions.has("in") ? "↔" : directions.has("out") ? "→" : "←";
      return `${kind} ${arrow}`;
    })
    .join(" · ");
}

// The note's neighbourhood as a tree, the way `ipa graph` prints it: each row
// is a relation and a clickable note, and a neighbour's own neighbours unfold
// under it.
export class TraversalView extends BaseIpaView {
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

  async refresh(force = false): Promise<void> {
    const path = this.adapter.getActiveNotePath();
    if (!path) {
      if (force) {
        this.notePath = null;
        this.showEmpty(this.bodyEl, "Open a note to see its IPA graph.");
      }
      return;
    }
    if (!force && path === this.notePath) return;
    if (!this.adapter.hasFileSystemAccess()) {
      this.showError(this.bodyEl, "IPA requires a desktop vault backed by the file system.");
      return;
    }
    this.notePath = path;
    const title = this.adapter.getActiveNoteTitle() ?? "";
    if (!(await this.client.isManagedPath(path))) {
      if (this.notePath !== path) return;
      this.showEmpty(this.bodyEl, "Not an IPA-managed note (excluded from indexing).");
      return;
    }
    try {
      const graph = (await this.client.graph(title, GRAPH_DEPTH, GRAPH_MAX_NODES)) as Graph;
      if (this.notePath !== path) return;
      this.render(graph);
    } catch (error) {
      if (this.notePath !== path) return;
      this.showError(this.bodyEl, error);
    }
  }

  private render(graph: Graph): void {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const entries = new Map<string, Entry[]>();
    const push = (parent: string, entry: Entry) => {
      const list = entries.get(parent) ?? [];
      list.push(entry);
      entries.set(parent, list);
    };
    for (const node of graph.nodes) {
      if (node.parent) push(node.parent, { node, relations: node.relations, cross: false });
    }
    for (const edge of graph.cross_edges ?? []) {
      const node = byId.get(edge.to);
      if (node) push(edge.from, { node, relations: edge.relations, cross: true });
    }
    for (const list of entries.values()) {
      list.sort(
        (a, b) =>
          Number(a.cross) - Number(b.cross) ||
          relationRank(a.relations) - relationRank(b.relations) ||
          (TYPE_RANK[a.node.type ?? ""] ?? 2) - (TYPE_RANK[b.node.type ?? ""] ?? 2) ||
          a.node.id.localeCompare(b.node.id)
      );
    }

    this.bodyEl.empty();
    const tree = this.bodyEl.createDiv({ cls: "ipa-graph" });
    const center = byId.get(graph.center);
    const head = tree.createDiv({ cls: "ipa-graph__row ipa-graph__row--center" });
    head.createSpan({ cls: "ipa-graph__mark", text: "◎" });
    head.createSpan({ cls: "ipa-graph__name", text: graph.center });
    if (center?.type) head.createSpan({ cls: "ipa-graph__type", text: center.type });

    const neighbours = entries.get(graph.center) ?? [];
    if (neighbours.length === 0) {
      tree.createDiv({ cls: "ipa-empty", text: "No refs or links." });
      return;
    }
    this.renderList(tree, neighbours, entries);
    if ((graph.truncated_nodes ?? 0) > 0) {
      tree.createDiv({ cls: "ipa-item__meta", text: `… ${graph.truncated_nodes} more notes not loaded` });
    }
  }

  private renderList(container: HTMLElement, list: Entry[], entries: Map<string, Entry[]>): void {
    const ul = container.createEl("ul", { cls: "ipa-graph__list" });
    const renderSlice = (slice: Entry[]) => slice.forEach((entry) => this.renderEntry(ul, entry, entries));
    renderSlice(list.slice(0, SHOWN_PER_LIST));
    if (list.length > SHOWN_PER_LIST) {
      const more = ul.createEl("li").createEl("a", { cls: "ipa-more", text: `Show ${list.length - SHOWN_PER_LIST} more` });
      more.addEventListener("click", () => {
        more.parentElement?.remove();
        renderSlice(list.slice(SHOWN_PER_LIST));
      });
    }
  }

  private renderEntry(ul: HTMLElement, entry: Entry, entries: Map<string, Entry[]>): void {
    const li = ul.createEl("li");
    const row = li.createDiv({ cls: "ipa-graph__row" });
    if (entry.cross) row.addClass("is-cross");
    row.createSpan({ cls: "ipa-graph__rel", text: relationLabel(entry.relations) });
    const name = row.createSpan({ cls: "ipa-graph__name is-link", text: entry.node.id });
    name.addEventListener("click", (event) => void this.adapter.open(null, entry.node.id, Keymap.isModEvent(event)));
    if (entry.node.type && entry.node.type !== "note") row.createSpan({ cls: "ipa-graph__type", text: entry.node.type });

    // A cross edge points at a note already shown elsewhere in the tree.
    if (entry.cross) {
      row.createSpan({ cls: "ipa-graph__type", text: "↩" });
      return;
    }
    const children = entries.get(entry.node.id) ?? [];
    if (children.length === 0) return;
    // Obsidian's chevron icon, not a ▸ glyph: UI fonts often lack the glyph.
    const toggle = row.createSpan({ cls: "ipa-graph__toggle", attr: { "aria-label": "Show neighbours" } });
    const icon = toggle.createSpan({ cls: "ipa-graph__chevron" });
    toggle.createSpan({ text: String(children.length) });
    setIcon(icon, "chevron-right");
    let body: HTMLElement | null = null;
    toggle.addEventListener("click", () => {
      if (body) {
        body.remove();
        body = null;
      } else {
        body = li.createDiv();
        this.renderList(body, children, entries);
      }
      setIcon(icon, body ? "chevron-down" : "chevron-right");
    });
  }
}

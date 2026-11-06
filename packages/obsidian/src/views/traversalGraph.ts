// Shapes returned by core graphTopology, plus the picture form of the traversal
// view: the note's IPA neighbourhood laid out by meaning, not by force.
//
//   grandparents          (ref → of a parent)
//   parents               (ref →)
//   link ←  ◎ note  link →
//   children rows         (ref ←)
//
// Labels are HTML (so Korean titles get CSS ellipsis per slot) over an SVG edge
// layer. The layout is deterministic: the same note always draws the same way.

export interface Relation {
  kind: string; // "ref" | "link"
  direction: string; // "out" | "in"
}

export interface GraphNode {
  id: string;
  type?: string;
  distance: number;
  parent: string | null;
  relations: Relation[];
}

export interface Graph {
  center: string;
  nodes: GraphNode[];
  cross_edges?: Array<{ from: string; to: string; relations: Relation[] }>;
  truncated_nodes?: number;
}

export interface PictureOptions {
  width: number;
  // Draw every neighbour instead of folding long groups into a "+N" chip.
  showAll: boolean;
  onOpen: (id: string, event: MouseEvent) => void;
  onShowAll: () => void;
}

const has = (relations: Relation[], kind: string, direction: string) =>
  relations.some((r) => r.kind === kind && r.direction === direction);

const TYPE_RANK: Record<string, number> = { root: 0, index: 1 };
const byTypeThenName = (a: GraphNode, b: GraphNode) =>
  (TYPE_RANK[a.type ?? ""] ?? 2) - (TYPE_RANK[b.type ?? ""] ?? 2) || a.id.localeCompare(b.id);

const ROW_GAP = 68;
const TOP = 18;
const SIDE_MAX = 5; // link neighbours per side before "+N"
const CHILD_ROWS = 3; // child rows before "+N"
const SLOT_MIN = 84; // narrowest label slot in a child row

interface Placed {
  id: string;
  type: string;
  x: number;
  y: number;
  slot: number;
  center?: boolean;
}

interface Edge {
  from: Placed;
  to: Placed;
  kind: "ref" | "link";
  vertical: boolean;
}

export function renderTraversalPicture(container: HTMLElement, graph: Graph, options: PictureOptions): void {
  const W = Math.max(240, options.width);
  const center = graph.nodes.find((n) => n.id === graph.center);
  const near = graph.nodes.filter((n) => n.parent === graph.center);

  // Classify by the relation to the centre; a ref relation wins over a link.
  const parents = near.filter((n) => has(n.relations, "ref", "out")).sort(byTypeThenName);
  const children = near
    .filter((n) => !parents.includes(n) && has(n.relations, "ref", "in"))
    .sort(byTypeThenName);
  const linkOut = near
    .filter((n) => !parents.includes(n) && !children.includes(n) && has(n.relations, "link", "out"))
    .sort(byTypeThenName);
  const linkIn = near
    .filter((n) => !parents.includes(n) && !children.includes(n) && !linkOut.includes(n))
    .sort(byTypeThenName);
  const parentIds = new Set(parents.map((p) => p.id));
  const grandparents = graph.nodes
    .filter((n) => n.distance === 2 && n.parent && parentIds.has(n.parent) && has(n.relations, "ref", "out"))
    .sort(byTypeThenName);

  const placed: Placed[] = [];
  const edges: Edge[] = [];
  // Edges to highlight when a node is hovered, when it is not simply the edges
  // touching it (grouped children share the group's edge).
  const edgeOwners = new Map<string, Edge[]>();
  const at = new Map<string, Placed>();
  const place = (node: GraphNode | null, id: string, type: string, x: number, y: number, slot: number) => {
    const p: Placed = { id, type, x, y, slot };
    placed.push(p);
    if (node) at.set(node.id, p);
    return p;
  };
  // Edges: ref edges run vertically (parents above, children below), link
  // edges run sideways and are dashed.
  const link = (from: Placed | undefined, to: Placed | undefined, kind: "ref" | "link", vertical: boolean) => {
    if (from && to) edges.push({ from, to, kind, vertical });
  };
  // A row of n nodes centred on the pane, each with a label slot of `slot` px.
  const rowXs = (n: number, slot: number) => Array.from({ length: n }, (_, i) => W / 2 + (i - (n - 1) / 2) * slot);

  let y = TOP;
  const upperSlot = (n: number) => Math.min(150, (W - 16) / Math.max(1, n));
  if (grandparents.length) {
    const slot = upperSlot(grandparents.length);
    rowXs(grandparents.length, slot).forEach((x, i) => place(grandparents[i], grandparents[i].id, grandparents[i].type ?? "note", x, y, slot));
    y += ROW_GAP;
  }
  if (parents.length) {
    const slot = upperSlot(parents.length);
    rowXs(parents.length, slot).forEach((x, i) => place(parents[i], parents[i].id, parents[i].type ?? "note", x, y, slot));
    y += ROW_GAP;
  }

  // Centre row, with link neighbours stacked in side columns.
  const side = (list: GraphNode[]) =>
    options.showAll || list.length <= SIDE_MAX ? list : list.slice(0, SIDE_MAX - 1);
  const leftShown = side(linkIn);
  const rightShown = side(linkOut);
  const sideCount = Math.max(
    leftShown.length + (linkIn.length > leftShown.length ? 1 : 0),
    rightShown.length + (linkOut.length > rightShown.length ? 1 : 0)
  );
  const sideStep = 40;
  const sideHalf = ((sideCount - 1) / 2) * sideStep;
  const centerY = y + Math.max(0, sideHalf - ROW_GAP / 2 + 20);
  const me = place(center ?? null, graph.center, center?.type ?? "note", W / 2, centerY, Math.min(220, W * 0.42));
  me.center = true;
  const sideSlot = Math.min(150, W * 0.27);
  const column = (list: GraphNode[], total: number, x: number) => {
    const count = list.length + (total > list.length ? 1 : 0);
    const ys = Array.from({ length: count }, (_, i) => centerY + (i - (count - 1) / 2) * sideStep);
    list.forEach((n, i) => link(me, place(n, n.id, n.type ?? "note", x, ys[i], sideSlot), "link", false));
    if (total > list.length) link(me, place(null, `+${total - list.length}`, "more", x, ys[count - 1], sideSlot), "link", false);
  };
  column(leftShown, linkIn.length, W * 0.15);
  column(rightShown, linkOut.length, W * 0.85);

  // Children in rows under the centre. One row fans out from the centre; more
  // rows sit in a group box joined by a single edge, because per-child edges
  // would run through the rows above and read as chains.
  let bottom = centerY;
  let group: { x: number; y: number; w: number; h: number; count: number } | null = null;
  if (children.length) {
    const perRow = Math.max(2, Math.min(8, Math.floor((W - 16) / SLOT_MIN)));
    const limit = options.showAll ? children.length : perRow * CHILD_ROWS;
    const shown = children.length > limit ? children.slice(0, limit - 1) : children;
    const items: Array<GraphNode | null> = [...shown];
    if (children.length > shown.length) items.push(null); // "+N"
    const grouped = items.length > perRow;
    const top = Math.max(centerY + ROW_GAP, centerY + sideHalf + 44) + (grouped ? 22 : 0);
    const slot = (W - 16) / perRow;
    const kids: Placed[] = [];
    for (let r = 0; r * perRow < items.length; r++) {
      const row = items.slice(r * perRow, (r + 1) * perRow);
      const rowY = top + r * 56;
      rowXs(row.length, slot).forEach((x, i) => {
        const n = row[i];
        kids.push(n ? place(n, n.id, n.type ?? "note", x, rowY, slot) : place(null, `+${children.length - shown.length}`, "more", x, rowY, slot));
      });
      bottom = rowY;
    }
    if (grouped) {
      group = { x: 8, y: top - 26, w: W - 16, h: bottom - top + 58, count: children.length };
      // A virtual end point on the box edge; every child shares this one edge.
      const port: Placed = { id: "", type: "port", x: W / 2, y: group.y, slot: 0 };
      link(me, port, "ref", true);
      const shared = edges[edges.length - 1];
      for (const k of kids) edgeOwners.set(k.id, [shared]);
      bottom += 14;
    } else {
      for (const k of kids) link(me, k, "ref", true);
    }
  }
  bottom = Math.max(bottom, centerY + sideHalf);

  // Ancestors are linked once both rows exist.
  for (const g of grandparents) link(at.get(g.parent ?? ""), at.get(g.id), "ref", true);
  for (const p of parents) link(me, at.get(p.id), "ref", true);

  // ── DOM ──
  container.empty();
  const height = bottom + 44;
  const root = container.createDiv({ cls: "ipa-picture" });
  root.style.height = `${height}px`;
  const svg = root.createSvg("svg", { cls: "ipa-picture__edges", attr: { width: String(W), height: String(height) } });
  if (group) {
    const box = root.createDiv({ cls: "ipa-picture__group" });
    box.style.left = `${group.x}px`;
    box.style.top = `${group.y}px`;
    box.style.width = `${group.w}px`;
    box.style.height = `${group.h}px`;
    box.createSpan({ cls: "ipa-picture__group-label", text: `ref ← ${group.count}` });
  }
  const edgeEls = new Map<string, SVGElement[]>();
  const elOf = new Map<Edge, SVGElement>();
  for (const e of edges) {
    const { from: a, to: b } = e;
    const d = e.vertical
      ? `M${a.x},${a.y} C${a.x},${(a.y + b.y) / 2} ${b.x},${(a.y + b.y) / 2} ${b.x},${b.y}`
      : `M${a.x},${a.y} C${(a.x + b.x) / 2},${a.y} ${(a.x + b.x) / 2},${b.y} ${b.x},${b.y}`;
    // SVG elements take classes one token at a time (classList.add), so pass an array.
    const path = svg.createSvg("path", { cls: ["ipa-picture__edge", `is-${e.kind}`], attr: { d } });
    elOf.set(e, path);
    for (const end of [a.id, b.id]) {
      const list = edgeEls.get(end) ?? [];
      list.push(path);
      edgeEls.set(end, list);
    }
  }
  for (const [id, owned] of edgeOwners) {
    edgeEls.set(id, owned.map((e) => elOf.get(e)).filter((el): el is SVGElement => !!el));
  }
  for (const p of placed) {
    const node = root.createDiv({ cls: `ipa-picture__node is-${p.type}${p.center ? " is-center" : ""}` });
    node.style.left = `${p.x}px`;
    node.style.top = `${p.y}px`;
    node.style.setProperty("--slot", `${Math.max(40, p.slot - 6)}px`);
    node.createSpan({ cls: "ipa-picture__dot" });
    node.createSpan({ cls: "ipa-picture__label", text: p.id });
    node.setAttr("aria-label", p.type === "more" ? "Show all" : p.id);
    const hot = (on: boolean) => (edgeEls.get(p.id) ?? []).forEach((el) => el.classList.toggle("is-hot", on));
    node.addEventListener("mouseenter", () => hot(true));
    node.addEventListener("mouseleave", () => hot(false));
    if (p.center) continue;
    node.addEventListener("click", (event) => {
      if (p.type === "more") options.onShowAll();
      else options.onOpen(p.id, event);
    });
  }
}

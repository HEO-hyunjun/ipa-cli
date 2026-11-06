import { locationFromPath, refLabel, scoreLabel } from "../util/format";

// One search result as core returns it; shared by the search panel and modal.
export interface SearchHit {
  note?: string;
  path?: string;
  type?: string;
  refs?: unknown[];
  score?: number;
}

// The badge line under a result title: type, location, score, refs.
export function renderHitMeta(container: HTMLElement, hit: SearchHit, showScore: boolean): void {
  if (hit.type) container.createSpan({ cls: "ipa-badge ipa-badge--type", text: String(hit.type) });
  const location = locationFromPath(hit.path);
  if (location) container.createSpan({ cls: "ipa-badge", text: location });
  if (showScore) container.createSpan({ cls: "ipa-badge ipa-badge--score", text: scoreLabel(hit.score) });
  if (Array.isArray(hit.refs) && hit.refs.length) {
    container.createSpan({ text: `→ ${hit.refs.map(refLabel).join(", ")}` });
  }
}

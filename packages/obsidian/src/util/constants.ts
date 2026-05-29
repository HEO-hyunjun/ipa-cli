// Shared identifiers for the IPA Obsidian plugin views and commands.

export const VIEW_TYPE_SEARCH = "ipa-search-view";
export const VIEW_TYPE_TRAVERSAL = "ipa-traversal-view";
export const VIEW_TYPE_VALIDATION = "ipa-validation-view";

export const ICON_ID = "library";

// up/down/siblings/root come from core traversal; backlinks is resolved from
// Obsidian's metadata cache (core has no backlinks mode).
export const TRAVERSAL_TABS = ["up", "down", "siblings", "root", "backlinks"] as const;
export type TraversalTab = (typeof TRAVERSAL_TABS)[number];

export const TRAVERSAL_TAB_LABELS: Record<TraversalTab, string> = {
  up: "Up",
  down: "Down",
  siblings: "Siblings",
  root: "Root",
  backlinks: "Backlinks"
};

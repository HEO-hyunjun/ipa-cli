export type ValidationScope = "current" | "vault";

export interface IpaSettings {
  // Apply behaviour
  // Auto-apply formatter fixes when a note is saved (note switch, close, Cmd+S).
  formatOnSave: boolean;
  autoValidateAfterApply: boolean;
  // Validation
  defaultValidationScope: ValidationScope;
  // IPA Flow
  confirmIpaFlow: boolean;
  // Vault-local plugins
  enableVaultPlugins: boolean;
  showPluginLoadErrors: boolean;
  // Search
  searchResultLimit: number;
  showSearchScore: boolean;
  // Show the ref path (root / index / note) instead of the folder path in note headers.
  showRefTrail: boolean;
  // Dot colours in the traversal picture by note type; "" keeps the theme colour.
  graphColors: GraphColors;
}

export type GraphNoteType = "root" | "index" | "note";
export type GraphColors = Record<GraphNoteType, string>;

export const DEFAULT_SETTINGS: IpaSettings = {
  formatOnSave: false,
  autoValidateAfterApply: true,
  defaultValidationScope: "current",
  confirmIpaFlow: true,
  enableVaultPlugins: true,
  showPluginLoadErrors: true,
  searchResultLimit: 25,
  showSearchScore: true,
  showRefTrail: true,
  graphColors: { root: "", index: "", note: "" }
};

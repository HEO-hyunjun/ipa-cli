import type { TraversalTab } from "../util/constants";

export type ValidationScope = "current" | "vault";

export interface IpaSettings {
  // Apply behaviour
  saveOnApply: boolean;
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
  // Traversal
  defaultTraversalTab: TraversalTab;
}

export const DEFAULT_SETTINGS: IpaSettings = {
  saveOnApply: true,
  autoValidateAfterApply: true,
  defaultValidationScope: "current",
  confirmIpaFlow: true,
  enableVaultPlugins: true,
  showPluginLoadErrors: true,
  searchResultLimit: 25,
  showSearchScore: true,
  defaultTraversalTab: "up"
};

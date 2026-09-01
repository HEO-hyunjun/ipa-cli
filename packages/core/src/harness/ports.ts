// Harness provider port.
//
// The project intentionally ships JavaScript-compatible TypeScript sources,
// so this contract is expressed with JSDoc instead of runtime-invalid type
// annotations. Provider adapters own every harness detail that varies by
// agent: locations, supported components, hook registration, generated hook
// output schemas, and manifest display paths.

/**
 * @typedef {Object} HarnessHookRegistration
 * @property {string} event
 * @property {string|null} matcher
 * @property {string|null} statusMessage
 * @property {number|null} timeout
 */

/**
 * @typedef {Object} HarnessProviderAdapter
 * @property {string} id
 * @property {string} displayName
 * @property {string} skillDisplayPath
 * @property {string} hooksConfigDisplayPath
 * @property {string} promptDisplayPath
 * @property {string} localSkillsRoot
 * @property {string[]} validComponents
 * @property {string[]} defaultComponents
 * @property {boolean} usesPlugin
 * @property {(homeBase: string) => object} targetSpec
 * @property {(selected: string[]) => string[]} completeSelection
 * @property {(component: string) => HarnessHookRegistration|null} hookRegistration
 * @property {(component: string) => string|null} pluginMarker
 * @property {(config: object) => void} applyPermissions
 * @property {(config: object) => void} removePermissions
 * @property {(config: object) => boolean} permissionPresent
 * @property {(spec: object) => object} manifestGlobal
 * @property {(messageExpression: string) => string} userPromptOutput
 * @property {(messageExpression: string) => string} stopBlockOutput
 * @property {(messageExpression: string) => string} stopNoticeOutput
 */

const REQUIRED_METHODS = [
  "targetSpec",
  "completeSelection",
  "hookRegistration",
  "pluginMarker",
  "applyPermissions",
  "removePermissions",
  "permissionPresent",
  "manifestGlobal",
  "userPromptOutput",
  "stopBlockOutput",
  "stopNoticeOutput"
];

export function assertHarnessProviderAdapter(adapter) {
  if (!adapter || typeof adapter !== "object" || !adapter.id) {
    throw new Error("invalid harness provider adapter: id is required");
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new Error(`invalid harness provider adapter ${adapter.id}: ${method} must be a function`);
    }
  }
  if (!Array.isArray(adapter.validComponents) || !Array.isArray(adapter.defaultComponents)) {
    throw new Error(`invalid harness provider adapter ${adapter.id}: component lists are required`);
  }
  return adapter;
}

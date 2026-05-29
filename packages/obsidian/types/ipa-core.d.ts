// Ambient declarations for the workspace packages consumed by the Obsidian plugin.
// @ipa/core ships as plain ESM JavaScript without type definitions, so these
// declarations exist purely for editor ergonomics. esbuild strips types at build
// time and does not type-check, so parameter shapes are authoritative while return
// types are intentionally loose (the runtime shapes are validated where consumed).

declare module "@ipa/core" {
  // Config / settings
  export function readVaultConfig(vaultPath: string): Promise<any>;
  export function normalizeMapping(config?: Record<string, unknown>): any;
  export function resolveSettings(options?: Record<string, unknown>): Promise<any>;

  // Notes / graph
  export function loadNotes(vaultPath: string, mapping?: any): Promise<any[]>;
  export function indexNotes(notes: any[]): any;
  export function buildGraph(notes: any[]): any;
  export function findNote(notes: any[], noteName: string): any;
  export function resolveNote(vaultPath: string, noteName: string): Promise<any>;

  // Read surfaces
  export function searchVault(
    vaultPath: string,
    query: string,
    options?: Record<string, unknown>
  ): Promise<any>;
  export function prepareSearchContext(vaultPath: string, notes?: any[] | null): Promise<any>;
  export function searchWithContext(context: any, query: string, options?: Record<string, unknown>): Promise<any>;
  export function viewNote(
    vaultPath: string,
    noteName: string,
    options?: Record<string, unknown>
  ): Promise<any>;
  export function traversal(vaultPath: string, mode: string, noteName: string): Promise<any>;
  export function traversalAll(vaultPath: string, noteName: string, notes?: any[] | null): Promise<any>;
  export function loadNotes(vaultPath: string, mapping?: any): Promise<any[]>;
  export function loadNotesForView(vaultPath: string, mapping?: any): Promise<any[]>;
  export function suggestLinks(vaultPath: string, noteName?: string | null): Promise<any>;

  // Validation / format
  export function validateVault(vaultPath: string, notes?: any[] | null): Promise<any>;
  export function formatVault(
    vaultPath: string,
    apply?: boolean,
    options?: Record<string, unknown>
  ): Promise<any>;

  // Write surfaces
  export function moveNote(
    vaultPath: string,
    noteName: string,
    targetFolder: string,
    apply?: boolean
  ): Promise<any>;
  export function renameNote(
    vaultPath: string,
    oldName: string,
    newName: string,
    apply?: boolean
  ): Promise<any>;
  export function replaceInNote(
    vaultPath: string,
    noteName: string,
    oldText: string,
    newText: string,
    options?: Record<string, unknown>
  ): Promise<any>;
  export function rewriteNote(
    vaultPath: string,
    noteName: string,
    rewrite: (body: string) => string,
    options?: Record<string, unknown>
  ): Promise<any>;
  export function refactorVault(
    vaultPath: string,
    command: string,
    args: string[],
    options?: Record<string, unknown>
  ): Promise<any>;

  // Cache
  export function rebuildCache(vaultPath: string, options?: Record<string, unknown>): Promise<any>;
  export function cacheStatus(vaultPath: string): Promise<any>;
  export function cacheDoctor(vaultPath: string): Promise<any>;
  export function cacheClean(vaultPath: string): Promise<any>;
  export function cacheInspect(vaultPath: string, noteName: string): Promise<any>;

  // Plugins / rules
  export function listPlugins(vaultPath: string): Promise<any>;
  export function listRules(vaultPath: string): Promise<any>;
  export function listSearchChannels(vaultPath: string): Promise<any>;
  export function pluginDoctor(vaultPath: string): Promise<any>;
  export function pluginInit(vaultPath: string, options?: Record<string, unknown>): Promise<any>;
  export function validatePlugin(path: string, kind?: string | null): Promise<any>;

  // Constants
  export const DEFAULT_MAPPING: Record<string, string>;
  export const CHANNELS: string[];
  export const RULES: string[];
  export const REFACTORS: string[];
}

declare module "@ipa/builtin-rules" {
  export const channels: string[];
  export const conventionRules: string[];
  export const refactors: string[];
}

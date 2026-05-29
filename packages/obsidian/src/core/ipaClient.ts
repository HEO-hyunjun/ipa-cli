import * as core from "@ipa/core";

// Thin wrapper around @ipa/core. Every core entry point takes the vault's
// absolute path as its first argument; on Obsidian desktop (Electron) the core
// Node fs/path logic runs unchanged. This class injects the resolved vault path
// so the views never touch the path themselves.
export class IpaClient {
  constructor(private readonly resolveVaultPath: () => string) {}

  private get vault(): string {
    return this.resolveVaultPath();
  }

  // Parsed notes are cached in memory so repeated traversals reuse a single
  // load instead of re-parsing the whole vault each call. Invalidated on vault
  // changes (wired in main.ts).
  private notesCache: any[] | null = null;
  private searchContext: any = null;

  async loadNotesCached(): Promise<any[]> {
    if (!this.notesCache) {
      const { mapping } = await core.readVaultConfig(this.vault);
      // loadNotesForView reuses the .ipa/cache summary (refs/type/links) like the
      // CLI — no full vault re-parse when the cache is fresh.
      this.notesCache = await core.loadNotesForView(this.vault, mapping);
    }
    return this.notesCache;
  }

  invalidateNotes(): void {
    this.notesCache = null;
    this.searchContext = null;
  }

  // Read surfaces
  search(query: string, options: Record<string, unknown> = {}): Promise<any> {
    return core.searchVault(this.vault, query, options);
  }

  // Reuses one prepared search context (notes + prepared channels) across
  // queries so only per-query scoring runs after the first search.
  async searchCached(query: string, options: Record<string, unknown> = {}): Promise<any> {
    if (!this.searchContext) {
      // search scores note bodies, which the cache summary omits, so prepare
      // loads full notes once; later queries reuse this context.
      this.searchContext = await core.prepareSearchContext(this.vault);
    }
    return core.searchWithContext(this.searchContext, query, options);
  }

  // Build the search context ahead of the first query (called in the background).
  async warmSearch(): Promise<void> {
    if (this.searchContext) return;
    try {
      this.searchContext = await core.prepareSearchContext(this.vault);
    } catch {
      // ignore warm-up failures; the next real search surfaces any error
    }
  }

  view(note: string, options: Record<string, unknown> = {}): Promise<any> {
    return core.viewNote(this.vault, note, options);
  }

  traversal(mode: string, note: string): Promise<any> {
    return core.traversal(this.vault, mode, note);
  }

  async traversalAll(note: string): Promise<any> {
    return core.traversalAll(this.vault, note, await this.loadNotesCached());
  }

  suggestLinks(note: string): Promise<any> {
    return core.suggestLinks(this.vault, note);
  }

  // Validation / format
  validate(): Promise<any> {
    return core.validateVault(this.vault);
  }

  // Plan only. Applying patches goes through Obsidian's Vault API (see
  // core/applyFixes.ts) so the editor and cache stay in sync — never via
  // core.formatVault(apply=true), which writes with Node fs and bypasses Obsidian.
  formatPlan(notes?: string[]): Promise<any> {
    return core.formatVault(this.vault, false, notes ? { notes } : {});
  }

  // IPA Flow / write
  move(note: string, target: string, apply: boolean): Promise<any> {
    return core.moveNote(this.vault, note, target, apply);
  }

  rename(oldName: string, newName: string, apply: boolean): Promise<any> {
    return core.renameNote(this.vault, oldName, newName, apply);
  }

  // Cache
  cacheStatus(): Promise<any> {
    return core.cacheStatus(this.vault);
  }

  rebuildCache(): Promise<any> {
    return core.rebuildCache(this.vault);
  }

  cacheInspect(note: string): Promise<any> {
    return core.cacheInspect(this.vault, note);
  }

  cacheDoctor(): Promise<any> {
    return core.cacheDoctor(this.vault);
  }

  // Plugins / rules / config
  listPlugins(): Promise<any> {
    return core.listPlugins(this.vault);
  }

  listRules(): Promise<any> {
    return core.listRules(this.vault);
  }

  listSearchChannels(): Promise<any> {
    return core.listSearchChannels(this.vault);
  }

  pluginDoctor(): Promise<any> {
    return core.pluginDoctor(this.vault);
  }

  readConfig(): Promise<any> {
    return core.readVaultConfig(this.vault);
  }
}

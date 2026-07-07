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
  private fullNotesCache: any[] | null = null;
  private searchContext: any = null;
  private validationCache: any = null;

  async loadNotesCached(): Promise<any[]> {
    if (!this.notesCache) {
      const { mapping } = await core.readVaultConfig(this.vault);
      // loadNotesForView reuses the .ipa/cache summary (refs/type/links) like the
      // CLI — no full vault re-parse when the cache is fresh.
      this.notesCache = await core.loadNotesForView(this.vault, mapping);
    }
    return this.notesCache;
  }

  // Full notes (with body + frontmatter) loaded once and shared by validation,
  // format, and search — the surfaces that need note bodies, which the summary
  // cache (loadNotesForView) omits. Without this, one Validate re-parsed the
  // whole vault up to three times (validateVault + formatVault + formatVault's
  // inner validateVault).
  async loadFullNotesCached(): Promise<any[]> {
    if (!this.fullNotesCache) {
      const { mapping } = await core.readVaultConfig(this.vault);
      this.fullNotesCache = await core.loadNotes(this.vault, mapping);
    }
    return this.fullNotesCache;
  }

  // A path outside the indexed note set (mapping exclude) is not IPA-managed;
  // callers skip IPA surfaces for it instead of surfacing "note not found".
  // core note paths (relPath) are posix + possibly NFD (macOS fs); Obsidian's
  // active path is NFC, so normalize both sides before comparing.
  async isManagedPath(path: string): Promise<boolean> {
    const target = path.normalize("NFC");
    const notes = await this.loadNotesCached();
    return notes.some((note) => String(note?.relPath ?? "").normalize("NFC") === target);
  }

  invalidateNotes(): void {
    this.notesCache = null;
    this.fullNotesCache = null;
    this.searchContext = null;
    this.validationCache = null;
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
      // reuses the shared full-note load; later queries reuse this context.
      this.searchContext = await core.prepareSearchContext(this.vault, await this.loadFullNotesCached());
    }
    return core.searchWithContext(this.searchContext, query, options);
  }

  // Build the search context ahead of the first query (called in the background).
  async warmSearch(): Promise<void> {
    if (this.searchContext) return;
    try {
      this.searchContext = await core.prepareSearchContext(this.vault, await this.loadFullNotesCached());
    } catch {
      // ignore warm-up failures; the next real search surfaces any error
    }
  }

  // Read paths reuse the in-memory caches so a per-click view/traversal never
  // re-parses the whole vault (the target note body is still read fresh).
  async view(note: string, options: Record<string, unknown> = {}): Promise<any> {
    return core.viewNote(this.vault, note, { ...options, notes: await this.loadNotesCached() });
  }

  async traversal(mode: string, note: string): Promise<any> {
    return core.traversal(this.vault, mode, note, { notes: await this.loadNotesCached() });
  }

  async traversalAll(note: string): Promise<any> {
    return core.traversalAll(this.vault, note, await this.loadNotesCached());
  }

  // Link suggestions score against the search context; reusing the cached one
  // avoids rebuilding the whole context (the dominant cost) per suggestion.
  async suggestLinks(note: string): Promise<any> {
    if (!this.searchContext) {
      this.searchContext = await core.prepareSearchContext(this.vault, await this.loadFullNotesCached());
    }
    return core.suggestLinks(this.vault, note, { context: this.searchContext });
  }

  // Validation / format. Both reuse the cached full-note load, so a Validate that
  // runs validate() then formatPlan() parses the vault once instead of 3x.
  //
  // The full checkNote pass dominates cost, so validate() is also cached:
  // switching the active note re-runs validate() but doesn't change note
  // contents, so the vault-wide issue set is reused until a vault edit
  // invalidates it. That makes the common "click between notes" flow instant.
  async validate(): Promise<any> {
    if (!this.validationCache) {
      this.validationCache = await core.validateVault(this.vault, await this.loadFullNotesCached());
    }
    return this.validationCache;
  }

  // Plan only. Applying patches goes through Obsidian's Vault API (see
  // core/applyFixes.ts) so the editor and cache stay in sync — never via
  // core.formatVault(apply=true), which writes with Node fs and bypasses Obsidian.
  // patchesOnly skips formatVault's internal validateVault (a second full
  // checkNote pass) because callers here read patches, not issues.
  async formatPlan(notes?: string[]): Promise<any> {
    return core.formatVault(this.vault, false, {
      ...(notes ? { notes } : {}),
      loadedNotes: await this.loadFullNotesCached(),
      patchesOnly: true,
      // Run apply-gated rules (e.g. date_modified) at plan time: Obsidian applies
      // patches via vault.process, so fs apply stays false but rules need apply
      // context to produce their patch.
      ruleApply: true
    });
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

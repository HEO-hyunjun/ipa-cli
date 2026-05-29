import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { readFile } from "node:fs/promises";
import {
  ICON_ID,
  VIEW_TYPE_SEARCH,
  VIEW_TYPE_TRAVERSAL,
  VIEW_TYPE_VALIDATION
} from "./util/constants";
import { DEFAULT_SETTINGS, IpaSettings } from "./settings/settings";
import { IpaSettingTab } from "./settings/SettingsTab";
import { ObsidianVaultAdapter } from "./adapter/ObsidianVaultAdapter";
import { IpaClient } from "./core/ipaClient";
import { SearchView } from "./views/SearchView";
import { TraversalView } from "./views/TraversalView";
import { ValidationView } from "./views/ValidationView";
import { errorMessage } from "./util/format";
import { ConfirmModal } from "./util/ConfirmModal";
import { IpaFlow } from "./core/ipaFlow";
import { applyFixes } from "./core/applyFixes";

export default class IpaPlugin extends Plugin {
  settings!: IpaSettings;
  adapter!: ObsidianVaultAdapter;
  client!: IpaClient;
  private warmTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.adapter = new ObsidianVaultAdapter(this.app);
    this.client = new IpaClient(() => this.adapter.getVaultPath());
    this.installPluginLoader();

    // Drop the in-memory caches whenever the vault changes, then re-warm the
    // search context once edits settle.
    const onVaultChange = () => {
      this.client.invalidateNotes();
      this.scheduleSearchWarm();
    };
    this.registerEvent(this.app.vault.on("modify", onVaultChange));
    this.registerEvent(this.app.vault.on("create", onVaultChange));
    this.registerEvent(this.app.vault.on("delete", onVaultChange));
    this.registerEvent(this.app.vault.on("rename", onVaultChange));

    this.registerView(VIEW_TYPE_SEARCH, (leaf) => new SearchView(leaf, this));
    this.registerView(VIEW_TYPE_TRAVERSAL, (leaf) => new TraversalView(leaf, this));
    this.registerView(VIEW_TYPE_VALIDATION, (leaf) => new ValidationView(leaf, this));

    this.addRibbonIcon(ICON_ID, "IPA: Open search", () => {
      void this.activateView(VIEW_TYPE_SEARCH);
    });

    this.registerCommands();
    this.addSettingTab(new IpaSettingTab(this.app, this));

    // Warm the search context in the background so the first search is fast.
    this.scheduleSearchWarm(2000);
  }

  onunload(): void {
    if (this.warmTimer !== null) window.clearTimeout(this.warmTimer);
    delete (globalThis as Record<string, unknown>).__ipaImportPlugin;
  }

  // Debounced background warm-up of the search context. Edits keep rescheduling
  // it, so it only runs once the vault is idle.
  private scheduleSearchWarm(delay = 1500): void {
    if (!this.adapter.hasFileSystemAccess()) return;
    if (this.warmTimer !== null) window.clearTimeout(this.warmTimer);
    this.warmTimer = window.setTimeout(() => {
      this.warmTimer = null;
      void this.client.warmSearch();
    }, delay);
  }

  // core loads vault-local plugins with import(file://...), which the Obsidian
  // renderer rejects. Inject a loader that reads the file and imports it via a
  // blob URL (verified to work in the renderer). Honors the enableVaultPlugins
  // setting so disabling it makes core skip vault-local plugins gracefully.
  private installPluginLoader(): void {
    (globalThis as Record<string, unknown>).__ipaImportPlugin = async (absPath: string) => {
      if (!this.settings.enableVaultPlugins) {
        throw new Error("IPA: vault-local plugins are disabled in settings.");
      }
      const code = await readFile(absPath, "utf8");
      const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
      try {
        return await import(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
  }

  async activateView(type: string): Promise<WorkspaceLeaf | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(type)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return null;
      await leaf.setViewState({ type, active: true });
    }
    workspace.revealLeaf(leaf);
    return leaf;
  }

  private async revealView<T>(type: string): Promise<T | null> {
    const leaf = await this.activateView(type);
    return (leaf?.view as unknown as T) ?? null;
  }

  private guardVault(): boolean {
    if (!this.adapter.hasFileSystemAccess()) {
      new Notice("IPA requires a desktop vault backed by the file system.");
      return false;
    }
    return true;
  }

  private registerCommands(): void {
    this.addCommand({
      id: "open-search-panel",
      name: "Open search panel",
      callback: () => {
        void this.activateView(VIEW_TYPE_SEARCH);
      }
    });

    this.addCommand({
      id: "search-current-selection",
      name: "Search current selection",
      callback: async () => {
        const selection = this.adapter.getSelection().trim();
        const view = await this.revealView<SearchView>(VIEW_TYPE_SEARCH);
        if (view && selection) view.setQuery(selection, true);
      }
    });

    this.addCommand({
      id: "show-traversal",
      name: "Show traversal for current note",
      callback: () => {
        void this.activateView(VIEW_TYPE_TRAVERSAL);
      }
    });

    this.addCommand({
      id: "validate-current-note",
      name: "Validate current note",
      callback: async () => {
        const view = await this.revealView<ValidationView>(VIEW_TYPE_VALIDATION);
        view?.setScope("current");
      }
    });

    this.addCommand({
      id: "validate-vault",
      name: "Validate vault",
      callback: async () => {
        const view = await this.revealView<ValidationView>(VIEW_TYPE_VALIDATION);
        view?.setScope("vault");
      }
    });

    this.addCommand({
      id: "apply-fixes-current-note",
      name: "Apply fixes for current note",
      callback: async () => {
        await this.applyFixesForActive();
      }
    });

    this.addCommand({
      id: "move-current-note-by-convention",
      name: "Move current note by convention",
      callback: async () => {
        await this.moveActiveByConvention();
      }
    });

    this.addCommand({
      id: "reload-vault-plugins",
      name: "Reload vault-local plugins",
      callback: async () => {
        await this.reloadVaultPlugins();
      }
    });

    this.addCommand({
      id: "rebuild-cache",
      name: "Rebuild cache",
      callback: async () => {
        await this.rebuildCache();
      }
    });

    this.addCommand({
      id: "open-ipa-settings",
      name: "Open IPA settings",
      callback: () => {
        const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
        setting?.open();
        setting?.openTabById(this.manifest.id);
      }
    });
  }

  async rebuildCache(): Promise<void> {
    if (!this.guardVault()) return;
    try {
      await this.client.rebuildCache();
      new Notice("IPA: cache rebuilt.");
    } catch (error) {
      new Notice(`IPA cache rebuild failed: ${errorMessage(error)}`);
    }
  }

  async applyFixesForActive(): Promise<void> {
    if (!this.guardVault()) return;
    const title = this.adapter.getActiveNoteTitle();
    if (!title) {
      new Notice("IPA: open a note to apply fixes.");
      return;
    }
    try {
      const result = await applyFixes(this.app, this.client, this.settings, [title]);
      new Notice(result.message);
      const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_VALIDATION)[0]?.view as
        | ValidationView
        | undefined;
      view?.setScope("current");
    } catch (error) {
      new Notice(`IPA apply failed: ${errorMessage(error)}`);
    }
  }

  async moveActiveByConvention(): Promise<void> {
    if (!this.guardVault()) return;
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("IPA: open a note to move.");
      return;
    }

    const plan = new IpaFlow(this.app).plan(file);
    if ("error" in plan) {
      new Notice(`IPA Flow: ${plan.error}`);
      return;
    }

    const run = async () => {
      try {
        await this.client.move(plan.note, plan.targetFolder, true);
        new Notice(`IPA Flow: moved "${plan.note}" → ${plan.targetFolder}.`);
      } catch (error) {
        new Notice(`IPA Flow failed: ${errorMessage(error)}`);
      }
    };

    if (this.settings.confirmIpaFlow) {
      new ConfirmModal(this.app, {
        title: "Move note by IPA convention?",
        body: `${plan.note}\n${plan.fromFolder || "(vault root)"} → ${plan.targetFolder}\n(${plan.reason})`,
        confirmText: "Move",
        onConfirm: () => void run()
      }).open();
      return;
    }
    await run();
  }

  async reloadVaultPlugins(): Promise<void> {
    if (!this.guardVault()) return;
    try {
      await this.client.rebuildCache();
      new Notice("IPA: vault-local plugins reloaded.");
    } catch (error) {
      new Notice(`IPA reload failed: ${errorMessage(error)}`);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

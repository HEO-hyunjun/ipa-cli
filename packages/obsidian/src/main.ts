import { Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
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

// Obsidian's renderer cannot resolve node builtin ESM imports (node:fs, ...)
// inside a blob module, but `require` is available there. Rewrite static builtin
// imports to require() so vault plugins that use them load in Obsidian too; on
// the CLI (Node) the original ESM import is used unchanged.
function rewriteNodeBuiltinImports(code: string): string {
  return code.replace(
    /^[ \t]*import\s+(.+?)\s+from\s+["'](node:[a-zA-Z/_-]+)["'][ \t]*;?[ \t]*$/gm,
    (_full, clause: string, mod: string) => {
      const req = `require(${JSON.stringify(mod)})`;
      const c = clause.trim();
      if (c.startsWith("{")) return `const ${c} = ${req};`;
      if (c.startsWith("* as ")) return `const ${c.slice(5).trim()} = ${req};`;
      return `const ${c} = ${req}.default ?? ${req};`;
    }
  );
}

export default class IpaPlugin extends Plugin {
  settings!: IpaSettings;
  adapter!: ObsidianVaultAdapter;
  client!: IpaClient;
  private warmTimer: number | null = null;
  private lastMarkdownFile: TFile | null = null;
  private formatGuard = new Set<string>();
  private restoreSaveCommand: (() => void) | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.adapter = new ObsidianVaultAdapter(this.app);
    this.client = new IpaClient(() => this.adapter.getVaultPath());
    this.installPluginLoader();

    // Drop the in-memory caches whenever the vault changes. We deliberately do
    // NOT re-warm the search context here: prepareSearchContext is a multi-second
    // main-thread build, and re-running it on every edit/apply froze Obsidian.
    // The context rebuilds lazily on the next search; only onload pre-warms it.
    const onVaultChange = () => {
      this.client.invalidateNotes();
    };
    this.registerEvent(this.app.vault.on("modify", onVaultChange));
    this.registerEvent(this.app.vault.on("create", onVaultChange));
    this.registerEvent(this.app.vault.on("delete", onVaultChange));
    this.registerEvent(this.app.vault.on("rename", onVaultChange));

    this.registerFormatOnSave();

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
    if (this.restoreSaveCommand) this.restoreSaveCommand();
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
      const code = rewriteNodeBuiltinImports(await readFile(absPath, "utf8"));
      const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
      try {
        return await import(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
  }

  // Auto-apply formatter fixes when the user "saves" a note. Obsidian autosaves,
  // so we treat leaving a note (switching leaves or closing it) and the explicit
  // save-file command (Cmd/Ctrl+S) as the save points.
  private registerFormatOnSave(): void {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const current = this.app.workspace.getActiveFile();
        const previous = this.lastMarkdownFile;
        this.lastMarkdownFile = current && current.extension === "md" ? current : null;
        if (this.settings.formatOnSave && previous && previous !== current) {
          void this.formatOnSaveApply(previous);
        }
      })
    );
    this.lastMarkdownFile = this.app.workspace.getActiveFile();

    // Obsidian runs a command's checkCallback(false) when present, otherwise its
    // callback. editor:save-file has both and checkCallback wins, so wrap both to
    // reliably trigger format-on-save after the real save runs.
    const commands = (this.app as unknown as {
      commands?: {
        commands?: Record<string, {
          callback?: () => unknown;
          checkCallback?: (checking: boolean) => unknown;
        }>;
      };
    }).commands;
    const saveCommand = commands?.commands?.["editor:save-file"];
    if (saveCommand) {
      const afterSave = () => {
        const file = this.app.workspace.getActiveFile();
        if (this.settings.formatOnSave && file && file.extension === "md") {
          void this.formatOnSaveApply(file);
        }
      };
      const originalCallback = saveCommand.callback;
      const originalCheck = saveCommand.checkCallback;
      if (originalCheck) {
        saveCommand.checkCallback = (checking: boolean) => {
          const result = originalCheck.call(saveCommand, checking);
          if (!checking && result !== false) afterSave();
          return result;
        };
      }
      if (originalCallback) {
        saveCommand.callback = () => {
          const result = originalCallback.call(saveCommand);
          afterSave();
          return result;
        };
      }
      this.restoreSaveCommand = () => {
        if (originalCheck) saveCommand.checkCallback = originalCheck;
        if (originalCallback) saveCommand.callback = originalCallback;
      };
    }
  }

  // Apply fixes for one note, persisting to disk. Guards against the re-entrant
  // modify event the write itself fires.
  private async formatOnSaveApply(file: TFile): Promise<void> {
    if (!this.adapter.hasFileSystemAccess()) return;
    // Excluded (non-IPA-managed) files are out of scope: skip silently instead
    // of asking core, which would throw "note not found" into a Notice.
    if (!(await this.client.isManagedPath(file.path))) return;
    if (this.formatGuard.has(file.path)) return;
    this.formatGuard.add(file.path);
    try {
      await applyFixes(this.app, this.client, [file.basename]);
      // If the validation panel is open, re-run validation so the user sees the
      // recheck after fixes (the validate → fix → validate cycle).
      const validation = this.app.workspace.getLeavesOfType(VIEW_TYPE_VALIDATION)[0]?.view as
        | ValidationView
        | undefined;
      await validation?.revalidate();
    } catch (error) {
      new Notice(`IPA format-on-save failed: ${errorMessage(error)}`);
    } finally {
      window.setTimeout(() => this.formatGuard.delete(file.path), 600);
    }
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
      const result = await applyFixes(this.app, this.client, [title]);
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
        // Move through the Obsidian API, not core's fs rename: an external
        // rename looks like a delete to Obsidian and kicks the note out of the
        // open editor, while fileManager.renameFile keeps the tab on the note
        // and updates links.
        const targetFolder = normalizePath(plan.targetFolder).normalize("NFC");
        if (!this.app.vault.getAbstractFileByPath(targetFolder)) {
          await this.app.vault.createFolder(targetFolder);
        }
        await this.app.fileManager.renameFile(file, normalizePath(`${targetFolder}/${file.name}`));
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

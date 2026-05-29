import { ItemView, WorkspaceLeaf } from "obsidian";
import type IpaPlugin from "../main";
import type { IpaClient } from "../core/ipaClient";
import type { ObsidianVaultAdapter } from "../adapter/ObsidianVaultAdapter";
import { errorMessage } from "../util/format";

// Shared base for the IPA item views. Owns the plugin reference and a few
// rendering helpers so each panel only implements its own data flow.
export abstract class BaseIpaView extends ItemView {
  protected readonly plugin: IpaPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: IpaPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  protected get client(): IpaClient {
    return this.plugin.client;
  }

  protected get adapter(): ObsidianVaultAdapter {
    return this.plugin.adapter;
  }

  // Reset the content element and render a sticky header. Returns the body
  // element each panel renders into.
  protected buildShell(title: string): { body: HTMLElement; header: HTMLElement } {
    const root = this.contentEl;
    root.empty();
    root.addClass("ipa-view");
    const header = root.createDiv({ cls: "ipa-view__header" });
    header.createSpan({ cls: "ipa-view__title", text: title });
    const body = root.createDiv({ cls: "ipa-view__body" });
    return { body, header };
  }

  protected showError(container: HTMLElement, error: unknown): void {
    container.empty();
    container.createDiv({ cls: "ipa-error-banner", text: errorMessage(error) });
  }

  protected showEmpty(container: HTMLElement, message: string): void {
    container.empty();
    container.createDiv({ cls: "ipa-empty", text: message });
  }
}

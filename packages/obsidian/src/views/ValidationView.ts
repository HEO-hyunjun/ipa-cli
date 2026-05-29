import { Notice, WorkspaceLeaf } from "obsidian";
import { BaseIpaView } from "./BaseIpaView";
import { VIEW_TYPE_VALIDATION } from "../util/constants";
import type { ValidationScope } from "../settings/settings";
import { errorMessage } from "../util/format";
import { ConfirmModal } from "../util/ConfirmModal";
import { applyFixes } from "../core/applyFixes";
import type IpaPlugin from "../main";

const VALIDATE_DEBOUNCE_MS = 250;

interface Issue {
  severity?: string;
  code?: string;
  note?: string;
  path?: string;
  message?: string;
}

export class ValidationView extends BaseIpaView {
  private scope: ValidationScope;
  private scopeTabsEl!: HTMLElement;
  private summaryEl!: HTMLElement;
  private issuesEl!: HTMLElement;
  private registryEl!: HTMLElement;
  // Rule codes that the formatter can actually fix this run (from plan patches).
  private fixableRules = new Set<string>();
  private debounceTimer: number | null = null;
  private busy = false;

  constructor(leaf: WorkspaceLeaf, plugin: IpaPlugin) {
    super(leaf, plugin);
    this.scope = plugin.settings.defaultValidationScope;
  }

  getViewType(): string {
    return VIEW_TYPE_VALIDATION;
  }

  getDisplayText(): string {
    return "IPA Validation";
  }

  getIcon(): string {
    return "shield-check";
  }

  setScope(scope: ValidationScope): void {
    this.scope = scope;
    if (this.summaryEl) {
      this.syncScopeTabs();
      void this.validate();
    }
  }

  // Public entry for external callers (e.g. format-on-save) to re-run validation.
  async revalidate(): Promise<void> {
    if (this.summaryEl) await this.validate();
  }

  async onOpen(): Promise<void> {
    const { body, header } = this.buildShell("Validation");
    this.buildControls(header);
    this.summaryEl = body.createDiv({ cls: "ipa-item__meta" });
    this.issuesEl = body.createDiv();
    this.registryEl = body.createDiv();

    this.registerEvent(
      this.adapter.onActiveChange(() => {
        if (this.scope === "current") this.scheduleValidate();
      })
    );

    await this.validate();
    void this.renderRegistry();
  }

  async onClose(): Promise<void> {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private buildControls(header: HTMLElement): void {
    this.scopeTabsEl = header.createDiv({ cls: "ipa-tabs" });
    for (const scope of ["current", "vault"] as ValidationScope[]) {
      const button = this.scopeTabsEl.createEl("button", {
        cls: "ipa-tab",
        text: scope === "current" ? "Note" : "Vault"
      });
      if (scope === this.scope) button.addClass("is-active");
      button.addEventListener("click", () => {
        this.scope = scope;
        this.syncScopeTabs();
        void this.validate();
      });
    }

    const actions = header.createDiv({ cls: "ipa-toolbar" });
    const validateButton = actions.createEl("button", { text: "Validate" });
    validateButton.addEventListener("click", () => void this.validate());
    const applyButton = actions.createEl("button", { cls: "mod-cta", text: "Apply fixes" });
    applyButton.addEventListener("click", () => void this.apply());
  }

  private syncScopeTabs(): void {
    const buttons = Array.from(this.scopeTabsEl.children) as HTMLElement[];
    const order: ValidationScope[] = ["current", "vault"];
    buttons.forEach((button, index) => button.toggleClass("is-active", order[index] === this.scope));
  }

  private scheduleValidate(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.validate();
    }, VALIDATE_DEBOUNCE_MS);
  }

  private currentNotes(): string[] {
    const title = this.adapter.getActiveNoteTitle();
    return title ? [title] : [];
  }

  private async validate(): Promise<void> {
    if (this.busy) return;
    if (!this.adapter.hasFileSystemAccess()) {
      this.showError(this.issuesEl, "IPA requires a desktop vault backed by the file system.");
      return;
    }
    if (this.scope === "current" && this.currentNotes().length === 0) {
      this.summaryEl.setText("Current note");
      this.showEmpty(this.issuesEl, "Open a note to validate it.");
      return;
    }

    this.busy = true;
    this.summaryEl.setText("Validating…");
    try {
      const result = await this.client.validate();
      const allIssues: Issue[] = Array.isArray(result?.issues) ? result.issues : [];
      const issues = this.scope === "current" ? this.filterToActive(allIssues) : allIssues;

      const planNotes = this.scope === "current" ? this.currentNotes() : undefined;
      const plan = await this.client.formatPlan(planNotes);
      const patches: Array<{ rules?: unknown }> = Array.isArray(plan?.patches) ? plan.patches : [];
      this.fixableRules = new Set<string>(
        patches.flatMap((patch) => (Array.isArray(patch.rules) ? (patch.rules as string[]) : []))
      );

      this.renderIssues(result, issues);
    } catch (error) {
      this.summaryEl.setText("");
      this.showError(this.issuesEl, error);
    } finally {
      this.busy = false;
    }
  }

  private filterToActive(issues: Issue[]): Issue[] {
    const path = this.adapter.getActiveNotePath();
    const title = this.adapter.getActiveNoteTitle();
    return issues.filter((issue) => (path && issue.path === path) || (title && issue.note === title));
  }

  private isFixable(issue: Issue): boolean {
    return Boolean(issue.code && this.fixableRules.has(issue.code));
  }

  private renderIssues(result: { status?: string }, issues: Issue[]): void {
    const scopeLabel = this.scope === "current" ? `Note · ${this.adapter.getActiveNoteTitle() ?? ""}` : "Vault";
    const fixableCount = issues.filter((issue) => this.isFixable(issue)).length;
    const fixable = fixableCount ? ` · ${fixableCount} fixable` : "";
    const status = result?.status ? ` · ${result.status}` : "";
    this.summaryEl.setText(`${scopeLabel} · ${issues.length} issue(s)${fixable}${status}`);

    this.issuesEl.empty();
    if (issues.length === 0) {
      this.showEmpty(this.issuesEl, "No issues.");
      return;
    }

    const list = this.issuesEl.createEl("ul", { cls: "ipa-list" });
    for (const issue of issues) this.renderIssue(list, issue);
  }

  private renderIssue(list: HTMLElement, issue: Issue): void {
    const severity = String(issue.severity ?? "info").toLowerCase();
    const item = list.createEl("li", { cls: `ipa-issue ipa-issue--${severity}` });

    const head = item.createDiv({ cls: "ipa-issue__head" });
    head.createSpan({ cls: "ipa-badge", text: severity });
    if (issue.code) head.createSpan({ cls: "ipa-issue__code", text: issue.code });
    if (this.isFixable(issue)) head.createSpan({ cls: "ipa-issue__fixable", text: "fixable" });

    item.createDiv({ text: issue.message ?? "" });

    if (issue.note || issue.path) {
      const target = item.createDiv({ cls: "ipa-item__meta" });
      const link = target.createSpan({ cls: "ipa-path__node", text: issue.note ?? issue.path ?? "" });
      link.addEventListener("click", () => void this.adapter.open(issue.path ?? null, issue.note ?? null));
    }
  }

  private async apply(): Promise<void> {
    if (!this.adapter.hasFileSystemAccess()) {
      new Notice("IPA requires a desktop vault.");
      return;
    }
    if (this.scope === "current" && this.currentNotes().length === 0) {
      new Notice("IPA: open a note to apply fixes.");
      return;
    }

    const notes = this.scope === "current" ? this.currentNotes() : undefined;
    const run = async () => {
      try {
        const result = await applyFixes(this.app, this.client, notes);
        new Notice(result.message);
        if (this.plugin.settings.autoValidateAfterApply) await this.validate();
      } catch (error) {
        new Notice(`IPA apply failed: ${errorMessage(error)}`);
      }
    };

    // Confirm only when writing fixes to disk across the whole vault.
    if (this.scope === "vault" && this.plugin.settings.confirmIpaFlow) {
      new ConfirmModal(this.app, {
        title: "Apply fixes across the vault?",
        body: "This writes formatter fixes to every note that has available fixes.",
        confirmText: "Apply",
        onConfirm: () => void run()
      }).open();
      return;
    }
    await run();
  }

  private async renderRegistry(): Promise<void> {
    this.registryEl.empty();
    const details = this.registryEl.createEl("details");
    details.createEl("summary", { text: "Rules & vault-local plugins" });

    try {
      const [rules, plugins, doctor] = await Promise.all([
        this.client.listRules(),
        this.client.listPlugins(),
        this.client.pluginDoctor()
      ]);

      const ruleList = Array.isArray(rules?.rules) ? rules.rules : [];
      const pluginList = Array.isArray(plugins?.plugins) ? plugins.plugins : [];
      details.createDiv({
        cls: "ipa-item__meta",
        text: `${ruleList.length} rules · ${pluginList.length} vault-local plugin(s)`
      });

      if (pluginList.length) {
        const list = details.createEl("ul", { cls: "ipa-list" });
        for (const plugin of pluginList) {
          list.createEl("li", { cls: "ipa-item__meta", text: `${plugin.kind ?? "?"} · ${plugin.path ?? ""}` });
        }
      }

      if (this.plugin.settings.showPluginLoadErrors) {
        for (const message of this.extractPluginErrors(doctor)) {
          details.createDiv({ cls: "ipa-error-banner", text: message });
        }
      }
    } catch (error) {
      details.createDiv({ cls: "ipa-error-banner", text: errorMessage(error) });
    }
  }

  private extractPluginErrors(doctor: any): string[] {
    if (!doctor) return [];
    const errors: string[] = [];
    const push = (value: unknown) => {
      if (!value) return;
      if (typeof value === "string") errors.push(value);
      else if (typeof value === "object" && "message" in (value as object)) {
        errors.push(String((value as { message: unknown }).message));
      }
    };
    if (Array.isArray(doctor.errors)) doctor.errors.forEach(push);
    if (Array.isArray(doctor.issues)) {
      doctor.issues
        .filter((issue: { severity?: string }) => issue?.severity === "error")
        .forEach(push);
    }
    if (Array.isArray(doctor.plugins)) {
      for (const plugin of doctor.plugins) {
        if (plugin?.error) errors.push(`${plugin.path ?? "plugin"}: ${plugin.error}`);
      }
    }
    return errors;
  }
}

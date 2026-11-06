import { App, PluginSettingTab, Setting } from "obsidian";
import type IpaPlugin from "../main";
import type { GraphNoteType, ValidationScope } from "./settings";
import { errorMessage } from "../util/format";

export class IpaSettingTab extends PluginSettingTab {
  private readonly plugin: IpaPlugin;

  constructor(app: App, plugin: IpaPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Apply").setHeading();

    new Setting(containerEl)
      .setName("Format on save")
      .setDesc(
        "Automatically apply formatter fixes to a note when you leave it (switch notes, close it) or save with Cmd/Ctrl+S."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.formatOnSave).onChange(async (value) => {
          this.plugin.settings.formatOnSave = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Re-validate after apply")
      .setDesc("Run validation again on the affected note(s) once fixes are applied.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoValidateAfterApply).onChange(async (value) => {
          this.plugin.settings.autoValidateAfterApply = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Validation").setHeading();

    new Setting(containerEl)
      .setName("Default validation scope")
      .setDesc("Which scope the validation panel opens with.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("current", "Current note")
          .addOption("vault", "Whole vault")
          .setValue(this.plugin.settings.defaultValidationScope)
          .onChange(async (value) => {
            this.plugin.settings.defaultValidationScope = value as ValidationScope;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("IPA Flow").setHeading();

    new Setting(containerEl)
      .setName("Confirm before moving notes")
      .setDesc("Ask for confirmation before applying an IPA Flow move.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.confirmIpaFlow).onChange(async (value) => {
          this.plugin.settings.confirmIpaFlow = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Vault-local plugins").setHeading();

    new Setting(containerEl)
      .setName("Enable vault-local plugins")
      .setDesc("Apply .ipa/plugins search channels and rules in the panels.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableVaultPlugins).onChange(async (value) => {
          this.plugin.settings.enableVaultPlugins = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show plugin load errors")
      .setDesc("Surface vault-local plugin load errors in the validation panel.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showPluginLoadErrors).onChange(async (value) => {
          this.plugin.settings.showPluginLoadErrors = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Search").setHeading();

    new Setting(containerEl)
      .setName("Search result limit")
      .setDesc("Maximum number of search results to display.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.searchResultLimit))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed > 0) {
              this.plugin.settings.searchResultLimit = Math.floor(parsed);
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Show score")
      .setDesc("Show the relevance score on each search result.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showSearchScore).onChange(async (value) => {
          this.plugin.settings.showSearchScore = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Note header").setHeading();

    new Setting(containerEl)
      .setName("Show ref path in note header")
      .setDesc(
        "Replace the folder path above each note with its ref path (root / index / note). " +
          "Notes outside the IPA index or without refs keep the folder path."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showRefTrail).onChange(async (value) => {
          this.plugin.settings.showRefTrail = value;
          await this.plugin.saveSettings();
          if (value) this.plugin.refTrail.schedule();
          else this.plugin.refTrail.clear();
        })
      );

    new Setting(containerEl).setName("Traversal picture").setHeading();

    const colorLabels: Array<[GraphNoteType, string, string]> = [
      ["root", "Root color", "--color-orange"],
      ["index", "Index color", "--interactive-accent"],
      ["note", "Note color", "--text-muted"]
    ];
    for (const [type, name, themeVar] of colorLabels) {
      const setting = new Setting(containerEl).setName(name).setDesc("Dot color for this note type. Reset to follow the theme.");
      setting.addColorPicker((picker) => {
        // An unset color shows the theme color it currently resolves to.
        const current = this.plugin.settings.graphColors[type] || this.themeColor(themeVar);
        if (current) picker.setValue(current);
        picker.onChange(async (value) => {
          this.plugin.settings.graphColors[type] = value;
          await this.plugin.saveSettings();
          this.plugin.applyGraphColors();
        });
      });
      setting.addExtraButton((button) =>
        button
          .setIcon("rotate-ccw")
          .setTooltip("Follow the theme")
          .onClick(async () => {
            this.plugin.settings.graphColors[type] = "";
            await this.plugin.saveSettings();
            this.plugin.applyGraphColors();
            this.display();
          })
      );
    }

    void this.renderStatus(containerEl);
  }

  // Resolve a theme CSS variable to a #rrggbb the color picker accepts.
  private themeColor(variable: string): string {
    const probe = document.body.createDiv();
    probe.style.color = `var(${variable})`;
    const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number) ?? [];
    probe.remove();
    if (rgb.length < 3) return "";
    return "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  }

  private async renderStatus(containerEl: HTMLElement): Promise<void> {
    new Setting(containerEl).setName("Vault status").setHeading();
    const status = containerEl.createDiv({ cls: "ipa-item__meta" });
    status.setText("Loading…");

    if (!this.plugin.adapter.hasFileSystemAccess()) {
      status.setText("Not a desktop vault — IPA features are unavailable.");
      return;
    }

    try {
      const [config, plugins] = await Promise.all([
        this.plugin.client.readConfig(),
        this.plugin.client.listPlugins()
      ]);
      status.empty();
      const pluginCount = Array.isArray(plugins?.plugins) ? plugins.plugins.length : 0;
      status.createDiv({ text: `.ipa/config.yaml: ${config ? "loaded" : "missing"}` });
      status.createDiv({ text: `vault-local plugins: ${pluginCount}` });
    } catch (error) {
      status.setText(errorMessage(error));
    }
  }
}

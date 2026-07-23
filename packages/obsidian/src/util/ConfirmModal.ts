import { App, Modal } from "obsidian";

interface ConfirmOptions {
  title: string;
  body: string;
  confirmText?: string;
  onConfirm: () => void;
}

// Minimal confirmation dialog reused by Apply (vault scope) and IPA Flow.
export class ConfirmModal extends Modal {
  private readonly options: ConfirmOptions;

  constructor(app: App, options: ConfirmOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    this.titleEl.setText(this.options.title);
    // Body lines render as separate divs — a <p> collapses "\n", which makes
    // multi-line bodies (e.g. a batch move list) unreadable.
    const body = this.contentEl.createEl("p");
    for (const line of this.options.body.split("\n")) body.createDiv({ text: line });

    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const confirm = buttons.createEl("button", {
      cls: "mod-cta",
      text: this.options.confirmText ?? "Confirm"
    });
    confirm.addEventListener("click", () => {
      this.close();
      this.options.onConfirm();
    });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

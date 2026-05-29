import { App, MarkdownView, TFile } from "obsidian";
import type { IpaClient } from "./ipaClient";
import type { IpaSettings } from "../settings/settings";

interface Patch {
  note?: string;
  path?: string;
  content?: string;
  line?: number;
  replacement?: string;
}

export interface ApplyResult {
  applied: number;
  message: string;
}

// Mirrors core's applyFormatterPatch: a patch either replaces the whole note
// (content) or splices a single line (line/replacement).
function applyPatchToText(text: string, patch: Patch): string {
  if (typeof patch.content === "string") return patch.content;
  if (Number.isInteger(patch.line) && typeof patch.replacement === "string") {
    const lines = text.split("\n");
    lines.splice(Math.max(0, (patch.line as number) - 1), 1, patch.replacement);
    return lines.join("\n");
  }
  return text;
}

function groupByPath(patches: Patch[]): Map<string, Patch[]> {
  const map = new Map<string, Patch[]>();
  for (const patch of patches) {
    if (!patch.path) continue;
    const list = map.get(patch.path) ?? [];
    list.push(patch);
    map.set(patch.path, list);
  }
  return map;
}

// Apply formatter fixes through Obsidian so the editor and metadata cache stay in
// sync. core.formatVault(apply=true) writes via Node fs and bypasses Obsidian,
// leaving the editor with stale content (the bug behind "save on apply does
// nothing"). Instead we plan the patches and write them with the Vault API when
// saveOnApply is on, or into the active editor buffer when it is off.
export async function applyFixes(
  app: App,
  client: IpaClient,
  settings: IpaSettings,
  notes: string[] | undefined
): Promise<ApplyResult> {
  const plan = await client.formatPlan(notes);
  const patches: Patch[] = Array.isArray(plan?.patches) ? plan.patches : [];
  if (patches.length === 0) {
    return { applied: 0, message: "IPA: no fixes available." };
  }

  const byPath = groupByPath(patches);

  if (settings.saveOnApply) {
    let applied = 0;
    let files = 0;
    for (const [path, notePatches] of byPath) {
      // core paths come from fs.readdir (NFD on macOS); Obsidian indexes by NFC.
      const file = app.vault.getAbstractFileByPath(path.normalize("NFC"));
      if (!(file instanceof TFile)) continue;
      await app.vault.process(file, (data) => {
        let text = data;
        for (const patch of notePatches) text = applyPatchToText(text, patch);
        return text;
      });
      applied += notePatches.length;
      files += 1;
    }
    return { applied, message: `IPA: applied ${applied} fix(es) across ${files} note(s).` };
  }

  // Save on apply OFF: update only the active editor buffer (left unsaved).
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  const file = view?.file;
  if (!view || !file) {
    return { applied: 0, message: "IPA: 'Save on apply' is off — open the note in an editor to preview fixes." };
  }
  const notePatches = byPath.get(file.path);
  if (!notePatches || notePatches.length === 0) {
    return { applied: 0, message: "IPA: 'Save on apply' is off — no buffer fixes for the active note." };
  }
  let text = view.editor.getValue();
  for (const patch of notePatches) text = applyPatchToText(text, patch);
  view.editor.setValue(text);
  return {
    applied: notePatches.length,
    message: `IPA: applied ${notePatches.length} fix(es) to the editor buffer (unsaved).`
  };
}

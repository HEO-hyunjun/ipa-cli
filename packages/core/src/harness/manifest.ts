import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function harnessRoot(vaultPath) {
  return join(vaultPath, ".ipa", "harness");
}

export async function readHarnessIndex(vaultPath) {
  const path = join(harnessRoot(vaultPath), "manifest.json");
  if (!existsSync(path)) return { version: 1, targets: {} };
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeHarnessIndex(vaultPath, index) {
  const path = join(harnessRoot(vaultPath), "manifest.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(index, null, 2) + "\n", "utf8");
}

export async function readTargetManifest(vaultPath, target) {
  const path = join(harnessRoot(vaultPath), target, "manifest.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export function createTargetManifest({ adapter, spec, selected, omitted, selectionMode, cliInfo, installedAt, localSkills }) {
  return {
    version: 2,
    target: adapter.id,
    installed_at: installedAt,
    cli_version: cliInfo.version,
    cli_commit: cliInfo.commit,
    scope: ["global", "vault-local"],
    local_prompt: spec.localPrompt,
    components: selected,
    omitted_components: omitted,
    selection_mode: selectionMode,
    global: {
      ...adapter.manifestGlobal(spec),
      environment: {
        IPA_SEARCH_LOG: "1"
      }
    },
    local_skills: {
      root: adapter.localSkillsRoot,
      skills: localSkills
    },
    plugin_scaffold: {
      root: ".ipa/plugins",
      types: ".ipa/plugins/types/ipa-plugin.d.ts",
      rules: ".ipa/plugins/rules/*.js",
      search: ".ipa/plugins/search/*.js"
    },
    hooks: {
      session_start_env: {
        environment: {
          IPA_SEARCH_LOG: "1"
        },
        policy: "enable search-event logging for plain ipa search commands in agent sessions"
      },
      guard: {
        command: "ipa harness guard check <vault-relative-path>",
        policy: "new markdown files must be created under the configured inbox folder"
      },
      prompt_evidence: {
        policy: "record prompt/search pairs for tuning when hook:evidence is selected"
      },
      markdown_edit_ledger: {
        policy: "silently record raw Markdown edits for the session-end formatter gate"
      },
      formatter_gate: {
        policy: "block final response while edited vault notes still have formatter patches"
      }
    }
  };
}

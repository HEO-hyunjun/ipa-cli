import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { harnessRoot } from "./manifest.js";
import { HARNESS_HOOK_COMPONENT_TO_SCRIPT, componentSelected } from "./model.js";
import { HARNESS_MARKER, managedFileState, readFileSyncText, readManagedBlockBody } from "./managedFiles.js";
import { harnessHookScriptContent, opencodePluginScript } from "./shared/hookTemplates.js";
import { VAULT_LOCAL_SKILLS, globalPromptContent, harnessSkillContent, localPromptContent, vaultLocalSkillContent, vaultLocalSkillRelPath } from "./shared/templates.js";

export function harnessFragmentNames() {
  return ["skill", "prompt", "local-prompt", ...VAULT_LOCAL_SKILLS.map((skill) => skill.name)];
}

export function harnessFragmentsRoot(vaultPath) {
  return join(harnessRoot(vaultPath), "fragments");
}

export async function listHarnessFragments(vaultPath) {
  const root = harnessFragmentsRoot(vaultPath);
  if (!existsSync(root)) return [];
  const entries = await readdir(root);
  return entries.filter((entry) => entry.endsWith(".md")).map((entry) => entry.slice(0, -3)).sort();
}

export function readHarnessFragment(vaultPath, name) {
  const path = join(harnessFragmentsRoot(vaultPath), `${name}.md`);
  if (!existsSync(path)) return null;
  const text = readFileSyncText(path).trim();
  return text.length ? text : null;
}

function withVaultFragment(vaultPath, name, content) {
  const fragment = readHarnessFragment(vaultPath, name);
  if (!fragment) return content;
  const body = `\n## Vault Operating Rules\n\n${fragment}\n`;
  return content.endsWith("\n") ? `${content}${body}` : `${content}\n${body}`;
}

// Single source of truth for every content-bearing harness artifact: install
// writes these entries and the outdated check re-renders them for comparison.
export function harnessExpectedArtifacts(vaultPath, spec, mapping, selected, options = {}) {
  const artifacts = [];
  const usesPlugin = spec.adapter.usesPlugin;
  if (componentSelected(selected, "skill")) {
    artifacts.push({ component: "skill", scope: "global", kind: "file", path: spec.skillFile, content: withVaultFragment(vaultPath, "skill", harnessSkillContent(vaultPath, spec, mapping, options)) });
  }
  if (!usesPlugin) {
    for (const [component, script] of Object.entries(HARNESS_HOOK_COMPONENT_TO_SCRIPT)) {
      if (!componentSelected(selected, component)) continue;
      artifacts.push({ component, scope: "global", kind: "file", path: join(spec.hooksDir, script), content: harnessHookScriptContent(component, vaultPath, spec, mapping, options) });
    }
  } else if (spec.pluginFile) {
    const needsPlugin = componentSelected(selected, "opencode-plugin") || selected.some((component) => component.startsWith("hook:"));
    if (needsPlugin) {
      artifacts.push({ component: "opencode-plugin", scope: "global", kind: "file", path: spec.pluginFile, content: opencodePluginScript(vaultPath, mapping, selected, options) });
    }
  }
  if (componentSelected(selected, "prompt")) {
    artifacts.push({ component: "prompt", scope: "global", kind: "block", path: spec.globalPromptFile, content: withVaultFragment(vaultPath, "prompt", globalPromptContent(spec)) });
  }
  if (componentSelected(selected, "local-prompt")) {
    artifacts.push({ component: "local-prompt", scope: "vault", kind: "block", path: join(vaultPath, spec.localPrompt), content: withVaultFragment(vaultPath, "local-prompt", localPromptContent(vaultPath, spec, mapping, options)) });
  }
  if (componentSelected(selected, "local-skills")) {
    for (const skill of VAULT_LOCAL_SKILLS) {
      artifacts.push({ component: "local-skills", scope: "vault", kind: "file", path: join(vaultPath, vaultLocalSkillRelPath(spec, skill.name)), content: withVaultFragment(vaultPath, skill.name, vaultLocalSkillContent(skill, mapping)) });
    }
  }
  return artifacts;
}

// Installed-but-different components. Missing artifacts stay out of this list;
// presence is already reported by status/doctor. Files whose HARNESS_MARKER was
// stripped are treated as user-owned and skipped.
export function harnessOutdatedComponents(vaultPath, spec, mapping, selected, options = {}) {
  const outdated = new Set();
  for (const artifact of harnessExpectedArtifacts(vaultPath, spec, mapping, selected, options)) {
    if (artifact.kind === "block") {
      const body = readManagedBlockBody(artifact.path);
      if (body !== null && body !== artifact.content.trim()) outdated.add(artifact.component);
    } else if (existsSync(artifact.path)) {
      const text = readFileSyncText(artifact.path);
      if (text.includes(HARNESS_MARKER) && text !== artifact.content) outdated.add(artifact.component);
    }
  }
  return [...outdated];
}

// Components whose managed-target file exists but no longer carries the
// HARNESS_MARKER: the user forked it (or it predates the install). Blocks are
// excluded — they live inside user-owned files by design.
export function harnessUserOwnedComponents(vaultPath, spec, mapping, selected, options = {}) {
  const userOwned = new Set();
  for (const artifact of harnessExpectedArtifacts(vaultPath, spec, mapping, selected, options)) {
    if (artifact.kind !== "file") continue;
    if (managedFileState(artifact.path) === "user") userOwned.add(artifact.component);
  }
  return [...userOwned];
}

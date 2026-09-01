import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { harnessExpectedArtifacts } from "./artifacts.js";
import { HARNESS_HOOK_COMPONENT_TO_SCRIPT, componentSelected } from "./model.js";
import { hasManagedFile, removeManagedBlock, removeManagedFile, removeManagedVaultFile, upsertManagedBlock, writeManagedFile } from "./managedFiles.js";
import { addHookCommand, removeManagedHookCommands } from "./shared/hookConfig.js";
import { IPA_MANAGED_LOCAL_SKILL_NAMES, VAULT_LOCAL_SKILLS, vaultLocalSkillRelPath } from "./shared/templates.js";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function readJsonObject(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to parse ${path}: ${error.message}`);
  }
}

async function writeJsonObject(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function hookCommand(path, spec) {
  const home = spec ? dirname(spec.home) : null;
  if (home) {
    const rel = relative(home, path);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel) && !/\s/.test(rel)) {
      return `node ~/${rel.split(sep).join("/")}`;
    }
  }
  return `node ${shellQuote(path)}`;
}

function managedLocalSkillNames(previousSkills = []) {
  return [...new Set([...IPA_MANAGED_LOCAL_SKILL_NAMES, ...previousSkills])]
    .filter((name) => /^ipa-[a-z0-9-]+$/.test(String(name)));
}

export async function uninstallVaultLocalSkills(vaultPath, spec, previousSkills = []) {
  const removed = [];
  for (const name of managedLocalSkillNames(previousSkills)) {
    await removeManagedVaultFile(vaultPath, vaultLocalSkillRelPath(spec, name), removed);
  }
  return removed;
}

export async function pruneVaultLocalSkills(vaultPath, spec, keepCurrent = false, previousSkills = []) {
  const keep = keepCurrent ? new Set(VAULT_LOCAL_SKILLS.map((skill) => skill.name)) : new Set();
  const removed = [];
  for (const name of managedLocalSkillNames(previousSkills)) {
    if (keep.has(name)) continue;
    await removeManagedVaultFile(vaultPath, vaultLocalSkillRelPath(spec, name), removed);
  }
  return removed;
}
export function vaultLocalSkillStatus(vaultPath, spec) {
  return Object.fromEntries(VAULT_LOCAL_SKILLS.map((skill) => [
    skill.name,
    hasManagedFile(join(vaultPath, vaultLocalSkillRelPath(spec, skill.name)))
  ]));
}

export async function installGlobalHarness(vaultPath, spec, mapping, options = {}) {
  const selected = options.components?.selected
    ? options.components.selected
    : spec.adapter.defaultComponents;
  const files = [];
  const skipped = [];

  for (const artifact of harnessExpectedArtifacts(vaultPath, spec, mapping, selected, options)) {
    if (artifact.scope !== "global") continue;
    if (artifact.kind === "block") {
      await upsertManagedBlock(artifact.path, artifact.content);
      files.push(artifact.path);
    } else {
      await writeManagedFile(artifact.path, artifact.content, files, skipped);
    }
  }

  if (!spec.adapter.usesPlugin) {
    // The hooks config (and, for claude, the permission rule) live in a
    // user-owned settings file. A hand-edited/unparseable file must never be
    // clobbered: skip registration and report it, leaving the file untouched.
    let config = null;
    try {
      config = await readJsonObject(spec.hooksConfig);
    } catch {
      config = null;
    }
    if (config === null) {
      skipped.push(spec.hooksConfig);
    } else {
      removeManagedHookCommands(config);
      for (const [component, script] of Object.entries(HARNESS_HOOK_COMPONENT_TO_SCRIPT)) {
        if (!componentSelected(selected, component)) continue;
        const registration = spec.adapter.hookRegistration(component);
        if (!registration) continue;
        addHookCommand(
          config,
          registration.event,
          registration.matcher,
          hookCommand(join(spec.hooksDir, script), spec),
          registration.statusMessage,
          registration.timeout
        );
      }
      if (componentSelected(selected, "permissions")) {
        spec.adapter.applyPermissions(config);
      }
      await writeJsonObject(spec.hooksConfig, config);
      files.push(spec.hooksConfig);
    }
  }
  return { files, skipped };
}

export async function uninstallGlobalHarness(spec) {
  const removed = [];
  const scripts = [
    join(spec.hooksDir, "ipa-session-env.mjs"),
    join(spec.hooksDir, "ipa-inbox-guard.mjs"),
    join(spec.hooksDir, "ipa-user-prompt-nudge.mjs"),
    join(spec.hooksDir, "ipa-prompt-evidence.mjs"),
    join(spec.hooksDir, "ipa-md-write-nudge.mjs"),
    join(spec.hooksDir, "ipa-call-counter.mjs"),
    // Legacy hook removed after mutation tracking moved into the CLI.
    join(spec.hooksDir, "ipa-mutation-ledger.mjs"),
    join(spec.hooksDir, "ipa-formatter-gate.mjs"),
    join(spec.hooksDir, "ipa-vault-ref-nudge.mjs")
  ];
  for (const path of [spec.skillFile, ...scripts]) await removeManagedFile(path, removed);
  if (spec.pluginFile) await removeManagedFile(spec.pluginFile, removed);
  if (existsSync(spec.hooksConfig)) {
    // Fail safe on an unparseable user-owned settings file: leave it untouched.
    try {
      const config = await readJsonObject(spec.hooksConfig);
      removeManagedHookCommands(config);
      spec.adapter.removePermissions(config);
      await writeJsonObject(spec.hooksConfig, config);
      removed.push(spec.hooksConfig);
    } catch {
      // keep the file as-is rather than clobber content we cannot parse
    }
  }
  if (await removeManagedBlock(spec.globalPromptFile)) {
    removed.push(spec.globalPromptFile);
  }
  return removed;
}

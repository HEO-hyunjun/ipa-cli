import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  HARNESS_COMPONENTS,
  HARNESS_HOOK_COMPONENT_TO_SCRIPT,
  componentSelected,
  normalizeComponentList,
  resolveHarnessComponents
} from "./model.js";
import { harnessProvider } from "./registry.js";
import {
  createTargetManifest,
  harnessRoot,
  readHarnessIndex,
  readTargetManifest,
  writeHarnessIndex
} from "./manifest.js";
import {
  hasManagedFile,
  managedFileState,
  readFileSyncText,
  removeManagedBlock,
  upsertManagedBlock,
  writeManagedVaultFile
} from "./managedFiles.js";

function harnessHomeBase(options = {}) {
  return resolve(options.homeDir ?? process.env.IPA_HARNESS_HOME ?? homedir());
}

function targetSpec(target, options = {}) {
  const adapter = harnessProvider(target);
  return adapter.targetSpec(harnessHomeBase(options));
}

function permissionRulePresent(spec) {
  try {
    const config = JSON.parse(readFileSyncText(spec.hooksConfig) || "{}");
    return spec.adapter.permissionPresent(config);
  } catch {
    return false;
  }
}

function pluginHookComponentPresent(spec, component) {
  if (!hasManagedFile(spec.pluginFile)) return false;
  const marker = spec.adapter.pluginMarker(component);
  if (!marker) return false;
  try {
    return readFileSyncText(spec.pluginFile).includes(marker);
  } catch {
    return false;
  }
}

export function createHarnessService(deps) {
  const componentPresence = (spec, vaultPath, selected) => {
    const presence = Object.fromEntries(HARNESS_COMPONENTS.map((component) => [component, false]));
    if (componentSelected(selected, "skill")) presence.skill = hasManagedFile(spec.skillFile);
    if (componentSelected(selected, "prompt")) presence.prompt = hasManagedFile(spec.globalPromptFile);
    if (componentSelected(selected, "local-prompt")) presence["local-prompt"] = existsSync(join(vaultPath, spec.localPrompt));
    if (componentSelected(selected, "local-skills")) {
      const skills = deps.vaultLocalSkillStatus(vaultPath, spec);
      presence["local-skills"] = Object.values(skills).every((value) => value === true);
    }
    if (componentSelected(selected, "plugin-scaffold")) {
      const scaffold = deps.pluginScaffoldStatus(vaultPath);
      presence["plugin-scaffold"] = Boolean(scaffold.jsconfig && scaffold.types && scaffold.rules_dir && scaffold.search_dir);
    }
    if (spec.adapter.usesPlugin && componentSelected(selected, "opencode-plugin") && spec.pluginFile) {
      presence["opencode-plugin"] = hasManagedFile(spec.pluginFile);
    }
    if (componentSelected(selected, "permissions")) presence.permissions = permissionRulePresent(spec);
    for (const component of Object.keys(HARNESS_HOOK_COMPONENT_TO_SCRIPT)) {
      if (!componentSelected(selected, component)) continue;
      if (spec.adapter.usesPlugin && spec.pluginFile) {
        presence[component] = pluginHookComponentPresent(spec, component);
      } else {
        presence[component] = hasManagedFile(join(spec.hooksDir, HARNESS_HOOK_COMPONENT_TO_SCRIPT[component]));
      }
    }
    return presence;
  };

  const listFragments = async (vaultPath) => {
    const root = join(harnessRoot(vaultPath), "fragments");
    if (!existsSync(root)) return [];
    const entries = await readdir(root);
    return entries.filter((entry) => entry.endsWith(".md")).map((entry) => entry.slice(0, -3)).sort();
  };

  const status = async (vaultPath, options = {}) => {
    const index = await readHarnessIndex(vaultPath);
    const { config, mapping } = await deps.readVaultConfig(vaultPath);
    options = { ...options, callCounter: deps.callCounterOptions(config) };
    const global = {};
    const outdatedByTarget = {};
    let aggregateSelected = [];
    let aggregateOmitted = [];
    for (const target of Object.keys(index.targets ?? {})) {
      const spec = targetSpec(target, options);
      const targetManifest = await readTargetManifest(vaultPath, target);
      const selected = targetManifest?.components ?? spec.adapter.defaultComponents;
      const omitted = targetManifest?.omitted_components ?? [];
      if (targetManifest) {
        aggregateSelected = [...new Set([...aggregateSelected, ...selected])];
        aggregateOmitted = [...new Set([...aggregateOmitted, ...omitted])];
      }
      const outdatedComponents = deps.outdatedComponents(vaultPath, spec, mapping, selected, options);
      if (outdatedComponents.length) outdatedByTarget[target] = outdatedComponents;
      global[target] = {
        outdated_components: outdatedComponents,
        selected_components: selected,
        omitted_components: omitted,
        user_owned_components: deps.userOwnedComponents(vaultPath, spec, mapping, selected, options),
        cli_version: targetManifest?.cli_version ?? null,
        cli_commit: targetManifest?.cli_commit ?? null,
        skill: hasManagedFile(spec.skillFile),
        session_env_hook: hasManagedFile(join(spec.hooksDir, "ipa-session-env.mjs")),
        guard_hook: hasManagedFile(join(spec.hooksDir, "ipa-inbox-guard.mjs")),
        prompt_hook: hasManagedFile(join(spec.hooksDir, "ipa-user-prompt-nudge.mjs")),
        markdown_nudge_hook: hasManagedFile(join(spec.hooksDir, "ipa-md-write-nudge.mjs")),
        formatter_gate_hook: hasManagedFile(join(spec.hooksDir, "ipa-formatter-gate.mjs")),
        hooks_config: existsSync(spec.hooksConfig),
        permission_rule: permissionRulePresent(spec),
        prompt: hasManagedFile(spec.globalPromptFile),
        local_skills: deps.vaultLocalSkillStatus(vaultPath, spec),
        opencode_plugin: spec.pluginFile ? hasManagedFile(spec.pluginFile) : false,
        components: componentPresence(spec, vaultPath, selected)
      };
    }
    const outdatedTargets = Object.keys(outdatedByTarget);
    return {
      status: "ok",
      installed: Object.keys(index.targets ?? {}),
      manifest: existsSync(join(harnessRoot(vaultPath), "manifest.json")) ? ".ipa/harness/manifest.json" : null,
      global,
      components: { selected: aggregateSelected, omitted: aggregateOmitted },
      outdated: outdatedByTarget,
      update_hint: outdatedTargets.length
        ? `harness components are older than the installed CLI templates; run: ${outdatedTargets.map((target) => `ipa harness update ${target}`).join(", ")}`
        : null,
      fragments: await listFragments(vaultPath),
      plugin_scaffold: deps.pluginScaffoldStatus(vaultPath),
      guard: await deps.guardStatus(vaultPath)
    };
  };

  const install = async (vaultPath, target = "codex", options = {}) => {
    const spec = targetSpec(target, options);
    const { selected, omitted } = resolveHarnessComponents(spec.adapter, options);
    const { config, mapping } = await deps.readVaultConfig(vaultPath);
    options = { ...options, callCounter: deps.callCounterOptions(config) };
    const pluginInitResult = componentSelected(selected, "plugin-scaffold")
      ? await deps.pluginInit(vaultPath, { examples: true })
      : { created: [], skipped: [] };
    const dir = join(harnessRoot(vaultPath), spec.name);
    const manifest = createTargetManifest({
      adapter: spec.adapter,
      spec,
      selected,
      omitted,
      cliInfo: deps.cliVersionInfo(),
      installedAt: deps.nowIso(),
      localSkills: deps.localSkills.map((skill) => skill.name)
    });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await writeFile(join(dir, "guard.mjs"), [
      "#!/usr/bin/env node",
      "import { spawnSync } from 'node:child_process';",
      "const target = process.argv[2] ?? '';",
      "const result = spawnSync('ipa', ['harness', 'guard', 'check', target, '--json'], { stdio: 'inherit' });",
      "process.exit(result.status ?? 1);",
      ""
    ].join("\n"), "utf8");
    const files = [`.ipa/harness/${spec.name}/manifest.json`, `.ipa/harness/${spec.name}/guard.mjs`, ".ipa/harness/manifest.json"];
    const skippedUserOwned = [];
    for (const artifact of deps.expectedArtifacts(vaultPath, spec, mapping, selected, options)) {
      if (artifact.scope !== "vault") continue;
      const relPath = deps.toPosix(relative(vaultPath, artifact.path));
      if (artifact.kind === "block") {
        await upsertManagedBlock(artifact.path, artifact.content);
        files.push(relPath);
      } else {
        await writeManagedVaultFile(vaultPath, relPath, artifact.content, files, skippedUserOwned);
      }
    }
    const installOptions = { ...options, components: { ...options.components, selected } };
    const { files: globalFiles, skipped: globalSkipped } = await deps.installGlobal(vaultPath, spec, mapping, installOptions);
    skippedUserOwned.push(...globalSkipped);
    const index = await readHarnessIndex(vaultPath);
    index.targets = index.targets || {};
    index.targets[spec.name] = {
      path: `.ipa/harness/${spec.name}/manifest.json`,
      installed_at: manifest.installed_at,
      local_prompt: spec.localPrompt,
      components: selected,
      omitted_components: omitted
    };
    await writeHarnessIndex(vaultPath, index);
    return {
      status: "ok",
      target: spec.name,
      installed: true,
      plugin_init: pluginInitResult,
      files,
      global_files: globalFiles,
      skipped_user_owned: skippedUserOwned
    };
  };

  const uninstall = async (vaultPath, target = "codex", options = {}) => {
    const spec = targetSpec(target, options);
    await rm(join(harnessRoot(vaultPath), spec.name), { recursive: true, force: true });
    await removeManagedBlock(join(vaultPath, spec.localPrompt));
    const localSkillRemoved = await deps.uninstallLocalSkills(vaultPath, spec);
    const globalRemoved = await deps.uninstallGlobal(spec);
    const index = await readHarnessIndex(vaultPath);
    if (index.targets) delete index.targets[spec.name];
    await writeHarnessIndex(vaultPath, index);
    return { status: "ok", target: spec.name, installed: false, removed: [`.ipa/harness/${spec.name}`, spec.localPrompt, ...localSkillRemoved], global_removed: globalRemoved };
  };

  const update = async (vaultPath, target = "codex", options = {}) => {
    const spec = targetSpec(target, options);
    const index = await readHarnessIndex(vaultPath);
    if (!index.targets?.[spec.name]) {
      return { status: "error", target: spec.name, reason: "not_installed", message: `harness target ${spec.name} is not installed; run ipa harness install ${spec.name}` };
    }
    const targetManifest = await readTargetManifest(vaultPath, spec.name);
    const storedSelected = targetManifest?.components ?? index.targets[spec.name].components ?? spec.adapter.defaultComponents;
    const storedOmitted = targetManifest?.omitted_components ?? index.targets[spec.name].omitted_components ?? [];
    const valid = new Set(spec.adapter.validComponents);
    const only = normalizeComponentList(options.components?.only);
    const withList = normalizeComponentList(options.components?.with);
    const without = normalizeComponentList(options.components?.without);
    for (const component of [...only, ...withList, ...without]) {
      if (!valid.has(component)) throw new Error(`unknown harness component: ${component}`);
    }
    const autoAdded = only.length ? [] : spec.adapter.defaultComponents
      .filter((component) => !storedSelected.includes(component) && !storedOmitted.includes(component));
    let selected = only.length
      ? [...new Set(only)]
      : [...storedSelected.filter((component) => valid.has(component)), ...autoAdded];
    for (const component of withList) {
      if (!selected.includes(component)) selected.push(component);
    }
    selected = spec.adapter.completeSelection(selected.filter((component) => !without.includes(component)));
    const uninstallResult = await uninstall(vaultPath, spec.name, options);
    const installResult = await install(vaultPath, spec.name, { ...options, components: { only: selected } });
    return {
      status: "ok",
      target: spec.name,
      updated: true,
      components: selected,
      components_added: autoAdded,
      omitted_components: spec.adapter.validComponents.filter((component) => !selected.includes(component)),
      removed: uninstallResult.removed,
      global_removed: uninstallResult.global_removed,
      files: installResult.files,
      global_files: installResult.global_files,
      skipped_user_owned: installResult.skipped_user_owned,
      plugin_init: installResult.plugin_init
    };
  };

  const doctor = async (vaultPath, options = {}) => {
    const index = await readHarnessIndex(vaultPath);
    const { config, mapping } = await deps.readVaultConfig(vaultPath);
    options = { ...options, callCounter: deps.callCounterOptions(config) };
    const issues = [];
    const knownFragments = new Set(deps.fragmentNames());
    for (const fragment of await listFragments(vaultPath)) {
      if (!knownFragments.has(fragment)) {
        issues.push({ severity: "warn", code: "harness.fragment_unknown", message: `fragment .ipa/harness/fragments/${fragment}.md matches no harness artifact; expected one of: ${[...knownFragments].join(", ")}` });
      }
    }
    try {
      const pluginReport = await deps.pluginDoctor(vaultPath);
      for (const issue of pluginReport.issues ?? []) {
        issues.push({ severity: issue.severity ?? "error", code: "harness.plugin_invalid", message: `${issue.path ? `${issue.path}: ` : ""}${issue.message ?? "plugin is invalid"}` });
      }
    } catch {
      // Doctor remains fail-safe when plugin discovery itself is broken.
    }
    for (const [target, entry] of Object.entries(index.targets ?? {})) {
      const spec = targetSpec(target, options);
      const targetManifest = await readTargetManifest(vaultPath, target);
      const selected = targetManifest?.components ?? entry.components ?? spec.adapter.defaultComponents;
      const omitted = targetManifest?.omitted_components ?? entry.omitted_components ?? [];
      const pendingDefaults = spec.adapter.defaultComponents
        .filter((component) => !selected.includes(component) && !omitted.includes(component));
      if (pendingDefaults.length) {
        issues.push({ severity: "warn", code: "harness.component_new_default", target, message: `new default components available: ${pendingDefaults.join(", ")}; run ipa harness update ${target}` });
      }
      for (const component of deps.outdatedComponents(vaultPath, spec, mapping, selected, options)) {
        issues.push({ severity: "warn", code: "harness.component_outdated", target, message: `component ${component} differs from the current CLI template; run ipa harness update ${target}` });
      }
      if (!existsSync(resolve(vaultPath, entry.path))) issues.push({ severity: "error", code: "harness.manifest_missing", target, message: `missing ${entry.path}` });
      if (!existsSync(join(harnessRoot(vaultPath), target, "guard.mjs"))) issues.push({ severity: "warn", code: "harness.guard_missing", target, message: "guard script is missing" });
      if (componentSelected(selected, "skill") && managedFileState(spec.skillFile) === "missing") {
        issues.push({ severity: "warn", code: "harness.global_skill_missing", target, message: `missing managed IPA skill at ${spec.adapter.skillDisplayPath}` });
      }
      for (const [component, script] of Object.entries(HARNESS_HOOK_COMPONENT_TO_SCRIPT)) {
        if (!componentSelected(selected, component)) continue;
        if (spec.adapter.usesPlugin && spec.pluginFile) {
          if (managedFileState(spec.pluginFile) !== "user" && !pluginHookComponentPresent(spec, component)) {
            issues.push({ severity: "warn", code: `harness.global_${component.replace("hook:", "")}_hook_missing`, target, message: `missing managed ${spec.adapter.displayName} plugin behavior for ${component}` });
          }
        } else if (managedFileState(join(spec.hooksDir, script)) === "missing") {
          issues.push({ severity: "warn", code: `harness.global_${component.replace("hook:", "")}_hook_missing`, target, message: `missing managed hook ${script}` });
        }
      }
      if (!spec.adapter.usesPlugin) {
        const hookComponents = Object.keys(HARNESS_HOOK_COMPONENT_TO_SCRIPT).filter((component) => componentSelected(selected, component));
        let hooksConfig = null;
        if (hookComponents.length) {
          try {
            hooksConfig = JSON.parse(readFileSyncText(spec.hooksConfig) || "{}");
          } catch (error) {
            issues.push({ severity: "error", code: "harness.hooks_config_invalid", target, message: `cannot parse ${spec.adapter.hooksConfigDisplayPath}: ${error.message}` });
          }
        }
        if (hooksConfig) {
          for (const component of hookComponents) {
            const script = HARNESS_HOOK_COMPONENT_TO_SCRIPT[component];
            if (managedFileState(join(spec.hooksDir, script)) === "missing") continue;
            const event = spec.adapter.hookRegistration(component)?.event;
            const registered = (hooksConfig.hooks?.[event] ?? []).some((group) =>
              (group.hooks ?? []).some((hook) => typeof hook.command === "string" && hook.command.includes(script))
            );
            if (!registered) issues.push({ severity: "warn", code: `harness.global_${component.replace("hook:", "")}_hook_unregistered`, target, message: `hook ${script} is installed but not registered under ${event} in ${spec.adapter.hooksConfigDisplayPath}; run ipa harness update ${target}` });
          }
        }
      }
      if (spec.adapter.usesPlugin && spec.pluginFile && componentSelected(selected, "opencode-plugin") && managedFileState(spec.pluginFile) === "missing") {
        issues.push({ severity: "warn", code: "harness.global_opencode_plugin_missing", target, message: `missing managed ${spec.adapter.displayName} plugin at ${spec.adapter.manifestGlobal(spec).opencode_plugin}` });
      }
      if (componentSelected(selected, "permissions") && !permissionRulePresent(spec)) {
        issues.push({ severity: "warn", code: "harness.permission_rule_missing", target, message: `missing ${spec.adapter.displayName} permission rule ${spec.adapter.permissionRule} in ${spec.adapter.hooksConfigDisplayPath}; run ipa harness update ${target}` });
      }
      if (componentSelected(selected, "prompt") && !hasManagedFile(spec.globalPromptFile)) {
        issues.push({ severity: "warn", code: "harness.global_prompt_missing", target, message: `missing IPA harness block in ${spec.adapter.promptDisplayPath}` });
      }
      if (componentSelected(selected, "local-prompt") && !hasManagedFile(join(vaultPath, entry.local_prompt ?? spec.localPrompt))) {
        issues.push({ severity: "warn", code: "harness.local_prompt_missing", target, message: `missing IPA harness block in ${entry.local_prompt ?? spec.localPrompt}; run ipa harness update ${target}` });
      }
      if (componentSelected(selected, "local-skills")) {
        for (const skill of deps.localSkills) {
          const relPath = deps.vaultLocalSkillRelPath(spec, skill.name);
          if (managedFileState(join(vaultPath, relPath)) === "missing") {
            issues.push({ severity: "warn", code: "harness.local_skill_missing", target, message: `missing managed vault-local skill ${relPath}` });
          }
        }
      }
      if (componentSelected(selected, "plugin-scaffold")) {
        const scaffold = deps.pluginScaffoldStatus(vaultPath);
        if (!scaffold.jsconfig || !scaffold.types || !scaffold.rules_dir || !scaffold.search_dir) {
          issues.push({ severity: "warn", code: "harness.plugin_scaffold_missing", target, message: "missing .ipa/plugins authoring scaffold; run ipa harness init or ipa plugin init" });
        }
      }
    }
    return { status: issues.some((item) => item.severity === "error") ? "error" : "ok", installed: Object.keys(index.targets ?? {}), issues };
  };

  return { status, install, uninstall, update, doctor };
}

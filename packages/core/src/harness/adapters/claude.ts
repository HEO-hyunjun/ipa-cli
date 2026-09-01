import { join } from "node:path";
import { HARNESS_COMPONENTS } from "../model.js";
import { hookRegistration, hookSpecificOutput } from "../shared/hookConfig.js";

const validComponents = HARNESS_COMPONENTS.filter((component) => component !== "opencode-plugin");
const permissionRule = "Bash(ipa *)";

export const claudeAdapter = {
  id: "claude",
  displayName: "Claude Code",
  skillDisplayPath: "~/.claude/skills/ipa/SKILL.md",
  hooksConfigDisplayPath: "~/.claude/settings.json",
  promptDisplayPath: "~/.claude/CLAUDE.md",
  localSkillsRoot: ".claude/skills",
  validComponents,
  defaultComponents: [...validComponents],
  usesPlugin: false,
  targetSpec(homeBase) {
    const home = join(homeBase, ".claude");
    return {
      name: this.id,
      adapter: this,
      home,
      skillFile: join(home, "skills", "ipa", "SKILL.md"),
      hooksDir: join(home, "hooks"),
      hooksConfig: join(home, "settings.json"),
      localPrompt: "CLAUDE.md",
      globalPromptFile: join(home, "CLAUDE.md"),
      pluginFile: null
    };
  },
  completeSelection(selected) {
    return selected;
  },
  hookRegistration,
  permissionRule,
  applyPermissions(config) {
    if (!config.permissions || typeof config.permissions !== "object") config.permissions = {};
    if (!Array.isArray(config.permissions.allow)) config.permissions.allow = [];
    if (!config.permissions.allow.includes(permissionRule)) config.permissions.allow.push(permissionRule);
  },
  removePermissions(config) {
    if (!config.permissions || !Array.isArray(config.permissions.allow)) return;
    config.permissions.allow = config.permissions.allow.filter((rule) => rule !== permissionRule);
    if (!config.permissions.allow.length) delete config.permissions.allow;
    if (!Object.keys(config.permissions).length) delete config.permissions;
  },
  permissionPresent(config) {
    return Array.isArray(config.permissions?.allow) && config.permissions.allow.includes(permissionRule);
  },
  pluginMarker() {
    return null;
  },
  manifestGlobal(spec) {
    return {
      home: "~/.claude",
      skill: "~/.claude/skills/ipa/SKILL.md",
      hooks_config: "~/.claude/settings.json",
      prompt: `~/.claude/${spec.localPrompt}`,
      opencode_plugin: null
    };
  },
  userPromptOutput(messageExpression) {
    return hookSpecificOutput("UserPromptSubmit", messageExpression);
  },
  stopBlockOutput(messageExpression) {
    return `{ decision: "block", reason: ${messageExpression}, hookSpecificOutput: { hookEventName: "Stop", additionalContext: ${messageExpression} } }`;
  },
  stopNoticeOutput(messageExpression) {
    return hookSpecificOutput("Stop", messageExpression);
  }
};

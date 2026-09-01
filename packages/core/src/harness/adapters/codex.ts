import { join } from "node:path";
import { HARNESS_COMPONENTS } from "../model.js";
import { hookRegistration } from "../shared/hookConfig.js";

const validComponents = HARNESS_COMPONENTS.filter((component) => component !== "opencode-plugin" && component !== "permissions");

export const codexAdapter = {
  id: "codex",
  displayName: "Codex",
  skillDisplayPath: "~/.codex/skills/ipa/SKILL.md",
  hooksConfigDisplayPath: "~/.codex/hooks.json",
  promptDisplayPath: "~/.codex/AGENTS.md",
  localSkillsRoot: ".agents/skills",
  validComponents,
  defaultComponents: [...validComponents],
  usesPlugin: false,
  targetSpec(homeBase) {
    const home = join(homeBase, ".codex");
    return {
      name: this.id,
      adapter: this,
      home,
      skillFile: join(home, "skills", "ipa", "SKILL.md"),
      hooksDir: join(home, "hooks"),
      hooksConfig: join(home, "hooks.json"),
      localPrompt: "AGENTS.md",
      globalPromptFile: join(home, "AGENTS.md"),
      pluginFile: null
    };
  },
  completeSelection(selected) {
    return selected;
  },
  hookRegistration,
  applyPermissions() {},
  removePermissions() {},
  permissionPresent() {
    return false;
  },
  pluginMarker() {
    return null;
  },
  manifestGlobal(spec) {
    return {
      home: "~/.codex",
      skill: "~/.codex/skills/ipa/SKILL.md",
      hooks_config: "~/.codex/hooks.json",
      prompt: `~/.codex/${spec.localPrompt}`,
      opencode_plugin: null
    };
  },
  userPromptOutput(messageExpression) {
    return `{ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ${messageExpression} } }`;
  },
  stopBlockOutput(messageExpression) {
    return `{ decision: "block", reason: ${messageExpression} }`;
  },
  stopNoticeOutput(messageExpression) {
    return `{ systemMessage: ${messageExpression} }`;
  }
};

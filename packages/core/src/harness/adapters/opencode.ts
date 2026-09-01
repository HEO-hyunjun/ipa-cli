import { join } from "node:path";
import { HARNESS_COMPONENTS } from "../model.js";

const invalidComponents = new Set(["hook:call-counter", "hook:vault-ref", "permissions"]);
const validComponents = HARNESS_COMPONENTS.filter((component) => !invalidComponents.has(component));
const defaultComponents = [
  "skill",
  "prompt",
  "local-prompt",
  "hook:session-env",
  "hook:guard",
  "hook:markdown-nudge",
  "hook:formatter-gate"
];

const pluginMarkers = {
  "hook:session-env": 'hooks["shell.env"]',
  "hook:guard": 'hooks["tool.execute.before"]',
  "hook:markdown-nudge": 'hooks["tool.execute.after"]',
  "hook:call-counter": "callCounterHandler",
  "hook:formatter-gate": "runSessionGate",
  "hook:evidence": "evidenceHandler"
};

export const opencodeAdapter = {
  id: "opencode",
  displayName: "OpenCode",
  skillDisplayPath: "~/.config/opencode/skills/ipa/SKILL.md",
  hooksConfigDisplayPath: "~/.config/opencode/settings.json",
  promptDisplayPath: "~/.config/opencode/AGENTS.md",
  localSkillsRoot: ".opencode/skills",
  validComponents,
  defaultComponents,
  usesPlugin: true,
  targetSpec(homeBase) {
    const home = join(homeBase, ".config", "opencode");
    return {
      name: this.id,
      adapter: this,
      home,
      skillFile: join(home, "skills", "ipa", "SKILL.md"),
      hooksDir: join(home, "hooks"),
      hooksConfig: join(home, "settings.json"),
      localPrompt: "AGENTS.md",
      globalPromptFile: join(home, "AGENTS.md"),
      pluginFile: join(home, "plugins", "ipa-harness.js")
    };
  },
  completeSelection(selected) {
    const completed = [...selected];
    if (completed.some((component) => component.startsWith("hook:")) && !completed.includes("opencode-plugin")) {
      completed.push("opencode-plugin");
    }
    return completed;
  },
  hookRegistration() {
    return null;
  },
  applyPermissions() {},
  removePermissions() {},
  permissionPresent() {
    return false;
  },
  pluginMarker(component) {
    return pluginMarkers[component] ?? null;
  },
  manifestGlobal() {
    return {
      home: "~/.config/opencode",
      skill: "~/.config/opencode/skills/ipa/SKILL.md",
      hooks_config: "~/.config/opencode/settings.json",
      prompt: "~/.config/opencode/AGENTS.md",
      opencode_plugin: "~/.config/opencode/plugins/ipa-harness.js"
    };
  },
  userPromptOutput(messageExpression) {
    return messageExpression;
  },
  stopBlockOutput(messageExpression) {
    return messageExpression;
  },
  stopNoticeOutput(messageExpression) {
    return messageExpression;
  }
};

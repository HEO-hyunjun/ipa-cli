#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Table from "cli-table3";
import { Command } from "commander";
import * as colors from "yoctocolors";
import {
  REFACTORS,
  buildContext,
  cacheClean,
  cacheDoctor,
  cacheInspect,
  cacheStatus,
  contractExportFixtures,
  contractList,
  contractValidate,
  contractValidateOutput,
  doctor,
  formatVault,
  harnessDoctor,
  harnessGuardCheck,
  harnessGuardStatus,
  harnessInstall,
  harnessStatus,
  harnessUninstall,
  inboxAdd,
  inboxTriage,
  linkApply,
  linkPlan,
  listPlugins,
  listProfiles,
  listRules,
  listSearchChannels,
  moveNote,
  pluginDoctor,
  pluginDryRun,
  rebuildCache,
  refactorVault,
  renameNote,
  resolveSettings,
  reviewVault,
  searchVault,
  setDefaultProfile,
  traversal,
  tuneAnalyze,
  tuneEval,
  tuneLabel,
  tuneList,
  tuneLog,
  tuneReplay,
  tuneRun,
  tuneTestsetAdd,
  tuneTestsetDraft,
  tuneTestsetList,
  tuneTestsetShow,
  tuneTestsetValidate,
  tuneUse,
  validatePlugin,
  validateVault,
  viewNote
} from "../../core/dist/index.js";

const COMMAND_GROUPS = [
  {
    title: "Core commands",
    rows: [
      ["search", "Search notes with active weights and plugins"],
      ["view", "Show note overview, section, or full content"],
      ["traversal", "Walk refs, backlinks, siblings, and roots"],
      ["validator", "Validate IPA frontmatter and links"],
      ["context", "Build note context for an agent prompt"]
    ]
  },
  {
    title: "Operations",
    rows: [
      ["formatter", "Plan or apply formatting fixes"],
      ["refactor", "Rewrite tags, refs, and wikilinks"],
      ["rename / move", "Rename or move notes"],
      ["inbox", "Add or triage inbox notes"],
      ["link", "Suggest, plan, and apply wikilinks"],
      ["review", "Audit inbox, indexes, tags, and duplicates"]
    ]
  },
  {
    title: "Runtime",
    rows: [
      ["config / profile", "Inspect config and profile resolution"],
      ["engine", "Inspect and run search engine channels"],
      ["tune", "Evaluate and run the tpe-lite optimizer"],
      ["cache", "Rebuild, inspect, and diagnose vault cache"],
      ["plugin", "List, validate, and dry-run vault plugins"],
      ["contract", "Validate runtime contract fixtures"],
      ["harness", "Install, uninstall, and inspect AI harness hooks"]
    ]
  }
];

const PRETTY = Boolean((process.stdout.isTTY || process.env.IPA_FORCE_PRETTY === "1") && !process.env.NO_COLOR);

const HELP = formatHelp();
const COMMAND_HELP = {
  cache: formatDetailedHelp({
    usage: "ipa [OPTIONS] cache status|rebuild|clean|inspect|doctor [ARGS...]",
    summary: "Inspect and maintain the vault-local parsed cache.",
    commands: [
      ["ipa cache status", "Show stale cache entries"],
      ["ipa cache rebuild", "Rebuild manifest, files, and graph cache"],
      ["ipa cache inspect --note NOTE", "Inspect cache data for one note"],
      ["ipa cache doctor", "Diagnose cache/plugin fingerprint state"],
      ["ipa cache clean", "Remove cache artifacts"]
    ]
  }),
  config: formatDetailedHelp({
    usage: "ipa [OPTIONS] config show",
    summary: "Show the resolved vault/profile context for the current command.",
    examples: [
      ["ipa config show", "Use project-local selector/default profile"],
      ["ipa --profile work config show", "Show a named profile context"]
    ]
  }),
  convention: formatDetailedHelp({
    usage: "ipa [OPTIONS] convention check",
    summary: "Compatibility alias for validator checks.",
    examples: [
      ["ipa convention check", "Run the active vault validator"]
    ]
  }),
  context: formatDetailedHelp({
    usage: "ipa [OPTIONS] context QUERY [--by-note] [--size small|medium|large|full] [--format json|markdown]",
    summary: "Build a compact note-centered context pack for agent prompts.",
    options: [
      ["--by-note", "Treat QUERY as a note title instead of a search query"],
      ["--size NAME", "Context budget preset: small, medium, large, or full"],
      ["--max-notes N", "Override selected primary note count"],
      ["--max-chars N", "Override the target character budget"],
      ["--format json", "Print structured JSON"],
      ["--format markdown", "Print a markdown context pack"]
    ],
    examples: [
      ["ipa context \"ipa cli\"", "Search and assemble a medium context pack"],
      ["ipa context \"Alpha\" --by-note", "Build context around one note"],
      ["ipa context \"Alpha\" --by-note --size small --format markdown", "Hook-friendly compact context"]
    ]
  }),
  contract: formatDetailedHelp({
    usage: "ipa [OPTIONS] contract list|validate|validate-output|export-fixtures",
    summary: "Validate runtime contract fixtures and exported command output.",
    commands: [
      ["ipa contract list", "List known contracts"],
      ["ipa contract validate FILE", "Validate a contract fixture"],
      ["ipa contract validate-output COMMAND FILE", "Validate command output"],
      ["ipa contract export-fixtures", "Export current fixture contracts"]
    ]
  }),
  doctor: formatDetailedHelp({
    usage: "ipa [OPTIONS] doctor [--fix-dirs] [--check NAME]",
    summary: "Run basic vault setup checks.",
    options: [
      ["--fix-dirs", "Create missing expected directories"],
      ["--check NAME", "Run one check"]
    ]
  }),
  engine: formatDetailedHelp({
    usage: "ipa [OPTIONS] engine search|channels [ARGS...]",
    summary: "Inspect low-level search engine behavior.",
    commands: [
      ["ipa engine search \"query\" --explain", "Run search with threshold 0"],
      ["ipa engine channels", "List active search channels"]
    ]
  }),
  formatter: formatDetailedHelp({
    usage: "ipa [OPTIONS] formatter plan|apply [--note NOTE...]",
    summary: "Plan or apply fixes from active builtin and vault-local rules.",
    commands: [
      ["ipa formatter plan", "Preview all formatter patches"],
      ["ipa formatter apply", "Apply all formatter patches"],
      ["ipa formatter plan --note \"A\" \"B\"", "Preview patches for selected notes only"],
      ["ipa formatter apply --note \"A\"", "Apply patches for one note"]
    ]
  }),
  harness: formatDetailedHelp({
    usage: "ipa [OPTIONS] harness status|install|uninstall|doctor|guard",
    summary: "Install and inspect AI harness skills/hooks.",
    commands: [
      ["ipa harness status", "Show installed target state"],
      ["ipa harness install codex", "Install Codex skill/hooks and vault prompt block"],
      ["ipa harness uninstall codex", "Remove Codex harness files"],
      ["ipa harness doctor", "Validate installed harness files"],
      ["ipa harness guard check PATH --action create", "Check inbox-only write policy"]
    ]
  }),
  inbox: formatDetailedHelp({
    usage: "ipa [OPTIONS] inbox add|triage [ARGS...]",
    summary: "Create or triage inbox notes.",
    commands: [
      ["ipa inbox add ./draft.md --title \"Title\"", "Import a draft into the configured inbox"],
      ["ipa inbox triage", "Suggest refs/tags for inbox notes"],
      ["ipa inbox triage --apply --note \"Title\"", "Apply triage to one note"]
    ]
  }),
  link: formatDetailedHelp({
    usage: "ipa [OPTIONS] link suggest|plan|apply [ARGS...]",
    summary: "Suggest, persist, and apply wikilink edits.",
    commands: [
      ["ipa link suggest NOTE", "Suggest links for one note"],
      ["ipa link plan --note NOTE", "Write a guarded link plan"],
      ["ipa link apply .ipa/plans/link.json", "Apply a saved plan"]
    ]
  }),
  plugin: formatDetailedHelp({
    usage: "ipa [OPTIONS] plugin list|doctor|validate|dry-run [ARGS...]",
    summary: "Inspect and test vault-local JS plugins.",
    commands: [
      ["ipa plugin list", "List enabled plugins"],
      ["ipa plugin doctor", "Validate all plugin contracts"],
      ["ipa plugin validate .ipa/plugins/search/x.js", "Validate one plugin file"],
      ["ipa plugin dry-run search .ipa/plugins/search/x.js --query Alpha", "Run a search plugin without installing changes"],
      ["ipa plugin dry-run rules .ipa/plugins/rules/x.js --note Alpha", "Preview rule issues and fixes"]
    ]
  }),
  profile: formatDetailedHelp({
    usage: "ipa profile list|current|use NAME",
    summary: "Inspect and update the machine-local profile registry.",
    commands: [
      ["ipa profile list", "List configured profiles"],
      ["ipa profile current", "Show the default profile"],
      ["ipa profile use work", "Mark a profile as default"]
    ]
  }),
  refactor: formatDetailedHelp({
    usage: "ipa [OPTIONS] refactor COMMAND [ARGS...] [--apply]",
    summary: "Plan or apply refs, tags, and wikilink rewrites.",
    commands: [
      ["ipa refactor tag-rename old new", "Preview a tag rename"],
      ["ipa refactor tag-rename old new --apply", "Apply a tag rename"],
      ["ipa refactor ref-replace old new --apply", "Replace frontmatter refs"],
      ["ipa refactor wikilink-replace old new --apply", "Replace body wikilinks"]
    ]
  }),
  rename: formatDetailedHelp({
    usage: "ipa [OPTIONS] rename OLD NEW [--apply]",
    summary: "Rename a note and update links when applied.",
    examples: [
      ["ipa rename \"Old\" \"New\"", "Preview rename"],
      ["ipa rename \"Old\" \"New\" --apply", "Apply rename"]
    ]
  }),
  move: formatDetailedHelp({
    usage: "ipa [OPTIONS] move NOTE TARGET [--apply]",
    summary: "Move a note to a target directory and update links when applied.",
    examples: [
      ["ipa move \"Note\" \"02 Archive\"", "Preview move"],
      ["ipa move \"Note\" \"02 Archive\" --apply", "Apply move"]
    ]
  }),
  review: formatDetailedHelp({
    usage: "ipa [OPTIONS] review [all|inbox|indexes|tags|duplicates] [--suggest-refactor]",
    summary: "Audit vault structure and surface cleanup/refactor candidates.",
    examples: [
      ["ipa review all", "Run all read-only audits"],
      ["ipa review duplicates", "Find duplicate-looking notes"],
      ["ipa review all --suggest-refactor", "Include refactor suggestions"]
    ]
  }),
  search: formatDetailedHelp({
    usage: "ipa [OPTIONS] search QUERY [--max N] [--threshold N] [--all] [--json]",
    summary: "Search notes with active weights, tune result, and vault-local search plugins.",
    options: [
      ["--max N", "Maximum result count"],
      ["--threshold N", "Minimum score threshold"],
      ["--all", "Show all scored notes by forcing threshold 0"],
      ["--json", "Print structured output"]
    ],
    examples: [
      ["ipa search \"ipa cli\"", "Search the active vault"],
      ["ipa search \"graph\" --max 20", "Return more results"],
      ["ipa search \"Alpha\" --json", "Use machine-readable output"]
    ]
  }),
  traversal: formatDetailedHelp({
    usage: "ipa [OPTIONS] traversal [--up|--down|--siblings|--root] NOTE",
    summary: "Walk the ref graph around a note.",
    options: [
      ["--up NOTE", "Show note -> index -> root paths"],
      ["--down NOTE", "Show a child tree"],
      ["--siblings NOTE", "Show notes with the same parent"],
      ["--root NOTE", "Show root note(s)"]
    ]
  }),
  tune: formatTuneHelp(),
  validator: formatDetailedHelp({
    usage: "ipa [OPTIONS] validator [--json]",
    summary: "Validate active IPA notes after applying files.exclude.",
    examples: [
      ["ipa validator", "Human-readable issue report"],
      ["ipa validator --json", "Machine-readable issue payload"]
    ]
  }),
  view: formatDetailedHelp({
    usage: "ipa [OPTIONS] view NOTE [--full] [--section HEADING]",
    summary: "Show a note overview, section, or full body while preserving display names.",
    options: [
      ["--full", "Show the full note body and footer"],
      ["--section HEADING", "Show one markdown section"]
    ],
    examples: [
      ["ipa view \"Note Title\"", "Show structure overview"],
      ["ipa view \"Note Title\" --full", "Show full content"],
      ["ipa view \"Note Title\" --section \"Details\"", "Show one section"]
    ]
  })
};

async function settings(global) {
  return resolveSettings(global);
}

function print(payload, json = false) {
  if (json) console.log(JSON.stringify(payload, null, 2));
  else if (typeof payload === "string") console.log(payload);
  else console.log(render(payload));
}

function formatHelp() {
  const lines = [
    styleTitle("Usage: ipa [OPTIONS] COMMAND [ARGS...]"),
    "",
    "IPA vault CLI - JS/TS runtime.",
    "",
    styleSection("Options:"),
    formatRows([
      ["--profile NAME", "Use a profile from ~/.config/ipa/profile.yaml"],
      ["--vault PATH", "Use a vault path directly"],
      ["--json", "Print machine-readable JSON"],
      ["--help", "Show this help message"]
    ]),
    ""
  ];
  for (const group of COMMAND_GROUPS) {
    lines.push(styleSection(`${group.title}:`), formatRows(group.rows), "");
  }
  lines.push(styleSection("Examples:"));
  lines.push(formatRows([
    ["ipa search \"ipa cli\"", "Search the active vault"],
    ["ipa --profile ipa-test review all", "Run a read-only review on a test profile"],
    ["ipa plugin dry-run search .ipa/plugins/search/custom.js --query Alpha", "Test a vault plugin"]
  ]));
  lines.push("", styleMuted("Run `ipa <command> --help` for command-specific help."));
  return `${lines.join("\n")}\n`;
}

function formatCommandHelp(command) {
  return COMMAND_HELP[command] ?? `${HELP}\nNo detailed help is available for '${command}' yet.\n`;
}

function formatDetailedHelp({ usage, summary, commands = [], options = [], examples = [], notes = [] }) {
  const lines = [
    styleTitle(`Usage: ${usage}`),
    "",
    summary
  ];
  if (commands.length) lines.push("", styleSection("Commands:"), formatRows(commands));
  if (options.length) lines.push("", styleSection("Options:"), formatRows(options));
  if (examples.length) lines.push("", styleSection("Examples:"), formatRows(examples));
  if (notes.length) lines.push("", styleSection("Notes:"), ...notes.map((note) => `  ${note}`));
  lines.push("");
  return lines.join("\n");
}

function formatTuneHelp() {
  return [
    styleTitle("Usage: ipa [OPTIONS] tune [SUBCOMMAND] [ARGS...]"),
    "",
    "Evaluate search quality and run the tpe-lite optimizer against the active vault testset.",
    "",
    styleSection("Common commands:"),
    formatRows([
      ["ipa tune eval", "Evaluate current active search params"],
      ["ipa tune --trials 100", "Run 100 tpe-lite trials and save a result JSON"],
      ["ipa tune --trials 100 --apply", "Run tuning and activate the new result"],
      ["ipa tune list", "List saved tune result JSON files"],
      ["ipa tune use FILE", "Activate an existing tune result"],
      ["ipa tune analyze", "Inspect threshold candidates and target scores"],
      ["ipa tune replay [FILE]", "Replay saved trial history against the current vault"],
      ["ipa tune testset list", "List vault-local testsets"],
      ["ipa tune testset show", "Show the active testset"],
      ["ipa tune testset validate", "Validate testset targets"],
      ["ipa tune pack eval ipa-cli-core", "Evaluate the built-in sample pack"]
    ]),
    "",
    styleSection("Run options:"),
    formatRows([
      ["--trials N, -n N", "Number of tpe-lite trials; default 20"],
      ["--pack NAME", "Use a built-in query pack instead of the vault-local testset"],
      ["--seed N", "Deterministic optimizer seed; default 42"],
      ["--apply", "Activate the generated result by writing weights.file"],
      ["--quiet", "Suppress progress output"],
      ["--json", "Print machine-readable JSON; progress is suppressed"]
    ]),
    "",
    styleSection("Vault setup:"),
    "  Configure the default testset in {vault}/.ipa/config.yaml:",
    "",
    "  test:",
    "    file: .ipa/tune/testsets/testset.json",
    "",
    styleSection("Progress:"),
    "  Long runs print trial progress to stderr: completed/trials, percent, current loss, best loss, elapsed, and ETA.",
    ""
  ].join("\n");
}

function colorize(text, apply) {
  return PRETTY ? apply(String(text)) : String(text);
}

function styleTitle(text) {
  return colorize(text, (value) => colors.cyan(colors.bold(value)));
}

function styleSection(text) {
  return colorize(text, (value) => colors.magenta(colors.bold(value)));
}

function styleMuted(text) {
  return colorize(text, colors.dim);
}

function styleGood(text) {
  return colorize(text, colors.green);
}

function styleWarn(text) {
  return colorize(text, colors.yellow);
}

function styleBad(text) {
  return colorize(text, colors.red);
}

function styleStatus(status) {
  if (String(status).toLowerCase() === "ok" || String(status).toLowerCase() === "installed") return styleGood(status);
  if (String(status).toLowerCase() === "error" || String(status).toLowerCase() === "failed") return styleBad(status);
  return styleWarn(status);
}

function render(payload) {
  if (Array.isArray(payload)) return payload.map(render).join("\n");
  if (!payload || typeof payload !== "object") return String(payload ?? "");
  if (payload.results && Object.hasOwn(payload, "query")) return renderSearchResults(payload);
  if (payload.pack && Object.hasOwn(payload, "misses")) return renderTuneEval(payload);
  if (payload.optimizer && payload.best) return renderTuneRun(payload);
  if (payload.thresholds && payload.target_scores) return renderTuneAnalyze(payload);
  if (Object.hasOwn(payload, "replayed")) return renderTuneReplay(payload);
  if (payload.testsets) return renderTableReport("Tune testsets", ["Active", "File"], payload.testsets.map((item) => [payload.active === item ? "yes" : "", item]));
  if (Object.hasOwn(payload, "allowed")) return renderKeyValues("Harness guard", payload);
  if (payload.installed && payload.guard) return renderHarnessStatus(payload);
  if (payload.target && Object.hasOwn(payload, "installed") && (payload.files || payload.removed)) return renderHarnessChange(payload);
  if (payload.issues) return renderIssues(payload);
  if (payload.plugins) return renderPlugins(payload);
  if (payload.paths || payload.tree || payload.roots || payload.siblings) return renderTraversal(payload);
  if (payload.notes && payload.sources) return renderContext(payload);
  if (payload.channels) return renderChannels(payload.channels);
  if (payload.rules) return renderRules(payload.rules);
  if (payload.refactors) return renderRefactors(payload.refactors);
  if (payload.profile !== undefined && payload.vault_path) return renderKeyValues("Active config", payload);
  if (payload.status && payload.checks) return renderDoctor(payload);
  if (payload.suggestions) return renderTableReport("Link suggestions", ["Note", "Target", "Reason"], payload.suggestions.map((item) => [item.note, item.target, item.reason]));
  if (payload.changes) return renderTableReport("Planned changes", ["Note", "Path", "Target"], payload.changes.map((item) => [item.note ?? "-", item.path ?? "-", item.target ?? item.to ?? "-"]));
  return JSON.stringify(payload, null, 2);
}

function renderSearchResults(payload) {
  const lines = PRETTY
    ? [
        styleTitle(`Search results for '${payload.query}'`),
        styleMuted(`${payload.count} notes  threshold ${payload.threshold}  max ${payload.max_results}`)
      ]
    : [`Search results for '${payload.query}': ${payload.count} notes (threshold ${payload.threshold})`];
  if (!payload.results.length) return `${lines.join("\n")}\n${styleWarn("No results.")}`;
  if (PRETTY) {
    lines.push("", table(["Score", "Type", "Note", "Refs"], payload.results.map((hit) => [
      Number(hit.score).toFixed(3),
      hit.type ?? "?",
      hit.note,
      hit.refs?.join(", ") ?? ""
    ])));
  } else {
    for (const hit of payload.results) {
      const refs = hit.refs?.length ? `  ref→ ${hit.refs.join(", ")}` : "";
      lines.push(`  [ ${Number(hit.score).toFixed(1)}] [${String(hit.type ?? "?").padEnd(5)}] ${hit.note}${refs}`);
    }
  }
  if (payload.ref_distribution?.length) {
    lines.push("", styleSection("결과 노트들의 소속 인덱스/ref 분포 (2건 이상)"));
    if (PRETTY) lines.push(table(["Count", "Ref"], payload.ref_distribution.map((item) => [item.count, item.ref])));
    else {
      for (const item of payload.ref_distribution) {
        lines.push(`${String(item.count).padStart(4)}건  ${item.ref}`);
      }
    }
    lines.push("→ 2건+ 인덱스는 `ipa view \"노트명\"` 또는 `ipa traversal --down \"인덱스명\"` 권장");
  }
  return lines.join("\n");
}

function renderTuneEval(payload) {
  const lines = [
    styleTitle("Tune evaluation"),
    `Pack: ${payload.pack}   Total: ${payload.total}   Hits: ${payload.hits}   Misses: ${payload.misses}   Avg rank: ${payload.avg_rank ?? "-"}`
  ];
  const rows = (payload.rows ?? []).map((row) => [
    row.query,
    row.target,
    row.rank ?? "-",
    row.hit ? "yes" : "no"
  ]);
  if (rows.length) lines.push("", table(["Query", "Target", "Rank", "Hit"], rows));
  return lines.join("\n");
}

function renderTuneRun(payload) {
  const best = payload.best ?? {};
  const lines = [
    styleTitle("Tune run"),
    `Optimizer: ${payload.optimizer}   Trials: ${payload.trials}   Pack: ${payload.pack ?? "-"}`,
    `Best trial: ${best.trial ?? "-"}   Loss: ${best.loss ?? "-"}`,
    `Elapsed: ${formatDuration(payload.elapsed_ms)}   Result file: ${payload.result_file ?? "-"}`
  ];
  if (payload.active) lines.push(`Active weights: ${payload.active}`);
  return lines.join("\n");
}

function renderTuneAnalyze(payload) {
  const lines = [
    styleTitle("Tune analysis"),
    `Pack: ${payload.pack}   Suggested threshold: ${payload.suggested_threshold ?? "-"}   Best threshold: ${payload.best_threshold ?? "-"}`
  ];
  if (payload.thresholds?.length) {
    lines.push("", table(["Threshold", "Hits", "Misses", "Avg rank", "Loss"], payload.thresholds.map((row) => [
      row.threshold,
      row.hits,
      row.misses,
      row.avg_rank ?? "-",
      row.loss
    ])));
  }
  if (payload.target_scores?.length) {
    lines.push("", table(["Query", "Target", "Rank", "Score"], payload.target_scores.map((row) => [
      row.query,
      row.target,
      row.rank ?? "-",
      row.score ?? "-"
    ])));
  }
  return lines.join("\n");
}

function renderTuneReplay(payload) {
  const lines = [
    styleTitle("Tune replay"),
    `Source: ${payload.source}   Replayed: ${payload.replayed}   Changed: ${payload.changed}`
  ];
  if (payload.rows?.length) {
    lines.push("", table(["Trial", "Previous", "Current", "Hits", "Misses"], payload.rows.map((row) => [
      row.trial,
      row.previous_loss ?? "-",
      row.loss,
      row.hits,
      row.misses
    ])));
  }
  return lines.join("\n");
}

function renderIssues(payload) {
  const title = payload.summary?.patches !== undefined ? "Formatter report" : "Issues";
  const lines = [styleTitle(title)];
  if (payload.status) lines.push(`Status: ${styleStatus(payload.status)}`);
  if (payload.summary) {
    lines.push(`Summary: ${Object.entries(payload.summary).map(([key, value]) => `${key}=${value}`).join(" ")}`);
  }
  if (payload.patches?.length) {
    lines.push("", table(["Note", "Path", "Plugin"], payload.patches.map((item) => [item.note ?? "-", item.path ?? "-", item.plugin ?? "-"])));
  }
  if (!payload.issues.length) {
    lines.push("", styleGood("No issues."));
    return lines.join("\n");
  }
  lines.push("", table(["Severity", "Code", "Note", "Message"], payload.issues.map((item) => [
    item.severity ?? "info",
    item.code ?? "-",
    item.note ?? "-",
    item.message ?? "-"
  ])));
  return lines.join("\n");
}

function renderPlugins(payload) {
  if (!payload.plugins.length) return `${styleTitle("Plugins")}\n\n${styleWarn("No enabled plugins.")}`;
  return renderTableReport("Plugins", ["Kind", "Path"], payload.plugins.map((item) => [item.kind, item.path]));
}

function renderTraversal(payload) {
  if (payload.paths) {
    if (!payload.paths.length) return `No upward paths found for '${payload.note ?? ""}'`;
    return [
      `Upward paths from '${payload.note ?? payload.paths[0]?.[0] ?? ""}':`,
      ...payload.paths.map((path, index) => `  ${index + 1}. ${path.join(" → ")}`)
    ].join("\n");
  }
  if (payload.tree) {
    return [`Tree from '${payload.note ?? payload.tree.note}':`, ...renderLegacyTree(payload.tree)].join("\n");
  }
  if (payload.siblings) {
    if (!payload.siblings.length) return `No siblings found for '${payload.note ?? ""}'`;
    return [`Siblings of '${payload.note ?? ""}':`, ...payload.siblings.map((note) => `  - ${note}`)].join("\n");
  }
  if (payload.roots) {
    if (!payload.roots.length) return `No root found for '${payload.note ?? ""}'`;
    return [`Root(s) for '${payload.note ?? ""}':`, ...payload.roots.map((note) => `  - ${note}`)].join("\n");
  }
  return JSON.stringify(payload, null, 2);
}

function renderContext(payload) {
  const lines = [
    styleTitle("Context"),
    `Query: ${payload.query}   Mode: ${payload.mode ?? "search"}   Size: ${payload.size ?? "medium"}   Notes: ${payload.notes.length}`,
    ""
  ];
  const rows = payload.notes.map((note) => [
    note.id,
    note.type || "?",
    note.path,
    note.score === null || note.score === undefined ? "-" : Number(note.score).toFixed(2)
  ]);
  if (rows.length) lines.push(table(["Note", "Type", "Path", "Score"], rows));
  for (const note of payload.notes) {
    lines.push("", `## ${note.id}`, `type: ${note.type || "?"}`, `path: ${note.path}`);
    if (note.refs?.length) lines.push(`refs: ${note.refs.join(", ")}`);
    if (note.tags?.length) lines.push(`tags: ${note.tags.join(", ")}`);
    if (note.upward_paths?.length) {
      lines.push("upward:");
      for (const path of note.upward_paths) lines.push(`  - ${path.join(" -> ")}`);
    }
    for (const [label, items] of [
      ["backlinks", note.backlinks],
      ["siblings", note.siblings],
      ["outlinks", note.outlinks],
      ["children", note.children]
    ]) {
      if (!items?.length) continue;
      lines.push(`${label}:`);
      for (const item of items) lines.push(`  - ${item.id} [${item.type || "?"}] ${item.path}`);
    }
    if (note.excerpt) lines.push("excerpt:", indentBlock(note.excerpt, "  "));
  }
  if (payload.next_commands?.length) lines.push("", "Next commands:", ...payload.next_commands.map((command) => `  ${command}`));
  if (payload.warnings?.length) lines.push("", renderIssues({ issues: payload.warnings }));
  return truncateRenderedContext(lines.join("\n"), payload.budget?.max_chars);
}

function indentBlock(text, prefix) {
  return String(text ?? "").split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function truncateRenderedContext(text, maxChars) {
  if (!Number.isFinite(Number(maxChars)) || text.length <= Number(maxChars)) return text;
  const suffix = "\n\n...context truncated. Use `ipa view \"Note Title\" --full` for full source text.";
  return text.slice(0, Math.max(0, Number(maxChars) - suffix.length)).trimEnd() + suffix;
}

function renderChannels(items) {
  const rows = items.map((item) => [
    item.name,
    Number(item.defaultWeight ?? 0).toFixed(4),
    item.enabled === false ? "off" : Number(item.defaultWeight ?? 0).toFixed(4),
    item.description ?? "-"
  ]);
  return renderTableReport(`search channels`, ["name", "weight", "active", "description"], rows);
}

function renderRules(items) {
  const rows = items.map((item) => [
    item.code,
    item.category ?? "-",
    item.severity ?? "-",
    item.scope ?? "-",
    item.fixable ? "yes" : "no",
    item.enabled === false ? "off" : "on",
    item.source ?? "-"
  ]);
  return renderTableReport("validator rules", ["code", "category", "severity", "scope", "fix", "active", "source"], rows);
}

function renderRefactors(items) {
  const descriptions = {
    "ref-replace": "ref 교체 (대상 노트의 ref 배열에서 OLD -> NEW)",
    "tag-rename": "태그 이름 변경 (전체 vault)",
    "tag-remove": "태그 제거",
    "tag-add": "특정 노트에 태그 추가",
    "wikilink-replace": "본문 wikilink 치환",
    "ref-add": "특정 노트에 ref 추가",
    "ref-remove": "특정 노트에서 ref 제거"
  };
  return renderTableReport("refactor commands", ["name", "description"], items.map((item) => [item, descriptions[item] ?? "-"]));
}

function renderDoctor(payload) {
  const lines = [
    styleTitle("Doctor"),
    `Status: ${styleStatus(payload.status)}`,
    "",
    formatRows(Object.entries(payload.checks).map(([key, value]) => [key, String(value)]))
  ];
  if (payload.issues?.length) lines.push("", renderIssues(payload));
  return lines.join("\n");
}

function renderHarnessStatus(payload) {
  const lines = [
    styleTitle("Harness status"),
    "",
    formatRows([
      ["installed", payload.installed.length ? payload.installed.join(", ") : "-"],
      ["manifest", payload.manifest ?? "-"],
      ["guard policy", payload.guard?.policy ?? "-"],
      ["inbox", payload.guard?.inbox_dir ?? "-"],
      ["archive", payload.guard?.archive_dir ?? "-"]
    ])
  ];
  const globalRows = Object.entries(payload.global ?? {}).map(([target, state]) => [
    target,
    state.skill ? "yes" : "no",
    state.guard_hook ? "yes" : "no",
    state.prompt_hook ? "yes" : "no",
    state.markdown_nudge_hook ? "yes" : "no"
  ]);
  if (globalRows.length) lines.push("", table(["target", "skill", "guard", "prompt", "md nudge"], globalRows));
  return lines.join("\n");
}

function renderHarnessChange(payload) {
  const lines = [
    styleTitle(payload.installed ? `Harness install: ${payload.target}` : `Harness uninstall: ${payload.target}`),
    "",
    `Status: ${payload.installed ? styleGood("installed") : styleWarn("removed")}`
  ];
  if (payload.files?.length) lines.push("", "Vault-local files:", ...payload.files.map((file) => `  ${file}`));
  if (payload.global_files?.length) lines.push("", "Global files:", ...payload.global_files.map((file) => `  ${file}`));
  if (payload.removed?.length) lines.push("", "Removed vault-local files:", ...payload.removed.map((file) => `  ${file}`));
  if (payload.global_removed?.length) lines.push("", "Removed global files:", ...payload.global_removed.map((file) => `  ${file}`));
  return lines.join("\n");
}

function renderKeyValues(title, payload) {
  return [styleTitle(title), "", formatRows(Object.entries(payload).map(([key, value]) => [key, String(value ?? "-")]))].join("\n");
}

function renderTableReport(title, headers, rows) {
  if (!rows.length) return `${styleTitle(title)}\n\n${styleWarn("No rows.")}`;
  return `${styleTitle(`${title} (${rows.length})`)}\n\n${table(headers, rows)}`;
}

function table(headers, rows) {
  const stringHeaders = headers.map((header) => String(header ?? ""));
  const stringRows = rows.map((row) => row.map((cell) => String(cell ?? "")));
  if (PRETTY) return boxTable(stringHeaders, stringRows);
  const data = [stringHeaders, ...stringRows];
  const widths = headers.map((_, column) => Math.max(...data.map((row) => row[column]?.length ?? 0)));
  const format = (row) => row.map((cell, column) => String(cell ?? "").padEnd(widths[column])).join("  ").trimEnd();
  return [
    format(stringHeaders),
    format(stringHeaders.map((_, column) => "-".repeat(widths[column]))),
    ...stringRows.map(format)
  ].join("\n");
}

function boxTable(headers, rows) {
  const rendered = new Table({
    head: headers.map((header) => styleMuted(header)),
    style: { head: [], border: [], compact: true },
    wordWrap: true,
    wrapOnWordBoundary: false,
    chars: {
      top: "─",
      "top-mid": "┬",
      "top-left": "╭",
      "top-right": "╮",
      bottom: "─",
      "bottom-mid": "┴",
      "bottom-left": "╰",
      "bottom-right": "╯",
      left: "│",
      "left-mid": "├",
      mid: "─",
      "mid-mid": "┼",
      right: "│",
      "right-mid": "┤",
      middle: "│"
    }
  });
  for (const row of rows) rendered.push(row);
  return rendered.toString();
}

function formatRows(rows) {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${colorize(left.padEnd(width), colors.cyan)}  ${right}`).join("\n");
}

function renderLegacyTree(node, depth = 0) {
  const prefix = depth === 0 ? "" : `${"  ".repeat(depth)}${node.type === "note" ? "📄 " : ""}`;
  const lines = [`${prefix}${node.note}`];
  for (const child of node.children ?? []) lines.push(...renderLegacyTree(child, depth + 1));
  return lines;
}

async function withVault(global, fn) {
  const s = await settings(global);
  return fn(s.vaultPath, s);
}

function globalOptions(program) {
  const options = program.opts();
  return {
    profile: options.profile ?? null,
    vault: options.vault ?? null,
    json: Boolean(options.json)
  };
}

function jsonOutput(program) {
  return Boolean(program.opts().json);
}

function optionNumber(value, fallback = undefined) {
  return value === undefined || value === null ? fallback : Number(value);
}

function collectRepeated(value, previous) {
  return [...previous, value];
}

function optionalList(values) {
  return values?.length ? values : undefined;
}

function setHelp(command, key) {
  command.helpInformation = () => formatCommandHelp(key);
  return command;
}

function buildProgram() {
  const program = new Command();
  program
    .name("ipa")
    .usage("[OPTIONS] COMMAND [ARGS...]")
    .description("IPA vault CLI - JS/TS runtime.")
    .option("--profile <name>", "Use a profile from ~/.config/ipa/profile.yaml")
    .option("--vault <path>", "Use a vault path directly")
    .option("--json", "Print machine-readable JSON")
    .helpOption("--help", "Show this help message")
    .addHelpCommand(false)
    .action(() => {
      console.log(HELP);
    });
  program.helpInformation = () => HELP;

  program
    .command("help")
    .argument("[command]", "Command to describe")
    .description("Show command help")
    .action((command) => {
      console.log(command ? formatCommandHelp(command) : HELP);
    });

  setHelp(program.command("search"), "search")
    .argument("[query...]", "Search query")
    .option("--max <number>", "Maximum result count")
    .option("--threshold <number>", "Minimum score threshold")
    .option("--all", "Show all scored notes by forcing threshold 0")
    .action(async (queryParts, options) => {
      await withVault(globalOptions(program), async (vault) => print(await searchVault(vault, queryParts.join(" "), {
        threshold: optionNumber(options.threshold),
        maxResults: optionNumber(options.max),
        showAll: Boolean(options.all)
      }), jsonOutput(program)));
    });

  setHelp(program.command("view"), "view")
    .argument("<note>", "Note title")
    .option("--full", "Show the full note body and footer")
    .option("--section <heading>", "Show one markdown section")
    .action(async (note, options) => {
      await withVault(globalOptions(program), async (vault) => print(await viewNote(vault, note, {
        full: Boolean(options.full),
        section: options.section ?? null
      })));
    });

  setHelp(program.command("traversal"), "traversal")
    .argument("[note]", "Note title")
    .option("--up <note>", "Show note -> index -> root paths")
    .option("--down <note>", "Show a child tree")
    .option("--siblings <note>", "Show notes with the same parent")
    .option("--root <note>", "Show root note(s)")
    .action(async (noteArg, options) => {
      const mode = options.down ? "down" : options.siblings ? "siblings" : options.root ? "root" : "up";
      const note = options[mode] ?? noteArg;
      await withVault(globalOptions(program), async (vault) => print(await traversal(vault, mode, note), jsonOutput(program)));
    });

  setHelp(program.command("validator"), "validator")
    .action(async () => {
      await withVault(globalOptions(program), async (vault) => print(await validateVault(vault), jsonOutput(program)));
    });

  setHelp(program.command("doctor"), "doctor")
    .option("--fix-dirs", "Create missing expected directories")
    .option("--check <name>", "Run one check")
    .action(async (options) => {
      await withVault(globalOptions(program), async (vault) => print(await doctor(vault, {
        fixDirs: Boolean(options.fixDirs),
        check: options.check
      }), jsonOutput(program)));
    });

  setHelp(program.command("context"), "context")
    .argument("[query...]", "Search query or note title")
    .option("--by-note", "Treat QUERY as a note title instead of a search query")
    .option("--include <mode>", "Include extra context")
    .option("--format <format>", "Output format")
    .option("--size <size>", "Context budget preset")
    .option("--max-notes <number>", "Maximum primary note count")
    .option("--max-chars <number>", "Target character budget")
    .action(async (queryParts, options) => {
      await withVault(globalOptions(program), async (vault) => {
        const payload = await buildContext(vault, queryParts.join(" "), {
          byNote: Boolean(options.byNote),
          full: String(options.include ?? "").includes("full"),
          size: options.size,
          maxNotes: optionNumber(options.maxNotes),
          maxChars: optionNumber(options.maxChars)
        });
        if (options.format === "markdown") {
          print(renderContext(payload));
        } else {
          print(payload, jsonOutput(program) || options.format === "json");
        }
      });
    });

  setHelp(program.command("rename"), "rename")
    .argument("<oldName>", "Current note title")
    .argument("<newName>", "New note title")
    .option("--apply", "Apply the rename")
    .action(async (oldName, newName, options) => {
      await withVault(globalOptions(program), async (vault) => print(await renameNote(vault, oldName, newName, Boolean(options.apply)), jsonOutput(program)));
    });

  setHelp(program.command("move"), "move")
    .argument("<note>", "Note title")
    .argument("<target>", "Target directory")
    .option("--apply", "Apply the move")
    .action(async (note, target, options) => {
      await withVault(globalOptions(program), async (vault) => print(await moveNote(vault, note, target, Boolean(options.apply)), jsonOutput(program)));
    });

  setHelp(program.command("add"), "inbox")
    .argument("<source>", "Source markdown file")
    .option("--title <title>", "Inbox note title")
    .option("--ref <ref>", "Frontmatter ref", collectRepeated, [])
    .option("--tag <tag>", "Frontmatter tag", collectRepeated, [])
    .option("--force", "Overwrite if needed")
    .action(async (source, options) => {
      await withVault(globalOptions(program), async (vault) => print(await inboxAdd(vault, resolve(source), {
        title: options.title,
        refs: optionalList(options.ref),
        tags: optionalList(options.tag),
        force: Boolean(options.force)
      }), jsonOutput(program)));
    });

  setHelp(program.command("refactor"), "refactor")
    .argument("<subcommand>", "Refactor command")
    .argument("[values...]", "Command values")
    .option("--apply", "Apply the refactor")
    .action(async (subcommand, values, options) => {
      await withVault(globalOptions(program), async (vault) => print(await refactorVault(vault, subcommand, values, {
        apply: Boolean(options.apply)
      }), jsonOutput(program)));
    });

  const configCommand = setHelp(program.command("config"), "config");
  configCommand
    .command("show")
    .action(async () => {
      await withVault(globalOptions(program), async (vault, resolved) => print({
        profile: resolved.profile,
        vault_path: vault,
        source: resolved.source
      }, jsonOutput(program)));
    });

  const profileCommand = setHelp(program.command("profile"), "profile");
  profileCommand
    .command("list")
    .action(async () => {
      print(await listProfiles(), jsonOutput(program));
    });
  profileCommand
    .command("current")
    .action(async () => {
      const registry = await listProfiles();
      const current = Object.entries(registry.profiles ?? {}).find(([, item]) => item.default === true)?.[0] ?? null;
      print({ current }, jsonOutput(program));
    });
  profileCommand
    .command("use")
    .argument("<name>", "Profile name")
    .action(async (name) => {
      print(await setDefaultProfile(name), jsonOutput(program));
    });

  const engineCommand = setHelp(program.command("engine"), "engine");
  engineCommand
    .command("channels")
    .action(async () => {
      await withVault(globalOptions(program), async (vault) => print(await listSearchChannels(vault), jsonOutput(program)));
    });
  engineCommand
    .command("search")
    .argument("[query...]", "Search query")
    .option("--explain", "Accepted for compatibility")
    .action(async (queryParts) => {
      await withVault(globalOptions(program), async (vault) => print(await searchVault(vault, queryParts.join(" "), {
        threshold: 0,
        maxResults: 10
      }), jsonOutput(program)));
    });

  const conventionCommand = setHelp(program.command("convention"), "convention");
  conventionCommand
    .command("check")
    .action(async () => {
      await withVault(globalOptions(program), async (vault) => print(await validateVault(vault), jsonOutput(program)));
    });

  const formatterCommand = setHelp(program.command("formatter"), "formatter");
  formatterCommand
    .command("plan")
    .option("--note <notes...>", "Restrict formatting to note titles")
    .action(async (options) => {
      await withVault(globalOptions(program), async (vault) => print(await formatVault(vault, false, {
        notes: optionalList(options.note)
      }), jsonOutput(program)));
    });
  formatterCommand
    .command("apply")
    .option("--note <notes...>", "Restrict formatting to note titles")
    .action(async (options) => {
      await withVault(globalOptions(program), async (vault) => print(await formatVault(vault, true, {
        notes: optionalList(options.note)
      }), jsonOutput(program)));
    });

  const inboxCommand = setHelp(program.command("inbox"), "inbox");
  inboxCommand
    .command("add")
    .argument("<source>", "Source markdown file")
    .option("--title <title>", "Inbox note title")
    .option("--ref <ref>", "Frontmatter ref", collectRepeated, [])
    .option("--tag <tag>", "Frontmatter tag", collectRepeated, [])
    .option("--force", "Overwrite if needed")
    .action(async (source, options) => {
      await withVault(globalOptions(program), async (vault) => print(await inboxAdd(vault, resolve(source), {
        title: options.title,
        refs: optionalList(options.ref),
        tags: optionalList(options.tag),
        force: Boolean(options.force)
      }), jsonOutput(program)));
    });
  inboxCommand
    .command("triage")
    .option("--apply", "Apply triage suggestions")
    .option("--note <note>", "Restrict to one note")
    .action(async (options) => {
      await withVault(globalOptions(program), async (vault) => print(await inboxTriage(vault, Boolean(options.apply), options.note), jsonOutput(program)));
    });

  const harnessCommand = setHelp(program.command("harness"), "harness");
  harnessCommand
    .command("status")
    .action(async () => {
      await withVault(globalOptions(program), async (vault, resolved) => print(await harnessStatus(vault, {
        profile: resolved.profile
      }), jsonOutput(program)));
    });
  harnessCommand
    .command("install")
    .argument("[target]", "Harness target", "codex")
    .action(async (target) => {
      await withVault(globalOptions(program), async (vault, resolved) => print(await harnessInstall(vault, target, {
        profile: resolved.profile
      }), jsonOutput(program)));
    });
  harnessCommand
    .command("uninstall")
    .argument("[target]", "Harness target", "codex")
    .action(async (target) => {
      await withVault(globalOptions(program), async (vault, resolved) => print(await harnessUninstall(vault, target, {
        profile: resolved.profile
      }), jsonOutput(program)));
    });
  harnessCommand
    .command("doctor")
    .action(async () => {
      await withVault(globalOptions(program), async (vault, resolved) => print(await harnessDoctor(vault, {
        profile: resolved.profile
      }), jsonOutput(program)));
    });
  const guardCommand = harnessCommand.command("guard");
  guardCommand
    .command("status")
    .action(async () => {
      await withVault(globalOptions(program), async (vault) => print(await harnessGuardStatus(vault), jsonOutput(program)));
    });
  guardCommand
    .command("check")
    .argument("<path>", "Markdown path")
    .option("--action <action>", "Write action")
    .action(async (path, options) => {
      await withVault(globalOptions(program), async (vault) => print(await harnessGuardCheck(vault, path, {
        action: options.action
      }), jsonOutput(program)));
    });

  const cacheCommand = setHelp(program.command("cache"), "cache");
  cacheCommand.command("status").action(async () => {
    await withVault(globalOptions(program), async (vault) => print(await cacheStatus(vault), jsonOutput(program)));
  });
  cacheCommand.command("rebuild").action(async () => {
    await withVault(globalOptions(program), async (vault) => print(await rebuildCache(vault), jsonOutput(program)));
  });
  cacheCommand.command("clean").action(async () => {
    await withVault(globalOptions(program), async (vault) => print(await cacheClean(vault), jsonOutput(program)));
  });
  cacheCommand
    .command("inspect")
    .argument("[note]", "Note title")
    .option("--note <note>", "Note title")
    .action(async (noteArg, options) => {
      await withVault(globalOptions(program), async (vault) => print(await cacheInspect(vault, options.note ?? noteArg), jsonOutput(program)));
    });
  cacheCommand.command("doctor").action(async () => {
    await withVault(globalOptions(program), async (vault) => print(await cacheDoctor(vault), jsonOutput(program)));
  });

  const linkCommand = setHelp(program.command("link"), "link");
  linkCommand
    .command("suggest")
    .argument("<note>", "Note title")
    .action(async (note) => {
      await withVault(globalOptions(program), async (vault) => print(await linkPlan(vault, { note }), jsonOutput(program)));
    });
  linkCommand
    .command("plan")
    .option("--note <note>", "Note title")
    .option("--output <path>", "Plan output path")
    .option("--scope <scope>", "Accepted for compatibility")
    .action(async (options) => {
      await withVault(globalOptions(program), async (vault) => print(await linkPlan(vault, {
        note: options.note,
        output: options.output
      }), jsonOutput(program)));
    });
  linkCommand
    .command("apply")
    .argument("<planFile>", "Plan file")
    .action(async (planFile) => {
      await withVault(globalOptions(program), async (vault) => print(await linkApply(vault, planFile), jsonOutput(program)));
    });

  setHelp(program.command("review"), "review")
    .argument("[scope]", "Review scope", "all")
    .option("--suggest-refactor", "Include refactor suggestions")
    .option("--content", "Include content-level checks")
    .action(async (scope, options) => {
      await withVault(globalOptions(program), async (vault) => print(await reviewVault(vault, scope, {
        suggestRefactor: Boolean(options.suggestRefactor),
        content: Boolean(options.content)
      }), jsonOutput(program)));
    });

  const contractCommand = setHelp(program.command("contract"), "contract");
  contractCommand.command("list").action(async () => {
    print(await contractList(), jsonOutput(program));
  });
  contractCommand
    .command("validate")
    .argument("<file>", "Contract file")
    .action(async (file) => {
      await withVault(globalOptions(program), async (vault) => print(await contractValidate(resolve(vault, file)), jsonOutput(program)));
    });
  contractCommand
    .command("validate-output")
    .argument("<command>", "Command name")
    .argument("<file>", "Output fixture file")
    .action(async (command, file) => {
      await withVault(globalOptions(program), async (vault) => print(await contractValidateOutput(command, resolve(vault, file)), jsonOutput(program)));
    });
  contractCommand
    .command("export-fixtures")
    .option("--target <path>", "Target directory", ".ipa/fixtures/contracts")
    .action(async (options) => {
      await withVault(globalOptions(program), async (vault) => print(await contractExportFixtures(vault, options.target), jsonOutput(program)));
    });

  const pluginCommand = setHelp(program.command("plugin"), "plugin");
  pluginCommand.command("list").action(async () => {
    await withVault(globalOptions(program), async (vault) => print(await listPlugins(vault), jsonOutput(program)));
  });
  pluginCommand.command("doctor").action(async () => {
    await withVault(globalOptions(program), async (vault) => print(await pluginDoctor(vault), jsonOutput(program)));
  });
  pluginCommand
    .command("validate")
    .argument("<file>", "Plugin file")
    .action(async (file) => {
      await withVault(globalOptions(program), async (vault) => print(await validatePlugin(resolve(vault, file)), jsonOutput(program)));
    });
  pluginCommand
    .command("dry-run")
    .argument("<kind>", "Plugin kind")
    .argument("<file>", "Plugin file")
    .option("--query <query>", "Search query")
    .option("--note <note>", "Note title")
    .action(async (kind, file, options) => {
      await withVault(globalOptions(program), async (vault) => print(await pluginDryRun(vault, kind, file, {
        query: options.query,
        note: options.note
      }), jsonOutput(program)));
    });

  const tuneCommand = setHelp(program.command("tune"), "tune")
    .argument("[trial]", "Trial count")
    .option("--trials <number>", "Number of tpe-lite trials")
    .option("-n <number>", "Number of tpe-lite trials")
    .option("--pack <name>", "Built-in query pack")
    .option("--seed <number>", "Deterministic optimizer seed")
    .option("--apply", "Activate the generated result")
    .option("--quiet", "Suppress progress output")
    .action(async (trialArg, options) => {
      const positionalTrial = Number.isFinite(Number(trialArg)) ? trialArg : null;
      const trials = Number(options.trials ?? options.n ?? positionalTrial ?? 20);
      const progress = jsonOutput(program) || options.quiet ? null : createTuneProgressReporter();
      if (progress) {
        process.stderr.write(`Starting tune: trials=${trials}, optimizer=tpe-lite\n`);
      }
      await withVault(globalOptions(program), async (vault) => print(await tuneRun(vault, {
        trials,
        packName: options.pack,
        seed: options.seed,
        apply: Boolean(options.apply),
        onProgress: progress
      }), jsonOutput(program)));
    });
  tuneCommand.command("help").action(() => {
    console.log(formatCommandHelp("tune"));
  });
  tuneCommand.command("eval").action(async () => {
    await withVault(globalOptions(program), async (vault) => print(await tuneEval(vault), jsonOutput(program)));
  });
  tuneCommand.command("list").action(async () => {
    await withVault(globalOptions(program), async (vault) => print(await tuneList(vault), jsonOutput(program)));
  });
  tuneCommand
    .command("use")
    .argument("<file>", "Tune result file")
    .action(async (file) => {
      await withVault(globalOptions(program), async (vault) => print(await tuneUse(vault, file), jsonOutput(program)));
    });
  tuneCommand
    .command("analyze")
    .option("--threshold <threshold>", "Candidate threshold", collectRepeated, [])
    .option("--cap <number>", "Candidate cap")
    .option("--pack <name>", "Built-in query pack")
    .action(async (options) => {
      const thresholds = options.threshold.map(Number);
      await withVault(globalOptions(program), async (vault) => print(await tuneAnalyze(vault, {
        thresholds: thresholds.length ? thresholds : undefined,
        cap: optionNumber(options.cap),
        packName: options.pack
      }), jsonOutput(program)));
    });
  tuneCommand
    .command("replay")
    .argument("[file]", "Tune result file")
    .option("--pack <name>", "Built-in query pack")
    .action(async (file, options) => {
      await withVault(globalOptions(program), async (vault) => print(await tuneReplay(vault, {
        file: file ?? null,
        packName: options.pack
      }), jsonOutput(program)));
    });
  tuneCommand
    .command("label")
    .option("--query <query>", "Query")
    .option("--target <target>", "Target note")
    .option("--miss", "Record as miss")
    .action(async (options) => {
      await withVault(globalOptions(program), async (vault) => print(await tuneLabel(vault, {
        query: options.query,
        target: options.target,
        hit: options.miss ? false : true
      }), jsonOutput(program)));
    });
  tuneCommand.command("log").action(async () => {
    await withVault(globalOptions(program), async (vault) => print(await tuneLog(vault), jsonOutput(program)));
  });
  const testsetCommand = tuneCommand.command("testset");
  testsetCommand.action(async () => {
    await withVault(globalOptions(program), async (vault) => print(await tuneTestsetList(vault), jsonOutput(program)));
  });
  testsetCommand.command("list").action(async () => {
    await withVault(globalOptions(program), async (vault) => print(await tuneTestsetList(vault), jsonOutput(program)));
  });
  testsetCommand
    .command("show")
    .argument("[file]", "Testset file")
    .action(async (file) => {
      await withVault(globalOptions(program), async (vault) => print(await tuneTestsetShow(vault, file ?? null), jsonOutput(program)));
    });
  testsetCommand
    .command("validate")
    .argument("[file]", "Testset file")
    .action(async (file) => {
      await withVault(globalOptions(program), async (vault) => print(await tuneTestsetValidate(vault, file ?? null), jsonOutput(program)));
    });
  testsetCommand
    .command("draft")
    .option("--file <file>", "Target testset file")
    .action(async (options) => {
      await withVault(globalOptions(program), async (vault) => print(await tuneTestsetDraft(vault, {
        file: options.file
      }), jsonOutput(program)));
    });
  testsetCommand
    .command("add")
    .option("--file <file>", "Target testset file")
    .option("--query <query>", "Query")
    .option("--target <target>", "Target note")
    .action(async (options) => {
      await withVault(globalOptions(program), async (vault) => print(await tuneTestsetAdd(vault, {
        file: options.file,
        query: options.query,
        target: options.target
      }), jsonOutput(program)));
    });
  const packCommand = tuneCommand.command("pack");
  const printTunePacks = () => {
    print({ packs: ["ipa-cli-core"] }, jsonOutput(program));
  };
  packCommand.action(printTunePacks);
  packCommand.command("list").action(printTunePacks);
  packCommand
    .command("eval")
    .argument("[name]", "Pack name", "ipa-cli-core")
    .action(async (name) => {
      await withVault(globalOptions(program), async (vault) => print(await tuneEval(vault, name), jsonOutput(program)));
    });

  program.command("list-channels").action(async () => {
    await withVault(globalOptions(program), async (vault) => print(await listSearchChannels(vault), jsonOutput(program)));
  });
  program.command("list-rules").action(async () => {
    await withVault(globalOptions(program), async (vault) => print(await listRules(vault), jsonOutput(program)));
  });
  program.command("list-refactors").action(() => {
    print({ refactors: REFACTORS }, jsonOutput(program));
  });

  return program;
}

async function main(argv = process.argv.slice(2)) {
  const program = buildProgram();
  await program.parseAsync(argv, { from: "user" });
}

function createTuneProgressReporter() {
  let lastLength = 0;
  let lastWrite = 0;
  return (event) => {
    const now = Date.now();
    const done = event.completed >= event.trials;
    if (!done && now - lastWrite < 250) return;
    lastWrite = now;
    const percent = event.trials ? Math.round(event.completed / event.trials * 100) : 0;
    const line = [
      `tune ${event.completed}/${event.trials}`,
      `${percent}%`,
      `loss=${formatNumber(event.loss)}`,
      `best=${formatNumber(event.best_loss)}@${event.best_trial}`,
      `hits=${event.hits}`,
      `misses=${event.misses}`,
      `elapsed=${formatDuration(event.elapsed_ms)}`,
      `eta=${formatDuration(event.eta_ms)}`
    ].join("  ");
    if (process.stderr.isTTY) {
      process.stderr.write(`\r${line}${" ".repeat(Math.max(0, lastLength - line.length))}`);
      if (done) process.stderr.write("\n");
      lastLength = line.length;
    } else {
      process.stderr.write(`${line}\n`);
    }
  };
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(3) : "-";
}

function formatDuration(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) < 0) return "-";
  const total = Math.round(Number(ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});

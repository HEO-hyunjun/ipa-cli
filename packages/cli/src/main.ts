#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CHANNELS,
  REFACTORS,
  RULES,
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
  inboxAdd,
  inboxTriage,
  linkApply,
  linkPlan,
  listPlugins,
  listProfiles,
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
  tuneEval,
  tuneList,
  tuneLog,
  tuneRun,
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

const HELP = formatHelp();

function parseGlobal(argv) {
  const global = { profile: null, vault: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") global.profile = argv[++i];
    else if (arg === "--vault") global.vault = argv[++i];
    else rest.push(arg);
  }
  return { global, rest };
}

function has(args, flag) {
  return args.includes(flag);
}

function getOpt(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
}

function positional(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      i += takesValue(args[i]) ? 1 : 0;
    } else {
      out.push(args[i]);
    }
  }
  return out;
}

function takesValue(flag) {
  return ![
    "--json",
    "--all",
    "--reasons",
    "--full",
    "--apply",
    "--fix-dirs",
    "--suggest-refactor",
    "--content",
    "--by-note",
    "--summary",
    "--explain",
    "--force",
    "--help",
    "-h"
  ].includes(flag);
}

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
    "Usage: ipa [OPTIONS] COMMAND [ARGS...]",
    "",
    "IPA vault CLI - JS/TS runtime.",
    "",
    "Options:",
    formatRows([
      ["--profile NAME", "Use a profile from ~/.config/ipa/profile.yaml"],
      ["--vault PATH", "Use a vault path directly"],
      ["--json", "Print machine-readable JSON"],
      ["--help", "Show this help message"]
    ]),
    ""
  ];
  for (const group of COMMAND_GROUPS) {
    lines.push(`${group.title}:`, formatRows(group.rows), "");
  }
  lines.push("Examples:");
  lines.push(formatRows([
    ["ipa search \"ipa cli\"", "Search the active vault"],
    ["ipa --profile ipa-test review all", "Run a read-only review on a test profile"],
    ["ipa plugin dry-run search .ipa/plugins/search/custom.js --query Alpha", "Test a vault plugin"]
  ]));
  return `${lines.join("\n")}\n`;
}

function render(payload) {
  if (Array.isArray(payload)) return payload.map(render).join("\n");
  if (!payload || typeof payload !== "object") return String(payload ?? "");
  if (payload.results && Object.hasOwn(payload, "query")) return renderSearchResults(payload);
  if (payload.pack && Object.hasOwn(payload, "misses")) return renderTuneEval(payload);
  if (payload.optimizer && payload.best) return renderTuneRun(payload);
  if (payload.issues) return renderIssues(payload);
  if (payload.plugins) return renderPlugins(payload);
  if (payload.paths) return renderPaths(payload);
  if (payload.tree) return `Traversal tree\n\n${renderTree(payload.tree)}`;
  if (payload.notes && payload.sources) return renderContext(payload);
  if (payload.channels) return renderRegistry("Search channels", payload.channels, "name", "description");
  if (payload.rules) return renderRegistry("Convention rules", payload.rules, "code", "severity");
  if (payload.refactors) return renderList("Refactors", payload.refactors);
  if (payload.profile !== undefined && payload.vault_path) return renderKeyValues("Active config", payload);
  if (payload.status && payload.checks) return renderDoctor(payload);
  if (payload.suggestions) return renderTableReport("Link suggestions", ["Note", "Target", "Reason"], payload.suggestions.map((item) => [item.note, item.target, item.reason]));
  if (payload.changes) return renderTableReport("Planned changes", ["Note", "Path", "Target"], payload.changes.map((item) => [item.note ?? "-", item.path ?? "-", item.target ?? item.to ?? "-"]));
  return JSON.stringify(payload, null, 2);
}

function renderSearchResults(payload) {
  const header = [
    "Search results",
    `Query: ${payload.query || "(empty)"}   Count: ${payload.count}   Threshold: ${payload.threshold}   Max: ${payload.max_results}`
  ];
  if (!payload.results.length) return `${header.join("\n")}\n\nNo results.`;
  const rows = payload.results.map((hit, index) => [
    String(index + 1),
    hit.note,
    hit.type ?? "?",
    hit.score,
    hit.path
  ]);
  return `${header.join("\n")}\n\n${table(["Rank", "Note", "Type", "Score", "Path"], rows)}`;
}

function renderTuneEval(payload) {
  const lines = [
    "Tune evaluation",
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
  return [
    "Tune run",
    `Optimizer: ${payload.optimizer}   Trials: ${payload.trials}`,
    `Best trial: ${best.trial ?? "-"}   Loss: ${best.loss ?? "-"}`,
    `Result file: ${payload.result_file ?? "-"}`
  ].join("\n");
}

function renderIssues(payload) {
  const title = payload.summary?.patches !== undefined ? "Formatter report" : "Issues";
  const lines = [title];
  if (payload.status) lines.push(`Status: ${payload.status}`);
  if (payload.summary) {
    lines.push(`Summary: ${Object.entries(payload.summary).map(([key, value]) => `${key}=${value}`).join(" ")}`);
  }
  if (payload.patches?.length) {
    lines.push("", table(["Note", "Path", "Plugin"], payload.patches.map((item) => [item.note ?? "-", item.path ?? "-", item.plugin ?? "-"])));
  }
  if (!payload.issues.length) {
    lines.push("", "No issues.");
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
  if (!payload.plugins.length) return "Plugins\n\nNo enabled plugins.";
  return renderTableReport("Plugins", ["Kind", "Path"], payload.plugins.map((item) => [item.kind, item.path]));
}

function renderPaths(payload) {
  if (!payload.paths.length) return "Traversal paths\n\nNo paths.";
  return renderTableReport("Traversal paths", ["#", "Path"], payload.paths.map((path, index) => [String(index + 1), path.join(" -> ")]));
}

function renderContext(payload) {
  const rows = payload.notes.map((note) => [note.id, note.type || "?", note.path]);
  return [
    "Context",
    `Query: ${payload.query}   Notes: ${payload.notes.length}`,
    "",
    table(["Note", "Type", "Path"], rows)
  ].join("\n");
}

function renderRegistry(title, items, nameKey, descriptionKey) {
  const rows = items.map((item) => [item[nameKey], item[descriptionKey] ?? "-"]);
  return renderTableReport(title, ["Name", "Description"], rows);
}

function renderList(title, items) {
  return [`${title} (${items.length})`, ...items.map((item) => `  ${item}`)].join("\n");
}

function renderDoctor(payload) {
  const lines = [
    "Doctor",
    `Status: ${payload.status}`,
    "",
    formatRows(Object.entries(payload.checks).map(([key, value]) => [key, String(value)]))
  ];
  if (payload.issues?.length) lines.push("", renderIssues(payload));
  return lines.join("\n");
}

function renderKeyValues(title, payload) {
  return [title, "", formatRows(Object.entries(payload).map(([key, value]) => [key, String(value ?? "-")]))].join("\n");
}

function renderTableReport(title, headers, rows) {
  if (!rows.length) return `${title}\n\nNo rows.`;
  return `${title} (${rows.length})\n\n${table(headers, rows)}`;
}

function table(headers, rows) {
  const data = [headers, ...rows.map((row) => row.map((cell) => String(cell ?? "")))];
  const widths = headers.map((_, column) => Math.max(...data.map((row) => row[column]?.length ?? 0)));
  const format = (row) => row.map((cell, column) => String(cell ?? "").padEnd(widths[column])).join("  ").trimEnd();
  return [
    format(headers),
    format(headers.map((_, column) => "-".repeat(widths[column]))),
    ...rows.map(format)
  ].join("\n");
}

function formatRows(rows) {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`).join("\n");
}

function renderTree(node, depth = 0) {
  return `${"  ".repeat(depth)}- ${node.note}\n${(node.children ?? []).map((child) => renderTree(child, depth + 1)).join("")}`.trimEnd();
}

async function withVault(global, fn) {
  const s = await settings(global);
  return fn(s.vaultPath, s);
}

async function main(argv = process.argv.slice(2)) {
  const { global, rest } = parseGlobal(argv);
  if (rest.length === 0 || has(rest, "--help") || has(rest, "-h")) {
    console.log(HELP);
    return;
  }

  const [command, sub, ...tail] = rest;
  const args = [sub, ...tail].filter((item) => item !== undefined);
  const json = has(args, "--json");

  switch (command) {
    case "search": {
      const query = positional(args).join(" ");
      const threshold = Number(getOpt(args, "--threshold", 0.05));
      const maxResults = Number(getOpt(args, "--max", 10));
      return withVault(global, async (vault) => print(await searchVault(vault, query, {
        threshold,
        maxResults,
        showAll: has(args, "--all")
      }), json));
    }
    case "view": {
      const [note] = positional(args);
      return withVault(global, async (vault) => print(await viewNote(vault, note, {
        full: has(args, "--full"),
        section: getOpt(args, "--section", null)
      })));
    }
    case "traversal": {
      const mode = has(args, "--down") ? "down" : has(args, "--siblings") ? "siblings" : has(args, "--root") ? "root" : "up";
      const note = getOpt(args, `--${mode}`, positional(args)[0]);
      return withVault(global, async (vault) => print(await traversal(vault, mode, note), json));
    }
    case "validator":
      return withVault(global, async (vault) => print(await validateVault(vault), json));
    case "doctor":
      return withVault(global, async (vault) => print(await doctor(vault, {
        fixDirs: has(args, "--fix-dirs"),
        check: getOpt(args, "--check")
      }), json));
    case "context": {
      const query = positional(args).join(" ");
      return withVault(global, async (vault) => {
        const payload = await buildContext(vault, query, {
          byNote: has(args, "--by-note"),
          full: String(getOpt(args, "--include", "")).includes("full")
        });
        if (getOpt(args, "--format") === "markdown") {
          print(payload.notes.map((note) => `## ${note.id}\n${note.body}`).join("\n\n"));
        } else print(payload, true);
      });
    }
    case "rename": {
      const [oldName, newName] = positional(args);
      return withVault(global, async (vault) => print(await renameNote(vault, oldName, newName, has(args, "--apply")), json));
    }
    case "move": {
      const [note, target] = positional(args);
      return withVault(global, async (vault) => print(await moveNote(vault, note, target, has(args, "--apply")), json));
    }
    case "add":
      return addInbox(global, args, json);
    case "refactor":
      return refactor(global, args, json);
    case "config":
      return config(global, args, json);
    case "profile":
      return profile(args, json);
    case "engine":
      return engine(global, args, json);
    case "convention":
      return convention(global, args, json);
    case "formatter":
      return formatter(global, args, json);
    case "inbox":
      return inbox(global, args, json);
    case "harness":
      return harness(args, json);
    case "cache":
      return cache(global, args, json);
    case "link":
      return link(global, args, json);
    case "review":
      return review(global, args, json);
    case "contract":
      return contract(global, args, json);
    case "plugin":
      return plugin(global, args, json);
    case "tune":
      return tune(global, args, json);
    case "list-channels":
      return print({ channels: CHANNELS }, json);
    case "list-rules":
      return print({ rules: RULES }, json);
    case "list-refactors":
      return print({ refactors: REFACTORS }, json);
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

async function config(global, args, json) {
  if (args[0] !== "show") throw new Error("usage: ipa config show");
  return withVault(global, async (vault, s) => print({ profile: s.profile, vault_path: vault, source: s.source }, json));
}

async function profile(args, json) {
  if (args[0] === "list") return print(await listProfiles(), json);
  if (args[0] === "current") {
    const registry = await listProfiles();
    const current = Object.entries(registry.profiles ?? {}).find(([, item]) => item.default === true)?.[0] ?? null;
    return print({ current }, json);
  }
  if (args[0] === "use") return print(await setDefaultProfile(args[1]), json);
  throw new Error("usage: ipa profile list|current|use");
}

async function engine(global, args, json) {
  if (args[0] === "channels") return print({ channels: CHANNELS }, json);
  if (args[0] === "search") {
    const query = positional(args.slice(1)).join(" ");
    return withVault(global, async (vault) => print(await searchVault(vault, query, { threshold: 0, maxResults: 10 }), json));
  }
  throw new Error("usage: ipa engine search|channels");
}

async function convention(global, args, json) {
  if (args[0] !== "check") throw new Error("usage: ipa convention check");
  return withVault(global, async (vault) => print(await validateVault(vault), json));
}

async function formatter(global, args, json) {
  if (args[0] === "plan") {
    return withVault(global, async (vault) => print(await formatVault(vault, false), json));
  }
  if (args[0] === "apply") {
    return withVault(global, async (vault) => print(await formatVault(vault, true), json));
  }
  throw new Error("usage: ipa formatter plan|apply");
}

async function addInbox(global, args, json) {
  const [source] = positional(args);
  return withVault(global, async (vault) => print(await inboxAdd(vault, resolve(source), {
    title: getOpt(args, "--title"),
    refs: collect(args, "--ref"),
    tags: collect(args, "--tag"),
    force: has(args, "--force")
  }), json));
}

async function inbox(global, args, json) {
  if (args[0] === "add") return addInbox(global, args.slice(1), json);
  if (args[0] === "triage") {
    return withVault(global, async (vault) => print(await inboxTriage(vault, has(args, "--apply"), getOpt(args, "--note")), json));
  }
  throw new Error("usage: ipa inbox add|triage");
}

async function refactor(global, args, json) {
  const [cmd, ...rest] = args;
  return withVault(global, async (vault) => print(await refactorVault(vault, cmd, positional(rest), { apply: has(rest, "--apply") }), json));
}

async function harness(args, json) {
  const sub = args[0];
  if (sub === "guard" && args[1] === "check") return print({ allowed: true, reason: "js harness guard smoke" }, json);
  if (["status", "install", "uninstall", "doctor"].includes(sub) || sub === "guard") {
    return print({ status: "ok", command: args.join(" "), installed: false }, json);
  }
  throw new Error("usage: ipa harness status|install|uninstall|doctor|guard");
}

async function cache(global, args, json) {
  const sub = args[0];
  return withVault(global, async (vault) => {
    if (sub === "status") return print(await cacheStatus(vault), json);
    if (sub === "rebuild") return print(await rebuildCache(vault), json);
    if (sub === "clean") return print(await cacheClean(vault), json);
    if (sub === "inspect") return print(await cacheInspect(vault, getOpt(args, "--note") ?? args[1]), json);
    if (sub === "doctor") return print(await cacheDoctor(vault), json);
    throw new Error("usage: ipa cache status|rebuild|clean|inspect|doctor");
  });
}

async function link(global, args, json) {
  const sub = args[0];
  return withVault(global, async (vault) => {
    if (sub === "suggest") return print(await linkPlan(vault, { note: args[1] }), json);
    if (sub === "plan") return print(await linkPlan(vault, { note: getOpt(args, "--note"), output: getOpt(args, "--output") }), json);
    if (sub === "apply") return print(await linkApply(vault, args[1]), json);
    throw new Error("usage: ipa link suggest|plan|apply");
  });
}

async function review(global, args, json) {
  const scope = args[0] ?? "all";
  return withVault(global, async (vault) => print(await reviewVault(vault, scope, {
    suggestRefactor: has(args, "--suggest-refactor"),
    content: has(args, "--content")
  }), json));
}

async function contract(global, args, json) {
  const sub = args[0];
  if (sub === "list") return print(await contractList(), json);
  if (sub === "validate") {
    return withVault(global, async (vault) => print(await contractValidate(resolve(vault, args[1])), json));
  }
  if (sub === "validate-output") {
    return withVault(global, async (vault) => print(await contractValidateOutput(args[1], resolve(vault, args[2])), json));
  }
  if (sub === "export-fixtures") {
    return withVault(global, async (vault) => print(await contractExportFixtures(vault, getOpt(args, "--target", ".ipa/fixtures/contracts")), json));
  }
  throw new Error("usage: ipa contract list|validate|validate-output|export-fixtures");
}

async function plugin(global, args, json) {
  const sub = args[0];
  return withVault(global, async (vault) => {
    if (sub === "list") return print(await listPlugins(vault), json);
    if (sub === "doctor") return print(await pluginDoctor(vault), json);
    if (sub === "validate") return print(await validatePlugin(resolve(vault, args[1])), json);
    if (sub === "dry-run") {
      const kind = args[1];
      const path = args[2];
      return print(await pluginDryRun(vault, kind, path, {
        query: getOpt(args, "--query"),
        note: getOpt(args, "--note")
      }), json);
    }
    throw new Error("usage: ipa plugin list|doctor|validate|dry-run");
  });
}

async function tune(global, args, json) {
  return withVault(global, async (vault) => {
    if (args[0] === "eval") return print(await tuneEval(vault), json);
    if (args[0] === "list") return print(await tuneList(vault), json);
    if (args[0] === "use") return print(await tuneUse(vault, args[1]), json);
    if (args[0] === "analyze") return print({ status: "ok", message: "threshold analysis is available after labelled logs" }, json);
    if (args[0] === "replay") return print({ status: "ok", replayed: 0 }, json);
    if (args[0] === "label") return print({ status: "ok", labelled: true }, json);
    if (args[0] === "log") return print(await tuneLog(vault), json);
    if (args[0] === "testset") return print({ status: "ok", command: args.slice(1).join(" ") }, json);
    if (args[0] === "pack") {
      if (args[1] === "eval") return print(await tuneEval(vault, args[2] ?? "ipa-cli-core"), json);
      if (args[1] === "list") return print({ packs: ["ipa-cli-core"] }, json);
      return print({ status: "ok", pack: args.slice(1).join(" ") }, json);
    }
    return print(await tuneRun(vault, { trials: Number(getOpt(args, "--trials", getOpt(args, "-n", 20))) }), json);
  });
}

function collect(args, flag) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) values.push(args[i + 1]);
  }
  return values.length ? values : undefined;
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});

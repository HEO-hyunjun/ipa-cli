#!/usr/bin/env node
import { readFile, unlink } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import Table from "cli-table3";
import { Command } from "commander";
import * as colors from "yoctocolors";
import {
  REFACTORS,
  buildContext,
  cacheClean,
  cascadeNote,
  cacheDoctor,
  cacheInspect,
  cacheStatus,
  cliVersionInfo,
  configInit,
  contractExportFixtures,
  contractList,
  contractValidate,
  contractValidateOutput,
  conventionShow,
  createProfile,
  digestNote,
  doctor,
  formatVault,
  harnessDoctor,
  harnessGuardCheck,
  harnessGuardStatus,
  harnessInstall,
  harnessStatus,
  harnessUninstall,
  harnessSessionGate,
  obsidianPluginSync,
  harnessUpdate,
  inboxAdd,
  inboxTriage,
  initProfileRegistry,
  linkApply,
  linkPlan,
  listPlugins,
  listProfiles,
  listRules,
  listSearchChannels,
  moveNote,
  pluginDoctor,
  pluginDryRun,
  pluginInit,
  rebuildCache,
  redirectNotes,
  refactorVault,
  replaceInNote,
  renameNote,
  resolveSettings,
  reviewVault,
  searchVault,
  searchVaultMany,
  selfUpdate,
  suggestLinks,
  setDefaultProfile,
  setNoteField,
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
  tuneTestsetInit,
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
      ["digest", "Summarize index notes and their children in one call"],
      ["cascade", "Plan/apply the ripple of a new note: refs, links, overlap candidates"],
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
      ["note", "Core-backed scripted note edits"],
      ["rename", "Rename a note and update links"],
      ["move", "Move a note and update links"],
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
      ["plugin", "Scaffold, list, validate, and dry-run vault plugins"],
      ["contract", "Validate runtime contract fixtures"],
      ["harness", "Install, uninstall, update, and inspect AI harness hooks"],
      ["update", "Update the ipa CLI from its git checkout"],
      ["obsidian", "Install or sync the Obsidian plugin into the active vault"],
      ["list-channels / list-rules / list-refactors", "Inspect builtin registries"]
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
    ],
    options: [
      ["inspect [NOTE]", "Inspect the cache entry for a note title"],
      ["inspect --note NOTE", "Pass the note title as an option"]
    ]
  }),
  config: formatDetailedHelp({
    usage: "ipa [OPTIONS] config <init|show>",
    summary: "Create the vault's .ipa/config.yaml, or show the resolved vault/profile context.",
    commands: [
      ["ipa config init", "Write .ipa/config.yaml with the default mapping template"],
      ["ipa config show", "Show the resolved vault/profile context"]
    ],
    options: [
      ["--force", "Overwrite an existing .ipa/config.yaml (init)"],
      ["--inbox NAME", "Record an existing inbox folder name in the mapping (init)"],
      ["--project NAME", "Record an existing project folder name in the mapping (init)"],
      ["--archive NAME", "Record an existing archive folder name in the mapping (init)"]
    ],
    examples: [
      ["ipa config init", "Create the config with default folder/field names"],
      ["ipa config init --inbox Inbox --project Projects", "Absorb an existing folder layout"],
      ["ipa config show", "Use project-local selector/default profile"]
    ]
  }),
  convention: formatDetailedHelp({
    usage: "ipa [OPTIONS] convention [show|check]",
    summary: "Show IPA concepts rendered through the active vault config, or run validator checks.",
    commands: [
      ["ipa convention", "Show IPA concepts with this vault's real field/folder names plus vault operating rules"],
      ["ipa convention show", "Same as bare ipa convention"],
      ["ipa convention check", "Run the active vault validator (compatibility alias)"]
    ],
    notes: [
      "Vault operating rules come from .ipa/harness/fragments/*.md — the same fragments the harness inlines into managed prompts."
    ]
  }),
  context: formatDetailedHelp({
    usage: "ipa [OPTIONS] context QUERY [--by-note] [--size small|medium|large|full] [--format json|markdown]",
    summary: "Build a compact note-centered context pack for agent prompts.",
    options: [
      ["--by-note", "Treat QUERY as a note title instead of a search query"],
      ["--include MODE", "Include extra context; use full for full selected note bodies"],
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
      ["ipa contract export-fixtures", "Export current fixture contracts"],
      ["ipa contract export-fixtures --target DIR", "Export fixtures into a target directory"]
    ],
    options: [
      ["export-fixtures --target DIR", "Target directory; default .ipa/fixtures/contracts"]
    ]
  }),
  doctor: formatDetailedHelp({
    usage: "ipa [OPTIONS] doctor [--fix-dirs] [--check NAME]",
    summary: "Run basic vault setup checks.",
    options: [
      ["--fix-dirs", "Create missing expected directories"],
      ["--check NAME", "Run one check (config or cache)"]
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
    ],
    options: [
      ["plan/apply --note NOTE...", "Restrict formatting to one or more note titles"]
    ]
  }),
  harness: formatDetailedHelp({
    usage: "ipa [OPTIONS] harness status|init|install|uninstall|update|doctor|guard",
    summary: "Install and inspect AI harness skills, hooks, vault prompt blocks, and plugin scaffold.",
    commands: [
      ["ipa harness status", "Show installed target state and outdated components"],
      ["ipa harness init codex", "Initialize Codex skill/hooks, vault prompt block, and plugin scaffold"],
      ["ipa harness install codex", "Install Codex skill/hooks, vault prompt block, and plugin scaffold"],
      ["ipa harness install claude", "Install Claude Code skill/hooks, vault prompt block, and plugin scaffold"],
      ["ipa harness install opencode", "Install OpenCode skill/hooks, vault prompt block, and plugin scaffold"],
      ["ipa harness uninstall codex", "Remove Codex harness files"],
      ["ipa harness update claude", "Reinstall harness files with the current CLI templates, keeping component selection"],
      ["ipa harness doctor", "Validate installed harness files"],
      ["ipa harness guard status", "Show guard policy state"],
      ["ipa harness guard check PATH --action create", "Check inbox-only write policy"]
    ],
    options: [
      ["init/install/uninstall [target]", "Harness target: codex (default), claude, or opencode"],
      ["init/install --only <component...>", "Install only the named components (repeatable, comma-separated)"],
      ["init/install --with <component...>", "Add components to the default set (repeatable, comma-separated)"],
      ["init/install --without <component...>", "Remove components from the default set (repeatable, comma-separated)"],
      ["guard check --action ACTION", "Write action to evaluate; default is create-like behavior"]
    ],
    examples: [
      ["ipa harness install opencode", "Default OpenCode install (all components except hook:evidence)"],
      ["ipa harness install opencode --with hook:evidence", "Default install plus the opt-in evidence hook"],
      ["ipa harness install opencode --only skill,prompt", "Install only the global skill and prompt components"],
      ["ipa harness install codex --only hook:guard", "Install only the Codex inbox guard hook"]
    ],
    notes: [
      "Without --only, init/install applies the default install for the target (all components except hook:evidence).",
      "Components: skill, prompt, local-prompt, local-skills, plugin-scaffold, opencode-plugin, permissions (claude; adds a Bash(ipa *) allow rule to ~/.claude/settings.json), hook:session-env, hook:guard, hook:markdown-nudge, hook:formatter-gate, hook:evidence (opt-in)."
    ]
  }),
  inbox: formatDetailedHelp({
    usage: "ipa [OPTIONS] inbox add|triage [ARGS...]",
    summary: "Create or triage inbox notes.",
    commands: [
      ["ipa inbox add ./draft.md --title \"Title\"", "Import a draft into the configured inbox"],
      ["ipa inbox triage", "Suggest refs/tags for inbox notes"],
      ["ipa inbox triage --apply --note \"Title\"", "Apply triage to one note"]
    ],
    options: [
      ["add --title TITLE", "Inbox note title"],
      ["add --ref REF", "Add a frontmatter ref; repeatable"],
      ["add --tag TAG", "Add a frontmatter tag; repeatable"],
      ["add --force", "Overwrite if the target note already exists"],
      ["triage --apply", "Apply suggested refs/tags"],
      ["triage --note NOTE", "Restrict triage to one note"]
    ]
  }),
  link: formatDetailedHelp({
    usage: "ipa [OPTIONS] link suggest|plan|apply [ARGS...]",
    summary: "Suggest, persist, and apply wikilink edits.",
    commands: [
      ["ipa link suggest NOTE", "Suggest links for one note"],
      ["ipa link plan --note NOTE", "Write a guarded link plan"],
      ["ipa link apply .ipa/plans/link.json", "Apply a saved plan"]
    ],
    options: [
      ["plan --note NOTE", "Plan links for one note"],
      ["plan --output PATH", "Plan output path"],
      ["plan --scope SCOPE", "Accepted for compatibility"]
    ]
  }),
  plugin: formatDetailedHelp({
    usage: "ipa [OPTIONS] plugin init|list|doctor|validate|dry-run [ARGS...]",
    summary: "Create, inspect, and test vault-local JS plugins.",
    commands: [
      ["ipa plugin init", "Create .ipa/plugins authoring structure with JS types and disabled examples"],
      ["ipa plugin list", "List enabled plugins"],
      ["ipa plugin doctor", "Validate all plugin contracts"],
      ["ipa plugin validate .ipa/plugins/search/x.js", "Validate one plugin file"],
      ["ipa plugin dry-run search .ipa/plugins/search/x.js --query Alpha", "Run a search plugin without installing changes"],
      ["ipa plugin dry-run rules .ipa/plugins/rules/x.js --note Alpha", "Preview rule issues and fixes"]
    ],
    options: [
      ["init --force", "Overwrite scaffold files that already exist"],
      ["init --no-examples", "Skip disabled example plugin files"],
      ["dry-run --query QUERY", "Search query for search plugin dry-runs"],
      ["dry-run --note NOTE", "Note title for rule plugin dry-runs"]
    ]
  }),
  profile: formatDetailedHelp({
    usage: "ipa profile init|new|list|current|use [ARGS...]",
    summary: "Create, inspect, and update the machine-local profile registry.",
    commands: [
      ["ipa profile init --vault ~/ipa", "Initialize ~/.config/ipa/profile.yaml with the default ipa profile"],
      ["ipa profile new work ~/work/IPA --default", "Add or update a named profile and make it default"],
      ["ipa profile list", "List configured profiles"],
      ["ipa profile current", "Show the default profile"],
      ["ipa profile use work", "Mark a profile as default"]
    ],
    options: [
      ["init --name NAME", "Profile name to initialize; default ipa"],
      ["init --vault PATH", "Vault path to initialize; default ~/ipa"],
      ["new --default", "Mark the new or updated profile as default"],
      ["init/new --force", "Update an existing profile instead of failing"]
    ]
  }),
  refactor: formatDetailedHelp({
    usage: "ipa [OPTIONS] refactor COMMAND [ARGS...] [--apply]",
    summary: "Plan or apply refs, tags, and wikilink rewrites.",
    commands: [
      ["ipa refactor tag-rename OLD NEW", "Rename a frontmatter tag across the vault"],
      ["ipa refactor tag-remove TAG", "Remove a frontmatter tag across the vault"],
      ["ipa refactor tag-add TAG", "Add a frontmatter tag to every note"],
      ["ipa refactor ref-replace OLD NEW", "Replace frontmatter refs across the vault"],
      ["ipa refactor ref-remove REF", "Remove a frontmatter ref across the vault"],
      ["ipa refactor ref-add REF", "Add a frontmatter ref to every note"],
      ["ipa refactor wikilink-replace OLD NEW", "Replace exact body wikilinks across the vault"]
    ],
    options: [
      ["--apply", "Write the planned refactor; omit for preview"]
    ],
    notes: [
      "`refactor` is vault-wide. Preview first; use `ipa note replace` for note-scoped literal edits.",
      "Run `ipa list-refactors` to inspect every registered refactor recipe."
    ]
  }),
  rename: formatDetailedHelp({
    usage: "ipa [OPTIONS] rename OLD NEW [--apply]",
    summary: "Rename a note and update links when applied.",
    examples: [
      ["ipa rename \"Old\" \"New\"", "Preview rename"],
      ["ipa rename \"Old\" \"New\" --apply", "Apply rename"]
    ],
    options: [
      ["--apply", "Write the rename and link updates; omit for preview"]
    ]
  }),
  move: formatDetailedHelp({
    usage: "ipa [OPTIONS] move NOTE TARGET [--apply]",
    summary: "Move a note to a target directory and update links when applied.",
    examples: [
      ["ipa move \"Note\" \"02 Archive\"", "Preview move"],
      ["ipa move \"Note\" \"02 Archive\" --apply", "Apply move"]
    ],
    options: [
      ["--apply", "Write the move and link updates; omit for preview"]
    ]
  }),
  note: formatDetailedHelp({
    usage: "ipa [OPTIONS] note replace|set|redirect NOTE [ARGS...]",
    summary: "Apply core-backed edits to existing notes, including frontmatter, without raw vault path scans.",
    commands: [
      ["ipa note replace \"Note\" --old-file .tmp/old.txt --new-file .tmp/new.txt", "Preview a literal block replacement"],
      ["ipa note replace \"Note\" --old-file .tmp/old.txt --new-file .tmp/new.txt --apply", "Apply the replacement"],
      ["ipa note set \"Note\" --field ref --add \"Index Note\" --apply", "Add a frontmatter list item"],
      ["ipa note set \"Note\" --field type --value index --apply", "Set a scalar frontmatter field"],
      ["ipa note set \"A\" \"B\" --field ref --add \"Index\" --apply", "Same field edit across several notes"],
      ["ipa note redirect \"Old A\" \"Old B\" --to \"SoT Note\" --archive --apply", "Rewire every wikilink/ref to the target and archive the sources"]
    ],
    options: [
      ["--old-file PATH", "File containing the exact raw note text to replace"],
      ["--new-file PATH", "File containing replacement text"],
      ["--apply", "Write the change; omit for preview"],
      ["--allow-multiple", "Allow replacing more than one matching block"],
      ["--keep-files", "Keep --old-file/--new-file after a successful apply (default: .tmp files are removed)"],
      ["--field NAME", "Frontmatter field to edit with note set"],
      ["--value VALUE", "Scalar value for note set"],
      ["--add VALUE", "List item to add (repeatable)"],
      ["--remove VALUE", "List item to remove (repeatable)"]
    ],
    notes: [
      "Writes keep the mapped date_modified field in sync automatically — never edit time fields by hand."
    ]
  }),
  review: formatDetailedHelp({
    usage: "ipa [OPTIONS] review [all|inbox|indexes|tags|duplicates] [--suggest-refactor]",
    summary: "Audit vault structure and surface cleanup/refactor candidates.",
    examples: [
      ["ipa review all", "Run all read-only audits"],
      ["ipa review duplicates", "Find duplicate-looking notes"],
      ["ipa review all --suggest-refactor", "Include refactor suggestions"]
    ],
    options: [
      ["--suggest-refactor", "Attach refactor command suggestions where possible"],
      ["--content", "Include content-level checks"]
    ]
  }),
  search: formatDetailedHelp({
    usage: "ipa [OPTIONS] search QUERY... [--max N] [--threshold N] [--all] [--join] [--json]",
    summary: "Search notes with active weights, tune result, and vault-local search plugins.",
    options: [
      ["--max N", "Maximum result count (per query)"],
      ["--threshold N", "Minimum score threshold"],
      ["--all", "Show all scored notes by forcing threshold 0"],
      ["--join", "Treat all arguments as one space-joined query"],
      ["--json", "Print structured output"]
    ],
    examples: [
      ["ipa search \"ipa cli\"", "Search the active vault"],
      ["ipa search \"ipa cli\" \"하네스\"", "Run several queries in one call (vault loads once)"],
      ["ipa search \"graph\" --max 20", "Return more results"],
      ["ipa search \"Alpha\" --json", "Use machine-readable output"]
    ],
    notes: [
      "Multiple arguments run as separate queries against one loaded vault. Quote multi-word queries, or pass --join to search all arguments as one query."
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
  obsidian: formatDetailedHelp({
    usage: "ipa [OPTIONS] obsidian install|sync",
    summary: "Deploy the built Obsidian plugin bundle into the active vault's .obsidian/plugins/ipa-obsidian/.",
    commands: [
      ["ipa obsidian install", "Create the plugin folder in the active vault and copy the built bundle (enable it in Obsidian afterwards)"],
      ["ipa obsidian sync", "Refresh an existing install with the current build; does nothing if the vault has no install"]
    ],
    notes: [
      "Copies release assets only (main.js, manifest.json, styles.css, versions.json); data.json settings are never touched.",
      "ipa update --apply rebuilds the bundle and runs the sync automatically when the active vault carries an install."
    ]
  }),
  update: formatDetailedHelp({
    usage: "ipa [OPTIONS] update [--apply]",
    summary: "Update the ipa CLI from its git checkout: show pending upstream commits, then fast-forward pull and rebuild.",
    options: [
      ["--apply", "Run git pull --ff-only, pnpm install, and pnpm run build in the repo; also syncs the vault-installed Obsidian plugin"]
    ],
    examples: [
      ["ipa update", "Show how far behind upstream the checkout is and the commands to run"],
      ["ipa update --apply", "Fast-forward pull and rebuild; the ipa symlink keeps pointing at the fresh build"]
    ],
    notes: [
      "Refuses to apply while the checkout has uncommitted changes or has diverged from upstream.",
      "After updating, run `ipa harness status` and `ipa harness update <target>` if components are outdated."
    ]
  }),
  validator: formatDetailedHelp({
    usage: "ipa [OPTIONS] validator [--note NOTE...] [--json]",
    summary: "Validate active IPA notes after applying files.exclude.",
    examples: [
      ["ipa validator", "Human-readable vault-wide issue report"],
      ["ipa validator --note \"Edited Note\"", "Only issues attached to the edited note(s)"],
      ["ipa validator --json", "Machine-readable issue payload"]
    ],
    options: [
      ["--note NOTE...", "Restrict reported issues to the named notes (validation still runs vault-wide)"],
      ["--json", "Print machine-readable JSON"]
    ]
  }),
  view: formatDetailedHelp({
    usage: "ipa [OPTIONS] view NOTE [NOTE...] [--full] [--section HEADING]",
    summary: "Show note overviews, sections, or full bodies while preserving display names.",
    options: [
      ["--full", "Show the full note body and footer"],
      ["--section HEADING", "Show one markdown section"]
    ],
    examples: [
      ["ipa view \"Note Title\"", "Show structure overview"],
      ["ipa view \"Note Title\" --full", "Show full content"],
      ["ipa view \"Note A\" \"Note B\" --full", "Show several notes in one call"],
      ["ipa view \"Note Title\" --section \"Details\"", "Show one section"]
    ]
  }),
  cascade: formatDetailedHelp({
    usage: "ipa [OPTIONS] cascade plan|apply --note NOTE [--only refs,links,overlaps]",
    summary: "Staged ripple for a new note: ref wiring and title wikilinks are appliable; overlap candidates are report-only.",
    commands: [
      ["ipa cascade plan --note \"New Note\"", "Preview refs, links, and overlap candidates"],
      ["ipa cascade apply --note \"New Note\" --only links", "Apply only the wikilink wiring"]
    ],
    options: [
      ["--note NOTE", "Target note title"],
      ["--only KINDS", "Comma-separated subset: refs, links, overlaps"]
    ],
    notes: [
      "Overlap candidates are never auto-merged: synthesize content yourself, then use note replace / note redirect."
    ]
  }),
  digest: formatDetailedHelp({
    usage: "ipa [OPTIONS] digest NOTE [--max N] [--snippet-chars N]",
    summary: "Summarize an index/root note and its children (modified date, sections, snippet) in one call.",
    options: [
      ["--max N", "Maximum children to include (default 30)"],
      ["--snippet-chars N", "Snippet length per child (default 240)"]
    ],
    examples: [
      ["ipa digest \"🔖 Index Note\"", "Digest all children of an index"],
      ["ipa digest \"🔖 Index Note\" --max 10", "Digest the first 10 children"]
    ],
    notes: [
      "Use digest before opening children with view --full; read at most the 2-3 most relevant children in full."
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
      ["ipa tune log", "Show recorded search events"],
      ["ipa tune label --query Q --target NOTE", "Record a search label"],
      ["ipa tune testset init", "Create the vault-local testset file and configure test.file"],
      ["ipa tune testset list", "List vault-local testsets"],
      ["ipa tune testset show", "Show the active testset"],
      ["ipa tune testset validate", "Validate testset targets"],
      ["ipa tune testset draft --file FILE", "Draft testset cases from logged events"],
      ["ipa tune testset add --query Q --target NOTE", "Add one labelled test case"],
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
    styleSection("Subcommand options:"),
    formatRows([
      ["analyze --threshold N", "Candidate threshold; repeatable"],
      ["analyze --cap N", "Candidate max result cap"],
      ["analyze/replay --pack NAME", "Use a built-in query pack"],
      ["label --query Q", "Query to label"],
      ["label --target NOTE", "Expected target note for a hit"],
      ["label --miss", "Record the query as a miss"],
      ["log --limit N", "Show only the newest N events"],
      ["log --query TEXT", "Filter events by query substring"],
      ["testset init --file FILE", "Target testset file"],
      ["testset init --force", "Overwrite an existing testset file"],
      ["testset init --activate", "Set the new file as test.file"],
      ["testset show/validate [FILE]", "Inspect or validate a specific testset file"],
      ["testset draft/add --file FILE", "Write cases to a specific testset file"],
      ["testset add --query Q --target NOTE", "Add one labelled query target"]
    ]),
    "",
    styleSection("Vault setup:"),
    "  Configure the default testset in {vault}/.ipa/config.yaml:",
    "",
    "  test:",
    "    file: .ipa/tune/testsets/testset.json",
    "",
    styleSection("Search logging:"),
    "  Set IPA_SEARCH_LOG=1 when running ipa search to append JSONL events under .ipa/tune/logs/search-events.jsonl.",
    "  Use `ipa tune log` to inspect them and `ipa tune testset draft --file NAME` to draft test cases.",
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
  if (Array.isArray(payload.queries) && payload.queries.every((item) => item && Object.hasOwn(item, "query") && item.results)) return payload.queries.map(renderSearchResults).join("\n\n");
  if (payload.pack && Object.hasOwn(payload, "misses")) return renderTuneEval(payload);
  if (payload.optimizer && payload.best) return renderTuneRun(payload);
  if (payload.thresholds && payload.target_scores) return renderTuneAnalyze(payload);
  if (Object.hasOwn(payload, "replayed")) return renderTuneReplay(payload);
  if (payload.events) return renderTuneLog(payload);
  if (payload.operation === "config-init") return renderConfigInit(payload);
  if (payload.file && Object.hasOwn(payload, "config_updated") && Object.hasOwn(payload, "created")) return renderKeyValues("Tune testset", payload);
  if (payload.testsets) return renderTableReport("Tune testsets", ["Active", "File"], payload.testsets.map((item) => [payload.active === item ? "yes" : "", item]));
  if (Object.hasOwn(payload, "allowed")) return renderKeyValues("Harness guard", payload);
  if (payload.convention && payload.markdown) return `${styleTitle("IPA convention")}\n\n${payload.markdown.trimEnd()}`;
  if (payload.installed && payload.guard) return renderHarnessStatus(payload);
  if (payload.target && Object.hasOwn(payload, "installed") && (payload.files || payload.removed)) return renderHarnessChange(payload);
  if (payload.plugin_root && payload.created && payload.skipped) return renderPluginInit(payload);
  if (payload.installed && payload.issues) return renderHarnessDoctor(payload);
  if (payload.status && payload.checks) return renderDoctor(payload);
  if (payload.issues) return renderIssues(payload);
  if (payload.plugins) return renderPlugins(payload);
  if (payload.paths || payload.tree || payload.roots || payload.siblings) return renderTraversal(payload);
  if (payload.notes && payload.sources) return renderContext(payload);
  if (payload.channels) return renderChannels(payload.channels);
  if (payload.rules) return renderRules(payload.rules);
  if (payload.refactors) return renderRefactors(payload.refactors);
  if (payload.operation === "replace-in-note") return renderKeyValues("Note replace", payload);
  if (payload.operation === "set-note-field") return renderKeyValues("Note set", payload);
  if (payload.operation === "digest") return renderDigest(payload);
  if (payload.operation === "redirect-notes") return renderRedirect(payload);
  if (payload.operation === "cascade") return renderCascade(payload);
  if (payload.profile !== undefined && payload.vault_path && Object.hasOwn(payload, "created")) return renderKeyValues("Profile", payload);
  if (payload.profile !== undefined && payload.vault_path) return renderKeyValues("Active config", payload);
  if (payload.suggestions) return renderTableReport("Link suggestions", ["Suggestion", "Score"], payload.suggestions.map((item) => [item.target, item.score ?? "-"]));
  if (Object.hasOwn(payload, "up_to_date") || payload.reason === "not_a_git_checkout") return renderSelfUpdate(payload);
  if (payload.target && Object.hasOwn(payload, "updated")) return renderKeyValues("Harness update", { status: payload.status, target: payload.target, updated: payload.updated, components: (payload.components ?? []).join(", "), omitted: (payload.omitted_components ?? []).join(", ") || "-", "user-owned kept": (payload.skipped_user_owned ?? []).join(", ") || "-" });
  if (Array.isArray(payload.changes)) return renderTableReport("Planned changes", ["Note", "Path", "Target"], payload.changes.map((item) => [item.note ?? "-", item.path ?? "-", item.target ?? item.to ?? "-"]));
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
    lines.push("", table(["Score", "Type", "Note", "Modified", "Refs"], payload.results.map((hit) => [
      Number(hit.score).toFixed(3),
      hit.type ?? "?",
      hit.note,
      hit.modified ? String(hit.modified).split(" ")[0] : "",
      hit.refs?.join(", ") ?? ""
    ])));
  } else {
    for (const hit of payload.results) {
      const refs = hit.refs?.length ? `  ref→ ${hit.refs.join(", ")}` : "";
      lines.push(`  [ ${Number(hit.score).toFixed(1)}] [${String(hit.type ?? "?").padEnd(5)}] ${hit.note}${refs}`);
      const meta = [
        hit.modified ? String(hit.modified).split(" ")[0] : null,
        hit.snippet || null
      ].filter(Boolean).join(" · ");
      if (meta) lines.push(`         └ ${meta}`);
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

function renderRedirect(payload) {
  const lines = [
    `Note redirect ${payload.apply ? "(applied)" : "(preview)"}`,
    `  ${payload.sources.join(", ")} → ${payload.target}`
  ];
  if (payload.changes?.length) {
    lines.push("", table(["Note", "Path", "Links", "Refs"], payload.changes.map((item) => [
      item.note, item.path ?? "-", item.links ? "yes" : "", item.refs ? "yes" : ""
    ])));
  } else {
    lines.push("", "No references to rewire.");
  }
  if (payload.archived?.length) {
    lines.push("", ...payload.archived.map((item) => `archive: ${item.note} → ${item.to}`));
  }
  if (!payload.apply) lines.push("", "Run again with --apply to write the changes.");
  else lines.push("", "Run `ipa validator` to confirm link integrity.");
  return lines.join("\n");
}

function renderCascade(payload) {
  const lines = [`Cascade ${payload.apply ? "(applied)" : "(plan)"} for '${payload.note}'`];
  if (payload.ref_suggestions?.length) {
    lines.push("", "Ref suggestions (graph membership):");
    for (const item of payload.ref_suggestions) lines.push(`  - ${item.ref}  (${item.count} related notes)`);
  }
  if (payload.forward_links?.length) {
    lines.push("", "Forward links (wrap mentions inside this note):");
    for (const item of payload.forward_links) lines.push(`  - [[${item.target}]]  (${item.reason})`);
  }
  if (payload.reverse_links?.length) {
    lines.push("", "Reverse links (other notes mentioning this title):");
    for (const item of payload.reverse_links) lines.push(`  - ${item.note}`);
  }
  if (payload.overlaps?.length) {
    lines.push("", "Overlap candidates (report only — merge by hand if warranted):");
    for (const item of payload.overlaps) {
      lines.push(`  - [${Number(item.score).toFixed(1)}] ${item.note}  (matched: ${item.matched_query})`);
      if (item.snippet) lines.push(`      ${item.snippet}`);
    }
  }
  if (payload.applied?.length) {
    lines.push("", "Applied:");
    for (const item of payload.applied) lines.push(`  - ${item.kind}: ${item.note} ← ${item.value}`);
  }
  if (!payload.ref_suggestions?.length && !payload.forward_links?.length && !payload.reverse_links?.length && !payload.overlaps?.length) {
    lines.push("", "Nothing to cascade.");
  }
  if (!payload.apply) lines.push("", "Apply tier-1 wiring with: ipa cascade apply --note <note> [--only refs,links]");
  return lines.join("\n");
}

function renderDigest(payload) {
  const showing = payload.children_shown < payload.children_total
    ? ` (showing ${payload.children_shown})`
    : "";
  const lines = [`Digest for '${payload.note}' [${payload.type || "?"}]: children ${payload.children_total}${showing}`];
  if (payload.snippet) lines.push(`  ${payload.snippet}`);
  for (const item of payload.items ?? []) {
    const date = item.modified ? String(item.modified).split(" ")[0] : "";
    lines.push("", `- ${item.id}  [${item.type || "?"}]${date ? `  (${date})` : ""}`);
    if (item.snippet) lines.push(`  ${item.snippet}`);
    if (item.headings?.length) lines.push(`  sections: ${item.headings.join(" · ")}`);
  }
  if (!payload.items?.length) lines.push("", "(no children)");
  if (payload.children_shown < payload.children_total) {
    lines.push("", `→ ${payload.children_total - payload.children_shown} more children hidden; raise --max or view specific notes.`);
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

function renderTuneLog(payload) {
  if (!payload.events?.length) return `${styleTitle("Tune search log")}\n\n${styleWarn("No search events.")}`;
  return renderTableReport("Tune search log", ["Time", "Agent", "Turn", "Type", "Prompt", "Query", "Top result", "Count"], payload.events.map((event) => [
    event.ts ?? event.time ?? "-",
    event.agent ?? "-",
    event.turn_id ?? event.prompt_event_id ?? "-",
    event.event_type ?? event.type ?? "search",
    event.source_prompt ?? event.prompt ?? (event.event_type === "prompt" ? event.query : "-") ?? "-",
    event.generated_query ?? (event.event_type === "prompt" ? "-" : event.query ?? event.q ?? "-"),
    event.results?.[0]?.note ?? event.target ?? "-",
    event.count ?? event.results?.length ?? "-"
  ]));
}

// Vault-wide sweeps can report hundreds of rows; past this total the text
// renderer switches to per-code counts plus a few examples per code so the
// output stays proportional to the problem shape, not the vault size.
// --json always carries the full list.
const ISSUE_RENDER_CAP_TOTAL = 30;
const ISSUE_RENDER_PER_CODE = 5;
const PATCH_RENDER_CAP = 20;

function renderIssues(payload) {
  const title = payload.summary?.patches !== undefined ? "Formatter report" : "Issues";
  const lines = [styleTitle(title)];
  if (payload.status) lines.push(`Status: ${styleStatus(payload.status)}`);
  if (payload.summary) {
    lines.push(`Summary: ${Object.entries(payload.summary).map(([key, value]) => `${key}=${value}`).join(" ")}`);
  }
  if (payload.patches?.length) {
    const patchRows = payload.patches.slice(0, PATCH_RENDER_CAP).map((item) => [item.note ?? "-", item.path ?? "-", item.plugin ?? "-"]);
    lines.push("", table(["Note", "Path", "Plugin"], patchRows));
    if (payload.patches.length > PATCH_RENDER_CAP) {
      lines.push(styleMuted(`… +${payload.patches.length - PATCH_RENDER_CAP} more patch(es) — narrow with --note or use --json.`));
    }
  }
  if (!payload.issues.length) {
    lines.push("", styleGood("No issues."));
    return lines.join("\n");
  }
  let issues = payload.issues;
  let hidden = 0;
  if (issues.length > ISSUE_RENDER_CAP_TOTAL) {
    const counts = new Map();
    for (const item of issues) counts.set(item.code ?? "-", (counts.get(item.code ?? "-") ?? 0) + 1);
    lines.push("", table(["Count", "Code"], [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => [count, code])));
    const perCode = new Map();
    const shown = [];
    for (const item of issues) {
      const code = item.code ?? "-";
      const seen = perCode.get(code) ?? 0;
      if (seen < ISSUE_RENDER_PER_CODE) {
        shown.push(item);
        perCode.set(code, seen + 1);
      } else {
        hidden += 1;
      }
    }
    issues = shown;
  }
  lines.push("", table(["Severity", "Code", "Note", "Path", "Message"], issues.map((item) => [
    item.severity ?? "info",
    item.code ?? "-",
    item.note ?? "-",
    item.path ?? "-",
    item.message ?? "-"
  ])));
  if (hidden > 0) {
    lines.push(styleMuted(`… +${hidden} more issue(s) hidden (${ISSUE_RENDER_PER_CODE} shown per code) — narrow with --note "Note Title" or use --json for the full list.`));
  }
  return lines.join("\n");
}

function renderPlugins(payload) {
  if (!payload.plugins.length) return `${styleTitle("Plugins")}\n\n${styleWarn("No enabled plugins.")}`;
  return renderTableReport("Plugins", ["Kind", "Path"], payload.plugins.map((item) => [item.kind, item.path]));
}

function renderPluginInit(payload) {
  const lines = [
    styleTitle("Plugin scaffold"),
    "",
    formatRows([
      ["root", payload.plugin_root],
      ["examples", payload.examples ? "yes" : "no"]
    ])
  ];
  for (const [label, items] of [
    ["Created", payload.created],
    ["Updated", payload.updated],
    ["Existing", payload.existing],
    ["Skipped", payload.skipped]
  ]) {
    if (items?.length) lines.push("", `${label}:`, ...items.map((item) => `  ${item}`));
  }
  return lines.join("\n");
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
  const searchRows = (payload.search_results?.length ? payload.search_results : payload.notes).map((note) => [
    note.score === null || note.score === undefined ? "-" : Number(note.score).toFixed(2),
    note.type || "?",
    note.note ?? note.id,
    locationLabel(note.location),
    note.path,
    refLabels(note.ref_details, note.refs).join(", ")
  ]);
  if (searchRows.length) lines.push(styleSection("Search results"), table(["Score", "Type", "Note", "Loc", "Path", "Refs"], searchRows));
  if (payload.ref_distribution?.length) {
    lines.push("", styleSection("Ref distribution"), table(["Count", "Ref", "Loc", "Path"], payload.ref_distribution.map((item) => [
      item.count,
      item.ref,
      locationLabel(item.location),
      item.path || "-"
    ])));
  }
  if (payload.tag_distribution?.length) {
    lines.push("", styleSection("Tag distribution"), table(["Count", "Tag"], payload.tag_distribution.map((item) => [
      item.count,
      item.tag
    ])));
  }
  for (const note of payload.notes) {
    lines.push("", `## ${note.id}`, `type: ${note.type || "?"}`, `location: ${locationLabel(note.location)}`, `path: ${note.path}`);
    if (note.refs?.length) lines.push(`refs: ${refLabels(note.ref_details, note.refs).join(", ")}`);
    if (note.tags?.length) lines.push(`tags: ${note.tags.join(", ")}`);
    if (note.upward_paths?.length) {
      lines.push("traversal:");
      const detailed = note.traversal?.upward;
      const paths = detailed?.length ? detailed : note.upward_paths;
      for (const path of paths) lines.push(`  - ${formatTraversalPath(path)}`);
    }
    if (note.content_mode === "full" && note.body) lines.push("body:", indentBlock(note.body, "  "));
    else lines.push(...formatOverview(note.overview));
  }
  if (payload.next_commands?.length) lines.push("", "Next commands:", ...payload.next_commands.map((command) => `  ${command}`));
  if (payload.warnings?.length) lines.push("", renderIssues({ issues: payload.warnings }));
  return truncateRenderedContext(lines.join("\n"), payload.budget?.max_chars);
}

function locationLabel(location) {
  if (!location) return "-";
  return location.kind || "-";
}

function refLabels(details = [], refs = []) {
  if (details?.length) {
    return details.map((item) => `${item.id}${item.location?.kind ? ` [${item.location.kind}]` : ""}`);
  }
  return (refs ?? []).map((ref) => String(ref));
}

function formatTraversalPath(path) {
  return path.map((item) => {
    if (typeof item === "string") return item;
    return `${item.id}${item.location?.kind ? ` [${item.location.kind}]` : ""}`;
  }).join(" -> ");
}

function formatOverview(overview) {
  const headings = overview?.headings ?? [];
  if (!headings.length) return ["overview:", "  (no headings)"];
  return [
    "overview:",
    ...headings.map((heading) => `  - H${heading.level} ${heading.title}${heading.line ? ` (line ${heading.line})` : ""}`)
  ];
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
    "ref-replace": "frontmatter ref 교체 (전체 vault)",
    "tag-rename": "태그 이름 변경 (전체 vault)",
    "tag-remove": "태그 제거 (전체 vault)",
    "tag-add": "태그 추가 (전체 vault)",
    "wikilink-replace": "본문 wikilink 치환 (전체 vault)",
    "ref-add": "frontmatter ref 추가 (전체 vault)",
    "ref-remove": "frontmatter ref 제거 (전체 vault)"
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
  if (payload.issues?.length) lines.push("", renderIssues({ issues: payload.issues }));
  else lines.push("", styleGood("No issues."));
  return lines.join("\n");
}

function renderHarnessStatus(payload) {
  const lines = [
    styleTitle("Harness status"),
    "",
    formatRows([
      ["installed", payload.installed.length ? payload.installed.join(", ") : "-"],
      ["manifest", payload.manifest ?? "-"],
      ["plugin scaffold", payload.plugin_scaffold?.types ? "yes" : "no"],
      ["guard policy", payload.guard?.policy ?? "-"],
      ["inbox", payload.guard?.inbox_dir ?? "-"],
      ["archive", payload.guard?.archive_dir ?? "-"],
      ["guard allow", (payload.guard?.allow ?? []).length ? payload.guard.allow.join(", ") : "-"],
      ["fragments", (payload.fragments ?? []).length ? payload.fragments.join(", ") : "-"]
    ])
  ];
  const globalRows = Object.entries(payload.global ?? {}).map(([target, state]) => [
    target,
    state.skill ? "yes" : "no",
    state.guard_hook ? "yes" : "no",
    state.prompt ? "yes" : "no",
    state.markdown_nudge_hook ? "yes" : "no"
  ]);
  if (globalRows.length) lines.push("", table(["target", "skill", "guard", "prompt", "md nudge"], globalRows));
  const componentRows = Object.entries(payload.global ?? {}).flatMap(([target, state]) => {
    if (!state.selected_components) return [];
    const rows = [
      [`selected (${target})`, state.selected_components.length ? state.selected_components.join(", ") : "-"],
      [`omitted (${target})`, (state.omitted_components ?? []).length ? state.omitted_components.join(", ") : "-"]
    ];
    if ((state.user_owned_components ?? []).length) {
      rows.push([`user-owned (${target})`, state.user_owned_components.join(", ")]);
    }
    return rows;
  });
  if (componentRows.length) {
    lines.push("", formatRows(componentRows));
  } else {
    const selectedComponents = payload.components?.selected ?? [];
    const omittedComponents = payload.components?.omitted ?? [];
    if (selectedComponents.length || omittedComponents.length) {
      lines.push("", formatRows([
        ["selected", selectedComponents.length ? selectedComponents.join(", ") : "-"],
        ["omitted", omittedComponents.length ? omittedComponents.join(", ") : "-"]
      ]));
    }
  }
  return lines.join("\n");
}

function renderHarnessDoctor(payload) {
  const lines = [styleTitle("Harness doctor"), `Status: ${styleStatus(payload.status)}`];
  const targets = [...(payload.installed ?? [])];
  for (const issue of payload.issues ?? []) {
    const target = issue.target ?? "-";
    if (!targets.includes(target)) targets.push(target);
  }
  if (!targets.length) {
    lines.push("", styleGood("No issues."));
    return lines.join("\n");
  }
  for (const target of targets) {
    const issues = (payload.issues ?? []).filter((item) => (item.target ?? "-") === target);
    if (!issues.length) {
      lines.push("", `${target}: ${styleGood("no issues")}`);
      continue;
    }
    lines.push("", styleTitle(target), table(["Severity", "Code", "Message"], issues.map((item) => [
      item.severity ?? "info",
      item.code ?? "-",
      item.message ?? "-"
    ])));
  }
  return lines.join("\n");
}

function renderHarnessChange(payload) {
  const lines = [
    styleTitle(payload.installed ? `Harness install: ${payload.target}` : `Harness uninstall: ${payload.target}`),
    "",
    `Status: ${payload.installed ? styleGood("installed") : styleWarn("removed")}`
  ];
  if (payload.files?.length) lines.push("", "Vault-local files:", ...payload.files.map((file) => `  ${file}`));
  if (payload.plugin_init) {
    const created = payload.plugin_init.created?.length ?? 0;
    const existing = payload.plugin_init.existing?.length ?? 0;
    const skipped = payload.plugin_init.skipped?.length ?? 0;
    lines.push("", `Plugin scaffold: ${created} created, ${existing} existing, ${skipped} skipped`);
  }
  if (payload.global_files?.length) lines.push("", "Global files:", ...payload.global_files.map((file) => `  ${file}`));
  if (payload.skipped_user_owned?.length) {
    lines.push("", "Skipped user-owned files (marker removed; left untouched):", ...payload.skipped_user_owned.map((file) => `  ${file}`));
  }
  if (payload.removed?.length) lines.push("", "Removed vault-local files:", ...payload.removed.map((file) => `  ${file}`));
  if (payload.global_removed?.length) lines.push("", "Removed global files:", ...payload.global_removed.map((file) => `  ${file}`));
  return lines.join("\n");
}

function renderSelfUpdate(payload) {
  if (payload.reason === "not_a_git_checkout") {
    return `${styleTitle("ipa update")}\n\n${styleWarn(payload.message)}`;
  }
  const lines = [styleTitle(`ipa update (${payload.mode})`), ""];
  lines.push(`repo     ${payload.repo_root}`);
  lines.push(`version  ${payload.version ?? "unknown"}${payload.commit ? ` (${payload.commit})` : ""}  branch ${payload.branch ?? "-"} -> ${payload.upstream}`);
  if (!payload.fetch_ok) lines.push(styleWarn("git fetch failed; behind/ahead counts may be stale"));
  if (payload.dirty) lines.push(styleWarn("worktree has uncommitted changes"));
  if (payload.status === "error") {
    lines.push("", styleWarn(`error: ${payload.message}`));
    return lines.join("\n");
  }
  if (payload.up_to_date) {
    lines.push("", "already up to date");
  } else {
    lines.push("", `behind ${payload.behind} commit(s)${payload.ahead ? `, ahead ${payload.ahead}` : ""}:`);
    lines.push(...payload.changes.map((change) => `  ${change}`));
    if (payload.mode === "plan") {
      lines.push("", "to update, run `ipa update --apply` or:", ...payload.commands.map((cmd) => `  ${cmd}`));
    }
  }
  if (payload.applied) {
    lines.push("", `updated to ${payload.commit_after}`, styleMuted(payload.next));
  }
  return lines.join("\n");
}

function renderConfigInit(payload) {
  const status = payload.overwritten ? "overwritten" : "created";
  const rows = renderKeyValues("Config init", {
    path: payload.path,
    status,
    inbox: payload.inbox,
    project: payload.project,
    archive: payload.archive,
    fragment: `${payload.fragment_path} (${payload.fragment_created ? "created" : "kept"})`
  });
  const hint = styleMuted(`Next: match folders/fields to your vault, then ${(payload.next_steps ?? []).join(" / ")}`);
  return `${rows}\n\n${hint}`;
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

function collectComponents(value, previous) {
  const segments = String(value)
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return [...previous, ...segments];
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
    .option("--version", "Show version information")
    .helpOption("--help", "Show this help message")
    .addHelpCommand(false)
    .action(() => {
      if (program.opts().version) {
        const info = cliVersionInfo();
        if (jsonOutput(program)) print(info, true);
        else console.log(`ipa ${info.version ?? "unknown"}${info.commit ? ` (${info.commit})` : ""}`);
        return;
      }
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
    .argument("[query...]", "Search query; several quoted queries run in one call")
    .option("--max <number>", "Maximum result count")
    .option("--threshold <number>", "Minimum score threshold")
    .option("--all", "Show all scored notes by forcing threshold 0")
    .option("--join", "Treat all arguments as one space-joined query")
    .action(async (queryParts, options) => {
      const searchOptions = {
        threshold: optionNumber(options.threshold),
        maxResults: optionNumber(options.max),
        showAll: Boolean(options.all),
        logCwd: process.cwd()
      };
      await withVault(globalOptions(program), async (vault) => {
        if (queryParts.length > 1 && !options.join) {
          print(await searchVaultMany(vault, queryParts, searchOptions), jsonOutput(program));
          return;
        }
        print(await searchVault(vault, queryParts.join(" "), searchOptions), jsonOutput(program));
      });
    });

  setHelp(program.command("view"), "view")
    .argument("<notes...>", "Note titles")
    .option("--full", "Show the full note body and footer")
    .option("--section <heading>", "Show one markdown section")
    .action(async (notes, options) => {
      await withVault(globalOptions(program), async (vault) => {
        const rendered = [];
        for (const note of notes) {
          rendered.push(await viewNote(vault, note, {
            full: Boolean(options.full),
            section: options.section ?? null
          }));
        }
        print(rendered.join("\n\n"));
      });
    });

  setHelp(program.command("digest"), "digest")
    .argument("<notes...>", "Index or root note titles")
    .option("--max <number>", "Maximum children to include")
    .option("--snippet-chars <number>", "Snippet length per child")
    .action(async (notes, options) => {
      await withVault(globalOptions(program), async (vault) => {
        const results = [];
        for (const note of notes) {
          results.push(await digestNote(vault, note, {
            max: optionNumber(options.max),
            snippetChars: optionNumber(options.snippetChars)
          }));
        }
        if (results.length === 1) print(results[0], jsonOutput(program));
        else if (jsonOutput(program)) print(results, true);
        else print(results.map((result) => render(result)).join("\n\n"));
      });
    });

  setHelp(program.command("cascade"), "cascade")
    .argument("<mode>", "plan or apply")
    .requiredOption("--note <note>", "Target note title")
    .option("--only <kinds>", "Comma-separated: refs,links,overlaps")
    .action(async (mode, options) => {
      if (!["plan", "apply"].includes(mode)) throw new Error(`unknown cascade mode: ${mode}`);
      const only = String(options.only ?? "").split(",").map((item) => item.trim()).filter(Boolean);
      await withVault(globalOptions(program), async (vault) => print(await cascadeNote(vault, options.note, {
        apply: mode === "apply",
        only: only.length ? only : undefined
      }), jsonOutput(program)));
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
    .option("--note <notes...>", "Restrict reported issues to note titles")
    .action(async (options) => {
      await withVault(globalOptions(program), async (vault) => print(await validateVault(vault, null, {
        notes: optionalList(options.note)
      }), jsonOutput(program)));
    });

  setHelp(program.command("doctor"), "doctor")
    .option("--fix-dirs", "Create missing expected directories")
    .option("--check <name>", "Run one check (config or cache)")
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

  const noteCommand = setHelp(program.command("note"), "note");
  noteCommand
    .command("replace")
    .argument("<note>", "Note title")
    .requiredOption("--old-file <path>", "File containing the exact text to replace")
    .requiredOption("--new-file <path>", "File containing replacement text")
    .option("--apply", "Apply the replacement")
    .option("--allow-multiple", "Allow replacing multiple matches")
    .option("--keep-files", "Keep --old-file/--new-file after a successful apply")
    .action(async (note, options) => {
      const oldPath = resolve(options.oldFile);
      const newPath = resolve(options.newFile);
      const oldText = await readFile(oldPath, "utf8");
      const newText = await readFile(newPath, "utf8");
      await withVault(globalOptions(program), async (vault) => {
        const result = await replaceInNote(vault, note, oldText, newText, {
          apply: Boolean(options.apply),
          allowMultiple: Boolean(options.allowMultiple)
        });
        if (result.applied && !options.keepFiles) {
          const cleaned = [];
          for (const path of new Set([oldPath, newPath])) {
            if (!path.split(sep).includes(".tmp")) continue;
            try {
              await unlink(path);
              cleaned.push(relative(process.cwd(), path) || path);
            } catch {
              // keep going — cleanup is best-effort
            }
          }
          if (cleaned.length) result.cleaned_files = cleaned.join(", ");
        }
        print(result, jsonOutput(program));
      });
    });

  noteCommand
    .command("set")
    .argument("<notes...>", "Note titles")
    .requiredOption("--field <name>", "Frontmatter field name")
    .option("--value <value>", "Scalar value to set")
    .option("--add <value>", "List item to add", collectRepeated, [])
    .option("--remove <value>", "List item to remove", collectRepeated, [])
    .option("--apply", "Apply the change")
    .action(async (notes, options) => {
      await withVault(globalOptions(program), async (vault) => {
        const results = [];
        for (const note of notes) {
          results.push(await setNoteField(vault, note, options.field, {
            value: options.value,
            add: optionalList(options.add),
            remove: optionalList(options.remove),
            apply: Boolean(options.apply)
          }));
        }
        if (results.length === 1) print(results[0], jsonOutput(program));
        else if (jsonOutput(program)) print(results, true);
        else print(results.map((result) => render(result)).join("\n\n"));
      });
    });

  noteCommand
    .command("redirect")
    .argument("<notes...>", "Source note titles")
    .requiredOption("--to <note>", "Target note title")
    .option("--archive", "Move source notes into the archive folder")
    .option("--apply", "Apply the redirect")
    .action(async (notes, options) => {
      await withVault(globalOptions(program), async (vault) => print(await redirectNotes(vault, notes, options.to, {
        archive: Boolean(options.archive),
        apply: Boolean(options.apply)
      }), jsonOutput(program)));
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
    .command("init")
    .option("--force", "Overwrite an existing .ipa/config.yaml")
    .option("--inbox <name>", "Inbox folder name to record in the mapping")
    .option("--project <name>", "Project folder name to record in the mapping")
    .option("--archive <name>", "Archive folder name to record in the mapping")
    .action(async (options) => {
      await withVault(globalOptions(program), async (vault) => print(await configInit(vault, {
        force: Boolean(options.force),
        inbox: options.inbox,
        project: options.project,
        archive: options.archive
      }), jsonOutput(program)));
    });
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
    .command("init")
    .option("--name <name>", "Profile name", "ipa")
    .option("--vault <path>", "Vault path", "~/ipa")
    .option("--force", "Update an existing initialized profile")
    .action(async (options) => {
      print(await initProfileRegistry({
        name: options.name,
        vault: program.opts().vault ?? options.vault,
        force: Boolean(options.force)
      }), jsonOutput(program));
    });
  profileCommand
    .command("new")
    .argument("<name>", "Profile name")
    .argument("<vault>", "Vault path")
    .option("--default", "Mark this profile as default")
    .option("--force", "Update the profile if it already exists")
    .action(async (name, vault, options) => {
      print(await createProfile(name, vault, {
        default: Boolean(options.default),
        force: Boolean(options.force)
      }), jsonOutput(program));
    });
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
    .command("show", { isDefault: true })
    .action(async () => {
      await withVault(globalOptions(program), async (vault) => print(await conventionShow(vault), jsonOutput(program)));
    });
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
        notes: optionalList(options.note),
        // Surface apply-gated rule patches (e.g. date_modified sync) at plan
        // time so plan/apply report the same patch set. fs writes stay off.
        ruleApply: true
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

  setHelp(program.command("update"), "update")
    .option("--apply", "Fast-forward pull, install dependencies, and rebuild")
    .action(async (options) => {
      const result = await selfUpdate({ apply: Boolean(options.apply), stream: !jsonOutput(program) });
      if (options.apply && result.status === "ok") {
        // Keep an installed vault-local Obsidian plugin in step with the CLI:
        // sync the freshly built bundle when the active vault carries one.
        try {
          const resolved = await resolveSettings(globalOptions(program));
          result.obsidian_sync = await obsidianPluginSync(resolved.vaultPath);
        } catch {
          result.obsidian_sync = { status: "ok", synced: false, reason: "no_vault_resolved" };
        }
      }
      print(result, jsonOutput(program));
      if (result.status === "error") process.exitCode = 1;
    });

  const obsidianCommand = setHelp(program.command("obsidian"), "obsidian");
  obsidianCommand
    .command("install")
    .action(async () => {
      await withVault(globalOptions(program), async (vault) => {
        const result = await obsidianPluginSync(vault, { install: true });
        print(result, jsonOutput(program));
        if (result.status === "error") process.exitCode = 1;
      });
    });
  obsidianCommand
    .command("sync")
    .action(async () => {
      await withVault(globalOptions(program), async (vault) => {
        const result = await obsidianPluginSync(vault);
        print(result, jsonOutput(program));
        if (result.status === "error") process.exitCode = 1;
      });
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
    .command("init")
    .argument("[target]", "Harness target", "codex")
    .option("--only <component...>", "Install only the named components", collectComponents, [])
    .option("--with <component...>", "Add components to the default set", collectComponents, [])
    .option("--without <component...>", "Remove components from the default set", collectComponents, [])
    .action(async (target, options) => {
      await withVault(globalOptions(program), async (vault, resolved) => print(await harnessInstall(vault, target, {
        profile: resolved.profile,
        components: {
          only: optionalList(options.only),
          with: optionalList(options["with"]),
          without: optionalList(options.without)
        }
      }), jsonOutput(program)));
    });
  harnessCommand
    .command("install")
    .argument("[target]", "Harness target", "codex")
    .option("--only <component...>", "Install only the named components", collectComponents, [])
    .option("--with <component...>", "Add components to the default set", collectComponents, [])
    .option("--without <component...>", "Remove components from the default set", collectComponents, [])
    .action(async (target, options) => {
      await withVault(globalOptions(program), async (vault, resolved) => print(await harnessInstall(vault, target, {
        profile: resolved.profile,
        components: {
          only: optionalList(options.only),
          with: optionalList(options["with"]),
          without: optionalList(options.without)
        }
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
    .command("update")
    .argument("[target]", "Harness target", "codex")
    .option("--only <component...>", "Update to exactly the named components", collectComponents, [])
    .option("--with <component...>", "Add components to the stored selection", collectComponents, [])
    .option("--without <component...>", "Remove components from the stored selection", collectComponents, [])
    .action(async (target, options) => {
      await withVault(globalOptions(program), async (vault, resolved) => {
        const result = await harnessUpdate(vault, target, {
          profile: resolved.profile,
          components: {
            only: optionalList(options.only),
            with: optionalList(options["with"]),
            without: optionalList(options.without)
          }
        });
        print(result, jsonOutput(program));
        if (result.status === "error") process.exitCode = 1;
      });
    });
  harnessCommand
    .command("doctor")
    .action(async () => {
      await withVault(globalOptions(program), async (vault, resolved) => print(await harnessDoctor(vault, {
        profile: resolved.profile
      }), jsonOutput(program)));
    });
  harnessCommand
    .command("gate")
    .option("--session <id>", "Session id scoping pending edits")
    .action(async (options) => {
      await withVault(globalOptions(program), async (vault, resolved) => {
        const result = await harnessSessionGate(vault, {
          profile: resolved.profile,
          session: options.session
        });
        print(result, jsonOutput(program));
        if (result.block) process.exitCode = 1;
      });
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
      await withVault(globalOptions(program), async (vault) => print(await suggestLinks(vault, note), jsonOutput(program)));
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
  pluginCommand
    .command("init")
    .option("--force", "Overwrite existing scaffold files")
    .option("--no-examples", "Skip disabled example plugin files")
    .action(async (options) => {
      await withVault(globalOptions(program), async (vault) => print(await pluginInit(vault, {
        force: Boolean(options.force),
        examples: options.examples
      }), jsonOutput(program)));
    });
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
  tuneCommand
    .command("log")
    .option("--limit <number>", "Show only the newest N events")
    .option("--query <query>", "Filter events by query substring")
    .action(async (options) => {
      await withVault(globalOptions(program), async (vault) => print(await tuneLog(vault, {
        limit: optionNumber(options.limit),
        query: options.query
      }), jsonOutput(program)));
    });
  const testsetCommand = tuneCommand.command("testset");
  testsetCommand.action(async () => {
    await withVault(globalOptions(program), async (vault) => print(await tuneTestsetList(vault), jsonOutput(program)));
  });
  testsetCommand.command("list").action(async () => {
    await withVault(globalOptions(program), async (vault) => print(await tuneTestsetList(vault), jsonOutput(program)));
  });
  testsetCommand
    .command("init")
    .option("--file <file>", "Target testset file")
    .option("--force", "Overwrite an existing testset file")
    .option("--activate", "Set this file as test.file even when another testset is active")
    .action(async (options) => {
      await withVault(globalOptions(program), async (vault) => print(await tuneTestsetInit(vault, {
        file: options.file,
        force: Boolean(options.force),
        activate: Boolean(options.activate)
      }), jsonOutput(program)));
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

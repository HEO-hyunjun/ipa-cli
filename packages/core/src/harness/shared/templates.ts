import { HARNESS_MARKER } from "../managedFiles.js";

// The global prompt block is loaded into every session, vault-related or not,
// so it contains only the trigger, source-of-truth pointers, and write safety.
export function globalPromptContent(spec, options = {}) {
  const tool = spec.adapter.displayName;
  const skillPath = spec.adapter.skillDisplayPath;
  const contextual = options.recallMode === "contextual";
  const recall = contextual
    ? "Use IPA when private vault history could materially change planning, architecture, resumption, handoff, status, or ownership decisions, even when notes are not named."
    : "Use IPA only when the user explicitly asks for IPA/vault/note work, names a vault note or path, or invokes the `ipa` skill. Do not proactively scan the vault for self-contained work.";
  return `## IPA Vault

This ${tool} environment has the IPA CLI installed for the user's private note vault.

- ${recall}
- Start with \`ipa search\`, \`ipa view\`, or \`ipa context\`; batch related queries or note titles in one call and stop once the needed evidence is found.
- Code and git are authoritative for current behavior. Use vault notes for intent and private history, and report conflicts.
- The CLI help is the command source of truth: \`ipa help\`, \`ipa help --all\`, and \`ipa <command> --help\`. IPA concepts and active vault rules: \`ipa convention\`.
- Full workflow: the \`ipa\` skill at \`${skillPath}\`.
- Create notes with \`ipa inbox add\`. Core note mutations finalize themselves; after a raw Markdown edit run one \`ipa note finalize "Note Title"\` call.`;
}

function profileRegistryDisplay() {
  return process.env.XDG_CONFIG_HOME ? "$XDG_CONFIG_HOME/ipa/profile.yaml" : "~/.config/ipa/profile.yaml";
}

function commandPrefix(vaultPath, options = {}, local = false) {
  return "ipa";
}

export const VAULT_LOCAL_SKILLS = [
  {
    name: "ipa-rule",
    description: "Create, modify, review, and debug IPA vault convention rules using .ipa/plugins/rules/*.js and formatter fixes. Use this skill whenever the user mentions IPA rules, vault conventions, frontmatter requirements, title/tag/ref validation, folder/type policy, validator warnings, formatter rule fixes, or wants the vault to enforce a custom convention.",
    body: (mapping) => `# IPA Rule Skill

Use this skill when the user wants to add, change, review, or debug IPA vault conventions such as frontmatter rules, note title rules, folder/type rules, tag rules, or formatter fixes.

## Workflow

1. Inspect the active convention surface with \`ipa list-rules\` and \`ipa validator\`.
2. Scaffold plugin authoring files with \`ipa plugin init\` if \`.ipa/plugins\` is missing; it drops runnable \`_example-*.js\` rules to copy from.
3. Read \`.ipa/plugins/types/ipa-plugin.d.ts\` for the \`Note\` and \`RuleContext\` field shapes — read it to learn the field shapes before writing check logic. Use \`// @ts-check\` and \`import("../types/ipa-plugin").Rule\` in each rule file.
4. Write the check as a \`checkNote(note, ctx)\` rule under \`.ipa/plugins/rules/*.js\`. Count an index's children with \`ctx.childCount(note)\` and a note's inbound references (notes pointing at it through \`${mapping.refs}\`) with \`ctx.backlinkCount(note)\` — both apply the vault's title-normalized matching. Reserve \`checkVault(ctx)\` / \`scope: "vault"\` for whole-vault aggregates; those are exercised by \`ipa validator\`, not by dry-run.
5. Verify instantly with \`ipa plugin dry-run rules .ipa/plugins/rules/<rule>.js --note "Note Title"\` — a \`checkNote\` rule fires per note here, so you see it the moment you save.
6. Validate the plugin shape with \`ipa plugin validate .ipa/plugins/rules/<rule>.js\`, then re-run \`ipa list-rules\` and \`ipa validator\` after enabling it.
7. If the rule has a safe fix, verify the formatter loop with \`ipa formatter plan --note "Note Title"\` and \`ipa formatter apply --note "Note Title"\`.

Inspect and debug installed plugins with \`ipa plugin list\` and \`ipa plugin doctor\`.

Keep rules narrow and convention-focused. Do not use rule plugins for search ranking; use an IPA search plugin or the ipa-tune workflow instead.`
  },
  {
    name: "ipa-config",
    description: "Configure IPA vault and profile settings in .ipa/config.yaml and the global IPA profile registry. Use this skill whenever the user asks about ipa config init, ipa config show, IPA_PROFILE, profile init/new/use/list/current, vault selection, bootstrapping a new/empty vault, folder/field mapping, files.exclude, plugin enablement, search channels, test.file, weights.file, or profile/config troubleshooting.",
    body: `# IPA Config Skill

Use this skill when the user wants to inspect or change IPA profile selection, vault mappings, folder names, plugin policy, search channels, active tune results, or \`.ipa/config.yaml\`.

## Workflow

1. Resolve the active context first with \`ipa config show\`.
2. If \`.ipa/config.yaml\` is missing (new/empty vault), create it with \`ipa config init\` — absorb an existing folder layout via \`--inbox/--project/--archive\`, then edit \`mapping\` so folder/field names match the vault. Match the config to the vault, not the vault to the defaults.
3. Propose the setup plan from a quick structural scan — the folder layout plus a handful of sample notes' frontmatter. Do not exhaustively enumerate every note or every frontmatter key before proposing; refine after the user confirms.
4. Inspect profile state with \`ipa profile current\` and \`ipa profile list\`.
5. Create or update profiles with \`ipa profile init --vault <path>\`, \`ipa profile new <name> <path>\`, or \`ipa profile use <name>\`.
6. Keep machine-global profile concerns in the profile registry and vault-specific policy in \`.ipa/config.yaml\`.
7. For vault-local config, prefer minimal edits to mapping, folders, files.exclude, plugins, search channel toggles, test.file, and weights.file.
8. After changing \`mapping\` fields or folder names, re-render the installed harness with \`ipa harness update <target>\` (for example \`ipa harness update claude\`): prompt blocks and skills print the mapped field/folder names, so they stay stale until re-rendered.
9. Verify config-sensitive behavior with \`ipa config show\`, \`ipa list-rules\`, \`ipa list-channels\`, \`ipa validator\`, and a focused \`ipa search "keyword"\`.

## Onboarding Close

Before finishing a fresh setup, optionally (offer it; the user may skip) confirm two categories of vault policy. The organizing principle: CLI에 담을 칸이 있으면 config.yaml, 없으면 fragment.

- **Mapping — has a config slot.** Existing folder names → inbox/project/archive and frontmatter field names go in \`.ipa/config.yaml\` via \`ipa config init --inbox/--project/--archive\` (then edit \`mapping\`). Absorb the vault's real structure; do not reshape the vault to the defaults.
- **Operating rules — no config slot, pure policy.** Ask up to four short questions: ⓐ where work/scratch docs go, ⓑ auto-migrate/organize vs confirm each time, ⓒ folders/notes never to touch, ⓓ title/tag conventions. Write the answers into \`.ipa/harness/fragments/prompt.md\` (\`ipa config init\` seeds an empty template there), then \`ipa harness update <target>\` to inline them into managed prompts.

Hard rule regardless of answers: never rename the user's folders or run vault-wide changes (mass move/backfill) without asking — absorb the existing structure through mapping instead.

Do not hard-code one user's absolute vault path into vault-local files. Use project-local selectors, profiles, or documented setup commands instead.`
  },
  {
    name: "ipa-tune",
    description: "Guide IPA search tuning from recent search logs to labelled testsets, tune result analysis, and safe activation. Use this skill whenever the user wants better IPA search results, says a search result was wrong, asks to review tune logs, sample cases, label correct notes, build or validate a testset, analyze weights/threshold/cap, or apply a tune result.",
    body: `# IPA Tune Skill

Use this skill when the user wants to improve IPA search quality, review misses, create search evaluation cases, analyze tune results, or apply tuned weights.

## Rules

- Treat prompt and search logs as evidence, not labels. A prompt event tells you what the user asked; it does not prove the correct note.
- When the optional \`hook:evidence\` component is installed, prompts and search calls are paired automatically (\`prompt_event_id\`/\`source_prompt\`); otherwise enable logging explicitly with \`IPA_SEARCH_LOG=1\`.
- Use \`prompt_event_id\`, \`turn_id\`, \`source_prompt\`, and \`generated_query\` to connect prompt/search pairs. If a prompt has no matching search event, treat it as "no query was run" rather than inferring one from nearby timestamps.
- Do not run the optimizer by default. Present the command and wait unless the user explicitly asks you to execute it.
- Do not activate a tune result just because it is newest. Activate only a reviewed artifact that improves the target cases without obvious regressions.

## Workflow

1. Confirm the active tune surface before changing anything:
   - Run \`ipa config show\` when vault/profile selection might matter.
   - Run \`ipa tune testset list\` to see the configured \`.ipa/config.yaml\` \`test.file\`.
   - Run \`ipa tune testset show\` or \`ipa tune testset show <file>\` to inspect the current cases and query count.
   - If no vault-local testset exists, initialize one with \`ipa tune testset init --file testset.json\`. Do not use the sample \`ipa-cli-core\` pack unless the user explicitly asks for a fixture/demo pack.
2. Gather evidence from recent activity:
   - Inspect recent events with \`ipa tune log --limit 50\`.
   - Narrow noisy logs with \`ipa tune log --query "keyword"\`.
   - If the log only has prompt events or lacks result lists, rerun focused \`ipa search "keyword"\` checks before drafting labels.
   - Preserve the user's natural query text when it is the query being evaluated; do not replace it with an internal summary unless you are creating a separate variant case.
3. Draft or fetch candidate test cases:
   - Use \`ipa tune testset draft --file testset.json\` to convert logged events that already contain explicit targets into a draft file.
   - Expect \`draft\` to produce zero cases when logs contain only prompts/search results without a \`target\`, \`note\`, \`selected\`, or \`clicked\` field.
   - After drafting, run \`ipa tune testset show testset.json\` and review every row. Do not bulk-accept draft rows without checking the query and target.
4. Confirm labels with the user before adding cases:
   - Show the original request/context, exact search query, observed top results, and the proposed target note.
   - Ask which note should be the correct target when the query failed, was ambiguous, or came from a prompt event.
   - Do not infer a label from an "obvious" top result. No explicit confirmation means no \`testset add\`.
5. Add confirmed cases deliberately:
   - Use \`ipa tune testset add --file testset.json --query "user query" --target "Correct Note"\` for each confirmed regression case.
   - Use the exact note title accepted by IPA search/view, not a raw path.
   - If the user wants an audit trail, also record \`ipa tune label --query "user query" --target "Correct Note"\`; this does not replace adding the case to the testset.
   - Keep scenario or multi-target cases as manual JSON edits only when needed, then validate immediately.
6. Validate and baseline before tuning:
   - Run \`ipa tune testset validate testset.json\` and resolve missing targets or malformed cases first.
   - Run \`ipa tune eval\` to establish baseline loss, miss count, average rank, and the active pack path.
   - For important misses, run focused \`ipa search "keyword"\` checks so the user can see the current behavior.
7. Propose the tune run:
   - Recommend a command such as \`ipa tune --trials 200\` for a small/medium testset or \`ipa tune --trials 500 --quiet\` for a broader one.
   - Use \`--apply\` only when the user explicitly wants the new result activated immediately.
   - Otherwise, present the command and wait for the user to run it.
8. Review tune artifacts after a run:
   - Run \`ipa tune list\` to identify the newest result and the active marker.
   - Run \`ipa tune analyze\` to inspect threshold/cap behavior and score distribution.
   - Run \`ipa tune replay <result.json>\` when comparing a saved artifact against the current vault/testset.
   - Summarize weight, threshold, cap, loss, hit/miss, and average-rank changes. Call out likely regressions.
9. Activate only a reviewed result:
   - Use \`ipa tune use <result.json>\` only for the artifact the user chose.
   - Run \`ipa tune eval\` after activation to confirm the active weights behave as expected.
   - Re-run focused \`ipa search "keyword"\` checks for the original problem queries and any regression-sensitive queries.
10. Close the loop:
   - Report what was added to the testset, which result was reviewed or activated, and which searches verify the behavior.
   - If the result is weak, recommend more representative labels instead of simply increasing trial count.

## Label Confirmation Protocol

Before adding any testset case, present candidates in this form:

\`\`\`text
Original request/context: ...
Search query: ...
Observed results:
1. Note A
2. Note B
3. Note C

Which note should be the correct target for this query?
\`\`\`

If the user has not answered this question, do not run \`ipa tune testset add\` for that case. This applies even when the top result looks correct.

Treat tuning as an evaluation loop, not a one-off command. Prefer better labels and representative cases over simply increasing trial count.`
  },
  {
    name: "ipa-review",
    description: "Diagnose IPA vault structural health — tag hygiene, index/root structure, link integrity, frontmatter consistency — vault-wide or for one subtree, then fix approved issues. Use this skill whenever the user asks for a vault review, health check, tag cleanup, orphan notes, broken links, index structure, or frontmatter consistency.",
    body: (mapping) => `# IPA Review Skill

Diagnose vault structure, report by category, and fix only what the user approves.

## Workflow

1. Scope: vault-wide by default; when the user names a root/index, inspect its centered neighborhood with \`ipa graph "Root Note" --depth 2\` and use \`ipa traversal --down "Root Note"\` when a directional subtree is needed.
2. Scan:

\`\`\`bash
ipa review all                      # convention, inbox, duplicates
ipa validator                       # frontmatter, broken links, orphan notes
\`\`\`

   Builtin review scopes cover only generic IPA mechanics. Vault-specific checks such as tag vocabulary, title conventions, index thresholds, and single-source-of-truth policy come from \`.ipa/plugins/rules/*.js\` and the vault's harness fragments.
   Categories to cover: active vault-rule findings, index/root structure, link health (orphan notes without \`${mapping.refs}\`, broken wikilinks, notes pointing directly at a root), and frontmatter consistency.
3. Report a chat summary per category with issue counts and affected notes, then ask which items to fix.
4. Fix approved items only:

\`\`\`bash
ipa note set "Note" --field ${mapping.tags} --add "tag" --apply     # few notes
ipa move "Note" "${mapping.archive_dir}" --apply                    # relocation
ipa formatter plan --note "Note A" "Note B"                         # then matching apply
ipa refactor ref-replace "Old Index" "New Index" --apply            # bulk changes: plan first (no --apply), then apply
ipa refactor tag-rename old_tag new_tag --apply
ipa refactor wikilink-replace "Old" "New" --apply
\`\`\`

   \`ipa refactor\` also supports \`ref-add\`, \`ref-remove\`, \`tag-remove\`, and \`tag-add\` — see \`ipa refactor --help\`.
5. Summarize the applied changes.

## Must Not

- Edit a single note's body content (that is enrichment work, not review).
- Apply any fix without user approval.
- Create index/root notes without user approval.`
  },
  {
    name: "ipa-consult",
    description: "Consult on the IPA method and this vault's operation: explain IPA concepts and design intent, listen to friction (\"this is inconvenient\", \"the vault feels messy\"), diagnose from vault evidence, and route the fix to the right IPA capability. Use this skill whenever the user asks what IPA/index/root/refs/tags mean, why the vault is organized this way, how to organize something, or complains about vault workflow friction.",
    body: (mapping) => `# IPA Consult Skill

Act as an IPA method consultant: explain concepts with their design intent, and turn workflow friction into a diagnosis plus a concrete lever. This skill advises and routes — it does not apply changes itself; execution belongs to the skill or command it points at.

Difference from ipa-review: review mechanically detects and fixes convention violations; consult handles "why does this hurt and which mechanism fixes it for good".

## Read First

Ground every answer in the vault, not memory:

\`\`\`bash
ipa convention                 # concepts, field/folder mapping, this vault's operating rules
ipa search "IPA"               # vault-local philosophy/decision notes, if any
ipa digest                     # current shape: counts, largest indexes, orphans
\`\`\`

## Core Design Intent

The source of truth for IPA philosophy is the Design Intent section of \`ipa convention\` — read it before answering, and explain the why, not just the definition. The load-bearing ideas: folders express only lifecycle state while classification lives in links (\`${mapping.refs}\` vertical, \`${mapping.tags}\` horizontal — orthogonal, never interchangeable); index/root notes are pure navigation with no content; only the project folder is actively managed; and IPA deliberately covers only "record and retrieve" — requests to shape thinking or drive execution are outside its domain, and saying so is a valid answer.

## Mode 1 — Concept Q&A ("what is an index", "refs vs tags")

\`ipa convention\` is the authoritative source for definitional and concept questions — answer directly from it, using this vault's real field/folder names and explaining the design intent behind the rule. Illustrate with at most one related note found via \`ipa search\`; do not survey the whole vault (\`ipa digest\`, \`ipa review all\`, repeated search/view) to settle a question \`ipa convention\` already answers.

## Mode 2 — Friction Counseling ("X is inconvenient", "how do I organize Y")

1. Clarify the friction first: when does it occur, in which workflow step, how often.
2. Scan for evidence before advising: \`ipa validator\`, \`ipa review all\`, \`ipa traversal --down "Root"\`, \`ipa tune log --limit 20\` — pick what matches the complaint.
3. Name the diagnosis, then route it to the mechanism that removes the friction permanently:

| Friction | Lever |
|---|---|
| "I keep forgetting/violating convention X" | Add a rule plugin — ipa-rule skill |
| "Search does not find the right note" | Label cases and tune — ipa-tune skill |
| "Field or folder names do not fit how I think" | Remap in config — ipa-config skill (then \`ipa harness update\`) |
| "The inbox keeps piling up" | Inspect \`ipa inbox --help\` and run an approved batch triage |
| "Tags/indexes/links feel messy" | Structural health pass — ipa-review skill |
| "Agents keep doing X wrong in this vault" | Add an operating rule fragment under \`.ipa/harness/fragments/\` |
| "The same manual fix repeats" | Rule plugin with a safe fix so the formatter applies it |

4. Prefer the smallest lever that removes the cause; a one-off manual cleanup that will recur is not a resolution.

Vault operating rules belong in \`.ipa/harness/fragments/prompt.md\` (then \`ipa harness update <target>\`), never in the \`IPA_HARNESS_MANAGED\` block of \`CLAUDE.md\`/\`AGENTS.md\` — doctor flags a hand-edited managed block as drift and \`harness update\` overwrites it.

## Must Not

- Apply fixes, move notes, or edit config in this skill — hand off to the routed skill and say why.
- Answer philosophy questions from general knowledge when \`ipa convention\` or a vault note contradicts it.
- Recommend restructuring beyond what the observed friction justifies.`
  }
];

// Keep retired names so install/update can remove old managed files without
// touching user-owned forks whose marker was removed.
export const IPA_MANAGED_LOCAL_SKILL_NAMES = [
  ...VAULT_LOCAL_SKILLS.map((skill) => skill.name),
  "ipa-triage"
];

export function vaultLocalSkillRootRel(spec) {
  return spec.adapter.localSkillsRoot;
}

export function vaultLocalSkillRelPath(spec, name) {
  return `${vaultLocalSkillRootRel(spec)}/${name}/SKILL.md`;
}

export function vaultLocalSkillContent(skill, mapping) {
  const body = typeof skill.body === "function" ? skill.body(mapping) : skill.body;
  return `---
name: ${skill.name}
description: ${JSON.stringify(skill.description)}
---

<!-- ${HARNESS_MARKER} -->

${body.trim()}
`;
}


export function harnessSkillContent(vaultPath, spec, mapping, options = {}) {
  const prefix = commandPrefix(vaultPath, options);
  const contextual = options.recallMode === "contextual";
  const description = contextual
    ? "Use IPA for explicit vault work and when private vault history may materially change planning, architecture, resumption, handoff, status, or ownership decisions. Skip self-contained implementation questions."
    : `Use IPA when the user explicitly asks for IPA, vault, or note work; names a path under ${mapping.inbox_dir}/, ${mapping.project_dir}/, ${mapping.archive_dir}/, or ${vaultPath}; or invokes this skill. Do not proactively search the vault for self-contained work.`;
  return `---
name: ipa
description: ${JSON.stringify(description)}
---

<!-- ${HARNESS_MARKER} -->

# IPA CLI Skill

Vault: ${vaultPath}
Target: ${spec.name}
Config: \`.ipa/config.yaml\`
Profile registry: ${profileRegistryDisplay()}

## Read

- Discovery: \`${prefix} search "facet A" "facet B"\`. Exact notes: \`${prefix} view "A" "B" --full\`. Broad pack: \`${prefix} context "keyword" --size medium --format markdown\`.
- Use short lexical facets, not a file path or the whole user prompt. Batch related queries and titles in one command.
- Read only the few notes needed to answer. Prefer current decisions and dated evidence; report conflicts with code or git.
- For concepts and vault policy, run \`${prefix} convention\`. For every other command, use \`${prefix} help\`, \`${prefix} help --all\`, or \`${prefix} <command> --help\` as the source of truth.

## Write

- Create Markdown through \`${prefix} inbox add\`; the guard blocks new notes outside the mapped inbox.
- Core-backed mutations such as \`${prefix} inbox add\`, \`${prefix} note set --apply\`, and \`${prefix} note replace --apply\` format and validate in the same call.
- After a raw editor Write/Edit, run \`${prefix} note finalize "Note Title"\` once. The Stop gate checks any edited note still pending.
- Mutations preview unless the command says otherwise. For an already-authorized single-note change, apply it; for bulk changes, show the plan and obtain confirmation first.
- Never hand-edit \`${mapping.created_at}\` or \`${mapping.updated_at}\`.

## Extensions

- Vault policy belongs in \`.ipa/config.yaml\`, \`.ipa/plugins/{rules,search,gates}/\`, and managed prompt fragments. Exact plugin workflows live under \`${vaultPath}/${vaultLocalSkillRootRel(spec)}/\` when the optional local-skills component is installed.
- Sessions outside the vault do not load \`${vaultPath}/${spec.localPrompt}\`; read it before a vault-wide reorganization.
`;
}

// The vault-local block carries only vault-specific facts. Generic IPA
// workflow lives in the global skill; concepts and operating rules are
// queryable via `ipa convention` — do not duplicate them here.
export function localPromptContent(vaultPath, spec, mapping, options = {}) {
  const prefix = commandPrefix(vaultPath, options, true);
  return `## IPA CLI Harness

This vault has an IPA CLI harness installed. For explicit vault work, use the global \`ipa\` skill and the \`${prefix}\` CLI.

- Folders: inbox \`${mapping.inbox_dir}\`, project \`${mapping.project_dir}\`, archive \`${mapping.archive_dir}\`
- Vault config: .ipa/config.yaml; profile registry: ${profileRegistryDisplay()}
- Concepts and policy: \`${prefix} convention\`. Exact commands: \`${prefix} help\` and \`${prefix} <command> --help\`.
- Core note mutations finalize themselves; after raw Markdown edits run \`${prefix} note finalize "Note Title"\` once.
`;
}

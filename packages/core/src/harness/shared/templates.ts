import { HARNESS_MARKER } from "../managedFiles.js";

function ipaEvidenceRecall(prefix = "ipa") {
  return `## Evidence Recall

Use IPA when private vault knowledge could materially change the answer, even if the user did not mention notes. This includes prior rationale and decisions, team direction, meeting or scrum agreements, current work status, blockers, ownership, resumptions, and handoffs. Meeting and scrum records may be the only source for an operational fact; do not treat them as merely secondary evidence.

1. Decide whether recall is needed. Skip IPA when the request is self-contained or current code and git are sufficient. For current implementation facts, inspect code and git first; use vault evidence for intent, organizational context, and facts that are not represented there.
2. Find the center. If a note or index is known, use \`${prefix} view\` or \`${prefix} context --by-note\`. Otherwise run one \`${prefix} search "facet A" "facet B"\` call with 2-3 short lexical angles. Never submit a file path or the whole user prompt as a query.
3. Rank evidence by authority and freshness. Prefer current status/architecture notes and explicit decision records when they exist, but use dated meeting or scrum notes when they are newer or the sole source. Distinguish a confirmed decision from a proposal or provisional update.
4. Expand only after finding a center. Use \`${prefix} digest\` for an index, \`${prefix} graph "Note Title" --depth 2\` for a centered neighborhood, or \`${prefix} traversal\` for a directional walk. Once titles are selected, batch them in one \`${prefix} view "A" "B" --full\` call; do not reopen an overview in full unless a specific missing section is necessary. Open at most 2-3 full notes, then converge.
5. Use the evidence in the answer. State the applicable fact or decision, its rationale or status, and the note title/date when freshness matters. If code or git conflicts with the vault, report the drift instead of silently choosing one.

## Command Pointers

- Discovery or broad history: \`${prefix} search\` and \`${prefix} context\`.
- Exact note: \`${prefix} view\`. Index summary: \`${prefix} digest\`.
- Relationships: \`${prefix} graph\` for a centered neighborhood; \`${prefix} traversal\` for direction.
- IPA concepts and active vault rules: \`${prefix} convention\`.
- Command discovery and exact syntax: \`${prefix} help\` and \`${prefix} <command> --help\`.
`;
}
// The global prompt block is loaded into every session, vault-related or not,
// so it stays pointer-level: when to reach for ipa, where the detail lives
// (skill, --help, ipa convention), and the two guard rails that hooks enforce.
export function globalPromptContent(spec) {
  const tool = spec.adapter.displayName;
  const skillPath = spec.adapter.skillDisplayPath;
  return `## IPA Vault — Evidence-Based Work

This ${tool} environment has the IPA CLI installed for the user's private note vault: decisions and rationale, project history, team direction, meeting and scrum records, current work status, and user-specific context.

- Use vault evidence whenever a request explicitly concerns IPA/notes, or when planning, architecture/spec interpretation, regression history, resuming work, or a handoff could depend on private context — even if the user did not mention notes. Meeting or scrum records may be the only source for an operational fact.
- Skip IPA for self-contained questions when the supplied context, current code, and git are enough. Code and git are authoritative for current implementation behavior; IPA is evidence for intent, decisions, organizational context, and facts absent from the repository. Report drift when they conflict.
- Entry points: \`ipa search "keyword"\` (discovery; several short facets in one call), \`ipa view "Note Title"\` (exact read), and \`ipa context "keyword" --size medium --format markdown\` (broad/history bootstrap). Full workflow: the \`ipa\` skill at \`${skillPath}\`; exact syntax: \`ipa <command> --help\`.
- On an index or root note, run \`ipa digest\` before opening children, read at most 2-3 full notes, then use the evidence in the answer instead of continuing to explore.
- IPA concepts and this vault's operating rules: \`ipa convention\`.
- Create new vault notes only through \`ipa inbox add\` — a guard hook blocks new markdown outside the inbox.
- After editing vault markdown, finish the note-scoped loop: \`ipa validator --note ...\`, \`ipa formatter plan --note ...\`, \`ipa formatter apply --note ...\`. A Stop gate blocks final responses while formatter patches remain.`;
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
- In harness sessions, prompts and search calls are logged automatically (\`prompt_event_id\`/\`source_prompt\` connect them); use plain \`ipa search "keyword"\` for evidence collection. \`IPA_SEARCH_LOG=1\` remains a compatibility fallback for non-harness searches.
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
    name: "ipa-triage",
    description: "Triage IPA inbox notes into the archive: confirm refs/tags, wire wikilinks, validate, and move approved notes. Use this skill whenever the user wants to clean up or empty the inbox, triage notes, confirm refs/tags for new notes, or move finished notes to the archive.",
    body: (mapping) => `# IPA Triage Skill

Move finished inbox notes into the archive: confirm refs/tags → wire links → validate → move after approval. Triage connects and moves notes that are already written; it does not create notes or deepen their content.

When a triage sweep moves or archives several notes at once, surface the full per-note plan (the \`ipa inbox triage\`/\`ipa cascade plan\` dry-run output) and run each \`--apply\` step only after the user confirms; a single-note capture or edit needs no such round-trip.

## Workflow

1. Scan the inbox: \`ipa review inbox\` lists notes and issues (missing refs/tags). If the user named specific notes, triage only those; with 10+ notes, work in batches the user confirms.
2. Confirm refs/tags per note:

\`\`\`bash
ipa view "Note" --full
ipa inbox triage --note "Note"           # ref/tag suggestions
ipa search "keyword"                     # verify suggestions, find candidates
ipa traversal --down "Candidate Index"   # see what already lives under a candidate
\`\`\`

   Refs must point at existing index notes — a note points at an index, not directly at a root. Reuse existing tags; add a new tag only when it cuts across more than one index. If no index fits, ask the user whether to create one. A note that is only a line or two, or clearly unfinished, stays in the inbox — report it as needing enrichment instead of forcing a move.

   Apply confirmed values with \`ipa inbox triage --apply --note "Note"\`, or adjust manually with \`ipa note set "Note" --field ${mapping.refs} --add "Index Note" --apply\`.
3. Wire the note into the graph: \`ipa cascade plan --note "Note"\`, then \`ipa cascade apply --note "Note" --only links\`. Never auto-merge duplicate candidates — compare contents, ask the user, and on an approved merge combine with \`ipa note replace\` then rewire references with \`ipa note redirect --archive --apply\`.
4. Validate: \`ipa validator --note "Note"\` → \`ipa formatter plan --note "Note"\` → \`ipa formatter apply --note "Note"\`.
5. Move after approval: present a summary table (note, refs, tags, action) and ask which notes to move. Move only the approved ones: \`ipa move "Note" "${mapping.archive_dir}" --apply\` (wikilinks update automatically).
6. Report moved notes, held notes with reasons, and recommended follow-ups.

## Must Not

- Move a note to the archive without user approval.
- Edit note bodies beyond wikilink insertion or an approved merge.
- Add a ref to an index that does not exist.
- Auto-merge suspected duplicates.`
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
| "The inbox keeps piling up" | Batch triage — ipa-triage skill |
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
  return `---
name: ipa
description: Use IPA for explicit vault and note work, and whenever planning, architecture or spec interpretation, regression history, work resumption, handoff, team direction, meetings, scrums, status, blockers, or ownership may depend on private vault knowledge even when notes are not mentioned. Also use for note paths under \`${mapping.inbox_dir}/\`, \`${mapping.project_dir}/\`, \`${mapping.archive_dir}/\`, or \`.md\` files in ${vaultPath}. Skip self-contained implementation questions; code and git remain authoritative for current behavior.
---

<!-- ${HARNESS_MARKER} -->

# IPA CLI Skill

## Active Vault

- Target: ${spec.name}
- Vault: ${vaultPath}
- Profile registry: ${profileRegistryDisplay()}
- Vault config: .ipa/config.yaml
- IPA concepts + vault operating rules: \`${prefix} convention\`

Sessions running outside the vault directory do not load the vault's own \`${spec.localPrompt}\`; before writing or reorganizing notes from such a session, run \`${prefix} convention\` and read \`${vaultPath}/${spec.localPrompt}\` for user-maintained rules outside the managed block.

## Skill Routing

This skill is the single entry point for vault requests from any directory. Focused workflows live as vault-local skills under \`${vaultPath}/${vaultLocalSkillRootRel(spec)}/\`:

- \`ipa-consult\` — IPA concept questions ("what is an index", "refs vs tags") and workflow friction ("the vault feels messy", "X keeps bothering me")
- \`ipa-triage\` — inbox → refs/tags → wikilinks → archive processing
- \`ipa-review\` — vault or subtree structural health checks with approved fixes
- \`ipa-tune\` — search quality complaints, testset labelling, tune analysis
- \`ipa-rule\` — authoring vault convention rule plugins
- \`ipa-config\` — profile/config and field/folder mapping changes

Inside the vault these load as invocable skills — invoke the matching one. Outside the vault they are not auto-loaded: read the matching \`SKILL.md\` at the path above and follow its workflow with \`${prefix}\` commands. If the skill file does not exist, fall back to \`${prefix} convention\` and the commands below.

${ipaEvidenceRecall(prefix)}
Keep exploration proportional to the question: simple lookups within ~3 ipa calls, broad questions within ~8. At the budget, answer from the evidence gathered and state what was not checked.

If search results look stale after external (Obsidian) edits, diagnose the index fingerprint with \`${prefix} cache doctor\` and force a rebuild with \`${prefix} cache rebuild\`.

## Safe Writes

Mutating commands preview by default and write only with \`--apply\`. For a single-note mutation the user already asked for, a preview or plan is not the deliverable — re-run the same command with \`--apply\` to actually write. The exception is a multi-note or bulk mutation (a triage sweep, a mass move or refactor) in an interactive session: surface the per-note plan, get the user's confirmation, then run \`--apply\`.

New Markdown notes belong in the configured inbox:

\`\`\`bash
${prefix} inbox add ./draft.md --title "Title" --ref "Index Note" --tag "topic"
\`\`\`

Set refs and tags (frontmatter \`${mapping.refs}\`/\`${mapping.tags}\`) at capture time — do not leave them for later. Reuse the vault's existing tag vocabulary first (\`${prefix} inbox triage --note "Title"\` suggests refs/tags from it). Create a new tag only when it names a perspective that cuts across more than one index; a tag as narrow as a single note or a single index adds no retrieval value — put that meaning in the ref instead.

After editing vault Markdown, finish the note-scoped loop (vault-wide runs are maintenance sweeps — always scope with \`--note\`):

\`\`\`bash
${prefix} validator --note "Edited Note"
${prefix} formatter plan --note "Edited Note"
${prefix} formatter apply --note "Edited Note"
\`\`\`

Multiple edited notes take one \`--note\` followed by all titles: \`${prefix} formatter plan --note "Note A" "Note B"\`, then the matching \`${prefix} formatter apply --note "Note A" "Note B"\`. The harness Stop hook blocks final responses while edited notes still have formatter patches — do not stop at plan-only.

Never edit the time fields (\`${mapping.created_at}\`/\`${mapping.updated_at}\`) by hand: core-backed writes and \`formatter apply\` keep them in sync. A stale-looking date is not a task to fix.

## Scripted Edits

Prefer core-backed commands over scanning vault folders with \`fs\`:

\`\`\`bash
${prefix} note replace "Note Title" --old-file .tmp/old-block.txt --new-file .tmp/new-block.txt --apply
${prefix} note set "Note Title" --field ${mapping.refs} --add "Index Note" --apply
${prefix} note set "Note Title" --field ${mapping.note_type} --value index --apply
\`\`\`

\`note replace --apply\` removes its \`.tmp/\` input files automatically (\`--keep-files\` to keep them). Inside the \`ipa-cli\` workspace, one-off scripts may import core helpers (\`replaceInNote\`, \`rewriteNote\` from \`./packages/core/dist/index.js\`) — never hard-code vault folder paths.

## Vault Convention And Plugins

Vault-specific conventions are code, not prose: convention checks live in \`.ipa/plugins/rules/*.js\`, retrieval boosts in \`.ipa/plugins/search/*.js\`, and session-end policy in \`.ipa/plugins/gates/*.js\` (run by the Stop gate via \`${prefix} harness gate\`). Authoring and verification (\`${prefix} plugin init\` scaffold → \`plugin validate\` → \`plugin dry-run\`) follow the \`ipa-rule\` skill workflow.
`;
}

// The vault-local block carries only vault-specific facts. Generic IPA
// workflow lives in the global skill; concepts and operating rules are
// queryable via `ipa convention` — do not duplicate them here.
export function localPromptContent(vaultPath, spec, mapping, options = {}) {
  const prefix = commandPrefix(vaultPath, options, true);
  return `## IPA CLI Harness

This vault has an IPA CLI harness installed. Vault work goes through the \`${prefix}\` CLI — full workflow and safe-write rules in the global \`ipa\` skill, IPA concepts and this vault's operating rules via \`${prefix} convention\`, exact syntax via \`${prefix} <command> --help\`.

- Folders: inbox \`${mapping.inbox_dir}\`, project \`${mapping.project_dir}\`, archive \`${mapping.archive_dir}\`
- Vault config: .ipa/config.yaml; profile registry: ${profileRegistryDisplay()}
- Vault-specific conventions are enforced by \`.ipa/plugins/rules/*.js\`, retrieval boosts by \`.ipa/plugins/search/*.js\`, session-end policy by \`.ipa/plugins/gates/*.js\`; verify with \`${prefix} plugin validate\` and \`${prefix} plugin dry-run\`.
- In harness sessions plain \`${prefix} search "keyword"\` calls are logged as tune evidence automatically.

Focused workflows live as vault-local skills for each installed harness target — the exact path and routing map are in that target's global \`ipa\` skill.
`;
}


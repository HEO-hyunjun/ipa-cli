import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

function lintMessage(heading, issues) {
  return [heading, ...issues.map((issue) => `- ${issue.note ?? issue.path ?? "vault"}: ${issue.code} ${issue.message}`)].join("\n");
}

export function createHarnessSessionGate(deps) {
return async function harnessSessionGate(vaultPath, options = {}) {
  const sessionId = options.session ?? null;
  const pendingPath = join(vaultPath, ".ipa", "harness", "formatter-pending.json");
  const ttlMs = 48 * 60 * 60 * 1000;
  let entries = [];
  if (existsSync(pendingPath)) {
    try {
      const parsed = JSON.parse(await readFile(pendingPath, "utf8"));
      entries = Array.isArray(parsed.notes) ? parsed.notes : [];
    } catch {
      entries = [];
    }
  }
  const cutoff = Date.now() - ttlMs;
  entries = entries.filter((item) => {
    const ts = Date.parse(item?.updated_at ?? "");
    return Number.isNaN(ts) || ts >= cutoff;
  });
  const owned = sessionId
    ? entries.filter((item) => !item.session_id || item.session_id === sessionId)
    : entries;
  // A note renamed or deleted after its edit drops out here; otherwise one
  // missing title would make finalize skip every other edited note.
  const ownedTitles = [...new Set(owned
    .filter((item) => typeof item.path !== "string" || existsSync(join(vaultPath, item.path)))
    .map((item) => typeof item.title === "string" ? item.title.trim() : "")
    .filter(Boolean))];
  const blocks = [];
  const errors = [];
  const warnings = [];
  if (ownedTitles.length) {
    // Stop-time lint: finalize (formatter apply + validate) this session's
    // edited notes here, so the agent never runs `ipa note finalize` itself.
    // Only validator errors block. A finalize failure (e.g. a note renamed
    // after its edit) is reported, never blocking.
    try {
      const lint = await deps.finalizeNotes(vaultPath, ownedTitles);
      const issues = lint.validation.issues ?? [];
      const lintErrors = issues.filter((issue) => issue.severity === "error");
      const lintWarnings = issues.filter((issue) => issue.severity !== "error");
      if (lintErrors.length) {
        blocks.push({ source: "validator", message: lintMessage(`Stop lint found ${lintErrors.length} validator error(s) in edited notes. Fix them before finishing:`, lintErrors) });
      }
      if (lintWarnings.length) {
        warnings.push({ source: "validator", message: lintMessage(`${lintWarnings.length} validator warning(s) in edited notes:`, lintWarnings) });
      }
    } catch (error) {
      errors.push({ source: "validator", message: error.message });
    }
  }
  const gatePlugins = (await deps.loadPluginModules(vaultPath, "gates"))
    .map((plugin) => deps.normalizeGatePlugin(plugin))
    .filter(Boolean);
  if (gatePlugins.length) {
    const { config, mapping } = await deps.readVaultConfig(vaultPath);
    const notes = await deps.loadNotes(vaultPath, mapping);
    // Mutation ledger: ipa dry-run mutations recorded directly by the CLI that
    // were never followed by an --apply/apply command. Unlike formatter
    // pending, the gate never clears these — only an --apply sighting or the 48h
    // TTL does, so a warning survives across gate runs until the plan is applied.
    const mutationPath = join(vaultPath, ".ipa", "harness", "mutation-pending.json");
    let mutationEntries = [];
    if (existsSync(mutationPath)) {
      try {
        const parsed = JSON.parse(await readFile(mutationPath, "utf8"));
        mutationEntries = Array.isArray(parsed.mutations) ? parsed.mutations : [];
      } catch {
        mutationEntries = [];
      }
    }
    const ownedMutations = (sessionId
      ? mutationEntries.filter((item) => !item.session_id || item.session_id === sessionId)
      : mutationEntries)
      .filter((item) => {
        const ts = Date.parse(item?.ts ?? "");
        return Number.isNaN(ts) || ts >= cutoff;
      });
    const gateLookup = deps.makeNoteLookup(notes);
    const ctx = {
      vaultPath,
      config,
      mapping,
      notes,
      lookup: (ref) => gateLookup(ref) ?? null,
      session: {
        id: sessionId,
        edits: owned.map((item) => ({ title: item.title, path: item.path ?? null, updated_at: item.updated_at ?? null })),
        pending_mutations: ownedMutations.map((item) => ({ command: item.command, ts: item.ts ?? null }))
      }
    };
    for (const gate of gatePlugins) {
      try {
        const result = await gate.check(ctx);
        if (result && result.block) {
          blocks.push({ source: gate.name, message: String(result.message ?? `gate ${gate.name} blocked the session`) });
        } else if (result) {
          // A non-blocking gate result (block falsy) carrying a message/warn is
          // an advisory warning: surface it to the agent without holding the
          // response, so a block:false gate is not silently dropped.
          const warn = [result.message, result.warn].find((value) => typeof value === "string" && value.trim());
          if (warn) warnings.push({ source: gate.name, message: warn });
        }
      } catch (error) {
        errors.push({ source: gate.name, message: error.message });
      }
    }
  }
  // Owned entries are consumed once linted, so a validator error blocks once: a
  // fix re-records the note through the edit ledger, while an error the agent
  // cannot resolve must not lock the session. Gate plugin blocks keep the ledger
  // because plugins read session.edits on the next Stop.
  if (!blocks.some((item) => item.source !== "validator")) {
    // Owned entries leave the ledger here. Foreign entries (a different non-null session_id) are
    // re-checked against the formatter and dropped when clean too — ownership must
    // not strand a clean note until the 48h TTL, or a multi-turn --resume that
    // rotates the session id would let it resurface and wrongly gate a later turn.
    // Only genuinely pending foreign work is kept.
    const ownedSet = new Set(owned);
    const foreign = entries.filter((item) => !ownedSet.has(item));
    const foreignTitles = [...new Set(foreign
      .map((item) => typeof item.title === "string" ? item.title.trim() : "")
      .filter(Boolean))];
    let foreignDirty = new Set(foreignTitles);
    if (foreignTitles.length) {
      try {
        const plan = await deps.formatVault(vaultPath, false, { notes: foreignTitles, ruleApply: true, patchesOnly: true });
        foreignDirty = new Set(plan.patches.map((patch) => patch.note));
      } catch {
        // Fail-safe: if the foreign notes can't be verified, keep them rather than
        // risk dropping real pending work.
      }
    }
    const remaining = foreign.filter((item) =>
      foreignDirty.has(typeof item.title === "string" ? item.title.trim() : ""));
    if (remaining.length) {
      await writeFile(pendingPath, JSON.stringify({ version: 1, notes: remaining }, null, 2) + "\n", "utf8");
    } else if (existsSync(pendingPath)) {
      await rm(pendingPath, { force: true });
    }
  }
  return {
    status: "ok",
    block: blocks.length > 0,
    session_id: sessionId,
    notes: ownedTitles,
    gates: gatePlugins.map((gate) => gate.name),
    blocks,
    warnings,
    errors
  };
};

}

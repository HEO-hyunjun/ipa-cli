// bench/lib/transcript.mjs
const IPA_CALL_RE = /(?:^|[;&|(]\s*)\s*ipa\s+[a-z-]/;

export function emptyParsed() {
  return { sessionId: null, costUsd: 0, numTurns: 0, isError: false, bashCalls: [], ipaCalls: [], finalText: "" };
}

export function parseTranscript(jsonlText) {
  const out = emptyParsed();
  const events = jsonlText.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  for (const ev of events) {
    if (ev.type === "system" && ev.subtype === "init") out.sessionId = ev.session_id ?? out.sessionId;
    if (ev.type === "assistant") {
      for (const block of ev.message?.content ?? []) {
        if (block.type === "tool_use" && block.name === "Bash") {
          out.bashCalls.push({ id: block.id, command: String(block.input?.command ?? ""), isError: false });
        }
      }
    }
    if (ev.type === "user") {
      for (const block of ev.message?.content ?? []) {
        if (block.type === "tool_result" && block.is_error) {
          const call = out.bashCalls.find((c) => c.id === block.tool_use_id);
          if (call) call.isError = true;
        }
      }
    }
    if (ev.type === "result") {
      out.sessionId = ev.session_id ?? out.sessionId;
      out.costUsd = ev.total_cost_usd ?? 0;
      out.numTurns = ev.num_turns ?? 0;
      out.isError = Boolean(ev.is_error);
      out.finalText = typeof ev.result === "string" ? ev.result : "";
    }
  }
  out.ipaCalls = out.bashCalls.filter((c) => IPA_CALL_RE.test(c.command.trim()));
  return out;
}

export function mergeParsed(acc, next) {
  return {
    sessionId: next.sessionId ?? acc.sessionId,
    costUsd: acc.costUsd + next.costUsd,
    numTurns: acc.numTurns + next.numTurns,
    isError: acc.isError || next.isError,
    bashCalls: [...acc.bashCalls, ...next.bashCalls],
    ipaCalls: [...acc.ipaCalls, ...next.ipaCalls],
    finalText: next.finalText || acc.finalText,
  };
}

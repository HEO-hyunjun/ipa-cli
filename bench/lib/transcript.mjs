// bench/lib/transcript.mjs
// ipa 호출 감지: bash 명령을 셸 구분자(&&, ||, ;)로 세그먼트 분할한 뒤, 각 세그먼트가
// 줄머리에서 `ipa <subcommand>`로 시작하는지 본다. `(^|\n)`로 heredoc 종료 뒤 새 줄에서
// 이어지는 `ipa ...`(예: `cat > f <<'EOF' ... EOF\nipa inbox add`)까지 잡는다 —
// 이 형태는 앞이 셸 구분자가 아니라 `EOF\n`이라 예전 구분자-only 정규식이 놓쳤다.
// 트레이드오프: heredoc 본문에 `ipa search ...`처럼 실제 명령 형태의 줄이 있으면 오탐할 수
// 있으나, 실제 `&& ipa <sub>` 체이닝을 놓치지 않는 쪽을 우선한다.
const IPA_SEGMENT_RE = /(?:^|\n)\s*ipa\s+[a-z-]/;
const isIpaCall = (command) => command.split(/&&|\|\||;/).some((seg) => IPA_SEGMENT_RE.test(seg));

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
  out.ipaCalls = out.bashCalls.filter((c) => isIpaCall(c.command));
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

// bench/lib/responder.mjs
// 에이전트가 대본 밖 반문을 했을 때 1회 주입하는 canned reply. LLM 사용자 시뮬레이터는 두지 않는다.
const QUESTION_RE = /(\?|할까요|될까요|괜찮을까|진행해도|어떤 (걸|것을)|선택해|알려주시|주시겠어)/;

const REPLIES = {
  approve: "응, 그렇게 진행해줘.",
  decline: "아니, 진행하지 말고 지금 상태만 알려줘.",
};

export function pickReply(finalText, policy) {
  if (!policy || !QUESTION_RE.test(finalText ?? "")) return null;
  if (policy.startsWith("detail:")) return policy.slice("detail:".length);
  return REPLIES[policy] ?? null;
}

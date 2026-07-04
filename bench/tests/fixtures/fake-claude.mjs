// bench/tests/fixtures/fake-claude.mjs
// 테스트/드라이런 전용 claude 스텁. 받은 인자를 stderr에 남기고 canned transcript를 출력한다.
import { writeFileSync } from "node:fs";
process.stderr.write(JSON.stringify(process.argv.slice(2)) + "\n");
// 환경 격리 검증용 프로브: 테스트가 IPA_BENCH_ENV_PROBE를 지정했을 때만 자식이 받은 HOME을 그 경로에 기록한다.
// (게이트 없이 $HOME에 쓰면 실제 HOME을 쓰는 세션·드라이런에서 테스터 홈을 오염시킨다.)
if (process.env.IPA_BENCH_ENV_PROBE) {
  try { writeFileSync(process.env.IPA_BENCH_ENV_PROBE, String(process.env.HOME ?? "")); } catch { /* ignore */ }
}
const resume = process.argv.includes("--resume");
const lines = [
  { type: "system", subtype: "init", session_id: "sess-fake-1" },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: 'ipa search "커피"' } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } },
  { type: "assistant", message: { content: [{ type: "text", text: resume ? "마무리했습니다." : "정리했습니다. 진행할까요?" }] } },
  { type: "result", subtype: "success", session_id: "sess-fake-1", total_cost_usd: 0.01, num_turns: 2, is_error: false, result: resume ? "마무리했습니다." : "정리했습니다. 진행할까요?" },
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\n");

// bench/tests/fixtures/fake-claude.mjs
// 테스트/드라이런 전용 claude 스텁. 받은 인자를 stderr에 남기고 canned transcript를 출력한다.
process.stderr.write(JSON.stringify(process.argv.slice(2)) + "\n");
const resume = process.argv.includes("--resume");
const lines = [
  { type: "system", subtype: "init", session_id: "sess-fake-1" },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: 'ipa search "커피"' } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } },
  { type: "assistant", message: { content: [{ type: "text", text: resume ? "마무리했습니다." : "정리했습니다. 진행할까요?" }] } },
  { type: "result", subtype: "success", session_id: "sess-fake-1", total_cost_usd: 0.01, num_turns: 2, is_error: false, result: resume ? "마무리했습니다." : "정리했습니다. 진행할까요?" },
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\n");

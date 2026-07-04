// bench/lib/runner.mjs
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

export function runClaudeTurn({ cwd, model, message, resumeSessionId = null, maxTurns = 12, claudeCmd = ["claude"], timeoutMs = 900_000 }) {
  const args = [
    ...claudeCmd.slice(1),
    "-p", message,
    "--output-format", "stream-json", "--verbose",
    "--model", model,
    "--max-turns", String(maxTurns),
    "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep",
  ];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  const xdgDir = `${cwd}-xdg`; // 프로필 레지스트리 격리 (~/.config/ipa 보호)
  mkdirSync(xdgDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(claudeCmd[0], args, { cwd, env: { ...process.env, IPA_VAULT_PATH: cwd, XDG_CONFIG_HOME: xdgDir } });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`claude turn timeout after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => {
      clearTimeout(timer);
      // max-turns 초과 등은 시나리오 판정 대상이지 인프라 오류가 아니므로 result 이벤트만 있으면 성공 취급
      if (out.includes('"type":"result"')) resolve(out);
      else reject(new Error(`claude produced no result event. stderr: ${err.slice(0, 2000)}`));
    });
  });
}

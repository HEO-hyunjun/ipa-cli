// bench/lib/runner.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

// harness install은 $HOME/.claude에 전역 하네스를 쓴다. homeDir를 격리 디렉터리로 지정해
// 실제 ~/.claude가 덮어써지는 것을 막는다. 볼트-로컬 스킬은 cwd(sandboxDir) 아래에 쓰인다.
export function installHarness({ ipaBin, sandboxDir, homeDir }) {
  mkdirSync(homeDir, { recursive: true });
  execFileSync(process.execPath, [ipaBin, "harness", "install", "claude"], {
    cwd: sandboxDir,
    env: { ...process.env, HOME: homeDir, IPA_HARNESS_HOME: homeDir, IPA_VAULT_PATH: sandboxDir, XDG_CONFIG_HOME: `${sandboxDir}-xdg` },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// homeDir를 넘기면 자식 프로세스의 HOME을 격리 디렉터리로 덮어쓴다. 넘기지 않으면 실제 HOME을 쓴다.
// (macOS -p 세션은 격리 HOME에서 로그인 상태를 못 읽어 인증에 실패하므로, 러너는 세션에는 HOME을 격리하지 않는다.
//  ~/.claude 오염 방지는 install 단계의 HOME 격리로 처리한다 — bench/README.md 참고.)
export function runClaudeTurn({ cwd, model, message, resumeSessionId = null, maxTurns = 12, claudeCmd = ["claude"], timeoutMs = 900_000, homeDir = null }) {
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
  const harnessHome = homeDir ?? `${cwd}-home`;
  mkdirSync(xdgDir, { recursive: true });
  mkdirSync(harnessHome, { recursive: true });
  // IPA_HARNESS_HOME: 세션 안에서 에이전트가 실행하는 `ipa harness install/update`의 전역 쓰기 대상을
  // 격리한다 (실측: HOME은 Claude Code의 셸 스냅샷이 실제 값으로 복원하지만, 로그인 셸에 없는 이
  // 변수는 XDG_CONFIG_HOME처럼 세션 내부 Bash까지 전파된다 — 실제 ~/.claude 오염 사고 2회의 근본 수정).
  const env = { ...process.env, IPA_VAULT_PATH: cwd, XDG_CONFIG_HOME: xdgDir, IPA_HARNESS_HOME: harnessHome };
  if (homeDir) { env.HOME = homeDir; }
  return new Promise((resolve, reject) => {
    const child = spawn(claudeCmd[0], args, { cwd, env });
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

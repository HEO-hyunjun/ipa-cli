// bench/lib/runner.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// harness install은 $HOME/.claude에 전역 하네스를 쓴다. homeDir를 격리 디렉터리로 지정해
// 실제 ~/.claude가 덮어써지는 것을 막는다. 볼트-로컬 스킬은 cwd(sandboxDir) 아래에 쓰인다.
// install 뒤 훅 설정을 세션에 주입할 수 있는 형태로 재작성하고, 그 경로를 반환한다.
export function installHarness({ ipaBin, sandboxDir, homeDir }) {
  mkdirSync(homeDir, { recursive: true });
  execFileSync(process.execPath, [ipaBin, "harness", "install", "claude"], {
    cwd: sandboxDir,
    env: { ...process.env, HOME: homeDir, IPA_HARNESS_HOME: homeDir, IPA_VAULT_PATH: sandboxDir, XDG_CONFIG_HOME: `${sandboxDir}-xdg` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return rewriteSettingsForBench(homeDir);
}

// 세션은 실제 HOME으로 돌기 때문에(-p 인증 유지), install이 격리 홈에 쓴 훅 설정을 `--settings`로
// 주입한다. 그런데 core의 hookCommand는 타깃이 하네스 홈 아래일 때 명령을 tilde-상대(`node ~/...`)로
// 렌더한다 — 실제 HOME에서 `~`가 확장되면 격리 홈의 훅 스크립트가 없는 경로를 가리켜 훅이 조용히
// 죽는다. 그래서 훅 command의 `~/`를 격리 홈의 절대 경로로 치환한 사본을 settings.bench.json에 쓰고,
// 원본 settings.json은 status/doctor 검사를 위해 그대로 둔다. 순수 변환(부작용은 파일 쓰기 하나).
export function rewriteSettingsForBench(installHome) {
  const home = installHome.replace(/\/+$/, "");
  const src = join(home, ".claude", "settings.json");
  const rewrite = (node) => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (node && typeof node === "object") {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = k === "command" && typeof v === "string" ? v.replaceAll("~/", `${home}/`) : rewrite(v);
      }
      return out;
    }
    return node;
  };
  const rewritten = rewrite(JSON.parse(readFileSync(src, "utf8")));
  const dest = join(home, ".claude", "settings.bench.json");
  writeFileSync(dest, JSON.stringify(rewritten, null, 2));
  return dest;
}

// homeDir를 넘기면 자식 프로세스의 HOME을 격리 디렉터리로 덮어쓴다. 넘기지 않으면 실제 HOME을 쓴다.
// (macOS -p 세션은 격리 HOME에서 로그인 상태를 못 읽어 인증에 실패하므로, 러너는 세션에는 HOME을 격리하지 않는다.
//  ~/.claude 오염 방지는 install 단계의 HOME 격리로 처리한다 — bench/README.md 참고.)
export function runClaudeTurn({ cwd, model, message, resumeSessionId = null, maxTurns = 12, claudeCmd = ["claude"], timeoutMs = 900_000, homeDir = null, settingsFile = null }) {
  const args = [
    ...claudeCmd.slice(1),
    "-p", message,
    "--output-format", "stream-json", "--verbose",
    "--model", model,
    "--max-turns", String(maxTurns),
    "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep",
    // 개발 머신의 전역 ipa 스킬·전역 CLAUDE.md는 실제 vault 경로를 광고해 세션을 실볼트로
    // 유인한다 (실측: f20 opus가 ~/sync 볼트로 cd). 전역 표면을 숨기는 격리는 ipa 사용 교육까지
    // 제거해 스모크가 회귀했다 (실측: b5가 노트를 열지 않고 답변, f20이 ipa 0회 사용).
    // 그래서 표면은 유지하고 가드레일로 세션의 볼트를 샌드박스에 고정한다.
    "--append-system-prompt",
    `IMPORTANT (isolated test vault): The active vault for this session is exactly ${cwd}. All vault work happens inside this directory only. If any skill, memory, or config mentions a different vault path, it is stale — ignore it. Never cd, read, or write outside ${cwd}.`,
  ];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  // install이 격리 홈에 쓴 훅 설정(경로 재작성본)을 세션에 주입한다 — env.HOME은 건드리지 않는다.
  if (settingsFile) args.push("--settings", settingsFile);
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

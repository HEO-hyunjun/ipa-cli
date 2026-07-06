// bench/lib/runner.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

// harness install은 $HOME/.claude에 전역 하네스를 쓴다. homeDir를 격리 디렉터리로 지정해
// 실제 ~/.claude가 덮어써지는 것을 막는다. 볼트-로컬 스킬은 cwd(sandboxDir) 아래에 쓰인다.
// install 뒤 그 격리 .claude를 세션이 CLAUDE_CONFIG_DIR로 통째로 쓸 수 있게 손질하고(훅 경로 절대화 +
// defaultMode) 그 config dir 경로를 반환한다. 인증(.credentials.json)은 run.mjs가 provisionAuth로 넣는다.
export function installHarness({ ipaBin, sandboxDir, homeDir }) {
  mkdirSync(homeDir, { recursive: true });
  execFileSync(process.execPath, [ipaBin, "harness", "install", "claude"], {
    cwd: sandboxDir,
    env: { ...process.env, HOME: homeDir, IPA_HARNESS_HOME: homeDir, IPA_VAULT_PATH: sandboxDir, XDG_CONFIG_HOME: `${sandboxDir}-xdg` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const configDir = join(homeDir, ".claude");
  prepareBenchConfigDir(configDir, homeDir);
  return configDir;
}

// 세션은 이 격리 .claude를 유일한 config 루트(CLAUDE_CONFIG_DIR)로 돌린다. CLAUDE_CONFIG_DIR는
// 실제 ~/.claude를 병합이 아니라 완전히 대체하므로 샌드박스 하네스 훅만 발화하고 개발자의 실-홈 훅은
// 절대 끼지 않는다 (예전 `--settings` 경로는 둘을 병합해 모든 훅이 이중 발화 → 훅 기반 측정이 전부
// 오염됐다). config dir를 자족적으로 만드는 두 손질:
//   1) tilde-상대 훅 command(`node ~/...`)를 격리 홈 절대경로로 치환 — 세션 셸의 `~` 확장 방식(macOS는
//      os.homedir()가 $HOME을 무시)에 훅 해석이 의존하지 않게 한다.
//   2) permissions.defaultMode를 명시 — 예전 병합은 이 값을 실제 ~/.claude settings에서 상속했다.
//      격리 config dir에선 명시하지 않으면 headless 세션이 권한 프롬프트에 막힌다.
// 순수 변환(부작용은 settings.json 덮어쓰기 하나).
export function prepareBenchConfigDir(configDir, home) {
  const abs = home.replace(/\/+$/, "");
  const src = join(configDir, "settings.json");
  const rewrite = (node) => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (node && typeof node === "object") {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = k === "command" && typeof v === "string" ? v.replaceAll("~/", `${abs}/`) : rewrite(v);
      }
      return out;
    }
    return node;
  };
  const settings = rewrite(JSON.parse(readFileSync(src, "utf8")));
  settings.permissions = { ...(settings.permissions ?? {}), defaultMode: settings.permissions?.defaultMode ?? "auto" };
  writeFileSync(src, JSON.stringify(settings, null, 2));
  return src;
}

// macOS 로그인 키체인의 OAuth 자격증명을 격리 config dir에 .credentials.json으로 복사한다. 이 claude
// 버전은 비-기본 CLAUDE_CONFIG_DIR에선 키체인을 참조하지 않고 config dir의 파일에서 자격증명을 읽으므로
// (실측: 이게 없으면 세션이 "Not logged in"으로 죽는다), 세션이 인증되려면 이 복사가 필요하다. 키체인에서
// 자격증명을 밖으로 READ만 하며 실제 ~/.claude에는 절대 쓰지 않는다. 키체인 엔트리가 없는 non-macOS/CI에선
// soft-fail한다.
export function provisionAuth(configDir) {
  try {
    const cred = execFileSync("security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8" });
    const dest = join(configDir, ".credentials.json");
    writeFileSync(dest, cred.endsWith("\n") ? cred : `${cred}\n`, { mode: 0o600 });
    return dest;
  } catch {
    return null; // 키체인 없음 — 세션이 상속받은 자격증명에 맡긴다
  }
}

// configDir를 넘기면 세션을 그 격리 config dir(CLAUDE_CONFIG_DIR) + 격리 HOME으로 돌린다 — 샌드박스 훅만
// 발화하고, 세션 내부의 `ipa harness install`도 실제 ~/.claude에 닿지 못한다. 인증은 configDir에 복사된
// .credentials.json에서 온다. configDir 없이(dry-run) 돌면 homeDir가 없는 한 실제 HOME을 그대로 쓴다.
export function runClaudeTurn({ cwd, model, message, resumeSessionId = null, maxTurns = 12, claudeCmd = ["claude"], timeoutMs = 900_000, homeDir = null, configDir = null }) {
  const args = [
    ...claudeCmd.slice(1),
    "-p", message,
    "--output-format", "stream-json", "--verbose",
    "--model", model,
    "--max-turns", String(maxTurns),
    "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep",
    // 세션은 격리 하네스 표면(설치된 ipa 스킬 + ipa 교육 CLAUDE.md)을 CLAUDE_CONFIG_DIR로 로드한다 —
    // ipa 사용 교육은 유지하되(전역 표면을 숨기면 스모크가 회귀한다: b5가 노트 없이 답변, f20이 ipa
    // 0회), 그 표면에 남은 stale vault 경로 참조가 세션을 실볼트로 유인하지 않도록(실측: f20 opus가
    // ~/sync로 cd) 가드레일로 세션의 볼트를 샌드박스에 고정한다.
    "--append-system-prompt",
    `IMPORTANT (isolated test vault): The active vault for this session is exactly ${cwd}. All vault work happens inside this directory only. If any skill, memory, or config mentions a different vault path, it is stale — ignore it. Never cd, read, or write outside ${cwd}.`,
  ];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  const xdgDir = `${cwd}-xdg`; // 프로필 레지스트리 격리 (~/.config/ipa 보호)
  const harnessHome = homeDir ?? (configDir ? dirname(configDir) : `${cwd}-home`);
  mkdirSync(xdgDir, { recursive: true });
  mkdirSync(harnessHome, { recursive: true });
  // IPA_HARNESS_HOME: 세션 안에서 에이전트가 실행하는 `ipa harness install/update`의 전역 쓰기 대상을
  // 격리한다 (실측: HOME은 Claude Code의 셸 스냅샷이 실제 값으로 복원하지만, 로그인 셸에 없는 이
  // 변수는 XDG_CONFIG_HOME처럼 세션 내부 Bash까지 전파된다 — 실제 ~/.claude 오염 사고 2회의 근본 수정).
  const env = { ...process.env, IPA_VAULT_PATH: cwd, XDG_CONFIG_HOME: xdgDir, IPA_HARNESS_HOME: harnessHome };
  // CLAUDE_CONFIG_DIR: 세션이 격리 하네스 config dir만 로드한다 → 실-홈 훅 병합(이중 발화) 제거.
  // macOS os.homedir()는 $HOME을 무시하므로 config 격리는 HOME이 아니라 이 변수가 담당한다.
  // HOME도 격리해 `~`·세션 내부 install을 실제 홈에서 떼어 놓는다 (인증은 config dir의 .credentials.json).
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  if (homeDir) env.HOME = homeDir;
  else if (configDir) env.HOME = dirname(configDir);
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

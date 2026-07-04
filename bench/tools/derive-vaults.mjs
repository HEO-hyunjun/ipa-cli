// bench/tools/derive-vaults.mjs
// divergent 스냅샷에서 canonical / messy / pre-ipa 페르소나를 결정적으로 재생성한다.
// 실행: node bench/tools/derive-vaults.mjs  (산출물은 커밋 대상)
import { cpSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VAULTS = join(REPO, "bench", "vaults");
const IPA_BIN = join(REPO, "packages", "cli", "dist", "main.js");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function* mdFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* mdFiles(full);
    else if (entry.name.endsWith(".md")) yield full;
  }
}

// "2026-05-06 22:04" → "2026/05/06 (Tue) 22:04:00"
function toCanonicalDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return value;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`);
  return `${m[1]}/${m[2]}/${m[3]} (${DAYS[d.getDay()]}) ${m[4]}:${m[5]}:00`;
}

function transformFrontmatter(text) {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return text;
  let fm = text.slice(4, end);
  fm = fm
    .replace(/^kind:/m, "type:")
    .replace(/^parents:/m, "ref:")
    .replace(/^created:\s*(.+)$/m, (_, v) => `date_created: ${toCanonicalDate(v)}`)
    .replace(/^updated:\s*(.+)$/m, (_, v) => `date_modified: ${toCanonicalDate(v)}`);
  return `---\n${fm}${text.slice(end)}`;
}

const CANONICAL_CONFIG = `mapping:
  fields:
    note_type: type
    refs: ref
    tags: tags
    created_at: date_created
    updated_at: date_modified
    aliases: aliases
  folders:
    inbox: "00 Inbox"
    project: "01 Project"
    archive: "02 Archive"
  date_format: "YYYY/MM/DD (ddd) HH:mm:ss"
files:
  exclude:
    - README.md
    - AGENTS.md
    - CLAUDE.md
    - "90 Settings/**"
`;

function buildCanonical() {
  const src = join(VAULTS, "divergent");
  const dst = join(VAULTS, "canonical");
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  rmSync(join(dst, "99 Fixtures"), { recursive: true, force: true }); // 의도적 위반 픽스처 제외
  rmSync(join(dst, ".ipa", "plugins"), { recursive: true, force: true }); // divergent 전용 규칙 제거
  rmSync(join(dst, ".ipa", "tune", "logs"), { recursive: true, force: true }); // 개인 절대경로 담긴 검색 로그 제거
  rmSync(join(dst, "90 Settings", "Profile Fixtures"), { recursive: true, force: true }); // 개인 경로 담긴 내부 프로필 픽스처 제외
  for (const file of mdFiles(dst)) writeFileSync(file, transformFrontmatter(readFileSync(file, "utf8")));
  writeFileSync(join(dst, ".ipa", "config.yaml"), CANONICAL_CONFIG);
  // 포매터로 잔여 자동수정 가능 이슈 정규화
  execFileSync(process.execPath, [IPA_BIN, "--vault", dst, "formatter", "apply"], { stdio: "inherit" });
}

const MESSY_STRIP_FM = ["02 Archive/프렌치프레스 첫 기록.md", "00 Inbox/커피 드립 실패 메모.md"];
const MESSY_OLD_FIELDS = ["02 Archive/러닝 다음날 회복 루틴.md"];
const MESSY_ORPHANS = [
  ["스탠딩 데스크 높이 메모", "팔꿈치 90도 기준으로 71cm가 맞는 것 같다. 모니터암 높이도 다시 잡아야 한다."],
  ["출퇴근 팟캐스트 목록", "요즘 듣는 것: 개발 관련 두 개, 경제 하나. 과학 팟캐스트 하나 추가하고 싶다."],
  ["위스키 테이스팅 임시 메모", "아일라 계열은 아직 어렵다. 셰리 캐스크 쪽부터 다시."],
  ["여행 짐 체크리스트 초안", "보조배터리, 멀티어댑터, 상비약. 작년에 우산을 두 번 잊었다."],
];

function buildMessy() {
  const src = join(VAULTS, "canonical");
  const dst = join(VAULTS, "messy");
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  for (const rel of MESSY_STRIP_FM) {
    const p = join(dst, rel);
    if (!existsSync(p)) throw new Error(`messy fixture missing: ${rel}`);
    const text = readFileSync(p, "utf8");
    const end = text.indexOf("\n---", 4);
    writeFileSync(p, text.slice(end + 5).replace(/^\n+/, "")); // frontmatter 통째로 제거
  }
  for (const rel of MESSY_OLD_FIELDS) {
    const p = join(dst, rel);
    if (!existsSync(p)) throw new Error(`messy fixture missing: ${rel}`);
    writeFileSync(p, readFileSync(p, "utf8")
      .replace(/^type:/m, "kind:").replace(/^ref:/m, "parents:")
      .replace(/^date_created:/m, "created:").replace(/^date_modified:/m, "updated:"));
  }
  for (const [title, body] of MESSY_ORPHANS) {
    writeFileSync(join(dst, "00 Inbox", `${title}.md`), `# ${title}\n\n${body}\n`); // frontmatter 없음 = 의도된 방치
  }
}

function buildPreIpa() {
  const src = join(VAULTS, "canonical");
  const dst = join(VAULTS, "pre-ipa");
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  rmSync(join(dst, ".ipa"), { recursive: true, force: true });
  for (const f of ["AGENTS.md", "CLAUDE.md", ".ipa-config"]) rmSync(join(dst, f), { force: true });
  const renames = [["00 Inbox", "Inbox"], ["01 Project", "Projects"], ["02 Archive", "Archive"], ["90 Settings", "Meta"]];
  for (const [from, to] of renames) if (existsSync(join(dst, from))) renameSync(join(dst, from), join(dst, to));
  for (const file of mdFiles(dst)) {
    // IPA 필드 제거, tags만 유지 — "IPA 이전" 상태 재현
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text
      .replace(/^type:.*\n/m, "").replace(/^ref:.*\n/m, "")
      .replace(/^date_created:.*\n/m, "").replace(/^date_modified:.*\n/m, "")
      .replace(/^aliases:.*\n/m, "").replace(/^stage:.*\n/m, "").replace(/^special:.*\n/m, ""));
  }
}

buildCanonical();
buildMessy();
buildPreIpa();
console.log("personas rebuilt: canonical, messy, pre-ipa");

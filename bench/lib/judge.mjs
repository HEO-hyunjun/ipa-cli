// bench/lib/judge.mjs
import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";

const HARNESS_MD = new Set(["CLAUDE.md", "AGENTS.md"]);
const isVaultMd = (p) => p.endsWith(".md") && !p.startsWith(".ipa/") && !p.startsWith(".claude/") && !HARNESS_MD.has(p);

function changedMd(diff) {
  return [...diff.added, ...diff.removed, ...diff.modified].filter(isVaultMd);
}

function validatorErrors(ipaBin, sandboxDir, title) {
  try {
    const out = execFileSync(process.execPath,
      [ipaBin, "--vault", sandboxDir, "validator", "--note", title, "--json"],
      { encoding: "utf8", cwd: sandboxDir, stdio: ["ignore", "pipe", "pipe"] });
    const payload = JSON.parse(out);
    return { errors: (payload.issues ?? []).filter((i) => i.severity === "error"), skipped: false };
  } catch (e) {
    // 설정에서 제외된 폴더의 파일은 볼트 정책상 노트가 아니다 — validator가 "note not found"로
    // 실패하면 에러가 아니라 skip으로 취급한다.
    const out = `${e.stderr ?? ""}${e.stdout ?? ""}${e}`;
    if (/note not found/i.test(out)) return { errors: [], skipped: true };
    return { errors: [{ code: "bench.validator_failed", severity: "error", message: String(e).slice(0, 300) }], skipped: false };
  }
}

function formatterPatchCount(ipaBin, sandboxDir, title) {
  try {
    const out = execFileSync(process.execPath,
      [ipaBin, "--vault", sandboxDir, "formatter", "plan", "--note", title, "--json"],
      { encoding: "utf8", cwd: sandboxDir, stdio: ["ignore", "pipe", "pipe"] });
    const payload = JSON.parse(out);
    return { patches: payload.summary?.patches ?? payload.patches?.length ?? 0, skipped: false };
  } catch (e) {
    // validatorErrors와 동일: 색인 제외 파일은 formatter plan이 "note not found"로 실패한다 —
    // 에러가 아니라 skip으로 취급한다.
    const out = `${e.stderr ?? ""}${e.stdout ?? ""}${e}`;
    if (/note not found/i.test(out)) return { patches: 0, skipped: true };
    return { patches: 0, skipped: false, error: String(e).slice(0, 300) };
  }
}

export function evaluateExpect(expect, ctx) {
  const { sandboxDir, diff, parsed, ipaBin } = ctx;
  const results = [];
  const push = (name, pass, detail = "") => results.push({ name, pass, detail });

  for (const [key, value] of Object.entries(expect)) {
    switch (key) {
      case "no_ipa_calls":
        push(key, parsed.ipaCalls.length === 0, `${parsed.ipaCalls.length} ipa calls`); break;
      case "ipa_used":
        push(key, parsed.ipaCalls.length > 0, `${parsed.ipaCalls.length} ipa calls`); break;
      case "no_hand_edit":
        // 메커니즘이 요점인 시나리오의 이스케이프 해치 감시: ipa CLI를 우회해 vault .md를
        // Write/Edit/Grep으로 직접 손댔으면 fail. mechanism-in-CLI 계약을 지표가 아니라 게이트로 세운다.
        push(key, parsed.nonIpaVaultTouches === 0, `${parsed.nonIpaVaultTouches} non-ipa vault touches`); break;
      case "used_command":
        push(key, parsed.ipaCalls.some((c) => new RegExp(value).test(c.command)), value); break;
      case "not_used_command":
        push(key, !parsed.ipaCalls.some((c) => new RegExp(value).test(c.command)), value); break;
      case "command_flow": {
        // value: 정규식 배열 — ipa 호출 시퀀스에 순서대로(부분수열) 매칭되어야 한다.
        // 한 호출이 `ipa a && ipa b`처럼 체이닝된 경우 연속 스텝을 한 호출에서 전진시킬 수 있다.
        let idx = 0;
        for (const c of parsed.ipaCalls) {
          while (idx < value.length && new RegExp(value[idx]).test(c.command)) idx += 1;
        }
        push(key, idx === value.length, `matched ${idx}/${value.length} steps`); break;
      }
      case "file_added":
        push(key, diff.added.some((p) => new RegExp(value).test(p)), value); break;
      case "file_modified":
        push(key, diff.modified.some((p) => new RegExp(value).test(p)), value); break;
      case "file_removed":
        push(key, diff.removed.some((p) => new RegExp(value).test(p)), value); break;
      case "md_changed_max": {
        const n = changedMd(diff).length;
        push(key, n <= value, `${n} md changed (max ${value})`); break;
      }
      case "md_changed_min": {
        const n = changedMd(diff).length;
        push(key, n >= value, `${n} md changed (min ${value})`); break;
      }
      case "notes_moved_max": {
        // 이동한 노트 = diff.removed의 basename이 diff.added에 같은 이름으로 다시 나타나는 쌍.
        // 폴더 rename/대량 이동은 60+ 쌍으로 잡히고, 기계적 formatter 정규화는 modified만 남긴다.
        const addedNames = new Set(diff.added.filter(isVaultMd).map((p) => basename(p, ".md")));
        const count = diff.removed.filter(isVaultMd).filter((p) => addedNames.has(basename(p, ".md"))).length;
        push(key, count <= value, `${count} notes moved (max ${value})`); break;
      }
      case "md_changes_within": {
        const offenders = changedMd(diff).filter((p) => !value.some((prefix) => p.startsWith(prefix)));
        push(key, offenders.length === 0, offenders.join(", ")); break;
      }
      case "notes_added": {
        const hits = diff.added.filter((p) => isVaultMd(p) && p.startsWith(`${value.folder}/`)
          && (!value.title_regex || new RegExp(value.title_regex).test(basename(p, ".md"))));
        const okMin = value.min === undefined || hits.length >= value.min;
        const okMax = value.max === undefined || hits.length <= value.max;
        push(key, okMin && okMax, `${hits.length} notes in ${value.folder}`); break;
      }
      case "file_contains": {
        const full = join(sandboxDir, value.path);
        const ok = existsSync(full) && new RegExp(value.regex).test(readFileSync(full, "utf8"));
        push(key, ok, `${value.path} ~ /${value.regex}/`); break;
      }
      case "formatter_pending_empty": {
        // 실제 formatter 상태를 측정한다 — write-nudge 원장(formatter-pending.json)이 아니라.
        // 원장은 Write/Edit 툴로 노트 루트 md를 편집할 때만 쓰여서, CLI 골든패스로 작업하면
        // 비어 있어 무조건 통과했다. 변경된 노트마다 `formatter plan --json`을 돌려 미적용
        // 패치가 0인지 확인한다.
        const titles = [...diff.added, ...diff.modified].filter(isVaultMd)
          .map((p) => basename(p, ".md"))
          .filter((t) => !["README", "🏠 Home"].includes(t));
        const offenders = [];
        const skipped = [];
        for (const t of titles) {
          const r = formatterPatchCount(ipaBin, sandboxDir, t);
          if (r.skipped) skipped.push(t);
          else if (r.error) offenders.push(`${t}: ${r.error}`);
          else if (r.patches > 0) offenders.push(`${r.patches} patches pending in ${t}`);
        }
        const clean = `clean (${titles.length - skipped.length} notes${skipped.length ? `, ${skipped.length} skipped: not indexed` : ""})`;
        push(key, offenders.length === 0, offenders.slice(0, 5).join(" | ") || clean); break;
      }
      case "validator_clean_changed": {
        const titles = [...diff.added, ...diff.modified].filter(isVaultMd)
          .map((p) => basename(p, ".md"))
          .filter((t) => !["README", "🏠 Home"].includes(t));
        const errors = [];
        const skipped = [];
        for (const t of titles) {
          const r = validatorErrors(ipaBin, sandboxDir, t);
          if (r.skipped) skipped.push(t);
          else errors.push(...r.errors.map((i) => `${t}: ${i.message}`));
        }
        const clean = `clean (${titles.length - skipped.length} notes${skipped.length ? `, ${skipped.length} skipped: not indexed` : ""})`;
        push(key, errors.length === 0, errors.slice(0, 5).join(" | ") || clean); break;
      }
      case "validator_reports_regex": {
        // 볼트 전체 validator를 돌려(에이전트가 저작한 rule 플러그인 포함) 이슈가 regex에 걸리는지
        // 확인한다. validator_clean_changed와 달리 특정 이슈의 *존재*를 요구한다 — 저작한 rule이
        // 실제로 발화하는지 end-state로 판정한다(rule-authoring 프로브에서 사용).
        const re = new RegExp(value);
        try {
          const out = execFileSync(process.execPath,
            [ipaBin, "--vault", sandboxDir, "validator", "--json"],
            { encoding: "utf8", cwd: sandboxDir, stdio: ["ignore", "pipe", "pipe"] });
          const issues = JSON.parse(out).issues ?? [];
          const hit = issues.some((i) => re.test(`${i.message ?? ""} ${i.note ?? ""} ${i.code ?? ""}`));
          push(key, hit, hit ? `matched issue ~ /${value}/` : `${issues.length} issues, none ~ /${value}/`);
        } catch (e) {
          push(key, false, `validator failed: ${String(e).slice(0, 200)}`);
        }
        break;
      }
      case "final_answer_regex":
        push(key, new RegExp(value).test(parsed.finalText), value); break;
      case "final_answer_not_regex":
        push(key, !new RegExp(value).test(parsed.finalText), value); break;
      case "any_of": {
        // value: 서브 expect 객체 배열 — judge는 키를 AND로 보므로 OR가 필요할 때 쓴다.
        // 각 서브 expect를 재귀 평가해, 하위 항목이 모두 통과하는 분기가 하나라도 있으면 통과.
        const branches = (Array.isArray(value) ? value : []).map((sub) => {
          const rows = evaluateExpect(sub, ctx);
          return { ok: rows.length > 0 && rows.every((r) => r.pass), rows };
        });
        const detail = branches
          .map((b, i) => `[${i}] ${b.ok ? "pass" : (b.rows.filter((r) => !r.pass).map((r) => r.name).join("+") || "empty")}`)
          .join(" | ");
        push(key, branches.some((b) => b.ok), detail); break;
      }
      default:
        push(key, false, "unknown assertion key");
    }
  }
  return results;
}

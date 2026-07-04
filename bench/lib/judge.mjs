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
        const p = join(sandboxDir, ".ipa", "harness", "formatter-pending.json");
        let ok = true, detail = "absent";
        if (existsSync(p)) {
          try {
            const data = JSON.parse(readFileSync(p, "utf8"));
            const list = Array.isArray(data) ? data : data.notes ?? data.pending ?? [];
            ok = list.length === 0; detail = `${list.length} pending`;
          } catch { ok = false; detail = "unparseable"; }
        }
        push(key, ok, detail); break;
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
      case "final_answer_regex":
        push(key, new RegExp(value).test(parsed.finalText), value); break;
      case "final_answer_not_regex":
        push(key, !new RegExp(value).test(parsed.finalText), value); break;
      default:
        push(key, false, "unknown assertion key");
    }
  }
  return results;
}

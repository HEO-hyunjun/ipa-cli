// bench/tests/vaults.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VAULTS = join(REPO, "bench", "vaults");
const IPA_BIN = join(REPO, "packages", "cli", "dist", "main.js");

test("five personas exist with expected shape", () => {
  for (const p of ["canonical", "divergent", "messy", "pre-ipa", "empty"]) assert.ok(existsSync(join(VAULTS, p)), p);
  assert.ok(existsSync(join(VAULTS, "canonical", ".ipa", "config.yaml")));
  assert.ok(!existsSync(join(VAULTS, "pre-ipa", ".ipa")), "pre-ipa must not have .ipa");
  assert.ok(existsSync(join(VAULTS, "pre-ipa", "Inbox")), "pre-ipa uses renamed folders");
  assert.ok(existsSync(join(VAULTS, "messy", "00 Inbox", "스탠딩 데스크 높이 메모.md")));
});

test("canonical uses standard fields, divergent keeps its own", () => {
  const canon = readFileSync(join(VAULTS, "canonical", "02 Archive", "V60 15g 240g 기본 레시피.md"), "utf8");
  assert.match(canon, /^type:/m);
  assert.match(canon, /^date_created: \d{4}\/\d{2}\/\d{2}/m);
  const div = readFileSync(join(VAULTS, "divergent", "02 Archive", "V60 15g 240g 기본 레시피.md"), "utf8");
  assert.match(div, /^kind:/m);
});

test("canonical validator has zero error-severity issues", () => {
  const out = execFileSync(process.execPath, [IPA_BIN, "--vault", join(VAULTS, "canonical"), "validator", "--json"], { encoding: "utf8" });
  const errors = JSON.parse(out).issues.filter((i) => i.severity === "error");
  assert.equal(errors.length, 0, JSON.stringify(errors.slice(0, 3)));
});

test("scenario-referenced note titles exist in canonical", () => {
  const needed = [
    "02 Archive/V60 15g 240g 기본 레시피.md",
    "02 Archive/오후 커피 컷오프 실험.md",
    "00 Inbox/러닝화 후보 메모.md",
    "02 Archive/무릎 통증 신호 체크리스트.md",
    "00 Inbox/아침 식사와 집중도 로그.md",
    "02 Archive/수면 개선 22시 루틴.md",
  ];
  for (const rel of needed) assert.ok(existsSync(join(VAULTS, "canonical", rel)), rel);
});

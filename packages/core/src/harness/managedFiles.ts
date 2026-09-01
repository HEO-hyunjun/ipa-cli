import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const HARNESS_MARKER = "IPA_HARNESS_MANAGED";
export const HARNESS_MANAGED_BLOCK = "ipa-harness";

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function readFileSyncText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function managedFileState(path) {
  if (!existsSync(path)) return "missing";
  try {
    return readFileSyncText(path).includes(HARNESS_MARKER) ? "managed" : "user";
  } catch {
    return "missing";
  }
}

export function hasManagedFile(path) {
  return managedFileState(path) === "managed";
}

export async function writeManagedFile(path, content, files, skipped = null) {
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const previous = await readFile(path, "utf8");
    if (previous === content) {
      files.push(path);
      return;
    }
    if (!previous.includes(HARNESS_MARKER)) {
      if (skipped) skipped.push(path);
      return;
    }
  }
  await writeFile(path, content, "utf8");
  files.push(path);
}

export async function removeManagedFile(path, removed) {
  if (!existsSync(path)) return;
  const text = await readFile(path, "utf8");
  if (!text.includes(HARNESS_MARKER)) return;
  await rm(path, { force: true });
  removed.push(path);
}

export async function writeManagedVaultFile(vaultPath, relPath, content, files, skipped = null) {
  const written = [];
  const skippedAbs = [];
  await writeManagedFile(join(vaultPath, relPath), content, written, skippedAbs);
  if (written.length) files.push(relPath);
  if (skipped && skippedAbs.length) skipped.push(relPath);
}

export async function removeManagedVaultFile(vaultPath, relPath, removed) {
  const before = removed.length;
  await removeManagedFile(join(vaultPath, relPath), removed);
  if (removed.length > before) removed[removed.length - 1] = relPath;
}

export async function upsertManagedBlock(path, body) {
  const begin = `<!-- ${HARNESS_MARKER}_BEGIN:${HARNESS_MANAGED_BLOCK} -->`;
  const end = `<!-- ${HARNESS_MARKER}_END:${HARNESS_MANAGED_BLOCK} -->`;
  const block = `${begin}\n${body.trim()}\n${end}`;
  const previous = existsSync(path) ? await readFile(path, "utf8") : "";
  const pattern = new RegExp(`${escaped(begin)}[\\s\\S]*?${escaped(end)}`);
  const next = pattern.test(previous)
    ? previous.replace(pattern, block)
    : [previous.trimEnd(), block].filter(Boolean).join("\n\n") + "\n";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");
}

export async function removeManagedBlock(path) {
  if (!existsSync(path)) return false;
  const begin = `<!-- ${HARNESS_MARKER}_BEGIN:${HARNESS_MANAGED_BLOCK} -->`;
  const end = `<!-- ${HARNESS_MARKER}_END:${HARNESS_MANAGED_BLOCK} -->`;
  const previous = await readFile(path, "utf8");
  const pattern = new RegExp(`\\n?${escaped(begin)}[\\s\\S]*?${escaped(end)}\\n?`);
  if (!pattern.test(previous)) return false;
  await writeFile(path, previous.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n", "utf8");
  return true;
}

export function readManagedBlockBody(path) {
  if (!existsSync(path)) return null;
  const begin = `<!-- ${HARNESS_MARKER}_BEGIN:${HARNESS_MANAGED_BLOCK} -->`;
  const end = `<!-- ${HARNESS_MARKER}_END:${HARNESS_MANAGED_BLOCK} -->`;
  const text = readFileSyncText(path);
  const beginIdx = text.indexOf(begin);
  const endIdx = text.indexOf(end);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return null;
  return text.slice(beginIdx + begin.length, endIdx).trim();
}

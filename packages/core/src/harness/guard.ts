import { existsSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";

export function guardAllowPatterns(config, asList) {
  return asList(config?.harness?.guard?.allow);
}

function isInsideVault(vaultPath, absolutePath) {
  const rel = relative(vaultPath, absolutePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("/"));
}

function pathInFolder(relPath, folder, toPosix) {
  const rel = toPosix(relPath).replace(/^\/+/, "");
  const dir = toPosix(folder).replace(/^\/+/, "");
  return rel === dir || rel.startsWith(`${dir}/`);
}

export function createHarnessGuard(deps) {
  const status = async (vaultPath) => {
    const { config, mapping } = await deps.readVaultConfig(vaultPath);
    return {
      policy: "new_markdown_requires_inbox",
      inbox_dir: mapping.inbox_dir,
      project_dir: mapping.project_dir,
      archive_dir: mapping.archive_dir,
      allow: guardAllowPatterns(config, deps.asList)
    };
  };

  const check = async (vaultPath, relPath, options = {}) => {
    if (!relPath) throw new Error("harness guard check requires a vault-relative path");
    const { config, mapping } = await deps.readVaultConfig(vaultPath);
    const normalized = deps.toPosix(relPath).replace(/^\/+/, "");
    const absolute = resolve(vaultPath, normalized);
    if (!isInsideVault(vaultPath, absolute)) {
      return { allowed: false, reason: "path escapes vault", path: normalized };
    }
    const action = options.action ?? (existsSync(absolute) ? "edit" : "create");
    if (extname(normalized).toLowerCase() !== ".md") {
      return { allowed: true, reason: "non-markdown file", path: normalized, action };
    }
    const walkerSkipped = normalized === ".ipa" || normalized.startsWith(".ipa/")
      || normalized.split("/").some((segment) => segment === ".git" || segment === ".cache" || segment === "node_modules");
    if (walkerSkipped || deps.isExcludedPath(normalized, deps.asList(mapping.exclude))) {
      return { allowed: true, reason: "path is excluded from note indexing", path: normalized, action };
    }
    if (action !== "create") {
      return { allowed: true, reason: "existing markdown edit", path: normalized, action };
    }
    if (pathInFolder(normalized, mapping.inbox_dir, deps.toPosix)) {
      return { allowed: true, reason: "new markdown is under inbox", path: normalized, action, inbox_dir: mapping.inbox_dir };
    }
    const allowPatterns = guardAllowPatterns(config, deps.asList);
    if (deps.isExcludedPath(normalized, allowPatterns)) {
      return { allowed: true, reason: "path matches a guard allow pattern from .ipa/config.yaml", path: normalized, action, inbox_dir: mapping.inbox_dir };
    }
    return {
      allowed: false,
      reason: "new markdown files must be created under the configured inbox folder",
      path: normalized,
      action,
      inbox_dir: mapping.inbox_dir
    };
  };

  return { status, check };
}

// Small presentation helpers shared across the IPA views.

export function scoreLabel(score: unknown): string {
  const value = Number(score);
  return Number.isFinite(value) ? value.toFixed(2) : "-";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unexpected IPA error";
}

// core returns ref entries either as plain strings or as { id, location } objects.
export function refLabel(ref: unknown): string {
  if (typeof ref === "string") return ref;
  if (ref && typeof ref === "object" && "id" in ref) {
    const entry = ref as { id: string; location?: { kind?: string } };
    return entry.location?.kind ? `${entry.id} [${entry.location.kind}]` : entry.id;
  }
  return String(ref ?? "");
}

// formatVault returns a patch count in summary.patches and/or a patches array.
export function patchCount(result: unknown): number {
  const value = result as { summary?: { patches?: number }; patches?: unknown[] } | null;
  if (value && typeof value.summary?.patches === "number") return value.summary.patches;
  if (value && Array.isArray(value.patches)) return value.patches.length;
  return 0;
}

// Search hits expose a vault-relative path but no location kind, so derive a
// coarse location label from the top-level IPA folder (00 Inbox / 01 Project / 02 Archive).
export function locationFromPath(path: unknown): string {
  const value = typeof path === "string" ? path : "";
  if (!value) return "";
  const top = value.split("/")[0] ?? "";
  if (/inbox/i.test(top)) return "inbox";
  if (/archive/i.test(top)) return "archive";
  if (/project/i.test(top)) return "project";
  return top;
}

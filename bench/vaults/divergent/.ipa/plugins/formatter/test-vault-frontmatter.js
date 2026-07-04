function yamlEscape(value) {
  return JSON.stringify(String(value));
}

function replaceFrontmatterValue(raw, key, value) {
  const lines = String(raw ?? "").split("\n");
  const index = lines.findIndex((line) => line.startsWith(key + ":"));
  if (index === -1) return raw;
  lines[index] = key + ": " + value;
  return lines.join("\n");
}

function expectedStage(note) {
  const top = note.relPath.split("/")[0];
  return { "00 Inbox": "inbox", "01 Project": "active", "02 Archive": "archived" }[top] ?? null;
}

export async function format(note, context) {
  if (note.folder === context.mapping.inbox_dir && Object.keys(note.frontmatter ?? {}).length === 0) {
    const frontmatter = [
      "---",
      "created: 2026-05-10 00:00",
      "updated: 2026-05-10 00:00",
      "kind: note",
      "parents: []",
      "tags: [cli_test]",
      "aliases: [" + yamlEscape(note.id) + "]",
      "stage: inbox",
      "---",
      ""
    ].join("\n");
    return [{ content: frontmatter + note.raw }];
  }

  const stage = expectedStage(note);
  if (stage && note.frontmatter?.stage && note.frontmatter.stage !== stage) {
    return [{ content: replaceFrontmatterValue(note.raw, "stage", stage) }];
  }

  return [];
}

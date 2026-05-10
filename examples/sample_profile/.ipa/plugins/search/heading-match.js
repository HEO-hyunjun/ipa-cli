export async function search(query, notes) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return notes
    .filter((note) => note.body.toLowerCase().includes(`# ${q}`) || note.body.toLowerCase().includes(`## ${q}`))
    .map((note) => ({
      note: note.id,
      score: 1,
      reason: { matched: "heading" }
    }));
}

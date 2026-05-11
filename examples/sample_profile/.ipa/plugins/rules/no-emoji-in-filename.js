export const rules = [{
  code: "sample.no_emoji_in_filename",
  severity: "info",
  check(note) {
    if (note.type === "index" || note.type === "root") return [];
    if (!/^[🔖🏷]/u.test(note.id)) return [];
    return [{
      message: "filename starts with an emoji; reserve emoji prefixes for index/root notes"
    }];
  }
}];

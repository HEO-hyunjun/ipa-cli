from ipa_cli.api import BaseSearchChannel


class ParentAliasChannel(BaseSearchChannel):
    name = "parent_alias"
    description = "Boost notes whose parent index title or alias matches the query."
    default_weight = 0.18
    requires_parse_level = 1

    def setup(self, ctx):
        self.parent_titles = {}
        for note in ctx.notes:
            title = note.title
            aliases = note.field("aliases") or []
            self.parent_titles[note.link] = [title, *aliases]

    def prepare(self, query):
        self.query_terms = set(query.normalized.split())

    def search(self, ctx, query):
        scores = {}
        for note in ctx.notes:
            score = 0.0
            for parent in note.field("parents") or []:
                for label in self.parent_titles.get(parent, []):
                    text = label.lower()
                    if any(term in text for term in self.query_terms):
                        score = max(score, 1.0)
            if score:
                scores[note.id] = score
        return scores

    def explain(self, note_id):
        return {"reason": "query term matched parent title or alias"}


from ipa_cli.api import BaseConventionRule, Issue, Severity


class FrontmatterKindRule(BaseConventionRule):
    code = "ipa_test.frontmatter_kind"
    severity = Severity.ERROR
    default_scope = "note"

    def check(self, ctx, note):
        kind = note.field("kind")
        if kind in {"note", "index", "root"}:
            return []
        return [
            Issue(
                code=self.code,
                severity=self.severity,
                note_id=note.id,
                message="kind must be one of note, index, root",
                span=None,
            )
        ]


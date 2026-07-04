from ipa_cli.api import BaseConventionRule, Issue, Severity


class ProjectNoteRule(BaseConventionRule):
    code = "ipa_test.project_note"
    severity = Severity.ERROR
    default_scope = "folder"

    def check_folder(self, ctx, folder):
        issues = []
        for note in ctx.iter_notes(folder=folder):
            if note.path.startswith("01 Project/") and note.field("kind") == "note":
                issues.append(
                    Issue(
                        code=self.code,
                        severity=self.severity,
                        note_id=note.id,
                        message="01 Project may contain root/index only",
                        span=None,
                    )
                )
        return issues


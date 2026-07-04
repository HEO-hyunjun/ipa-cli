from pathlib import PurePosixPath

from ipa_cli.api import BaseConventionRule, Issue, Severity


class ArchiveFlatRule(BaseConventionRule):
    code = "ipa_test.archive_flat"
    severity = Severity.ERROR
    default_scope = "vault"

    def check_vault(self, ctx):
        issues = []
        for note in ctx.iter_notes():
            path = PurePosixPath(note.path)
            if len(path.parts) > 2 and path.parts[0] == "02 Archive":
                issues.append(
                    Issue(
                        code=self.code,
                        severity=self.severity,
                        note_id=note.id,
                        message="02 Archive must stay flat",
                        span=None,
                    )
                )
        return issues


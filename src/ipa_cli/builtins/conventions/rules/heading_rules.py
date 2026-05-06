"""Heading convention rules.

Mirrors 1차's H001 ("h1 used") nudge: filename serves as the title in
the IPA convention so notes should start at H2. Code-fence content is
explicitly skipped so YAML/example markdown blocks don't trip the rule.
P5's markdown-it-py parser will replace this hand-rolled fence tracker
with proper AST traversal.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar

from ipa_cli.api.base_rules import BaseConventionRule, Issue, Severity, Span

if TYPE_CHECKING:
    from ipa_cli.api.context import ValidationContext
    from ipa_cli.parse.note_model import Note


class NoH1Rule(BaseConventionRule):
    """Flag in-body H1 headings outside fenced code blocks."""

    code: ClassVar[str] = "ipa.heading.no_h1"
    severity: ClassVar[Severity] = Severity.INFO

    def check(self, ctx: "ValidationContext", note: "Note") -> list[Issue]:
        issues: list[Issue] = []
        in_fence = False
        for idx, line in enumerate(note.body.splitlines(), start=1):
            stripped = line.lstrip()
            if stripped.startswith("```") or stripped.startswith("~~~"):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            if line.startswith("# ") and not line.startswith("## "):
                issues.append(
                    Issue(
                        code=self.code,
                        severity=self.severity,
                        note_id=note.id,
                        message=f"h1 used: {line.rstrip()!r}",
                        span=Span(idx, 1, idx, len(line) + 1),
                    )
                )
        return issues

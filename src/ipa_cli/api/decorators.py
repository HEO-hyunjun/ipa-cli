"""Convenience decorators for authoring simple rules without boilerplate.

``@simple_format_rule`` wraps a per-line normalizer function into a
``BaseConventionRule`` subclass. The wrapped function takes a single line
and returns the corrected line, or ``None`` when no change is needed.
Each changed line becomes one ``Issue`` (severity-tagged) and one
candidate ``Patch``. This collapses the most common "lint + autofix"
pattern down to a single function so users don't write paired classes.

P1 stub: ``check`` produces issues from ``note.body`` lines. ``fix`` is
left as ``None`` until P3 introduces the FormatContext helpers needed to
re-derive the original line content from a stored ``Issue``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Callable

from ipa_cli.api.base_rules import (
    BaseConventionRule,
    Issue,
    Severity,
    Span,
)

if TYPE_CHECKING:
    from ipa_cli.api.context import FormatContext, ValidationContext
    from ipa_cli.parse.note_model import Note


LineNormalizer = Callable[[str], "str | None"]


def simple_format_rule(
    code: str,
    severity: Severity = Severity.INFO,
) -> Callable[[LineNormalizer], type[BaseConventionRule]]:
    """Wrap a per-line normalizer into a ``BaseConventionRule`` subclass."""

    def decorator(fn: LineNormalizer) -> type[BaseConventionRule]:
        class _SimpleFormatRule(BaseConventionRule):
            _line_fn = staticmethod(fn)

            def check(
                self,
                ctx: "ValidationContext",
                note: "Note",
            ) -> list[Issue]:
                issues: list[Issue] = []
                lines = note.body.splitlines()
                for idx, line in enumerate(lines, start=1):
                    new = type(self)._line_fn(line)
                    if new is None or new == line:
                        continue
                    issues.append(
                        Issue(
                            code=self.code,
                            severity=self.severity,
                            note_id=note.id,
                            message=f"line {idx}: normalize",
                            span=Span(idx, 1, idx, len(line) + 1),
                        )
                    )
                return issues

            def fix(
                self,
                ctx: "FormatContext",
                issue: Issue,
            ) -> list:
                # P3 fills this in once FormatContext exposes a way to
                # look up the original line from issue.note_id + span.
                return None  # type: ignore[return-value]

        cls_name = (
            "".join(part.capitalize() for part in code.replace("-", "_").split("."))
            + "Rule"
        )
        _SimpleFormatRule.__name__ = cls_name
        _SimpleFormatRule.__qualname__ = cls_name
        _SimpleFormatRule.code = code
        _SimpleFormatRule.severity = severity
        return _SimpleFormatRule

    return decorator

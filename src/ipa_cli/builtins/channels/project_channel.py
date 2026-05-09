"""Project channel — soft bonus for active-project context.

Mirrors 1차 ``has_project_context``. A note participates in active
project context when:

- it lives under ``mapping.project_dir`` directly, OR
- one of its refs targets a note that lives under ``mapping.project_dir``.

Scoring is binary 1.0 — the weight applied at engine time gates the
size of the bonus. Notes with zero project context never appear in the
channel output.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar

from ipa_cli.api.base_channels import BaseSearchChannel
from ipa_cli.builtins.channels.weights import DEFAULT_CHANNEL_WEIGHTS
from ipa_cli.parse.links import extract_ref_targets

if TYPE_CHECKING:
    from ipa_cli.api.base_channels import Query, SetupContext
    from ipa_cli.parse.note_model import Note


def _under_project(note: "Note", project_name: str) -> bool:
    return any(part == project_name for part in note.path.parts)


class ProjectChannel(BaseSearchChannel):
    name: ClassVar[str] = "project"
    description: ClassVar[str] = (
        "Note lives in mapping.project_dir or refs into one — score 1.0"
    )
    default_weight: ClassVar[float] = DEFAULT_CHANNEL_WEIGHTS[name]

    def search(self, ctx: "SetupContext", query: "Query") -> dict[str, float]:
        mapping = ctx.mapping
        project_name = mapping.project_dir
        if not project_name:
            return {}

        notes_by_id = {n.id: n for n in ctx.notes}
        scores: dict[str, float] = {}
        for note in ctx.notes:
            if _under_project(note, project_name):
                scores[note.id] = 1.0
                continue
            for ref_target in extract_ref_targets(note.refs(mapping)):
                target = notes_by_id.get(ref_target)
                if target is not None and _under_project(target, project_name):
                    scores[note.id] = 1.0
                    break
        return scores

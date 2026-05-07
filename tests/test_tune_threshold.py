"""tune/threshold_dist.py — analyze_threshold NFC matching."""

from __future__ import annotations

import unicodedata
from pathlib import Path
from typing import ClassVar

from ipa_cli.api.base_channels import BaseSearchChannel, SetupContext
from ipa_cli.parse.note_model import Note
from ipa_cli.runtime.search_engine import SearchEngine
from ipa_cli.tune.threshold_dist import analyze_threshold


class _ConstantChannel(BaseSearchChannel):
    """Channel that returns a constant score for every note — the test
    only cares about whether ``analyze_threshold`` matches the target id."""

    name: ClassVar[str] = "constant"
    description: ClassVar[str] = ""
    default_weight: ClassVar[float] = 1.0

    def setup(self, ctx) -> None:
        return None

    def search(self, ctx, query):
        return {n.id: 1.0 for n in ctx.notes}


def _engine(notes: list[Note]) -> SearchEngine:
    ctx = SetupContext(notes=notes, vault_path=Path("/tmp"), cache_dir=Path("/tmp"))
    return SearchEngine(channels=[_ConstantChannel()], ctx=ctx)


def test_analyze_threshold_matches_nfd_target_to_nfc_note_id() -> None:
    """Testsets shipped from macOS often arrive in NFD; note ids are NFC.
    ``analyze_threshold`` must reconcile both before counting hits."""
    name = "포레스트"
    nfc_id = unicodedata.normalize("NFC", name)
    nfd_target = unicodedata.normalize("NFD", name)
    assert nfc_id != nfd_target

    notes = [
        Note(id=nfc_id, path=Path(f"/tmp/{nfc_id}.md"), body="", frontmatter={}),
        Note(id="other", path=Path("/tmp/other.md"), body="", frontmatter={}),
    ]
    engine = _engine(notes)
    engine.setup()

    testset = {
        "cases": [
            {"id": "R1", "queries": ["q"], "target_filename": nfd_target},
        ],
        "scenario_cases": [],
    }
    result = analyze_threshold(engine, testset, weights={"constant": 1.0})

    assert result.n_cases == 1
    assert result.n_hit_cases == 1, "NFD target should match NFC note id"
    assert result.n_miss_cases == 0


def test_analyze_threshold_matches_nfd_scenario_targets() -> None:
    name = "포레스트"
    nfc_id = unicodedata.normalize("NFC", name)
    nfd_target = unicodedata.normalize("NFD", name)

    notes = [
        Note(id=nfc_id, path=Path(f"/tmp/{nfc_id}.md"), body="", frontmatter={}),
    ]
    engine = _engine(notes)
    engine.setup()

    testset = {
        "cases": [],
        "scenario_cases": [
            {
                "id": "S1",
                "queries": ["q"],
                "target_filenames": [nfd_target],
                "recall_mode": "top10",
                "recall_threshold": 1,
            }
        ],
    }
    result = analyze_threshold(engine, testset, weights={"constant": 1.0})

    assert result.n_hit_cases == 1
    assert result.n_miss_cases == 0

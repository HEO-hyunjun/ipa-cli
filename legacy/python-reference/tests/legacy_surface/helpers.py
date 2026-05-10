"""Equivalence helpers for legacy surface characterization tests.

The plan note (`IPA CLI legacy surface 내부 재구현 계획`) commits to three
helpers backing the byte-identical / structured / 3-tier criteria from
decisions #1, #3, #4:

* :func:`assert_stdout_matches` — Rich/ANSI stripped line-by-line match.
  Used for ``list-*`` / ``view`` / ``traversal`` whose output shape we
  preserve exactly.
* :func:`assert_search_equivalent` — top1 exact, top5 ordered-ish
  (inversion count), topN set equality. Used for ``search``.
* :func:`assert_validator_structured_equal` — issue ID set, severity set,
  and counts. Used for ``validator`` whose stdout is allowed to drift.

All three operate on already-captured output so the test layer can
choose how it invokes legacy vs. new code paths.

Set ``UPDATE_GOLDENS=1`` when running pytest to (re)generate the golden
files under ``tests/fixtures/legacy_goldens/``.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

# CSI / OSC sequences emitted by Rich when not in a terminal-less mode.
# CliRunner usually disables colour, but be defensive — strip both.
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_OSC_RE = re.compile(r"\x1b\][^\x07]*\x07")
_TRAILING_WS_RE = re.compile(r"[ \t]+$", re.MULTILINE)

GOLDENS_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "legacy_goldens"


def strip_ansi(text: str) -> str:
    """Remove ANSI / OSC escape sequences and trailing per-line whitespace."""
    out = _OSC_RE.sub("", text)
    out = _ANSI_RE.sub("", out)
    out = _TRAILING_WS_RE.sub("", out)
    # Rich pads box-drawing rows with spaces; strip those without changing
    # the content shape that consumers care about.
    return out


def normalize(text: str, *, vault: Path | None = None) -> str:
    """Strip ANSI noise and substitute the per-test vault path with ``<VAULT>``.

    pytest's tmp_path differs each run, so legacy commands that print the
    note's absolute path (``Path: /private/var/folders/.../vault/...``)
    would otherwise look unstable. Replacing the vault prefix lets the
    golden file capture the relative shape, which is what the snapshot
    actually cares about.
    """
    out = strip_ansi(text)
    if vault is not None:
        out = out.replace(str(vault), "<VAULT>")
    return out


def _golden_path(name: str) -> Path:
    return GOLDENS_DIR / f"{name}.txt"


def assert_stdout_matches(
    actual: str, golden_name: str, *, vault: Path | None = None
) -> None:
    """Decision #1 — strip Rich/ANSI and compare line-by-line against a
    golden file under ``tests/fixtures/legacy_goldens/``.

    Pass ``vault=`` to mask the per-test absolute path so the golden
    captures the stable shape, not the pytest tmp directory.

    When ``UPDATE_GOLDENS=1`` is set, write the captured output instead
    of asserting. Lets us regenerate goldens whenever the legacy surface
    moves on purpose; the migration tests then have to match the new
    snapshot.
    """
    cleaned = normalize(actual, vault=vault)
    path = _golden_path(golden_name)
    if os.environ.get("UPDATE_GOLDENS") == "1":
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(cleaned, encoding="utf-8")
        return
    if not path.exists():
        raise AssertionError(
            f"golden missing: {path}. Re-run with UPDATE_GOLDENS=1 to capture."
        )
    expected = path.read_text(encoding="utf-8")
    if cleaned != expected:
        # Provide a unified-style hint without pulling in difflib boilerplate.
        raise AssertionError(
            f"stdout drift vs. golden {golden_name!r}.\n"
            f"--- expected ---\n{expected}\n"
            f"--- actual ---\n{cleaned}\n"
        )


# ---------------------------------------------------------------------------
# Search 3-tier (decision #3)
# ---------------------------------------------------------------------------


def _inversions(a: list[str], b: list[str]) -> int:
    """Count pairwise rank inversions between two ID rankings.

    Items present in ``a`` but missing from ``b`` are dropped before
    comparison so the count reflects ordering disagreement only.
    """
    pos = {x: i for i, x in enumerate(b)}
    common = [x for x in a if x in pos]
    inv = 0
    for i in range(len(common)):
        for j in range(i + 1, len(common)):
            if pos[common[i]] > pos[common[j]]:
                inv += 1
    return inv


def assert_search_equivalent(
    actual: list[str],
    expected: list[str],
    *,
    top1: bool = True,
    top5_inversion_max: int = 2,
    topN: int = 10,
) -> None:
    """Decision #3: 3-tier search equivalence.

    * ``top1`` (hard fail) — first hit must match exactly.
    * top5 ordered-ish — top5 IDs must overlap and inversions stay
      within ``top5_inversion_max``.
    * topN set — top ``topN`` IDs must form the same set.

    All three criteria are evaluated; any failure raises AssertionError
    listing every violated tier so callers can act on multiple at once.
    """
    failures: list[str] = []

    if top1:
        a1 = actual[0] if actual else None
        e1 = expected[0] if expected else None
        if a1 != e1:
            failures.append(f"top1 mismatch: actual={a1!r}, expected={e1!r}")

    a5, e5 = actual[:5], expected[:5]
    inv = _inversions(a5, e5)
    if inv > top5_inversion_max:
        failures.append(
            f"top5 inversion count {inv} > {top5_inversion_max} "
            f"(actual={a5}, expected={e5})"
        )

    aN, eN = set(actual[:topN]), set(expected[:topN])
    if aN != eN:
        only_actual = aN - eN
        only_expected = eN - aN
        failures.append(
            f"top{topN} set mismatch — only_actual={sorted(only_actual)}, "
            f"only_expected={sorted(only_expected)}"
        )

    if failures:
        raise AssertionError("search equivalence violated:\n  " + "\n  ".join(failures))


# ---------------------------------------------------------------------------
# Validator structured equivalence (decision #4)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IssueRow:
    """Minimal projection of a validator issue used for structured compare.

    ``code`` survives the legacy ↔ new mapping (we keep legacy codes in
    the legacy view layer) — ``note`` and ``category`` round-trip too.
    """

    note: str
    code: str
    category: str


def assert_validator_structured_equal(
    actual: list[IssueRow], expected: list[IssueRow]
) -> None:
    """Decision #4 — compare issue ID set, severity set, and per-code count.

    Stdout shape (Rich box, summary line wording) is allowed to drift
    between legacy and the new ``runtime/legacy_validator_view.py`` —
    only the structured payload has to round-trip.
    """
    actual_set = {(r.note, r.code) for r in actual}
    expected_set = {(r.note, r.code) for r in expected}
    if actual_set != expected_set:
        only_actual = actual_set - expected_set
        only_expected = expected_set - actual_set
        raise AssertionError(
            "validator issue set drift — "
            f"only_actual={sorted(only_actual)}, "
            f"only_expected={sorted(only_expected)}"
        )

    actual_cats = {r.category for r in actual}
    expected_cats = {r.category for r in expected}
    if actual_cats != expected_cats:
        raise AssertionError(
            f"validator category set drift — actual={sorted(actual_cats)}, "
            f"expected={sorted(expected_cats)}"
        )

    # Per-code counts catch the rare case of a rule firing twice on the
    # same note where the projection collapsed it into one entry.
    def _count(rows: list[IssueRow]) -> dict[str, int]:
        out: dict[str, int] = {}
        for r in rows:
            out[r.code] = out.get(r.code, 0) + 1
        return out

    if _count(actual) != _count(expected):
        raise AssertionError(
            f"validator per-code counts drift — actual={_count(actual)}, "
            f"expected={_count(expected)}"
        )

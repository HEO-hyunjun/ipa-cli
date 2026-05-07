"""Builtin refactor recipe metadata.

Surface for ``list-refactors``. The actual recipe implementations
(arg parsing, mutation logic) ship in S6 — for now the metadata mirrors
the legacy ``vault_refactor`` subcommands so ``list-refactors`` can keep
its byte-identical golden during S1.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class BuiltinRefactor:
    name: str
    description: str


BUILTIN_REFACTORS: list[BuiltinRefactor] = [
    BuiltinRefactor("ref-replace", "ref 교체 (대상 노트의 ref 배열에서 OLD → NEW)"),
    BuiltinRefactor("tag-rename", "태그 이름 변경 (전체 vault)"),
    BuiltinRefactor("tag-remove", "태그 제거"),
    BuiltinRefactor("tag-add", "특정 노트에 태그 추가"),
    BuiltinRefactor("wikilink-replace", "본문 wikilink 치환"),
    BuiltinRefactor("ref-add", "특정 노트에 ref 추가"),
    BuiltinRefactor("ref-remove", "특정 노트에서 ref 제거"),
]

"""Built-in refactor commands (metadata only, S4)."""

from __future__ import annotations

from dataclasses import dataclass

from ipa_cli.plugins.registry import register_refactor


@dataclass(frozen=True)
class BuiltinRefactor:
    name: str
    description: str


_BUILTINS = [
    ("ref-replace", "ref 교체 (대상 노트의 ref 배열에서 OLD → NEW)"),
    ("tag-rename", "태그 이름 변경 (전체 vault)"),
    ("tag-remove", "태그 제거"),
    ("tag-add", "특정 노트에 태그 추가"),
    ("wikilink-replace", "본문 wikilink 치환"),
    ("ref-add", "특정 노트에 ref 추가"),
    ("ref-remove", "특정 노트에서 ref 제거"),
]

for _name, _desc in _BUILTINS:
    register_refactor(BuiltinRefactor(name=_name, description=_desc))

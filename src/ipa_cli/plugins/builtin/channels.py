"""Built-in search channels (metadata only, S4).

Each channel name corresponds to a scoring function inside
`ipa_cli.core.vault_search`. The registry exposes name + default
weight + description so `ipa search list-channels` and `ipa tune`
(S5) can enumerate them.
"""

from __future__ import annotations

from dataclasses import dataclass

from ipa_cli.config.defaults import DEFAULT_WEIGHTS
from ipa_cli.plugins.registry import register_channel

_DESCRIPTIONS: dict[str, str] = {
    "fuzzy": "노트명 4단계 fuzzy/aliases 매칭",
    "keyword": "토큰 매칭 비율 (body_match와 신호 일부 중복)",
    "related": "그래프 관련도 (보조)",
    "body_match": "BM25-trigram 본문 매칭 (자모 NFD trigram)",
    "sequence_match": "filename 토큰 전체 매칭 binary",
    "filename_partial": "filename 토큰 부분 매칭 graded",
    "child_body_match": "인덱스 한정 자식 BM25 max 전파",
    "project": "01 Project 거주 selectivity",
}


@dataclass(frozen=True)
class BuiltinChannel:
    name: str
    weight: float | None
    description: str


for _name, _weight in DEFAULT_WEIGHTS.items():
    register_channel(
        BuiltinChannel(
            name=_name,
            weight=_weight,
            description=_DESCRIPTIONS.get(_name, ""),
        )
    )

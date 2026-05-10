"""P5 parser layer — markdown-it-py wrapper + obsidian extensions."""

from __future__ import annotations

from pathlib import Path

import pytest

from ipa_cli.api.base_channels import SetupContext
from ipa_cli.parse.markdown_parser import (
    extract_code_fences,
    extract_headings,
    extract_inline_text,
    parse_markdown,
)
from ipa_cli.parse.note_model import Note
from ipa_cli.parse.obsidian_extensions import (
    extract_callouts,
    extract_embeds_from_tokens,
    extract_wikilinks_from_tokens,
)


def _note(nid: str, body: str, frontmatter: dict | None = None) -> Note:
    return Note(
        id=nid,
        path=Path(f"/tmp/{nid}.md"),
        body=body,
        frontmatter=frontmatter or {},
    )


def test_parse_markdown_returns_token_list() -> None:
    tokens = parse_markdown("# Title\n\nbody text")
    assert any(t.type == "heading_open" for t in tokens)
    assert any(t.type == "paragraph_open" for t in tokens)


def test_extract_headings_levels_and_text() -> None:
    body = "# H1\n\n## Two\n\n### Three\n"
    headings = extract_headings(parse_markdown(body))
    assert [h.level for h in headings] == [1, 2, 3]
    assert [h.text for h in headings] == ["H1", "Two", "Three"]


def test_extract_code_fences_captures_info_string() -> None:
    body = "intro\n\n```python\nprint(1)\n```\n"
    fences = extract_code_fences(parse_markdown(body))
    assert len(fences) == 1
    assert fences[0].info == "python"
    assert "print(1)" in fences[0].content


def test_inline_text_skips_code_fences() -> None:
    body = "alpha\n\n```\ndo_not_index\n```\n\nbeta gamma"
    text = extract_inline_text(parse_markdown(body))
    assert "alpha" in text
    assert "beta" in text
    assert "do_not_index" not in text


def test_wikilinks_excludes_embeds_and_code_fences() -> None:
    body = (
        "Free [[Real Link]] here.\n\n"
        "![[Embedded Note]] is an embed not a link.\n\n"
        "```\n[[Inside Code]]\n```\n"
    )
    tokens = parse_markdown(body)
    wls = extract_wikilinks_from_tokens(tokens)
    embeds = extract_embeds_from_tokens(tokens)
    assert wls == ["Real Link"]
    assert embeds == ["Embedded Note"]


def test_callouts_recognized_in_blockquote() -> None:
    body = "> [!note] Heads up\n> body\n"
    callouts = extract_callouts(parse_markdown(body))
    assert len(callouts) == 1
    assert callouts[0].kind == "note"
    assert callouts[0].title == "Heads up"


def test_note_body_ast_is_lazy_and_cached() -> None:
    note = _note("alpha", "# Title\n\nhi")
    assert note._body_ast is None  # not built yet
    ast1 = note.body_ast
    ast2 = note.body_ast
    assert ast1 is ast2  # same instance — cached
    assert note.headings[0].text == "Title"


def test_note_wikilinks_property_uses_ast() -> None:
    note = _note("a", "Body with [[Target]] only.")
    assert note.wikilinks == ["Target"]


def test_setup_context_tokens_uses_inline_text(tmp_path: Path) -> None:
    n = _note("alpha", "alpha BETA gamma")
    ctx = SetupContext(notes=[n], vault_path=tmp_path, cache_dir=tmp_path / ".cache")
    toks = ctx.tokens["alpha"]
    assert "alpha" in toks
    assert "beta" in toks  # lowercased
    assert "gamma" in toks


def test_setup_context_ref_graph_filters_dangling_links(tmp_path: Path) -> None:
    a = _note("A", "ref [[B]] and [[NOT_IN_VAULT]]", {"ref": ["[[B]]"]})
    b = _note("B", "")
    ctx = SetupContext(notes=[a, b], vault_path=tmp_path, cache_dir=tmp_path / ".cache")
    g = ctx.ref_graph
    assert g.out_neighbors("A") == {"B"}
    assert g.in_neighbors("B") == {"A"}
    # dangling target dropped
    assert "NOT_IN_VAULT" not in g.edges


def test_setup_context_ref_graph_excludes_self_loop(tmp_path: Path) -> None:
    a = _note("A", "[[A]]", {"ref": ["[[A]]"]})
    ctx = SetupContext(notes=[a], vault_path=tmp_path, cache_dir=tmp_path / ".cache")
    assert ctx.ref_graph.edges["A"] == set()


def test_setup_context_ref_graph_skips_links_in_code_fences(tmp_path: Path) -> None:
    body = "```\n[[B]]\n```\n"
    a = _note("A", body)
    b = _note("B", "")
    ctx = SetupContext(notes=[a, b], vault_path=tmp_path, cache_dir=tmp_path / ".cache")
    assert ctx.ref_graph.out_neighbors("A") == set()

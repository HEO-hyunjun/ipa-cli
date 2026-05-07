"""Legacy ``ipa refactor`` entrypoint, decoupled from synthetic-argv.

S6 of the migration plan keeps the seven 1차 subcommands working by
parsing the raw argv ourselves and dispatching to the corresponding
``core.vault_refactor.cmd_*`` helper. The actual mutation logic stays
in ``core/`` until S7 — the migration matrix lives in
``docs/legacy-refactor-subcommands.md``.
"""

from __future__ import annotations

import argparse
import io
from contextlib import redirect_stdout
from pathlib import Path

from ipa_cli.core.notes_cache import scan_vault_cached
from ipa_cli.core.vault_parser import build_note_index
from ipa_cli.core.vault_refactor import (
    build_filter,
    cmd_ref_add,
    cmd_ref_remove,
    cmd_ref_replace,
    cmd_tag_add,
    cmd_tag_remove,
    cmd_tag_rename,
    cmd_wikilink_replace,
    print_results,
)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ipa refactor",
        description="Vault 구조 리팩토링 (legacy)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", help="리팩토링 명령")

    p_rr = sub.add_parser("ref-replace", help="ref 교체")
    p_rr.add_argument("old")
    p_rr.add_argument("new")

    p_tr = sub.add_parser("tag-rename", help="태그 이름 변경")
    p_tr.add_argument("old")
    p_tr.add_argument("new")

    p_td = sub.add_parser("tag-remove", help="태그 제거")
    p_td.add_argument("tag")

    p_ta = sub.add_parser("tag-add", help="태그 추가")
    p_ta.add_argument("tag")

    p_wr = sub.add_parser("wikilink-replace", help="본문 wikilink 치환")
    p_wr.add_argument("old")
    p_wr.add_argument("new")

    p_ra = sub.add_parser("ref-add", help="ref 추가")
    p_ra.add_argument("ref")

    p_rm = sub.add_parser("ref-remove", help="ref 제거")
    p_rm.add_argument("ref")

    for p in (p_rr, p_tr, p_td, p_ta, p_wr, p_ra, p_rm):
        p.add_argument("--apply", action="store_true")
        p.add_argument("--filter", dest="filter", default=None)
        p.add_argument("--scope-ref", dest="scope_ref", default=None)
        p.add_argument("--scope-tag", dest="scope_tag", default=None)
        p.add_argument(
            "--scope-type",
            dest="scope_type",
            choices=["note", "index", "root"],
            default=None,
        )
        p.add_argument("--scope-folder", dest="scope_folder", default=None)

    return parser


def render_refactor(vault_path: Path, raw_args: list[str]) -> str:
    """Parse CLI args, run the matching ``cmd_*`` and return its stdout."""
    parser = _build_parser()
    if not raw_args:
        return parser.format_help()

    args = parser.parse_args(raw_args)
    if not args.command:
        return parser.format_help()

    notes = scan_vault_cached(vault_path)
    index = build_note_index(notes)
    note_filter = build_filter(args, index, vault_path)

    if args.command == "ref-replace":
        results = cmd_ref_replace(
            notes, note_filter, vault_path, args.old, args.new, args.apply
        )
    elif args.command == "tag-rename":
        results = cmd_tag_rename(
            notes, note_filter, vault_path, args.old, args.new, args.apply
        )
    elif args.command == "tag-remove":
        results = cmd_tag_remove(notes, note_filter, vault_path, args.tag, args.apply)
    elif args.command == "tag-add":
        results = cmd_tag_add(notes, note_filter, vault_path, args.tag, args.apply)
    elif args.command == "wikilink-replace":
        results = cmd_wikilink_replace(
            notes, note_filter, vault_path, args.old, args.new, args.apply
        )
    elif args.command == "ref-add":
        results = cmd_ref_add(notes, note_filter, vault_path, args.ref, args.apply)
    elif args.command == "ref-remove":
        results = cmd_ref_remove(notes, note_filter, vault_path, args.ref, args.apply)
    else:
        return parser.format_help()

    buf = io.StringIO()
    with redirect_stdout(buf):
        print_results(results, args.apply)
    return buf.getvalue()

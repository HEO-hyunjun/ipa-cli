"""ipa CLI entrypoint.

Surface:
  - ``ipa search / view / traversal / validator / refactor`` — legacy
    surface, now routed through ``runtime/*`` modules built on the same
    parse + service layer as ``engine`` / ``convention`` / ``formatter``.
  - ``ipa convention check`` / ``ipa formatter plan/apply`` — engine-
    based vault validation/fix flow.
  - ``ipa engine search / channels`` — direct ``SearchEngine`` access.
  - ``ipa tune (run) / eval / list / use / analyze``.
  - ``ipa config show`` / ``ipa profile list / use / current``.
  - ``ipa list-channels / list-rules / list-refactors`` — builtin metadata.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import typer
from rich.console import Console
from rich.table import Table

from ipa_cli.builtins.channels.default_channels import default_channels
from ipa_cli.builtins.conventions.default_convention import default_convention
from ipa_cli.builtins.refactors import BUILTIN_REFACTORS
from ipa_cli.config import (
    Settings,
    list_profiles,
    load_settings,
    set_default_profile,
)
from ipa_cli.tune import (
    analyze_threshold,
    load_testset,
)

app = typer.Typer(
    name="ipa",
    help="IPA vault CLI — search, traversal, validator, refactor, tune.",
    no_args_is_help=True,
    rich_markup_mode="rich",
)
config_app = typer.Typer(help="설정 조회·관리.", no_args_is_help=True)
profile_app = typer.Typer(help="프로필 관리.", no_args_is_help=True)
convention_app = typer.Typer(help="convention runtime 명령.", no_args_is_help=True)
formatter_app = typer.Typer(help="formatter runtime 명령.", no_args_is_help=True)
inbox_app = typer.Typer(help="Inbox 파일 수용 명령.", no_args_is_help=True)
engine_app = typer.Typer(
    help="search runtime 명령 (channels / search).",
    no_args_is_help=True,
)
app.add_typer(config_app, name="config")
app.add_typer(profile_app, name="profile")
app.add_typer(convention_app, name="convention")
app.add_typer(formatter_app, name="formatter")
app.add_typer(inbox_app, name="inbox")
app.add_typer(engine_app, name="engine")

console = Console()


@app.callback()
def _global(
    ctx: typer.Context,
    profile: str | None = typer.Option(
        None, "--profile", help="활성 프로필 (.ipa-profile/IPA_PROFILE보다 우선)"
    ),
    vault: Path | None = typer.Option(
        None, "--vault", help="vault 경로 ad-hoc 지정 (profile 우회)"
    ),
):
    """Resolve Settings once and stash in ctx.obj for subcommands."""
    args = sys.argv[1:]
    profile_setup_cmd = (
        "profile" in args
        and len(args) > args.index("profile") + 1
        and args[args.index("profile") + 1] in {"list", "use"}
    )
    if ctx.resilient_parsing or "--help" in args or "-h" in args or profile_setup_cmd:
        return
    try:
        settings = load_settings(profile=profile, vault=vault)
    except ValueError as exc:
        raise typer.BadParameter(str(exc)) from exc
    warning = settings.source_map.get("weights.file.warning") or settings.source_map.get(
        "tune.result_file.warning"
    )
    if warning:
        console.print(f"[yellow]warning[/yellow] {warning}")
    ctx.obj = settings


def _settings(ctx: typer.Context) -> Settings:
    if not isinstance(ctx.obj, Settings):
        ctx.obj = load_settings()
    return ctx.obj


# ── legacy 명령 (runtime/* 모듈로 라우팅) ──


@app.command()
def search(
    ctx: typer.Context,
    query: list[str] = typer.Argument(None, help="검색 쿼리 (여러 개 가능)"),
    threshold: float | None = typer.Option(
        None, "--threshold", help="결과 컷오프 점수 (default: profile)"
    ),
    max_results: int | None = typer.Option(
        None, "--max", help="최대 결과 수 (default: profile)"
    ),
    show_all: bool = typer.Option(False, "--all", help="threshold/cap 무시"),
    reasons: bool = typer.Option(False, "--reasons", help="채널별 매칭 사유 표시"),
    log: bool = typer.Option(False, "--log", help="AI search event log 강제 기록"),
    actor: str | None = typer.Option(None, "--actor", help="search log actor"),
    log_context: Path | None = typer.Option(
        None, "--log-context", help="turn context JSON 파일"
    ),
):
    """통합 검색 (legacy unified_search)."""
    if not query:
        raise typer.BadParameter("검색 쿼리를 1개 이상 지정해주세요")
    from ipa_cli.runtime.mapping_loader import load_mapping
    from ipa_cli.runtime.search import render_search_results, search_hits
    from ipa_cli.runtime.search_loader import load_search_channels
    from ipa_cli.tune.search_log import (
        append_event,
        build_event,
        finalize_result_ranks,
        load_turn_context,
        should_log_search,
    )

    s = _settings(ctx)
    workspace = s.profile_dir
    workspace_arg = workspace if workspace.is_dir() else None
    mapping = load_mapping(workspace_arg)
    channels = load_search_channels(workspace_arg, vault_path=s.vault_path)
    eff_threshold = threshold if threshold is not None else s.search.threshold
    eff_max = max_results if max_results is not None else s.search.max_results
    hits, notes, cut = search_hits(
        s.vault_path,
        list(query),
        threshold=eff_threshold,
        max_results=eff_max,
        show_all=show_all,
        weights=s.search.weights,
        mapping=mapping,
        channels=channels,
        cache_dir=s.cache_dir,
    )
    if should_log_search(explicit=log):
        context = load_turn_context(actor=actor, context_path=log_context)
        try:
            event = build_event(
                settings=s,
                queries=list(query),
                threshold=eff_threshold,
                max_results=eff_max,
                show_all=show_all,
                reasons=reasons,
                hits=hits,
                notes=notes,
                cut_count=cut,
                actor=actor,
                context=context,
            )
            append_event(s.vault_path, finalize_result_ranks(event))
        except Exception:
            # Logging is best-effort; search output must not break.
            pass
    output = render_search_results(
        list(query),
        hits,
        notes,
        cut,
        threshold=eff_threshold,
        show_all=show_all,
        reasons=reasons,
        mapping=mapping,
    )
    typer.echo(output)


@app.command()
def view(
    ctx: typer.Context,
    note: str = typer.Argument(..., help="노트명"),
    section: str | None = typer.Option(None, "--section", help="특정 섹션만"),
    full: bool = typer.Option(False, "--full", help="전체 본문"),
):
    """노트 보기."""
    from ipa_cli.runtime.view import render_view

    s = _settings(ctx)
    output = render_view(s.vault_path, note=note, section=section, full=full)
    typer.echo(output)


@app.command()
def traversal(
    ctx: typer.Context,
    up: str | None = typer.Option(None, "--up", help="상향 탐색"),
    down: str | None = typer.Option(None, "--down", help="하향 탐색"),
    siblings: str | None = typer.Option(None, "--siblings", help="형제 노트"),
    root: str | None = typer.Option(None, "--root", help="소속 root"),
):
    """계층 탐색."""
    if not any([up, down, siblings, root]):
        raise typer.BadParameter("--up/--down/--siblings/--root 중 하나를 지정해주세요")
    from ipa_cli.runtime.traversal import render_traversal

    s = _settings(ctx)
    output = render_traversal(
        s.vault_path, up=up, down=down, siblings=siblings, root=root
    )
    typer.echo(output)


@app.command()
def validator(
    ctx: typer.Context,
    note: str | None = typer.Option(None, "--note", help="단일 노트 검증"),
    select: str | None = typer.Option(None, "--select", help="카테고리/룰 선택"),
    ignore: str | None = typer.Option(None, "--ignore", help="룰 무시"),
    fix: bool = typer.Option(False, "--fix", help="자동 수정"),
    dry_run: bool = typer.Option(False, "--dry-run", help="수정 미리보기"),
):
    """vault 구조 검증 (legacy)."""
    from ipa_cli.runtime.legacy_validator_view import render_validator

    s = _settings(ctx)
    output = render_validator(
        s.vault_path,
        note=note,
        select=select,
        ignore=ignore,
        fix=fix,
        dry_run=dry_run,
    )
    typer.echo(output)


@app.command(
    context_settings={"allow_extra_args": True, "ignore_unknown_options": True}
)
def refactor(ctx: typer.Context):
    """vault 일괄 수정 (legacy; 모든 인자를 새 dispatcher에 전달)."""
    from ipa_cli.runtime.refactor import render_refactor

    s = _settings(ctx)
    output = render_refactor(s.vault_path, list(ctx.args))
    typer.echo(output, nl=False)


# ── config / profile ──


@config_app.command("show")
def config_show(
    ctx: typer.Context,
    source: bool = typer.Option(
        False, "--source", help="각 값의 출처(default/yaml/env/cli) 표시"
    ),
):
    """현재 적용 config 출력."""
    s = _settings(ctx)
    table = Table(title=f"ipa config (profile: {s.profile})")
    table.add_column("key", style="cyan")
    table.add_column("value", style="white")
    if source:
        table.add_column("source", style="dim")

    rows: list[tuple[str, str]] = [
        ("profile", s.profile),
        ("profile_dir", str(s.profile_dir)),
        ("profile_config", str(s.config_path)),
        (
            "vault_config",
            str(s.vault_config_path) if s.vault_config_path != Path() else "(unset)",
        ),
        ("vault_path", str(s.vault_path) if s.vault_path != Path() else "(unset)"),
        ("cache_dir", str(s.cache_dir)),
        ("test.file", str(s.testset_path) if s.testset_path is not None else "(unset)"),
        (
            "weights.file",
            str(s.weight_result_path)
            if s.weight_result_path is not None
            else "(unset)",
        ),
        ("search.threshold", str(s.search.threshold)),
        ("search.max_results", str(s.search.max_results)),
    ]
    for name, weight in s.search.weights.items():
        rows.append((f"search.weights.{name}", f"{weight:.4f}"))

    for key, value in rows:
        if source:
            table.add_row(key, value, s.source_map.get(key, "default"))
        else:
            table.add_row(key, value)
    console.print(table)


@profile_app.command("list")
def profile_list(ctx: typer.Context):
    """전역 profile.yaml에 등록된 profile 목록."""
    names, active = list_profiles()
    if not names:
        console.print("[yellow]No profiles found in[/yellow] ~/.config/ipa/profile.yaml")
        return
    table = Table(title="ipa profiles")
    table.add_column("name", style="cyan")
    table.add_column("active", style="green")
    for name in names:
        table.add_row(name, "✓" if name == active else "")
    console.print(table)


@profile_app.command("current")
def profile_current(ctx: typer.Context):
    """현재 활성 프로필과 vault 경로 출력."""
    s = _settings(ctx)
    vault_path = str(s.vault_path) if s.vault_path != Path() else "(unset)"
    typer.echo(f"profile: {s.profile}")
    typer.echo(f"vault_path: {vault_path}")


@profile_app.command("use")
def profile_use(ctx: typer.Context, name: str = typer.Argument(...)):
    """전역 profile.yaml에서 default profile을 선택."""
    set_default_profile(name)
    console.print(f"default profile → [cyan]{name}[/cyan]")


# ── convention runtime ──


@convention_app.command("check")
def convention_check(
    ctx: typer.Context,
    note: str | None = typer.Option(
        None, "--note", help="단일 노트 ID(파일 stem) 검사"
    ),
    scope: str = typer.Option(
        "note",
        "--scope",
        help="실행 단위: note | folder | vault. 더 넓은 scope rule은 opt-in 시에만 실행.",
    ),
    folder: Path | None = typer.Option(
        None, "--folder", help="--scope folder 시 대상 폴더 (vault 상대/절대 경로)"
    ),
    all_: bool = typer.Option(False, "--all", help="--scope vault의 별칭"),
    summary: bool = typer.Option(
        False, "--summary", help="이슈 본문 대신 코드·severity별 개수 요약"
    ),
):
    """활성 프로필의 mapping/convention으로 vault를 검증한다."""
    from ipa_cli.api.base_rules import Severity
    from ipa_cli.parse.vault_loader import load_notes
    from ipa_cli.runtime.convention_loader import load_convention
    from ipa_cli.runtime.mapping_loader import load_mapping
    from ipa_cli.runtime.validator_engine import run_validator, scope_allows_rule

    if all_:
        scope = "vault"
    if scope not in {"note", "folder", "vault"}:
        raise typer.BadParameter(f"--scope must be note|folder|vault, got {scope!r}")
    if scope == "folder" and folder is None:
        raise typer.BadParameter("--scope folder는 --folder PATH 가 필요합니다")

    s = _settings(ctx)
    if s.vault_path == Path():
        console.print(
            "[red]vault_path 미설정. profile.yaml 또는 IPA_VAULT_PATH로 지정하세요.[/red]"
        )
        raise typer.Exit(2)

    workspace = s.profile_dir
    workspace_arg = workspace if workspace.is_dir() else None

    mapping = load_mapping(workspace_arg)
    convention = load_convention(
        workspace_arg,
        vault_path=s.vault_path,
        surface="convention",
    )
    notes = load_notes(s.vault_path, mapping)

    folder_resolved: Path | None = None
    if folder is not None:
        folder_resolved = (
            folder if folder.is_absolute() else (s.vault_path / folder)
        ).resolve()

    issues = run_validator(
        notes,
        mapping,
        convention,
        vault_path=s.vault_path,
        scope=scope,  # type: ignore[arg-type]
        folder=folder_resolved,
        target_note_id=note,
    )

    skipped = [
        r
        for r in convention.rules
        if not scope_allows_rule(scope, r.default_scope)  # type: ignore[arg-type]
    ]

    console.print(
        f"[bold]profile[/bold] {s.profile}  "
        f"[bold]convention[/bold] {convention.name}  "
        f"[bold]rules[/bold] {len(convention.rules)} (scoped-out: {len(skipped)})  "
        f"[bold]notes[/bold] {len(notes)}  "
        f"[bold]scope[/bold] {scope}"
    )

    if summary:
        agg: dict[tuple[str, str], int] = {}
        for issue in issues:
            key = (issue.code, issue.severity.value)
            agg[key] = agg.get(key, 0) + 1
        table = Table(title=f"summary ({len(issues)} issues)")
        table.add_column("code", style="cyan")
        table.add_column("severity", style="magenta")
        table.add_column("count", style="white", justify="right")
        for (code, sev), count in sorted(agg.items()):
            table.add_row(code, sev, str(count))
        console.print(table)
    else:
        if not issues:
            console.print("[green]no issues[/green]")
        else:
            for issue in issues:
                color = {
                    Severity.INFO: "blue",
                    Severity.WARN: "yellow",
                    Severity.ERROR: "red",
                }.get(issue.severity, "white")
                console.print(
                    f"  [{color}]{issue.severity.value:5s}[/{color}] "
                    f"[cyan]{issue.code}[/cyan]  "
                    f"{issue.note_id}  "
                    f"{issue.message}"
                )
            console.print(f"\nfound {len(issues)} issues")

    has_error = any(i.severity == Severity.ERROR for i in issues)
    raise typer.Exit(1 if has_error else 0)


# ── formatter runtime ──


def _resolve_formatter_inputs(
    ctx: typer.Context,
    *,
    scope: str,
    folder: Path | None,
    all_: bool,
    note: str | None,
):
    """Shared loader: settings, mapping, convention, notes, validator issues."""
    from ipa_cli.parse.vault_loader import load_notes
    from ipa_cli.runtime.convention_loader import load_convention
    from ipa_cli.runtime.mapping_loader import load_mapping
    from ipa_cli.runtime.validator_engine import run_validator

    if all_:
        scope = "vault"
    if scope not in {"note", "folder", "vault"}:
        raise typer.BadParameter(f"--scope must be note|folder|vault, got {scope!r}")
    if scope == "folder" and folder is None:
        raise typer.BadParameter("--scope folder는 --folder PATH 가 필요합니다")

    s = _settings(ctx)
    if s.vault_path == Path():
        console.print(
            "[red]vault_path 미설정. profile.yaml 또는 IPA_VAULT_PATH로 지정하세요.[/red]"
        )
        raise typer.Exit(2)

    workspace = s.profile_dir
    workspace_arg = workspace if workspace.is_dir() else None
    mapping = load_mapping(workspace_arg)
    convention = load_convention(
        workspace_arg,
        vault_path=s.vault_path,
        surface="formatter",
    )
    notes = load_notes(s.vault_path, mapping)

    folder_resolved: Path | None = None
    if folder is not None:
        folder_resolved = (
            folder if folder.is_absolute() else (s.vault_path / folder)
        ).resolve()

    issues = run_validator(
        notes,
        mapping,
        convention,
        vault_path=s.vault_path,
        scope=scope,  # type: ignore[arg-type]
        folder=folder_resolved,
        target_note_id=note,
    )
    return s, mapping, convention, notes, issues


@formatter_app.command("plan")
def formatter_plan(
    ctx: typer.Context,
    note: str | None = typer.Option(None, "--note", help="단일 노트 ID 검사"),
    scope: str = typer.Option("note", "--scope", help="note | folder | vault"),
    folder: Path | None = typer.Option(None, "--folder", help="--scope folder 시 대상"),
    all_: bool = typer.Option(False, "--all", help="--scope vault 별칭"),
    summary: bool = typer.Option(False, "--summary", help="개수 요약"),
):
    """변경 계획 미리보기 (적용 안 함). conflict는 plan 단계에서 보고."""
    from ipa_cli.runtime.formatter_engine import plan as run_plan

    s, mapping, convention, notes, issues = _resolve_formatter_inputs(
        ctx, scope=scope, folder=folder, all_=all_, note=note
    )
    plan_result = run_plan(issues, convention, mapping, notes, s.vault_path)
    _render_plan(plan_result, summary=summary, header_extra=f"profile {s.profile}")


@formatter_app.command("apply")
def formatter_apply(
    ctx: typer.Context,
    note: str | None = typer.Option(None, "--note", help="단일 노트 ID 적용"),
    scope: str = typer.Option("note", "--scope", help="note | folder | vault"),
    folder: Path | None = typer.Option(None, "--folder", help="--scope folder 시 대상"),
    all_: bool = typer.Option(False, "--all", help="--scope vault 별칭"),
    summary: bool = typer.Option(False, "--summary", help="개수 요약"),
):
    """변경을 디스크에 적용. conflict patch는 자동 제외 (먼저 plan 보세요)."""
    from ipa_cli.runtime.formatter_engine import apply as run_apply
    from ipa_cli.runtime.formatter_engine import plan as run_plan

    s, mapping, convention, notes, issues = _resolve_formatter_inputs(
        ctx, scope=scope, folder=folder, all_=all_, note=note
    )
    plan_result = run_plan(issues, convention, mapping, notes, s.vault_path)
    if plan_result.total_patches == 0 and plan_result.total_conflicts == 0:
        console.print("[green]no patches to apply[/green]")
        raise typer.Exit(0)

    _render_plan(plan_result, summary=summary, header_extra=f"apply on {s.profile}")
    apply_result = run_apply(plan_result)

    console.print(
        f"\n[bold]applied[/bold] {len(apply_result.updated_notes)} note(s); "
        f"errors {len(apply_result.errors)}"
    )
    for note_id, msg in apply_result.errors:
        console.print(f"  [red]error[/red] {note_id}: {msg}")
    raise typer.Exit(1 if apply_result.errors else 0)


def _render_plan(plan_result, *, summary: bool, header_extra: str) -> None:
    console.print(
        f"[bold]{header_extra}[/bold]  "
        f"[bold]patches[/bold] {plan_result.total_patches}  "
        f"[bold]conflicts[/bold] {plan_result.total_conflicts}  "
        f"[bold]notes[/bold] {len(plan_result.plans_by_note)}"
    )

    if summary:
        if plan_result.total_patches == 0 and plan_result.total_conflicts == 0:
            console.print("[green]no changes planned[/green]")
            return
        table = Table(title="patch summary by note")
        table.add_column("note", style="cyan")
        table.add_column("patches", justify="right")
        table.add_column("conflicts", justify="right", style="red")
        for np in plan_result.plans_by_note.values():
            table.add_row(np.note_id, str(len(np.patches)), str(len(np.conflicts)))
        console.print(table)
        return

    if not plan_result.plans_by_note:
        console.print("[green]no changes planned[/green]")
        return

    for np in plan_result.plans_by_note.values():
        console.print(f"\n[cyan]{np.note_id}[/cyan]  ({np.path})")
        for patch in np.patches:
            span = patch.span
            console.print(
                f"  [green]+[/green] L{span.start_line}:{span.start_col}-{span.end_col}  "
                f"→ {patch.replacement!r}"
            )
        for a, b in np.conflicts:
            console.print(
                f"  [red]conflict[/red] L{a.span.start_line} "
                f"({a.replacement!r} ⨯ {b.replacement!r})"
            )


# ── inbox intake ──


def _run_inbox_add(
    ctx: typer.Context,
    file: Path,
    *,
    title: str | None,
    refs: list[str] | None,
    tags: list[str] | None,
    dry_run: bool,
) -> None:
    from ipa_cli.runtime.inbox import InboxAddError, add_file_to_inbox

    s = _settings(ctx)
    try:
        result = add_file_to_inbox(
            file,
            vault_path=s.vault_path,
            title=title,
            refs=refs or [],
            tags=tags or [],
            dry_run=dry_run,
        )
    except InboxAddError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1) from exc
    rel = result.destination.relative_to(s.vault_path.expanduser().resolve())
    console.print(f"[green]inbox[/green] {rel}")
    if dry_run:
        console.print(result.rendered)


@inbox_app.command("add")
def inbox_add(
    ctx: typer.Context,
    file: Path = typer.Argument(..., help="Inbox로 이동할 파일"),
    title: str | None = typer.Option(None, "--title", help="대상 노트 제목"),
    refs: list[str] | None = typer.Option(None, "--ref", help="ref wikilink 대상"),
    tags: list[str] | None = typer.Option(None, "--tag", help="추가 tag"),
    dry_run: bool = typer.Option(False, "--dry-run", help="쓰기 없이 결과 미리보기"),
):
    """파일을 IPA Inbox 노트 형식으로 포맷한 뒤 00 Inbox로 이동."""
    _run_inbox_add(ctx, file, title=title, refs=refs, tags=tags, dry_run=dry_run)


@app.command("add")
def add_alias(
    ctx: typer.Context,
    file: Path = typer.Argument(..., help="Inbox로 이동할 파일"),
    title: str | None = typer.Option(None, "--title", help="대상 노트 제목"),
    refs: list[str] | None = typer.Option(None, "--ref", help="ref wikilink 대상"),
    tags: list[str] | None = typer.Option(None, "--tag", help="추가 tag"),
    dry_run: bool = typer.Option(False, "--dry-run", help="쓰기 없이 결과 미리보기"),
):
    """`ipa inbox add`의 전역 agent-friendly alias."""
    _run_inbox_add(ctx, file, title=title, refs=refs, tags=tags, dry_run=dry_run)


# ── search runtime ──


def _build_engine(ctx: typer.Context):
    """Resolve settings → SearchEngine over the active profile's channels."""
    from ipa_cli.api.base_channels import SetupContext
    from ipa_cli.parse.vault_loader import load_notes
    from ipa_cli.runtime.mapping_loader import load_mapping
    from ipa_cli.runtime.search_engine import SearchEngine
    from ipa_cli.runtime.search_loader import load_search_channels

    s = _settings(ctx)
    if s.vault_path == Path():
        console.print(
            "[red]vault_path 미설정. profile.yaml 또는 IPA_VAULT_PATH로 지정하세요.[/red]"
        )
        raise typer.Exit(2)

    workspace = s.profile_dir
    workspace_arg = workspace if workspace.is_dir() else None
    mapping = load_mapping(workspace_arg)
    channels = load_search_channels(workspace_arg, vault_path=s.vault_path)
    notes = load_notes(s.vault_path, mapping)

    ctx_obj = SetupContext(
        notes=notes,
        vault_path=s.vault_path,
        cache_dir=s.cache_dir,
        mapping=mapping,
    )
    return s, channels, SearchEngine(channels, ctx_obj), notes


@engine_app.command("channels")
def engine_channels(ctx: typer.Context):
    """search engine에 등록된 채널 목록 (기본 weight + 활성 weight)."""
    from ipa_cli.runtime.search_loader import load_search_channels

    s = _settings(ctx)
    workspace_arg = s.profile_dir if s.profile_dir.is_dir() else None
    channels = load_search_channels(workspace_arg, vault_path=s.vault_path)

    table = Table(title=f"engine channels ({len(channels)} loaded)")
    table.add_column("name", style="cyan")
    table.add_column("default", style="dim", justify="right")
    table.add_column("active", style="magenta", justify="right")
    table.add_column("description", style="white")
    for ch in channels:
        active = s.search.weights.get(ch.name, ch.default_weight)
        table.add_row(
            ch.name,
            f"{ch.default_weight:.4f}",
            f"{active:.4f}",
            ch.description,
        )
    console.print(table)


def _parse_weight_overrides(items: list[str] | None) -> dict[str, float]:
    out: dict[str, float] = {}
    for raw in items or []:
        if "=" not in raw:
            raise typer.BadParameter(f"--weight 형식: name=value (got {raw!r})")
        k, v = raw.split("=", 1)
        out[k.strip()] = float(v)
    return out


@engine_app.command("search")
def engine_search(
    ctx: typer.Context,
    query: str = typer.Argument(..., help="검색 쿼리"),
    only: str | None = typer.Option(
        None, "--only", help="실행할 채널 화이트리스트 (콤마 구분)"
    ),
    weight: list[str] | None = typer.Option(
        None, "--weight", help="채널 weight 임시 override (예: --weight body_match=0.5)"
    ),
    explain: bool = typer.Option(False, "--explain", help="결과별 채널 raw 점수 표시"),
    threshold: float | None = typer.Option(
        None, "--threshold", help="결과 컷오프 점수 (default: active profile)"
    ),
    max_results: int | None = typer.Option(
        None, "--max", help="결과 cap (default: active profile)"
    ),
):
    """SearchEngine으로 vault 검색 (channel weights + threshold + cap)."""
    from ipa_cli.api.base_channels import Query

    s, channels, engine, notes = _build_engine(ctx)

    if only:
        keep = {x.strip() for x in only.split(",") if x.strip()}
        engine.channels = [c for c in engine.channels if c.name in keep]
        if not engine.channels:
            raise typer.BadParameter(f"--only={only}: 일치하는 채널 없음")

    weights = s.search.weights or {}
    weights = {**weights, **_parse_weight_overrides(weight)}

    hits = engine.search(
        Query(raw=query),
        weights=weights or None,
        threshold=s.search.threshold if threshold is None else threshold,
        cap=s.search.max_results if max_results is None else max_results,
    )

    # Persist any AST tokens built this run so subsequent invocations
    # skip parsing for unchanged notes. Best-effort — failures are ignored.
    try:
        engine.persist_parsed_cache()
    except Exception:
        pass

    console.print(
        f"[bold]profile[/bold] {s.profile}  "
        f"[bold]channels[/bold] {len(engine.channels)}  "
        f"[bold]notes[/bold] {len(notes)}  "
        f"[bold]hits[/bold] {len(hits)}"
    )
    if not hits:
        console.print("[yellow]no hits[/yellow]")
        raise typer.Exit(0)

    for h in hits:
        console.print(f"  [{h.score:.4f}] [cyan]{h.note_id}[/cyan]")
        if explain and h.explanations:
            for ch_name, payload in sorted(h.explanations.items()):
                console.print(
                    f"      [dim]{ch_name}[/dim] raw={payload.get('raw', 0.0):.4f}"
                )


# ── builtin metadata 조회 ──


@app.command("list-channels")
def list_channels(ctx: typer.Context):
    """builtin search 채널 목록 (default_channels()에서 가져옴)."""
    s = _settings(ctx)
    channels = default_channels()
    table = Table(title=f"search channels ({len(channels)} registered)")
    table.add_column("name", style="cyan")
    table.add_column("weight", style="magenta", justify="right")
    table.add_column("active", style="green", justify="right")
    table.add_column("description", style="white")
    for ch in channels:
        active = s.search.weights.get(ch.name, ch.default_weight)
        table.add_row(
            ch.name,
            f"{ch.default_weight:.4f}",
            f"{active:.4f}",
            ch.description,
        )
    console.print(table)


@app.command("list-rules")
def list_rules():
    """builtin convention 룰 목록 (default_convention().rules)."""
    convention = default_convention()
    rules = convention.rules
    table = Table(title=f"validator rules ({len(rules)} registered)")
    table.add_column("code", style="cyan")
    table.add_column("category", style="magenta")
    table.add_column("severity", style="yellow")
    table.add_column("scope", style="white")
    for r in rules:
        # ipa.<category>.<rest> → category 추출. 다른 prefix는 통째로 표기.
        parts = r.code.split(".", 2)
        category = parts[1] if len(parts) >= 3 and parts[0] == "ipa" else "—"
        table.add_row(
            r.code,
            category,
            str(r.severity.value),
            r.default_scope,
        )
    console.print(table)


@app.command("list-refactors")
def list_refactors():
    """builtin refactor recipe 메타데이터 (S6에서 실제 호출 가능)."""
    table = Table(title=f"refactor commands ({len(BUILTIN_REFACTORS)} registered)")
    table.add_column("name", style="cyan")
    table.add_column("description", style="white")
    for cmd in BUILTIN_REFACTORS:
        table.add_row(cmd.name, cmd.description)
    console.print(table)


# ── tune ──


tune_app = typer.Typer(
    help="Optuna 튜닝 (weight + threshold + cap) 및 분포 진단.",
    invoke_without_command=True,
    no_args_is_help=False,
)
log_app = typer.Typer(help="AI search event log 조회·샘플링.", no_args_is_help=True)
pack_app = typer.Typer(help="golden query pack 관리.", no_args_is_help=True)
testset_app = typer.Typer(help="log 기반 testset draft 관리.", no_args_is_help=True)
app.add_typer(tune_app, name="tune")
tune_app.add_typer(log_app, name="log")
tune_app.add_typer(pack_app, name="pack")
tune_app.add_typer(testset_app, name="testset")


def _parse_fixed(items: list[str] | None) -> dict[str, float]:
    out: dict[str, float] = {}
    for raw in items or []:
        if "=" not in raw:
            raise typer.BadParameter(f"--fix 형식: name=value (got '{raw}')")
        k, v = raw.split("=", 1)
        out[k.strip()] = float(v)
    return out


def _parse_only(value: str | None) -> list[str] | None:
    if not value:
        return None
    return [s.strip() for s in value.split(",") if s.strip()]


def _event_created(event: dict[str, Any]) -> str:
    return str(event.get("created_at") or "")


def _target_rank(results: list[dict[str, Any]], target: str) -> int | None:
    target_cf = target.casefold()
    for idx, item in enumerate(results, start=1):
        title = str(item.get("title") or "")
        note = str(item.get("note") or "")
        if title.casefold() == target_cf or Path(note).stem.casefold() == target_cf:
            return idx
    return None


@log_app.command("list")
def tune_log_list(ctx: typer.Context, since: str | None = typer.Option(None, "--since")):
    """Search event log 목록."""
    from ipa_cli.tune.search_log import read_events

    s = _settings(ctx)
    events = read_events(s.vault_path)
    table = Table(title=f"search events ({len(events)})")
    table.add_column("event", style="cyan")
    table.add_column("created", style="dim")
    table.add_column("actor", style="magenta")
    table.add_column("query", style="white")
    for event in sorted(events, key=_event_created, reverse=True):
        table.add_row(
            str(event.get("event_id") or ""),
            str(event.get("created_at") or ""),
            str(event.get("actor") or ""),
            str(event.get("agent_search_query") or ""),
        )
    console.print(table)


@log_app.command("show")
def tune_log_show(
    ctx: typer.Context,
    event_id: str = typer.Argument(...),
    format_: str = typer.Option("markdown", "--format", help="markdown | json"),
):
    """Search event 상세 출력."""
    from ipa_cli.tune.search_log import event_to_markdown, find_event

    s = _settings(ctx)
    try:
        event = find_event(s.vault_path, event_id)
    except KeyError as exc:
        raise typer.BadParameter(f"unknown event: {event_id}") from exc
    if format_ == "json":
        typer.echo(__import__("json").dumps(event, ensure_ascii=False, indent=2))
    else:
        typer.echo(event_to_markdown(event))


@log_app.command("sample")
def tune_log_sample(
    ctx: typer.Context,
    limit: int = typer.Option(20, "--limit"),
    strategy: str = typer.Option("diverse", "--strategy"),
    format_: str = typer.Option("markdown", "--format", help="markdown | json"),
):
    """라벨링 후보 search event를 샘플링."""
    import json

    from ipa_cli.tune.search_log import event_to_markdown, read_events, sample_events

    s = _settings(ctx)
    events = sample_events(read_events(s.vault_path), strategy=strategy, limit=limit)
    if format_ == "json":
        typer.echo(json.dumps(events, ensure_ascii=False, indent=2))
        return
    typer.echo("\n\n".join(event_to_markdown(event) for event in events))


@log_app.command("prune")
def tune_log_prune(
    ctx: typer.Context,
    older_than: str = typer.Option(..., "--older-than", help="예: 30d, 12h"),
    dry_run: bool = typer.Option(False, "--dry-run"),
):
    """오래된 search event 삭제."""
    from ipa_cli.tune.search_log import prune_events, read_events, write_events

    s = _settings(ctx)
    events = read_events(s.vault_path)
    kept, removed = prune_events(events, older_than=older_than)
    if dry_run:
        console.print(f"[yellow]would prune[/yellow] {len(removed)} event(s)")
        for event in removed:
            console.print(f"  {event.get('event_id')}")
        return
    write_events(s.vault_path, kept)
    console.print(f"[green]pruned[/green] {len(removed)} event(s)")


@log_app.command("redact")
def tune_log_redact(
    ctx: typer.Context,
    field: str = typer.Option(..., "--field", help="redact할 필드명"),
    older_than: str = typer.Option(..., "--older-than", help="예: 14d"),
    dry_run: bool = typer.Option(False, "--dry-run"),
):
    """오래된 event의 민감 필드 제거."""
    from ipa_cli.tune.search_log import prune_events, read_events, write_events

    s = _settings(ctx)
    events = read_events(s.vault_path)
    kept, targets = prune_events(events, older_than=older_than)
    redacted = []
    for event in targets:
        event = dict(event)
        event[field] = None
        redacted.append(event)
    if dry_run:
        console.print(f"[yellow]would redact[/yellow] {len(redacted)} event(s)")
        return
    write_events(s.vault_path, kept + redacted)
    console.print(f"[green]redacted[/green] {len(redacted)} event(s)")


@log_app.command("compact")
def tune_log_compact(
    ctx: typer.Context,
    before: str = typer.Option(..., "--before", help="YYYY-MM-DD"),
    dry_run: bool = typer.Option(False, "--dry-run"),
):
    """오래된 event의 result 상세를 줄인다."""
    from datetime import datetime, timezone

    from ipa_cli.tune.search_log import read_events, write_events

    cutoff = datetime.fromisoformat(before).replace(tzinfo=timezone.utc)
    s = _settings(ctx)
    changed = 0
    events = read_events(s.vault_path)
    for event in events:
        created_raw = str(event.get("created_at") or "")
        try:
            created = datetime.fromisoformat(created_raw.replace("Z", "+00:00"))
        except ValueError:
            continue
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if created < cutoff and event.get("results"):
            event["results"] = event["results"][:3]
            event["compacted"] = True
            changed += 1
    if dry_run:
        console.print(f"[yellow]would compact[/yellow] {changed} event(s)")
        return
    write_events(s.vault_path, events)
    console.print(f"[green]compacted[/green] {changed} event(s)")


@tune_app.command("replay")
def tune_replay(
    ctx: typer.Context,
    event_id: str = typer.Argument(...),
    weights_path: Path | None = typer.Option(None, "--weights"),
):
    """과거 search event를 현재 engine/weight로 재실행."""
    from ipa_cli.api.base_channels import Query
    from ipa_cli.tune.search_log import find_event

    s, _channels, engine, _notes = _build_engine(ctx)
    try:
        event = find_event(s.vault_path, event_id)
    except KeyError as exc:
        raise typer.BadParameter(f"unknown event: {event_id}") from exc
    query = str(event.get("agent_search_query") or "")
    weights = dict(s.search.weights)
    if weights_path is not None:
        import json

        payload = json.loads(weights_path.read_text(encoding="utf-8"))
        weights.update(payload.get("weights") or {})
    hits = engine.search(
        Query(raw=query),
        weights=weights,
        threshold=s.search.threshold,
        cap=s.search.max_results,
    )
    previous = event.get("results") or []
    target = str(previous[0].get("title") if previous else "")
    current_results = [
        {"title": h.note_id, "total_score": h.score, "rank": idx}
        for idx, h in enumerate(hits, start=1)
    ]
    rank = _target_rank(current_results, target) if target else None
    console.print(f"[bold]event[/bold] {event_id}")
    console.print(f"[bold]query[/bold] {query}")
    console.print(f"[bold]target[/bold] {target or '(none)'}")
    console.print(f"[bold]current rank[/bold] {rank if rank is not None else 'MISS'}")
    for idx, hit in enumerate(hits[:5], start=1):
        console.print(f"  {idx}. {hit.note_id} ({hit.score:.4f})")


@tune_app.command("label")
def tune_label(
    ctx: typer.Context,
    event_id: str = typer.Argument(...),
    target: str | None = typer.Option(None, "--target"),
    failure_type: str | None = typer.Option(None, "--failure-type"),
    reject: bool = typer.Option(False, "--reject"),
    reason: str | None = typer.Option(None, "--reason"),
):
    """Search event에 사람이 라벨을 달아 draft JSONL에 누적."""
    import json

    from ipa_cli.tune.search_log import drafts_dir, find_event

    s = _settings(ctx)
    event = find_event(s.vault_path, event_id)
    path = drafts_dir(s.vault_path) / "latest.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "source_event_id": event_id,
        "user_query": event.get("user_query"),
        "agent_search_query": event.get("agent_search_query"),
        "target_filename": target,
        "failure_type": failure_type,
        "rejected": reject,
        "reason": reason,
    }
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    console.print(f"[green]labeled[/green] {event_id} -> {path}")


@testset_app.command("draft")
def tune_testset_draft(
    ctx: typer.Context,
    from_log: bool = typer.Option(False, "--from-log"),
    strategy: str = typer.Option("low-confidence", "--strategy"),
    limit: int = typer.Option(30, "--limit"),
):
    """Search log에서 draft 후보 JSONL을 생성."""
    import json

    from ipa_cli.tune.search_log import drafts_dir, read_events, sample_events

    if not from_log:
        raise typer.BadParameter("--from-log is required")
    s = _settings(ctx)
    events = sample_events(read_events(s.vault_path), strategy=strategy, limit=limit)
    path = drafts_dir(s.vault_path) / "latest.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for event in events:
            record = {
                "source_event_id": event.get("event_id"),
                "user_query": event.get("user_query"),
                "agent_search_query": event.get("agent_search_query"),
                "target_filename": None,
            }
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    console.print(f"[green]draft[/green] {len(events)} case(s) -> {path}")


@testset_app.command("add")
def tune_testset_add(
    ctx: typer.Context,
    event: str = typer.Option(..., "--event"),
    target: str = typer.Option(..., "--target"),
):
    """단일 event를 draft case로 추가."""
    tune_label(ctx, event, target=target, failure_type=None, reject=False, reason=None)


@testset_app.command("export")
def tune_testset_export(
    ctx: typer.Context,
    draft: str = typer.Option("latest", "--draft"),
    target: Path | None = typer.Option(None, "--target"),
):
    """Draft JSONL을 ipa tune eval testset JSON으로 export."""
    import json

    from ipa_cli.tune.search_log import drafts_dir

    s = _settings(ctx)
    draft_path = drafts_dir(s.vault_path) / (draft if draft.endswith(".jsonl") else f"{draft}.jsonl")
    if target is None:
        target = s.vault_path / ".ipa" / "tune" / "testsets" / "testset.json"
    elif not target.is_absolute():
        target = s.vault_path / target
    cases = []
    for line in draft_path.read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        if record.get("rejected") or not record.get("target_filename"):
            continue
        cases.append(
            {
                "id": record.get("source_event_id"),
                "queries": [record.get("agent_search_query")],
                "target_filename": record.get("target_filename"),
                "source_event_id": record.get("source_event_id"),
                "user_query": record.get("user_query"),
            }
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"version": "v1", "cases": cases}, ensure_ascii=False, indent=2), encoding="utf-8")
    console.print(f"[green]exported[/green] {len(cases)} case(s) -> {target}")


def _pack_path(vault_path: Path, name: str) -> Path:
    from ipa_cli.tune.search_log import querypack_dir

    filename = name if name.endswith(".json") else f"{name}.json"
    return querypack_dir(vault_path) / filename


def _read_pack(vault_path: Path, name: str) -> dict[str, Any]:
    import json

    path = _pack_path(vault_path, name)
    return json.loads(path.read_text(encoding="utf-8"))


def _write_pack(vault_path: Path, name: str, payload: dict[str, Any]) -> Path:
    import json

    path = _pack_path(vault_path, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


@pack_app.command("list")
def tune_pack_list(ctx: typer.Context):
    """Golden query pack 목록."""
    from ipa_cli.tune.search_log import querypack_dir

    s = _settings(ctx)
    root = querypack_dir(s.vault_path)
    for path in sorted(root.glob("*.json")) if root.is_dir() else []:
        console.print(path.name)


@pack_app.command("create")
def tune_pack_create(
    ctx: typer.Context,
    name: str = typer.Argument(...),
    description: str = typer.Option("", "--description"),
):
    """빈 golden query pack 생성."""
    s = _settings(ctx)
    payload = {
        "schema_version": 1,
        "name": name,
        "description": description,
        "cases": [],
    }
    path = _write_pack(s.vault_path, name, payload)
    console.print(f"[green]created[/green] {path}")


@pack_app.command("add")
def tune_pack_add(
    ctx: typer.Context,
    name: str = typer.Argument(...),
    event_id: str = typer.Option(..., "--event"),
    target: str = typer.Option(..., "--target"),
    top_k: int = typer.Option(5, "--top-k"),
):
    """Search event를 golden query pack case로 추가."""
    from ipa_cli.tune.search_log import find_event

    s = _settings(ctx)
    pack = _read_pack(s.vault_path, name)
    event = find_event(s.vault_path, event_id)
    cases = pack.setdefault("cases", [])
    case_id = f"{name}-{len(cases) + 1:03d}"
    cases.append(
        {
            "id": case_id,
            "user_query": event.get("user_query"),
            "agent_search_query": event.get("agent_search_query"),
            "target": target,
            "expect": {"top_k": top_k},
            "source_event_id": event_id,
        }
    )
    path = _write_pack(s.vault_path, name, pack)
    console.print(f"[green]added[/green] {case_id} -> {path}")


@pack_app.command("eval")
def tune_pack_eval(ctx: typer.Context, name: str = typer.Argument(...)):
    """Golden query pack을 현재 search engine으로 평가."""
    from ipa_cli.api.base_channels import Query

    s, _channels, engine, _notes = _build_engine(ctx)
    pack = _read_pack(s.vault_path, name)
    cases = pack.get("cases") or []
    passed = 0
    for case in cases:
        query = str(case.get("agent_search_query") or "")
        top_k = int((case.get("expect") or {}).get("top_k") or 5)
        target = str(case.get("target") or "")
        hits = engine.search(
            Query(raw=query),
            weights=dict(s.search.weights),
            threshold=s.search.threshold,
            cap=max(s.search.max_results, top_k),
        )[:top_k]
        if any(hit.note_id.casefold() == target.casefold() for hit in hits):
            passed += 1
    console.print(f"[bold]pack[/bold] {name}  [bold]pass[/bold] {passed}/{len(cases)}")


@pack_app.command("promote")
def tune_pack_promote(
    ctx: typer.Context,
    draft: str = typer.Option("latest", "--draft"),
    pack: str = typer.Option(..., "--pack"),
):
    """Draft의 라벨링 완료 case를 golden pack으로 승격."""
    import json

    from ipa_cli.tune.search_log import drafts_dir

    s = _settings(ctx)
    pack_payload = _read_pack(s.vault_path, pack)
    cases = pack_payload.setdefault("cases", [])
    draft_path = drafts_dir(s.vault_path) / (draft if draft.endswith(".jsonl") else f"{draft}.jsonl")
    for line in draft_path.read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        if record.get("rejected") or not record.get("target_filename"):
            continue
        cases.append(
            {
                "id": f"{pack}-{len(cases) + 1:03d}",
                "user_query": record.get("user_query"),
                "agent_search_query": record.get("agent_search_query"),
                "target": record.get("target_filename"),
                "expect": {"top_k": 5},
                "source_event_id": record.get("source_event_id"),
            }
        )
    path = _write_pack(s.vault_path, pack, pack_payload)
    console.print(f"[green]promoted[/green] -> {path}")


def _filter_excluded(notes: list, exclude_filenames: list[str] | None) -> list:
    """``exclude_filenames``에 해당하는 ``Note``를 제거 (id 매칭).

    Both sides are NFC-normalised so testsets shipped from macOS (where
    composed Hangul filenames come back as NFD) match note ids without
    silent fall-through.
    """
    if not exclude_filenames:
        return notes
    from ipa_cli.tune.loss import nfc

    excl = {nfc(s) for s in exclude_filenames}
    return [n for n in notes if nfc(n.id) not in excl]


def _study_fingerprint(
    *,
    regression_cases: list[dict],
    scenario_cases: list[dict],
    channel_names: list[str],
    only_keys: list[str] | None,
    fixed_weights: dict[str, float],
    tune_threshold: bool,
    tune_cap: bool,
    fixed_threshold: float,
    fixed_cap: int,
) -> str:
    """testset/채널/옵션 기반 12자리 fingerprint.

    동일 fingerprint면 sqlite study가 resume되고 다르면 별도 sub-dir에
    새 study가 만들어진다. 이전 testset의 best trial이 다른 testset의
    best로 누수되는 것을 막는다.
    """
    import hashlib
    import json

    payload = {
        "reg": sorted(
            json.dumps(c, sort_keys=True, default=str) for c in regression_cases
        ),
        "scn": sorted(
            json.dumps(c, sort_keys=True, default=str) for c in scenario_cases
        ),
        "ch": sorted(channel_names),
        "only": sorted(only_keys) if only_keys else None,
        "fix": sorted(fixed_weights.items()),
        "tune_threshold": tune_threshold,
        "tune_cap": tune_cap,
        "fixed_threshold": fixed_threshold if not tune_threshold else None,
        "fixed_cap": fixed_cap if not tune_cap else None,
    }
    serialized = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha1(serialized.encode("utf-8")).hexdigest()[:12]


def _format_duration(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def _count_unique_testset_queries(
    regression_cases: list[dict], scenario_cases: list[dict]
) -> int:
    seen: set[str] = set()
    for case in [*regression_cases, *scenario_cases]:
        for raw in case.get("queries") or []:
            if raw:
                seen.add(raw)
    return len(seen)


@tune_app.callback(invoke_without_command=True)
def tune_run(
    ctx: typer.Context,
    trials: int = typer.Option(200, "--trials", "-n", help="Optuna trial 수"),
    apply_best: bool = typer.Option(
        False,
        "--apply",
        help="저장된 best result JSON을 vault config weights.file로 활성화",
    ),
    save_best: bool = typer.Option(
        True,
        "--save/--no-save",
        help="best params를 result JSON으로 저장 (default: ON)",
    ),
    fix: list[str] = typer.Option(
        None, "--fix", help="채널 weight 고정 (예: --fix body_match=0.30)"
    ),
    only: str | None = typer.Option(
        None, "--only", help="튜닝할 채널 화이트리스트 (콤마 구분)"
    ),
    tune_threshold: bool = typer.Option(
        True,
        "--tune-threshold/--no-tune-threshold",
        help="threshold도 튜닝 (default: ON)",
    ),
    tune_cap: bool = typer.Option(
        True, "--tune-cap/--no-tune-cap", help="cap (max_results)도 튜닝 (default: ON)"
    ),
    testset_path: Path | None = typer.Option(
        None, "--testset", help="testset NAME|PATH (default: vault .ipa config)"
    ),
    persist_study: bool = typer.Option(
        False,
        "--persist-study/--no-persist-study",
        help="Optuna study sqlite resume cache 저장 (default: OFF)",
    ),
    no_persist_legacy: bool = typer.Option(
        False,
        "--no-persist",
        help="deprecated alias: study sqlite 저장 안 함 (현재 기본값)",
    ),
    progress_every: int = typer.Option(
        1,
        "--progress-every",
        help="N trial마다 진행 상황 출력 (default: every trial)",
        min=1,
    ),
):
    """채널 weight + threshold + cap을 동시 튜닝하는 TPE study.

    Trials reuse a single ``SearchEngine`` setup — channel discovery,
    scoring, and threshold/cap pruning all flow through the engine, so
    trial cost is dominated by per-channel scoring rather than index
    rebuilds.
    """
    if ctx.invoked_subcommand is not None:
        return  # subcommand가 직접 처리

    from ipa_cli.tune.runner import run_study

    s, _channels, engine, notes = _build_engine(ctx)
    ts = load_testset(testset_path, profile=s.profile, vault_path=s.vault_path)
    notes = _filter_excluded(notes, ts.get("exclude_filenames"))
    # Rebuild engine context with the filtered note list so excluded
    # entries don't enter BM25 / channel scoring.
    engine.ctx.notes = notes
    regression = ts.get("cases", [])
    scenario = [c for c in (ts.get("scenario_cases") or []) if c.get("queries")]

    console.print(
        f"[bold]vault[/bold] {s.vault_path}  "
        f"[bold]notes[/bold] {len(notes)}  "
        f"[bold]channels[/bold] {len(engine.channels)}  "
        f"[bold]regression[/bold] {len(regression)}  "
        f"[bold]scenario[/bold] {len(scenario)}"
    )
    unique_queries = _count_unique_testset_queries(regression, scenario)
    console.print(
        f"[dim]precompute: {unique_queries} unique queries × "
        f"{len(engine.channels)} channels once; trials reuse cached raw scores[/dim]"
    )

    fixed_weights = _parse_fixed(fix)
    only_keys = _parse_only(only)
    if apply_best and not save_best:
        raise typer.BadParameter("--apply requires saving a result JSON")

    if no_persist_legacy:
        persist_study = False

    if not persist_study:
        study_dir = None
    else:
        fp = _study_fingerprint(
            regression_cases=regression,
            scenario_cases=scenario,
            channel_names=[c.name for c in engine.channels],
            only_keys=only_keys,
            fixed_weights=fixed_weights,
            tune_threshold=tune_threshold,
            tune_cap=tune_cap,
            fixed_threshold=s.search.threshold,
            fixed_cap=s.search.max_results,
        )
        study_dir = s.vault_path / ".ipa" / "cache" / "tune-studies" / fp

    progress_started_at: float | None = None
    width = len(str(max(trials, 1)))

    def _on_trial(i: int, loss: float, best: float, duration: float) -> None:
        nonlocal progress_started_at
        from time import monotonic

        now = monotonic()
        if progress_started_at is None:
            progress_started_at = now - duration
        completed = i + 1
        should_print = (
            completed == 1
            or completed == trials
            or completed % progress_every == 0
            or loss <= best
        )
        if not should_print:
            return
        elapsed = max(0.0, now - progress_started_at)
        avg = elapsed / completed if completed else 0.0
        eta = max(0, trials - completed) * avg
        marker = "  ★" if loss <= best else ""
        console.print(
            f"  iter {completed:>{width}d}/{trials}  "
            f"last={duration:.2f}s  avg={avg:.2f}s  "
            f"eta={_format_duration(eta)}  "
            f"loss={loss:8.2f}  best={best:.2f}{marker}"
        )

    def _on_precompute_done(query_count: int, duration: float) -> None:
        console.print(
            f"[dim]precompute done: {query_count} queries in "
            f"{duration:.2f}s[/dim]"
        )

    result = run_study(
        engine,
        regression,
        scenario,
        n_trials=trials,
        tune_threshold=tune_threshold,
        tune_cap=tune_cap,
        fixed_weights=fixed_weights,
        only_keys=only_keys,
        fixed_threshold=s.search.threshold,
        fixed_cap=s.search.max_results,
        study_dir=study_dir,
        on_trial=_on_trial,
        on_precompute_done=_on_precompute_done,
    )

    table = Table(
        title=f"BEST after {result.n_trials} trials  (loss {result.best_loss:.2f})"
    )
    table.add_column("key", style="cyan")
    table.add_column("value", style="white")
    table.add_row("threshold", f"{result.best_threshold:.4f}")
    table.add_row("cap", str(result.best_cap))
    for k, v in result.best_weights.items():
        table.add_row(f"weights.{k}", f"{v:.4f}")
    table.add_row("reg hit", f"{result.best_metrics.reg_hit}/{len(regression)}")
    table.add_row("scn hit", f"{result.best_metrics.scn_hit}/{len(scenario)}")
    table.add_row("avg_rank", f"{result.best_metrics.avg_rank:.2f}")
    console.print(table)
    if result.storage_url in {"memory", "sqlite:///:memory:"}:
        console.print("[dim]study: in-memory (not persisted)[/dim]")
    else:
        console.print(f"[dim]study storage: {result.storage_url}[/dim]")

    if save_best:
        _save_best_result(s, result, activate=apply_best)


def _save_best_result(settings: Settings, result, *, activate: bool) -> Path:
    """Persist tune result as immutable artifact and optionally activate it.

    Saves ``.ipa/tune/results/{timestamp}.json`` (immutable). If
    ``activate`` is true, also updates ``weights.file`` in vault-local
    config. Past results stay on disk for rollback via ``ipa tune use``.
    """
    from ipa_cli.tune import (
        TuneResult,
        save_result,
        write_active_result_filename,
    )

    study_meta = {
        "optimizer": "optuna-tpe",
        "n_trials": int(result.n_trials),
        "best_loss": float(result.best_loss),
        "study_name": result.study_name,
        "saved_at": _utc_now_iso(),
    }
    if result.storage_url not in {"memory", "sqlite:///:memory:"}:
        study_meta["storage_url"] = result.storage_url

    artifact = TuneResult(
        threshold=round(result.best_threshold, 4),
        max_results=int(result.best_cap),
        weights={k: round(float(v), 4) for k, v in result.best_weights.items()},
        study=study_meta,
    )
    saved_path = save_result(
        settings.profile,
        artifact,
        vault_path=settings.vault_path,
    )
    fname = saved_path.name
    if activate:
        write_active_result_filename(
            settings.profile,
            fname,
            vault_path=settings.vault_path,
        )
        console.print(
            f"[green]applied[/green] tune result → {saved_path}\n"
            f"  pointer: {settings.vault_config_path} weights.file = .ipa/tune/results/{fname}"
        )
    else:
        console.print(
            f"[green]saved[/green] tune result → {saved_path}\n"
            f"  activate: ipa tune use {fname}"
        )
    return saved_path


def _utc_now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


@tune_app.command("analyze")
def tune_analyze(
    ctx: typer.Context,
    testset_path: Path | None = typer.Option(
        None, "--testset", help="testset NAME|PATH"
    ),
    top_n: int = typer.Option(10, "--top", help="각 케이스의 score 수집 깊이"),
):
    """Threshold 분포 분석 (정답·noise 점수 percentile + 후보 X 시뮬)."""
    s, _channels, engine, notes = _build_engine(ctx)
    ts = load_testset(testset_path, profile=s.profile, vault_path=s.vault_path)
    notes = _filter_excluded(notes, ts.get("exclude_filenames"))
    engine.ctx.notes = notes
    result = analyze_threshold(
        engine,
        ts,
        weights=dict(s.search.weights) if s.search.weights else None,
        top_n=top_n,
    )

    console.print(
        f"[bold]cases[/bold] {result.n_cases}  "
        f"[bold]hit[/bold] {result.n_hit_cases}  "
        f"[bold]miss[/bold] {result.n_miss_cases}"
    )

    def _dist_table(title: str, dist) -> Table | None:
        if dist is None:
            return None
        t = Table(title=title)
        t.add_column("stat", style="cyan")
        t.add_column("score", style="white", justify="right")
        for label, value in [
            ("count", dist.count),
            ("min", f"{dist.minimum:.3f}"),
            ("P05", f"{dist.p05:.3f}"),
            ("P25", f"{dist.p25:.3f}"),
            ("median", f"{dist.median:.3f}"),
            ("P75", f"{dist.p75:.3f}"),
            ("P95", f"{dist.p95:.3f}"),
            ("max", f"{dist.maximum:.3f}"),
        ]:
            t.add_row(label, str(value))
        return t

    if t := _dist_table("정답 점수 (살려야 할 score)", result.correct_dist):
        console.print(t)
    if t := _dist_table("Noise 점수 (자르고 싶은 score)", result.noise_dist):
        console.print(t)

    cand = Table(title="X 후보별 시뮬레이션")
    cand.add_column("X", justify="right", style="cyan")
    cand.add_column("cut hit", justify="right", style="red")
    cand.add_column("cut noise", justify="right", style="green")
    cand.add_column("avg pass", justify="right")
    cand.add_column("risky ids (≤5)", style="dim")
    for row in result.candidates:
        risky_str = " ".join(row.risky_ids[:5]) + (
            "..." if len(row.risky_ids) > 5 else ""
        )
        cand.add_row(
            f"{row.x:.2f}",
            str(row.cut_hit),
            str(row.cut_noise),
            f"{row.avg_after:.2f}",
            risky_str,
        )
    console.print(cand)


@tune_app.command("eval")
def tune_eval(
    ctx: typer.Context,
    testset_path: Path | None = typer.Option(
        None, "--testset", help="testset NAME|PATH (default: vault .ipa config)"
    ),
):
    """현재 활성 search params로 baseline loss/metrics 측정 (튜닝 안 함).

    Routes through ``SearchEngine`` so eval and tune share a single
    scoring path; the engine is set up once and reused.
    """
    from ipa_cli.tune.loss import compute_loss

    s, _channels, engine, notes = _build_engine(ctx)
    ts = load_testset(testset_path, profile=s.profile, vault_path=s.vault_path)
    notes = _filter_excluded(notes, ts.get("exclude_filenames"))
    engine.ctx.notes = notes
    regression = ts.get("cases", [])
    scenario = [c for c in (ts.get("scenario_cases") or []) if c.get("queries")]

    loss, metrics = compute_loss(
        engine,
        regression,
        scenario,
        weights=dict(s.search.weights) if s.search.weights else None,
        threshold=s.search.threshold,
        cap=s.search.max_results,
    )

    table = Table(title=f"baseline (loss {loss:.2f})  profile={s.profile}")
    table.add_column("key", style="cyan")
    table.add_column("value", style="white")
    table.add_row("threshold", f"{s.search.threshold:.4f}")
    table.add_row("max_results", str(s.search.max_results))
    table.add_row("reg hit", f"{metrics.reg_hit}/{len(regression)}")
    table.add_row("scn hit", f"{metrics.scn_hit}/{len(scenario)}")
    table.add_row("avg_rank", f"{metrics.avg_rank:.2f}")
    console.print(table)


@tune_app.command("list")
def tune_list(ctx: typer.Context):
    """profile의 tune/results history (newest first, ★ = active)."""
    from ipa_cli.tune import list_results, read_active_result_filename

    s = _settings(ctx)
    history = list_results(s.profile, vault_path=s.vault_path)
    active = read_active_result_filename(s.profile, vault_path=s.vault_path)

    if not history:
        console.print(
            f"[dim]no tune results yet for profile '{s.profile}'. "
            "Run `ipa tune` to create the first one.[/dim]"
        )
        return

    table = Table(title=f"tune results ({len(history)})  profile={s.profile}")
    table.add_column("active", style="green")
    table.add_column("filename", style="cyan")
    for name in history:
        marker = "★" if name == active else ""
        table.add_row(marker, name)
    console.print(table)
    if active and active not in history:
        console.print(
            f"[yellow]warning[/yellow] active pointer '{active}' "
            "doesn't match any file in results dir. "
            "search will fall back to builtin defaults."
        )


@tune_app.command("use")
def tune_use(
    ctx: typer.Context,
    filename: str = typer.Argument(
        ..., help="활성화할 result 파일명 (예: 2026-05-06T21-30-00.json)"
    ),
):
    """vault-local config의 weights.file 포인터를 <filename>으로 갱신."""
    from ipa_cli.tune import (
        list_results,
        load_result,
        write_active_result_filename,
    )

    s = _settings(ctx)
    target = filename if filename.endswith(".json") else f"{filename}.json"

    if target not in list_results(s.profile, vault_path=s.vault_path):
        raise typer.BadParameter(
            f"'{target}' not found in tune/results for profile '{s.profile}'. "
            "Use `ipa tune list` to see available files."
        )

    # Sanity check: ensure the file is loadable JSON.
    load_result(s.profile, target, vault_path=s.vault_path)

    write_active_result_filename(s.profile, target, vault_path=s.vault_path)
    console.print(
        f"[green]switched[/green] active tune result → {target}\n"
        f"  pointer: {s.vault_config_path} weights.file = .ipa/tune/results/{target}"
    )


if __name__ == "__main__":
    app()

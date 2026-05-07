"""ipa CLI entrypoint.

Surface:
  - ``ipa search / view / traversal / validator / refactor`` — legacy
    surface backed by ``ipa_cli.core`` modules
  - ``ipa convention check`` / ``ipa formatter plan/apply`` — engine-
    based replacements built on the same vault
  - ``ipa engine search / channels`` — direct ``SearchEngine`` access
  - ``ipa tune (run) / eval / list / use / analyze``
  - ``ipa config show`` / ``ipa profile list / use / current``
  - ``ipa list-channels / list-rules / list-refactors`` — registry view
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType

import typer
from rich.console import Console
from rich.table import Table

from ipa_cli.config import (
    Settings,
    list_profiles,
    load_settings,
    set_default_profile,
)
from ipa_cli.core import (
    vault_refactor,
    vault_search,
    vault_traversal,
    vault_validator,
)
from ipa_cli.plugins import get_channels, get_refactors, get_rules
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
engine_app = typer.Typer(
    help="search runtime 명령 (channels / search).",
    no_args_is_help=True,
)
app.add_typer(config_app, name="config")
app.add_typer(profile_app, name="profile")
app.add_typer(convention_app, name="convention")
app.add_typer(formatter_app, name="formatter")
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
    if warning := settings.source_map.get("tune.result_file.warning"):
        console.print(f"[yellow]warning[/yellow] {warning}")
    ctx.obj = settings


def _settings(ctx: typer.Context) -> Settings:
    if not isinstance(ctx.obj, Settings):
        ctx.obj = load_settings()
    return ctx.obj


def _call_module(module: ModuleType, args: list[str], settings: Settings) -> int:
    """Invoke a core module's main() with synthetic argv. Returns exit code.

    The legacy scripts use argparse and sys.exit; we splice argv, swallow
    SystemExit, and inject the active vault path when not already
    specified. ``IPA_CACHE_DIR`` is exported so notes_cache / bm25 caches
    write under the active profile workspace instead of the legacy
    ``~/.cache/vault_search/`` location.
    """
    import os as _os

    new_argv = [module.__name__] + list(args)
    # Inject --vault from active profile when not already present.
    # vault_refactor uses subparsers without a root --vault flag, so for
    # refactor we only inject when there's already at least one arg
    # (otherwise the path parses as a subcommand). Other modules accept
    # --vault at any position.
    needs_vault = settings.vault_path != Path() and "--vault" not in args
    if needs_vault and (module is not vault_refactor or args):
        new_argv += ["--vault", str(settings.vault_path)]
    old_argv = sys.argv
    old_cache_env = _os.environ.get("IPA_CACHE_DIR")
    sys.argv = new_argv
    _os.environ["IPA_CACHE_DIR"] = str(settings.cache_dir)
    try:
        module.main()
        return 0
    except SystemExit as e:
        if e.code is None:
            return 0
        return int(e.code) if isinstance(e.code, int) else 1
    finally:
        sys.argv = old_argv
        if old_cache_env is None:
            _os.environ.pop("IPA_CACHE_DIR", None)
        else:
            _os.environ["IPA_CACHE_DIR"] = old_cache_env


# ── legacy core 모듈 직접 호출 ──


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
):
    """통합 검색 (legacy unified_search)."""
    if not query:
        raise typer.BadParameter("검색 쿼리를 1개 이상 지정해주세요")
    s = _settings(ctx)
    eff_threshold = threshold if threshold is not None else s.search.threshold
    eff_max = max_results if max_results is not None else s.search.max_results
    args: list[str] = []
    for q in query:
        args += ["--search", q]
    args += ["--threshold", str(eff_threshold), "--max", str(eff_max)]
    if show_all:
        args.append("--all")
    if reasons:
        args.append("--reasons")
    raise typer.Exit(_call_module(vault_search, args, s))


@app.command()
def view(
    ctx: typer.Context,
    note: str = typer.Argument(..., help="노트명"),
    section: str | None = typer.Option(None, "--section", help="특정 섹션만"),
    full: bool = typer.Option(False, "--full", help="전체 본문"),
):
    """노트 보기."""
    args = ["--view", note]
    if section:
        args += ["--section", section]
    if full:
        args.append("--full")
    raise typer.Exit(_call_module(vault_search, args, _settings(ctx)))


@app.command()
def traversal(
    ctx: typer.Context,
    up: str | None = typer.Option(None, "--up", help="상향 탐색"),
    down: str | None = typer.Option(None, "--down", help="하향 탐색"),
    siblings: str | None = typer.Option(None, "--siblings", help="형제 노트"),
    root: str | None = typer.Option(None, "--root", help="소속 root"),
):
    """계층 탐색."""
    args: list[str] = []
    for flag, val in [
        ("--up", up),
        ("--down", down),
        ("--siblings", siblings),
        ("--root", root),
    ]:
        if val:
            args += [flag, val]
    if not args:
        raise typer.BadParameter("--up/--down/--siblings/--root 중 하나를 지정해주세요")
    raise typer.Exit(_call_module(vault_traversal, args, _settings(ctx)))


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
    args: list[str] = []
    if note:
        args += ["--note", note]
    if select:
        args += ["--select", select]
    if ignore:
        args += ["--ignore", ignore]
    if fix:
        args.append("--fix")
    if dry_run:
        args.append("--dry-run")
    raise typer.Exit(_call_module(vault_validator, args, _settings(ctx)))


@app.command(
    context_settings={"allow_extra_args": True, "ignore_unknown_options": True}
)
def refactor(ctx: typer.Context):
    """vault 일괄 수정 (legacy; 모든 인자를 vault_refactor에 그대로 전달)."""
    raise typer.Exit(_call_module(vault_refactor, list(ctx.args), _settings(ctx)))


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
        ("profile_yaml", str(s.profile_dir / "profile.yaml")),
        ("vault_path", str(s.vault_path) if s.vault_path != Path() else "(unset)"),
        ("cache_dir", str(s.cache_dir)),
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
    """profile workspace 목록."""
    names, active = list_profiles()
    if not names:
        console.print("[yellow]No profiles found under[/yellow] ~/.config/ipa/profiles")
        return
    table = Table(title="ipa profiles")
    table.add_column("name", style="cyan")
    table.add_column("project", style="green")
    for name in names:
        table.add_row(name, "✓" if name == active else "")
    console.print(table)


@profile_app.command("current")
def profile_current(ctx: typer.Context):
    """현재 활성 프로필 이름만 출력 (스크립팅용)."""
    typer.echo(_settings(ctx).profile)


@profile_app.command("use")
def profile_use(ctx: typer.Context, name: str = typer.Argument(...)):
    """현재 디렉터리에 .ipa-profile을 써서 프로젝트 profile을 선택."""
    set_default_profile(name)
    console.print(f".ipa-profile → [cyan]{name}[/cyan] ({Path.cwd() / '.ipa-profile'})")


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
    convention = load_convention(workspace_arg)
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
    convention = load_convention(workspace_arg)
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
    channels = load_search_channels(workspace_arg)
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
    channels = load_search_channels(workspace_arg)

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


# ── plugin registry 조회 ──


@app.command("list-channels")
def list_channels(ctx: typer.Context):
    """등록된 search 채널 목록 (빌트인 + 향후 외부 plugin)."""
    s = _settings(ctx)
    channels = get_channels()
    table = Table(title=f"search channels ({len(channels)} registered)")
    table.add_column("name", style="cyan")
    table.add_column("weight", style="magenta", justify="right")
    table.add_column("active", style="green", justify="right")
    table.add_column("description", style="white")
    for name, ch in channels.items():
        active = s.search.weights.get(name, 0.0)
        table.add_row(
            name,
            f"{ch.weight:.4f}" if ch.weight is not None else "—",
            f"{active:.4f}",
            ch.description,
        )
    console.print(table)


@app.command("list-rules")
def list_rules():
    """등록된 validator 룰 목록."""
    rules = get_rules()
    table = Table(title=f"validator rules ({len(rules)} registered)")
    table.add_column("id", style="cyan")
    table.add_column("category", style="magenta")
    table.add_column("description", style="white")
    for rid in sorted(rules):
        r = rules[rid]
        table.add_row(r.id, r.category, r.description)
    console.print(table)


@app.command("list-refactors")
def list_refactors():
    """등록된 refactor 커맨드 목록."""
    refs = get_refactors()
    table = Table(title=f"refactor commands ({len(refs)} registered)")
    table.add_column("name", style="cyan")
    table.add_column("description", style="white")
    for name, cmd in refs.items():
        table.add_row(name, cmd.description)
    console.print(table)


# ── tune ──


tune_app = typer.Typer(
    help="Optuna 튜닝 (weight + threshold + cap) 및 분포 진단.",
    invoke_without_command=True,
    no_args_is_help=False,
)
app.add_typer(tune_app, name="tune")


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


def _filter_excluded(notes: list, exclude_filenames: list[str] | None) -> list:
    """``exclude_filenames``에 해당하는 ``Note``를 제거 (id 매칭)."""
    if not exclude_filenames:
        return notes
    excl = set(exclude_filenames)
    return [n for n in notes if n.id not in excl]


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


@tune_app.callback(invoke_without_command=True)
def tune_run(
    ctx: typer.Context,
    trials: int = typer.Option(200, "--trials", "-n", help="Optuna trial 수"),
    apply_best: bool = typer.Option(
        False,
        "--apply",
        help="best params를 result JSON으로 저장하고 profile.yaml 포인터 갱신",
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
        None, "--testset", help="testset NAME|PATH (default: profile tune/testsets)"
    ),
    no_persist: bool = typer.Option(
        False, "--no-persist", help="study sqlite 영속화 끄고 in-memory만"
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
    ts = load_testset(testset_path, profile=s.profile)
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

    fixed_weights = _parse_fixed(fix)
    only_keys = _parse_only(only)
    if no_persist:
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
        study_dir = s.cache_dir / "tune-studies" / fp

    def _on_trial(i: int, loss: float, best: float) -> None:
        if loss <= best:  # only print when we improve or equal
            console.print(f"  trial {i:4d}  loss={loss:8.2f}  ★ best={best:.2f}")

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
    console.print(f"[dim]storage: {result.storage_url}[/dim]")

    if apply_best:
        _apply_best_to_config(s, result)


def _apply_best_to_config(settings: Settings, result) -> None:
    """Persist tune result as immutable artifact + flip active pointer.

    Saves ``tune/results/{timestamp}.json`` (immutable) and updates
    ``tune.result_file`` in profile.yaml via ruamel round-trip. Past
    results stay on disk for rollback via ``ipa tune use``.
    """
    from ipa_cli.tune import (
        TuneResult,
        save_result,
        timestamp_filename,
        write_active_result_filename,
    )

    artifact = TuneResult(
        threshold=round(result.best_threshold, 4),
        max_results=int(result.best_cap),
        weights={k: round(float(v), 4) for k, v in result.best_weights.items()},
        study={
            "n_trials": int(result.n_trials),
            "best_loss": float(result.best_loss),
            "saved_at": _utc_now_iso(),
        },
    )
    fname = timestamp_filename()
    saved_path = save_result(settings.profile, artifact, filename=fname)
    write_active_result_filename(settings.profile, fname)

    console.print(
        f"[green]applied[/green] tune result → {saved_path}\n"
        f"  pointer: {settings.profile_dir / 'profile.yaml'} tune.result_file = {fname}"
    )


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
    ts = load_testset(testset_path, profile=s.profile)
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
        None, "--testset", help="testset NAME|PATH (default: profile tune/testsets)"
    ),
):
    """현재 활성 search params로 baseline loss/metrics 측정 (튜닝 안 함).

    Routes through ``SearchEngine`` so eval and tune share a single
    scoring path; the engine is set up once and reused.
    """
    from ipa_cli.tune.loss import compute_loss

    s, _channels, engine, notes = _build_engine(ctx)
    ts = load_testset(testset_path, profile=s.profile)
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
    history = list_results(s.profile)
    active = read_active_result_filename(s.profile)

    if not history:
        console.print(
            f"[dim]no tune results yet for profile '{s.profile}'. "
            "Run `ipa tune --apply` to create the first one.[/dim]"
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
    """profile.yaml의 tune.result_file 포인터를 <filename>으로 갱신."""
    from ipa_cli.tune import (
        list_results,
        load_result,
        write_active_result_filename,
    )

    s = _settings(ctx)
    target = filename if filename.endswith(".json") else f"{filename}.json"

    if target not in list_results(s.profile):
        raise typer.BadParameter(
            f"'{target}' not found in tune/results for profile '{s.profile}'. "
            "Use `ipa tune list` to see available files."
        )

    # Sanity check: ensure the file is loadable JSON.
    load_result(s.profile, target)

    write_active_result_filename(s.profile, target)
    console.print(
        f"[green]switched[/green] active tune result → {target}\n"
        f"  pointer: {s.profile_dir / 'profile.yaml'} tune.result_file = {target}"
    )


if __name__ == "__main__":
    app()

"""ipa CLI entrypoint.

S1: Typer scaffold + subprocess passthrough to _shared/scripts/*.
S2: --profile/--vault global options, ipa config show, ipa profile list/use/current.
S3: subprocess 제거. core 모듈을 직접 호출 (argv injection).
S4+: plugin loading, tune.
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

app = typer.Typer(
    name="ipa",
    help="IPA vault CLI — search, traversal, validator, refactor, tune.",
    no_args_is_help=True,
    rich_markup_mode="rich",
)
config_app = typer.Typer(help="설정 조회·관리.", no_args_is_help=True)
profile_app = typer.Typer(help="프로필 관리.", no_args_is_help=True)
app.add_typer(config_app, name="config")
app.add_typer(profile_app, name="profile")

console = Console()


@app.callback()
def _global(
    ctx: typer.Context,
    profile: str | None = typer.Option(
        None, "--profile", help="활성 프로필 (env IPA_PROFILE > config.yaml default)"
    ),
    vault: Path | None = typer.Option(
        None, "--vault", help="vault 경로 ad-hoc 지정 (profile 우회)"
    ),
):
    """Resolve Settings once and stash in ctx.obj for subcommands."""
    ctx.obj = load_settings(profile=profile, vault=vault)


def _settings(ctx: typer.Context) -> Settings:
    if not isinstance(ctx.obj, Settings):
        ctx.obj = load_settings()
    return ctx.obj


def _call_module(module: ModuleType, args: list[str], settings: Settings) -> int:
    """Invoke a core module's main() with synthetic argv. Returns exit code.

    The legacy scripts use argparse and sys.exit; we splice argv, swallow
    SystemExit, and inject the active vault path when not already specified.
    Cache directory is exported as IPA_CACHE_DIR so notes_cache writes
    under the active profile (avoids pickle collision with the legacy
    `~/.cache/vault_search/notes_meta.pkl` file).
    """
    import os as _os

    new_argv = [module.__name__] + list(args)
    # Only inject --vault when there's at least one user-supplied arg —
    # vault_refactor uses subparsers without a root --vault flag, so
    # injecting on an empty argv would mis-parse the path as a subcommand.
    if args and settings.vault_path != Path() and "--vault" not in args:
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


# ── core 모듈 직접 호출 ──


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
    """통합 검색."""
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
    """vault 구조 검증."""
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
    """vault 일괄 수정 (모든 인자를 vault_refactor에 그대로 전달)."""
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
        ("vault_path", str(s.vault_path) if s.vault_path != Path() else "(unset)"),
        ("cache_dir", str(s.cache_dir)),
        ("config_path", str(s.config_path)),
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
    """config.yaml에 정의된 프로필 목록."""
    s = _settings(ctx)
    names, default = list_profiles(s.config_path)
    if not names:
        console.print(
            f"[yellow]No profiles defined in[/yellow] {s.config_path} "
            f"(using built-in defaults; active='{s.profile}')"
        )
        return
    table = Table(title=f"profiles in {s.config_path}")
    table.add_column("name", style="cyan")
    table.add_column("default", style="green")
    table.add_column("active", style="magenta")
    for name in names:
        table.add_row(
            name,
            "✓" if name == default else "",
            "✓" if name == s.profile else "",
        )
    console.print(table)


@profile_app.command("current")
def profile_current(ctx: typer.Context):
    """현재 활성 프로필 이름만 출력 (스크립팅용)."""
    typer.echo(_settings(ctx).profile)


@profile_app.command("use")
def profile_use(ctx: typer.Context, name: str = typer.Argument(...)):
    """default_profile을 NAME으로 변경 (config.yaml 갱신)."""
    s = _settings(ctx)
    set_default_profile(name, s.config_path)
    console.print(f"default profile → [cyan]{name}[/cyan] ({s.config_path})")


# ── 후속 stub ──


@app.command()
def tune():
    """Optuna search weight 튜닝. (S5 예정)"""
    typer.echo("ipa tune — S5에서 구현 예정", err=True)
    raise typer.Exit(2)


if __name__ == "__main__":
    app()

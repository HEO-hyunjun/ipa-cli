"""ipa CLI entrypoint.

S1 Bootstrap: Typer app with `search` wired to existing vault_search.py
via subprocess passthrough. Other subcommands are stubs to be filled in
S2 (config/profile) and S3 (parity for view/traversal/validator/refactor).
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import typer

app = typer.Typer(
    name="ipa",
    help="IPA vault CLI — search, traversal, validator, refactor, tune.",
    no_args_is_help=True,
    rich_markup_mode="rich",
)


def _resolve_scripts_dir() -> Path:
    """Locate the existing _shared/scripts directory (S1 passthrough target).

    Resolution order:
    1. IPA_SCRIPTS_DIR env override
    2. ~/ipa/.claude/skills/_shared/scripts (symlink convention)
    3. $IPA_VAULT_PATH/.claude/skills/_shared/scripts
    """
    if (env_dir := os.environ.get("IPA_SCRIPTS_DIR")) and Path(env_dir).is_dir():
        return Path(env_dir)
    symlink = Path.home() / "ipa" / ".claude" / "skills" / "_shared" / "scripts"
    if symlink.is_dir():
        return symlink
    if vault := os.environ.get("IPA_VAULT_PATH"):
        candidate = Path(vault) / ".claude" / "skills" / "_shared" / "scripts"
        if candidate.is_dir():
            return candidate
    raise typer.BadParameter(
        "Could not locate _shared/scripts. Set IPA_SCRIPTS_DIR or IPA_VAULT_PATH, "
        "or create ~/ipa symlink to your vault."
    )


def _passthrough(script: str, args: list[str]) -> int:
    scripts_dir = _resolve_scripts_dir()
    return subprocess.call(["python3", str(scripts_dir / script), *args])


@app.command()
def search(
    query: list[str] = typer.Argument(None, help="검색 쿼리 (여러 개 가능)"),
    threshold: float = typer.Option(0.30, "--threshold", help="결과 컷오프 점수"),
    max_results: int = typer.Option(15, "--max", help="최대 결과 수"),
    show_all: bool = typer.Option(False, "--all", help="threshold/cap 무시"),
    reasons: bool = typer.Option(False, "--reasons", help="채널별 매칭 사유 표시"),
):
    """통합 검색. (S1: vault_search.py passthrough)"""
    if not query:
        raise typer.BadParameter("검색 쿼리를 1개 이상 지정해주세요")
    args: list[str] = []
    for q in query:
        args += ["--search", q]
    args += ["--threshold", str(threshold), "--max", str(max_results)]
    if show_all:
        args.append("--all")
    if reasons:
        args.append("--reasons")
    raise typer.Exit(_passthrough("vault_search.py", args))


@app.command()
def view(
    note: str = typer.Argument(..., help="노트명"),
    section: str | None = typer.Option(None, "--section", help="특정 섹션만"),
    full: bool = typer.Option(False, "--full", help="전체 본문"),
):
    """노트 보기. (S1: vault_search.py --view passthrough)"""
    args = ["--view", note]
    if section:
        args += ["--section", section]
    if full:
        args.append("--full")
    raise typer.Exit(_passthrough("vault_search.py", args))


@app.command()
def traversal(
    up: str | None = typer.Option(None, "--up", help="상향 탐색"),
    down: str | None = typer.Option(None, "--down", help="하향 탐색"),
    siblings: str | None = typer.Option(None, "--siblings", help="형제 노트"),
    root: str | None = typer.Option(None, "--root", help="소속 root"),
):
    """계층 탐색. (S1: vault_traversal.py passthrough)"""
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
    raise typer.Exit(_passthrough("vault_traversal.py", args))


@app.command()
def validator(
    note: str | None = typer.Option(None, "--note", help="단일 노트 검증"),
    select: str | None = typer.Option(None, "--select", help="카테고리/룰 선택"),
    ignore: str | None = typer.Option(None, "--ignore", help="룰 무시"),
    fix: bool = typer.Option(False, "--fix", help="자동 수정"),
    dry_run: bool = typer.Option(False, "--dry-run", help="수정 미리보기"),
):
    """vault 구조 검증. (S1: vault_validator.py passthrough)"""
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
    raise typer.Exit(_passthrough("vault_validator.py", args))


@app.command(
    context_settings={"allow_extra_args": True, "ignore_unknown_options": True}
)
def refactor(ctx: typer.Context):
    """vault 일괄 수정. (S1: vault_refactor.py passthrough — 모든 인자 그대로 전달)"""
    raise typer.Exit(_passthrough("vault_refactor.py", list(ctx.args)))


# ── 후속 단계 stub ──


@app.command()
def config():
    """설정 조회/수정. (S2 예정)"""
    typer.echo("ipa config — S2에서 구현 예정", err=True)
    raise typer.Exit(2)


@app.command()
def profile():
    """프로필 관리. (S2 예정)"""
    typer.echo("ipa profile — S2에서 구현 예정", err=True)
    raise typer.Exit(2)


@app.command()
def tune():
    """Optuna search weight 튜닝. (S5 예정)"""
    typer.echo("ipa tune — S5에서 구현 예정", err=True)
    raise typer.Exit(2)


if __name__ == "__main__":
    app()

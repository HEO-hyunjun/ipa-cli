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
from ipa_cli.plugins import get_channels, get_refactors, get_rules
from ipa_cli.tune import (
    analyze_threshold,
    filter_excluded,
    load_testset,
    run_study,
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


# ── 후속 stub ──


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


def _load_testset_with_notes(s: Settings, testset_path: Path | None):
    """Common boilerplate for tune commands."""
    from ipa_cli.core.vault_parser import build_note_index, scan_vault

    if s.vault_path == Path():
        raise typer.BadParameter(
            "vault_path 미설정. config.yaml 또는 IPA_VAULT_PATH로 지정하세요."
        )
    ts = load_testset(testset_path)
    notes = scan_vault(s.vault_path)
    notes = filter_excluded(notes, ts.get("exclude_filenames"))
    idx = build_note_index(notes)
    return ts, notes, idx


@tune_app.callback(invoke_without_command=True)
def tune_run(
    ctx: typer.Context,
    trials: int = typer.Option(200, "--trials", "-n", help="Optuna trial 수"),
    apply_best: bool = typer.Option(
        False, "--apply", help="best weights를 활성 profile config.yaml에 write-back"
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
        None, "--testset", help="testset.json 경로 (default: env > project > xdg)"
    ),
    no_persist: bool = typer.Option(
        False, "--no-persist", help="study sqlite 영속화 끄고 in-memory만"
    ),
):
    """채널 weight + threshold + cap을 동시 튜닝하는 TPE study."""
    if ctx.invoked_subcommand is not None:
        return  # subcommand가 직접 처리

    s = _settings(ctx)
    ts, notes, idx = _load_testset_with_notes(s, testset_path)
    regression = ts.get("cases", [])
    scenario = [c for c in (ts.get("scenario_cases") or []) if c.get("queries")]

    console.print(
        f"[bold]vault[/bold] {s.vault_path}  "
        f"[bold]notes[/bold] {len(notes)}  "
        f"[bold]regression[/bold] {len(regression)}  "
        f"[bold]scenario[/bold] {len(scenario)}"
    )

    fixed_weights = _parse_fixed(fix)
    only_keys = _parse_only(only)
    study_dir = None if no_persist else s.cache_dir

    def _on_trial(i: int, loss: float, best: float) -> None:
        if loss <= best:  # only print when we improve or equal
            console.print(f"  trial {i:4d}  loss={loss:8.2f}  ★ best={best:.2f}")

    result = run_study(
        notes,
        idx,
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
    """Write best weights/threshold/cap back to active profile in config.yaml."""
    from ruamel.yaml import YAML

    yaml = YAML()
    yaml.preserve_quotes = True
    cfg_path = settings.config_path
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    if cfg_path.is_file():
        with cfg_path.open("r", encoding="utf-8") as f:
            data = yaml.load(f) or {}
    else:
        data = {}

    profiles = data.setdefault("profiles", {})
    profile = profiles.setdefault(settings.profile, {})
    search = profile.setdefault("search", {})
    search["threshold"] = round(result.best_threshold, 4)
    search["max_results"] = result.best_cap
    weights = search.setdefault("weights", {})
    for k, v in result.best_weights.items():
        weights[k] = round(v, 4)

    if "default_profile" not in data:
        data["default_profile"] = settings.profile

    with cfg_path.open("w", encoding="utf-8") as f:
        yaml.dump(data, f)
    console.print(
        f"[green]applied[/green] best params → {cfg_path}  (profile: {settings.profile})"
    )


@tune_app.command("analyze")
def tune_analyze(
    ctx: typer.Context,
    testset_path: Path | None = typer.Option(
        None, "--testset", help="testset.json 경로"
    ),
    top_n: int = typer.Option(10, "--top", help="각 케이스의 score 수집 깊이"),
):
    """Threshold 분포 분석 (정답·noise 점수 percentile + X 후보 시뮬)."""
    s = _settings(ctx)
    ts, notes, idx = _load_testset_with_notes(s, testset_path)
    result = analyze_threshold(notes, idx, ts, top_n=top_n)

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


if __name__ == "__main__":
    app()

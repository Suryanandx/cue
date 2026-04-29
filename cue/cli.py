"""cue — open-source meeting assistant CLI."""
from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import asdict
from typing import Optional

import click
import httpx
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.table import Table

from cue import __version__
from cue.agents import Agent, AgentStore
from cue.config import CONFIG_PATH, CueConfig, ensure_dirs
from cue.providers import ChatMessage, route
from cue.providers.ollama import OllamaProvider
from cue.providers.openrouter import OpenRouterProvider

console = Console()


@click.group(invoke_without_command=True)
@click.version_option(__version__, prog_name="cue")
@click.pass_context
def cli(ctx: click.Context) -> None:
    """Open-source meeting assistant. Whispers smart, runs local."""
    if ctx.invoked_subcommand is None:
        click.echo(ctx.get_help())


# ──────────────────────────  init / config  ────────────────────────── #

@cli.command()
def init() -> None:
    """First-run setup. Writes ~/.cue/config.toml and the agent directory."""
    ensure_dirs()
    cfg = CueConfig.load()

    if not cfg.openrouter.api_key:
        key = click.prompt(
            "OpenRouter API key (https://openrouter.ai/keys, blank for Ollama-only)",
            default="",
            show_default=False,
            hide_input=True,
        )
        cfg.openrouter.api_key = key.strip()

    cfg.save()
    console.print(Panel.fit(
        f"[green]✓[/] Cue initialised\n"
        f"  config:   {CONFIG_PATH}\n"
        f"  agents:   {len(AgentStore().list())} built-in\n"
        f"  daemon:   {cfg.daemon.bind}:{cfg.daemon.port}\n\n"
        f"Try [cyan]cue ask \"hello\"[/] or [cyan]cue daemon start[/].",
        title="Cue", border_style="yellow",
    ))


@cli.group()
def config() -> None:
    """Inspect and edit the persisted config."""


@config.command("show")
def config_show() -> None:
    cfg = CueConfig.load()
    safe = asdict(cfg)
    if safe["openrouter"]["api_key"]:
        safe["openrouter"]["api_key"] = "sk-or-...***"
    console.print_json(data=safe)


@config.command("set")
@click.argument("key")
@click.argument("value")
def config_set(key: str, value: str) -> None:
    """Set `section.key`, e.g. `cue config set ui.stealth false`."""
    cfg = CueConfig.load()
    section, _, field = key.partition(".")
    if not field or not hasattr(cfg, section):
        raise click.BadParameter(f"Unknown key '{key}'. Use section.field form.")
    obj = getattr(cfg, section)
    if not hasattr(obj, field):
        raise click.BadParameter(f"Unknown field '{field}' in section '{section}'.")
    current = getattr(obj, field)
    if isinstance(current, bool):
        casted: object = value.lower() in ("1", "true", "yes", "on")
    elif isinstance(current, int):
        casted = int(value)
    elif isinstance(current, float):
        casted = float(value)
    else:
        casted = value
    setattr(obj, field, casted)
    cfg.save()
    console.print(f"[green]✓[/] {key} = {casted}")


# ──────────────────────────  daemon  ────────────────────────── #

@cli.group()
def daemon() -> None:
    """Manage the FastAPI daemon (the engine behind GUI + CLI)."""


@daemon.command("start")
@click.option("--foreground", is_flag=True, help="Run in foreground (don't detach).")
@click.option("--host", default=None)
@click.option("--port", type=int, default=None)
def daemon_start(foreground: bool, host: Optional[str], port: Optional[int]) -> None:
    from cue.daemon.server import start
    try:
        start(host=host, port=port, foreground=foreground)
    except RuntimeError as e:
        raise click.ClickException(str(e))
    if not foreground:
        console.print("[green]✓[/] daemon started in background")


@daemon.command("stop")
def daemon_stop() -> None:
    from cue.daemon.server import stop
    if stop():
        console.print("[green]✓[/] daemon stopped")
    else:
        console.print("[yellow]daemon was not running[/]")


@daemon.command("status")
def daemon_status() -> None:
    from cue.daemon.server import status
    s = status()
    color = "green" if s["running"] else "red"
    console.print(Panel.fit(
        f"[{color}]{'running' if s['running'] else 'stopped'}[/]\n"
        f"  pid:  {s['pid']}\n"
        f"  url:  {s['url']}\n"
        f"  logs: {s['logs']}",
        title="cue daemon", border_style=color,
    ))


@daemon.command("logs")
@click.option("-n", "--lines", default=50)
def daemon_logs(lines: int) -> None:
    from cue.config import DATA_DIR
    log = DATA_DIR / "daemon.log"
    if not log.exists():
        console.print("[yellow]no logs yet[/]")
        return
    with log.open() as f:
        tail = f.readlines()[-lines:]
    sys.stdout.write("".join(tail))


# ──────────────────────────  ask (one-shot)  ────────────────────────── #

@cli.command()
@click.argument("question", nargs=-1, required=True)
@click.option("--agent", "-a", default=None, help="Agent slug (default: configured default).")
@click.option("--model", "-m", default=None, help="Override model, e.g. openrouter:openai/gpt-4o")
def ask(question: tuple[str, ...], agent: Optional[str], model: Optional[str]) -> None:
    """One-shot Q&A through the agent pipeline."""
    cfg = CueConfig.load()
    store = AgentStore()
    text = " ".join(question)
    slug = agent or cfg.default_agent
    try:
        a = store.get(slug)
    except KeyError:
        raise click.ClickException(f"Agent not found: {slug}. Run `cue agent list`.")

    messages: list[ChatMessage] = []
    if a.system_prompt:
        messages.append(ChatMessage(role="system", content=a.system_prompt))
    messages.append(ChatMessage(role="user", content=text))

    primary = model or a.model
    fallback = a.fallback

    console.print(f"[dim]{a.name} · {primary}[/]")

    async def run() -> None:
        full = []
        async for ev in route(
            primary, fallback, messages, cfg,
            temperature=a.temperature, max_tokens=a.max_tokens,
        ):
            if ev.type == "token":
                sys.stdout.write(ev.content)
                sys.stdout.flush()
                full.append(ev.content)
            elif ev.type == "error":
                console.print(f"\n[red]error:[/] {ev.error}")
                return
            elif ev.type == "done":
                tokens = ev.completion_tokens
                console.print(
                    f"\n\n[dim]{ev.model} · {tokens} tokens[/]"
                    if tokens else f"\n\n[dim]{ev.model}[/]"
                )

    asyncio.run(run())


# ──────────────────────────  agents  ────────────────────────── #

@cli.group()
def agent() -> None:
    """Manage agents (TOML files in ~/.cue/agents)."""


@agent.command("list")
def agent_list() -> None:
    store = AgentStore()
    table = Table(show_header=True, header_style="bold yellow", box=None, padding=(0, 2))
    table.add_column("slug")
    table.add_column("name")
    table.add_column("model")
    table.add_column("hotkey")
    table.add_column("type")
    for a in store.list():
        table.add_row(
            a.slug, a.name, a.model, a.hotkey or "—",
            "[dim]builtin[/]" if a.builtin else "user",
        )
    console.print(table)


@agent.command("show")
@click.argument("slug")
def agent_show(slug: str) -> None:
    a = AgentStore().get(slug)
    console.print(Panel.fit(
        Markdown(f"# {a.name}\n\n_{a.description}_\n\n"
                 f"- **model:** `{a.model}`\n"
                 f"- **fallback:** `{a.fallback}`\n"
                 f"- **temp:** {a.temperature}  · **max_tokens:** {a.max_tokens}\n"
                 f"- **kb_scope:** {', '.join(a.kb_scope) or 'none'}\n"
                 f"- **hotkey:** {a.hotkey or 'none'}\n\n"
                 f"---\n\n```\n{a.system_prompt}\n```"),
        border_style="yellow", title=f"agent · {slug}",
    ))


@agent.command("new")
@click.argument("slug")
@click.option("--from", "from_", default=None, help="Copy an existing agent as the starting template.")
def agent_new(slug: str, from_: Optional[str]) -> None:
    store = AgentStore()
    base = store.get(from_) if from_ else Agent(
        slug=slug, name=slug.replace("-", " ").title(),
        description="Custom agent",
        system_prompt="You are a helpful assistant.",
    )
    new = Agent(
        slug=slug, name=base.name, description=base.description,
        model=base.model, fallback=base.fallback,
        temperature=base.temperature, max_tokens=base.max_tokens,
        system_prompt=base.system_prompt, kb_scope=list(base.kb_scope),
        voice=base.voice, hotkey=base.hotkey,
    )
    path = store.save(new)
    console.print(f"[green]✓[/] saved {path}")
    console.print(f"Edit with [cyan]$EDITOR {path}[/]")


@agent.command("rm")
@click.argument("slug")
def agent_rm(slug: str) -> None:
    try:
        AgentStore().delete(slug)
    except KeyError as e:
        raise click.ClickException(str(e))
    console.print(f"[green]✓[/] deleted {slug}")


@agent.command("use")
@click.argument("slug")
def agent_use(slug: str) -> None:
    """Set the default agent."""
    AgentStore().get(slug)  # validate
    cfg = CueConfig.load()
    cfg.default_agent = slug
    cfg.save()
    console.print(f"[green]✓[/] default agent → {slug}")


# ──────────────────────────  models  ────────────────────────── #

@cli.group()
def model() -> None:
    """List + benchmark Ollama and OpenRouter models."""


@model.command("list")
def model_list() -> None:
    cfg = CueConfig.load()

    async def run() -> None:
        ollama = OllamaProvider(cfg.ollama.host, cfg.ollama.port)
        openrouter = OpenRouterProvider(
            cfg.openrouter.api_key,
            site_url=cfg.openrouter.site_url,
            site_name=cfg.openrouter.site_name,
        )
        try:
            ol = await ollama.list_models()
        except Exception as e:
            ol = []
            console.print(f"[yellow]ollama unavailable: {e}[/]")
        try:
            orm = await openrouter.list_models()
        except Exception as e:
            orm = []
            console.print(f"[yellow]openrouter unavailable: {e}[/]")

        if ol:
            console.print(Panel.fit("\n".join(ol[:30]) + ("\n..." if len(ol) > 30 else ""),
                                    title=f"ollama  ({len(ol)})", border_style="cyan"))
        if orm:
            preview = "\n".join(orm[:30]) + (f"\n... +{len(orm) - 30} more" if len(orm) > 30 else "")
            console.print(Panel.fit(preview, title=f"openrouter  ({len(orm)})", border_style="yellow"))

    asyncio.run(run())


@model.command("set")
@click.argument("agent_slug")
@click.argument("model_spec")
def model_set(agent_slug: str, model_spec: str) -> None:
    """Override an agent's model. e.g. cue model set interview-coding openrouter:openai/gpt-4o"""
    store = AgentStore()
    a = store.get(agent_slug)
    if a.builtin:
        # Promote built-in to a user-editable copy
        new = Agent(
            slug=a.slug, name=a.name, description=a.description,
            model=model_spec, fallback=a.fallback,
            temperature=a.temperature, max_tokens=a.max_tokens,
            system_prompt=a.system_prompt, kb_scope=list(a.kb_scope),
            voice=a.voice, hotkey=a.hotkey,
        )
        store.save(new)
    else:
        a.model = model_spec
        store.save(a)
    console.print(f"[green]✓[/] {agent_slug} → {model_spec}")


# ──────────────────────────  GUI launcher  ────────────────────────── #

@cli.command()
def start() -> None:
    """Launch the Electron overlay (requires the GUI build)."""
    import shutil
    import subprocess

    candidates = ["/Applications/Cue.app/Contents/MacOS/Cue", shutil.which("cue-gui")]
    for c in candidates:
        if c and (c.startswith("/") or shutil.which(c)):
            subprocess.Popen([c])
            console.print(f"[green]✓[/] launched {c}")
            return
    console.print(
        "[yellow]Cue GUI not installed.[/]\n"
        "Run from the repo root: [cyan]cd electron && npm install && npm start[/]"
    )


# ──────────────────────────  health  ────────────────────────── #

@cli.command()
def doctor() -> None:
    """Diagnose providers, paths, and agent state."""
    cfg = CueConfig.load()

    async def run() -> None:
        rows = []
        rows.append(("config", str(CONFIG_PATH), CONFIG_PATH.exists()))
        rows.append(("openrouter key", "set" if cfg.openrouter.api_key else "missing",
                     bool(cfg.openrouter.api_key)))
        ol = OllamaProvider(cfg.ollama.host, cfg.ollama.port)
        rows.append(("ollama", f"{cfg.ollama.host}:{cfg.ollama.port}", await ol.health()))
        agents = AgentStore().list()
        rows.append(("agents", f"{len(agents)} loaded", len(agents) > 0))

        # try the daemon if running
        try:
            r = httpx.get(f"http://{cfg.daemon.bind}:{cfg.daemon.port}/v1/health", timeout=2)
            rows.append(("daemon", f"{cfg.daemon.bind}:{cfg.daemon.port}", r.status_code == 200))
        except httpx.HTTPError:
            rows.append(("daemon", "not running", False))

        t = Table(box=None, show_header=False, padding=(0, 2))
        for name, detail, ok in rows:
            mark = "[green]✓[/]" if ok else "[red]×[/]"
            t.add_row(mark, name, detail)
        console.print(t)

    asyncio.run(run())


if __name__ == "__main__":
    cli()

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

# ──────────────────────────  practice (mock interview TUI)  ────────────────────────── #

@cli.command()
@click.argument("agent", required=False)
def practice(agent: Optional[str]) -> None:
    """Mock interview / practice session in the terminal.

    Pick an agent (default: interview), and the agent will roleplay the
    interviewer asking questions. You answer in plain text. Useful for
    behavioral, sales, or coding-interview practice without a meeting.
    """
    cfg = CueConfig.load()
    store = AgentStore()
    slug = agent or "interview"
    try:
        a = store.get(slug)
    except KeyError:
        raise click.ClickException(f"Agent not found: {slug}")

    interviewer_prompt = (
        "You are now ROLE-REVERSED: act as the interviewer. Ask the candidate "
        "questions appropriate for the agent's domain (e.g. behavioral STAR, "
        "system design, coding, sales discovery). Ask ONE question at a time. "
        "After the candidate answers, evaluate briefly (one line) and ask the "
        "next question. Calibrate difficulty to the answer quality."
    )
    base_system = a.system_prompt + "\n\n---\n" + interviewer_prompt
    history: list[ChatMessage] = [
        ChatMessage(role="system", content=base_system),
        ChatMessage(role="user", content="Begin. Ask your first question."),
    ]

    console.print(Panel.fit(
        f"[yellow]Practice mode[/] · {a.name}\n"
        f"Type your answers · [cyan]Ctrl-D[/] to end · [cyan]/skip[/] for next q · [cyan]/grade[/] for feedback",
        border_style="yellow",
    ))

    async def run_turn() -> None:
        async for ev in route(
            a.model, a.fallback, history, cfg,
            temperature=a.temperature, max_tokens=a.max_tokens,
        ):
            if ev.type == "token":
                sys.stdout.write(ev.content)
                sys.stdout.flush()
            elif ev.type == "error":
                console.print(f"\n[red]error:[/] {ev.error}")
                return
            elif ev.type == "done":
                console.print("")

    full = []

    def stream_collect():
        async def go():
            buf = []
            async for ev in route(
                a.model, a.fallback, history, cfg,
                temperature=a.temperature, max_tokens=a.max_tokens,
            ):
                if ev.type == "token":
                    sys.stdout.write(ev.content)
                    sys.stdout.flush()
                    buf.append(ev.content)
                elif ev.type == "error":
                    console.print(f"\n[red]error:[/] {ev.error}")
                    return ""
                elif ev.type == "done":
                    console.print("")
                    return "".join(buf)
            return "".join(buf)
        return asyncio.run(go())

    console.print("[dim]interviewer ▸[/]")
    reply = stream_collect()
    if reply:
        history.append(ChatMessage(role="assistant", content=reply))

    while True:
        try:
            answer = click.prompt("\nyou ▸", default="", show_default=False)
        except (EOFError, click.exceptions.Abort):
            console.print("\n[dim]session ended[/]")
            break
        if not answer.strip():
            continue
        if answer.strip() == "/skip":
            history.append(ChatMessage(role="user", content="(skipped) Ask the next question, harder."))
        elif answer.strip() == "/grade":
            history.append(ChatMessage(role="user", content="Grade the entire session so far. List 3 strengths, 3 gaps, 3 things to practice."))
        else:
            history.append(ChatMessage(role="user", content=answer))
        console.print("\n[dim]interviewer ▸[/]")
        reply = stream_collect()
        if reply:
            history.append(ChatMessage(role="assistant", content=reply))


# ──────────────────────────  listen (live transcript preview)  ────────────────────────── #

@cli.command()
@click.option("--agent", "-a", default=None, help="Agent slug. Default: configured default agent.")
def listen(agent: Optional[str]) -> None:
    """Live listening mode in the terminal.

    Prints transcript chunks as they arrive from the daemon's STT endpoint.
    For v0.1 this is a thin stub that polls the daemon — real-time wiring
    lands when the STT engine ships in 0.2.
    """
    cfg = CueConfig.load()
    base = f"http://{cfg.daemon.bind}:{cfg.daemon.port}"
    try:
        h = httpx.get(f"{base}/v1/health", timeout=2)
    except httpx.HTTPError:
        raise click.ClickException(f"daemon not running at {base}. Run [cue daemon start].")

    info = h.json()
    if not info.get("providers", {}).get("openrouter") and not info.get("providers", {}).get("ollama"):
        console.print("[yellow]warning:[/] no providers configured. Listening will work but answers will fail.")

    slug = agent or cfg.default_agent
    console.print(Panel.fit(
        f"[green]●[/] listening · agent={slug} · daemon={base}\n"
        f"[dim]Ctrl-C to stop · STT engine: {info.get('stt_engine')}[/]",
        border_style="green",
    ))
    console.print(
        "[dim]STT engine wiring lands in 0.2. For now use the Electron overlay or "
        "pipe transcripts in via [cue ask][/]."
    )


# ──────────────────────────  session (transcripts + answers)  ────────────────────────── #

@cli.group()
def session() -> None:
    """Browse past sessions (transcripts + answers)."""


@session.command("list")
def session_list() -> None:
    from cue.config import SESSIONS_DIR
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    rows = sorted(SESSIONS_DIR.glob("*.json"), reverse=True)
    if not rows:
        console.print("[dim]no sessions yet[/]")
        return
    t = Table(box=None, show_header=True, header_style="bold yellow", padding=(0, 2))
    t.add_column("id")
    t.add_column("created")
    t.add_column("path", overflow="fold")
    for p in rows:
        ts = p.stat().st_mtime
        from datetime import datetime
        t.add_row(p.stem, datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M"), str(p))
    console.print(t)


@session.command("show")
@click.argument("session_id")
def session_show(session_id: str) -> None:
    from cue.config import SESSIONS_DIR
    path = SESSIONS_DIR / f"{session_id}.json"
    if not path.exists():
        raise click.ClickException(f"session {session_id} not found")
    import json
    data = json.loads(path.read_text("utf-8"))
    console.print(Panel.fit(
        Markdown(f"# Session {session_id}\n\n```json\n{json.dumps(data, indent=2)[:4000]}\n```"),
        border_style="yellow",
    ))


@session.command("export")
@click.argument("session_id")
@click.option("--output", "-o", default=None, help="Output file (default: stdout)")
def session_export(session_id: str, output: Optional[str]) -> None:
    from cue.config import SESSIONS_DIR
    path = SESSIONS_DIR / f"{session_id}.json"
    if not path.exists():
        raise click.ClickException(f"session {session_id} not found")
    content = path.read_text("utf-8")
    if output:
        from pathlib import Path
        Path(output).write_text(content, "utf-8")
        console.print(f"[green]✓[/] exported to {output}")
    else:
        sys.stdout.write(content)


# ──────────────────────────  repl (interactive shell)  ────────────────────────── #

@cli.command()
@click.option("--agent", "-a", default=None, help="Agent slug. Default: configured default agent.")
def repl(agent: Optional[str]) -> None:
    """Interactive Q&A shell. Multi-turn conversation in the terminal.

    Commands inside the REPL:
      /agent <slug>   switch agents
      /model <spec>   override model for this session
      /reset          clear conversation history
      /save <name>    save the conversation to ~/.cue/sessions
      /quit           exit
    """
    cfg = CueConfig.load()
    store = AgentStore()
    slug = agent or cfg.default_agent
    try:
        a = store.get(slug)
    except KeyError:
        raise click.ClickException(f"Agent not found: {slug}")

    history: list[ChatMessage] = []
    if a.system_prompt:
        history.append(ChatMessage(role="system", content=a.system_prompt))

    model_override = None

    console.print(Panel.fit(
        f"[yellow]REPL[/] · {a.name} · {a.model}\n"
        f"[dim]/agent · /model · /reset · /save · /quit[/]",
        border_style="yellow",
    ))

    while True:
        try:
            user_in = click.prompt("▸", default="", show_default=False)
        except (EOFError, click.exceptions.Abort):
            console.print("\n[dim]bye[/]")
            break
        if not user_in.strip():
            continue
        cmd = user_in.strip()
        if cmd == "/quit":
            break
        if cmd == "/reset":
            history = [ChatMessage(role="system", content=a.system_prompt)] if a.system_prompt else []
            console.print("[dim]history cleared[/]")
            continue
        if cmd.startswith("/agent "):
            new_slug = cmd.split(maxsplit=1)[1].strip()
            try:
                a = store.get(new_slug)
                history = [ChatMessage(role="system", content=a.system_prompt)] if a.system_prompt else []
                console.print(f"[green]✓[/] agent → {a.name}")
            except KeyError:
                console.print(f"[red]agent not found: {new_slug}[/]")
            continue
        if cmd.startswith("/model "):
            model_override = cmd.split(maxsplit=1)[1].strip()
            console.print(f"[green]✓[/] model → {model_override}")
            continue
        if cmd.startswith("/save "):
            name = cmd.split(maxsplit=1)[1].strip()
            from cue.config import SESSIONS_DIR
            import json
            from datetime import datetime
            SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
            path = SESSIONS_DIR / f"{name}.json"
            path.write_text(json.dumps({
                "id": name,
                "agent": a.slug,
                "model": model_override or a.model,
                "saved_at": datetime.now().isoformat(),
                "messages": [{"role": m.role, "content": m.content} for m in history],
            }, indent=2), "utf-8")
            console.print(f"[green]✓[/] saved {path}")
            continue

        history.append(ChatMessage(role="user", content=user_in))

        async def run() -> str:
            buf = []
            async for ev in route(
                model_override or a.model, a.fallback, history, cfg,
                temperature=a.temperature, max_tokens=a.max_tokens,
            ):
                if ev.type == "token":
                    sys.stdout.write(ev.content); sys.stdout.flush()
                    buf.append(ev.content)
                elif ev.type == "error":
                    console.print(f"\n[red]error:[/] {ev.error}")
                    return ""
                elif ev.type == "done":
                    console.print("")
            return "".join(buf)

        reply = asyncio.run(run())
        if reply:
            history.append(ChatMessage(role="assistant", content=reply))


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

"""Agent storage — TOML files in ~/.cue/agents/, with built-ins shipped in-package."""
from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass, field, asdict
from importlib import resources
from pathlib import Path

import tomli_w

from cue.config import AGENTS_DIR


@dataclass
class Agent:
    slug: str
    name: str
    description: str = ""
    model: str = "openrouter:openai/gpt-4o-mini"
    fallback: str = "openrouter:meta-llama/llama-3.1-8b-instruct:free"
    temperature: float = 0.4
    max_tokens: int = 1024
    system_prompt: str = ""
    kb_scope: list[str] = field(default_factory=list)
    voice: str = "default"
    hotkey: str = ""
    builtin: bool = False

    @classmethod
    def from_toml(cls, slug: str, raw: dict, *, builtin: bool = False) -> "Agent":
        return cls(
            slug=slug,
            name=raw.get("name", slug.replace("-", " ").title()),
            description=raw.get("description", ""),
            model=raw.get("model", "openrouter:openai/gpt-4o-mini"),
            fallback=raw.get("fallback", "openrouter:meta-llama/llama-3.1-8b-instruct:free"),
            temperature=float(raw.get("temperature", 0.4)),
            max_tokens=int(raw.get("max_tokens", 1024)),
            system_prompt=raw.get("system_prompt", "").strip(),
            kb_scope=list(raw.get("kb_scope", [])),
            voice=raw.get("voice", "default"),
            hotkey=raw.get("hotkey", ""),
            builtin=builtin,
        )

    def to_toml(self) -> str:
        d = asdict(self)
        d.pop("slug")
        d.pop("builtin")
        return tomli_w.dumps(d)


_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")


class AgentStore:
    def __init__(self) -> None:
        AGENTS_DIR.mkdir(parents=True, exist_ok=True)

    def list(self) -> list[Agent]:
        agents: dict[str, Agent] = {}
        # Built-ins first
        try:
            pkg = resources.files("cue.agents.builtins")
            for entry in pkg.iterdir():
                if entry.name.endswith(".toml"):
                    slug = entry.name.removesuffix(".toml")
                    agents[slug] = Agent.from_toml(
                        slug, tomllib.loads(entry.read_text("utf-8")), builtin=True
                    )
        except (ModuleNotFoundError, FileNotFoundError):
            pass
        # User overrides / additions
        for path in sorted(AGENTS_DIR.glob("*.toml")):
            slug = path.stem
            agents[slug] = Agent.from_toml(slug, tomllib.loads(path.read_text("utf-8")))
        return sorted(agents.values(), key=lambda a: (not a.builtin, a.slug))

    def get(self, slug: str) -> Agent:
        for a in self.list():
            if a.slug == slug:
                return a
        raise KeyError(f"Agent not found: {slug}")

    def save(self, agent: Agent) -> Path:
        if not _SLUG_RE.match(agent.slug):
            raise ValueError("slug must be lowercase letters, digits, or hyphens (2-40 chars)")
        path = AGENTS_DIR / f"{agent.slug}.toml"
        path.write_text(agent.to_toml(), "utf-8")
        return path

    def delete(self, slug: str) -> None:
        path = AGENTS_DIR / f"{slug}.toml"
        if path.exists():
            path.unlink()
        else:
            raise KeyError(f"User agent not found: {slug} (built-ins cannot be deleted)")

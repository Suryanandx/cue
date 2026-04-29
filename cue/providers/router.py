"""Provider router. Resolves `provider:model` strings and falls back gracefully."""
from __future__ import annotations

from typing import AsyncIterator

from cue.config import CueConfig
from cue.providers.base import ChatMessage, Provider, StreamEvent
from cue.providers.ollama import OllamaProvider
from cue.providers.openrouter import OpenRouterProvider


def _build(name: str, cfg: CueConfig) -> Provider:
    if name == "openrouter":
        return OpenRouterProvider(
            api_key=cfg.openrouter.api_key,
            site_url=cfg.openrouter.site_url,
            site_name=cfg.openrouter.site_name,
        )
    if name == "ollama":
        return OllamaProvider(host=cfg.ollama.host, port=cfg.ollama.port)
    raise ValueError(f"Unknown provider: {name}")


def resolve(spec: str, cfg: CueConfig) -> tuple[Provider, str]:
    """`openrouter:openai/gpt-4o-mini` → (OpenRouter, 'openai/gpt-4o-mini').

    Bare `gpt-4o-mini` defaults to OpenRouter; bare `llama3:8b` defaults to Ollama.
    """
    if ":" in spec:
        provider, _, model = spec.partition(":")
        # Ollama tags use ':' too — `llama3:8b` is one token, not provider+model
        if provider in ("openrouter", "ollama") and model:
            return _build(provider, cfg), model
    # Heuristic: contains '/' → openrouter, else ollama
    if "/" in spec:
        return _build("openrouter", cfg), spec
    return _build("ollama", cfg), spec


async def route(
    primary: str,
    fallback: str | None,
    messages: list[ChatMessage],
    cfg: CueConfig,
    *,
    temperature: float = 0.7,
    max_tokens: int = 1024,
) -> AsyncIterator[StreamEvent]:
    """Stream from primary; if first event is an error, retry on fallback."""
    p, m = resolve(primary, cfg)
    started = False
    async for ev in p.stream_chat(m, messages, temperature=temperature, max_tokens=max_tokens):
        if ev.type == "error" and not started and fallback:
            fp, fm = resolve(fallback, cfg)
            async for fev in fp.stream_chat(
                fm, messages, temperature=temperature, max_tokens=max_tokens
            ):
                yield fev
            return
        if ev.type == "token":
            started = True
        yield ev

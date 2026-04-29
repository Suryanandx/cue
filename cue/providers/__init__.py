"""LLM provider routing — Ollama (local) + OpenRouter (cloud).

Agents declare a preferred model like `openrouter:anthropic/claude-3.5-sonnet`
or `ollama:llama3:8b`. The router picks the right provider, falls back on
failure, and streams tokens uniformly.
"""
from cue.providers.base import ChatMessage, Provider, StreamEvent
from cue.providers.ollama import OllamaProvider
from cue.providers.openrouter import OpenRouterProvider
from cue.providers.router import resolve, route

__all__ = [
    "ChatMessage",
    "Provider",
    "StreamEvent",
    "OllamaProvider",
    "OpenRouterProvider",
    "resolve",
    "route",
]

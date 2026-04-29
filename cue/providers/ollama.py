from __future__ import annotations

import json
from typing import AsyncIterator

import httpx

from cue.providers.base import ChatMessage, Provider, StreamEvent


class OllamaProvider(Provider):
    name = "ollama"

    def __init__(self, host: str = "127.0.0.1", port: int = 11434) -> None:
        self.base = f"http://{host}:{port}"

    async def list_models(self) -> list[str]:
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.get(f"{self.base}/api/tags")
            r.raise_for_status()
            return sorted(m["name"] for m in r.json().get("models", []))

    async def stream_chat(
        self,
        model: str,
        messages: list[ChatMessage],
        *,
        temperature: float = 0.7,
        max_tokens: int = 1024,
    ) -> AsyncIterator[StreamEvent]:
        payload = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "options": {"temperature": temperature, "num_predict": max_tokens},
            "stream": True,
        }
        async with httpx.AsyncClient(timeout=120) as c:
            async with c.stream("POST", f"{self.base}/api/chat", json=payload) as r:
                if r.status_code != 200:
                    body = (await r.aread()).decode("utf-8", "replace")
                    yield StreamEvent(type="error", error=f"Ollama {r.status_code}: {body}")
                    return
                async for line in r.aiter_lines():
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if "error" in chunk:
                        yield StreamEvent(type="error", error=chunk["error"])
                        return
                    msg = chunk.get("message", {})
                    if tok := msg.get("content"):
                        yield StreamEvent(type="token", content=tok, model=model)
                    if chunk.get("done"):
                        yield StreamEvent(
                            type="done",
                            model=model,
                            prompt_tokens=chunk.get("prompt_eval_count", 0),
                            completion_tokens=chunk.get("eval_count", 0),
                        )
                        return

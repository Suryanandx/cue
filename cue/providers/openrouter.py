from __future__ import annotations

import json
import re
from typing import AsyncIterator

import httpx

from cue.providers.base import ChatMessage, Provider, StreamEvent

BASE_URL = "https://openrouter.ai/api/v1"


def _is_openrouter_chat_model(row: dict) -> bool:
    """Exclude embeddings / rerank endpoints from chat completion listings."""
    mid = str(row.get("id", "")).lower()
    if re.search(r"text-embedding|/(?:embed|embeddings)(?:/|$)|\brerank\b", mid):
        return False
    arch = row.get("architecture") or {}
    modalities = arch.get("input_modalities") or []
    if modalities:
        lowers = {str(x).lower() for x in modalities}
        if "text" not in lowers:
            return False
    return True


class OpenRouterProvider(Provider):
    name = "openrouter"

    def __init__(self, api_key: str, *, site_url: str = "", site_name: str = "Cue") -> None:
        self.api_key = api_key
        self.site_url = site_url
        self.site_name = site_name

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "HTTP-Referer": self.site_url,
            "X-Title": self.site_name,
            "Content-Type": "application/json",
        }

    async def list_models(self) -> list[str]:
        if not self.api_key:
            return []
        async with httpx.AsyncClient(base_url=BASE_URL, headers=self._headers(), timeout=20) as c:
            r = await c.get("/models")
            r.raise_for_status()
            data = r.json().get("data", [])
            return sorted(m["id"] for m in data if _is_openrouter_chat_model(m))

    async def stream_chat(
        self,
        model: str,
        messages: list[ChatMessage],
        *,
        temperature: float = 0.7,
        max_tokens: int = 1024,
    ) -> AsyncIterator[StreamEvent]:
        if not self.api_key:
            yield StreamEvent(type="error", error="OPENROUTER_API_KEY is not set")
            return

        payload = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,
        }

        prompt_tokens = 0
        completion_tokens = 0
        async with httpx.AsyncClient(base_url=BASE_URL, headers=self._headers(), timeout=120) as c:
            async with c.stream("POST", "/chat/completions", json=payload) as r:
                if r.status_code != 200:
                    body = (await r.aread()).decode("utf-8", "replace")
                    yield StreamEvent(type="error", error=f"OpenRouter {r.status_code}: {body}")
                    return
                async for line in r.aiter_lines():
                    if not line or not line.startswith("data: "):
                        continue
                    raw = line[6:].strip()
                    if raw == "[DONE]":
                        break
                    try:
                        chunk = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if "error" in chunk:
                        yield StreamEvent(type="error", error=str(chunk["error"]))
                        return
                    choices = chunk.get("choices", [])
                    if not choices:
                        continue
                    delta = choices[0].get("delta", {})
                    if tok := delta.get("content"):
                        yield StreamEvent(type="token", content=tok, model=model)
                    if usage := chunk.get("usage"):
                        prompt_tokens = usage.get("prompt_tokens", prompt_tokens)
                        completion_tokens = usage.get("completion_tokens", completion_tokens)

        yield StreamEvent(
            type="done",
            model=model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )

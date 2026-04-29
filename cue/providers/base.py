from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator, Literal


@dataclass
class ChatMessage:
    role: Literal["system", "user", "assistant", "tool"]
    content: str


@dataclass
class StreamEvent:
    type: Literal["token", "done", "error", "usage"]
    content: str = ""
    model: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    error: str = ""


class Provider(ABC):
    """Common interface for chat-completion providers."""

    name: str

    @abstractmethod
    async def list_models(self) -> list[str]:
        ...

    @abstractmethod
    async def stream_chat(
        self,
        model: str,
        messages: list[ChatMessage],
        *,
        temperature: float = 0.7,
        max_tokens: int = 1024,
    ) -> AsyncIterator[StreamEvent]:
        ...

    async def health(self) -> bool:
        try:
            await self.list_models()
            return True
        except Exception:
            return False

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import AsyncIterator


class TTSEngine(ABC):
    name: str

    @abstractmethod
    async def synthesize_stream(
        self, text: str, *, voice: str = "default"
    ) -> AsyncIterator[bytes]:
        ...

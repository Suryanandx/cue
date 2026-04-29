from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator


@dataclass
class STTChunk:
    text: str
    is_final: bool = False
    start_ms: int = 0
    end_ms: int = 0


class STTEngine(ABC):
    name: str

    @abstractmethod
    async def transcribe_stream(
        self, audio_chunks: AsyncIterator[bytes]
    ) -> AsyncIterator[STTChunk]:
        ...

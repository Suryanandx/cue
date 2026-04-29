"""Coqui XTTS-v2 backend. Loads only when used; ships behind the `[tts]` extra."""
from __future__ import annotations

from typing import AsyncIterator

from cue.tts.base import TTSEngine


class CoquiEngine(TTSEngine):
    name = "coqui"

    def __init__(self, model: str = "tts_models/multilingual/multi-dataset/xtts_v2") -> None:
        self.model_name = model
        self._tts = None

    def _load(self):
        if self._tts is not None:
            return self._tts
        from TTS.api import TTS  # type: ignore[import-not-found]

        self._tts = TTS(model_name=self.model_name, progress_bar=False)
        return self._tts

    async def synthesize_stream(
        self, text: str, *, voice: str = "default"
    ) -> AsyncIterator[bytes]:
        raise NotImplementedError(
            "Coqui streaming will land in 0.2. For 0.1, the Electron renderer "
            "uses Web Speech API for spoken output."
        )
        if False:  # pragma: no cover
            yield b""

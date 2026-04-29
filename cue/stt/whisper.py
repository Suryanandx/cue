"""Distil-Whisper via Hugging Face transformers (pure Python, pip-installable).

Heavy import lives behind a lazy loader so `cue` works without the [stt] extra.
"""
from __future__ import annotations

from typing import AsyncIterator

from cue.stt.base import STTChunk, STTEngine


class WhisperEngine(STTEngine):
    name = "transformers"

    def __init__(self, model: str = "distil-whisper/distil-large-v3", device: str = "cpu") -> None:
        self.model_name = model
        self.device = device
        self._pipe = None

    def _load(self):
        if self._pipe is not None:
            return self._pipe
        from transformers import pipeline  # type: ignore[import-not-found]

        self._pipe = pipeline(
            "automatic-speech-recognition",
            model=self.model_name,
            device=self.device,
            return_timestamps=True,
        )
        return self._pipe

    async def transcribe_stream(
        self, audio_chunks: AsyncIterator[bytes]
    ) -> AsyncIterator[STTChunk]:
        # Implementation note: the production path will buffer chunks through
        # silero-vad to detect utterance boundaries before invoking Whisper.
        # See https://github.com/huggingface/speech-to-speech for the full
        # VAD → STT handler we model this on.
        raise NotImplementedError(
            "Whisper streaming will land in 0.2. For 0.1, the Electron renderer "
            "captures audio and the daemon receives transcripts already-decoded."
        )
        if False:  # pragma: no cover
            yield STTChunk(text="")

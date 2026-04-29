"""Speech-to-text interfaces.

Default engine is `transformers` running distil-whisper via
huggingface/speech-to-speech-style VAD chunking. Activate by installing the
optional `[stt]` extra and ensuring PyTorch is available.

Other engines: `webspeech` (browser/Electron native), `groq`, `openrouter`.
"""
from cue.stt.base import STTChunk, STTEngine

__all__ = ["STTChunk", "STTEngine"]

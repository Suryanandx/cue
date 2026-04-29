"""Text-to-speech interfaces.

Default engine is `webspeech` (Electron renderer uses native SpeechSynthesis).
Premium engines: `coqui` (XTTS-v2 with voice-cloning), `openai`, `elevenlabs`.
"""
from cue.tts.base import TTSEngine

__all__ = ["TTSEngine"]

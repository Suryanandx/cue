"""Cue configuration.

Reads from ~/.cue/config.toml, falling back to environment variables.
Writes via `cue config set`.
"""
from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field, asdict
from pathlib import Path

import tomli_w
from platformdirs import user_config_dir, user_data_dir

CONFIG_DIR = Path(user_config_dir("cue", appauthor=False))
DATA_DIR = Path(user_data_dir("cue", appauthor=False))
CONFIG_PATH = CONFIG_DIR / "config.toml"
AGENTS_DIR = CONFIG_DIR / "agents"
SESSIONS_DIR = DATA_DIR / "sessions"
KB_DIR = DATA_DIR / "kb"


@dataclass
class DaemonConfig:
    bind: str = "127.0.0.1"
    port: int = 7821
    token: str = ""  # required if bind != 127.0.0.1


@dataclass
class OpenRouterConfig:
    api_key: str = ""
    site_url: str = "https://cue.valthrax.com"
    site_name: str = "Cue"
    default_model: str = "openai/gpt-4o-mini"
    fallback_model: str = "meta-llama/llama-3.1-8b-instruct:free"


@dataclass
class OllamaConfig:
    host: str = "127.0.0.1"
    port: int = 11434
    default_model: str = "llama3:8b"


@dataclass
class STTConfig:
    engine: str = "transformers"  # transformers | webspeech | groq | openrouter
    model: str = "distil-whisper/distil-large-v3"
    chunk_ms: int = 500
    language: str = "en"


@dataclass
class TTSConfig:
    engine: str = "webspeech"  # webspeech | coqui | openai | elevenlabs
    voice: str = "default"
    enabled: bool = False


@dataclass
class UIConfig:
    overlay_width: int = 340
    overlay_height: int = 480
    stealth: bool = True
    always_on_top: bool = True
    click_through: bool = False
    hotkey_toggle: str = "CommandOrControl+\\"
    hotkey_regenerate: str = "CommandOrControl+B"
    hotkey_mute: str = "CommandOrControl+M"


@dataclass
class CueConfig:
    daemon: DaemonConfig = field(default_factory=DaemonConfig)
    openrouter: OpenRouterConfig = field(default_factory=OpenRouterConfig)
    ollama: OllamaConfig = field(default_factory=OllamaConfig)
    stt: STTConfig = field(default_factory=STTConfig)
    tts: TTSConfig = field(default_factory=TTSConfig)
    ui: UIConfig = field(default_factory=UIConfig)
    default_agent: str = "interview-behavioral"

    @classmethod
    def load(cls) -> "CueConfig":
        if not CONFIG_PATH.exists():
            return cls._from_env()
        raw = tomllib.loads(CONFIG_PATH.read_text("utf-8"))
        cfg = cls()
        for section, sub in raw.items():
            if hasattr(cfg, section) and isinstance(sub, dict):
                obj = getattr(cfg, section)
                for k, v in sub.items():
                    if hasattr(obj, k):
                        setattr(obj, k, v)
            elif hasattr(cfg, section):
                setattr(cfg, section, sub)
        cfg = cls._apply_env(cfg)
        return cfg

    @classmethod
    def _from_env(cls) -> "CueConfig":
        return cls._apply_env(cls())

    @staticmethod
    def _apply_env(cfg: "CueConfig") -> "CueConfig":
        if k := os.environ.get("OPENROUTER_API_KEY"):
            cfg.openrouter.api_key = k
        if k := os.environ.get("CUE_DAEMON_BIND"):
            cfg.daemon.bind = k
        if k := os.environ.get("CUE_DAEMON_PORT"):
            cfg.daemon.port = int(k)
        if k := os.environ.get("CUE_DEFAULT_AGENT"):
            cfg.default_agent = k
        return cfg

    def save(self) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(tomli_w.dumps(asdict(self)), "utf-8")


def ensure_dirs() -> None:
    for d in (CONFIG_DIR, DATA_DIR, AGENTS_DIR, SESSIONS_DIR, KB_DIR):
        d.mkdir(parents=True, exist_ok=True)

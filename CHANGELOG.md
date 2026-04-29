# Changelog

## [0.1.0] — 2026-04-30

### Added
- Python package `cue` with `cli`, `daemon`, `providers`, `agents`, `stt`,
  `tts`, `kb` modules.
- FastAPI daemon at `127.0.0.1:7821` exposing `/v1/chat` (SSE), `/v1/agents`,
  `/v1/models`, `/v1/sessions`, `/v1/health`, plus stubs for `/v1/stt` and
  `/v1/tts`. OpenAPI docs at `/docs`.
- LLM router supporting both Ollama (local) and OpenRouter (cloud) with
  per-agent model + fallback configuration and uniform streaming events.
- Five built-in agents shipped as TOML: behavioral, coding, system design,
  sales discovery, meeting notetaker. User agents in `~/.cue/agents/`.
- CLI commands: `init`, `ask`, `daemon start|stop|status|logs`, `agent
  list|show|new|rm|use`, `model list|set`, `config show|set`, `doctor`,
  `start`.
- Electron overlay rebranded from Kenshin → Cue (window title, package id,
  brand strings, IPC namespace `window.cue`, all renderer references).
- Stealth overlay enabled via `BrowserWindow.setContentProtection(true)`
  (window invisible to screen-record / screen-share on macOS and Windows).
- README, OpenAPI docs, project structure ready for `pip install cue`.

### Stubbed (lands in 0.2)
- Live STT via huggingface/speech-to-speech VAD + distil-whisper (interfaces
  in place at `cue.stt`, optional `[stt]` extra installs the model deps).
- Coqui XTTS-v2 voice synthesis + voice cloning (interfaces at `cue.tts`,
  optional `[tts]` extra).
- Knowledge-base ingest in Python (current Electron-side `kb-engine.js`
  remains the v0.1 path).

[0.1.0]: https://github.com/Suryanandx/cue/releases/tag/v0.1.0

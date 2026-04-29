# Cue

**The open-source meeting assistant. Whispers smart, runs local.**

Cue is a Cluely-class overlay that listens to your meetings, understands the
context, and feeds you the right line — without sending your audio, transcripts,
or knowledge base to anyone you didn't choose. Bring your own model: any
OpenRouter endpoint, any local Ollama. Pick your privacy posture: 100% local,
fully cloud, or anywhere in between.

## Download (recommended)

Just want the app? Grab the right binary, paste your OpenRouter key into the
onboarding wizard on first launch, and you're set in under a minute.

| Platform | File | Notes |
|---|---|---|
| **macOS** (Apple Silicon + Intel) | [Cue-x.y.z.dmg](https://github.com/Suryanandx/cue/releases/latest) | Drag to Applications, open, paste key. |
| **Windows** 10/11 | [Cue-Setup-x.y.z.exe](https://github.com/Suryanandx/cue/releases/latest) | NSIS installer with shortcuts. |
| **Linux** (x64 + arm64) | [Cue-x.y.z.AppImage](https://github.com/Suryanandx/cue/releases/latest) | `chmod +x` and run. `.deb` also available. |

Or browse all artifacts on the [latest release](https://github.com/Suryanandx/cue/releases/latest).

The first launch shows an onboarding wizard:
1. Welcome
2. Pick a model provider — **OpenRouter** (paste your key from
   [openrouter.ai/keys](https://openrouter.ai/keys)) or **Ollama** (point at
   your local daemon)
3. Test the connection
4. Done — `⌘ Enter` from anywhere triggers the overlay

## Power-user install (CLI + daemon)

```
pip install cue
cue init
cue daemon start
cue start          # launches the Electron overlay
```

---

## Why Cue exists

Cluely got the feature set right and the philosophy wrong. The right tool for
real-time AI assistance during interviews, sales calls, and meetings should be:

1. **Yours** — open source, Apache-2.0, forkable.
2. **Local-first** — Ollama + on-device STT/TTS by default; cloud is opt-in.
3. **Composable** — every agent is a TOML file you can read, edit, share.
4. **Scriptable** — a documented HTTP daemon under the GUI, for power users.
5. **Honest** — no dark patterns, no hidden telemetry, no upsell wall.

---

## What's in the box

- **Cluely-style overlay** — translucent, always-on-top, survives screen-share
  (`setContentProtection(true)` on Mac and Windows).
- **STT** — `huggingface/speech-to-speech` style VAD + Whisper pipeline (planned
  for 0.2). Web Speech API in v0.1 for zero-config kickoff.
- **TTS** — Coqui XTTS-v2 voice-cloning support (planned for 0.2). Web Speech
  API in v0.1.
- **LLM router** — Ollama (local) and OpenRouter (cloud) side by side with
  per-agent model overrides and auto-fallback.
- **Agent system** — five built-ins shipped (Behavioral, Coding, System Design,
  Sales Discovery, Meeting Notetaker). All TOML, all swappable, all yours.
- **Daemon** — FastAPI service exposing `/v1/chat`, `/v1/agents`, `/v1/stt`,
  `/v1/tts`, `/v1/sessions`, plus OpenAPI docs at `/docs`.
- **CLI** — first-class. Run interviews from the terminal if you want.
- **RAG** — pluggable knowledge base for resume, JD, company research.

---

## Architecture

```
┌──────────────────┐  ┌──────────────────┐
│  Electron GUI    │  │  CLI  (cue ...)  │
│  Cluely-style    │  │                  │
└────────┬─────────┘  └────────┬─────────┘
         │ HTTP / SSE          │
         └─────────┬───────────┘
                   ▼
         ┌──────────────────────────────┐
         │  Cue Daemon (Python FastAPI) │
         │                              │
         │  /v1/stt  →  speech-to-speech │
         │  /v1/tts  →  coqui-tts        │
         │  /v1/chat →  ollama + openrouter │
         │  /v1/agents · /v1/kb · /v1/sessions │
         │                              │
         │  Default bind: 127.0.0.1:7821 │
         └──────────────────────────────┘
```

The daemon is the engine. The GUI and CLI are clients. You can write your own
client — Raycast, OBS plugin, hotkey app, mobile companion — by hitting the
documented HTTP API.

---

## Quickstart

### 1. Install

```bash
pip install cue                     # daemon + CLI
# Optional engines:
pip install "cue[stt]"              # transformers + Whisper
pip install "cue[tts]"              # Coqui XTTS-v2
pip install "cue[kb]"               # LanceDB + PDF/DOCX/XLSX ingest
pip install "cue[all]"              # everything
```

### 2. Set up

```bash
cue init                            # writes ~/.cue/config.toml
cue config set openrouter.api_key sk-or-v1-...
```

### 3. Talk to Cue

```bash
cue ask "explain the CAP theorem in 30 seconds"
cue ask "tell me about a hard project" --agent interview-behavioral
```

### 4. Run the daemon (powers the GUI + scripted clients)

```bash
cue daemon start                    # detaches; PID tracked under ~/.local/share/cue
cue daemon status
cue doctor                          # full health check
```

### 5. Launch the overlay

```bash
cd electron && npm install && npm start
# or, once packaged:
cue start
```

---

## Agents

Agents are TOML files. Five ship built-in:

| Slug                       | Purpose                                          |
| -------------------------- | ------------------------------------------------ |
| `interview-behavioral`     | STAR-format answers tuned to your resume + JD    |
| `interview-coding`         | Code-first answers with reasoning + complexity   |
| `interview-system-design`  | Layered architecture answers, scale + tradeoffs  |
| `sales-discovery`          | MEDDPICC nudges + next questions in real time    |
| `meeting-notetaker`        | Silent listener, structured minutes after        |

Create your own:

```bash
cue agent new my-coach --from interview-behavioral
$EDITOR ~/.cue/agents/my-coach.toml
cue agent use my-coach
```

The daemon picks up changes immediately; no restart.

---

## Models — Ollama and OpenRouter

```bash
cue model list                      # both providers, side by side
cue model set interview-coding openrouter:openai/gpt-4o
cue model set meeting-notetaker ollama:llama3:8b
```

Each agent declares `model` and `fallback`. If primary fails or the call
errors before the first token, the fallback streams in transparently.
Suggested defaults:

| Use            | Provider     | Model                                          |
| -------------- | ------------ | ---------------------------------------------- |
| Live coding    | OpenRouter   | `anthropic/claude-3.5-sonnet`                  |
| Live behavior  | OpenRouter   | `openai/gpt-4o`                                |
| Notetaker      | Ollama       | `llama3:8b` (private, free, fast enough)       |
| Free fallback  | OpenRouter   | `meta-llama/llama-3.1-8b-instruct:free`        |

---

## CLI reference

```
cue init                        first-run setup wizard
cue ask "..."                   one-shot through the default agent
cue daemon start | stop | status | logs
cue start                       launch the GUI overlay

cue agent list / show / new / rm / use
cue model list / set <agent> <model>
cue config show / set <key> <value>
cue doctor                      full diagnostics
```

`cue --help` for the full tree.

---

## REST API

The daemon serves OpenAPI at `http://127.0.0.1:7821/docs`. The endpoints:

| Method | Path                | Purpose                                    |
| ------ | ------------------- | ------------------------------------------ |
| POST   | `/v1/chat`          | SSE token stream through any agent + model |
| GET    | `/v1/agents`        | List all agents                            |
| POST   | `/v1/agents/:slug`  | Create or update an agent                  |
| DELETE | `/v1/agents/:slug`  | Remove a user agent                        |
| GET    | `/v1/models`        | Both Ollama and OpenRouter catalogues      |
| POST   | `/v1/stt`           | Audio in → transcript chunks (planned)     |
| POST   | `/v1/tts`           | Text in → audio out (planned)              |
| GET    | `/v1/sessions`      | Past session transcripts + answers         |
| GET    | `/v1/health`        | Daemon + provider status                   |

LAN-bind requires a token:

```bash
cue config set daemon.bind 0.0.0.0
cue config set daemon.token $(uuidgen)
```

---

## Privacy

- Audio capture happens in the renderer, never persisted unless you call
  `cue session record`.
- Transcripts and KB documents live on your disk under `~/.local/share/cue`.
- The daemon binds to `127.0.0.1` by default. LAN-bind is opt-in and requires
  a bearer token.
- No telemetry. Ever.
- The stealth overlay (`setContentProtection(true)`) hides the window from
  screen-recording and screen-share APIs on macOS and Windows. Use it
  responsibly.

---

## Roadmap

- **0.1** (this release) — Daemon, CLI, 5 agents, Electron overlay rebrand,
  Ollama + OpenRouter routing, REST API, OpenAPI docs.
- **0.2** — Live STT via huggingface/speech-to-speech VAD + distil-whisper.
  Coqui XTTS-v2 streaming TTS. Voice cloning.
- **0.3** — `cue practice` (full Textual TUI mock-interview mode), KB v2 with
  LanceDB.
- **0.4** — Tool-calling agents (web search, Python sandbox, clipboard).
  Marketplace for community-shared `.cue.toml` agents.
- **1.0** — Windows-native overlay parity, frozen Electron + daemon installer.

---

## License

Apache-2.0. Forever. See [LICENSE](./LICENSE).

Part of the [Valthrax](https://valthrax.com) open-source studio. Sibling
projects: [Pressmark](https://pressmark.valthrax.com),
[Switchboard](https://switchboard.valthrax.com),
[Murmur](https://murmur.valthrax.com).

"""Cue daemon — FastAPI app exposing the full pipeline.

Default bind: 127.0.0.1:7821. Same machinery powers the Electron overlay,
the CLI, and any third-party client. OpenAPI docs at /docs.
"""
from __future__ import annotations

import json
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from cue import __version__
from cue.agents import AgentStore
from cue.config import CueConfig
from cue.providers import ChatMessage, route
from cue.providers.ollama import OllamaProvider
from cue.providers.openrouter import OpenRouterProvider


class ChatRequest(BaseModel):
    messages: list[dict]
    agent: str | None = None
    model: str | None = None
    fallback: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None


class AgentBody(BaseModel):
    name: str
    description: str = ""
    model: str = "openrouter:openai/gpt-4o-mini"
    fallback: str = "openrouter:meta-llama/llama-3.1-8b-instruct:free"
    temperature: float = 0.4
    max_tokens: int = 1024
    system_prompt: str = ""
    kb_scope: list[str] = []
    voice: str = "default"
    hotkey: str = ""


def create_app(config: CueConfig | None = None) -> FastAPI:
    cfg = config or CueConfig.load()
    store = AgentStore()

    app = FastAPI(
        title="Cue Daemon",
        version=__version__,
        description="Open-source meeting assistant. Local-first. Bring your own model.",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:*", "https://cue.valthrax.com"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/v1/health")
    async def health() -> dict:
        ollama_ok = await OllamaProvider(cfg.ollama.host, cfg.ollama.port).health()
        openrouter_ok = bool(cfg.openrouter.api_key)
        return {
            "status": "ok",
            "version": __version__,
            "providers": {"ollama": ollama_ok, "openrouter": openrouter_ok},
            "agents": len(store.list()),
            "stt_engine": cfg.stt.engine,
            "tts_engine": cfg.tts.engine,
        }

    @app.get("/v1/agents")
    async def list_agents() -> list[dict]:
        return [
            {
                "slug": a.slug,
                "name": a.name,
                "description": a.description,
                "model": a.model,
                "hotkey": a.hotkey,
                "builtin": a.builtin,
            }
            for a in store.list()
        ]

    @app.get("/v1/agents/{slug}")
    async def get_agent(slug: str) -> dict:
        try:
            a = store.get(slug)
        except KeyError:
            raise HTTPException(404, f"Agent '{slug}' not found")
        return {
            "slug": a.slug,
            "name": a.name,
            "description": a.description,
            "model": a.model,
            "fallback": a.fallback,
            "temperature": a.temperature,
            "max_tokens": a.max_tokens,
            "system_prompt": a.system_prompt,
            "kb_scope": a.kb_scope,
            "voice": a.voice,
            "hotkey": a.hotkey,
            "builtin": a.builtin,
        }

    @app.post("/v1/agents/{slug}")
    async def upsert_agent(slug: str, body: AgentBody) -> dict:
        from cue.agents import Agent

        agent = Agent(slug=slug, **body.model_dump())
        store.save(agent)
        return {"saved": slug}

    @app.delete("/v1/agents/{slug}")
    async def delete_agent(slug: str) -> dict:
        try:
            store.delete(slug)
        except KeyError as e:
            raise HTTPException(404, str(e))
        return {"deleted": slug}

    @app.post("/v1/chat")
    async def chat(req: ChatRequest):
        messages = [ChatMessage(role=m["role"], content=m["content"]) for m in req.messages]

        if req.agent:
            try:
                a = store.get(req.agent)
            except KeyError:
                raise HTTPException(404, f"Agent '{req.agent}' not found")
            if a.system_prompt:
                messages = [ChatMessage(role="system", content=a.system_prompt), *messages]
            primary = req.model or a.model
            fallback = req.fallback or a.fallback
            temperature = req.temperature if req.temperature is not None else a.temperature
            max_tokens = req.max_tokens or a.max_tokens
        else:
            primary = req.model or f"openrouter:{cfg.openrouter.default_model}"
            fallback = req.fallback or f"openrouter:{cfg.openrouter.fallback_model}"
            temperature = req.temperature if req.temperature is not None else 0.4
            max_tokens = req.max_tokens or 1024

        async def event_stream() -> AsyncIterator[dict]:
            async for ev in route(
                primary, fallback, messages, cfg,
                temperature=temperature, max_tokens=max_tokens,
            ):
                yield {"event": ev.type, "data": json.dumps(ev.__dict__)}

        return EventSourceResponse(event_stream())

    @app.get("/v1/models")
    async def list_models() -> dict:
        out: dict[str, list[str]] = {"ollama": [], "openrouter": []}
        try:
            out["ollama"] = await OllamaProvider(cfg.ollama.host, cfg.ollama.port).list_models()
        except Exception:
            pass
        try:
            out["openrouter"] = await OpenRouterProvider(
                cfg.openrouter.api_key,
                site_url=cfg.openrouter.site_url,
                site_name=cfg.openrouter.site_name,
            ).list_models()
        except Exception:
            pass
        return out

    @app.post("/v1/stt")
    async def stt() -> dict:
        # TODO: Wire huggingface/speech-to-speech VAD + Whisper handlers here.
        # For v0 the Electron renderer handles audio capture and posts chunks
        # back through this endpoint.
        return {"engine": cfg.stt.engine, "ready": False, "note": "STT engine not wired yet"}

    @app.post("/v1/tts")
    async def tts() -> dict:
        # TODO: Coqui XTTS-v2 integration. Default v0 path uses Web Speech API in renderer.
        return {"engine": cfg.tts.engine, "ready": cfg.tts.engine == "webspeech"}

    @app.get("/v1/sessions")
    async def list_sessions() -> list[dict]:
        from cue.config import SESSIONS_DIR
        return [
            {"id": p.stem, "path": str(p)}
            for p in sorted(SESSIONS_DIR.glob("*.json"), reverse=True)
        ]

    return app

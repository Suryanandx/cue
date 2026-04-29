"""End-to-end chat tests: POST /v1/chat through FastAPI with mocked upstream LLMs.

Covers OpenRouter streaming, Ollama streaming, agent system prompts, 404 agent,
primary→fallback routing, and missing API key — without real network calls.
"""
from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
import respx
from httpx import ASGITransport, AsyncClient

from cue.config import CueConfig, OpenRouterConfig
from cue.daemon.api import create_app


def _openrouter_data_line(obj: dict[str, Any]) -> bytes:
    return ("data: " + json.dumps(obj) + "\n\n").encode()


def _openrouter_stream_ok(content_parts: list[str]) -> bytes:
    parts: list[bytes] = []
    for p in content_parts:
        parts.append(
            _openrouter_data_line({"choices": [{"delta": {"content": p}}]})
        )
    parts.append(b"data: [DONE]\n\n")
    return b"".join(parts)


def _ollama_lines(chunks: list[tuple[str, bool]], *, eval_count: int = 2) -> bytes:
    """Each tuple is (content_piece, is_final_done_line)."""
    out = []
    for i, (content, done) in enumerate(chunks):
        payload: dict[str, Any] = {"model": "llama3:8b", "message": {"content": content}}
        if done:
            payload["done"] = True
            payload["prompt_eval_count"] = 1
            payload["eval_count"] = eval_count
        else:
            payload["done"] = False
        out.append(json.dumps(payload))
    return ("\n".join(out) + "\n").encode()


async def _collect_chat_sse(client: AsyncClient, payload: dict) -> list[tuple[str, dict]]:
    """Parse SSE from /v1/chat into [(event_name, parsed_json_data), ...]."""
    events: list[tuple[str, dict]] = []
    async with client.stream("POST", "/v1/chat", json=payload) as response:
        assert response.status_code == 200, response.text
        buf = ""
        async for chunk in response.aiter_text():
            # sse-starlette uses CRLF between fields and blank line between events
            buf += chunk.replace("\r\n", "\n")
            while "\n\n" in buf:
                block, buf = buf.split("\n\n", 1)
                ev_name: str | None = None
                data_lines: list[str] = []
                for line in block.split("\n"):
                    if line.startswith("event:"):
                        ev_name = line[6:].strip()
                    elif line.startswith("data:"):
                        data_lines.append(line[5:].strip())
                if ev_name is not None and data_lines:
                    events.append((ev_name, json.loads("".join(data_lines))))
    return events


@pytest.fixture
def cfg_openrouter() -> CueConfig:
    c = CueConfig()
    c.openrouter = OpenRouterConfig(
        api_key="sk-test-key",
        default_model="openai/gpt-4o-mini",
        fallback_model="meta-llama/llama-3.1-8b-instruct:free",
    )
    return c


@pytest.mark.asyncio
async def test_chat_openrouter_default_model_streams_tokens_and_done(cfg_openrouter: CueConfig):
    app = create_app(cfg_openrouter)
    body = _openrouter_stream_ok(["Hello", " world"])

    with respx.mock:
        respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(200, content=body)
        )
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            evs = await _collect_chat_sse(
                client,
                {"messages": [{"role": "user", "content": "Say hi"}]},
            )

    types = [e[0] for e in evs]
    assert "token" in types
    assert types[-1] == "done"
    texts = [json.loads(json.dumps(e[1])) for e in evs if e[0] == "token"]
    joined = "".join(d["content"] for d in texts)
    assert joined == "Hello world"
    done_payload = next(e[1] for e in evs if e[0] == "done")
    assert done_payload.get("type") == "done"


@pytest.mark.asyncio
async def test_chat_ollama_model_streams(cfg_openrouter: CueConfig):
    app = create_app(cfg_openrouter)
    olines = _ollama_lines([("Yes", False), ("", True)])

    with respx.mock:
        respx.post("http://127.0.0.1:11434/api/chat").mock(
            return_value=httpx.Response(200, content=olines)
        )
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            evs = await _collect_chat_sse(
                client,
                {
                    "messages": [{"role": "user", "content": "Ping"}],
                    "model": "ollama:llama3:8b",
                },
            )

    tokens = [e[1]["content"] for e in evs if e[0] == "token"]
    assert "".join(tokens) == "Yes"
    assert any(e[0] == "done" for e in evs)


@pytest.mark.asyncio
async def test_chat_with_builtin_agent_prepends_system_prompt(cfg_openrouter: CueConfig):
    app = create_app(cfg_openrouter)
    captured: dict[str, Any] = {}

    def capture_and_stream(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content.decode())
        msgs = captured["body"]["messages"]
        assert msgs[0]["role"] == "system"
        assert "interview co-pilot" in msgs[0]["content"].lower()
        assert msgs[-1]["content"] == "One short tip."
        return httpx.Response(200, content=_openrouter_stream_ok(["OK"]))

    with respx.mock:
        respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            side_effect=capture_and_stream
        )
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            evs = await _collect_chat_sse(
                client,
                {
                    "messages": [{"role": "user", "content": "One short tip."}],
                    "agent": "interview",
                },
            )

    assert any(e[0] == "token" for e in evs)
    assert captured["body"]["model"] == "anthropic/claude-3.5-sonnet"


@pytest.mark.asyncio
async def test_chat_unknown_agent_404(cfg_openrouter: CueConfig):
    app = create_app(cfg_openrouter)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.post(
            "/v1/chat",
            json={
                "messages": [{"role": "user", "content": "x"}],
                "agent": "this-agent-does-not-exist-zz99",
            },
        )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_chat_fallback_when_primary_http_error(cfg_openrouter: CueConfig):
    """Router switches to fallback when primary returns non-200 before any token."""
    app = create_app(cfg_openrouter)
    ok_body = _openrouter_stream_ok(["from-fallback"])

    with respx.mock:
        respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            side_effect=[
                httpx.Response(503, text="upstream bad"),
                httpx.Response(200, content=ok_body),
            ]
        )
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            evs = await _collect_chat_sse(
                client,
                {"messages": [{"role": "user", "content": "Hi"}]},
            )

    texts = [e[1].get("content", "") for e in evs if e[0] == "token"]
    assert "".join(texts) == "from-fallback"


@pytest.mark.asyncio
async def test_chat_no_api_key_returns_error_event():
    cfg = CueConfig()
    cfg.openrouter = OpenRouterConfig(api_key="")
    app = create_app(cfg)

    with respx.mock:
        # No outbound calls expected for missing key on openrouter path
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            evs = await _collect_chat_sse(
                client,
                {
                    "messages": [{"role": "user", "content": "Hi"}],
                    "model": "openrouter:openai/gpt-4o-mini",
                },
            )

    assert evs[0][0] == "error"
    assert "OPENROUTER" in evs[0][1].get("error", "").upper() or "api" in evs[0][1].get(
        "error", ""
    ).lower()


@pytest.mark.asyncio
async def test_chat_invalid_model_spec_returns_error_event(cfg_openrouter: CueConfig):
    app = create_app(cfg_openrouter)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        evs = await _collect_chat_sse(
            client,
            {
                "messages": [{"role": "user", "content": "x"}],
                "model": "openrouter:",
            },
        )
    assert evs[0][0] == "error"
    assert "empty" in evs[0][1].get("error", "").lower() or "invalid" in evs[0][1].get("error", "").lower()


@pytest.mark.asyncio
async def test_chat_explicit_model_override_on_agent(cfg_openrouter: CueConfig):
    """Request model= overrides agent default when both are openrouter."""
    app = create_app(cfg_openrouter)
    captured: dict[str, Any] = {}

    def capture(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content.decode())
        return httpx.Response(200, content=_openrouter_stream_ok(["x"]))

    with respx.mock:
        respx.post("https://openrouter.ai/api/v1/chat/completions").mock(side_effect=capture)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            await _collect_chat_sse(
                client,
                {
                    "messages": [{"role": "user", "content": "q"}],
                    "agent": "interview",
                    "model": "openrouter:openai/gpt-4o-mini",
                },
            )

    assert captured["body"]["model"] == "openai/gpt-4o-mini"

"""Unit tests: OpenRouter chat vs non-chat model filtering (free tier listings)."""
from __future__ import annotations

import pytest

from cue.providers.openrouter import _is_openrouter_chat_model


@pytest.mark.parametrize(
    "model_id,expect_chat",
    [
        ("meta-llama/llama-3.1-8b-instruct:free", True),
        ("openrouter/auto", True),
        ("anthropic/claude-3.5-sonnet", True),
        ("openai/text-embedding-3-small", False),
        ("openai/text-embedding-ada-002", False),
    ],
)
def test_chat_model_filter_by_id(model_id: str, expect_chat: bool) -> None:
    row = {"id": model_id}
    assert _is_openrouter_chat_model(row) is expect_chat


def test_chat_model_requires_text_modality_when_present() -> None:
    assert _is_openrouter_chat_model(
        {"id": "x/y", "architecture": {"input_modalities": ["image"]}}
    ) is False
    assert _is_openrouter_chat_model(
        {"id": "x/y", "architecture": {"input_modalities": ["text"]}}
    ) is True

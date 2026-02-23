"""
Unit tests for Cursor CLI routing in the bridge.
"""

import asyncio
import json

import pytest

from src.sandbox.bridge import AgentBridge


class FakePipe:
    def __init__(self, lines: list[str]):
        self._lines = [line.encode("utf-8") + b"\n" for line in lines]

    async def readline(self) -> bytes:
        if not self._lines:
            return b""
        return self._lines.pop(0)


class FakeProcess:
    def __init__(self, stdout_lines: list[str], stderr_lines: list[str], returncode: int):
        self.stdout = FakePipe(stdout_lines)
        self.stderr = FakePipe(stderr_lines)
        self.returncode = returncode

    async def wait(self) -> int:
        return self.returncode


@pytest.mark.asyncio
async def test_stream_cursor_cli_maps_events_and_persists_session(monkeypatch):
    bridge = AgentBridge(
        sandbox_id="sb-1",
        session_id="sess-1",
        control_plane_url="http://localhost:8787",
        auth_token="token-1",
    )

    lines = [
        json.dumps(
            {
                "type": "system",
                "subtype": "init",
                "session_id": "cursor-session-123",
            }
        ),
        json.dumps(
            {
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": "hello from cursor"}]},
                "session_id": "cursor-session-123",
            }
        ),
        json.dumps(
            {
                "type": "tool_call",
                "subtype": "started",
                "call_id": "call-1",
                "tool_call": {"readToolCall": {"args": {"path": "README.md"}}},
                "session_id": "cursor-session-123",
            }
        ),
        json.dumps(
            {
                "type": "tool_call",
                "subtype": "completed",
                "call_id": "call-1",
                "tool_call": {
                    "readToolCall": {
                        "args": {"path": "README.md"},
                        "result": {"success": {"content": "ok"}},
                    }
                },
                "session_id": "cursor-session-123",
            }
        ),
        json.dumps(
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "result": "done",
                "session_id": "cursor-session-123",
            }
        ),
    ]

    async def fake_create_subprocess_exec(*_args, **_kwargs):
        return FakeProcess(lines, [], 0)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    events = []
    async for event in bridge._stream_cursor_cli_response(
        message_id="msg-1",
        content="test prompt",
        model="openai/gpt-5.2-codex",
    ):
        events.append(event)

    assert any(e["type"] == "token" and e["content"] == "hello from cursor" for e in events)
    assert any(e["type"] == "tool_call" and e["callId"] == "call-1" for e in events)
    assert any(e["type"] == "tool_result" and e["callId"] == "call-1" for e in events)
    assert bridge.cursor_session_id == "cursor-session-123"


@pytest.mark.asyncio
async def test_handle_prompt_cursor_surfaces_429_error(monkeypatch):
    bridge = AgentBridge(
        sandbox_id="sb-1",
        session_id="sess-1",
        control_plane_url="http://localhost:8787",
        auth_token="token-1",
    )
    sent_events: list[dict] = []

    async def capture_send(event: dict) -> None:
        sent_events.append(event)

    bridge._send_event = capture_send

    async def fake_create_subprocess_exec(*_args, **_kwargs):
        return FakeProcess([], ["HTTP 429 Too Many Requests"], 1)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    await bridge._handle_prompt(
        {
            "type": "prompt",
            "messageId": "msg-429",
            "content": "trigger rate limit",
            "providerMode": "cursor",
        }
    )

    error_events = [e for e in sent_events if e.get("type") == "error"]
    completion_events = [e for e in sent_events if e.get("type") == "execution_complete"]

    assert error_events
    assert "429" in (error_events[-1].get("error") or "")
    assert completion_events
    assert completion_events[-1]["success"] is False
    assert "429" in (completion_events[-1].get("error") or "")

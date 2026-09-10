"""语音助理（模块 20）：回合、动作、待确认、例程、与对话页的隔离。模型用 FunctionModel 编脚本。"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel
from sqlalchemy import select

from app.routers import assistant as assistant_router
from domain import assistant, briefing
from domain.model_runtime import ModelRuntimeError
from domain.models import GoogleAccount, MailMessage, ProviderCredential, TalkSession, TalkTurn


def scripted(*steps):
    """按顺序回放：每步是 (tool_name, args) 或 一句文本；工具结果回来后走下一步。"""
    calls: list[list[ModelMessage]] = []

    def function(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        calls.append(list(messages))
        step = steps[min(len(calls) - 1, len(steps) - 1)]
        if isinstance(step, str):
            return ModelResponse(parts=[TextPart(content=step)])
        name, args = step
        return ModelResponse(parts=[ToolCallPart(tool_name=name, args=args)])

    return FunctionModel(function), calls


@pytest.fixture
def routed(monkeypatch):
    async def fake_route(capability, operation, **_):
        return {"capability": capability, "operation": operation}

    monkeypatch.setattr(assistant_router, "prepare_chat_route", fake_route)

    def use(model):
        monkeypatch.setattr(assistant, "model_for", lambda _cap, _route: model)

    return use


async def test_open_page_turn_returns_navigate_action(client, routed):
    model, calls = scripted(("open_page", {"page": "邮件"}), "打开了")
    routed(model)
    r = await client.post("/assistant/turn", data={"text": "帮我打开邮件", "route": "/read"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reply"] == "打开了"
    assert body["actions"] == [{"kind": "navigate", "to": "/mail", "label": "打开邮件"}]
    assert body["pending"] == []
    assert body["capability"] == "chat-general"
    # 系统提示词带着当前页面
    first_request = calls[0][0]
    assert any("/read" in getattr(p, "content", "") for p in first_request.parts)

    # 同一会话第二轮要带上文
    r2 = await client.post(
        "/assistant/turn", data={"text": "再打开词汇", "session_id": body["session_id"]}
    )
    assert r2.status_code == 200
    assert r2.json()["session_id"] == body["session_id"]
    history_texts = [
        getattr(p, "content", "") for m in calls[-1] for p in m.parts if hasattr(p, "content")
    ]
    assert "帮我打开邮件" in history_texts and "打开了" in history_texts


async def test_unbound_model_is_503_not_silent(client, monkeypatch):
    async def boom(*_a, **_k):
        raise ModelRuntimeError("assistant 未绑定")

    monkeypatch.setattr(assistant_router, "prepare_chat_route", boom)
    r = await client.post("/assistant/turn", data={"text": "你好"})
    assert r.status_code == 503
    assert "语音助理" in r.json()["detail"]


async def test_empty_turn_rejected(client, routed):
    routed(scripted("不该到这")[0])
    r = await client.post("/assistant/turn", data={"text": "   "})
    assert r.status_code == 400


async def test_draft_reply_is_pending_until_approved(client, session, routed, monkeypatch):
    cred = ProviderCredential(
        name="me@example.com", kind="oauth", provider_type="google_account", config={}
    )
    session.add(cred)
    await session.flush()
    account = GoogleAccount(email="me@example.com", credential_id=cred.id)
    session.add(account)
    await session.flush()
    msg = MailMessage(
        account_id=account.id,
        gmail_id="g1",
        thread_id="t1",
        from_name="Ken",
        from_addr="ken@example.com",
        subject="Lunch?",
        snippet="tomorrow?",
        sent_at=datetime(2026, 9, 1, tzinfo=UTC),
        unread=True,
    )
    session.add(msg)
    await session.commit()

    model, _ = scripted(
        ("draft_reply", {"message_id": msg.id, "body": "Sure, noon works."}), "起草好了，等你确认"
    )
    routed(model)
    r = await client.post("/assistant/turn", data={"text": "回复 Ken 说中午可以"})
    assert r.status_code == 200, r.text
    pending = r.json()["pending"]
    assert len(pending) == 1
    item = pending[0]
    assert item["type"] == "send_mail"
    assert item["payload"]["to"] == "ken@example.com"
    assert item["payload"]["subject"] == "Re: Lunch?"
    assert item["payload"]["reply_to_message_id"] == msg.id

    sent: list[dict] = []

    async def fake_send(body, _session):
        assert body.confirm is True
        sent.append(body.model_dump())
        return {"id": "sent-1"}

    monkeypatch.setattr(assistant_router, "send_mail", fake_send)
    r2 = await client.post(
        "/assistant/approve", json={"type": item["type"], "payload": item["payload"]}
    )
    assert r2.status_code == 200, r2.text
    assert sent and sent[0]["to"] == "ken@example.com" and sent[0]["body"] == "Sure, noon works."

    r3 = await client.post("/assistant/approve", json={"type": "launch_rockets", "payload": {}})
    assert r3.status_code == 400


async def test_tool_catalog_matches_registered_tools():
    agent = assistant.build_agent(TestModel())
    registered = set(agent._function_toolset.tools)
    assert registered == {name for name, _g, _d in assistant.TOOL_CATALOG}


async def test_tools_endpoint(client):
    r = await client.get("/assistant/tools")
    assert r.status_code == 200
    assert {t["name"] for t in r.json()} == {name for name, _g, _d in assistant.TOOL_CATALOG}


async def test_morning_brief_without_google(client, session):
    text, payload = await briefing.compose_morning_brief(session)
    assert text.startswith("早上好。")
    assert "任务都空着" in text and "没有到期" in text
    assert payload["mail"] is None and payload["calendar"] is None
    assert payload["tasks"] == {"running": 0, "failed_24h": 0}

    r = await client.post("/assistant/routines/morning_brief/run")
    assert r.status_code == 200, r.text
    assert r.json()["last"]["text"] == text
    assert r.json()["schedule_label"] == "每天 07:30"

    r = await client.get("/assistant/brief/today")
    assert r.json()["brief"]["text"] == text
    r = await client.get("/home")
    assert r.json()["brief"]["text"] == text
    r = await client.get("/assistant/routines")
    assert [x["key"] for x in r.json()] == ["morning_brief"]

    r = await client.post("/assistant/routines/nope/run")
    assert r.status_code == 404


async def test_assistant_sessions_stay_out_of_talk_history(client, session):
    talk = TalkSession(mode="assistant", user_id="owner")
    session.add(talk)
    await session.flush()
    session.add(TalkTurn(session_id=talk.id, ordinal=1, role="user", text="hi"))
    session.add(
        TalkTurn(
            session_id=talk.id,
            ordinal=2,
            role="assistant",
            text="hello",
            feedback={"actions": [{"kind": "navigate", "to": "/"}], "pending": []},
        )
    )
    await session.commit()

    r = await client.get("/talk/sessions")
    assert r.status_code == 200
    assert talk.id not in {s["id"] for s in r.json()}
    r = await client.get("/assistant/sessions")
    assert [s["id"] for s in r.json()] == [talk.id]
    turns = r.json()[0]["turns"]
    assert [t["role"] for t in turns] == ["user", "assistant"]
    assert turns[1]["actions"][0]["to"] == "/"
    r = await client.get("/home")
    assert r.json()["continue"]["talk"] is None

    stmt = select(TalkSession).where(TalkSession.mode == "assistant")
    rows = (await session.execute(stmt)).scalars().all()
    assert len(rows) == 1


async def test_tts_assistant_scene_falls_back_to_bilingual_edge_voice(
    client, monkeypatch, tmp_path
):
    from types import SimpleNamespace

    from app.routers import tts as tts_router

    seen: dict = {}

    async def fake_synthesis(prepared, *, text, voice_id, rate, path):
        seen["voice"] = voice_id
        seen["plugin"] = prepared.snapshot.plugin_id
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"ID3fake")
        return SimpleNamespace(path=path, provider="edge-tts", stream=None)

    monkeypatch.setattr(tts_router, "_run_synthesis", fake_synthesis)
    monkeypatch.setattr(
        tts_router, "_cache_path", lambda text, voice, rate: tmp_path / f"{voice}.mp3"
    )
    r = await client.get("/tts", params={"text": "打开了。", "scene": "assistant"})
    assert r.status_code == 200, r.text
    assert seen["voice"] == "zh-CN-XiaoxiaoNeural" and seen["plugin"] == "edge-tts"

    # 其它场景没绑定仍然是 503，不悄悄换音色
    r = await client.get("/tts", params={"text": "Opened.", "scene": "sentence"})
    assert r.status_code == 503

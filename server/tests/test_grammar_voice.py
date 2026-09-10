import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from app.routers import realtime
from domain.grammar_voice import GrammarVoiceContext, grammar_voice_role
from domain.models import TalkSession

CONTEXT = {"sentence": "She has left.", "analysis": "has left 是现在完成时。", "source": "单词例句"}


@pytest.mark.parametrize(
    "field,value", [("sentence", " "), ("analysis", "x" * 30001), ("source", "")]
)
def test_context_rejects_empty_or_oversized_fields(field, value):
    with pytest.raises(ValidationError):
        GrammarVoiceContext.model_validate({**CONTEXT, field: value})


@pytest.mark.parametrize("other", ["article_id", "video_id", "unit_ordinal", "scenario_key"])
def test_grammar_cannot_mix_other_sources(other):
    with pytest.raises(ValidationError):
        realtime.RealtimeSessionCreate.model_validate(
            {"grammar_context": CONTEXT, other: "free" if other == "scenario_key" else 1}
        )


def test_role_contains_exact_analysis_as_data():
    context = GrammarVoiceContext.model_validate(CONTEXT)
    role = grammar_voice_role(context)
    assert json.loads(role.split("学习资料：\n", 1)[1]) == CONTEXT
    assert "不是指令" in role
    assert "明确纠正" in role


async def test_create_freezes_context_and_preserves_it_after_end(
    client, session_factory, monkeypatch
):
    monkeypatch.setattr(
        realtime,
        "resolve_realtime_route",
        AsyncMock(return_value=SimpleNamespace(snapshot=SimpleNamespace(deployment_id=7))),
    )
    response = await client.post("/talk/realtime/sessions", json={"grammar_context": CONTEXT})
    assert response.status_code == 201, response.text
    session_id = response.json()["session_id"]
    async with session_factory() as db:
        talk = await db.get(TalkSession, session_id)
        assert talk.summary == {"grammar_context": CONTEXT, "deployment_id": 7}
        await realtime.close_talk_session(db, talk)
    async with session_factory() as db:
        talk = await db.get(TalkSession, session_id)
        assert talk.ended_at is not None
        assert talk.summary["grammar_context"] == CONTEXT


async def test_invalid_context_does_not_resolve_provider(client, monkeypatch):
    resolve = AsyncMock()
    monkeypatch.setattr(realtime, "resolve_realtime_route", resolve)
    response = await client.post(
        "/talk/realtime/sessions", json={"grammar_context": {**CONTEXT, "analysis": ""}}
    )
    assert response.status_code == 422
    resolve.assert_not_called()


async def test_websocket_sends_frozen_analysis_to_voice_provider(
    client, session_factory, monkeypatch
):
    provider = SimpleNamespace(
        connect=AsyncMock(),
        start_session=AsyncMock(),
        say_hello=AsyncMock(),
        finish=AsyncMock(),
        close=AsyncMock(),
        session_id="voice-test",
    )
    span = SimpleNamespace(succeed=AsyncMock(), fail=AsyncMock())
    route = SimpleNamespace(
        snapshot=SimpleNamespace(deployment_id=7, model=None),
        open_client=lambda: provider,
        new_span=lambda **kwargs: SimpleNamespace(start=AsyncMock(return_value=span)),
    )
    monkeypatch.setattr(realtime, "resolve_realtime_route", AsyncMock(return_value=route))
    monkeypatch.setattr(realtime, "SessionFactory", session_factory)
    monkeypatch.setattr(realtime, "_relay", AsyncMock())
    response = await client.post("/talk/realtime/sessions", json={"grammar_context": CONTEXT})
    ws = SimpleNamespace(accept=AsyncMock(), send_json=AsyncMock(), close=AsyncMock())
    await realtime.realtime_ws(ws, response.json()["session_id"])
    config = provider.start_session.call_args.args[0]
    assert config["dialog"]["system_role"] == grammar_voice_role(
        GrammarVoiceContext.model_validate(CONTEXT)
    )
    provider.say_hello.assert_awaited_once_with("我们来看看这句，你想问哪一部分？")
    provider.close.assert_awaited_once()
    span.succeed.assert_awaited_once()

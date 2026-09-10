import pytest

from domain.llm import LLMUnavailable
from domain.scenarios import get_scenario, list_scenarios
from domain.talk import (
    DIFFICULTY_STYLES,
    _normalize_coach,
    _normalize_feedback,
    build_coach_prompt,
    build_system_prompt,
)

EXPECTED_KEYS = {
    "hotel_checkin",
    "restaurant_order",
    "asking_directions",
    "airport_checkin",
    "shopping_return",
    "work_meeting",
    "job_interview",
    "phone_call",
    "doctor_visit",
    "small_talk",
}


def test_all_scenarios_loaded() -> None:
    scenarios = list_scenarios()
    assert {s["key"] for s in scenarios} == EXPECTED_KEYS
    assert len(scenarios) == 10


def test_scenario_fields_complete() -> None:
    for s in list_scenarios():
        assert s["title"] and s["title_en"] and s["level"]
        assert s["role_ai"] and s["role_user"] and s["goal"]
        assert s["opening_line"].strip()
        assert len(s["key_sentences"]) == 3
        for pair in s["key_sentences"]:
            assert pair["en"].strip() and pair["zh"].strip()
        assert len(s["hints"]) == 2


def test_get_scenario() -> None:
    scenario = get_scenario("hotel_checkin")
    assert scenario is not None
    assert scenario["title"] == "酒店入住"
    assert get_scenario("no_such_scenario") is None


def test_system_prompt_injects_scenario() -> None:
    scenario = get_scenario("hotel_checkin")
    prompt = build_system_prompt(scenario, "medium")
    assert scenario["role_ai"] in prompt
    assert scenario["goal"] in prompt
    assert "JSON" in prompt
    assert "reply" in prompt and "feedback" in prompt
    assert "英语" in prompt  # 始终英语回复的规则


def test_system_prompt_difficulty_styles() -> None:
    scenario = get_scenario("small_talk")
    for difficulty, style in DIFFICULTY_STYLES.items():
        assert style in build_system_prompt(scenario, difficulty)
    # 未知难度回退 medium
    assert DIFFICULTY_STYLES["medium"] in build_system_prompt(scenario, "unknown")


def test_system_prompt_free_talk() -> None:
    prompt = build_system_prompt(None, "easy")
    assert "自由对话" in prompt
    assert DIFFICULTY_STYLES["easy"] in prompt


def test_normalize_feedback() -> None:
    assert _normalize_feedback({"level": "ok", "note": "表达自然"}) == {
        "level": "ok",
        "note": "表达自然",
    }
    assert _normalize_feedback(
        {"level": "improve", "note": "时态有误", "better": "I went there yesterday."}
    ) == {"level": "improve", "note": "时态有误", "better": "I went there yesterday."}
    # improve 缺 better / 非法 level / 非 dict 一律丢弃
    assert _normalize_feedback({"level": "improve", "note": "x"}) is None
    assert _normalize_feedback({"level": "great", "note": "x"}) is None
    assert _normalize_feedback("ok") is None
    assert _normalize_feedback(None) is None


def test_coach_prompt_uses_message_context_and_level() -> None:
    scenario = get_scenario("hotel_checkin")
    system, payload = build_coach_prompt("May I see your passport, please?", "easy", scenario)
    assert "恰好 3" in system
    assert "自动" not in system
    assert "May I see your passport" in payload
    assert DIFFICULTY_STYLES["easy"] in payload
    assert scenario["title"] in payload


def test_normalize_coach_requires_three_complete_replies() -> None:
    result = _normalize_coach(
        {
            "translation": "请给我看一下护照。",
            "intent": "前台正在礼貌核验身份。",
            "replies": [
                {"en": "Of course. Here it is.", "zh": "当然，给您。", "tone": "简短"},
                {"en": "Sure, I have it right here.", "zh": "好的，就在这里。", "tone": "自然"},
                {
                    "en": "Certainly. Do you also need my booking confirmation?",
                    "zh": "当然。您还需要预订确认单吗？",
                    "tone": "主动",
                },
            ],
        }
    )
    assert result["translation"] == "请给我看一下护照。"
    assert len(result["replies"]) == 3

    with pytest.raises(LLMUnavailable):
        _normalize_coach(
            {
                "translation": "翻译",
                "intent": "意图",
                "replies": [{"en": "One.", "zh": "一。"}],
            }
        )


async def test_coach_endpoint_uses_owned_session_context(client, monkeypatch) -> None:
    from app.routers import talk as talk_router

    seen: dict = {}

    async def fake_coach(text, difficulty, scenario, **options):
        seen.update(text=text, difficulty=difficulty, scenario=scenario, **options)
        return {
            "translation": "晚上好，欢迎光临。您预订了吗？",
            "intent": "前台正在确认入住预订。",
            "replies": [
                {"en": "Yes, I do.", "zh": "是的。", "tone": "简短"},
                {"en": "Yes, it is under Li.", "zh": "有的，姓李。", "tone": "自然"},
                {
                    "en": "Yes, I booked a room for two nights.",
                    "zh": "有的，我订了两晚。",
                    "tone": "具体",
                },
            ],
        }

    monkeypatch.setattr(talk_router, "coach_message", fake_coach)
    created = await client.post(
        "/talk/sessions",
        json={"mode": "text", "scenario_key": "hotel_checkin", "difficulty": "easy"},
    )
    assert created.status_code == 201
    session_id = created.json()["id"]

    response = await client.post(
        f"/talk/sessions/{session_id}/coach",
        json={"text": "Do you have a reservation?"},
    )
    assert response.status_code == 200
    assert len(response.json()["replies"]) == 3
    assert seen["difficulty"] == "easy"
    assert seen["scenario"]["key"] == "hotel_checkin"
    assert seen["variant"] == 0
    assert seen["previous_replies"] == []
    alternate = await client.post(
        f"/talk/sessions/{session_id}/coach",
        json={
            "text": "Do you have a reservation?",
            "variant": 1,
            "previous_replies": ["Yes, I do."],
        },
    )
    assert alternate.status_code == 200
    assert seen["variant"] == 1
    assert seen["previous_replies"] == ["Yes, I do."]
    for options in [
        {"variant": -1},
        {"variant": 20},
        {"previous_replies": ["a"] * 58},
        {"previous_replies": ["a" * 1001]},
    ]:
        invalid = await client.post(
            f"/talk/sessions/{session_id}/coach",
            json={"text": "Hello", **options},
        )
        assert invalid.status_code == 422

    empty = await client.post(
        f"/talk/sessions/{session_id}/coach",
        json={"text": "   "},
    )
    assert empty.status_code == 400


@pytest.mark.parametrize("replies", [1, "reply", {}, None])
def test_normalize_coach_rejects_non_list_replies(replies) -> None:
    with pytest.raises(LLMUnavailable):
        _normalize_coach({"translation": "翻译", "intent": "意图", "replies": replies})


def test_normalize_coach_rejects_non_text_fields() -> None:
    with pytest.raises(LLMUnavailable):
        _normalize_coach({"translation": {"text": "翻译"}, "intent": "意图", "replies": []})


def test_coach_variants_include_history_as_data() -> None:
    import json

    system, payload = build_coach_prompt(
        "Hello",
        "easy",
        variant=2,
        previous_replies=["I like travel."],
    )
    assert json.loads(payload)["variant"] == 2
    assert json.loads(payload)["previous_replies"] == ["I like travel."]
    assert "待分析的数据" in system


async def test_coach_rejects_repeated_history(monkeypatch) -> None:
    import domain.talk as talk

    async def complete(*args):
        return (
            {
                "translation": "你好",
                "intent": "问候",
                "replies": [
                    {"en": "Hello!", "zh": "你好", "tone": "简短"},
                    {"en": "Good morning.", "zh": "早上好", "tone": "自然"},
                    {"en": "How are you?", "zh": "你好吗", "tone": "询问"},
                ],
            },
            "test",
            1,
        )

    monkeypatch.setattr(talk, "complete_json", complete)
    with pytest.raises(LLMUnavailable, match="历史重复"):
        await talk.coach_message("Hello", "easy", variant=1, previous_replies=[" hello! "])


@pytest.mark.parametrize("sentences", [["Hello", "hello", "Hi"], ["a" * 1001, "Hi", "Bye"]])
def test_coach_rejects_duplicate_or_oversized_replies(sentences) -> None:
    with pytest.raises(LLMUnavailable):
        _normalize_coach(
            {
                "translation": "你好",
                "intent": "问候",
                "replies": [
                    {"en": sentence, "zh": "你好", "tone": "简短"} for sentence in sentences
                ],
            }
        )

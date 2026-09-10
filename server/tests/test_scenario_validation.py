from domain.scenarios import (
    _normalize_draft,
    is_builtin_key,
    list_scenarios,
    sanitize_scenario,
    validate_scenario,
)

VALID = {
    "key": "coffee_order",
    "title": "咖啡店点单",
    "title_en": "Ordering Coffee",
    "level": "A2",
    "role_ai": "咖啡师",
    "role_user": "顾客",
    "goal": "点一杯定制咖啡并完成支付",
    "opening_line": "Hi! What can I get started for you today?",
    "key_sentences": [
        {"en": "Could I get a latte with oat milk?", "zh": "能来一杯燕麦奶拿铁吗？"},
        {"en": "Can I get that iced?", "zh": "可以做成冰的吗？"},
    ],
    "hints": ["先说杯型和冷热，再说奶和糖的偏好"],
}


def test_valid_scenario_passes() -> None:
    assert validate_scenario(VALID) == []


def test_builtin_scenarios_pass_validation() -> None:
    for scenario in list_scenarios():
        assert validate_scenario(scenario) == [], scenario["key"]
        assert scenario["is_builtin"] is True


def test_missing_required_fields() -> None:
    errors = validate_scenario({"key": "x_scene"})
    assert any("title" in e for e in errors)
    assert any("opening_line" in e for e in errors)
    assert any("key_sentences" in e for e in errors)
    assert any("hints" in e for e in errors)


def test_bad_key_format() -> None:
    for bad_key in ("Bad-Key", "1starts_with_digit", "has space", "", None):
        errors = validate_scenario({**VALID, "key": bad_key})
        assert any("key" in e for e in errors), bad_key


def test_bad_level() -> None:
    errors = validate_scenario({**VALID, "level": "Z9"})
    assert any("level" in e for e in errors)


def test_bad_key_sentences() -> None:
    assert validate_scenario({**VALID, "key_sentences": []})
    assert validate_scenario({**VALID, "key_sentences": ["plain string"]})
    assert validate_scenario({**VALID, "key_sentences": [{"en": "only english"}]})


def test_bad_hints() -> None:
    assert validate_scenario({**VALID, "hints": []})
    assert validate_scenario({**VALID, "hints": ["ok", ""]})
    assert validate_scenario({**VALID, "hints": "not a list"})


def test_non_dict_rejected() -> None:
    assert validate_scenario("nope") == ["场景必须是 JSON 对象"]


def test_sanitize_strips_runtime_flags() -> None:
    cleaned = sanitize_scenario({**VALID, "is_builtin": True, "extra": 1})
    assert "is_builtin" not in cleaned
    assert "extra" not in cleaned
    assert cleaned["key"] == "coffee_order"


def test_normalize_draft_key_slug_and_builtin_suffix() -> None:
    draft = _normalize_draft({**VALID, "key": "Coffee Order!"}, level=None)
    assert draft["key"] == "coffee_order"
    # 撞内置 key 自动加后缀
    assert is_builtin_key("restaurant_order")
    draft = _normalize_draft({**VALID, "key": "restaurant_order"}, level="b1")
    assert draft["key"] == "restaurant_order_custom"
    assert draft["level"] == "B1"

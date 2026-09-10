"""批量策划拆解阶段的单测（模块 16 FR-437）。

守的是归一化：模型给的比例、档位、张数一律不可信，脏数据不能流到前端。
全程 mock `complete_json`，不打真实网络、不出图。
"""

from __future__ import annotations

from typing import Any

import pytest

from domain import image_batch
from domain.image_batch import BatchError, plan_tasks
from domain.image_sizes import RATIOS, TIERS
from domain.llm import LLMUnavailable


def _stub(monkeypatch: pytest.MonkeyPatch, payload: Any, calls: list | None = None) -> None:
    """把 complete_json 换成返回固定 payload 的假实现。"""

    async def fake(alias: str, system: str, user: str) -> tuple[Any, str, int]:
        if calls is not None:
            calls.append({"alias": alias, "system": system, "user": user})
        return payload, "fake-model", 12

    monkeypatch.setattr(image_batch, "complete_json", fake)


def _tasks(*items: dict) -> dict:
    return {"tasks": list(items)}


async def test_plans_three_tasks(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list = []
    _stub(
        monkeypatch,
        _tasks(
            {"label": "吧台特写", "prompt_zh": "咖啡馆吧台上的意式咖啡机与糕点柜",
             "ratio": "3:2", "tier": "1k", "n": 1},
            {"label": "手冲器具", "prompt_zh": "木桌上的手冲壶、滤杯与磨豆机",
             "ratio": "1:1", "tier": "2k", "n": 2},
            {"label": "临窗座位", "prompt_zh": "晨光斜照的靠窗卡座，桌上一杯拿铁",
             "ratio": "16:9", "tier": "1k", "n": 1},
        ),
        calls,
    )

    tasks = await plan_tasks("给我的咖啡主题单词本出一套配图", app_key="text_to_image")

    assert [t["label"] for t in tasks] == ["吧台特写", "手冲器具", "临窗座位"]
    assert [t["ratio"] for t in tasks] == ["3:2", "1:1", "16:9"]
    assert [t["tier"] for t in tasks] == ["1k", "2k", "1k"]
    assert [t["n"] for t in tasks] == [1, 2, 1]
    for task in tasks:
        assert set(task) == {"label", "prompt_zh", "ratio", "tier", "n"}
    # 拆解走文本别名，不碰生图能力
    assert calls[0]["alias"] == "explain-standard"


async def test_normalizes_illegal_ratio_tier_and_count(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub(
        monkeypatch,
        _tasks(
            {"label": "", "prompt_zh": "书桌上摊开的笔记本与钢笔",
             "ratio": "21:9", "tier": "8k", "n": 99},
            {"label": "夜读", "prompt_zh": "台灯下的书页特写", "ratio": None, "n": 0},
            {"label": "清晨", "prompt_zh": "窗边的书与咖啡", "ratio": "3:2",
             "tier": "2k", "n": "3"},
        ),
    )

    # 用不锁比例的应用测归一化本身；锁定优先另有 test_locked_ratio_wins_over_model 守着
    tasks = await plan_tasks("随便出一套", app_key="text_to_image")

    # 非法值回落到用途默认尺寸对应的比例（free 是 1024x1024 → 1:1）
    assert tasks[0]["ratio"] == "1:1"
    assert tasks[0]["tier"] == "1k"
    assert tasks[0]["n"] == 4  # 99 夹回上限
    assert tasks[0]["label"] == "子任务 1"  # 名字空了用序号补
    assert tasks[1]["ratio"] == "1:1"
    assert tasks[1]["n"] == 1  # 0 夹回下限
    assert tasks[2] == {
        "label": "清晨",
        "prompt_zh": "窗边的书与咖啡",
        "ratio": "3:2",
        "tier": "2k",
        "n": 3,
    }
    for task in tasks:
        assert task["ratio"] in RATIOS
        assert task["tier"] in TIERS
        assert 1 <= task["n"] <= 4


async def test_truncates_beyond_max_tasks(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub(
        monkeypatch,
        _tasks(*[{"label": f"第{i}张", "prompt_zh": f"场景 {i}"} for i in range(1, 10)]),
    )

    tasks = await plan_tasks("出一套图", app_key="text_to_image", max_tasks=4)

    assert len(tasks) == 4
    assert [t["label"] for t in tasks] == ["第1张", "第2张", "第3张", "第4张"]


async def test_empty_task_list_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub(monkeypatch, {"tasks": []})

    with pytest.raises(BatchError) as excinfo:
        await plan_tasks("出一套图", app_key="text_to_image")
    assert excinfo.value.kind == "api"


async def test_entries_without_prompt_are_dropped(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub(monkeypatch, _tasks({"label": "只有名字"}, {"prompt_zh": "  "}, 42))

    with pytest.raises(BatchError):
        await plan_tasks("出一套图", app_key="text_to_image")


async def test_locked_ratio_wins_over_model(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub(
        monkeypatch,
        _tasks(
            {"label": "正面", "prompt_zh": "一只戴围巾的柴犬正面半身", "ratio": "16:9"},
            {"label": "侧脸", "prompt_zh": "同一只柴犬的侧脸剪影", "ratio": "2:3"},
        ),
    )

    tasks = await plan_tasks("给我做一组头像", app_key="avatar")

    assert [t["ratio"] for t in tasks] == ["1:1", "1:1"]


async def test_locked_app_hides_ratio_choices_from_model(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list = []
    _stub(monkeypatch, _tasks({"label": "正面", "prompt_zh": "柴犬正面半身"}), calls)

    await plan_tasks("给我做一组头像", app_key="avatar")

    assert "比例已锁定" in calls[0]["user"]
    assert "比例候选" not in calls[0]["user"]


async def test_blank_idea_rejected() -> None:
    with pytest.raises(BatchError) as excinfo:
        await plan_tasks("   ", app_key="text_to_image")
    assert excinfo.value.kind == "api"


async def test_overlong_idea_rejected() -> None:
    with pytest.raises(BatchError, match="801"):
        await plan_tasks("咖" * 801, app_key="text_to_image")


async def test_unknown_app_rejected() -> None:
    with pytest.raises(BatchError) as excinfo:
        await plan_tasks("出一套图", app_key="不存在的应用")
    assert excinfo.value.kind == "api"


async def test_gateway_failure_maps_to_kind(monkeypatch: pytest.MonkeyPatch) -> None:
    async def boom(alias: str, system: str, user: str) -> tuple[Any, str, int]:
        raise LLMUnavailable("Connection error: gateway offline")

    monkeypatch.setattr(image_batch, "complete_json", boom)

    with pytest.raises(BatchError) as excinfo:
        await plan_tasks("出一套图", app_key="text_to_image")
    assert excinfo.value.kind == "connect"


async def test_accepts_list_under_another_key(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub(monkeypatch, {"方案": [{"label": "俯拍", "prompt_zh": "俯拍的木桌与咖啡杯"}]})

    tasks = await plan_tasks("咖啡配图", app_key="text_to_image")

    assert tasks == [
        {"label": "俯拍", "prompt_zh": "俯拍的木桌与咖啡杯", "ratio": "1:1", "tier": "1k", "n": 1}
    ]

"""循环节点 AI 编排的守卫（模块 17 · FR-465）。

这里守的是**归一化**，不联网。模型必然会给出 `count: "12张"`、`mode: "并行"`、
提示词给成一整段字符串而不是数组——这些不能让它漏到前端去，前端拿到
`count: "12张"` 只会静默填不进输入框，而用户看不出为什么。

另一条更隐蔽：模型常说「跑 12 轮」却只给 5 条提示词。按 count 循环取用的话，
第 6 轮起会重复前 5 条，界面上写着 12 轮、出来只有 5 种，且看不出原因。
"""

from __future__ import annotations

import pytest

from domain import canvas_loop
from domain.canvas_loop import LoopPlanError, _normalize


class TestIntCoercion:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            (12, 12),
            (12.0, 12),
            ("12", 12),
            ("12张", 12),
            ("约 8 轮", 8),
            ("跑3次", 3),
            ("", 5),  # 抠不出数字就用默认
            (None, 5),
            (True, 5),  # bool 是 int 的子类，必须挡掉否则 True→1
        ],
    )
    def test_as_int_digs_a_number_out(self, raw: object, expected: int) -> None:
        assert canvas_loop._as_int(raw, default=5, lo=1, hi=999) == expected

    def test_as_int_clamps(self) -> None:
        assert canvas_loop._as_int(9999, default=1, lo=1, hi=64) == 64
        assert canvas_loop._as_int(-3, default=1, lo=1, hi=64) == 1


class TestModeCoercion:
    @pytest.mark.parametrize("raw", ["parallel", "并发", "并行", "同时", "PARALLEL", " Parallel "])
    def test_parallel_synonyms(self, raw: str) -> None:
        assert canvas_loop._as_mode(raw) == "parallel"

    @pytest.mark.parametrize("raw", ["serial", "串行", "顺序", "", None, "随便什么"])
    def test_everything_else_is_serial(self, raw: object) -> None:
        """默认串行：串行只是慢，并发跑错了是同时废 N 张。"""
        assert canvas_loop._as_mode(raw) == "serial"


class TestPromptCoercion:
    def test_accepts_a_list(self) -> None:
        assert canvas_loop._as_prompts(["a", "b"]) == ["a", "b"]

    def test_accepts_a_newline_string(self) -> None:
        """模型常把数组写成一整段换行文本。"""
        assert canvas_loop._as_prompts("第一条\n第二条\n") == ["第一条", "第二条"]

    def test_drops_blanks_and_squashes_whitespace(self) -> None:
        assert canvas_loop._as_prompts(["  a  b ", "", "   ", "c"]) == ["a b", "c"]

    def test_caps_the_count(self) -> None:
        got = canvas_loop._as_prompts([f"p{i}" for i in range(500)])
        assert len(got) == canvas_loop.MAX_PROMPTS

    @pytest.mark.parametrize("raw", [None, 123, {"a": 1}])
    def test_rubbish_becomes_empty(self, raw: object) -> None:
        assert canvas_loop._as_prompts(raw) == []


class TestNormalize:
    def test_full_pass(self) -> None:
        got = _normalize(
            {
                "title": "  语聊房封面  ",
                "mode": "并发",
                "count": "3张",
                "loop_start": 1,
                "variable_prompts": ["a", "b", "c"],
                "image_input": True,
                "image_batch_size": "2",
                "why": "要多样性所以并发",
            }
        )
        assert got == {
            "title": "语聊房封面",
            "mode": "parallel",
            "count": 3,
            "loop_start": 1,
            "variable_prompts": ["a", "b", "c"],
            "image_input": True,
            "image_batch_size": 2,
            "why": "要多样性所以并发",
        }

    def test_count_follows_the_prompts_when_they_disagree(self) -> None:
        """说 12 轮却只给 5 条 —— 以提示词为准。

        按 count=12 跑的话第 6 轮起重复前 5 条，界面写着 12 轮、出来只有 5 种。
        """
        got = _normalize({"count": 12, "variable_prompts": [f"p{i}" for i in range(5)]})
        assert got["count"] == 5

    def test_single_variable_prompt_keeps_the_requested_count(self) -> None:
        """只给一条带《计数》的提示词是**正当写法**，这时 count 必须留住。

        这条和上一条是一对：拉齐规则只在多条时生效，否则「一条模板跑 12 轮」
        会被压成 1 轮，正好把最有用的写法废掉。
        """
        got = _normalize({"count": 12, "variable_prompts": ["第《计数》张卖点图"]})
        assert got["count"] == 12

    def test_missing_fields_get_usable_defaults(self) -> None:
        got = _normalize({"variable_prompts": ["only"]})
        assert got["mode"] == "serial"
        assert got["count"] == 1
        assert got["loop_start"] == 1
        assert got["image_input"] is False
        assert got["image_batch_size"] == 1
        assert got["title"] == "循环"

    def test_no_prompts_is_the_only_hard_failure(self) -> None:
        with pytest.raises(LoopPlanError) as err:
            _normalize({"count": 5, "variable_prompts": []})
        assert err.value.kind == "api"

    def test_values_stay_inside_the_limits(self) -> None:
        got = _normalize(
            {
                "count": 99999,
                "loop_start": -5,
                "image_batch_size": 9999,
                "variable_prompts": ["a"],
            }
        )
        assert got["count"] <= canvas_loop.LOOP_MAX
        assert got["loop_start"] >= 1
        assert got["image_batch_size"] <= canvas_loop.BATCH_MAX


class TestUserPrompt:
    def test_mentions_upstream_images_when_there_are_any(self) -> None:
        text = canvas_loop.build_user_prompt("做封面", upstream_images=4, upstream_prompt="")
        assert "4 张图" in text

    def test_says_so_when_there_are_none(self) -> None:
        text = canvas_loop.build_user_prompt("做封面", upstream_images=0, upstream_prompt="")
        assert "没有图片输入" in text

    def test_includes_upstream_prompt_as_a_base(self) -> None:
        text = canvas_loop.build_user_prompt(
            "改配色", upstream_images=0, upstream_prompt="夜色星空"
        )
        assert "夜色星空" in text


class TestTokensStayInSync:
    def test_system_prompt_lists_every_token(self) -> None:
        """系统提示词里漏掉一个 token，模型就不会用它，而代码里明明支持。"""
        for token in canvas_loop.TOKENS:
            assert token in canvas_loop.SYSTEM


@pytest.mark.asyncio
class TestPlanLoopGuards:
    async def test_empty_idea_is_rejected_before_calling_the_model(self) -> None:
        with pytest.raises(LoopPlanError) as err:
            await canvas_loop.plan_loop("   ")
        assert err.value.kind == "api"

    async def test_overlong_idea_is_rejected(self) -> None:
        with pytest.raises(LoopPlanError) as err:
            await canvas_loop.plan_loop("字" * (canvas_loop.MAX_IDEA_CHARS + 1))
        assert "超过上限" in err.value.message

"""成套出图编排的守卫（模块 17）。

守两件事，都不联网：

1. **归一化**——模型必然会换键名、把数组答成字符串、把数字答成「12张」。
   这些不能漏到前端去：前端拿到 `count: "12张"` 只会静默填不进输入框。
2. **改动分档**——「6 张改 12 张」必须判成一档（本地改、不进模型）。
   判错成三档的话，用户改个数字要干等模型二十秒；判错成一档的话，
   改了目标却还按旧方案跑。
"""

from __future__ import annotations

import pytest

from domain import canvas_set
from domain.canvas_set import SetPlanError, apply_ops, change_tier, normalize_plan, to_run_config


def _plan(**over) -> dict:
    base = {
        "goal": "一套登录界面",
        "intent": "consistent",
        "variables": [
            {"key": "count", "label": "张数", "type": "number", "value": 2, "options": []}
        ],
        "steps": [
            {"id": "s1", "title": "登录页", "prompt": "画登录页", "dependsOn": []},
            {"id": "s2", "title": "注册页", "prompt": "画注册页", "dependsOn": ["s1"]},
        ],
        "rationale": "",
    }
    base.update(over)
    return base


class TestSplitNumbered:
    def test_strips_the_number_prefix(self) -> None:
        """编号留着会跟进提示词，模型会把「1.」当画面内容。"""
        got = canvas_set._split_numbered("1. 登录页\n2. 注册页\n3. 找回密码")
        assert got == ["登录页", "注册页", "找回密码"]

    @pytest.mark.parametrize("sep", [".", "、", ")", "）", "．"])
    def test_accepts_several_number_separators(self, sep: str) -> None:
        got = canvas_set._split_numbered(f"1{sep} 甲\n2{sep} 乙")
        assert got == ["甲", "乙"]

    def test_falls_back_to_lines(self) -> None:
        assert canvas_set._split_numbered("甲\n乙\n丙") == ["甲", "乙", "丙"]

    def test_single_line_stays_one_item(self) -> None:
        assert canvas_set._split_numbered("就一句话") == ["就一句话"]

    def test_blank_is_empty(self) -> None:
        assert canvas_set._split_numbered("   ") == []


class TestNormQuestion:
    def test_full_single_choice(self) -> None:
        got = canvas_set._norm_question(
            {
                "id": "style",
                "type": "single",
                "title": "  想要什么风格  ",
                "options": [{"value": "flat", "label": "扁平", "hint": "干净"}, {"value": "3d"}],
            },
            1,
        )
        assert got is not None
        assert got["type"] == "single"
        assert got["title"] == "想要什么风格"
        assert [o["value"] for o in got["options"]] == ["flat", "3d"]
        # 没给 label 的用 value 顶上，不能出现空按钮
        assert got["options"][1]["label"] == "3d"

    def test_plain_string_options(self) -> None:
        """模型常把选项给成字符串数组而不是对象数组。"""
        got = canvas_set._norm_question({"title": "配色", "options": ["暖色", "冷色"]}, 1)
        assert got is not None
        assert [o["label"] for o in got["options"]] == ["暖色", "冷色"]

    def test_choice_without_enough_options_degrades_to_text(self) -> None:
        """说是选择题却只给一个选项：降级成填空，而不是丢掉这一问。"""
        got = canvas_set._norm_question(
            {"type": "single", "title": "随便说", "options": ["只有一个"]}, 1
        )
        assert got is not None
        assert got["type"] == "text"

    def test_multi_clamps_min_max(self) -> None:
        got = canvas_set._norm_question(
            {"type": "multi", "title": "选几个", "options": ["a", "b", "c"], "min": 5, "max": 1}, 1
        )
        assert got is not None
        assert got["max"] >= got["min"]
        assert got["max"] <= len(got["options"])

    def test_no_title_is_dropped(self) -> None:
        assert canvas_set._norm_question({"options": ["a", "b"]}, 1) is None

    def test_non_dict_is_dropped(self) -> None:
        assert canvas_set._norm_question("随便一个字符串", 1) is None

    def test_missing_id_gets_one(self) -> None:
        got = canvas_set._norm_question({"title": "问题"}, 7)
        assert got is not None and got["id"] == "q7"

    def test_options_are_capped(self) -> None:
        got = canvas_set._norm_question(
            {"title": "很多选项", "options": [str(i) for i in range(50)]}, 1
        )
        assert got is not None
        assert len(got["options"]) == canvas_set.MAX_OPTIONS


class TestNormalizePlan:
    def test_full_pass(self) -> None:
        got = normalize_plan(
            {
                "goal": "  一套登录界面  ",
                "intent": "consistent",
                "steps": [{"id": "s1", "title": "登录", "prompt": "画登录页"}],
                "rationale": "要一致所以串行",
            }
        )
        assert got["goal"] == "一套登录界面"
        assert got["intent"] == "consistent"
        assert len(got["steps"]) == 1

    def test_unknown_intent_falls_back_to_consistent(self) -> None:
        """认不出就按一致成套：串行只是慢，并发跑错是同时废一批。"""
        got = normalize_plan({"intent": "随便什么", "steps": [{"prompt": "x"}]})
        assert got["intent"] == "consistent"

    def test_steps_given_as_one_numbered_string(self) -> None:
        got = normalize_plan({"steps": "1. 登录页\n2. 注册页"})
        assert [s["prompt"] for s in got["steps"]] == ["登录页", "注册页"]

    def test_steps_given_as_plain_strings(self) -> None:
        got = normalize_plan({"steps": ["甲", "乙"]})
        assert [s["prompt"] for s in got["steps"]] == ["甲", "乙"]

    def test_count_variable_is_forced_to_match_steps(self) -> None:
        """界面写着 8、实际跑 3 条且看不出原因，是最难查的一类。"""
        got = normalize_plan(
            {
                "variables": [{"key": "count", "type": "number", "value": 8}],
                "steps": [{"prompt": "a"}, {"prompt": "b"}, {"prompt": "c"}],
            }
        )
        count = next(v for v in got["variables"] if v["key"] == "count")
        assert count["value"] == 3

    def test_count_variable_is_added_when_missing(self) -> None:
        got = normalize_plan({"steps": [{"prompt": "a"}, {"prompt": "b"}]})
        assert any(v["key"] == "count" and v["value"] == 2 for v in got["variables"])

    def test_duplicate_step_ids_are_made_unique(self) -> None:
        """id 重了的话，改第二步的 patch 会落到第一步上。"""
        got = normalize_plan({"steps": [{"id": "x", "prompt": "a"}, {"id": "x", "prompt": "b"}]})
        ids = [s["id"] for s in got["steps"]]
        assert len(set(ids)) == len(ids)

    def test_empty_prompts_are_dropped(self) -> None:
        got = normalize_plan({"steps": [{"prompt": "  "}, {"prompt": "有效"}]})
        assert len(got["steps"]) == 1

    def test_no_steps_is_a_hard_failure(self) -> None:
        with pytest.raises(SetPlanError) as err:
            normalize_plan({"steps": []})
        assert err.value.kind == "api"

    def test_steps_are_capped(self) -> None:
        got = normalize_plan({"steps": [{"prompt": f"p{i}"} for i in range(500)]})
        assert len(got["steps"]) == canvas_set.MAX_STEPS


class TestChangeTier:
    def test_variable_change_is_tier_one(self) -> None:
        """「6 张改 12 张」——本地改，不进模型。这条是这个模块存在的理由之一。"""
        assert change_tier([{"op": "setVariable", "key": "count", "value": 12}]) == 1

    def test_text_edits_are_tier_one(self) -> None:
        assert change_tier([{"op": "setStepPrompt", "id": "s1", "value": "改过的词"}]) == 1
        assert change_tier([{"op": "setStepTitle", "id": "s1", "value": "新标题"}]) == 1
        assert change_tier([{"op": "reorder", "value": ["s2", "s1"]}]) == 1

    def test_structure_changes_are_tier_two(self) -> None:
        assert change_tier([{"op": "addStep"}]) == 2
        assert change_tier([{"op": "removeStep", "id": "s1"}]) == 2
        assert change_tier([{"op": "setDependsOn", "id": "s2", "value": []}]) == 2

    def test_goal_change_is_tier_three(self) -> None:
        assert change_tier([{"op": "setGoal", "value": "改做支付流程"}]) == 3

    def test_highest_tier_wins(self) -> None:
        assert change_tier([{"op": "setVariable"}, {"op": "setGoal"}]) == 3
        assert change_tier([{"op": "setVariable"}, {"op": "addStep"}]) == 2

    def test_unknown_op_is_conservative(self) -> None:
        """不认识的操作宁可多重算一次，也不要按旧方案跑。"""
        assert change_tier([{"op": "某个还没实现的操作"}]) == 2

    def test_empty_ops_is_tier_one(self) -> None:
        assert change_tier([]) == 1


class TestApplyOps:
    def test_set_variable(self) -> None:
        got = apply_ops(_plan(), [{"op": "setVariable", "key": "count", "value": 9}])
        # count 会被步数拉齐，所以这里断言的是「没崩、且与步数一致」
        assert next(v for v in got["variables"] if v["key"] == "count")["value"] == 2

    def test_set_step_prompt(self) -> None:
        got = apply_ops(_plan(), [{"op": "setStepPrompt", "id": "s2", "value": "改过的注册页"}])
        assert got["steps"][1]["prompt"] == "改过的注册页"

    def test_remove_step_syncs_count(self) -> None:
        got = apply_ops(_plan(), [{"op": "removeStep", "id": "s1"}])
        assert [s["id"] for s in got["steps"]] == ["s2"]
        assert next(v for v in got["variables"] if v["key"] == "count")["value"] == 1

    def test_reorder(self) -> None:
        got = apply_ops(_plan(), [{"op": "reorder", "value": ["s2", "s1"]}])
        assert [s["id"] for s in got["steps"]] == ["s2", "s1"]

    def test_does_not_mutate_the_input(self) -> None:
        original = _plan()
        apply_ops(original, [{"op": "setStepPrompt", "id": "s1", "value": "变了"}])
        assert original["steps"][0]["prompt"] == "画登录页"

    def test_unknown_step_id_is_ignored(self) -> None:
        got = apply_ops(_plan(), [{"op": "setStepPrompt", "id": "不存在", "value": "x"}])
        assert [s["prompt"] for s in got["steps"]] == ["画登录页", "画注册页"]


class TestToRunConfig:
    def test_consistent_runs_serial(self) -> None:
        run = to_run_config(_plan(intent="consistent"))
        assert run["mode"] == "serial"

    def test_varied_runs_parallel(self) -> None:
        run = to_run_config(_plan(intent="varied"))
        assert run["mode"] == "parallel"

    def test_count_and_prompts_come_from_steps(self) -> None:
        """参数是方案的投影：步数变了，轮数必须跟着变。"""
        run = to_run_config(_plan())
        assert run["count"] == 2
        assert run["variable_prompts"] == ["画登录页", "画注册页"]

    def test_is_a_pure_function_of_the_plan(self) -> None:
        plan = _plan()
        assert to_run_config(plan) == to_run_config(plan)

    def test_title_comes_from_goal(self) -> None:
        assert to_run_config(_plan(goal="登录界面套图"))["title"] == "登录界面套图"

    def test_blank_goal_still_gives_a_title(self) -> None:
        assert to_run_config(_plan(goal=""))["title"] != ""


@pytest.mark.asyncio
class TestGuards:
    async def test_ask_rejects_empty_idea_before_calling_the_model(self) -> None:
        with pytest.raises(SetPlanError):
            await canvas_set.ask("   ")

    async def test_ask_rejects_overlong_idea(self) -> None:
        with pytest.raises(SetPlanError) as err:
            await canvas_set.ask("字" * (canvas_set.MAX_IDEA_CHARS + 1))
        assert "超过上限" in err.value.message

    async def test_draft_rejects_empty_idea(self) -> None:
        with pytest.raises(SetPlanError):
            await canvas_set.draft("  ")


class TestPromptsStayHonest:
    def test_ask_prompt_tells_the_model_not_to_re_ask(self) -> None:
        text = canvas_set.build_ask_user(
            "做一套登录页", [{"title": "什么风格", "answer": "扁平"}], upstream_images=0
        )
        assert "扁平" in text
        assert "不要重复问" in text

    def test_plan_prompt_honours_an_explicit_count(self) -> None:
        text = canvas_set.build_plan_user("做登录页", [], upstream_images=0, want=6)
        assert "6 张" in text

    def test_plan_prompt_mentions_upstream_refs(self) -> None:
        text = canvas_set.build_plan_user("做登录页", [], upstream_images=3, want=None)
        assert "3 张参考图" in text

    def test_plan_prompt_tells_model_not_to_restate_the_reference(self) -> None:
        """参考图会真的发过去，再用文字复述一遍只会互相打架。"""
        text = canvas_set.build_plan_user("改配色", [], upstream_images=2, want=None)
        assert "不要重复描述" in text

    def test_plan_prompt_says_so_when_there_is_no_reference(self) -> None:
        """没有参考图时每条提示词都要能独立成立——这是两种完全不同的写法。"""
        text = canvas_set.build_plan_user("做登录页", [], upstream_images=0, want=None)
        assert "独立成立" in text

    def test_ask_prompt_does_not_re_ask_for_references(self) -> None:
        """用户已经选好参考图了，再问「要不要参考图」是浪费他一次点击。"""
        text = canvas_set.build_ask_user("做封面", [], upstream_images=4)
        assert "不要问他要不要参考图" in text

    def test_ask_prompt_states_the_no_reference_case(self) -> None:
        text = canvas_set.build_ask_user("做封面", [], upstream_images=0)
        assert "没有参考图" in text


class TestAttachmentContext:
    """输入框上挂的文件进提示词的方式（模块 17）。"""

    def test_no_attachments_leaves_no_empty_heading(self) -> None:
        assert canvas_set._attachment_lines([]) == []

    def test_unreadable_file_is_still_listed(self) -> None:
        """读不出正文的照样列出来。

        用户带了 `设计规范.sketch` 这件事本身就是信息。悄悄丢掉的话，
        用户会以为 AI 读过了，实际上它连有这个文件都不知道。
        """
        text = "\n".join(canvas_set._attachment_lines([{"name": "设计规范.sketch", "text": ""}]))
        assert "设计规范.sketch" in text
        assert "读不出正文" in text

    def test_text_is_carried_into_the_prompt(self) -> None:
        text = "\n".join(
            canvas_set._attachment_lines([{"name": "规范.md", "text": "首页要有搜索条"}])
        )
        assert "规范.md" in text
        assert "首页要有搜索条" in text
        # 文件是约束不是灵感：这句缺了模型会把规范当参考随便改
        assert "约束" in text

    def test_total_budget_stops_runaway_documents(self) -> None:
        """六份长文档会把上下文吃光，用户那句需求反而成了最不起眼的一段。"""
        items = [{"name": f"f{i}.md", "text": "字" * 5000} for i in range(6)]
        text = "\n".join(canvas_set._attachment_lines(items))
        assert len(text) < canvas_set.ATTACH_TOTAL_CHARS + 2000
        assert "没有全部读进来" in text

    def test_both_prompts_carry_attachments(self) -> None:
        """问和规划是两条路径，只在一条上带附件的话另一条会凭空少一半上下文。"""
        att = [{"name": "规范.md", "text": "必须有无障碍模式"}]
        assert "无障碍模式" in canvas_set.build_ask_user("做门户", [], 0, att)
        assert "无障碍模式" in canvas_set.build_plan_user("做门户", [], 0, None, att)


class TestFollowUp:
    """问完之后那一格：自由补充与「再问我几个」。"""

    def test_note_reaches_both_prompts(self) -> None:
        assert "临江市民政局" in canvas_set.build_ask_user(
            "做门户", [], 0, [], "机构名是临江市民政局"
        )
        assert "临江市民政局" in canvas_set.build_plan_user(
            "做门户", [], 0, None, [], "机构名是临江市民政局"
        )

    def test_more_flips_the_ask_less_instruction(self) -> None:
        """默认那条「宁可少问」在这一轮必须让位——是用户自己按的按钮。"""
        text = canvas_set.build_ask_user("做门户", [], 0, [], "", True)
        assert "再多问几个" in text
        assert "enough:true" in text

    def test_normal_round_does_not_ask_for_more(self) -> None:
        assert "再多问几个" not in canvas_set.build_ask_user("做门户", [], 0, [], "", False)


@pytest.mark.asyncio
class TestAskMoreOverridesEnough:
    async def test_more_round_never_reports_enough(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """模型回「够了」也不作数：用户刚按了「再问我几个」，
        界面上按了按钮什么都不发生，看起来就是坏了。"""

        async def fake(alias: str, system: str, user: str):
            return {"enough": True, "questions": []}, "fake-model", 9

        monkeypatch.setattr(canvas_set, "complete_json", fake)
        got = await canvas_set.ask("做一套门户", more=True)
        assert got["enough"] is False

    async def test_normal_round_respects_enough(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def fake(alias: str, system: str, user: str):
            return {"enough": True, "questions": []}, "fake-model", 9

        monkeypatch.setattr(canvas_set, "complete_json", fake)
        got = await canvas_set.ask("做一套门户")
        assert got["enough"] is True


class TestAskedTitlesGoBack:
    """已问但没答的题目也要回传给模型。

    只发"答过的"的话它不知道自己问过什么——实测第二轮把
    「参考图照着哪一面来」换成「参考图借哪一面」又问了一遍。
    """

    def test_unanswered_titles_are_listed(self) -> None:
        text = canvas_set.build_ask_user(
            "做门户", [], 1, [], "", True, ["参考图主要照着哪一面来？"]
        )
        assert "参考图主要照着哪一面来？" in text
        assert "别换个说法重问" in text

    def test_nothing_asked_yet_leaves_no_empty_heading(self) -> None:
        assert "已经问过了" not in canvas_set.build_ask_user("做门户", [], 0, [], "", False, [])

    def test_caps_the_list(self) -> None:
        """问了七八轮之后全量回传只会把需求本身挤出上下文。"""
        titles = [f"第 {i} 问" for i in range(40)]
        text = canvas_set.build_ask_user("做门户", [], 0, [], "", True, titles)
        assert f"第 {canvas_set.MAX_ASKED - 1} 问" in text
        assert f"第 {canvas_set.MAX_ASKED} 问" not in text

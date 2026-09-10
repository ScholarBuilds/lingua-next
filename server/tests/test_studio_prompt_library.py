"""提示词库照着 Infinite-Canvas 补齐的那几样（模块 17 FR-478 · M67）。

守的都是「不报错但结果是错的」那类：

- **内置模板的分类**是模板自带的属性，与用户自建的分组各走各的：删掉一个分组不该
  把内置模板的归类一起删掉，否则升级一次它又自己长回来，两边永远在打架。
- **隐藏可逆、删不掉**：内置模板不是一行数据，`DELETE` 只能 400；隐藏后默认列表里
  不再出现，但库自己要能看见它才谈得上恢复。默认不回是关键——每个消费方各自记得
  过滤一次的话，漏一处隐藏就等于没生效。
- **占位接上变量体系**：迁入的模板原文写 `[主体]`，方括号没有任何机制托底，忘了替换
  就原样发给模型，模型不报错、照着乱出图。换成 `{{主体}}` 之后，缺必填直接 400。
"""

from __future__ import annotations

import pytest

from domain import studio_prompts


class TestBuiltinCategories:
    def test_every_builtin_has_a_known_category(self):
        for item in studio_prompts.BUILTIN_PROMPTS:
            assert item["category"] in studio_prompts.CATEGORY_NAMES, item["key"]

    def test_infinite_canvas_taxonomy_is_kept(self):
        """前五类照搬蓝本（视角/分镜/角色/产品/光影），顺序也照它的来。"""
        head = [key for key, _ in studio_prompts.BUILTIN_CATEGORIES[:5]]
        assert head == ["view", "storyboard", "character", "product", "lighting"]
        names = studio_prompts.CATEGORY_NAMES
        assert names["view"] == "视角" and names["lighting"] == "光影"

    def test_catalog_order_matches_sort(self):
        catalog = studio_prompts.category_catalog()
        assert [c["id"] for c in catalog] == list(studio_prompts.CATEGORY_SORT)
        assert all(
            studio_prompts.CATEGORY_SORT[c["id"]] == index for index, c in enumerate(catalog)
        )

    def test_every_category_has_at_least_one_template(self):
        """空分类在左栏就是一个点进去什么都没有的死条目。"""
        used = {item["category"] for item in studio_prompts.BUILTIN_PROMPTS}
        assert used == set(studio_prompts.CATEGORY_NAMES)

    async def test_list_filters_by_category(self, client):
        resp = await client.get("/studio/prompts?category=lighting")
        assert resp.status_code == 200
        items = resp.json()["items"]
        assert items and all(item["category"] == "lighting" for item in items)
        assert all(item["builtin"] for item in items)

    async def test_categories_ride_along_with_the_list(self, client):
        body = (await client.get("/studio/prompts")).json()
        assert [c["id"] for c in body["categories"]] == list(studio_prompts.CATEGORY_SORT)

    async def test_user_prompts_carry_no_category(self, client):
        created = (
            await client.post("/studio/prompts", json={"title": "自建", "body": "a cat"})
        ).json()
        assert created["category"] is None
        assert created["hidden"] is False

    async def test_category_name_is_searchable(self, client):
        """搜「光影」要能搜出电影级光影校正——它的标题里没有这两个字。"""
        items = (await client.get("/studio/prompts?q=光影")).json()["items"]
        assert any(item["title"] == "电影级光影校正" for item in items)


class TestHideBuiltin:
    async def test_hide_then_restore(self, client):
        hidden = await client.patch("/studio/prompts/-1", json={"hidden": True})
        assert hidden.status_code == 200
        assert hidden.json()["hidden"] is True

        listed = (await client.get("/studio/prompts")).json()["items"]
        assert all(item["id"] != -1 for item in listed)

        # 库自己要看得见才谈得上恢复
        managed = (await client.get("/studio/prompts?include_hidden=true")).json()["items"]
        target = next(item for item in managed if item["id"] == -1)
        assert target["hidden"] is True
        assert target["body"], "隐藏不动内容，正文得原样在"

        back = await client.patch("/studio/prompts/-1", json={"hidden": False})
        assert back.status_code == 200 and back.json()["hidden"] is False
        again = (await client.get("/studio/prompts")).json()["items"]
        assert any(item["id"] == -1 for item in again)

    async def test_hidden_is_excluded_from_category_and_builtin_filters(self, client):
        await client.patch("/studio/prompts/-1", json={"hidden": True})
        for query in ("category=view", "builtin=true", "q=九宫格"):
            items = (await client.get(f"/studio/prompts?{query}")).json()["items"]
            assert all(item["id"] != -1 for item in items), query

    async def test_hidden_survives_a_second_hide(self, client):
        """重复隐藏不该在名单里留两份，否则「已隐藏」的计数会比能恢复的条数多。"""
        await client.patch("/studio/prompts/-2", json={"hidden": True})
        await client.patch("/studio/prompts/-2", json={"hidden": True})
        managed = (await client.get("/studio/prompts?include_hidden=true")).json()["items"]
        assert len([item for item in managed if item["hidden"]]) == 1

    async def test_content_edit_on_builtin_still_rejected(self, client):
        """放行的只有 hidden 这一个字段，其余照旧 400 并给出两条出路。"""
        for payload in ({"title": "改名"}, {"body": "x"}, {"favorite": True}):
            resp = await client.patch("/studio/prompts/-1", json=payload)
            assert resp.status_code == 400, payload
            assert "内置模板不可改" in resp.json()["detail"]
        mixed = await client.patch("/studio/prompts/-1", json={"hidden": True, "title": "改名"})
        assert mixed.status_code == 400
        # 混着传的那一次一个字段都不该生效
        listed = (await client.get("/studio/prompts")).json()["items"]
        assert any(item["id"] == -1 for item in listed)

    async def test_delete_builtin_points_at_hiding(self, client):
        resp = await client.delete("/studio/prompts/-1")
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert "复制" in detail and "隐藏" in detail

    async def test_hide_missing_builtin_is_404(self, client):
        resp = await client.patch("/studio/prompts/-999", json={"hidden": True})
        assert resp.status_code == 404

    async def test_user_prompt_ignores_hidden_flag(self, client):
        created = (
            await client.post("/studio/prompts", json={"title": "自建", "body": "a cat"})
        ).json()
        patched = await client.patch(f"/studio/prompts/{created['id']}", json={"hidden": True})
        assert patched.status_code == 200
        assert patched.json()["hidden"] is False


class TestBuiltinVariables:
    def test_declared_names_match_the_body(self):
        """声明与正文必须逐字对上：多出来的声明是填了没用的空格子，
        少掉的占位会原样漏给模型。"""
        for item in studio_prompts.BUILTIN_PROMPTS:
            derived = studio_prompts.extract_variable_names(item["body"], item["negative"])
            declared = [spec["name"] for spec in item.get("variables", ())]
            assert derived == declared, item["key"]

    def test_no_square_bracket_placeholders_left(self):
        """蓝本原文的 `[主体]` 一个都不该留下——它不进变量名单，也就没有任何拦截。"""
        for item in studio_prompts.BUILTIN_PROMPTS:
            assert "[主体" not in item["body"], item["key"]
            assert "[product]" not in item["body"], item["key"]

    def test_infinite_canvas_text_is_verbatim_apart_from_placeholders(self):
        """迁入的正向/负向没有被缩写：那些长句是调出来的。"""
        by_key = {item["key"]: item for item in studio_prompts.INFINITE_CANVAS_PROMPTS}
        grid = by_key["infinite_multi_camera_3x3"]
        assert "uniform light warm gray background color F0EDE8" in grid["body"]
        assert "no hard edges no white halo no light bleed" in grid["body"]
        assert grid["negative"].startswith("numbers, text, letters, labels, frame numbers")
        assert "out of frame" in grid["negative"]
        panorama = by_key["infinite_360_panorama"]
        assert "左右边缘100%像素级无缝衔接" in panorama["body"]

    def test_variable_names_may_be_chinese(self):
        """界面上的例子写的就是 `{{主体}}`；只认 ASCII 的话照着例子写全部静默失效。"""
        assert studio_prompts.extract_variable_names("画 {{主体}}") == ["主体"]
        assert studio_prompts.extract_variable_names("{{1格}} {{a-b}} {{阶段一}}") == ["阶段一"]

    async def test_builtin_exposes_labels_from_its_declaration(self, client):
        items = (await client.get("/studio/prompts?builtin=true")).json()["items"]
        grid = next(item for item in items if item["title"] == "多机位九宫格")
        names = [spec["name"] for spec in grid["variables"]]
        assert names == ["主体", "主体详细描述"]
        assert all(spec["required"] for spec in grid["variables"])
        assert grid["variables"][1]["description"]

    async def test_render_builtin_fills_the_placeholders(self, client):
        items = (await client.get("/studio/prompts?builtin=true")).json()["items"]
        grid = next(item for item in items if item["title"] == "多机位九宫格")
        rendered = await client.post(
            f"/studio/prompts/{grid['id']}/render",
            json={"values": {"主体": "一只柯基", "主体详细描述": "短腿、橘白毛色"}},
        )
        assert rendered.status_code == 200
        body = rendered.json()["body"]
        assert "一只柯基" in body and "{{" not in body

    async def test_render_builtin_without_values_is_rejected(self, client):
        """缺必填直接拦下，绝不把 `{{主体}}` 原样交出去。"""
        items = (await client.get("/studio/prompts?builtin=true")).json()["items"]
        grid = next(item for item in items if item["title"] == "多机位九宫格")
        resp = await client.post(f"/studio/prompts/{grid['id']}/render", json={"values": {}})
        assert resp.status_code == 400
        assert "主体" in resp.json()["detail"]

    async def test_fork_carries_variable_declarations(self, client):
        items = (await client.get("/studio/prompts?builtin=true")).json()["items"]
        grid = next(item for item in items if item["title"] == "多机位九宫格")
        copy = (await client.post(f"/studio/prompts/{grid['id']}/fork", json={})).json()
        assert [spec["name"] for spec in copy["variables"]] == ["主体", "主体详细描述"]
        assert copy["body"] == grid["body"]


@pytest.mark.parametrize("prompt_id", [-1, -11])
async def test_builtin_ids_stay_stable_across_hiding(client, prompt_id):
    """隐藏名单存 key 不存 id：id 是按声明顺序派生的，中间插一条模板全都要挪位。"""
    await client.patch(f"/studio/prompts/{prompt_id}", json={"hidden": True})
    managed = (await client.get("/studio/prompts?include_hidden=true")).json()["items"]
    hidden = [item["id"] for item in managed if item["hidden"]]
    assert hidden == [prompt_id]


class TestEditorSaveKeepsHistory:
    """编辑器那一发 PATCH（标题/正文/负向/场景/分组/变量一次全带）仍然存一版。

    这一版把 440px 的右侧抽屉换成了铺满整页的编辑器，发出去的 payload 形状没变——
    这条就是钉住「换了界面，版本链还在」。
    """

    async def test_one_patch_from_the_editor_adds_one_version(self, client):
        created = (
            await client.post(
                "/studio/prompts",
                json={"title": "街拍", "body": "a street portrait", "scene": "拍朋友"},
            )
        ).json()
        assert created["version"] == 1

        patched = (
            await client.patch(
                f"/studio/prompts/{created['id']}",
                json={
                    "title": "街拍 · 暖调",
                    "body": "a street portrait of {{主体}} at golden hour",
                    "negative": "blurry, watermark",
                    "scene": "拍朋友，想要暖调",
                    "group_id": None,
                    "variables": [{"name": "主体", "label": "主体", "description": "拍谁"}],
                },
            )
        ).json()
        assert patched["version"] == 2
        assert [spec["name"] for spec in patched["variables"]] == ["主体"]

        revisions = (
            await client.get(f"/studio/prompts/{created['id']}/revisions")
        ).json()["items"]
        assert [item["version"] for item in revisions] == [2, 1]

        # 回滚回第一版，正文与变量一起退回去
        restored = (
            await client.post(f"/studio/prompts/{created['id']}/revisions/1/restore")
        ).json()
        assert restored["body"] == "a street portrait"
        assert restored["variables"] == []

    async def test_editing_only_the_group_does_not_burn_a_version(self, client):
        """挪个分组不是「这条提示词写成什么样」，多一版会把历史面板淹掉。"""
        group = (await client.post("/studio/prompt-groups", json={"name": "我的库"})).json()
        created = (
            await client.post("/studio/prompts", json={"title": "街拍", "body": "a portrait"})
        ).json()
        moved = (
            await client.patch(
                f"/studio/prompts/{created['id']}",
                json={"title": "街拍", "body": "a portrait", "group_id": group["id"]},
            )
        ).json()
        assert moved["group_id"] == group["id"]
        assert moved["version"] == 1


class TestComposeWithAI:
    """AI 写一条（M68）。

    这一路唯一真正会出事的地方是**产出直接入库**：模型写的东西质量参差，库里
    一旦混进没人看过的条目，整个库就不敢直接套用了。所以端点只产出、不落库，
    落不落由人在编辑器里点保存决定。
    """

    @staticmethod
    def _stub(monkeypatch, payload: dict, capture: dict | None = None):
        async def fake(capability, system, user, *, deployment_id=None):
            if capture is not None:
                capture.update(
                    {
                        "capability": capability,
                        "system": system,
                        "user": user,
                        "deployment_id": deployment_id,
                    }
                )
            return payload, "deepseek-chat", 42

        monkeypatch.setattr(studio_prompts.llm, "complete_json", fake)

    async def test_compose_returns_a_draft_and_writes_nothing(self, client, monkeypatch):
        before = (await client.get("/studio/prompts?builtin=false")).json()["items"]
        self._stub(
            monkeypatch,
            {
                "title": "黄昏街拍",
                "scene": "想要一张暖调街头人像时",
                "body": "a candid street portrait at golden hour, warm rim light",
                "negative": "blurry, watermark",
                "variables": [],
            },
        )
        resp = await client.post("/studio/prompts/compose", json={"intent": "黄昏街头人像"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["title"] == "黄昏街拍"
        assert "golden hour" in data["body"]
        assert data["negative"] == "blurry, watermark"
        # 「模型」那一位显示的是上游真名，不是能力名（核心原则 6）
        assert data["model"] == "deepseek-chat"

        after = (await client.get("/studio/prompts?builtin=false")).json()["items"]
        assert len(after) == len(before), "AI 产出不许自己入库"
        assert all("golden hour" not in item["body"] for item in after)

    async def test_compose_uses_the_studio_chat_capability(self, client, monkeypatch):
        captured: dict = {}
        self._stub(monkeypatch, {"body": "a cat"}, captured)
        await client.post("/studio/prompts/compose", json={"intent": "一只猫"})
        assert captured["capability"] == "chat-general"
        assert "一只猫" in captured["user"]

    async def test_draft_alone_turns_into_expansion(self, client, monkeypatch):
        """各工具提示词框旁的「AI 扩写」走的就是这条：只给原稿，不给 intent。"""
        captured: dict = {}
        self._stub(monkeypatch, {"body": "a cat on a windowsill, soft morning light"}, captured)
        resp = await client.post("/studio/prompts/compose", json={"draft": "a cat"})
        assert resp.status_code == 200
        assert resp.json()["mode"] == "expand"
        assert "扩写" in captured["user"]
        assert "a cat" in captured["user"]

    async def test_empty_request_is_rejected_before_calling_the_model(
        self, client, monkeypatch
    ):
        called = False

        async def fake(*_args, **_kwargs):
            nonlocal called
            called = True
            return {}, "m", 1

        monkeypatch.setattr(studio_prompts.llm, "complete_json", fake)
        resp = await client.post("/studio/prompts/compose", json={})
        assert resp.status_code == 400
        assert called is False

    async def test_variable_names_come_from_the_body_not_the_model_list(
        self, client, monkeypatch
    ):
        """模型爱多列几个正文里没有的变量。照单全收的话，编辑器上会多出
        填了也没用的空格子，存一次又自己消失。"""
        self._stub(
            monkeypatch,
            {
                "body": "a photo of {{主体}} in {{场景}}",
                "negative": "",
                "variables": [
                    {"name": "主体", "label": "主体", "description": "拍谁"},
                    {"name": "幽灵", "label": "不存在", "description": "正文里没有"},
                ],
            },
        )
        data = (
            await client.post(
                "/studio/prompts/compose",
                json={"intent": "人像", "with_variables": True},
            )
        ).json()
        names = [spec["name"] for spec in data["variables"]]
        assert names == ["主体", "场景"]
        # 人写的说明保留，正文里没有的丢掉
        assert data["variables"][0]["description"] == "拍谁"
        assert all(spec["name"] != "幽灵" for spec in data["variables"])

    async def test_body_as_a_list_is_joined_not_dropped(self, client, monkeypatch):
        """模型偶尔把 body 吐成数组。丢掉的话用户看到的是空编辑器，
        而内容其实是对的，只是形状不对。"""
        self._stub(monkeypatch, {"body": ["a cat", "soft light"], "negative": ""})
        data = (await client.post("/studio/prompts/compose", json={"intent": "猫"})).json()
        assert data["body"] == "a cat, soft light"

    async def test_empty_body_is_an_error_not_an_empty_editor(self, client, monkeypatch):
        self._stub(monkeypatch, {"title": "有标题没正文", "body": ""})
        resp = await client.post("/studio/prompts/compose", json={"intent": "猫"})
        assert resp.status_code == 502

    async def test_unbound_capability_surfaces_as_503(self, client, monkeypatch):
        async def fake(*_args, **_kwargs):
            raise studio_prompts.llm.LLMUnavailable("能力 chat-general 尚未绑定模型")

        monkeypatch.setattr(studio_prompts.llm, "complete_json", fake)
        resp = await client.post("/studio/prompts/compose", json={"intent": "猫"})
        assert resp.status_code == 503
        assert "尚未绑定" in resp.json()["detail"]

    async def test_language_and_negative_switches_reach_the_prompt(self, client, monkeypatch):
        captured: dict = {}
        self._stub(monkeypatch, {"body": "一只猫"}, captured)
        await client.post(
            "/studio/prompts/compose",
            json={"intent": "猫", "language": "zh", "with_negative": False},
        )
        assert "简体中文" in captured["user"]
        assert "negative 给空字符串" in captured["user"]

    async def test_too_many_variables_is_rejected_before_the_editor(
        self, client, monkeypatch
    ):
        """数量闸门与保存路径同一条，否则用户改半天再点保存才被拒。"""
        body = " ".join(f"{{{{v{index}}}}}" for index in range(studio_prompts.MAX_VARIABLES + 1))
        self._stub(monkeypatch, {"body": body})
        resp = await client.post(
            "/studio/prompts/compose", json={"intent": "很多变量", "with_variables": True}
        )
        assert resp.status_code == 400
        assert "最多" in resp.json()["detail"]

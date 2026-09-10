"""创作工坊 M3：提示词库 + GPT 创作对话（FR-476、FR-478）。

守的是几条会静默出错的约束：

- **内置模板不可改**：它们是常量不是行，改了下次发版就冲掉；patch/delete 必须 400
  并直说该先 fork（而不是假装改成功）。
- **删组不删条目**：与素材分组同一条口径，`group_id` 置空退回未归组。
- **工具最多连调 2 次**：出图是花钱的调用，模型打转的代价是真金白银。
- **断流不丢已出的图**（BR-110）：后半程炸了，前面出好的图照样落进会话。

GPT 那一组全程 monkeypatch 掉底层 chat 客户端与 `imagegen.render_images`，
**不打真实网络**；`image_assets.ingest_one` 是真跑的（走内存存储），
所以「产图确实进了资产库」这条是真验的，不是断言桩函数被调过。
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from domain import image_assets, imagegen, studio_gpt, studio_media_assets, studio_prompts
from domain.imagegen import RenderResult
from domain.models import ImageAsset, ModelDeployment, ProviderCredential, StudioGptChat
from tests.model_binding_stub import seed_default_bindings
from tests.test_studio import FakeStorage, noise_png, seed_asset


@pytest.fixture
def fake_storage():
    from domain import storage as storage_mod

    fake = FakeStorage()
    storage_mod.set_storage(fake)
    yield fake
    storage_mod.set_storage(None)


# ---- 提示词分组 ----


class TestPromptGroups:
    async def test_create_list_patch(self, client):
        lib = (await client.post("/studio/prompt-groups", json={"name": "商用"})).json()
        assert lib["parent_id"] is None and lib["count"] == 0
        sub = (
            await client.post(
                "/studio/prompt-groups", json={"name": "电商", "parent_id": lib["id"]}
            )
        ).json()
        assert sub["parent_id"] == lib["id"]

        items = (await client.get("/studio/prompt-groups")).json()["items"]
        assert [g["name"] for g in items] == ["商用", "电商"]

        renamed = (
            await client.patch(f"/studio/prompt-groups/{sub['id']}", json={"name": "电商图"})
        ).json()
        # 只改名不该顺手把组挪到顶级
        assert renamed["name"] == "电商图" and renamed["parent_id"] == lib["id"]

        promoted = (
            await client.patch(f"/studio/prompt-groups/{sub['id']}", json={"parent_id": None})
        ).json()
        assert promoted["parent_id"] is None

    async def test_three_levels_rejected(self, client):
        lib = (await client.post("/studio/prompt-groups", json={"name": "库"})).json()
        sub = (
            await client.post("/studio/prompt-groups", json={"name": "子", "parent_id": lib["id"]})
        ).json()
        resp = await client.post(
            "/studio/prompt-groups", json={"name": "孙", "parent_id": sub["id"]}
        )
        assert resp.status_code == 400
        assert "两级" in resp.json()["detail"]

    async def test_group_with_children_cannot_be_demoted(self, client):
        lib = (await client.post("/studio/prompt-groups", json={"name": "库"})).json()
        other = (await client.post("/studio/prompt-groups", json={"name": "另一个库"})).json()
        await client.post("/studio/prompt-groups", json={"name": "子", "parent_id": lib["id"]})
        resp = await client.patch(
            f"/studio/prompt-groups/{lib['id']}", json={"parent_id": other["id"]}
        )
        assert resp.status_code == 400
        assert "三级" in resp.json()["detail"]

    async def test_unknown_group_is_404(self, client):
        missing = await client.patch("/studio/prompt-groups/999", json={"name": "x"})
        assert missing.status_code == 404
        assert (await client.delete("/studio/prompt-groups/999")).status_code == 404

    async def test_delete_group_releases_prompts_but_keeps_them(self, client):
        """删组只解除归属：条目退回未归组，一条都不删。"""
        lib = (await client.post("/studio/prompt-groups", json={"name": "临时"})).json()
        ids = []
        for index in range(2):
            created = await client.post(
                "/studio/prompts",
                json={"title": f"条目{index}", "body": "a cat", "group_id": lib["id"]},
            )
            ids.append(created.json()["id"])

        listed = (await client.get(f"/studio/prompts?group_id={lib['id']}")).json()["items"]
        assert sorted(item["id"] for item in listed) == sorted(ids)

        deleted = await client.delete(f"/studio/prompt-groups/{lib['id']}")
        assert deleted.json() == {"ok": True, "released": 2}

        rest = (await client.get("/studio/prompts?builtin=false")).json()["items"]
        assert sorted(item["id"] for item in rest) == sorted(ids)
        assert all(item["group_id"] is None for item in rest)


# ---- 内置模板与条目 ----


class TestBuiltinPrompts:
    def test_catalog_is_complete_and_unique(self):
        """Lingua 10 条与 Infinite-Canvas 10 条都在，字段不空且标识唯一。"""
        assert len(studio_prompts.LOCAL_BUILTIN_PROMPTS) == 10
        assert len(studio_prompts.INFINITE_CANVAS_PROMPTS) == 10
        assert len(studio_prompts.BUILTIN_PROMPTS) == 20
        keys = [item["key"] for item in studio_prompts.BUILTIN_PROMPTS]
        titles = [item["title"] for item in studio_prompts.BUILTIN_PROMPTS]
        assert len(set(keys)) == len(keys)
        assert len(set(titles)) == len(titles)
        for item in studio_prompts.BUILTIN_PROMPTS:
            assert item["body"].strip(), item["key"]
            assert item["negative"].strip(), item["key"]
            assert item["scene"].strip(), item["key"]
        assert all(
            item["source"] == "Infinite-Canvas"
            and item["source_ref"] == studio_prompts.INFINITE_CANVAS_SOURCE_REF
            for item in studio_prompts.INFINITE_CANVAS_PROMPTS
        )

    async def test_source_provenance_is_exposed(self, client):
        items = (await client.get("/studio/prompts?builtin=true")).json()["items"]
        source_items = [item for item in items if item["source"] == "Infinite-Canvas"]
        assert len(source_items) == 10
        assert all(
            item["source_ref"] == studio_prompts.INFINITE_CANVAS_SOURCE_REF
            for item in source_items
        )
        local_items = [item for item in items if item["source"] == "Lingua"]
        assert len(local_items) == 10

    def test_ids_are_negative_and_stable(self):
        ids = list(studio_prompts.BUILTIN_BY_ID)
        assert ids == [-(i + 1) for i in range(len(studio_prompts.BUILTIN_PROMPTS))]
        assert all(studio_prompts.is_builtin(i) for i in ids)

    async def test_list_puts_builtin_last(self, client):
        await client.post("/studio/prompts", json={"title": "我的模板", "body": "a dog"})
        items = (await client.get("/studio/prompts")).json()["items"]
        flags = [item["builtin"] for item in items]
        assert flags[0] is False
        assert flags.count(False) == 1
        # 自建全在前、内置全在后：不能交替出现
        assert flags == sorted(flags, key=lambda x: (x is True,))
        builtins = [item for item in items if item["builtin"]]
        assert len(builtins) == len(studio_prompts.BUILTIN_PROMPTS)
        assert all(item["id"] < 0 and item["used_count"] == 0 for item in builtins)

    async def test_patch_and_delete_builtin_rejected(self, client):
        patched = await client.patch("/studio/prompts/-1", json={"title": "改个名"})
        assert patched.status_code == 400
        assert "内置模板不可改" in patched.json()["detail"]
        assert "复制" in patched.json()["detail"]

        # 收藏也是改：内置条目没有落库的行，收藏状态无处可存
        favorited = await client.patch("/studio/prompts/-1", json={"favorite": True})
        assert favorited.status_code == 400

        deleted = await client.delete("/studio/prompts/-1")
        assert deleted.status_code == 400
        assert "内置模板不可改" in deleted.json()["detail"]

    async def test_missing_builtin_id_is_404(self, client):
        resp = await client.patch("/studio/prompts/-999", json={"title": "x"})
        assert resp.status_code == 404

    async def test_fork_builtin_makes_editable_copy(self, client):
        source = (await client.get("/studio/prompts?builtin=true")).json()["items"][0]
        forked = await client.post(f"/studio/prompts/{source['id']}/fork", json={})
        assert forked.status_code == 201
        copy = forked.json()
        assert copy["builtin"] is False and copy["id"] > 0
        assert copy["title"] == source["title"] + studio_prompts.FORK_SUFFIX
        assert copy["body"] == source["body"] and copy["negative"] == source["negative"]

        # 副本能改，这才是 fork 的意义
        patched = await client.patch(
            f"/studio/prompts/{copy['id']}", json={"body": "my own words", "favorite": True}
        )
        assert patched.status_code == 200
        assert patched.json()["body"] == "my own words"
        assert patched.json()["favorite"] is True

    async def test_use_counts_custom_and_ignores_builtin(self, client):
        created = (
            await client.post("/studio/prompts", json={"title": "常用", "body": "a cat"})
        ).json()
        first = await client.post(f"/studio/prompts/{created['id']}/use", json={})
        assert first.json() == {"ok": True, "used_count": 1}
        second = await client.post(f"/studio/prompts/{created['id']}/use", json={})
        assert second.json()["used_count"] == 2

        # 内置条目不计数，但也不能报错——套用不该被一个统计数字打断
        builtin = await client.post("/studio/prompts/-1/use", json={})
        assert builtin.status_code == 200
        assert builtin.json() == {"ok": True, "used_count": 0}

    async def test_search_matches_title_body_and_scene(self, client):
        await client.post(
            "/studio/prompts",
            json={"title": "夜景", "body": "neon street", "scene": "赛博朋克气氛图"},
        )
        by_title = (await client.get("/studio/prompts?q=夜景")).json()["items"]
        assert [item["title"] for item in by_title] == ["夜景"]

        by_body = (await client.get("/studio/prompts?q=neon")).json()["items"]
        assert any(item["title"] == "夜景" and not item["builtin"] for item in by_body)
        assert any(
            item["title"] == "电影级光影校正" and item["source"] == "Infinite-Canvas"
            for item in by_body
        )

        by_scene = (await client.get("/studio/prompts?q=赛博朋克")).json()["items"]
        assert [item["title"] for item in by_scene] == ["夜景"]

        # 内置条目也参与搜索
        hits = (await client.get("/studio/prompts?q=白底")).json()["items"]
        assert any(item["builtin"] and "白底" in item["scene"] for item in hits)

        assert (await client.get("/studio/prompts?q=不存在的词")).json()["items"] == []

    async def test_favorite_filter_excludes_builtin(self, client):
        created = (
            await client.post("/studio/prompts", json={"title": "收藏项", "body": "a cat"})
        ).json()
        await client.patch(f"/studio/prompts/{created['id']}", json={"favorite": True})
        items = (await client.get("/studio/prompts?favorite=true")).json()["items"]
        assert [item["title"] for item in items] == ["收藏项"]

    async def test_empty_title_or_body_rejected(self, client):
        assert (
            await client.post("/studio/prompts", json={"title": "", "body": "a cat"})
        ).status_code == 422
        assert (
            await client.post("/studio/prompts", json={"title": "x", "body": ""})
        ).status_code == 422


# ---- GPT 创作对话：测试替身 ----


def _chunk(text: str | None = None, tool_calls: list | None = None) -> SimpleNamespace:
    delta = SimpleNamespace(content=text, tool_calls=tool_calls)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)])


def _tool_piece(index: int, name: str | None, arguments: str, call_id: str | None = None):
    return SimpleNamespace(
        index=index,
        id=call_id,
        function=SimpleNamespace(name=name, arguments=arguments),
    )


class _Stream:
    def __init__(self, chunks: list) -> None:
        self._chunks = chunks

    def __aiter__(self):
        async def gen():
            for chunk in self._chunks:
                yield chunk

        return gen()


class _Completions:
    """按脚本逐轮回放。脚本项是 chunk 列表，或一个异常实例（当场抛）。"""

    def __init__(self, script: list) -> None:
        self.script = list(script)
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if not self.script:
            return _Stream([])
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return _Stream(item)


class _FakeClient:
    def __init__(self, script: list) -> None:
        self.completions = _Completions(script)
        self.chat = SimpleNamespace(completions=self.completions)
        self.closed = False

    async def close(self) -> None:
        self.closed = True


@pytest.fixture
async def bound_models(session):
    """把 chat-general / image-* 绑到直连部署上。

    能力没绑定时路由直接报「未绑定」，连客户端都建不出来（网关回落已下线）。
    """
    return await seed_default_bindings(session)


@pytest.fixture
def fake_chat(monkeypatch, bound_models):
    """装一个可编脚本的对话客户端，返回装配函数。"""

    holder: dict = {}

    def install(script: list) -> _FakeClient:
        client = _FakeClient(script)
        holder["client"] = client
        monkeypatch.setattr(studio_gpt, "_client", lambda _route: client)
        return client

    return install


@pytest.fixture
def fake_render(monkeypatch):
    """替掉真出图。记录调用参数，返回一张真 PNG 让 ingest 真跑。"""

    calls: list[dict] = []

    async def _render(prompt: str, **kwargs):
        calls.append({"prompt": prompt, **kwargs})
        return RenderResult(images=[noise_png()], model_reported="fake-image", latency_ms=12)

    monkeypatch.setattr(imagegen, "render_images", _render)
    return calls


def _events(body: str) -> list[dict]:
    out: list[dict] = []
    for frame in body.split("\n\n"):
        line = next((ln for ln in frame.split("\n") if ln.startswith("data:")), None)
        if line is not None:
            out.append(json.loads(line[5:].strip()))
    return out


IMAGE_CALL = [
    _chunk(tool_calls=[_tool_piece(0, "generate_image", "", "call_a")]),
    _chunk(tool_calls=[_tool_piece(0, None, '{"prompt":')]),
    _chunk(tool_calls=[_tool_piece(0, None, '"a red apple"}')]),
]


# ---- GPT 创作对话：会话 CRUD ----


class TestGptChatCrud:
    async def test_create_get_list_and_meta(self, client):
        created = (
            await client.post(
                "/studio/gpt-chats", json={"title": "画点东西", "system_prompt": "你只说中文"}
            )
        ).json()
        assert created["title"] == "画点东西"
        assert created["system_prompt"] == "你只说中文"
        assert created["version"] == 1 and created["turns"] == []

        got = (await client.get(f"/studio/gpt-chats/{created['id']}")).json()
        assert got == created

        listed = (await client.get("/studio/gpt-chats")).json()["items"]
        assert listed[0]["id"] == created["id"] and listed[0]["turn_count"] == 0

        meta = await client.patch(
            f"/studio/gpt-chats/{created['id']}/meta", json={"title": "改名", "pinned": True}
        )
        assert meta.json() == {"ok": True}
        after = (await client.get(f"/studio/gpt-chats/{created['id']}")).json()
        assert after["title"] == "改名" and after["pinned"] is True
        # meta 不动 version、不刷 updated_at（BR-146）
        assert after["version"] == 1 and after["updated_at"] == created["updated_at"]

        assert (await client.delete(f"/studio/gpt-chats/{created['id']}")).json() == {"ok": True}
        assert (await client.get(f"/studio/gpt-chats/{created['id']}")).status_code == 404

    async def test_empty_text_rejected(self, client):
        chat = (await client.post("/studio/gpt-chats", json={})).json()
        resp = await client.post(f"/studio/gpt-chats/{chat['id']}/send", json={"text": ""})
        assert resp.status_code == 422

    async def test_too_many_images_rejected(self, client):
        chat = (await client.post("/studio/gpt-chats", json={})).json()
        resp = await client.post(
            f"/studio/gpt-chats/{chat['id']}/send",
            json={"text": "看图", "image_asset_ids": list(range(1, 22))},
        )
        assert resp.status_code == 422

    async def test_combined_attachment_limit_is_enforced(self, client):
        chat = (await client.post("/studio/gpt-chats", json={})).json()
        resp = await client.post(
            f"/studio/gpt-chats/{chat['id']}/send",
            json={
                "text": "看附件",
                "image_asset_ids": list(range(1, 12)),
                "media_asset_ids": list(range(20, 30)),
            },
        )
        assert resp.status_code == 422


# ---- GPT 创作对话：流式与工具 ----


class TestGptStream:
    async def test_text_only_turn(self, client, fake_chat, bound_models):
        fake = fake_chat([[_chunk("好的"), _chunk("，"), _chunk("这就画")]])
        chat = (await client.post("/studio/gpt-chats", json={})).json()

        resp = await client.post(
            f"/studio/gpt-chats/{chat['id']}/send", json={"text": "帮我想个画面"}
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        events = _events(resp.text)

        assert events[0] == {
            "type": "meta",
            "chat_model": bound_models["chat"].upstream_model_id,
            "chat_alias": studio_gpt.CHAT_ALIAS,
            "chat_deployment_id": bound_models["chat"].id,
            "image_alias": studio_gpt.IMAGE_ALIAS,
            "image_deployment_id": None,
            "image_size": studio_gpt.DEFAULT_SIZE,
        }
        assert [e["text"] for e in events if e["type"] == "delta"] == ["好的", "，", "这就画"]
        assert not any(e["type"] == "error" for e in events)

        done = events[-1]
        assert done["type"] == "done"
        assert done["turn"]["role"] == "assistant"
        assert done["turn"]["content"] == "好的，这就画"
        assert "asset_ids" not in done["turn"]

        # 两轮一起落库，version 加一
        detail = (await client.get(f"/studio/gpt-chats/{chat['id']}")).json()
        assert [t["role"] for t in detail["turns"]] == ["user", "assistant"]
        assert detail["turns"][0]["content"] == "帮我想个画面"
        assert detail["version"] == 2
        assert fake.closed is True

    async def test_explicit_chat_deployment_is_used_and_logged(
        self, client, session, fake_chat
    ):
        credential = ProviderCredential(
            name="Agent 直连",
            kind="llm",
            provider_type="openai_compatible",
            config={"api_base": "https://agent.example.invalid/v1", "api_key": "sk-test"},
        )
        session.add(credential)
        await session.flush()
        deployment = ModelDeployment(
            credential_id=credential.id,
            upstream_model_id="agent-direct-model",
            adapter_type="openai",
            media_types=["chat"],
        )
        session.add(deployment)
        await session.commit()

        fake = fake_chat([[_chunk("直连回复")]])
        chat = (await client.post("/studio/gpt-chats", json={})).json()
        response = await client.post(
            f"/studio/gpt-chats/{chat['id']}/send",
            json={"text": "你好", "chat_deployment_id": deployment.id},
        )

        events = _events(response.text)
        assert events[0]["chat_model"] == "agent-direct-model"
        assert events[0]["chat_deployment_id"] == deployment.id
        assert fake.completions.calls[0]["model"] == "agent-direct-model"
        ledger = (
            await client.get("/config/model-invocations?plugin_id=openai&limit=10")
        ).json()["items"]
        invocation = next(item for item in ledger if item["deployment_id"] == deployment.id)
        assert invocation["operation"] == "chat.stream"
        assert invocation["status"] == "succeeded"
        assert invocation["response"]["text"] == "直连回复"

    async def test_tool_call_generates_and_ingests_image(
        self, client, session, fake_chat, fake_render, fake_storage
    ):
        fake = fake_chat([IMAGE_CALL, [_chunk("画好了，红苹果一枚")]])
        chat = (await client.post("/studio/gpt-chats", json={})).json()

        resp = await client.post(
            f"/studio/gpt-chats/{chat['id']}/send", json={"text": "画个苹果"}
        )
        events = _events(resp.text)

        images = [e for e in events if e["type"] == "image"]
        assert len(images) == 1
        assert images[0]["prompt"] == "a red apple"
        assert images[0]["url"].startswith("/api/images/assets/")

        # 真进了模块 16 的资产库（BR-140）：source/op/别名都对得上
        asset_id = images[0]["asset_id"]
        row = await session.get(ImageAsset, asset_id)
        assert row is not None
        assert row.source == "workbench" and row.op == studio_gpt.OP_KEY
        assert row.alias == studio_gpt.IMAGE_ALIAS and row.target_key == "free"
        assert row.prompt == "a red apple"

        # 出图参数固定 n=1，走的是既有 render_images（BR-141）
        assert fake_render[0]["alias"] == studio_gpt.IMAGE_ALIAS
        assert fake_render[0]["n"] == 1
        assert fake_render[0]["size"] == studio_gpt.DEFAULT_SIZE

        done = events[-1]
        assert done["turn"]["asset_ids"] == [asset_id]
        assert done["turn"]["content"] == "画好了，红苹果一枚"

        # 第二轮把工具结果回填了进去，模型才能对着图说话
        second = fake.completions.calls[1]["messages"]
        assert second[-2]["role"] == "assistant" and second[-2]["tool_calls"]
        assert second[-1]["role"] == "tool"
        assert json.loads(second[-1]["content"])["asset_id"] == asset_id

        detail = (await client.get(f"/studio/gpt-chats/{chat['id']}")).json()
        assert detail["turns"][-1]["asset_ids"] == [asset_id]

    async def test_selected_image_size_overrides_tool_argument(
        self, client, fake_chat, fake_render, fake_storage
    ):
        fake = fake_chat([IMAGE_CALL, [_chunk("已按画幅生成")]])
        chat = (await client.post("/studio/gpt-chats", json={})).json()

        response = await client.post(
            f"/studio/gpt-chats/{chat['id']}/send",
            json={"text": "画竖版", "image_size": "1088x1920"},
        )
        events = _events(response.text)

        assert events[0]["image_size"] == "1088x1920"
        assert fake_render[0]["size"] == "1088x1920"
        tools = fake.completions.calls[0]["tools"]
        assert tools[0]["function"]["parameters"]["properties"]["size"]["enum"] == [
            "1088x1920"
        ]
        detail = (await client.get(f"/studio/gpt-chats/{chat['id']}")).json()
        assert detail["turns"][0]["image_size"] == "1088x1920"

    async def test_tool_calls_capped(self, client, fake_chat, fake_render, fake_storage):
        """一直调工具也只画两张：出图是花钱的调用，打转的代价是真金白银。"""
        fake = fake_chat([IMAGE_CALL, IMAGE_CALL, IMAGE_CALL, IMAGE_CALL])
        chat = (await client.post("/studio/gpt-chats", json={})).json()

        resp = await client.post(f"/studio/gpt-chats/{chat['id']}/send", json={"text": "多画几张"})
        events = _events(resp.text)

        assert len(fake_render) == studio_gpt.MAX_TOOL_CALLS
        assert len([e for e in events if e["type"] == "image"]) == studio_gpt.MAX_TOOL_CALLS
        # 模型说话次数也封顶，不会无限往下滚
        assert len(fake.completions.calls) == studio_gpt.MAX_ROUNDS

        errors = [e for e in events if e["type"] == "error"]
        assert errors and "打转" in errors[0]["detail"]
        # 打转被拦下也照实记在这一轮上
        assert events[-1]["type"] == "done"
        assert events[-1]["turn"]["error"] == studio_gpt.STOPPED_NOTE

    async def test_error_keeps_generated_images(
        self, client, session, fake_chat, fake_render, fake_storage
    ):
        """BR-110：后半程炸了，前面出好的图照样落库，失败原因原样回报。"""
        fake_chat([IMAGE_CALL, RuntimeError("上游炸了")])
        chat = (await client.post("/studio/gpt-chats", json={})).json()

        resp = await client.post(f"/studio/gpt-chats/{chat['id']}/send", json={"text": "画个苹果"})
        events = _events(resp.text)

        asset_id = next(e for e in events if e["type"] == "image")["asset_id"]
        errors = [e for e in events if e["type"] == "error"]
        assert len(errors) == 1
        assert "上游炸了" in errors[0]["detail"]  # 原文，不是「操作失败」

        done = events[-1]
        assert done["type"] == "done"
        assert done["turn"]["asset_ids"] == [asset_id]
        assert "上游炸了" in done["turn"]["error"]

        detail = (await client.get(f"/studio/gpt-chats/{chat['id']}")).json()
        assert detail["turns"][-1]["asset_ids"] == [asset_id]
        assert detail["version"] == 2
        assert await session.get(ImageAsset, asset_id) is not None

    async def test_image_tool_failure_does_not_kill_the_turn(
        self, client, monkeypatch, fake_chat, fake_storage
    ):
        """一次出图失败只回给模型一条工具错误，对话继续。"""

        async def _boom(prompt: str, **kwargs):
            raise imagegen.ImageGenError("content", "提示词被上游安全策略拒绝：nope")

        monkeypatch.setattr(imagegen, "render_images", _boom)
        fake = fake_chat([IMAGE_CALL, [_chunk("这个画不了，换个说法？")]])
        chat = (await client.post("/studio/gpt-chats", json={})).json()

        resp = await client.post(f"/studio/gpt-chats/{chat['id']}/send", json={"text": "画个东西"})
        events = _events(resp.text)

        assert not any(e["type"] == "image" for e in events)
        tool_result = json.loads(fake.completions.calls[1]["messages"][-1]["content"])
        assert tool_result["ok"] is False and "安全策略" in tool_result["error"]
        assert events[-1]["turn"]["content"] == "这个画不了，换个说法？"
        assert "error" not in events[-1]["turn"]

    async def test_unknown_tool_is_answered_not_crashed(self, client, fake_chat):
        fake = fake_chat(
            [
                [_chunk(tool_calls=[_tool_piece(0, "delete_everything", "{}", "call_x")])],
                [_chunk("没有这个工具")],
            ]
        )
        chat = (await client.post("/studio/gpt-chats", json={})).json()
        resp = await client.post(f"/studio/gpt-chats/{chat['id']}/send", json={"text": "乱来"})
        events = _events(resp.text)

        tool_result = json.loads(fake.completions.calls[1]["messages"][-1]["content"])
        assert tool_result["ok"] is False
        assert events[-1]["type"] == "done"

    async def test_tools_are_declared_on_every_call(self, client, fake_chat, bound_models):
        fake = fake_chat([[_chunk("好")]])
        chat = (await client.post("/studio/gpt-chats", json={})).json()
        await client.post(f"/studio/gpt-chats/{chat['id']}/send", json={"text": "聊聊"})

        kwargs = fake.completions.calls[0]
        # 直连部署发上游真名；能力别名只在绑定表里出现
        assert kwargs["model"] == bound_models["chat"].upstream_model_id
        assert kwargs["stream"] is True
        assert kwargs["tools"][0]["function"]["name"] == studio_gpt.TOOL_NAME
        # 系统提示词缺省用服务端那份
        assert kwargs["messages"][0]["role"] == "system"
        assert kwargs["messages"][0]["content"] == studio_gpt.DEFAULT_SYSTEM

    async def test_custom_system_prompt_wins(self, client, fake_chat):
        fake = fake_chat([[_chunk("好")]])
        chat = (
            await client.post("/studio/gpt-chats", json={"system_prompt": "只用英文回答"})
        ).json()
        await client.post(f"/studio/gpt-chats/{chat['id']}/send", json={"text": "hi"})
        assert fake.completions.calls[0]["messages"][0]["content"] == "只用英文回答"


# ---- GPT 创作对话：入参处理（纯函数） ----


class TestGptInputs:
    def test_history_truncated_by_turns_and_chars(self):
        turns = [
            {"role": "user" if i % 2 == 0 else "assistant", "content": "x" * 5000}
            for i in range(60)
        ]
        messages = studio_gpt.history_messages(turns)
        assert len(messages) == studio_gpt.MAX_HISTORY_TURNS
        assert all(len(m["content"]) <= studio_gpt.MAX_TURN_CHARS for m in messages)
        # 留的是最近的，不是最早的
        assert messages[-1]["role"] == turns[-1]["role"]

    def test_history_notes_images_without_resending_them(self):
        turns = [
            {"role": "user", "content": "看这张", "image_asset_ids": [7, 8]},
            {"role": "assistant", "content": "画好了", "asset_ids": [9]},
        ]
        messages = studio_gpt.history_messages(turns)
        assert messages[0]["content"] == "看这张（这一轮带了 2 张图）"
        assert messages[1]["content"] == "画好了（这一轮出了 1 张图）"
        # 历史里的图不重新上送：全是纯文本 content
        assert all(isinstance(m["content"], str) for m in messages)

    def test_history_skips_broken_rows(self):
        turns = ["坏数据", {"role": "system", "content": "x"}, {"role": "user", "content": ""}]
        assert studio_gpt.history_messages(turns) == []

    async def test_multimodal_blocks_shape(self, session, fake_storage):
        asset = await seed_asset(session, fake_storage, noise_png())
        blocks = await studio_gpt.image_blocks(session, [asset.id])
        assert len(blocks) == 1
        assert blocks[0]["type"] == "image_url"
        url = blocks[0]["image_url"]["url"]
        assert url.startswith("data:image/png;base64,")

        chat = StudioGptChat(title="t", turns=[])
        messages = studio_gpt.build_messages(chat, "看这张图", blocks)
        content = messages[-1]["content"]
        assert isinstance(content, list)
        assert content[0] == {"type": "text", "text": "看这张图"}
        assert content[1] is blocks[0]

    async def test_missing_asset_reports_plainly(self, session, fake_storage):
        chat = StudioGptChat(title="t", turns=[])
        session.add(chat)
        await session.commit()
        with pytest.raises(Exception) as caught:
            await studio_gpt.image_blocks(session, [4242])
        assert "资产不存在" in str(caught.value)

    async def test_send_with_image_streams_and_persists_ids(
        self, client, session, fake_chat, fake_storage
    ):
        asset = await seed_asset(session, fake_storage, noise_png())
        fake = fake_chat([[_chunk("看到了")]])
        chat = (await client.post("/studio/gpt-chats", json={})).json()

        resp = await client.post(
            f"/studio/gpt-chats/{chat['id']}/send",
            json={"text": "这张图什么风格", "image_asset_ids": [asset.id]},
        )
        events = _events(resp.text)
        assert events[-1]["type"] == "done"

        sent = fake.completions.calls[0]["messages"][-1]["content"]
        assert isinstance(sent, list) and sent[1]["type"] == "image_url"

        detail = (await client.get(f"/studio/gpt-chats/{chat['id']}")).json()
        assert detail["turns"][0]["image_asset_ids"] == [asset.id]

    async def test_file_attachment_text_is_sent_and_persisted(
        self, client, session, fake_chat, fake_storage
    ):
        attachment = await studio_media_assets.ingest_one(
            session,
            b"brand color: cobalt blue",
            kind="file",
            name="brief.txt",
            mime="text/plain",
        )
        await session.commit()
        fake = fake_chat([[_chunk("已读取简报")]])
        chat = (await client.post("/studio/gpt-chats", json={})).json()

        response = await client.post(
            f"/studio/gpt-chats/{chat['id']}/send",
            json={"text": "按简报出一个方案", "media_asset_ids": [attachment.id]},
        )
        assert _events(response.text)[-1]["type"] == "done"
        content = fake.completions.calls[0]["messages"][-1]["content"]
        assert content[1]["type"] == "text"
        assert "brief.txt" in content[1]["text"]
        assert "cobalt blue" in content[1]["text"]

        detail = (await client.get(f"/studio/gpt-chats/{chat['id']}")).json()
        assert detail["turns"][0]["media_asset_ids"] == [attachment.id]


class TestAssetViewContract:
    """image 事件里的 url 与资产库对外那套是同一份，前端不必自己拼。"""

    async def test_image_event_url_matches_asset_view(self, session, fake_storage):
        asset = await seed_asset(session, fake_storage, noise_png())
        assert image_assets.asset_view(asset)["url"].startswith(
            f"/api/images/assets/{asset.id}/display"
        )


class TestSelfBuiltClientProxy:
    """自己 new httpx 客户端的地方，凡是上游可能在本机，都要按 is_local 判代理。

    这条坑第一次修只覆盖了 domain/gateway 管着的几个 LLM 客户端，配置中心那个
    自建客户端漏在外面——表现是**能力绑定保存不了**（一个 502），而那个报错看起来
    像配置中心自己的毛病，很难联想到是系统代理。ComfyUI 与 Ollama 这类上游默认就在
    本机，判据必须跟着走。
    """

    async def test_comfy_model_fetch_bypasses_proxy_for_loopback(self, monkeypatch):
        import httpx

        from domain import credentials, network_policy

        calls = []

        def transport_factory(*, proxy, trust_env):
            calls.append((proxy, trust_env))
            return httpx.MockTransport(lambda request: httpx.Response(200, json={"LoadImage": {}}))

        monkeypatch.setenv("HTTPS_PROXY", "http://unused.invalid:1234")
        monkeypatch.setattr(network_policy.httpx, "AsyncHTTPTransport", transport_factory)
        models = await credentials._comfy_fetch_models(
            {"base_url": "http://127.0.0.1:8188"}, "comfyui"
        )
        assert models == [{"id": "LoadImage", "media_types": ["workflow"]}]
        assert calls == [(None, False)]


class TestDisconnectPersistence:
    """客户端断流时，已生成的内容必须照样落库。

    这条是实测挖出来的真缺陷：原来 finally 里直接 `await append_turns(session, ...)`，
    断开时**根本落不了库**（两种断法都是 turns: 0）——请求作用域的 session 这时
    已经在拆，而且 CancelledError 是 BaseException，`except Exception` 兜不住。
    现在改成「自己开 session 的独立任务 + shield 挡取消」。
    """

    def test_persist_uses_its_own_session(self):
        """落库函数必须自己开 session，不能复用请求作用域那个。"""
        import inspect

        from domain import studio_gpt

        src = inspect.getsource(studio_gpt._persist_turn)
        assert "detached_session()" in src, "落库要自己开 session"
        assert "session" not in inspect.signature(studio_gpt._persist_turn).parameters

    def test_finally_shields_the_persist_task(self):
        """shield 是关键：外层 await 被取消时内层任务照样跑完。"""
        import inspect

        from domain import studio_gpt

        src = inspect.getsource(studio_gpt.stream_turn)
        assert "asyncio.shield" in src
        assert "asyncio.create_task" in src
        # CancelledError 要单独接住并记日志，不能和普通异常混在一起当失败处理
        assert "except asyncio.CancelledError" in src

    def test_partial_text_is_kept_incrementally(self):
        """半路断掉的正文也要保住：不能等一轮跑完才 append。"""
        import inspect

        from domain import studio_gpt

        src = inspect.getsource(studio_gpt.stream_turn)
        assert "slot" in src, "正文要先占位再就地更新"

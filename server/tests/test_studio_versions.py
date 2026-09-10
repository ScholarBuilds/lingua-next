"""提示词模板变量 · 提示词与工作流的版本链与导出（模块 17 ST-14 / ST-15）。

守的是几条会静默出错的约束：

- **缺必填变量必须报错**，绝不能把 `{{name}}` 原样当正文发给模型——模型不会抗议，
  只会照着这段乱七八糟的文字出图，用户要过很久才发现。
- **回滚不倒退版本号**：同一个号码先后指向两份内容的话，导出物上的版本号就没意义了。
- **保留策略真的裁**，且标记过的版本不被裁掉。
- **导出物不许夹带凭据或本机绝对路径**，被抹掉的位置要如实列出来（BR-110 不伪造）。
"""

from __future__ import annotations

from urllib.parse import unquote

import pytest

from domain import studio_prompts, studio_revisions, studio_workflows
from domain.models import StudioWorkflow


async def _new_prompt(client, **over) -> dict:
    body = {"title": "变量模板", "body": "a photo of {{subject}} at {{mood}} mood"}
    body.update(over)
    resp = await client.post("/studio/prompts", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---- 模板变量 ----


class TestPromptVariables:
    async def test_names_come_from_body_in_first_appearance_order(self, client):
        created = await _new_prompt(client)
        assert [item["name"] for item in created["variables"]] == ["subject", "mood"]
        assert all(item["required"] is True for item in created["variables"])
        assert created["version"] == 1

    async def test_annotations_survive_and_undeclared_names_are_dropped(self, client):
        created = await _new_prompt(
            client,
            variables=[
                {"name": "subject", "label": "主体", "description": "拍什么", "default": "a cat"},
                # 正文里没有的声明留着也替换不了任何东西，同步时丢掉
                {"name": "ghost", "label": "幽灵"},
            ],
        )
        by_name = {item["name"]: item for item in created["variables"]}
        assert set(by_name) == {"subject", "mood"}
        assert by_name["subject"]["label"] == "主体"
        assert by_name["subject"]["default"] == "a cat"

    async def test_negative_placeholders_are_collected_too(self, client):
        created = await _new_prompt(
            client, body="a portrait of {{who}}", negative="no {{avoid}}"
        )
        assert [item["name"] for item in created["variables"]] == ["who", "avoid"]

    async def test_render_fills_values_and_falls_back_to_default(self, client):
        created = await _new_prompt(
            client,
            variables=[{"name": "mood", "default": "calm"}],
        )
        resp = await client.post(
            f"/studio/prompts/{created['id']}/render", json={"values": {"subject": "a fox"}}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["body"] == "a photo of a fox at calm mood"
        assert "{{" not in resp.json()["body"]

    async def test_render_rejects_missing_required_and_never_leaks_placeholder(self, client):
        created = await _new_prompt(
            client,
            variables=[{"name": "subject", "label": "主体"}],
        )
        resp = await client.post(
            f"/studio/prompts/{created['id']}/render", json={"values": {"mood": "warm"}}
        )
        assert resp.status_code == 400, resp.text
        detail = resp.json()["detail"]
        assert "主体" in detail
        # 报错就是报错，不能把半成品正文顺手回给调用方
        assert "{{" not in detail
        assert "body" not in resp.json()

    async def test_optional_variable_may_stay_blank(self, client):
        created = await _new_prompt(
            client,
            body="a photo of {{subject}}{{extra}}",
            variables=[{"name": "extra", "required": False}],
        )
        resp = await client.post(
            f"/studio/prompts/{created['id']}/render", json={"values": {"subject": "a fox"}}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["body"] == "a photo of a fox"

    async def test_negative_is_rendered_with_the_same_values(self, client):
        created = await _new_prompt(
            client, body="a shot of {{subject}}", negative="{{subject}} blurred"
        )
        resp = await client.post(
            f"/studio/prompts/{created['id']}/render", json={"values": {"subject": "a car"}}
        )
        assert resp.json()["negative"] == "a car blurred"

    async def test_builtin_without_variables_renders_as_plain_text(self, client):
        """没有占位的内置模板照旧原样返回，不需要先填什么。"""
        prompt_id, item = next(
            (pid, tpl)
            for pid, tpl in studio_prompts.BUILTIN_BY_ID.items()
            if not tpl.get("variables")
        )
        resp = await client.post(f"/studio/prompts/{prompt_id}/render", json={"values": {}})
        assert resp.status_code == 200, resp.text
        assert resp.json()["body"] == item["body"]

    async def test_builtin_placeholders_go_through_the_same_gate(self, client):
        """内置模板的占位不是例外：缺必填一样 400。

        迁入 Infinite-Canvas 的模板时把它原文的 `[主体]` 换成了 `{{主体}}`，
        就是为了让它们接上这道闸——方括号没有任何机制托底，用户忘了替换就把
        `[主体]` 原样发给模型，模型不报错，只会照着乱出图。
        """
        prompt_id, item = next(
            (pid, tpl) for pid, tpl in studio_prompts.BUILTIN_BY_ID.items() if tpl.get("variables")
        )
        resp = await client.post(f"/studio/prompts/{prompt_id}/render", json={"values": {}})
        assert resp.status_code == 400, resp.text
        assert item["variables"][0]["label"] in resp.json()["detail"]

    async def test_variable_count_is_capped(self, client):
        names = " ".join(f"{{{{v{index}}}}}" for index in range(studio_prompts.MAX_VARIABLES + 1))
        resp = await client.post("/studio/prompts", json={"title": "太多变量", "body": names})
        assert resp.status_code == 400, resp.text
        assert str(studio_prompts.MAX_VARIABLES) in resp.json()["detail"]

    def test_stale_declaration_still_forces_the_placeholder_to_be_filled(self):
        """名单以正文为准：声明里写的是别的变量，正文里的 subject 照样得填。"""
        with pytest.raises(studio_prompts.StudioPromptError) as exc:
            studio_prompts.fill_variables(
                "a photo of {{subject}}",
                "",
                [{"name": "other", "required": False}],
                {"other": "x"},
            )
        assert "subject" in str(exc.value)

    def test_a_value_that_itself_contains_a_placeholder_is_caught(self):
        """`re.sub` 不回头扫替换进去的内容，值里写 `{{x}}` 就会原样留在结果里。
        这段发给模型它不会报错，只会照着乱出图，所以必须在这里拦下。"""
        with pytest.raises(studio_prompts.StudioPromptError) as exc:
            studio_prompts.fill_variables(
                "a photo of {{subject}}", "", [], {"subject": "{{evil}}"}
            )
        assert "{{evil}}" in str(exc.value)

    async def test_placeholder_inside_a_value_is_rejected_over_http(self, client):
        created = await _new_prompt(client)
        resp = await client.post(
            f"/studio/prompts/{created['id']}/render",
            json={"values": {"subject": "{{evil}}", "mood": "calm"}},
        )
        assert resp.status_code == 400
        assert "body" not in resp.json()

    def test_placeholder_syntax_ignores_single_braces(self):
        """单花括号是 JSON / f-string 的写法，提示词里贴 JSON 是常事，不能当变量。"""
        assert studio_prompts.extract_variable_names('{"seed": 1} and {{seed}}') == ["seed"]


# ---- 提示词版本链 ----


class TestPromptRevisions:
    async def test_create_lays_down_the_first_version(self, client):
        created = await _new_prompt(client)
        items = (await client.get(f"/studio/prompts/{created['id']}/revisions")).json()["items"]
        assert [item["version"] for item in items] == [1]
        assert items[0]["note"] == "新建"

    async def test_only_content_changes_add_a_version(self, client):
        created = await _new_prompt(client)
        after_favorite = await client.patch(
            f"/studio/prompts/{created['id']}", json={"favorite": True}
        )
        assert after_favorite.json()["version"] == 1

        after_edit = await client.patch(
            f"/studio/prompts/{created['id']}",
            json={"body": "a painting of {{subject}}", "note": "换成绘画"},
        )
        assert after_edit.json()["version"] == 2
        items = (await client.get(f"/studio/prompts/{created['id']}/revisions")).json()["items"]
        assert [item["version"] for item in items] == [2, 1]
        assert items[0]["note"] == "换成绘画"

    async def test_rollback_restores_content_and_moves_version_forward(self, client):
        created = await _new_prompt(client)
        await client.patch(f"/studio/prompts/{created['id']}", json={"body": "totally new"})

        restored = await client.post(f"/studio/prompts/{created['id']}/revisions/1/restore")
        assert restored.status_code == 200, restored.text
        assert restored.json()["body"] == created["body"]
        # 版本号只增不减：回滚本身也是新的一版
        assert restored.json()["version"] == 3
        assert [item["name"] for item in restored.json()["variables"]] == ["subject", "mood"]

        items = (await client.get(f"/studio/prompts/{created['id']}/revisions")).json()["items"]
        assert items[0]["note"] == "回滚到第 1 版"

    async def test_rollback_to_unknown_version_is_404(self, client):
        created = await _new_prompt(client)
        resp = await client.post(f"/studio/prompts/{created['id']}/revisions/9/restore")
        assert resp.status_code == 404

    async def test_builtin_has_no_history(self, client):
        resp = await client.get("/studio/prompts/-1/revisions")
        assert resp.status_code == 200
        assert resp.json()["items"] == []

    async def test_delete_takes_the_history_with_it(self, client, session):
        created = await _new_prompt(client)
        await client.patch(f"/studio/prompts/{created['id']}", json={"body": "another take"})
        assert await client.delete(f"/studio/prompts/{created['id']}")
        left = await studio_revisions.list_revisions(
            session, studio_revisions.ENTITY_PROMPT, created["id"]
        )
        assert left == []

    async def test_fork_starts_its_own_chain(self, client):
        created = await _new_prompt(client)
        copy = (await client.post(f"/studio/prompts/{created['id']}/fork", json={})).json()
        assert copy["version"] == 1
        assert [item["name"] for item in copy["variables"]] == ["subject", "mood"]
        items = (await client.get(f"/studio/prompts/{copy['id']}/revisions")).json()["items"]
        assert items[0]["note"] == f"复制自 #{created['id']}"


class TestRetention:
    async def test_window_prunes_old_versions_but_keeps_pinned(self, client, session):
        created = await _new_prompt(client)
        keep = studio_revisions.KEEP_RECENT

        # 第 2 版单独标记保留，它应当活过后面所有的裁剪
        await client.patch(f"/studio/prompts/{created['id']}", json={"body": "第二版 {{subject}}"})
        pinned = await client.patch(
            f"/studio/prompts/{created['id']}/revisions/2", json={"pinned": True}
        )
        assert pinned.status_code == 200, pinned.text
        assert pinned.json()["pinned"] is True

        for index in range(keep + 3):
            await client.patch(
                f"/studio/prompts/{created['id']}",
                json={"body": f"第 {index} 稿 {{{{subject}}}}"},
            )

        items = (await client.get(f"/studio/prompts/{created['id']}/revisions")).json()["items"]
        versions = [item["version"] for item in items]
        assert 2 in versions, "标记保留的版本不该被裁掉"
        assert 1 not in versions, "没标记的老版本应该按窗口裁掉"
        assert len([item for item in items if not item["pinned"]]) == keep

    async def test_unpinning_lets_the_window_reclaim_it(self, client, session):
        created = await _new_prompt(client)
        await client.patch(f"/studio/prompts/{created['id']}", json={"body": "第二版 {{subject}}"})
        await client.patch(f"/studio/prompts/{created['id']}/revisions/1", json={"pinned": True})
        for index in range(studio_revisions.KEEP_RECENT + 2):
            await client.patch(
                f"/studio/prompts/{created['id']}",
                json={"body": f"第 {index} 稿 {{{{subject}}}}"},
            )
        assert 1 in [
            item["version"]
            for item in (
                await client.get(f"/studio/prompts/{created['id']}/revisions")
            ).json()["items"]
        ]

        await client.patch(f"/studio/prompts/{created['id']}/revisions/1", json={"pinned": False})
        left = [
            item["version"]
            for item in (
                await client.get(f"/studio/prompts/{created['id']}/revisions")
            ).json()["items"]
        ]
        # 取消保留要当场重裁，否则这一版会一直挂到下次有人编辑
        assert 1 not in left
        assert len(left) == studio_revisions.KEEP_RECENT


# ---- 工作流版本与导出 ----

GRAPH = {
    "1": {"class_type": "KSampler", "inputs": {"seed": 0, "image": "refs/cat.png"}},
}
UI_SCHEMA = {"fields": [{"id": "seed", "node": "1", "input": "seed", "type": "number"}]}


async def _import_workflow(client, **over) -> dict:
    body = {
        "title": "我的放大流",
        "provider": "comfyui",
        "kind": "upscale",
        "payload": GRAPH,
        "ui_schema": UI_SCHEMA,
    }
    body.update(over)
    resp = await client.post("/studio/workflows", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestWorkflowVersions:
    async def test_import_and_edit_build_a_chain(self, client):
        created = await _import_workflow(client)
        assert created["version"] == 1

        edited = await client.patch(
            f"/studio/workflows/{created['id']}",
            json={"title": "改过名的流", "ui_schema": UI_SCHEMA, "note": "改名"},
        )
        assert edited.json()["version"] == 2
        items = (await client.get(f"/studio/workflows/{created['id']}/revisions")).json()["items"]
        assert [item["version"] for item in items] == [2, 1]
        assert items[0]["note"] == "改名"

    async def test_toggle_enabled_does_not_add_a_version(self, client):
        created = await _import_workflow(client)
        toggled = await client.patch(f"/studio/workflows/{created['id']}", json={"enabled": False})
        assert toggled.json()["version"] == 1

    async def test_restore_brings_back_the_old_input_mapping(self, client):
        created = await _import_workflow(client)
        await client.patch(
            f"/studio/workflows/{created['id']}",
            json={
                "title": "改坏了",
                "ui_schema": {
                    "fields": [
                        {
                            "id": "seed",
                            "node": "1",
                            "input": "seed",
                            "name": "种子",
                            "type": "number",
                        }
                    ]
                },
            },
        )
        restored = await client.post(f"/studio/workflows/{created['id']}/revisions/1/restore")
        assert restored.status_code == 200, restored.text
        assert restored.json()["title"] == "我的放大流"
        assert restored.json()["ui_schema"] == UI_SCHEMA
        assert restored.json()["version"] == 3

    async def test_bundled_workflow_cannot_be_restored(self, client):
        bundled = (await client.get("/studio/workflows")).json()["items"]
        target = next(item for item in bundled if item["source"] == "bundled")
        resp = await client.post(f"/studio/workflows/{target['id']}/revisions/1/restore")
        assert resp.status_code == 409
        assert "内置" in resp.json()["detail"]

    async def test_delete_takes_the_history_with_it(self, client, session):
        created = await _import_workflow(client)
        assert (await client.delete(f"/studio/workflows/{created['id']}")).status_code == 200
        left = await studio_revisions.list_revisions(
            session, studio_revisions.ENTITY_WORKFLOW, created["id"]
        )
        assert left == []

    async def test_a_row_built_outside_the_import_path_still_gets_a_baseline(
        self, client, session
    ):
        """RunningHub 目录同步建的行不经过 import_workflow，链是空的。
        第一次编辑必须先把「改之前」补成第 1 版，否则原样就永远回不去了。"""
        row = StudioWorkflow(
            key="runninghub:remote:app:77",
            title="同步来的应用",
            provider="runninghub",
            kind="app",
            source="user",
            payload={"id": "77", "app_id": "77"},
            ui_schema={"fields": []},
            content_hash="sync-hash",
            enabled=True,
            version=1,
        )
        session.add(row)
        await session.commit()

        edited = await client.patch(
            f"/studio/workflows/{row.id}",
            json={"title": "改过名的应用", "ui_schema": {"fields": []}},
        )
        assert edited.status_code == 200, edited.text
        items = (await client.get(f"/studio/workflows/{row.id}/revisions")).json()["items"]
        assert [item["version"] for item in items] == [2, 1]
        assert items[1]["note"] == "首次编辑前的内容"

        restored = await client.post(f"/studio/workflows/{row.id}/revisions/1/restore")
        assert restored.status_code == 200, restored.text
        assert restored.json()["title"] == "同步来的应用"


class TestWorkflowExport:
    async def test_export_import_round_trip_keeps_the_definition(self, client):
        created = await _import_workflow(client)
        resp = await client.post(f"/studio/workflows/{created['id']}/export")
        assert resp.status_code == 200, resp.text
        # 文件名保留中文标题并带版本号：导出几条不同的工作流，落盘后还分得清
        disposition = unquote(resp.headers["content-disposition"])
        assert disposition.startswith("attachment")
        assert "我的放大流-v1.json" in disposition
        bundle = resp.json()
        assert bundle["format"] == studio_workflows.EXPORT_FORMAT
        assert bundle["redacted"] == []
        assert bundle["workflow"]["version"] == 1

        # 同一个导入口原样吃回去：名字留空就沿用导出物里的
        again = await client.post("/studio/workflows", json={"payload": bundle})
        assert again.status_code == 201, again.text
        restored = again.json()
        assert restored["title"] == created["title"]
        assert restored["provider"] == created["provider"]
        assert restored["kind"] == created["kind"]
        assert restored["payload"] == created["payload"]
        assert restored["ui_schema"] == created["ui_schema"]
        assert restored["content_hash"] == created["content_hash"]
        assert restored["id"] != created["id"]

    async def test_bundle_wins_over_a_wrongly_picked_provider(self, client):
        created = await _import_workflow(client, provider="comfyui", kind="video")
        bundle = (await client.post(f"/studio/workflows/{created['id']}/export")).json()
        again = await client.post(
            "/studio/workflows",
            json={"payload": bundle, "provider": "runninghub", "kind": "image"},
        )
        assert again.status_code == 201, again.text
        assert again.json()["provider"] == "comfyui"
        assert again.json()["kind"] == "video"

    async def test_export_strips_local_absolute_paths(self, client):
        created = await _import_workflow(
            client,
            payload={
                "1": {
                    "class_type": "LoadImage",
                    "inputs": {
                        "image": "/Users/your-user/Pictures/私人参考图.png",
                        "mask": "C:\\\\Users\\\\scholar\\\\mask.png",
                        "lora": "refs/style.safetensors",
                    },
                }
            },
            ui_schema={"fields": [{"id": "img", "node": "1", "input": "image", "type": "text"}]},
        )
        bundle = (await client.post(f"/studio/workflows/{created['id']}/export")).json()
        inputs = bundle["workflow"]["payload"]["1"]["inputs"]
        assert inputs["image"] == studio_workflows.REDACTED_PATH
        assert inputs["mask"] == studio_workflows.REDACTED_PATH
        # 相对路径是工作流的正常内容，不该被误伤
        assert inputs["lora"] == "refs/style.safetensors"
        assert "scholar" not in resp_text(bundle)
        assert sorted(bundle["redacted"]) == [
            "payload.1.inputs.image",
            "payload.1.inputs.mask",
        ]

    async def test_export_strips_credentials_even_if_a_row_has_them(self, client, session):
        """导入口会拒收带密钥的定义，但库里可能有手改进去的历史行。
        导出是把东西发给别人的动作，这一层必须自己也守住。"""
        row = StudioWorkflow(
            key="user:legacy-secret",
            title="历史遗留",
            provider="runninghub",
            kind="app",
            source="user",
            payload={"id": "42", "auth": {"api_key": "sk-live-000000secret"}},
            ui_schema=None,
            content_hash="deadbeef",
            enabled=True,
            version=1,
        )
        session.add(row)
        await session.commit()

        bundle = (await client.post(f"/studio/workflows/{row.id}/export")).json()
        text = resp_text(bundle)
        assert "sk-live-000000secret" not in text
        assert "sk-" not in text
        assert bundle["workflow"]["payload"]["auth"]["api_key"] == studio_workflows.REDACTED_SECRET
        assert bundle["redacted"] == ["payload.auth.api_key"]

    def test_bundled_graphs_survive_the_scrub_untouched(self):
        """内置工作流里一条都不该被误伤——路径判据宁可漏也不能把正常内容抹了。"""
        hits: list[tuple[str, list[str]]] = []
        for item in studio_workflows._bundled_definitions():
            _cleaned, found = studio_workflows.scrub_export(
                {"payload": item["payload"], "ui_schema": item["ui_schema"]}
            )
            if found:
                hits.append((item["key"], found))
        assert hits == []

    def test_url_with_a_query_is_not_a_local_path(self):
        """ComfyUI 的 rgthree 比较节点把 `/api/view?filename=…` 存进图里。
        它是 HTTP 路径，抹掉只会弄坏节点的界面状态，也暴露不了本机目录。"""
        cleaned, hits = studio_workflows.scrub_export(
            {"url": "/api/view?filename=preview.png&type=temp"}
        )
        assert hits == []
        assert cleaned["url"] == "/api/view?filename=preview.png&type=temp"

    def test_long_base64_is_not_mistaken_for_a_path(self):
        """JPEG 的 base64 固定以 `/9j/` 开头，误判成路径就把内嵌图切没了。"""
        blob = "/9j/4AAQSkZJRgABAQAA" + "A" * 600
        cleaned, hits = studio_workflows.scrub_export({"image": blob})
        assert cleaned["image"] == blob
        assert hits == []

    def test_path_dropped_in_the_middle_of_a_string_is_scrubbed_too(self):
        """整串不是路径也照抹：命令行片段和节点备注里夹的那条一样带着用户名。"""
        cleaned, hits = studio_workflows.scrub_export(
            {
                "cmd": "--ckpt /Users/your-user/models/flux.safetensors --steps 20",
                "note": "结果存到 D:\\work\\out 再回看",
                "home": "先看 ~/models 里那份",
            }
        )
        assert "scholar" not in cleaned["cmd"]
        assert cleaned["cmd"] == f"--ckpt {studio_workflows.REDACTED_PATH} --steps 20"
        assert cleaned["note"] == f"结果存到 {studio_workflows.REDACTED_PATH} 再回看"
        assert cleaned["home"] == f"先看 {studio_workflows.REDACTED_PATH} 里那份"
        assert sorted(hits) == ["cmd", "home", "note"]

    def test_urls_and_relative_paths_survive_the_embedded_scan(self):
        """嵌入判据只认「某台机器上某个人」的根。域名里的 `p:/`、URL 里的 `/home/`
        和相对路径都不能动——动一个就把节点弄坏，而它们本来也泄不了本机目录。"""
        intact = {
            "a": "https://example.com/home/a.png",
            "b": "见 http://127.0.0.1:8188/api/view?filename=x.png",
            "c": "refs/style.safetensors",
            "d": "models/checkpoints/sd_xl.safetensors 放这里",
        }
        cleaned, hits = studio_workflows.scrub_export(dict(intact))
        assert cleaned == intact
        assert hits == []

    def test_credential_keys_beyond_the_import_gate_are_still_scrubbed(self):
        """导入门禁那份名单只有九个键。导出是往外发，带前缀的写法也要抹掉，
        但 `tokenizer` 这种 ComfyUI 真实输入名不能误伤。"""
        cleaned, hits = studio_workflows.scrub_export(
            {
                "token": "tok-1",
                "api_secret": "sec-2",
                "x_api_key": "sk-3",
                "auth_token": "tok-4",
                "webhook_secret": "sec-5",
                "private_key": "pk-6",
                "tokenizer": "clip-l",
                "token_normalization": "mean",
                "empty_token": "",
            }
        )
        assert "tok-1" not in str(cleaned)
        assert cleaned["token"] == studio_workflows.REDACTED_SECRET
        assert cleaned["api_secret"] == studio_workflows.REDACTED_SECRET
        assert cleaned["x_api_key"] == studio_workflows.REDACTED_SECRET
        assert cleaned["auth_token"] == studio_workflows.REDACTED_SECRET
        assert cleaned["webhook_secret"] == studio_workflows.REDACTED_SECRET
        assert cleaned["private_key"] == studio_workflows.REDACTED_SECRET
        # 空值不算凭据，抹了只会让人以为这里本来有东西
        assert cleaned["empty_token"] == ""
        assert cleaned["tokenizer"] == "clip-l"
        assert cleaned["token_normalization"] == "mean"
        assert "tokenizer" not in hits
        assert "token_normalization" not in hits

    def test_unknown_export_format_version_is_rejected(self):
        with pytest.raises(studio_workflows.StudioWorkflowError) as exc:
            studio_workflows.parse_export(
                {"format": studio_workflows.EXPORT_FORMAT, "format_version": 99, "workflow": {}}
            )
        assert "99" in str(exc.value)

    def test_plain_graph_is_not_treated_as_a_bundle(self):
        assert studio_workflows.parse_export(GRAPH) is None


def resp_text(bundle: dict) -> str:
    import json

    return json.dumps(bundle, ensure_ascii=False)

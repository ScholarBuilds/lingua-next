"""模块 17 v2 共享底座：真实模型目录与统一创作任务。"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from domain.model_catalog import infer_media_types, resolve_model_route, sync_cached_models
from domain.models import (
    CapabilityBinding,
    ImageAsset,
    ImageJob,
    ModelDeployment,
    ProviderCredential,
    StudioTask,
)
from domain.studio_tasks import StudioTaskError, new_task, transition


async def seed_credential(session, *, cache: list | None = None) -> ProviderCredential:
    row = ProviderCredential(
        name="图像中转",
        kind="llm",
        provider_type="openai_compatible",
        config={"api_base": "https://example.invalid/v1"},
        models_cache={"items": cache or []},
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


class TestModelCatalog:
    async def test_provider_types_expose_official_quick_add_recommendations(self, client) -> None:
        response = await client.get("/config/provider-types")
        assert response.status_code == 200
        by_type = {item["provider_type"]: item for item in response.json()}
        assert by_type["openai"]["recommendation"]["badge"] == "官方综合"
        assert by_type["modelscope"]["recommendation"]["category"] == "free"
        assert by_type["runninghub"]["recommendation"]["badge"] == "云端工作流"
        assert by_type["deepseek"]["recommendation"] is None

    async def test_unsaved_credential_probe_does_not_persist_or_audit(
        self, client, session, monkeypatch
    ) -> None:
        received: list[dict] = []

        async def fake_test(config, provider_type):
            received.append({"config": config, "provider_type": provider_type})
            return {
                "ok": True,
                "latency_ms": 8,
                "error_type": None,
                "detail": "可用，上游共 2 个模型",
            }

        monkeypatch.setitem(
            __import__("domain.credentials", fromlist=["PROVIDER_TYPES"]).PROVIDER_TYPES["openai"],
            "test",
            fake_test,
        )
        response = await client.post(
            "/config/credential-probe",
            json={
                "provider_type": "openai",
                "config": {"api_key": "draft-secret", "api_base": "https://draft.invalid"},
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["detail"] == "可用，上游共 2 个模型"
        assert received == [
            {
                "config": {"api_key": "draft-secret", "api_base": "https://draft.invalid"},
                "provider_type": "openai",
            }
        ]
        credentials = (await session.execute(select(ProviderCredential))).scalars().all()
        assert credentials == []

    async def test_credential_probe_merges_existing_secret_without_writing(
        self, client, session, monkeypatch
    ) -> None:
        from domain.credentials import encrypt_config

        credential = ProviderCredential(
            name="existing",
            kind="llm",
            provider_type="openai",
            config=encrypt_config(
                {
                    "api_key": "saved-secret",
                    "api_base": "https://saved.invalid/v1",
                }
            ),
        )
        session.add(credential)
        await session.commit()
        await session.refresh(credential)
        received: list[dict] = []

        async def fake_test(config, provider_type):
            received.append(config)
            return {"ok": True, "latency_ms": 1, "error_type": None, "detail": "ok"}

        monkeypatch.setitem(
            __import__("domain.credentials", fromlist=["PROVIDER_TYPES"]).PROVIDER_TYPES["openai"],
            "test",
            fake_test,
        )
        response = await client.post(
            "/config/credential-probe",
            json={
                "provider_type": "openai",
                "credential_id": credential.id,
                "config": {"api_key": "", "api_base": "https://draft.invalid/v1"},
            },
        )
        assert response.status_code == 200, response.text
        assert received == [
            {
                "api_key": "saved-secret",
                "api_base": "https://draft.invalid/v1",
            }
        ]
        await session.refresh(credential)
        assert credential.status == "untested"
        assert credential.last_tested_at is None

    async def test_resolve_direct_route_keeps_adapter_model_and_credential(self, session) -> None:
        cred = await seed_credential(session)
        deployment = ModelDeployment(
            credential_id=cred.id,
            upstream_model_id="gpt-image-2",
            adapter_type="openai",
            media_types=["image"],
            protocol_options={"image_request_mode": "images"},
        )
        session.add(deployment)
        await session.commit()
        route = await resolve_model_route(session, "image-free", deployment_id=deployment.id)
        assert route is not None
        assert route.adapter_type == "openai"
        assert route.upstream_model_id == "gpt-image-2"
        assert route.credential_config["api_base"] == "https://example.invalid/v1"
        assert route.protocol_options == {"image_request_mode": "images"}

    async def test_refresh_models_also_syncs_real_deployments(
        self, client, session, monkeypatch
    ) -> None:
        cred = await seed_credential(session)

        async def fake_refresh(row):
            row.models_cache = {
                "items": ["gpt-image-2", "gpt-5.5"],
                "refreshed_at": "2026-08-20T00:00:00+00:00",
            }
            return {
                "items": ["gpt-image-2", "gpt-5.5"],
                "count": 2,
                "refreshed_at": "2026-08-20T00:00:00+00:00",
            }

        monkeypatch.setattr("app.routers.config.refresh_models", fake_refresh)
        resp = await client.post(f"/config/credentials/{cred.id}/refresh-models")
        assert resp.status_code == 200, resp.text
        assert resp.json()["deployments"] == {
            "created": 2,
            "updated": 0,
            "skipped": 0,
            "total": 2,
        }
        rows = (await client.get(f"/config/model-deployments?credential_id={cred.id}")).json()
        assert [row["upstream_model_id"] for row in rows] == [
            "gpt-5.5",
            "gpt-image-2",
        ]
        assert {row["upstream_model_id"]: row["media_types"] for row in rows} == {
            "gpt-5.5": ["chat"],
            "gpt-image-2": ["image"],
        }

    def test_model_name_inference_is_conservative_and_adapter_aware(self) -> None:
        assert infer_media_types("gpt-image-2", "openai") == ["image"]
        assert infer_media_types("sora-2", "openai") == ["video"]
        assert infer_media_types("gpt-5.6", "openai") == ["chat"]
        assert infer_media_types("Qwen/Qwen-Image", "modelscope") == ["image"]

    async def test_modelscope_sync_splits_chat_and_image_adapters(self, session) -> None:
        credential = ProviderCredential(
            name="ModelScope",
            kind="llm",
            provider_type="modelscope",
            config={"api_key": "secret"},
            models_cache={"items": ["Qwen/Qwen3.5-35B-A3B", "Tongyi-MAI/Z-Image-Turbo"]},
        )
        session.add(credential)
        await session.commit()
        await session.refresh(credential)

        result = await sync_cached_models(session, credential, adapter_type="modelscope")
        await session.commit()
        assert result == {"created": 2, "updated": 0, "skipped": 0, "total": 2}
        rows = (
            await session.execute(
                select(ModelDeployment).where(ModelDeployment.credential_id == credential.id)
            )
        ).scalars()
        by_model = {row.upstream_model_id: row for row in rows}
        # 对话模型走 OpenAI 兼容直连（魔搭端点本身就是 OpenAI 协议）
        assert by_model["Qwen/Qwen3.5-35B-A3B"].adapter_type == "openai"
        assert by_model["Qwen/Qwen3.5-35B-A3B"].media_types == ["chat"]
        assert by_model["Tongyi-MAI/Z-Image-Turbo"].adapter_type == "modelscope"
        assert by_model["Tongyi-MAI/Z-Image-Turbo"].media_types == ["image"]

    async def test_refresh_gemini_models_uses_native_adapter(
        self, client, session, monkeypatch
    ) -> None:
        cred = ProviderCredential(
            name="Gemini 图片",
            kind="image",
            provider_type="gemini_image",
            config={"api_key": "secret"},
        )
        session.add(cred)
        await session.commit()
        await session.refresh(cred)

        async def fake_refresh(row):
            row.models_cache = {
                "items": [
                    {
                        "id": "gemini-3-pro-image-preview",
                        "display_name": "Gemini 3 Pro Image Preview",
                        "media_types": ["image"],
                    }
                ],
                "refreshed_at": "2026-08-20T00:00:00+00:00",
            }
            return {
                "items": row.models_cache["items"],
                "count": 1,
                "refreshed_at": row.models_cache["refreshed_at"],
            }

        monkeypatch.setattr("app.routers.config.refresh_models", fake_refresh)
        response = await client.post(f"/config/credentials/{cred.id}/refresh-models")
        assert response.status_code == 200, response.text
        rows = (await client.get(f"/config/model-deployments?credential_id={cred.id}")).json()
        assert len(rows) == 1
        assert rows[0]["upstream_model_id"] == "gemini-3-pro-image-preview"
        assert rows[0]["adapter_type"] == "gemini"
        assert rows[0]["media_types"] == ["image"]

    async def test_refresh_seedance_models_uses_volcengine_adapter(
        self, client, session, monkeypatch
    ) -> None:
        cred = ProviderCredential(
            name="方舟视频",
            kind="video",
            provider_type="volcengine_video",
            config={"api_key": "secret"},
        )
        session.add(cred)
        await session.commit()
        await session.refresh(cred)

        async def fake_refresh(row):
            row.models_cache = {
                "items": [
                    {
                        "id": "doubao-seedance-2-0-260128",
                        "media_types": ["video"],
                    }
                ],
                "refreshed_at": "2026-08-20T00:00:00+00:00",
            }
            return {
                "items": row.models_cache["items"],
                "count": 1,
                "refreshed_at": row.models_cache["refreshed_at"],
            }

        monkeypatch.setattr("app.routers.config.refresh_models", fake_refresh)
        response = await client.post(f"/config/credentials/{cred.id}/refresh-models")
        assert response.status_code == 200, response.text
        rows = (await client.get(f"/config/model-deployments?credential_id={cred.id}")).json()
        assert len(rows) == 1
        assert rows[0]["adapter_type"] == "volcengine"
        assert rows[0]["media_types"] == ["video"]

    async def test_manual_model_keeps_exact_upstream_name(self, client, session) -> None:
        cred = await seed_credential(session)
        resp = await client.post(
            "/config/model-deployments",
            json={
                "credential_id": cred.id,
                "upstream_model_id": "gpt-image-2",
                "display_name": "GPT Image 2",
                "adapter_type": "openai",
                "media_types": ["image"],
                "protocol_options": {"image_request_mode": "openai-responses"},
            },
        )
        assert resp.status_code == 201, resp.text
        created = resp.json()
        assert created["upstream_model_id"] == "gpt-image-2"
        assert created["credential_name"] == "图像中转"
        assert created["media_types"] == ["image"]

        listed = (await client.get("/config/model-deployments?media_type=image")).json()
        assert [row["upstream_model_id"] for row in listed] == ["gpt-image-2"]

    async def test_protocol_options_reject_secret_fields(self, client, session) -> None:
        cred = await seed_credential(session)
        resp = await client.post(
            "/config/model-deployments",
            json={
                "credential_id": cred.id,
                "upstream_model_id": "seedance-2.0",
                "adapter_type": "volcengine",
                "media_types": ["video"],
                "protocol_options": {"api_key": "must-not-live-here"},
            },
        )
        assert resp.status_code == 400
        assert "供应商凭据" in resp.json()["detail"]

    async def test_deployment_protocol_and_adapter_are_editable(self, client, session) -> None:
        cred = await seed_credential(session)
        created = await client.post(
            "/config/model-deployments",
            json={
                "credential_id": cred.id,
                "upstream_model_id": "gpt-image-2-all",
                "adapter_type": "openai",
                "media_types": ["image"],
                "protocol_options": {
                    "image_request_mode": "openai-responses",
                    "task_path_template": "/responses/{task_id}",
                },
            },
        )
        assert created.status_code == 201, created.text

        patched = await client.patch(
            f"/config/model-deployments/{created.json()['id']}",
            json={
                "adapter_type": "tudou",
                "media_types": ["image"],
                "protocol_options": None,
            },
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["adapter_type"] == "tudou"
        assert patched.json()["media_types"] == ["image"]
        assert patched.json()["protocol_options"] is None

        rejected = await client.patch(
            f"/config/model-deployments/{created.json()['id']}",
            json={"adapter_type": "volcengine"},
        )
        assert rejected.status_code == 400
        assert "不支持媒体类型" in rejected.json()["detail"]

    async def test_modelscope_lora_catalog_crud_and_filters(self, client, session) -> None:
        credential = ProviderCredential(
            name="ModelScope 出图",
            kind="llm",
            provider_type="modelscope",
            config={"api_key": "secret"},
        )
        session.add(credential)
        await session.commit()
        await session.refresh(credential)

        created = await client.post(
            "/config/modelscope-loras",
            json={
                "credential_id": credential.id,
                "lora_id": "Daniel8152/Klein-enhance",
                "display_name": "Klein 细节增强",
                "target_model": "Qwen/Qwen-Image-Edit-2511",
                "default_strength": 0.85,
                "note": "三参考编辑",
            },
        )
        assert created.status_code == 201, created.text
        row = created.json()
        assert row["lora_id"] == "Daniel8152/Klein-enhance"
        assert row["default_strength"] == 0.85

        duplicate = await client.post(
            "/config/modelscope-loras",
            json={
                "credential_id": credential.id,
                "lora_id": "Daniel8152/Klein-enhance",
                "target_model": "Qwen/Qwen-Image-Edit-2511",
            },
        )
        assert duplicate.status_code == 409

        listed = await client.get(
            "/config/modelscope-loras",
            params={
                "credential_id": credential.id,
                "target_model": "Qwen/Qwen-Image-Edit-2511",
                "enabled": True,
            },
        )
        assert [item["id"] for item in listed.json()] == [row["id"]]

        patched = await client.patch(
            f"/config/modelscope-loras/{row['id']}",
            json={"default_strength": 1.2, "enabled": False, "note": ""},
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["default_strength"] == 1.2
        assert patched.json()["enabled"] is False
        assert patched.json()["note"] is None

        deleted = await client.delete(f"/config/modelscope-loras/{row['id']}")
        assert deleted.status_code == 200
        assert (await client.get("/config/modelscope-loras")).json() == []

    async def test_modelscope_lora_rejects_other_credentials(self, client, session) -> None:
        credential = await seed_credential(session)
        response = await client.post(
            "/config/modelscope-loras",
            json={
                "credential_id": credential.id,
                "lora_id": "org/lora",
                "target_model": "org/model",
            },
        )
        assert response.status_code == 400
        assert "ModelScope" in response.json()["detail"]

    async def test_deployment_rejects_media_not_declared_by_plugin(self, client, session) -> None:
        cred = await seed_credential(session)
        response = await client.post(
            "/config/model-deployments",
            json={
                "credential_id": cred.id,
                "upstream_model_id": "seedance-wrong-route",
                "adapter_type": "volcengine",
                "media_types": ["chat"],
            },
        )
        assert response.status_code == 400
        assert "不支持媒体类型" in response.json()["detail"]

    async def test_sync_cached_models_is_idempotent(self, session) -> None:
        cred = await seed_credential(
            session,
            cache=[
                "gpt-image-2",
                {"id": "gpt-5.5", "label": "GPT 5.5", "type": "chat"},
                {"id": "seedance-2.0", "types": ["video"]},
            ],
        )
        first = await sync_cached_models(session, cred)
        await session.commit()
        second = await sync_cached_models(session, cred)
        await session.commit()
        assert first == {"created": 3, "updated": 0, "skipped": 0, "total": 3}
        assert second == {"created": 0, "updated": 0, "skipped": 0, "total": 3}

    async def test_binding_accepts_deployment_and_dual_writes_legacy_fields(
        self, client, session
    ) -> None:
        cred = await seed_credential(session)
        deployment = ModelDeployment(
            credential_id=cred.id,
            upstream_model_id="gpt-image-2",
            adapter_type="openai",
            media_types=["image"],
        )
        session.add(deployment)
        await session.commit()
        await session.refresh(deployment)

        resp = await client.put(
            "/config/bindings/image-free",
            json={"deployment_id": deployment.id},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["deployment_id"] == deployment.id
        assert body["credential_id"] == cred.id
        assert body["target"] == "gpt-image-2"

    async def test_legacy_binding_automatically_links_model_deployment(
        self, client, session
    ) -> None:
        cred = await seed_credential(session)

        resp = await client.put(
            "/config/bindings/image-free",
            json={"credential_id": cred.id, "target": "gpt-image-2"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["deployment_id"] is not None
        deployment = await session.get(ModelDeployment, body["deployment_id"])
        assert deployment is not None
        assert deployment.upstream_model_id == "gpt-image-2"
        assert deployment.media_types == ["image"]
        assert deployment.discovered is False
        # openai_compatible 凭据推断为直连部署
        assert deployment.adapter_type == "openai"
        assert "gateway_sync" not in body


class TestStudioTasks:
    async def test_batch_generation_registers_each_persistent_task(
        self, client, session, monkeypatch
    ) -> None:
        class FakeQueue:
            def __init__(self) -> None:
                self.enqueued: list[tuple] = []

            async def enqueue_job(self, *args) -> None:
                self.enqueued.append(args)

        queue = FakeQueue()

        async def fake_queue():
            return queue

        monkeypatch.setattr("app.routers.images.get_queue", fake_queue)
        resp = await client.post(
            "/images/batch",
            json={
                "app_key": "text_to_image",
                "tasks": [
                    {
                        "label": "角色正面",
                        "prompt_zh": "同一角色的正面设定图",
                        "ratio": "1:1",
                        "tier": "1k",
                        "n": 1,
                    }
                ],
                "alias": "image-free",
            },
        )
        assert resp.status_code == 202, resp.text
        body = resp.json()
        assert body["batch_id"]
        task_id = body["jobs"][0]["studio_task_id"]
        task = await session.get(StudioTask, task_id)
        assert task is not None
        assert task.batch_id == body["batch_id"]
        assert task.source_context == {"app_key": "text_to_image", "batch_index": 0}
        assert queue.enqueued[0][0] == "generate_image"

    async def test_task_state_machine_and_list_api(self, client, session) -> None:
        task = new_task(
            tool_id="infinite-canvas",
            task_type="image.generate",
            source_route="/studio/canvas/8",
            source_context={
                "canvas_id": 8,
                "node_id": "node-3",
                "source_node_id": "modelscope-1",
            },
            capability="image-free",
            invocation={"prompt": "测试"},
        )
        transition(task, "running", stage="submit", progress=12.5)
        direct_task = new_task(
            tool_id="infinite-canvas",
            task_type="video.generate",
            source_route="/studio/canvas/8",
            source_context={"canvas_id": 8, "node_id": "modelscope-1"},
            capability="video-generate",
            invocation={"prompt": "直接落回源节点"},
        )
        session.add_all([task, direct_task])
        await session.commit()

        resp = await client.get("/studio/tasks?status=running&tool_id=infinite-canvas")
        assert resp.status_code == 200
        item = resp.json()["items"][0]
        assert item["id"] == task.id
        assert item["source_context"]["node_id"] == "node-3"
        assert item["progress"] == 12.5
        assert item["started_at"] is not None

        by_source = await client.get(
            "/studio/tasks?canvas_id=8&source_node_id=modelscope-1"
        )
        assert by_source.status_code == 200
        assert [item["id"] for item in by_source.json()["items"]] == [task.id]

        other_source = await client.get(
            "/studio/tasks?canvas_id=8&source_node_id=modelscope-2"
        )
        assert other_source.status_code == 200
        assert other_source.json()["items"] == []

        by_origin = await client.get(
            "/studio/tasks?canvas_id=8&origin_node_id=modelscope-1"
        )
        assert by_origin.status_code == 200
        assert {item["id"] for item in by_origin.json()["items"]} == {
            task.id,
            direct_task.id,
        }

        bad = await client.get("/studio/tasks?status=made-up")
        assert bad.status_code == 400

    async def test_task_transition_appends_cursor_event_and_canvas_projection(
        self, client, session
    ) -> None:
        task = new_task(
            tool_id="infinite-canvas",
            task_type="image.generate",
            source_context={
                "canvas_id": 18,
                "node_id": "pending-node-2",
                "execution_group_id": "group-1",
            },
        )
        session.add(task)
        await session.flush()
        transition(task, "running", stage="provider", progress=23)
        transition(task, "running", stage="provider", progress=48)
        await session.commit()

        response = await client.get(f"/studio/tasks/{task.id}/events")
        assert response.status_code == 200
        events = response.json()["items"]
        assert [item["seq"] for item in events] == [1, 2, 3]
        assert [item["event_type"] for item in events] == [
            "task.queued",
            "task.running",
            "task.progress",
        ]
        assert events[-1]["canvas_id"] == 18
        assert events[-1]["node_id"] == "pending-node-2"

        listed = await client.get("/studio/tasks?canvas_id=18&node_id=pending-node-2")
        item = listed.json()["items"][0]
        assert item["id"] == task.id
        assert item["execution_group_id"] == "group-1"
        assert item["event_seq"] == 3

    def test_terminal_task_cannot_transition_back_to_running(self) -> None:
        task = new_task(tool_id="infinite-canvas", task_type="image.generate")
        transition(task, "running")
        transition(task, "succeeded")
        with pytest.raises(StudioTaskError, match="非法任务状态迁移"):
            transition(task, "running")

    async def test_succeeded_image_task_rerun_creates_fresh_job_from_snapshot(
        self, client, session, monkeypatch
    ) -> None:
        original = new_task(
            tool_id="infinite-canvas",
            task_type="image.generate",
            source_route="/studio/canvas/9",
            source_context={"canvas_id": 9, "node_id": "out-1"},
            capability="image-free",
            invocation={},
        )
        session.add(original)
        await session.flush([original])
        old_job = ImageJob(
            target_key="free",
            idea="同一角色",
            style_key="none",
            size="1024x1024",
            quality="high",
            n=1,
            alias="image-free",
            prompt_override="同一角色的正面设定图",
            options={"tier": "1k", "ref_asset_ids": [3]},
            status="done",
            studio_task_id=original.id,
        )
        session.add(old_job)
        await session.flush([old_job])
        original.invocation = {
            "image_job_id": old_job.id,
            "prompt_override": old_job.prompt_override,
            "_tool_runtime": {"operation": "image.generate"},
        }
        transition(original, "running")
        transition(original, "succeeded", result={"asset_ids": [11]})
        await session.commit()

        enqueued: list[tuple] = []

        class Queue:
            async def enqueue_job(self, *args, **kwargs):
                enqueued.append((args, kwargs))

        async def fake_queue():
            return Queue()

        monkeypatch.setattr("app.routers.studio_tasks.get_queue", fake_queue)
        response = await client.post(f"/studio/tasks/{original.id}/rerun")
        assert response.status_code == 202, response.text
        body = response.json()
        assert body["parent_task_id"] == original.id
        assert body["provider_task_id"] is None
        assert body["invocation"]["image_job_id"] != old_job.id
        fresh_job = await session.get(ImageJob, body["invocation"]["image_job_id"])
        assert fresh_job is not None
        assert fresh_job.prompt_override == old_job.prompt_override
        assert fresh_job.options == old_job.options
        assert fresh_job.status == "pending"
        assert enqueued == [(("generate_image", fresh_job.id, None, None, "downstream"), {})]

    async def test_cleanup_rejects_active_tasks_and_keeps_generated_records(
        self, client, session
    ) -> None:
        terminal = new_task(tool_id="infinite-canvas", task_type="workflow.comfyui")
        transition(terminal, "running")
        transition(terminal, "failed", error="失败", retryable=True)
        active = new_task(tool_id="infinite-canvas", task_type="workflow.comfyui")
        session.add_all([terminal, active])
        await session.commit()

        mixed = await client.post(
            "/studio/tasks/cleanup",
            json={"task_ids": [terminal.id, active.id]},
        )
        assert mixed.status_code == 409
        assert await session.get(StudioTask, terminal.id) is not None
        assert await session.get(StudioTask, active.id) is not None

        cleaned = await client.post(
            "/studio/tasks/cleanup",
            json={"task_ids": [terminal.id]},
        )
        assert cleaned.status_code == 200, cleaned.text
        assert cleaned.json() == {"deleted": 1, "missing": []}
        assert (await client.get(f"/studio/tasks/{terminal.id}")).status_code == 404
        assert (await client.get(f"/studio/tasks/{active.id}")).status_code == 200

    async def test_image_job_is_registered_before_queueing(
        self, client, session, monkeypatch
    ) -> None:
        class FakeQueue:
            def __init__(self) -> None:
                self.enqueued: list[tuple] = []

            async def set(self, *args, **kwargs) -> None:
                return None

            async def enqueue_job(self, *args) -> None:
                self.enqueued.append(args)

        queue = FakeQueue()
        cred = await seed_credential(session)
        deployment = ModelDeployment(
            credential_id=cred.id,
            upstream_model_id="gpt-image-2",
            adapter_type="openai",
            media_types=["image"],
        )
        session.add(deployment)
        await session.flush()
        session.add(
            CapabilityBinding(
                capability="image-free",
                credential_id=cred.id,
                deployment_id=deployment.id,
                target=deployment.upstream_model_id,
            )
        )
        await session.commit()

        async def fake_queue():
            return queue

        monkeypatch.setattr("app.routers.images.get_queue", fake_queue)
        resp = await client.post(
            "/images/jobs",
            json={
                "target_key": "free",
                "prompt_override": "一只白猫",
                "quality": "high",
                "alias": "image-free",
                "tool_id": "infinite-canvas",
                "source_route": "/studio/canvas/9",
                "source_context": {"canvas_id": 9, "node_id": "n1"},
            },
        )
        assert resp.status_code == 202, resp.text
        created = resp.json()
        assert created["studio_task_id"]
        task = await session.get(StudioTask, created["studio_task_id"])
        assert task is not None
        assert task.status == "queued"
        assert task.deployment_id == deployment.id
        assert task.invocation["quality"] == "high"
        assert task.source_context == {"canvas_id": 9, "node_id": "n1"}
        assert queue.enqueued[0][0] == "generate_image"

    async def test_canvas_image_job_can_override_global_model_per_node(
        self, client, session, monkeypatch
    ) -> None:
        class FakeQueue:
            async def set(self, *args, **kwargs) -> None:
                return None

            async def enqueue_job(self, *args) -> None:
                return None

        cred = await seed_credential(session)
        global_model = ModelDeployment(
            credential_id=cred.id,
            upstream_model_id="gpt-image-global",
            adapter_type="openai",
            media_types=["image"],
        )
        node_model = ModelDeployment(
            credential_id=cred.id,
            upstream_model_id="gpt-image-character",
            adapter_type="openai",
            media_types=["image"],
        )
        session.add_all([global_model, node_model])
        await session.flush()
        session.add(
            CapabilityBinding(
                capability="image-free",
                credential_id=cred.id,
                deployment_id=global_model.id,
                target=global_model.upstream_model_id,
            )
        )
        await session.commit()

        async def fake_queue():
            return FakeQueue()

        monkeypatch.setattr("app.routers.images.get_queue", fake_queue)
        response = await client.post(
            "/images/jobs",
            json={
                "target_key": "free",
                "prompt_override": "保持同一个角色",
                "alias": "image-free",
                "deployment_id": node_model.id,
                "tool_id": "infinite-canvas",
                "source_context": {"canvas_id": 9, "node_id": "character"},
            },
        )
        assert response.status_code == 202, response.text
        task = await session.get(StudioTask, response.json()["studio_task_id"])
        assert task is not None
        assert task.deployment_id == node_model.id
        assert task.deployment_id != global_model.id

    async def test_modelscope_job_persists_native_options_and_reference_assets(
        self, client, session, monkeypatch
    ) -> None:
        class FakeQueue:
            async def set(self, *args, **kwargs) -> None:
                return None

            async def enqueue_job(self, *args) -> None:
                return None

        credential = ProviderCredential(
            name="ModelScope",
            kind="llm",
            provider_type="modelscope",
            config={"api_key": "ms-secret"},
        )
        session.add(credential)
        await session.flush()
        deployment = ModelDeployment(
            credential_id=credential.id,
            upstream_model_id="Tongyi-MAI/Z-Image-Turbo",
            adapter_type="modelscope",
            media_types=["image"],
        )
        reference = ImageAsset(
            sha256="1" * 64,
            storage_key="images/ref.png",
            mime="image/png",
            target_key="free",
            prompt="reference",
        )
        session.add_all([deployment, reference])
        await session.commit()

        async def fake_queue():
            return FakeQueue()

        monkeypatch.setattr("app.routers.images.get_queue", fake_queue)
        response = await client.post(
            "/images/jobs",
            json={
                "target_key": "free",
                "prompt_override": "ink cat",
                "alias": "image-free",
                "deployment_id": deployment.id,
                "negative_prompt": "text, watermark",
                "seed": 17,
                "steps": 24,
                "guidance": 4.5,
                "loras": {"org/ink-style": 0.7},
                "ref_asset_ids": [reference.id],
            },
        )
        assert response.status_code == 202, response.text
        created = response.json()
        job = await session.get(ImageJob, created["image_job_id"])
        task = await session.get(StudioTask, created["studio_task_id"])
        expected = {
            "tier": "1k",
            "negative_prompt": "text, watermark",
            "seed": 17,
            "steps": 24,
            "guidance": 4.5,
            "loras": {"org/ink-style": 0.7},
            "ref_asset_ids": [reference.id],
        }
        assert job is not None and job.options == expected
        assert task is not None
        assert task.deployment_id == deployment.id
        assert task.invocation["options"] == {
            key: value for key, value in expected.items() if key != "tier"
        }

        missing = await client.post(
            "/images/jobs",
            json={
                "target_key": "free",
                "prompt_override": "ink cat",
                "alias": "image-free",
                "deployment_id": deployment.id,
                "ref_asset_ids": [999_999],
            },
        )
        assert missing.status_code == 404
        assert missing.json()["detail"] == "参考资产不存在：999999"

    async def test_canvas_image_job_rejects_non_image_deployment(self, client, session) -> None:
        cred = await seed_credential(session)
        video_model = ModelDeployment(
            credential_id=cred.id,
            upstream_model_id="seedance-video",
            adapter_type="volcengine",
            media_types=["video"],
        )
        session.add(video_model)
        await session.commit()

        response = await client.post(
            "/images/jobs",
            json={
                "target_key": "free",
                "prompt_override": "错误模型",
                "alias": "image-free",
                "deployment_id": video_model.id,
            },
        )
        assert response.status_code == 400
        assert "图片能力" in response.json()["detail"]

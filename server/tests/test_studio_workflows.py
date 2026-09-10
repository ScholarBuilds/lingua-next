"""模块 17 ST-15：工作流目录与 Infinite-Canvas 内置资产。"""

from domain import workflow_execution
from domain.models import (
    ImageAsset,
    ModelDeployment,
    ProviderCredential,
    StudioMediaAsset,
    StudioTask,
    StudioWorkflow,
)
from domain.studio_tasks import new_task, transition


async def test_bundled_infinite_canvas_workflows_are_seeded(client) -> None:
    resp = await client.get("/studio/workflows")
    assert resp.status_code == 200, resp.text
    items = resp.json()["items"]

    assert len(items) == 15
    assert {item["provider"] for item in items} == {"comfyui", "runninghub"}
    assert any(item["title"] == "LTX Director v2" for item in items)
    assert any(item["title"] == "SeedVR2 高清放大" for item in items)
    assert sum(item["has_thumbnail"] for item in items) == 6


async def test_workflow_detail_keeps_graph_and_ui_schema(client) -> None:
    items = (await client.get("/studio/workflows?provider=comfyui")).json()["items"]
    workflow = next(item for item in items if item["title"] == "MiniMax H3")

    resp = await client.get(f"/studio/workflows/{workflow['id']}")
    assert resp.status_code == 200, resp.text
    detail = resp.json()
    assert detail["node_count"] > 0
    assert detail["field_count"] == 7
    assert detail["payload"]
    assert detail["ui_schema"]["title"] == "MiniMax H3"
    assert detail["ui_schema"]["fields"][0]["id"] == "f_reference_image"
    assert detail["ui_schema"]["fields"][1] == {
        "id": "f_minimax_references",
        "node": "136",
        "input": "",
        "name": "MiniMax 多模态参考",
        "type": "minimax_refs",
        "default": [],
        "required": False,
        "hidden": True,
        "max_images": 9,
        "max_videos": 3,
        "max_audios": 3,
        "bind_prompt": None,
    }


async def test_zimage_workflow_exposes_prompt_dimensions_and_random_seed(client) -> None:
    items = (await client.get("/studio/workflows?provider=comfyui")).json()["items"]
    workflow = next(item for item in items if item["key"] == "comfyui:Z-Image")

    detail = (await client.get(f"/studio/workflows/{workflow['id']}")).json()
    assert detail["field_count"] == 4
    fields = {item["id"]: item for item in detail["ui_schema"]["fields"]}
    assert fields["f_prompt"]["node"] == "23"
    assert fields["f_prompt"]["bind_prompt"] is True
    assert fields["f_width"]["default"] == 1024
    assert fields["f_height"]["default"] == 1024
    assert fields["f_seed"]["random_enabled"] is True
    assert fields["f_seed"]["hidden"] is True
    rendered = workflow_execution.apply_comfy_fields(
        detail["payload"],
        detail["ui_schema"],
        {"f_prompt": "paper fox", "f_width": 1024, "f_height": 768, "f_seed": 9},
    )
    assert rendered["23"]["inputs"]["text"] == "paper fox"
    assert rendered["144"]["inputs"]["width"] == 1024
    assert rendered["144"]["inputs"]["height"] == 768
    assert rendered["22"]["inputs"]["seed"] == 9


async def test_enhance_and_klein_workflows_expose_source_page_fields(client) -> None:
    items = (await client.get("/studio/workflows?provider=comfyui")).json()["items"]
    by_key = {item["key"]: item for item in items}

    enhance = (
        await client.get(f"/studio/workflows/{by_key['comfyui:Z-Image-Enhance']['id']}")
    ).json()
    rendered = workflow_execution.apply_comfy_fields(
        enhance["payload"],
        enhance["ui_schema"],
        {"f_image": "input.png", "f_strength": 0.73},
    )
    assert enhance["field_count"] == 2
    assert rendered["15"]["inputs"]["image"] == "input.png"
    assert rendered["204"]["inputs"]["value"] == 0.73

    upscale = (
        await client.get(f"/studio/workflows/{by_key['comfyui:upscale']['id']}")
    ).json()
    rendered = workflow_execution.apply_comfy_fields(
        upscale["payload"],
        upscale["ui_schema"],
        {"f_image": "enhanced.png", "f_seed": 17, "f_resolution": 4096},
    )
    assert upscale["field_count"] == 3
    assert rendered["15"]["inputs"]["image"] == "enhanced.png"
    assert rendered["172"]["inputs"]["seed"] == 17
    assert rendered["172"]["inputs"]["resolution"] == 4096

    klein = (
        await client.get(f"/studio/workflows/{by_key['comfyui:Flux2-Klein']['id']}")
    ).json()
    values = {
        "f_prompt": "move the subject into moonlight",
        "f_seed": 42,
        "f_main": "main.png",
        "f_aux_a": "light.png",
        "f_aux_b": "",
        "f_has_aux_a": True,
        "f_has_aux_b": False,
    }
    rendered = workflow_execution.apply_comfy_fields(
        klein["payload"], klein["ui_schema"], values
    )
    assert klein["field_count"] == 7
    assert rendered["168"]["inputs"]["text"] == values["f_prompt"]
    assert rendered["158"]["inputs"]["noise_seed"] == 42
    assert rendered["278"]["inputs"]["image"] == "main.png"
    assert rendered["270"]["inputs"]["image"] == "light.png"
    assert rendered["292"]["inputs"]["image"] == ""
    assert rendered["313"]["inputs"]["value"] is True
    assert rendered["314"]["inputs"]["value"] is False

    angle = (
        await client.get(f"/studio/workflows/{by_key['comfyui:2511']['id']}")
    ).json()
    rendered = workflow_execution.apply_comfy_fields(
        angle["payload"],
        angle["ui_schema"],
        {"f_image": "subject.png", "f_prompt": "将相机俯视20度", "f_seed": 91},
    )
    assert angle["field_count"] == 3
    assert rendered["31"]["inputs"]["image"] == "subject.png"
    assert rendered["11"]["inputs"]["prompt"] == "将相机俯视20度"
    assert rendered["14"]["inputs"]["seed"] == 91


async def test_user_can_import_toggle_and_delete_workflow(client, session) -> None:
    resp = await client.post(
        "/studio/workflows",
        json={
            "title": "我的放大工作流",
            "provider": "comfyui",
            "kind": "upscale",
            "payload": {"1": {"class_type": "KSampler", "inputs": {"seed": 0}}},
            "ui_schema": {
                "fields": [{"id": "seed", "node": "1", "input": "seed", "type": "number"}]
            },
        },
    )
    assert resp.status_code == 201, resp.text
    created = resp.json()
    assert created["source"] == "user"
    assert created["node_count"] == 1
    assert created["field_count"] == 1

    patched = await client.patch(f"/studio/workflows/{created['id']}", json={"enabled": False})
    assert patched.status_code == 200, patched.text
    assert patched.json()["enabled"] is False

    edited = await client.patch(
        f"/studio/workflows/{created['id']}",
        json={
            "title": "我的高清放大",
            "ui_schema": {
                "fields": [{
                    "id": "steps",
                    "node": "1",
                    "input": "seed",
                    "name": "随机种子",
                    "type": "number",
                    "default": 20,
                }]
            },
        },
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["title"] == "我的高清放大"
    assert edited.json()["ui_schema"]["fields"][0]["name"] == "随机种子"

    deleted = await client.delete(f"/studio/workflows/{created['id']}")
    assert deleted.status_code == 200, deleted.text
    assert await session.get(StudioWorkflow, created["id"]) is None


async def test_workflow_import_rejects_embedded_secret(client) -> None:
    resp = await client.post(
        "/studio/workflows",
        json={
            "title": "错误工作流",
            "provider": "runninghub",
            "payload": {"id": "123", "api_key": "must-not-be-stored"},
        },
    )
    assert resp.status_code == 400
    assert "供应商凭据" in resp.json()["detail"]


async def test_bundled_workflow_cannot_be_deleted(client) -> None:
    workflow = (await client.get("/studio/workflows")).json()["items"][0]
    resp = await client.delete(f"/studio/workflows/{workflow['id']}")
    assert resp.status_code == 409
    assert "停用" in resp.json()["detail"]

    edited = await client.patch(
        f"/studio/workflows/{workflow['id']}",
        json={"title": "不能覆盖", "ui_schema": {"fields": []}},
    )
    assert edited.status_code == 409
    assert "内置工作流" in edited.json()["detail"]


async def test_comfy_import_rejects_non_api_graph_and_broken_field_mapping(client) -> None:
    invalid_graph = await client.post(
        "/studio/workflows",
        json={
            "title": "普通 JSON",
            "provider": "comfyui",
            "payload": {"name": "not a node graph"},
        },
    )
    assert invalid_graph.status_code == 400
    assert "class_type" in invalid_graph.json()["detail"]

    broken_mapping = await client.post(
        "/studio/workflows",
        json={
            "title": "错误映射",
            "provider": "comfyui",
            "payload": {"1": {"class_type": "KSampler", "inputs": {"seed": 1}}},
            "ui_schema": {
                "fields": [{
                    "id": "bad",
                    "node": "1",
                    "input": "missing",
                    "type": "number",
                }]
            },
        },
    )
    assert broken_mapping.status_code == 400
    assert "不存在的输入" in broken_mapping.json()["detail"]


async def test_workflow_run_registers_persistent_task_before_enqueue(
    client, session, monkeypatch
) -> None:
    workflow = (await client.get("/studio/workflows?provider=comfyui")).json()["items"][0]
    credential = ProviderCredential(
        name="本机 ComfyUI",
        kind="workflow",
        provider_type="comfyui",
        config={"api_base": "http://127.0.0.1:8188"},
    )
    session.add(credential)
    await session.commit()
    await session.refresh(credential)
    enqueued: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            enqueued.append((args, kwargs))

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.studio.get_queue", fake_queue)
    response = await client.post(
        f"/studio/workflows/{workflow['id']}/runs",
        json={
            "credential_id": credential.id,
            "fields": {},
            "source_context": {"canvas_id": 12, "node_id": "wf-node"},
        },
    )
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["status"] == "queued"
    assert body["tool_id"] == "infinite-canvas"
    assert body["source_context"] == {
        "workflow_id": workflow["id"],
        "canvas_id": 12,
        "node_id": "wf-node",
    }
    assert enqueued == [(("run_studio_workflow", body["id"]), {})]
    stored = await session.get(StudioTask, body["id"])
    assert stored is not None
    assert stored.invocation["credential_id"] == credential.id


async def test_runninghub_app_run_freezes_instance_and_wallet_selection(
    client, session, monkeypatch
) -> None:
    workflows = (await client.get("/studio/workflows?provider=runninghub")).json()["items"]
    workflow = next(item for item in workflows if item["kind"] == "app")
    credential = ProviderCredential(
        name="RunningHub",
        kind="workflow",
        provider_type="runninghub",
        config={
            "api_base": "https://www.runninghub.ai",
            "api_key": "credit-key",
            "wallet_api_key": "wallet-key",
        },
    )
    session.add(credential)
    await session.commit()
    await session.refresh(credential)

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            return None

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.studio.get_queue", fake_queue)
    response = await client.post(
        f"/studio/workflows/{workflow['id']}/runs",
        json={
            "credential_id": credential.id,
            "fields": {},
            "use_wallet": True,
            "instance_type": "plus",
        },
    )

    assert response.status_code == 202, response.text
    stored = await session.get(StudioTask, response.json()["id"])
    assert stored is not None
    assert stored.invocation["use_wallet"] is True
    assert stored.invocation["instance_type"] == "plus"


async def test_shared_tool_run_starts_canvas_image_task_from_manifest(
    client, session, monkeypatch
) -> None:
    enqueued: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            enqueued.append((args, kwargs))

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.studio.get_queue", fake_queue)
    response = await client.post(
        "/studio/tools/infinite-canvas/runs",
        json={
            "operation": "image.generate",
            "input": {"prompt": "A paper boat on a moonlit lake", "n": 2},
            "source_route": "/studio/canvas?canvas=7",
            "source_context": {"canvas_id": 7, "node_id": "node-image"},
        },
    )
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["tool_id"] == "infinite-canvas"
    assert body["task_type"] == "image.generate"
    assert body["canvas_id"] == 7
    assert body["node_id"] == "node-image"
    assert body["invocation"]["prompt_override"] == "A paper boat on a moonlit lake"
    assert body["invocation"]["_tool_runtime"]["operation"] == "image.generate"
    assert enqueued == [(("generate_image", body["image_job_id"], None, None, "downstream"), {})]


async def test_online_image_tool_routes_generate_and_reference_edit(
    client, session, monkeypatch
) -> None:
    credential = ProviderCredential(
        name="OpenAI Images",
        kind="image",
        provider_type="openai_image",
        config={"api_key": "encrypted-in-production"},
    )
    session.add(credential)
    await session.flush()
    deployment = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id="gpt-image-2",
        adapter_type="openai",
        media_types=["image"],
    )
    source = ImageAsset(
        sha256="a" * 64,
        storage_key="images/test/online-source.png",
        mime="image/png",
        width=1024,
        height=1024,
        bytes=12,
        target_key="free",
        prompt="source",
        source="workbench",
    )
    session.add_all([deployment, source])
    await session.commit()
    await session.refresh(deployment)
    await session.refresh(source)
    enqueued: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            enqueued.append((args, kwargs))

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.studio.get_queue", fake_queue)
    generate = await client.post(
        "/studio/tools/online-image/runs",
        json={
            "operation": "image.generate",
            "input": {
                "prompt": "glass garden",
                "deployment_id": deployment.id,
                "size": "1024x1024",
                "quality": "high",
                "n": 2,
            },
            "source_route": "/studio/online",
            "source_context": {"provider_name": "OpenAI", "model": "gpt-image-2"},
        },
    )
    assert generate.status_code == 202, generate.text
    generated = generate.json()
    assert generated["tool_id"] == "online-image"
    assert generated["deployment_id"] == deployment.id
    assert generated["invocation"]["size"] == "1024x1024"

    edit = await client.post(
        "/studio/tools/online-image/runs",
        json={
            "operation": "image.edit",
            "input": {
                "prompt": "turn it into paper",
                "ref_asset_ids": [source.id],
                "deployment_id": deployment.id,
                "size": "1024x1024",
                "quality": "medium",
                "n": 1,
            },
            "source_route": "/studio/online",
            "source_context": {"reference_asset_ids": [source.id]},
        },
    )
    assert edit.status_code == 202, edit.text
    edited = edit.json()
    assert edited["tool_id"] == "online-image"
    assert edited["invocation"]["ref_asset_ids"] == [source.id]
    assert enqueued == [
        (("generate_image", generated["image_job_id"], None, None, "downstream"), {}),
        (("edit_image_task", edited["id"]), {}),
    ]


async def test_online_image_tool_can_start_runninghub_image_workflow(
    client, session, monkeypatch
) -> None:
    workflows = (await client.get("/studio/workflows?provider=runninghub")).json()["items"]
    workflow = next(item for item in workflows if item["title"] == "GPT-Image-2-图片编辑")
    detail = (await client.get(f"/studio/workflows/{workflow['id']}")).json()
    prompt_field = next(
        item
        for item in detail["ui_schema"]["fields"]
        if item.get("fieldName") == "prompt"
    )
    credential = ProviderCredential(
        name="RunningHub Images",
        kind="workflow",
        provider_type="runninghub",
        config={"api_base": "https://www.runninghub.ai", "api_key": "test-key"},
    )
    session.add(credential)
    await session.commit()
    await session.refresh(credential)
    enqueued: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            enqueued.append((args, kwargs))

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.studio.get_queue", fake_queue)
    response = await client.post(
        "/studio/tools/online-image/runs",
        json={
            "operation": "workflow.run",
            "input": {
                "workflow_id": workflow["id"],
                "credential_id": credential.id,
                "fields": {prompt_field["id"]: "glass garden"},
            },
            "source_route": "/studio/online",
            "source_context": {
                "provider_name": "RunningHub",
                "model": workflow["title"],
            },
        },
    )

    assert response.status_code == 202, response.text
    body = response.json()
    assert body["tool_id"] == "online-image"
    assert body["task_type"] == "workflow.runninghub"
    assert body["invocation"]["fields"] == {prompt_field["id"]: "glass garden"}
    assert enqueued == [(("run_studio_workflow", body["id"]), {})]


async def test_canvas_can_queue_jimeng_native_upscale(client, session, monkeypatch) -> None:
    credential = ProviderCredential(
        name="Dreamina CLI",
        kind="image",
        provider_type="jimeng_cli",
        config={"executable": "/tmp/dreamina"},
    )
    session.add(credential)
    await session.flush()
    deployment = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id="5.0",
        adapter_type="jimeng",
        media_types=["image"],
    )
    source = ImageAsset(
        sha256="f" * 64,
        storage_key="images/test/upscale-source.png",
        mime="image/png",
        width=64,
        height=64,
        bytes=10,
        target_key="free",
        prompt="source",
        source="workbench",
    )
    session.add_all([deployment, source])
    await session.commit()
    calls: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            calls.append((args, kwargs))

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.studio.get_queue", fake_queue)
    response = await client.post(
        "/studio/tools/infinite-canvas/runs",
        json={
            "operation": "image.upscale",
            "input": {
                "deployment_id": deployment.id,
                "asset_id": source.id,
                "resolution_type": "4k",
            },
            "source_context": {"canvas_id": 9, "node_id": "upscaled-node"},
        },
    )
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["task_type"] == "image.upscale"
    assert body["invocation"]["resolution_type"] == "4k"
    assert calls == [(("upscale_image_task", body["id"]), {})]


async def test_shared_tool_run_rejects_capability_not_owned_by_tool(client, monkeypatch) -> None:
    called = False

    async def fake_queue():
        nonlocal called
        called = True
        raise AssertionError("不应触发队列")

    monkeypatch.setattr("app.routers.studio.get_queue", fake_queue)
    response = await client.post(
        "/studio/tools/grid-tool/runs",
        json={
            "operation": "image.generate",
            "input": {"prompt": "should fail before enqueue"},
        },
    )
    assert response.status_code == 400
    assert "不支持能力" in response.json()["detail"]
    assert called is False


async def test_zimage_tool_can_start_bundled_workflow(client, session, monkeypatch) -> None:
    workflows = (await client.get("/studio/workflows?provider=comfyui")).json()["items"]
    workflow = next(item for item in workflows if item["key"] == "comfyui:Z-Image")
    credential = ProviderCredential(
        name="本机 ComfyUI",
        kind="workflow",
        provider_type="comfyui",
        config={"api_base": "http://127.0.0.1:8188"},
    )
    session.add(credential)
    await session.commit()
    await session.refresh(credential)
    enqueued: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            enqueued.append((args, kwargs))

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.studio.get_queue", fake_queue)
    response = await client.post(
        "/studio/tools/zimage-generator/runs",
        json={
            "operation": "workflow.run",
            "input": {
                "workflow_id": workflow["id"],
                "credential_id": credential.id,
                "fields": {
                    "f_prompt": "paper fox",
                    "f_width": 1024,
                    "f_height": 1024,
                    "f_seed": 9,
                },
            },
            "source_route": "/studio/zimage",
            "source_context": {"zimage_engine": "local", "prompt": "paper fox"},
        },
    )

    assert response.status_code == 202, response.text
    body = response.json()
    assert body["tool_id"] == "zimage-generator"
    assert body["task_type"] == "workflow.comfyui"
    assert body["source_route"] == "/studio/zimage"
    assert body["source_context"]["zimage_engine"] == "local"
    assert enqueued == [(("run_studio_workflow", body["id"]), {})]


async def test_klein_and_enhance_tools_can_start_bundled_workflows(
    client, session, monkeypatch
) -> None:
    workflows = (await client.get("/studio/workflows?provider=comfyui")).json()["items"]
    by_key = {item["key"]: item for item in workflows}
    credential = ProviderCredential(
        name="本机 ComfyUI",
        kind="workflow",
        provider_type="comfyui",
        config={"api_base": "http://127.0.0.1:8188"},
    )
    session.add(credential)
    await session.commit()
    await session.refresh(credential)
    enqueued: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            enqueued.append((args, kwargs))

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.studio.get_queue", fake_queue)
    cases = (
        (
            "klein-editor",
            "comfyui:Flux2-Klein",
            "/studio/klein",
            {
                "f_prompt": "moonlight",
                "f_seed": 7,
                "f_main": "asset:1",
                "f_aux_a": "",
                "f_aux_b": "",
                "f_has_aux_a": False,
                "f_has_aux_b": False,
            },
            {"klein_engine": "local", "reference_asset_ids": [1]},
        ),
        (
            "enhance",
            "comfyui:Z-Image-Enhance",
            "/studio/enhance",
            {"f_image": "asset:1", "f_strength": 0.5},
            {"enhance_engine": "local", "source_asset_id": 1},
        ),
        (
            "angle-control",
            "comfyui:2511",
            "/studio/angle",
            {"f_image": "asset:1", "f_prompt": "将相机俯视20度", "f_seed": 9},
            {"angle_engine": "local", "source_asset_id": 1},
        ),
    )
    task_ids: list[str] = []
    for tool_id, key, route, fields, context in cases:
        response = await client.post(
            f"/studio/tools/{tool_id}/runs",
            json={
                "operation": "workflow.run",
                "input": {
                    "workflow_id": by_key[key]["id"],
                    "credential_id": credential.id,
                    "fields": fields,
                },
                "source_route": route,
                "source_context": context,
            },
        )
        assert response.status_code == 202, response.text
        body = response.json()
        assert body["tool_id"] == tool_id
        assert body["source_route"] == route
        task_ids.append(body["id"])
    assert enqueued == [
        (("run_studio_workflow", task_ids[0]), {}),
        (("run_studio_workflow", task_ids[1]), {}),
        (("run_studio_workflow", task_ids[2]), {}),
    ]


async def test_workflow_run_rejects_wrong_provider_credential(client, session) -> None:
    workflow = (await client.get("/studio/workflows?provider=runninghub")).json()["items"][0]
    credential = ProviderCredential(
        name="本机 ComfyUI",
        kind="workflow",
        provider_type="comfyui",
        config={"api_base": "http://127.0.0.1:8188"},
    )
    session.add(credential)
    await session.commit()
    await session.refresh(credential)
    response = await client.post(
        f"/studio/workflows/{workflow['id']}/runs",
        json={"credential_id": credential.id},
    )
    assert response.status_code == 400
    assert "runninghub" in response.json()["detail"]


async def test_failed_workflow_task_can_retry_without_overwriting_history(
    client, session, monkeypatch
) -> None:
    original = new_task(
        tool_id="workflow-center",
        task_type="workflow.comfyui",
        source_route="/studio/workflows?workflow=7",
        source_context={"workflow_id": 7},
        invocation={"workflow_id": 7, "credential_id": 9, "fields": {}},
    )
    original.provider_task_id = "prompt-existing"
    transition(
        original,
        "failed",
        stage="workflow_execute",
        error="临时断网",
        retryable=True,
    )
    session.add(original)
    await session.commit()
    enqueued: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            enqueued.append((args, kwargs))

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.studio_tasks.get_queue", fake_queue)
    response = await client.post(f"/studio/tasks/{original.id}/retry")
    assert response.status_code == 202, response.text
    retried = response.json()
    assert retried["id"] != original.id
    assert retried["parent_task_id"] == original.id
    assert retried["provider_task_id"] == "prompt-existing"
    assert retried["status"] == "queued"
    assert enqueued == [(("run_studio_workflow", retried["id"]), {})]
    stored_original = await session.get(StudioTask, original.id)
    assert stored_original.status == "failed"


async def test_succeeded_workflow_task_can_rerun_without_reusing_provider_task(
    client, session, monkeypatch
) -> None:
    original = new_task(
        tool_id="workflow-center",
        task_type="workflow.comfyui",
        source_route="/studio/workflows?workflow=7",
        source_context={"workflow_id": 7},
        invocation={"workflow_id": 7, "credential_id": 9, "fields": {"seed": 8}},
    )
    original.provider_task_id = "prompt-already-finished"
    transition(original, "running")
    transition(original, "succeeded", result={"items": []})
    session.add(original)
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
    rerun = response.json()
    assert rerun["parent_task_id"] == original.id
    assert rerun["invocation"] == original.invocation
    assert rerun["provider_task_id"] is None
    assert rerun["status"] == "queued"
    assert enqueued == [(("run_studio_workflow", rerun["id"]), {})]


async def test_video_run_registers_persistent_task_before_enqueue(
    client, session, monkeypatch
) -> None:
    credential = ProviderCredential(
        name="OpenAI Videos",
        kind="video",
        provider_type="openai_video",
        config={"api_key": "encrypted-in-production"},
    )
    session.add(credential)
    await session.flush()
    deployment = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id="sora-2",
        adapter_type="openai",
        media_types=["video"],
    )
    session.add(deployment)
    await session.commit()
    await session.refresh(deployment)
    enqueued: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            enqueued.append((args, kwargs))

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.studio.get_queue", fake_queue)
    response = await client.post(
        "/studio/videos/runs",
        json={
            "deployment_id": deployment.id,
            "prompt": "A paper boat on a moonlit lake",
            "duration": 4,
            "aspect_ratio": "16:9",
            "resolution": "720p",
        },
    )
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["tool_id"] == "video-director"
    assert body["task_type"] == "video.generate"
    assert body["deployment_id"] == deployment.id
    assert enqueued == [(("generate_studio_video", body["id"]), {})]


async def test_canvas_video_run_is_attributed_to_canvas_tool(client, session, monkeypatch) -> None:
    credential = ProviderCredential(
        name="Seedance",
        kind="video",
        provider_type="volcengine_video",
        config={"api_key": "encrypted-in-production"},
    )
    session.add(credential)
    await session.flush()
    deployment = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id="seedance-2.0",
        adapter_type="volcengine",
        media_types=["video"],
    )
    session.add(deployment)
    await session.commit()
    first = ImageAsset(
        sha256="1" * 64,
        storage_key="images/test/video-first.png",
        mime="image/png",
        width=64,
        height=64,
        bytes=10,
        target_key="free",
        prompt="first",
        source="workbench",
    )
    last = ImageAsset(
        sha256="2" * 64,
        storage_key="images/test/video-last.png",
        mime="image/png",
        width=64,
        height=64,
        bytes=10,
        target_key="free",
        prompt="last",
        source="workbench",
    )
    reference_video = StudioMediaAsset(
        kind="video",
        name="motion.mp4",
        mime="video/mp4",
        sha256="6" * 64,
        storage_key="media/test/volc-motion.mp4",
        bytes=100,
    )
    reference_audio = StudioMediaAsset(
        kind="audio",
        name="rhythm.mp3",
        mime="audio/mpeg",
        sha256="7" * 64,
        storage_key="media/test/volc-rhythm.mp3",
        bytes=100,
    )
    session.add_all([first, last, reference_video, reference_audio])
    await session.commit()

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            return None

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.studio.get_queue", fake_queue)
    response = await client.post(
        "/studio/videos/runs",
        json={
            "deployment_id": deployment.id,
            "prompt": "A crane flying",
            "references": [
                {"asset_id": first.id, "role": "first_frame"},
                {"asset_id": last.id, "role": "last_frame"},
            ],
            "media_references": [
                {"media_asset_id": reference_video.id, "kind": "video"},
                {"media_asset_id": reference_audio.id, "kind": "audio"},
            ],
            "options": {"generate_audio": True, "seed": 17},
            "source_route": "/studio/canvas/9",
            "source_context": {"canvas_id": 9, "node_id": "video-node"},
        },
    )
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["tool_id"] == "infinite-canvas"
    assert body["source_context"] == {"canvas_id": 9, "node_id": "video-node"}
    task = await session.get(StudioTask, body["id"])
    assert task is not None
    assert task.invocation["references"] == [
        {"asset_id": first.id, "role": "first_frame"},
        {"asset_id": last.id, "role": "last_frame"},
    ]
    assert task.invocation["media_references"] == [
        {"media_asset_id": reference_video.id, "kind": "video"},
        {"media_asset_id": reference_audio.id, "kind": "audio"},
    ]
    assert task.invocation["options"] == {
        "watermark": False,
        "generate_audio": True,
        "camera_fixed": False,
        "seed": 17,
    }


async def test_jimeng_video_run_keeps_image_video_and_audio_references(
    client, session, monkeypatch
) -> None:
    credential = ProviderCredential(
        name="Dreamina",
        kind="image",
        provider_type="jimeng_cli",
        config={"executable": "/tmp/dreamina"},
    )
    session.add(credential)
    await session.flush()
    deployment = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id="seedance2.0",
        adapter_type="jimeng",
        media_types=["video"],
    )
    image = ImageAsset(
        sha256="3" * 64,
        storage_key="images/test/jimeng-ref.png",
        mime="image/png",
        width=64,
        height=64,
        bytes=10,
        target_key="free",
        prompt="reference",
        source="workbench",
    )
    video = StudioMediaAsset(
        kind="video",
        name="reference.mp4",
        mime="video/mp4",
        sha256="4" * 64,
        storage_key="media/test/reference.mp4",
        bytes=100,
    )
    audio = StudioMediaAsset(
        kind="audio",
        name="reference.mp3",
        mime="audio/mpeg",
        sha256="5" * 64,
        storage_key="media/test/reference.mp3",
        bytes=100,
    )
    session.add_all([deployment, image, video, audio])
    await session.commit()

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            return None

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.studio.get_queue", fake_queue)
    response = await client.post(
        "/studio/videos/runs",
        json={
            "deployment_id": deployment.id,
            "prompt": "Follow image identity, video motion and audio rhythm",
            "duration": 5,
            "references": [{"asset_id": image.id, "role": "reference_image"}],
            "media_references": [
                {"media_asset_id": video.id, "kind": "video"},
                {"media_asset_id": audio.id, "kind": "audio"},
            ],
            "options": {"multimodal": True},
        },
    )
    assert response.status_code == 202, response.text
    task = await session.get(StudioTask, response.json()["id"])
    assert task is not None
    assert task.invocation["media_references"] == [
        {"media_asset_id": video.id, "kind": "video"},
        {"media_asset_id": audio.id, "kind": "audio"},
    ]
    assert task.invocation["options"]["multimodal"] is True

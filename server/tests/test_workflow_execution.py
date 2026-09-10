"""ComfyUI / RunningHub 工作流执行器协议测试，全部使用 MockTransport。"""

import inspect
import json

import httpx
import pytest
from sqlalchemy import select

from domain import workflow_execution
from domain.models import ModelInvocation, StudioWorkflow
from domain.workflow_execution import (
    WorkflowExecutionError,
    apply_comfy_fields,
    resume_handle,
    runninghub_node_info,
    runninghub_pruned_workflow,
    submit,
    wait_for_outputs,
)


def _workflow(**overrides) -> StudioWorkflow:
    values = {
        "id": 1,
        "key": "user:test",
        "title": "Test",
        "provider": "comfyui",
        "kind": "image",
        "source": "user",
        "source_id": "wf-1",
        "payload": {"10": {"class_type": "Text", "inputs": {"text": "old"}}},
        "ui_schema": {
            "fields": [
                {
                    "id": "prompt",
                    "node": "10",
                    "input": "text",
                    "name": "Prompt",
                    "type": "textarea",
                    "default": "old",
                }
            ]
        },
        "content_hash": "x" * 64,
        "enabled": True,
    }
    values.update(overrides)
    return StudioWorkflow(**values)


def _install_transport(monkeypatch, handler) -> None:
    real_client = httpx.AsyncClient

    def factory(base_url: str, timeout: float = 180.0):
        return real_client(
            transport=httpx.MockTransport(handler),
            timeout=timeout,
            base_url=base_url,
        )

    monkeypatch.setattr(workflow_execution, "_client", factory)


def test_workflow_public_runtime_has_no_static_provider_dispatch() -> None:
    assert "provider ==" not in inspect.getsource(workflow_execution.submit)
    assert "provider ==" not in inspect.getsource(workflow_execution.resume_handle)
    assert "provider ==" not in inspect.getsource(workflow_execution.wait_for_outputs)


def test_apply_comfy_fields_only_overrides_declared_inputs() -> None:
    workflow = _workflow()
    updated = apply_comfy_fields(workflow.payload, workflow.ui_schema, {"prompt": "new"})
    assert updated["10"]["inputs"]["text"] == "new"
    assert workflow.payload["10"]["inputs"]["text"] == "old"
    with pytest.raises(WorkflowExecutionError, match="未定义"):
        apply_comfy_fields(workflow.payload, workflow.ui_schema, {"hidden": "inject"})


def test_apply_comfy_fields_builds_minimax_multimodal_reference_nodes() -> None:
    payload = {
        "136": {
            "class_type": "MiniMaxH3ReferenceToVideo",
            "inputs": {"ref_images.ref_image_0": ["137", 0]},
        }
    }
    schema = {
        "fields": [
            {
                "id": "references",
                "node": "136",
                "input": "",
                "type": "minimax_refs",
            }
        ]
    }

    updated = apply_comfy_fields(
        payload,
        schema,
        {
            "references": [
                {"kind": "image", "remote": "image.png"},
                {"kind": "video", "remote": "clip.mp4"},
                {"kind": "audio", "remote": "voice.mp3"},
            ]
        },
    )

    inputs = updated["136"]["inputs"]
    assert inputs["ref_images.ref_image_0"] == ["9000", 0]
    assert inputs["ref_images.ref_image_1"] is None
    assert inputs["ref_videos.ref_video_0"] == ["9050", 0]
    assert inputs["ref_audios.ref_audio_0"] == ["9060", 0]
    assert updated["9000"]["inputs"] == {"image": "image.png"}
    assert updated["9040"]["inputs"] == {"file": "clip.mp4"}
    assert updated["9050"]["inputs"] == {"video": ["9040", 0]}
    assert updated["9060"]["inputs"] == {"audio": "voice.mp3"}
    assert payload["136"]["inputs"]["ref_images.ref_image_0"] == ["137", 0]


def test_apply_comfy_fields_rejects_minimax_reference_overflow() -> None:
    payload = {"136": {"inputs": {}}}
    schema = {"fields": [{"id": "references", "type": "minimax_refs"}]}
    references = [{"kind": "video", "remote": f"clip-{index}.mp4"} for index in range(4)]
    with pytest.raises(WorkflowExecutionError, match="最多支持 3 段参考视频"):
        apply_comfy_fields(payload, schema, {"references": references})


def test_runninghub_node_info_uses_enabled_defaults_and_explicit_values() -> None:
    schema = {
        "fields": [
            {
                "id": "1::prompt",
                "nodeId": "1",
                "fieldName": "prompt",
                "fieldValue": "default",
                "enabled": True,
            },
            {
                "id": "2::seed",
                "nodeId": "2",
                "fieldName": "seed",
                "fieldValue": "42",
                "enabled": False,
            },
        ]
    }
    assert runninghub_node_info(schema, {}) == [
        {"nodeId": "1", "fieldName": "prompt", "fieldValue": "default"}
    ]
    assert runninghub_node_info(schema, {"2::seed": 9})[-1] == {
        "nodeId": "2",
        "fieldName": "seed",
        "fieldValue": 9,
    }


def test_runninghub_node_info_enforces_required_and_randomizes_seed(monkeypatch) -> None:
    schema = {
        "fields": [
            {
                "id": "1::image",
                "nodeId": "1",
                "fieldName": "image",
                "label": "主图",
                "fieldType": "IMAGE",
                "fieldValue": "",
                "required": True,
            },
            {
                "id": "2::seed",
                "nodeId": "2",
                "fieldName": "seed",
                "fieldType": "NUMBER",
                "random_enabled": True,
                "min": 1,
                "max": 100,
                "step": 1,
            },
        ]
    }
    with pytest.raises(WorkflowExecutionError, match="主图"):
        runninghub_node_info(schema, {})
    monkeypatch.setattr(workflow_execution.random, "uniform", lambda _lo, _hi: 42.2)
    assert runninghub_node_info(schema, {"1::image": "uploaded.png"})[-1]["fieldValue"] == 42


def test_runninghub_optional_image_is_omitted_and_workflow_is_pruned() -> None:
    schema = {
        "optionalImageMode": "prune-workflow",
        "fields": [
            {
                "id": "1::image",
                "nodeId": "1",
                "fieldName": "image",
                "fieldType": "IMAGE",
                "fieldValue": "",
                "enabled": True,
                "required": False,
            },
            {
                "id": "2::prompt",
                "nodeId": "2",
                "fieldName": "prompt",
                "fieldType": "TEXT",
                "fieldValue": "a fox",
                "enabled": True,
            },
        ],
    }
    workflow = _workflow(
        provider="runninghub",
        kind="workflow",
        payload={
            "id": "2058",
            "workflow_json": {
                "1": {"class_type": "LoadImage", "inputs": {"image": ""}},
                "2": {"class_type": "Text", "inputs": {"prompt": "a fox"}},
                "3": {
                    "class_type": "Sampler",
                    "inputs": {"optional_image": ["1", 0], "prompt": ["2", 0]},
                },
            },
        },
        ui_schema=schema,
    )

    info = runninghub_node_info(schema, {})
    assert info == [{"nodeId": "2", "fieldName": "prompt", "fieldValue": "a fox"}]
    pruned = runninghub_pruned_workflow(workflow, info)
    assert pruned is not None
    assert "1" not in pruned
    assert pruned["3"]["inputs"] == {"prompt": ["2", 0]}
    assert "1" in workflow.payload["workflow_json"]


def test_resume_handle_reuses_provider_id_and_selected_wallet_key() -> None:
    handle = resume_handle(
        "runninghub",
        "existing-task",
        {
            "api_base": "https://www.runninghub.ai/openapi/v2",
            "api_key": "normal-key",
            "wallet_api_key": "wallet-key",
        },
        use_wallet=True,
    )
    assert handle.provider_task_id == "existing-task"
    assert handle.base_url == "https://www.runninghub.ai"
    assert handle.credential_config["api_key"] == "wallet-key"


def test_resume_runninghub_model_always_reuses_wallet_key() -> None:
    handle = resume_handle(
        "runninghub",
        "model-task",
        {
            "api_base": "https://www.runninghub.ai",
            "api_key": "points-key",
            "wallet_api_key": "wallet-key",
        },
        workflow_kind="model",
    )
    assert handle.credential_config["api_key"] == "wallet-key"
    assert handle.workflow_kind == "model"


async def test_comfy_submit_poll_and_download(session, monkeypatch) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/prompt":
            body = json.loads(request.content)
            assert body["prompt"]["10"]["inputs"]["text"] == "a fox"
            return httpx.Response(200, json={"prompt_id": "prompt-1"})
        if request.url.path == "/history/prompt-1":
            return httpx.Response(
                200,
                json={
                    "prompt-1": {
                        "outputs": {
                            "20": {
                                "images": [
                                    {
                                        "filename": "fox.png",
                                        "subfolder": "",
                                        "type": "output",
                                    }
                                ]
                            }
                        }
                    }
                },
            )
        if request.url.path == "/view":
            return httpx.Response(
                200,
                content=b"image-bytes",
                headers={"content-type": "image/png"},
            )
        return httpx.Response(404)

    _install_transport(monkeypatch, handler)
    handle = await submit(
        session,
        workflow=_workflow(),
        config={"api_base": "http://127.0.0.1:8188"},
        values={"prompt": "a fox"},
    )
    assert handle.provider_task_id == "prompt-1"
    outputs = await wait_for_outputs(handle)
    assert [(output.name, output.kind, output.data) for output in outputs] == [
        ("fox.png", "image", b"image-bytes")
    ]
    assert requests[-1].url.params["filename"] == "fox.png"
    invocations = list(
        (
            await session.execute(
                select(ModelInvocation).where(ModelInvocation.plugin_id == "comfyui")
            )
        ).scalars()
    )
    assert {row.request["phase"] for row in invocations} == {"submit", "wait"}
    assert all(row.status == "succeeded" for row in invocations)
    assert all(row.provider_request_id == "prompt-1" for row in invocations)
    assert all(row.operation == "workflow.run" for row in invocations)
    assert all(row.model == "wf-1" for row in invocations)
    assert all(row.runtime_generation is not None for row in invocations)
    assert all(row.request["route"]["plugin_id"] == "comfyui" for row in invocations)


async def test_runninghub_submit_poll_and_download(session, monkeypatch) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/task/openapi/create":
            body = json.loads(request.content)
            assert body["apiKey"] == "rh-key"
            assert body["workflowId"] == "2058"
            return httpx.Response(200, json={"code": 0, "data": {"taskId": "rh-1"}})
        if request.url.path == "/task/openapi/outputs":
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": [{"fileUrl": "https://cdn.example/result.mp4"}],
                },
            )
        if request.url.host == "cdn.example":
            return httpx.Response(200, content=b"video", headers={"content-type": "video/mp4"})
        return httpx.Response(404)

    _install_transport(monkeypatch, handler)
    workflow = _workflow(
        provider="runninghub",
        kind="workflow",
        source_id="2058",
        payload={"id": "2058"},
        ui_schema={"fields": []},
    )
    handle = await submit(
        session,
        workflow=workflow,
        config={"api_base": "https://www.runninghub.ai", "api_key": "rh-key"},
        values={},
    )
    assert handle.provider_task_id == "rh-1"
    outputs = await wait_for_outputs(handle)
    assert outputs[0].kind == "video"
    assert outputs[0].data == b"video"
    assert outputs[0].source_url == "https://cdn.example/result.mp4"


async def test_runninghub_submit_sends_pruned_workflow_for_empty_optional_image(
    session, monkeypatch
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/task/openapi/create"
        body = json.loads(request.content)
        assert body["nodeInfoList"] == [
            {"nodeId": "2", "fieldName": "prompt", "fieldValue": "paper fox"}
        ]
        assert "1" not in body["workflow"]
        assert body["workflow"]["3"]["inputs"] == {"prompt": ["2", 0]}
        return httpx.Response(200, json={"code": 0, "data": {"taskId": "rh-pruned-1"}})

    _install_transport(monkeypatch, handler)
    workflow = _workflow(
        provider="runninghub",
        kind="workflow",
        source_id="2058",
        payload={
            "id": "2058",
            "workflow_json": {
                "1": {"class_type": "LoadImage", "inputs": {"image": ""}},
                "2": {"class_type": "Text", "inputs": {"prompt": "paper fox"}},
                "3": {
                    "class_type": "Sampler",
                    "inputs": {"optional_image": ["1", 0], "prompt": ["2", 0]},
                },
            },
        },
        ui_schema={
            "optionalImageMode": "prune-workflow",
            "fields": [
                {
                    "id": "1::image",
                    "nodeId": "1",
                    "fieldName": "image",
                    "fieldType": "IMAGE",
                    "fieldValue": "",
                    "enabled": True,
                    "required": False,
                },
                {
                    "id": "2::prompt",
                    "nodeId": "2",
                    "fieldName": "prompt",
                    "fieldType": "TEXT",
                    "fieldValue": "paper fox",
                    "enabled": True,
                },
            ],
        },
    )

    handle = await submit(
        session,
        workflow=workflow,
        config={"api_base": "https://www.runninghub.ai", "api_key": "rh-key"},
        values={},
    )

    assert handle.provider_task_id == "rh-pruned-1"


async def test_runninghub_app_submit_includes_selected_instance_type(
    session, monkeypatch
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/task/openapi/ai-app/run":
            body = json.loads(request.content)
            assert body == {
                "apiKey": "rh-key",
                "webappId": "app-2058",
                "nodeInfoList": [
                    {"nodeId": "1", "fieldName": "prompt", "fieldValue": "a fox"}
                ],
                "instanceType": "plus",
            }
            return httpx.Response(200, json={"code": 0, "data": {"taskId": "rh-app-1"}})
        return httpx.Response(404)

    _install_transport(monkeypatch, handler)
    workflow = _workflow(
        provider="runninghub",
        kind="app",
        source_id="app-2058",
        payload={"id": "app-2058"},
        ui_schema={
            "fields": [
                {
                    "id": "1::prompt",
                    "nodeId": "1",
                    "fieldName": "prompt",
                    "fieldValue": "",
                    "enabled": True,
                }
            ]
        },
    )

    handle = await submit(
        session,
        workflow=workflow,
        config={"api_base": "https://www.runninghub.ai", "api_key": "rh-key"},
        values={"1::prompt": "a fox"},
        instance_type="plus",
    )

    assert handle.provider_task_id == "rh-app-1"
    assert [request.url.path for request in requests] == ["/task/openapi/ai-app/run"]


async def test_runninghub_model_submit_and_query_use_openapi_v2_wallet_contract(
    session, monkeypatch
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.host == "www.runninghub.ai":
            assert request.headers["authorization"] == "Bearer wallet-key"
        if request.url.path == "/openapi/v2/rhart-image/z-image/turbo":
            assert json.loads(request.content) == {
                "prompt": "paper fox",
                "width": 1024,
            }
            return httpx.Response(200, json={"taskId": "model-1", "status": "RUNNING"})
        if request.url.path == "/openapi/v2/query":
            assert json.loads(request.content) == {"taskId": "model-1"}
            return httpx.Response(
                200,
                json={
                    "taskId": "model-1",
                    "status": "SUCCESS",
                    "results": [{"url": "https://cdn.example/model.png"}],
                },
            )
        if request.url.host == "cdn.example":
            return httpx.Response(
                200, content=b"model-image", headers={"content-type": "image/png"}
            )
        return httpx.Response(404)

    _install_transport(monkeypatch, handler)
    workflow = _workflow(
        provider="runninghub",
        kind="model",
        source_id="z-image/turbo",
        payload={"id": "z-image/turbo", "endpoint": "rhart-image/z-image/turbo"},
        ui_schema={
            "fields": [
                {
                    "id": "model::prompt",
                    "nodeId": "model",
                    "fieldName": "prompt",
                    "fieldValue": "",
                    "enabled": True,
                },
                {
                    "id": "model::width",
                    "nodeId": "model",
                    "fieldName": "width",
                    "fieldValue": 1024,
                    "enabled": True,
                },
            ]
        },
    )
    handle = await submit(
        session,
        workflow=workflow,
        config={
            "api_base": "https://www.runninghub.ai",
            "api_key": "points-key",
            "wallet_api_key": "wallet-key",
        },
        values={"model::prompt": "paper fox"},
    )
    assert handle.workflow_kind == "model"
    outputs = await wait_for_outputs(handle)
    assert outputs[0].data == b"model-image"
    assert [request.url.path for request in requests] == [
        "/openapi/v2/rhart-image/z-image/turbo",
        "/openapi/v2/query",
        "/model.png",
    ]


async def test_resolve_timeline_uploads_assets_once(session, monkeypatch) -> None:
    uploads: list[int] = []
    media_uploads: list[tuple[int, str]] = []

    async def upload_asset(*args, asset_id: int, **kwargs) -> str:
        uploads.append(asset_id)
        return f"remote-{asset_id}.png"

    monkeypatch.setattr(workflow_execution, "_upload_asset", upload_asset)

    async def upload_media(*args, media_id: int, expected_kind: str, **kwargs) -> str:
        media_uploads.append((media_id, expected_kind))
        return f"remote-{media_id}.mp3"

    monkeypatch.setattr(workflow_execution, "_upload_media_asset", upload_media)
    resolved = await workflow_execution.resolve_media_values(
        session,
        provider="comfyui",
        config={"api_base": "http://127.0.0.1:8188"},
        ui_schema={"fields": [{"id": "timeline", "type": "timeline"}]},
        values={
            "timeline": json.dumps(
                {
                    "segments": [
                        {"id": "one", "type": "image", "asset_id": 7},
                        {"id": "two", "type": "image", "image_ref": "asset:7"},
                        {"id": "three", "type": "text", "prompt": "a fox"},
                    ],
                    "audioSegments": [
                        {
                            "id": "voice",
                            "type": "audio",
                            "media_asset_id": 12,
                            "start": 0,
                            "length": 24,
                        },
                        {
                            "id": "voice-copy",
                            "audio_ref": "media:12",
                            "start": 24,
                            "length": 24,
                        },
                    ],
                }
            )
        },
    )

    timeline = json.loads(resolved["timeline"])
    assert uploads == [7]
    assert media_uploads == [(12, "audio")]
    assert timeline["segments"][0]["imageFile"] == "remote-7.png"
    assert timeline["segments"][1]["imageFile"] == "remote-7.png"
    assert "asset_id" not in timeline["segments"][0]
    assert "image_ref" not in timeline["segments"][1]
    assert timeline["segments"][2] == {"id": "three", "type": "text", "prompt": "a fox"}
    assert timeline["audioSegments"][0]["audioFile"] == "remote-12.mp3"
    assert timeline["audioSegments"][1]["audioFile"] == "remote-12.mp3"
    assert "media_asset_id" not in timeline["audioSegments"][0]
    assert "audio_ref" not in timeline["audioSegments"][1]


async def test_resolve_media_values_uploads_typed_non_image_assets(session, monkeypatch) -> None:
    uploads: list[tuple[int, str]] = []

    async def upload_media(*args, media_id: int, expected_kind: str, **kwargs) -> str:
        uploads.append((media_id, expected_kind))
        return f"remote-{media_id}.bin"

    monkeypatch.setattr(workflow_execution, "_upload_media_asset", upload_media)
    resolved = await workflow_execution.resolve_media_values(
        session,
        provider="runninghub",
        config={"api_base": "https://www.runninghub.ai", "api_key": "rh-key"},
        ui_schema={
            "fields": [
                {"id": "clip", "type": "video"},
                {"id": "voice", "type": "audio"},
                {"id": "document", "type": "file"},
            ]
        },
        values={"clip": "media:4", "voice": "media:5", "document": "media:6"},
    )
    assert uploads == [(4, "video"), (5, "audio"), (6, "file")]
    assert resolved == {
        "clip": "remote-4.bin",
        "voice": "remote-5.bin",
        "document": "remote-6.bin",
    }


async def test_resolve_media_values_uploads_minimax_typed_references(session, monkeypatch) -> None:
    uploads: list[tuple[str, int]] = []

    async def upload_asset(*args, asset_id: int, **kwargs) -> str:
        uploads.append(("image", asset_id))
        return f"image-{asset_id}.png"

    async def upload_media(*args, media_id: int, expected_kind: str, **kwargs) -> str:
        uploads.append((expected_kind, media_id))
        return f"{expected_kind}-{media_id}.bin"

    monkeypatch.setattr(workflow_execution, "_upload_asset", upload_asset)
    monkeypatch.setattr(workflow_execution, "_upload_media_asset", upload_media)
    resolved = await workflow_execution.resolve_media_values(
        session,
        provider="comfyui",
        config={"api_base": "http://127.0.0.1:8188"},
        ui_schema={
            "fields": [
                {"id": "cover", "type": "image"},
                {"id": "references", "type": "minimax_refs"},
            ]
        },
        values={
            "cover": "asset:7",
            "references": [
                {"kind": "image", "ref": "asset:7"},
                {"kind": "video", "ref": "media:8"},
                {"kind": "audio", "ref": "media:9"},
                {"kind": "image", "ref": "asset:7"},
            ],
        },
    )

    assert uploads == [("image", 7), ("video", 8), ("audio", 9)]
    assert resolved["cover"] == "image-7.png"
    assert resolved["references"] == [
        {"kind": "image", "remote": "image-7.png"},
        {"kind": "video", "remote": "video-8.bin"},
        {"kind": "audio", "remote": "audio-9.bin"},
    ]


async def test_resolve_media_values_rejects_wrong_reference_family(session) -> None:
    with pytest.raises(WorkflowExecutionError, match="需要 media:<媒体ID>"):
        await workflow_execution.resolve_media_values(
            session,
            provider="comfyui",
            config={"api_base": "http://127.0.0.1:8188"},
            ui_schema={"fields": [{"id": "clip", "type": "video"}]},
            values={"clip": "asset:7"},
        )
    with pytest.raises(WorkflowExecutionError, match="需要 asset:<图片ID>"):
        await workflow_execution.resolve_media_values(
            session,
            provider="comfyui",
            config={"api_base": "http://127.0.0.1:8188"},
            ui_schema={"fields": [{"id": "cover", "type": "image"}]},
            values={"cover": "media:7"},
        )


async def test_resolve_timeline_rejects_invalid_json(session) -> None:
    with pytest.raises(WorkflowExecutionError, match="不是有效 JSON"):
        await workflow_execution.resolve_media_values(
            session,
            provider="comfyui",
            config={"api_base": "http://127.0.0.1:8188"},
            ui_schema={"fields": [{"id": "timeline", "type": "timeline"}]},
            values={"timeline": "{"},
        )

"""插件运行时：注册生命周期与模型适配器目录。"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.usage import RequestUsage

import domain.llm as llm
import domain.model_runtime as model_runtime
import domain.transcribe as transcribe
from app.routers import tts as tts_router
from domain.audio_runtime import (
    AudioRouteRequest,
    AudioSynthesis,
    PreparedAudioRoute,
    prepare_audio_route,
    register_audio_route_provider,
)
from domain.imagegen import (
    ImageGenError,
    PreparedImageRoute,
    RenderResult,
    prepare_image_route,
    register_image_route_provider,
)
from domain.model_catalog import ResolvedModelRoute
from domain.model_invocations import ModelInvocationSpan, invocation_context, safe_payload
from domain.model_plugins import (
    adapter_for_provider,
    get_model_plugin,
    list_model_plugins,
    register_model_plugin,
)
from domain.model_runtime import (
    ChatRouteEndpoint,
    ChatRouteRequest,
    PreparedChatRoute,
    SecretHandle,
    prepare_chat_route,
    register_chat_route_provider,
)
from domain.models import (
    CapabilityBinding,
    ModelDeployment,
    ProviderCredential,
    StudioWorkflow,
    Video,
)
from domain.plugin_runtime import PluginManifest, PluginRegistry, PluginRegistryError
from domain.repair_agent import LoggedRepairModel
from domain.studio_tasks import new_task
from domain.tool_execution import enqueue_task, new_execution_task
from domain.tool_plugins import (
    TOOL_STATUSES,
    get_tool_plugin,
    list_tool_plugins,
    register_tool_plugin,
)
from domain.video_generation import (
    PreparedVideoRoute,
    VideoHandle,
    VideoOutput,
    prepare_video_route,
    register_video_route_provider,
)
from domain.workflow_execution import (
    PreparedWorkflowRoute,
    WorkflowHandle,
    WorkflowOutput,
    prepare_workflow_route,
    register_workflow_route_provider,
)


def _manifest(plugin_id: str, *, priority: int = 0) -> PluginManifest:
    return PluginManifest(
        id=plugin_id,
        kind="test",
        name=plugin_id,
        version="1.0.0",
        capabilities=frozenset({"test.run"}),
        priority=priority,
    )


def test_registration_is_reversible_and_stale_disposer_is_safe() -> None:
    registry: PluginRegistry[object] = PluginRegistry("test")
    first = object()
    second = object()
    first_handle = registry.register(_manifest("sample"), first)
    second_handle = registry.register(_manifest("sample", priority=10), second, replace=True)

    assert registry.require("sample").implementation is second
    first_handle.dispose()
    assert registry.require("sample").implementation is second

    second_handle.dispose()
    assert registry.require("sample").implementation is first
    first_handle.dispose()
    assert registry.get("sample") is None


def test_capability_resolution_uses_priority_and_can_be_pinned() -> None:
    registry: PluginRegistry[str] = PluginRegistry("test")
    registry.register(_manifest("fallback", priority=1), "fallback")
    registry.register(_manifest("preferred", priority=20), "preferred")

    assert registry.resolve("test.run").implementation == "preferred"
    assert registry.resolve("test.run", preferred_id="fallback").implementation == "fallback"


def test_registry_rejects_wrong_kind_and_unknown_capability() -> None:
    registry: PluginRegistry[object] = PluginRegistry("test")
    with pytest.raises(PluginRegistryError, match="类型"):
        registry.register(
            PluginManifest(id="wrong", kind="other", name="wrong", version="1"),
            object(),
        )
    with pytest.raises(PluginRegistryError, match="没有插件"):
        registry.resolve("test.missing")


def test_model_plugins_are_runtime_data_not_a_static_adapter_set() -> None:
    before = {item["id"] for item in list_model_plugins()}
    assert {"openai", "gemini", "volcengine", "comfyui"} <= before
    assert get_model_plugin("openai").supports("image.generate")
    assert adapter_for_provider("gemini_image") == "gemini"

    handle = register_model_plugin(
        plugin_id="example-adapter",
        name="Example Adapter",
        media_types={"chat"},
        operations={"chat.complete"},
        provider_types={"example_provider"},
    )
    try:
        assert get_model_plugin("example-adapter").supports("chat.complete")
        assert adapter_for_provider("example_provider") == "example-adapter"
        assert "example-adapter" in {item["id"] for item in list_model_plugins()}
    finally:
        handle.dispose()

    assert "example-adapter" not in {item["id"] for item in list_model_plugins()}


async def test_chat_provider_registration_is_reversible_and_prepared_route_is_frozen(
    session,
) -> None:
    class Provider:
        def __init__(self, name: str) -> None:
            self.name = name

        def resolve(self, request: ChatRouteRequest) -> ChatRouteEndpoint:
            assert "sk-example" not in repr(request.credentials)
            return ChatRouteEndpoint(
                base_url=f"https://{self.name}.example/v1",
                transport="test-chat",
                secrets=SecretHandle({"api_key": request.credentials.get("api_key")}),
            )

        def open_client(self, route: PreparedChatRoute, timeout: float):
            return {
                "provider": self.name,
                "base_url": route.snapshot.base_url,
                "timeout": timeout,
            }

    plugin_handle = register_model_plugin(
        plugin_id="example-chat",
        name="Example Chat",
        media_types={"chat"},
        operations={"chat.complete"},
        provider_types={"example_chat"},
    )
    first_handle = register_chat_route_provider(
        plugin_id="example-chat",
        provider=Provider("first"),
        operations={"chat.complete"},
    )
    second_handle = None
    try:
        credential = ProviderCredential(
            name="Example Chat",
            kind="llm",
            provider_type="example_chat",
            config={"api_key": "sk-example"},
        )
        session.add(credential)
        await session.flush()
        deployment = ModelDeployment(
            credential_id=credential.id,
            upstream_model_id="example-model",
            adapter_type="example-chat",
            media_types=["chat"],
            protocol_options={"sampling": {"stop": ["END"]}},
        )
        session.add(deployment)
        await session.commit()

        prepared = await prepare_chat_route(
            "example-capability",
            "chat.complete",
            deployment_id=deployment.id,
        )
        assert prepared.snapshot.transport == "test-chat"
        assert prepared.open_client(12.0)["provider"] == "first"
        deployment.protocol_options["sampling"]["stop"].append("LATER")
        assert prepared.snapshot.view()["protocol_options"] == {"sampling": {"stop": ["END"]}}
        with pytest.raises(TypeError):
            prepared.snapshot.protocol_options["sampling"] = {}
        first_generation = prepared.snapshot.runtime_generation

        second_handle = register_chat_route_provider(
            plugin_id="example-chat",
            provider=Provider("second"),
            operations={"chat.complete"},
            replace=True,
        )
        replacement = await prepare_chat_route(
            "example-capability",
            "chat.complete",
            deployment_id=deployment.id,
        )
        assert replacement.snapshot.runtime_generation > first_generation
        assert replacement.open_client(13.0)["provider"] == "second"
        assert prepared.open_client(14.0)["provider"] == "first"

        second_handle.dispose()
        restored = await prepare_chat_route(
            "example-capability",
            "chat.complete",
            deployment_id=deployment.id,
        )
        assert restored.open_client(15.0)["provider"] == "first"
    finally:
        if second_handle is not None:
            second_handle.dispose()
        first_handle.dispose()
        plugin_handle.dispose()


async def test_image_provider_registration_is_reversible_and_prepared_route_is_frozen() -> None:
    class Provider:
        def __init__(self, name: str) -> None:
            self.name = name

        async def generate(self, route: PreparedImageRoute, **kwargs) -> RenderResult:
            assert "sk-image" not in repr(route)
            return RenderResult(images=[self.name.encode()], model_reported=kwargs["prompt"])

        async def edit(self, route: PreparedImageRoute, **kwargs) -> RenderResult:
            del route, kwargs
            return RenderResult(images=[self.name.encode()])

    plugin_handle = register_model_plugin(
        plugin_id="example-image",
        name="Example Image",
        media_types={"image"},
        operations={"image.generate", "image.edit"},
        provider_types={"example_image"},
    )
    first_handle = register_image_route_provider(
        plugin_id="example-image",
        provider=Provider("first"),
        operations={"image.generate", "image.edit"},
    )
    second_handle = None
    try:
        route = ResolvedModelRoute(
            deployment_id=91,
            adapter_type="example-image",
            upstream_model_id="example-model",
            provider_type="example_image",
            credential_config={"api_key": "sk-image", "nested": {"values": ["first"]}},
            protocol_options={"sampling": {"steps": [1, 2]}},
        )
        prepared = prepare_image_route("image-free", "image.generate", route)
        first_generation = prepared.snapshot.runtime_generation
        route.credential_config["nested"]["values"].append("later")
        route.protocol_options["sampling"]["steps"].append(3)
        assert prepared._route is not None
        assert prepared._route.credential_config["nested"] == {"values": ["first"]}
        assert prepared._route.protocol_options == {"sampling": {"steps": [1, 2]}}
        assert (await prepared.generate(prompt="first-model")).images == [b"first"]

        second_handle = register_image_route_provider(
            plugin_id="example-image",
            provider=Provider("second"),
            operations={"image.generate", "image.edit"},
            replace=True,
        )
        replacement = prepare_image_route("image-free", "image.generate", route)
        assert replacement.snapshot.runtime_generation > first_generation
        assert (await replacement.generate(prompt="second-model")).images == [b"second"]
        assert (await prepared.generate(prompt="still-first")).images == [b"first"]

        second_handle.dispose()
        restored = prepare_image_route("image-free", "image.generate", route)
        assert (await restored.generate(prompt="restored")).images == [b"first"]
    finally:
        if second_handle is not None:
            second_handle.dispose()
        first_handle.dispose()
        plugin_handle.dispose()


async def test_video_provider_registration_is_reversible_and_prepared_route_is_frozen(
    session,
) -> None:
    class Provider:
        def __init__(self, name: str) -> None:
            self.name = name

        async def submit(
            self,
            route: PreparedVideoRoute,
            _session,
            **kwargs,
        ) -> VideoHandle:
            assert "sk-video" not in repr(route)
            return VideoHandle(
                self.name,
                f"{self.name}-{kwargs['prompt']}",
                "",
                {},
                {},
                route.snapshot.model,
                route.snapshot.deployment_id,
            )

        def resume(self, route: PreparedVideoRoute, provider_task_id: str) -> VideoHandle:
            return VideoHandle(
                self.name,
                provider_task_id,
                "",
                {},
                {},
                route.snapshot.model,
                route.snapshot.deployment_id,
            )

        async def wait(self, handle: VideoHandle) -> VideoOutput:
            return VideoOutput(f"{self.name}.mp4", "video/mp4", self.name.encode())

    plugin_handle = register_model_plugin(
        plugin_id="example-video",
        name="Example Video",
        media_types={"video"},
        operations={"video.generate"},
        provider_types={"example_video"},
    )
    first_handle = register_video_route_provider(
        plugin_id="example-video",
        provider=Provider("first"),
        operations={"video.generate"},
    )
    second_handle = None
    try:
        route = ResolvedModelRoute(
            deployment_id=92,
            adapter_type="example-video",
            upstream_model_id="example-video-model",
            provider_type="example_video",
            credential_config={"api_key": "sk-video", "nested": {"values": ["first"]}},
            protocol_options={"sampling": {"steps": [1, 2]}},
        )
        prepared = prepare_video_route("video-generate", "video.generate", route)
        first_generation = prepared.snapshot.runtime_generation
        route.credential_config["nested"]["values"].append("later")
        route.protocol_options["sampling"]["steps"].append(3)
        assert prepared._route.credential_config["nested"] == {"values": ["first"]}
        assert prepared._route.protocol_options == {"sampling": {"steps": [1, 2]}}
        submitted = await prepared.submit(session, prompt="one")
        assert submitted.provider_task_id == "first-one"
        assert (await submitted._provider.wait(submitted)).data == b"first"

        second_handle = register_video_route_provider(
            plugin_id="example-video",
            provider=Provider("second"),
            operations={"video.generate"},
            replace=True,
        )
        replacement = prepare_video_route("video-generate", "video.generate", route)
        assert replacement.snapshot.runtime_generation > first_generation
        assert (await replacement.submit(session, prompt="two")).provider_task_id == "second-two"
        assert (await prepared.submit(session, prompt="three")).provider_task_id == "first-three"

        second_handle.dispose()
        restored = prepare_video_route("video-generate", "video.generate", route)
        assert restored.resume("persisted-task").protocol == "first"
    finally:
        if second_handle is not None:
            second_handle.dispose()
        first_handle.dispose()
        plugin_handle.dispose()


async def test_audio_provider_registration_is_reversible_and_prepared_route_is_frozen(
    tmp_path,
) -> None:
    class Provider:
        def __init__(self, name: str) -> None:
            self.name = name

        async def synthesize(
            self,
            route: PreparedAudioRoute,
            *,
            text: str,
            voice: str,
            rate: int,
            cache_path: Path,
        ) -> AudioSynthesis:
            assert "sk-audio" not in repr(route)
            cache_path.write_bytes(f"{self.name}:{text}:{voice}:{rate}".encode())
            return AudioSynthesis(provider=self.name, path=cache_path)

    plugin_handle = register_model_plugin(
        plugin_id="example-audio",
        name="Example Audio",
        media_types={"audio"},
        operations={"audio.synthesize"},
        provider_types={"example_audio"},
    )
    first_handle = register_audio_route_provider(
        plugin_id="example-audio",
        provider=Provider("first"),
        operations={"audio.synthesize"},
    )
    second_handle = None
    try:
        credentials = {"api_key": "sk-audio", "nested": {"values": ["first"]}}
        options = {"format": {"names": ["mp3"]}}
        request = AudioRouteRequest(
            capability="tts-sentence",
            plugin_id="example-audio",
            provider_type="example_audio",
            model="example-voice",
            credentials=credentials,
            protocol_options=options,
            deployment_id=93,
        )
        prepared = prepare_audio_route(request)
        first_generation = prepared.snapshot.runtime_generation
        credentials["nested"]["values"].append("later")
        options["format"]["names"].append("wav")
        assert prepared._credentials["nested"] == {"values": ["first"]}
        assert prepared._protocol_options == {"format": {"names": ["mp3"]}}
        first = await prepared.synthesize(
            text="one",
            voice="voice",
            rate=0,
            cache_path=tmp_path / "first.mp3",
        )
        assert first.path is not None and first.path.read_bytes().startswith(b"first:")

        second_handle = register_audio_route_provider(
            plugin_id="example-audio",
            provider=Provider("second"),
            operations={"audio.synthesize"},
            replace=True,
        )
        replacement = prepare_audio_route(request)
        assert replacement.snapshot.runtime_generation > first_generation
        second = await replacement.synthesize(
            text="two",
            voice="voice",
            rate=5,
            cache_path=tmp_path / "second.mp3",
        )
        still_first = await prepared.synthesize(
            text="three",
            voice="voice",
            rate=10,
            cache_path=tmp_path / "still-first.mp3",
        )
        assert second.provider == "second"
        assert still_first.provider == "first"

        second_handle.dispose()
        restored = prepare_audio_route(request)
        assert restored.snapshot.runtime_generation == first_generation
    finally:
        if second_handle is not None:
            second_handle.dispose()
        first_handle.dispose()
        plugin_handle.dispose()


async def test_workflow_provider_registration_is_reversible_and_prepared_route_is_frozen(
    session,
) -> None:
    class Provider:
        def __init__(self, name: str) -> None:
            self.name = name

        def prepare_config(self, config, *, use_wallet: bool, workflow_kind: str | None):
            assert use_wallet is False
            assert workflow_kind == "image"
            return {**config, "selected_by": self.name}

        async def submit(
            self,
            route: PreparedWorkflowRoute,
            _session,
            *,
            values,
            instance_type: str,
        ) -> WorkflowHandle:
            assert "secret-workflow" not in repr(route)
            return WorkflowHandle(
                self.name,
                f"{self.name}-{values['prompt']}-{instance_type}",
                "",
                {},
                route.snapshot.workflow_key,
                route.snapshot.source_id,
                route.snapshot.workflow_kind,
            )

        def resume(
            self,
            route: PreparedWorkflowRoute,
            provider_task_id: str,
        ) -> WorkflowHandle:
            return WorkflowHandle(
                self.name,
                provider_task_id,
                "",
                {},
                route.snapshot.workflow_key,
                route.snapshot.source_id,
                route.snapshot.workflow_kind,
            )

        async def wait(self, handle: WorkflowHandle) -> list[WorkflowOutput]:
            return [WorkflowOutput(f"{self.name}.txt", "text/plain", "text", self.name.encode())]

    plugin_handle = register_model_plugin(
        plugin_id="example-workflow",
        name="Example Workflow",
        media_types={"workflow"},
        operations={"workflow.run"},
    )
    first_handle = register_workflow_route_provider(
        plugin_id="example-workflow",
        provider=Provider("first"),
        operations={"workflow.run"},
    )
    second_handle = None
    try:
        workflow = StudioWorkflow(
            id=94,
            key="example:workflow",
            title="Example",
            provider="example-workflow",
            kind="image",
            source="user",
            source_id="source-94",
            payload={"nested": {"values": ["first"]}},
            ui_schema={"fields": []},
            content_hash="x" * 64,
            enabled=True,
        )
        config = {"api_key": "secret-workflow", "nested": {"values": ["first"]}}
        prepared = prepare_workflow_route(workflow, config)
        first_generation = prepared.snapshot.runtime_generation
        workflow.payload["nested"]["values"].append("later")
        config["nested"]["values"].append("later")
        assert prepared._workflow.payload["nested"] == {"values": ["first"]}
        assert prepared._config["nested"] == {"values": ["first"]}
        submitted = await prepared.submit(
            session,
            values={"prompt": "one"},
            instance_type="standard",
        )
        assert submitted.provider_task_id == "first-one-standard"
        assert (await submitted._provider.wait(submitted))[0].data == b"first"

        second_handle = register_workflow_route_provider(
            plugin_id="example-workflow",
            provider=Provider("second"),
            operations={"workflow.run"},
            replace=True,
        )
        replacement = prepare_workflow_route(workflow, config)
        assert replacement.snapshot.runtime_generation > first_generation
        assert (
            await replacement.submit(
                session,
                values={"prompt": "two"},
                instance_type="plus",
            )
        ).provider_task_id == "second-two-plus"
        assert (
            await prepared.submit(
                session,
                values={"prompt": "three"},
                instance_type="standard",
            )
        ).provider_task_id == "first-three-standard"

        second_handle.dispose()
        restored = prepare_workflow_route(workflow, config)
        assert restored.resume("persisted-task").provider == "first"
    finally:
        if second_handle is not None:
            second_handle.dispose()
        first_handle.dispose()
        plugin_handle.dispose()


async def test_model_plugin_catalog_api_is_self_describing(client) -> None:
    response = await client.get("/config/model-plugins")
    assert response.status_code == 200
    by_id = {item["id"]: item for item in response.json()}
    assert by_id["openai"]["media_types"] == ["chat", "image", "video"]
    assert "image.generate" in by_id["openai"]["operations"]
    assert by_id["openai"]["chat_provider_operations"] == [
        "chat.complete",
        "chat.stream",
    ]
    assert by_id["openai"]["chat_runtime_generation"] is not None
    assert by_id["openai"]["image_provider_operations"] == [
        "image.edit",
        "image.generate",
        "image.stream",
    ]
    assert by_id["openai"]["image_runtime_generation"] is not None
    assert by_id["openai"]["video_provider_operations"] == ["video.generate"]
    assert by_id["openai"]["video_runtime_generation"] is not None
    assert "realtime.session" in by_id["volcengine"]["ready_operations"]
    assert by_id["volcengine"]["chat_provider_operations"] == []
    assert by_id["volcengine"]["chat_runtime_generation"] is None
    assert by_id["volcengine"]["image_provider_operations"] == []
    assert by_id["volcengine"]["image_runtime_generation"] is None
    assert by_id["volcengine"]["video_provider_operations"] == ["video.generate"]
    assert by_id["volcengine"]["video_runtime_generation"] is not None
    assert by_id["volcengine"]["audio_provider_operations"] == ["audio.synthesize"]
    assert by_id["volcengine"]["audio_runtime_generation"] is not None
    assert "image.upscale" in by_id["jimeng"]["image_provider_operations"]
    assert by_id["jimeng"]["video_provider_operations"] == ["video.generate"]
    assert by_id["edge-tts"]["ready_operations"] == ["audio.synthesize"]
    assert by_id["edge-tts"]["audio_provider_operations"] == ["audio.synthesize"]
    assert by_id["edge-tts"]["audio_runtime_generation"] is not None
    assert by_id["faster-whisper"]["execution"] == "local"
    assert by_id["faster-whisper"]["ready_operations"] == ["asr.transcribe"]
    assert by_id["runninghub"]["execution"] == "workflow"
    assert by_id["runninghub"]["workflow_provider_operations"] == ["workflow.run"]
    assert by_id["runninghub"]["workflow_runtime_generation"] is not None
    assert by_id["comfyui"]["workflow_provider_operations"] == ["workflow.run"]
    assert by_id["comfyui"]["workflow_runtime_generation"] is not None


async def test_prepared_chat_call_is_one_shot_and_records_runtime_generation(
    client, session, monkeypatch
) -> None:
    await _seed_direct_chat(session)
    calls: list[dict] = []

    class FakeClient:
        def __init__(self, **_kwargs):
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

        async def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                id=f"one-shot-request-{len(calls)}",
                model="one-shot-model",
                usage=None,
                choices=[SimpleNamespace(message=SimpleNamespace(content="ok"))],
            )

        async def close(self):
            return None

    monkeypatch.setattr(model_runtime, "AsyncOpenAI", FakeClient)
    route = await prepare_chat_route("explain-standard", "chat.complete")
    request = {"messages": [{"role": "user", "content": "hello"}]}
    async with route.prepare_call(request, timeout=12.0) as call:
        response = await call.dispatch(model=route.snapshot.model, **request)
        with pytest.raises(model_runtime.ModelRuntimeError, match="不能重复执行"):
            await call.dispatch(model=route.snapshot.model, **request)
        await call.succeed(
            model=response.model,
            response={"text": response.choices[0].message.content},
            provider_request_id=response.id,
        )

    async with route.prepare_call(request, timeout=12.0) as abandoned:
        await abandoned.dispatch(model=route.snapshot.model, **request)

    assert len(calls) == 2
    assert abandoned.state == "abandoned"
    items = (await client.get("/config/model-invocations?plugin_id=openai&limit=10")).json()[
        "items"
    ]
    invocation = next(item for item in items if item["provider_request_id"] == "one-shot-request-1")
    assert invocation["status"] == "succeeded"
    assert invocation["runtime_generation"] == route.snapshot.runtime_generation
    assert invocation["request"]["route"]["transport"] == "openai-chat"
    abandoned_invocation = next(item for item in items if item["status"] == "abandoned")
    assert abandoned_invocation["provider_request_id"] is None
    assert abandoned_invocation["error_type"] == "ModelRuntimeError"


async def test_tool_plugin_catalog_is_server_owned_and_self_describing(client) -> None:
    response = await client.get("/studio/catalog")
    assert response.status_code == 200
    payload = response.json()
    by_id = {item["id"]: item for item in payload["tools"]}
    assert len(by_id) == 22
    assert by_id["infinite-canvas"]["runtime_kind"] == "canvas"
    assert by_id["infinite-canvas"]["resume_policy"] == "checkpoint"
    assert "workflow.run" in by_id["infinite-canvas"]["capabilities"]
    assert "image.generate" in by_id["image-console"]["capabilities"]
    assert by_id["klein-editor"]["route"] == "/studio/klein"
    assert by_id["klein-editor"]["capabilities"] == ["image.generate", "workflow.run"]
    assert by_id["zimage-generator"]["route"] == "/studio/zimage"
    assert by_id["online-image"]["capabilities"] == [
        "image.edit",
        "image.generate",
        "image.upscale",
        "workflow.run",
    ]
    for tool_id in (
        "zimage-generator",
        "online-image",
        "klein-editor",
        "enhance",
        "angle-control",
    ):
        assert by_id[tool_id]["status"] == "ready"
        assert by_id[tool_id]["runtime_kind"] == "task"
        assert by_id[tool_id]["resume_policy"] == "retry"
    assert by_id["video-director"]["operation_contracts"]["video.generate"]["input_schema"][
        "required"
    ] == ["deployment_id", "prompt"]
    assert by_id["infinite-canvas"]["operation_contracts"]["chat.general"]["output_schema"][
        "required"
    ] == ["text"]
    assert by_id["grid-tool"]["status"] == "ready"
    assert {item["id"] for item in payload["tool_categories"]} == {
        "create",
        "manage",
        "connect",
    }


def test_tool_status_is_a_product_fact_not_a_migration_stage() -> None:
    """状态只剩三档，beta 必须说清楚缺什么。

    旧的 partial 档是迁移期遗留：它既不回答「打开能不能用」，也不说缺什么，
    界面上「基础版 · 继续补齐」等于噪音。无限画布被标 partial 就是这么来的。
    """
    assert set(TOOL_STATUSES) == {"ready", "beta", "planned"}
    tools = list_tool_plugins()
    by_id = {item["id"]: item for item in tools}

    for item in tools:
        assert item["status"] in TOOL_STATUSES, item["id"]
        if item["status"] == "beta":
            assert item["gap"].strip(), f"{item['id']} 是 beta 却没写缺口"
        else:
            assert item["gap"] == "", f"{item['id']} 不是 beta 却写了缺口"

    # 级联、服务端投影、工作流编译、画布手势都落地了（M58/M62/M63/M64）
    assert by_id["infinite-canvas"]["status"] == "ready"
    # 扩展与 UXP 面板都在 tools/ 下真实存在，不该再算「还没做」
    assert by_id["chrome-collector"]["status"] == "beta"
    assert by_id["photoshop-connector"]["status"] == "beta"
    # 配置职责搬去 /settings/models 之后，这一页只剩调用账本
    assert by_id["model-lab"]["label"] == "模型调用账本"


def test_tool_gap_is_required_for_beta_and_rejected_otherwise() -> None:
    common = {
        "plugin_id": "gap-guard-tool",
        "label": "Gap Guard",
        "hint": "test",
        "category": "create",
        "blueprint": "TEST-2",
    }
    with pytest.raises(ValueError, match="必须写明缺口"):
        register_tool_plugin(status="beta", **common)
    with pytest.raises(ValueError, match="只有 beta"):
        register_tool_plugin(status="ready", gap="不该有", **common)
    with pytest.raises(ValueError, match="未知工具状态"):
        register_tool_plugin(status="partial", **common)

    handle = register_tool_plugin(status="beta", gap="缺一半", **common)
    try:
        assert get_tool_plugin("gap-guard-tool").gap == "缺一半"
    finally:
        handle.dispose()


def test_tool_plugin_registration_is_reversible() -> None:
    before = {item["id"] for item in list_tool_plugins()}
    handle = register_tool_plugin(
        plugin_id="sample-tool",
        label="Sample",
        hint="test",
        category="create",
        status="planned",
        blueprint="TEST-1",
        capabilities={"sample.run"},
    )
    try:
        assert get_tool_plugin("sample-tool").capabilities == frozenset({"sample.run"})
    finally:
        handle.dispose()
    assert {item["id"] for item in list_tool_plugins()} == before


async def test_tool_execution_freezes_manifest_and_uses_shared_dispatcher() -> None:
    task = new_execution_task(
        tool_id="infinite-canvas",
        operation="image.generate",
        task_type="image.generate",
        source_context={"canvas_id": 7, "node_id": "node-a"},
        model_capability="image-free",
        deployment_id=3,
        invocation={"image_job_id": 42, "prompt": "paper boat"},
    )
    snapshot = task.invocation["_tool_runtime"]
    assert snapshot == {
        "tool_id": "infinite-canvas",
        "tool_version": "1.0.0",
        "tool_generation": snapshot["tool_generation"],
        "operation": "image.generate",
        "runtime_kind": "canvas",
        "resume_policy": "checkpoint",
    }
    assert snapshot["tool_generation"] > 0
    assert task.canvas_id == 7
    assert task.node_id == "node-a"

    enqueued = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            enqueued.append((args, kwargs))

    await enqueue_task(Queue(), task, _job_id="tool-task-42")
    assert enqueued == [
        (("generate_image", 42, None, None, "downstream"), {"_job_id": "tool-task-42"})
    ]

    with pytest.raises(ValueError, match="不支持能力"):
        new_execution_task(
            tool_id="grid-tool",
            operation="video.generate",
            task_type="video.generate",
        )


def test_invocation_payload_redacts_secrets_and_binary_content() -> None:
    payload = safe_payload(
        {
            "api_key": "sk-secret",
            "headers": {"Authorization": "Bearer secret"},
            "image": "data:image/png;base64,abcdef",
            "body": b"abc",
            "signed": "https://cdn.example/a.png?X-Amz-Signature=secret&Expires=1",
            "error": "request failed: Bearer abcdef123456",
        }
    )
    assert payload["api_key"] == "[REDACTED]"
    assert payload["headers"]["Authorization"] == "[REDACTED]"
    assert payload["image"].startswith("[DATA_URL")
    assert payload["body"] == "[BINARY 3 bytes]"
    assert payload["signed"] == "https://cdn.example/a.png?[REDACTED]"
    assert "abcdef123456" not in payload["error"]


async def test_invocation_log_persists_context_and_is_listed(client, session) -> None:
    task = new_task(tool_id="infinite-canvas", task_type="chat.complete")
    session.add(task)
    await session.commit()
    with invocation_context(
        task_id=task.id,
        source="studio.canvas",
        canvas_id=12,
        node_id="node-7",
    ):
        span = await ModelInvocationSpan(
            plugin_id="openai",
            operation="chat.complete",
            model="explain-standard",
            capability="explain-standard",
            request={"messages": [{"role": "user", "content": "hello"}]},
        ).start()
        await span.succeed(
            model="deepseek-chat",
            response={"text": "你好"},
            usage={"input_tokens": 5, "output_tokens": 2},
            provider_request_id="req-1",
        )

    response = await client.get("/config/model-invocations?plugin_id=openai")
    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["status"] == "succeeded"
    assert item["plugin_version"] == "1.0.0"
    assert item["plugin_generation"] is not None
    assert item["task_id"] == task.id
    assert item["source"] == "studio.canvas"
    assert item["canvas_id"] == 12
    assert item["node_id"] == "node-7"
    assert item["context"] is None
    assert item["provider_request_id"] == "req-1"
    assert item["usage"] == {"input_tokens": 5, "output_tokens": 2}


async def _seed_direct_chat(session) -> ModelDeployment:
    credential = ProviderCredential(
        name="OpenAI 兼容直连",
        kind="llm",
        provider_type="openai_compatible",
        config={"api_base": "https://direct.example/v1", "api_key": "sk-direct-test"},
    )
    session.add(credential)
    await session.flush()
    deployment = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id="direct-chat-model",
        adapter_type="openai",
        media_types=["chat"],
    )
    session.add(deployment)
    await session.flush()
    session.add(
        CapabilityBinding(
            capability="explain-standard",
            credential_id=credential.id,
            deployment_id=deployment.id,
            target=deployment.upstream_model_id,
        )
    )
    await session.commit()
    return deployment


async def test_chat_route_freezes_bound_direct_deployment(session) -> None:
    deployment = await _seed_direct_chat(session)
    route = await prepare_chat_route("explain-standard", "chat.complete")

    assert route.snapshot.deployment_id == deployment.id
    assert route.snapshot.plugin_id == "openai"
    assert route.snapshot.model == "direct-chat-model"
    assert route.snapshot.base_url == "https://direct.example/v1"
    assert route.snapshot.selection_source == "binding"
    assert route.snapshot.view()["upstream_model_id"] == "direct-chat-model"
    assert "sk-direct-test" not in repr(route.secrets)
    assert "api_key" not in route.snapshot.view()


async def _seed_gateway_chat(session) -> ModelDeployment:
    """库里遗留的 litellm 部署：网关退役前建的行，迁移之后一律停用，这里保留一条模拟漏网的。"""
    credential = ProviderCredential(
        name="DeepSeek 经网关",
        kind="llm",
        provider_type="deepseek",
        config={"api_key": "sk-gateway-test"},
    )
    session.add(credential)
    await session.flush()
    deployment = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id="deepseek-chat",
        adapter_type="litellm",
        media_types=["chat"],
    )
    session.add(deployment)
    await session.flush()
    session.add(
        CapabilityBinding(
            capability="explain-standard",
            credential_id=credential.id,
            deployment_id=deployment.id,
            target=deployment.upstream_model_id,
        )
    )
    await session.commit()
    return deployment


async def test_chat_route_refuses_the_retired_gateway_adapter(session) -> None:
    """Chat 侧的网关适配器已删：遗留的 litellm 部署当场报错，不再静悄悄发到 :4000。

    报错要指向"这条部署没法执行 chat"，而不是等到真发请求时收一个连接被拒。
    """
    deployment = await _seed_gateway_chat(session)

    with pytest.raises(model_runtime.ModelRuntimeError, match="litellm"):
        await prepare_chat_route("explain-standard", "chat.complete")
    with pytest.raises(model_runtime.ModelRuntimeError, match="litellm"):
        await prepare_chat_route(
            "explain-standard",
            "chat.complete",
            deployment_id=deployment.id,
        )


async def test_unbound_capability_refuses_instead_of_falling_back() -> None:
    """没有部署行时报的是「未绑定」，不是一个连接被拒。"""
    with pytest.raises(model_runtime.ModelRuntimeError, match="尚未绑定模型"):
        await prepare_chat_route("explain-standard", "chat.complete")


def test_image_route_always_sends_the_upstream_model_name() -> None:
    """图片路由只发上游真名；没绑定报「未绑定」，adapter 没插件当场报错。"""
    with pytest.raises(ImageGenError, match="尚未绑定模型"):
        prepare_image_route("image-cover", "image.generate", None)

    stale_route = ResolvedModelRoute(
        deployment_id=77,
        adapter_type="litellm",  # 库里遗留的退役网关部署
        upstream_model_id="gpt-image-2",
        provider_type="deepseek",
        credential_config={"api_key": "sk-image-legacy"},
        protocol_options={},
    )
    with pytest.raises(ImageGenError, match="litellm"):
        prepare_image_route("image-cover", "image.generate", stale_route)

    direct_route = ResolvedModelRoute(
        deployment_id=78,
        adapter_type="openai",
        upstream_model_id="gpt-image-1",
        provider_type="openai_compatible",
        credential_config={"api_base": "https://direct.example/v1", "api_key": "sk-direct"},
        protocol_options={},
    )
    direct = prepare_image_route("image-cover", "image.generate", direct_route)
    assert direct.snapshot.plugin_id == "openai"
    assert direct.snapshot.deployment_id == 78
    assert direct.snapshot.model == "gpt-image-1"
    assert direct.snapshot.view()["upstream_model_id"] == "gpt-image-1"


async def test_repair_agent_logs_every_pydantic_model_request(client, session, monkeypatch) -> None:
    deployment = await _seed_direct_chat(session)
    route = await prepare_chat_route("explain-standard", "chat.complete")

    async def fake_request(self, messages, model_settings, model_request_parameters):
        return ModelResponse(
            parts=[TextPart("checked")],
            usage=RequestUsage(input_tokens=7, output_tokens=2),
            model_name="direct-chat-model",
            provider_response_id="repair-req-1",
        )

    monkeypatch.setattr(OpenAIChatModel, "request", fake_request)
    model = LoggedRepairModel("explain-standard", route)
    async with model:
        response = await model.request(
            [ModelRequest(parts=[UserPromptPart("inspect")])],
            None,
            ModelRequestParameters(),
        )
    assert response.text == "checked"

    items = (await client.get("/config/model-invocations?plugin_id=openai&limit=10")).json()[
        "items"
    ]
    invocation = next(item for item in items if item["deployment_id"] == deployment.id)
    assert invocation["status"] == "succeeded"
    assert invocation["response"]["text"] == "checked"
    assert invocation["usage"]["input_tokens"] == 7
    assert invocation["provider_request_id"] == "repair-req-1"


async def test_repair_session_persists_explicit_chat_deployment(client, session) -> None:
    deployment = await _seed_direct_chat(session)
    video = Video(title="repair target")
    session.add(video)
    await session.commit()

    response = await client.post(
        "/repair/sessions",
        json={
            "video_id": video.id,
            "model_alias": "repair-agent",
            "model_deployment_id": deployment.id,
        },
    )
    assert response.status_code == 201
    payload = response.json()
    assert payload["model_alias"] == "repair-agent"
    assert payload["model_deployment_id"] == deployment.id


async def test_tts_request_uses_explicit_audio_deployment(
    client, session, monkeypatch, tmp_path
) -> None:
    credential = ProviderCredential(
        name="Edge speech",
        kind="tts",
        provider_type="edge_tts",
        config={},
    )
    session.add(credential)
    await session.flush()
    deployment = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id="en-US-AriaNeural",
        adapter_type="edge-tts",
        media_types=["audio"],
    )
    session.add(deployment)
    await session.commit()
    audio = tmp_path / "speech.mp3"
    calls: list[dict] = []

    class FakeCommunicate:
        def __init__(self, text, voice, rate, proxy):
            assert proxy == ""
            calls.append({"text": text, "voice_id": voice, "rate": rate})

        async def stream(self):
            yield {"type": "audio", "data": b"fake-mp3"}

    monkeypatch.setattr("domain.audio_runtime.edge_tts.Communicate", FakeCommunicate)
    monkeypatch.setattr(tts_router, "_cache_path", lambda *_args: audio)
    response = await client.get(
        "/tts",
        params={"text": "hello", "deployment_id": deployment.id},
    )
    assert response.status_code == 200
    assert response.content == b"fake-mp3"
    assert calls[0]["voice_id"] == "en-US-AriaNeural"
    items = (await client.get("/config/model-invocations?plugin_id=edge-tts&limit=10")).json()[
        "items"
    ]
    invocation = next(item for item in items if item["deployment_id"] == deployment.id)
    assert invocation["runtime_generation"] is not None
    assert invocation["request"]["route"]["model"] == "en-US-AriaNeural"


async def test_volc_tts_request_dispatches_through_frozen_audio_provider(
    client, session, monkeypatch, tmp_path
) -> None:
    credential = ProviderCredential(
        name="Volc speech",
        kind="tts",
        provider_type="volc_speech",
        config={"app_id": "test-app", "access_key": "test-key"},
    )
    session.add(credential)
    await session.flush()
    deployment = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id="en_female_skye_uranus_bigtts",
        adapter_type="volcengine",
        media_types=["audio"],
    )
    session.add(deployment)
    await session.commit()
    calls: list[dict] = []

    async def fake_stream(text, voice, rate, **kwargs):
        calls.append({"text": text, "voice": voice, "rate": rate, **kwargs})
        yield b"first"
        yield b"second"

    monkeypatch.setattr("domain.audio_runtime.stream_synthesize", fake_stream)
    monkeypatch.setattr(tts_router, "_cache_path", lambda *_args: tmp_path / "volc.mp3")
    response = await client.get(
        "/tts",
        params={"text": "hello", "deployment_id": deployment.id},
    )
    assert response.status_code == 200
    assert response.content == b"firstsecond"
    assert response.headers["x-tts-provider"] == "volc"
    assert calls[0]["plugin_version"] is not None
    assert calls[0]["plugin_generation"] is not None
    assert calls[0]["runtime_generation"] is not None
    assert calls[0]["route_view"]["plugin_id"] == "volcengine"


async def test_realtime_session_persists_explicit_audio_deployment(client, session) -> None:
    credential = ProviderCredential(
        name="Volc realtime",
        kind="realtime",
        provider_type="volc_realtime",
        config={"app_id": "test-app", "access_key": "test-key"},
    )
    session.add(credential)
    await session.flush()
    deployment = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id="en_female_skye_uranus_bigtts",
        adapter_type="volcengine",
        media_types=["audio"],
    )
    session.add(deployment)
    await session.commit()

    response = await client.post(
        "/talk/realtime/sessions",
        json={"difficulty": "medium", "deployment_id": deployment.id},
    )
    assert response.status_code == 201
    payload = response.json()
    assert payload["deployment_id"] == deployment.id


async def test_local_asr_call_is_logged(client, monkeypatch, tmp_path) -> None:
    audio = tmp_path / "turn.wav"
    audio.write_bytes(b"wave")
    monkeypatch.setattr(transcribe, "transcribe_audio", lambda path, model: "hello")

    text = await transcribe.transcribe_audio_logged(
        str(audio),
        "small.en",
        capability="talk.turn.asr",
    )
    assert text == "hello"
    items = (
        await client.get("/config/model-invocations?plugin_id=faster-whisper&limit=10")
    ).json()["items"]
    invocation = items[0]
    assert invocation["operation"] == "asr.transcribe"
    assert invocation["status"] == "succeeded"
    assert invocation["request"]["audio_bytes"] == 4
    assert invocation["response"]["text"] == "hello"


async def test_complete_json_uses_direct_route_and_logs_it(client, session, monkeypatch) -> None:
    deployment = await _seed_direct_chat(session)
    clients: list[dict] = []
    calls: list[dict] = []

    class FakeClient:
        def __init__(self, **kwargs):
            clients.append(kwargs)
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

        async def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                id="req-direct",
                model="direct-chat-model-2026",
                usage=None,
                choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok": true}'))],
            )

        async def close(self):
            return None

    monkeypatch.setattr(model_runtime, "AsyncOpenAI", FakeClient)
    result, model, _latency = await llm.complete_json(
        "explain-standard",
        "system",
        "user",
        deployment_id=deployment.id,
    )

    assert result == {"ok": True}
    assert model == "direct-chat-model-2026"
    assert clients[0]["base_url"] == "https://direct.example/v1"
    assert clients[0]["api_key"] == "sk-direct-test"
    assert calls[0]["model"] == "direct-chat-model"

    response = await client.get("/config/model-invocations?plugin_id=openai")
    item = response.json()["items"][0]
    assert item["deployment_id"] == deployment.id
    assert item["provider_request_id"] == "req-direct"
    assert item["request"]["route"]["selection_source"] == "explicit"
    assert "sk-direct-test" not in str(item)

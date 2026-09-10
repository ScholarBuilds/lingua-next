"""泛型 CapabilitySeam 与四条新 seam（ASR / 实时语音 / 音素 / Midjourney）。

Provider 替身模式沿用 test_plugin_runtime：注册→准备→替换→卸载恢复，准备好的路由
冻结当时的 Provider 实例与代际；台账身份（plugin_version / generation）由 seam 写入。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

import domain.transcribe as transcribe
from domain import midjourney
from domain.credentials import CredentialError
from domain.kernel.capability_seam import (
    CapabilitySeam,
    RouteRequest,
    RouteSnapshot,
    SeamError,
)
from domain.midjourney import (
    MidjourneyError,
    MidjourneyHandle,
    MidjourneyOutput,
    PreparedMidjourneyRoute,
    register_midjourney_route_provider,
)
from domain.model_catalog import ResolvedModelRoute
from domain.model_plugins import (
    adapter_for_provider,
    get_model_plugin,
    list_model_plugins,
    register_model_plugin,
    wired_operations,
)
from domain.models import ModelDeployment, ProviderCredential
from domain.plugin_runtime import PluginRegistryError
from domain.subtitles import Cue
from domain.transcribe import (
    AsrTranscript,
    PreparedAsrRoute,
    asr_runtime,
    prepare_local_asr_route,
    register_asr_route_provider,
)
from domain.volc_realtime import (
    PreparedRealtimeRoute,
    VolcRealtimeClient,
    prepare_realtime_route,
    realtime_runtime,
    register_realtime_route_provider,
    resolve_realtime_route,
)


class _EchoProvider:
    def __init__(self, name: str) -> None:
        self.name = name

    async def run(self, route: Any, payload: Any) -> dict[str, Any]:
        return {
            "provider": self.name,
            "payload": payload,
            "api_key": route.credentials.get("api_key"),
        }


@pytest.fixture
def example_plugin():
    handle = register_model_plugin(
        plugin_id="example-seam",
        name="Example Seam",
        media_types={"audio"},
        operations={"example.run", "example.other"},
        provider_types={"example_seam"},
    )
    try:
        yield
    finally:
        handle.dispose()


def _request(**overrides: Any) -> RouteRequest:
    base: dict[str, Any] = {
        "capability": "example-cap",
        "plugin_id": "example-seam",
        "provider_type": "example_seam",
        "model": "example-model",
    }
    base.update(overrides)
    return RouteRequest(**base)


# ─────────────── 泛型 seam ───────────────


async def test_seam_registration_is_reversible_and_prepared_route_is_frozen(
    example_plugin,
) -> None:
    seam: CapabilitySeam[RouteRequest, RouteSnapshot, _EchoProvider] = CapabilitySeam(
        "test-seam-generic", label="示例"
    )
    first = seam.register(
        plugin_id="example-seam", provider=_EchoProvider("first"), operations={"example.run"}
    )
    credentials = {"api_key": "sk-seam", "nested": {"values": ["first"]}}
    options = {"format": {"names": ["mp3"]}}
    request = _request(credentials=credentials, protocol_options=options, deployment_id=7)
    second = None
    try:
        with pytest.raises(PluginRegistryError, match="已注册"):
            seam.register(
                plugin_id="example-seam",
                provider=_EchoProvider("dup"),
                operations={"example.run"},
            )
        prepared = seam.prepare(request, "Example.Run")
        assert prepared.snapshot.operation == "example.run"
        assert prepared.snapshot.plugin_id == "example-seam"
        assert prepared.snapshot.deployment_id == 7
        assert prepared.snapshot.plugin_version == "1.0.0"
        assert prepared.snapshot.plugin_generation > 0
        first_generation = prepared.snapshot.runtime_generation
        assert "sk-seam" not in repr(prepared)
        assert "sk-seam" not in repr(prepared.snapshot.view())
        # 准备后再改原始 dict 不影响冻结的副本，冻结副本本身也不可写
        credentials["nested"]["values"].append("later")
        options["format"]["names"].append("wav")
        assert prepared.credentials["nested"] == {"values": ["first"]}
        assert prepared.protocol_options == {"format": {"names": ["mp3"]}}
        with pytest.raises(TypeError):
            prepared.credentials["api_key"] = "x"  # type: ignore[index]
        assert (await prepared.provider.run(prepared, 1))["provider"] == "first"

        second = seam.register(
            plugin_id="example-seam",
            provider=_EchoProvider("second"),
            operations={"example.run"},
            replace=True,
        )
        replacement = seam.prepare(request, "example.run")
        assert replacement.snapshot.runtime_generation > first_generation
        assert (await replacement.provider.run(replacement, 2))["provider"] == "second"
        assert (await prepared.provider.run(prepared, 3))["provider"] == "first"
        assert seam.provider_operations() == {"example-seam": frozenset({"example.run"})}
        assert seam.views("example") == {
            "example-seam": {
                "example_provider_operations": ["example.run"],
                "example_runtime_generation": replacement.snapshot.runtime_generation,
            }
        }
        assert seam.generation("example-seam") == replacement.snapshot.runtime_generation

        second.dispose()
        restored = seam.prepare(request, "example.run")
        assert restored.snapshot.runtime_generation == first_generation
        assert (await restored.provider.run(restored, 4))["provider"] == "first"
    finally:
        if second is not None:
            second.dispose()
        first.dispose()
    with pytest.raises(SeamError) as excinfo:
        seam.prepare(request, "example.run")
    assert excinfo.value.kind == "binding"
    assert excinfo.value.retryable is False
    assert seam.provider_operations() == {}
    assert seam.generation("example-seam") is None


def test_seam_register_guards_against_undeclared_operations(example_plugin) -> None:
    seam: CapabilitySeam[RouteRequest, RouteSnapshot, _EchoProvider] = CapabilitySeam(
        "test-seam-guard", label="示例"
    )
    with pytest.raises(PluginRegistryError, match="至少要声明一个操作"):
        seam.register(plugin_id="example-seam", provider=_EchoProvider("x"), operations={" "})
    with pytest.raises(PluginRegistryError, match="声明的 operations"):
        seam.register(
            plugin_id="example-seam",
            provider=_EchoProvider("x"),
            operations={"example.run", "example.missing"},
        )
    with pytest.raises(PluginRegistryError, match="插件未注册"):
        seam.register(
            plugin_id="no-such-plugin", provider=_EchoProvider("x"), operations={"example.run"}
        )
    with pytest.raises(PluginRegistryError, match="label"):
        CapabilitySeam("test-seam-blank", label=" ")


def test_seam_prepare_reports_plugin_operation_and_provider_gaps(example_plugin) -> None:
    seam: CapabilitySeam[RouteRequest, RouteSnapshot, _EchoProvider] = CapabilitySeam(
        "test-seam-prepare", label="示例"
    )
    with pytest.raises(SeamError, match="模型插件不存在"):
        seam.prepare(_request(plugin_id="ghost"), "example.run")
    with pytest.raises(SeamError, match="未声明操作"):
        seam.prepare(_request(), "example.unknown")
    with pytest.raises(SeamError, match="尚未接入执行"):
        seam.prepare(_request(), "example.run")
    handle = seam.register(
        plugin_id="example-seam", provider=_EchoProvider("x"), operations={"example.run"}
    )
    try:
        # 声明过但没有 Provider 接线的操作同样不可用
        with pytest.raises(SeamError, match="尚未接入执行"):
            seam.prepare(_request(), "example.other")
    finally:
        handle.dispose()


async def test_route_span_template_records_success_failure_and_cancellation(
    client, example_plugin
) -> None:
    seam: CapabilitySeam[RouteRequest, RouteSnapshot, _EchoProvider] = CapabilitySeam(
        "test-seam-span", label="示例"
    )
    handle = seam.register(
        plugin_id="example-seam", provider=_EchoProvider("x"), operations={"example.run"}
    )
    try:
        route = seam.prepare(
            _request(credentials={"api_key": "sk-seam"}, deployment_id=11), "example.run"
        )
        async with route.span(request={"text": "hi", "api_key": "sk-seam"}) as span:
            span.finish(response={"ok": True}, provider_request_id="req-1")
        with pytest.raises(RuntimeError):
            async with route.span(request={"text": "boom"}):
                raise RuntimeError("upstream down")
        with pytest.raises(asyncio.CancelledError):
            async with route.span(request={"text": "cancel"}):
                raise asyncio.CancelledError()
        # finish 之后再抛也算失败：暂存的结果不会被写成成功
        with pytest.raises(ValueError):
            async with route.span(request={"text": "late"}) as span:
                span.finish(response={"ok": True})
                raise ValueError("late failure")
        # 未 finish 正常退出按成功记，response 为空
        async with route.span(
            request={"text": "bare"}, model="override", operation="example.other"
        ):
            pass
    finally:
        handle.dispose()

    items = (
        await client.get("/config/model-invocations?plugin_id=example-seam&limit=10")
    ).json()["items"]
    by_text = {item["request"]["text"]: item for item in items}
    ok = by_text["hi"]
    assert ok["status"] == "succeeded"
    assert ok["response"] == {"ok": True}
    assert ok["operation"] == "example.run"
    assert ok["capability"] == "example-cap"
    assert ok["deployment_id"] == 11
    assert ok["model"] == "example-model"
    assert ok["plugin_version"] == "1.0.0"
    assert ok["plugin_generation"] == route.snapshot.plugin_generation
    assert ok["runtime_generation"] == route.snapshot.runtime_generation
    assert ok["provider_request_id"] == "req-1"
    assert "sk-seam" not in json.dumps(ok)
    assert by_text["boom"]["status"] == "failed"
    assert by_text["boom"]["error_type"] == "RuntimeError"
    assert by_text["cancel"]["status"] == "cancelled"
    assert by_text["late"]["status"] == "failed"
    assert by_text["late"]["error_type"] == "ValueError"
    assert by_text["bare"]["status"] == "succeeded"
    assert by_text["bare"]["response"] is None
    assert by_text["bare"]["model"] == "override"
    assert by_text["bare"]["operation"] == "example.other"


# ─────────────── ready_operations 由注册表推导 ───────────────


def test_ready_operations_are_derived_from_seam_registries(example_plugin) -> None:
    plugin = get_model_plugin("example-seam")
    assert plugin.supports("example.run")
    assert plugin.ready_operations == plugin.operations  # 旧 seam 注册守卫读的上限
    assert not plugin.is_ready("example.run")
    assert plugin.wired_operations() == frozenset()
    # 没有插件接线这条操作时走缺省 adapter；缺省已从网关改成 OpenAI 兼容直连
    assert adapter_for_provider("example_seam", operation="example.run") == "openai"

    seam: CapabilitySeam[RouteRequest, RouteSnapshot, _EchoProvider] = CapabilitySeam(
        "test-seam-ready", label="示例", ready_source="test-ready"
    )
    handle = seam.register(
        plugin_id="example-seam", provider=_EchoProvider("x"), operations={"example.run"}
    )
    try:
        assert plugin.is_ready("example.run")
        assert not plugin.is_ready("example.other")
        assert plugin.wired_operations() == frozenset({"example.run"})
        assert adapter_for_provider("example_seam", operation="example.run") == "example-seam"
        view = next(item for item in list_model_plugins() if item["id"] == "example-seam")
        assert view["operations"] == ["example.other", "example.run"]
        assert view["ready_operations"] == ["example.run"]
        assert view["ready_media_types"] == ["example"]
        handle.dispose()
        assert not plugin.is_ready("example.run")
        seam.detach_ready_source()
    finally:
        handle.dispose()
        seam.detach_ready_source()


async def test_model_plugin_catalog_ready_operations_match_mounted_providers(client) -> None:
    response = await client.get("/config/model-plugins")
    assert response.status_code == 200
    new_seams = (asr_runtime, realtime_runtime, midjourney.midjourney_runtime)
    legacy_keys = (
        "chat_provider_operations",
        "image_provider_operations",
        "video_provider_operations",
        "audio_provider_operations",
        "workflow_provider_operations",
    )
    for item in response.json():
        mounted: set[str] = set()
        for key in legacy_keys:
            mounted.update(item[key])
        for seam in new_seams:
            mounted.update(seam.provider_operations().get(item["id"], frozenset()))
        declared = set(item["operations"])
        assert set(item["ready_operations"]) == mounted & declared, item["id"]
        assert set(item["ready_operations"]) == wired_operations(item["id"]) & declared
        assert set(item["ready_operations"]) <= declared
    by_id = {item["id"]: item for item in response.json()}
    assert by_id["faster-whisper"]["ready_operations"] == ["asr.transcribe"]
    assert by_id["volc-asr"]["ready_operations"] == ["asr.transcribe"]
    assert "realtime.session" in by_id["volcengine"]["ready_operations"]
    assert {"midjourney.imagine", "midjourney.poll", "midjourney.modal", "image.generate"} <= set(
        by_id["apimart"]["ready_operations"]
    )
    # 手写声明删掉后仍成立：gemini 的 chat 没有 Provider，就不是 ready
    assert by_id["gemini"]["ready_operations"] == ["image.edit", "image.generate"]
    assert "chat.stream" in by_id["gemini"]["operations"]


# ─────────────── ASR seam ───────────────


async def test_asr_route_logs_seam_identity_for_text_and_word_timestamps(
    client, monkeypatch, tmp_path
) -> None:
    audio = tmp_path / "turn.wav"
    audio.write_bytes(b"wave")
    progress: list[int] = []
    monkeypatch.setattr(transcribe, "transcribe_audio", lambda path, model: "hello world")

    def fake_cues(
        media_path: str, model_name: str, on_progress: Callable[[int], None] | None
    ) -> tuple[list[Cue], float]:
        assert model_name == "small.en"
        if on_progress is not None:
            on_progress(80)
        return (
            [
                Cue(start_ms=0, end_ms=500, text="hello", words=[[0, 500, "hello"]]),
                Cue(start_ms=500, end_ms=900, text="world", words=[[500, 900, "world"]]),
            ],
            1.25,
        )

    monkeypatch.setattr(transcribe, "transcribe_cues", fake_cues)

    text = await transcribe.transcribe_audio_logged(
        str(audio), "small.en", capability="talk.turn.asr"
    )
    assert text == "hello world"
    route = prepare_local_asr_route("small.en", capability="video.transcribe")
    assert isinstance(route, PreparedAsrRoute)
    transcript = await route.transcribe(
        path=str(audio), word_timestamps=True, on_progress=progress.append
    )
    assert isinstance(transcript, AsrTranscript)
    assert transcript.text == "hello world"
    assert transcript.duration_s == 1.25
    assert [cue.text for cue in transcript.cues] == ["hello", "world"]
    assert progress == [80]

    items = (
        await client.get("/config/model-invocations?plugin_id=faster-whisper&limit=10")
    ).json()["items"]
    by_capability = {item["capability"]: item for item in items}
    turn = by_capability["talk.turn.asr"]
    assert turn["operation"] == "asr.transcribe"
    assert turn["status"] == "succeeded"
    assert turn["model"] == "small.en"
    assert turn["request"] == {"file_name": "turn.wav", "audio_bytes": 4, "vad_filter": True}
    assert turn["response"] == {"text": "hello world", "character_count": 11}
    assert turn["plugin_version"] == "1.0.0"
    assert turn["plugin_generation"] == route.snapshot.plugin_generation
    assert turn["runtime_generation"] == route.snapshot.runtime_generation
    video = by_capability["video.transcribe"]
    assert video["request"]["word_timestamps"] is True
    assert video["response"] == {"cue_count": 2, "duration_s": 1.25, "word_count": 2}


async def test_asr_provider_replacement_drives_transcribe_audio_logged(client, tmp_path) -> None:
    audio = tmp_path / "turn.wav"
    audio.write_bytes(b"wave")

    class Provider:
        async def transcribe(self, route, *, path, word_timestamps, on_progress):
            assert route.snapshot.model == "tiny"
            async with route.span(request={"file_name": Path(path).name}) as span:
                span.finish(response={"text": "stub"})
            return AsrTranscript(text="stub")

    handle = register_asr_route_provider(
        plugin_id="faster-whisper", provider=Provider(), replace=True
    )
    try:
        assert await transcribe.transcribe_audio_logged(str(audio), "tiny") == "stub"
        replaced_generation = asr_runtime.generation("faster-whisper")
    finally:
        handle.dispose()
    assert asr_runtime.generation("faster-whisper") != replaced_generation
    items = (
        await client.get("/config/model-invocations?plugin_id=faster-whisper&limit=10")
    ).json()["items"]
    assert items[0]["response"] == {"text": "stub"}
    assert items[0]["runtime_generation"] == replaced_generation
    assert items[0]["capability"] == "asr"


# ─────────────── 实时语音 seam ───────────────


async def _volc_deployment(session, *, provider_type: str = "volc_realtime") -> ModelDeployment:
    credential = ProviderCredential(
        name=f"Volc {provider_type}",
        kind="realtime",
        provider_type=provider_type,
        config={"app_id": "app-1", "access_key": "ak-secret"},
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
    return deployment


async def test_realtime_route_freezes_volc_client_and_rejects_other_plugins(session) -> None:
    deployment = await _volc_deployment(session)
    route = await resolve_realtime_route(session, deployment.id)
    assert isinstance(route, PreparedRealtimeRoute)
    assert route.snapshot.plugin_id == "volcengine"
    assert route.snapshot.operation == "realtime.session"
    assert route.snapshot.deployment_id == deployment.id
    assert route.snapshot.model == "en_female_skye_uranus_bigtts"
    assert "ak-secret" not in repr(route)
    client = route.open_client()
    assert isinstance(client, VolcRealtimeClient)
    assert client.app_id == "app-1"
    assert client.access_key == "ak-secret"

    span = route.new_span(model="volc-realtime-dialogue", request={"difficulty": "easy"})
    assert span._row.plugin_id == "volcengine"
    assert span._row.runtime_generation == route.snapshot.runtime_generation
    assert span._row.deployment_id == deployment.id

    other = ProviderCredential(
        name="OpenAI", kind="llm", provider_type="openai", config={"api_key": "sk"}
    )
    session.add(other)
    await session.flush()
    chat = ModelDeployment(
        credential_id=other.id,
        upstream_model_id="gpt",
        adapter_type="openai",
        media_types=["chat"],
    )
    session.add(chat)
    await session.commit()
    with pytest.raises(CredentialError, match="实时语音插件未接入"):
        await resolve_realtime_route(session, chat.id)

    # 直接经 seam 准备：声明了 realtime.session 但不是火山凭据类型的插件没有 Provider
    with pytest.raises(SeamError, match="尚未接入执行"):
        prepare_realtime_route(
            RouteRequest(
                capability="realtime-voice",
                plugin_id="openai",
                provider_type="openai",
                model="gpt",
            ),
            "chat.complete",
        )


async def test_realtime_provider_replacement_is_used_by_route(session) -> None:
    deployment = await _volc_deployment(session, provider_type="volc_speech")
    opened: list[dict[str, Any]] = []

    class FakeClient:
        session_id = "fake-session"

        async def connect(self, timeout: float = 15.0) -> None: ...

        async def start_session(self, config: dict, timeout: float = 15.0) -> None: ...

        async def say_hello(self, content: str) -> None: ...

        async def chat_text_query(self, content: str) -> None: ...

        async def send_audio(self, chunk: bytes) -> None: ...

        async def receive(self, timeout: float | None = None):
            return None

        async def finish(self) -> None: ...

        async def close(self) -> None: ...

    class Provider:
        def open_client(self, route):
            opened.append(dict(route.credentials))
            return FakeClient()

    before = await resolve_realtime_route(session, deployment.id)
    handle = register_realtime_route_provider(
        plugin_id="volcengine", provider=Provider(), replace=True
    )
    try:
        route = await resolve_realtime_route(session, deployment.id)
        assert route.snapshot.runtime_generation > before.snapshot.runtime_generation
        assert isinstance(route.open_client(), FakeClient)
        assert opened == [{"app_id": "app-1", "access_key": "ak-secret"}]
        # 替换前准备好的路由仍用当时的 Provider
        assert isinstance(before.open_client(), VolcRealtimeClient)
    finally:
        handle.dispose()
    restored = await resolve_realtime_route(session, deployment.id)
    assert restored.snapshot.runtime_generation == before.snapshot.runtime_generation
    assert isinstance(restored.open_client(), VolcRealtimeClient)


async def test_realtime_session_api_rejects_non_volc_deployment(client, session) -> None:
    credential = ProviderCredential(
        name="OpenAI", kind="llm", provider_type="openai", config={"api_key": "sk"}
    )
    session.add(credential)
    await session.flush()
    deployment = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id="gpt",
        adapter_type="openai",
        media_types=["chat"],
    )
    session.add(deployment)
    await session.commit()
    response = await client.post(
        "/talk/realtime/sessions",
        json={"difficulty": "medium", "deployment_id": deployment.id},
    )
    assert response.status_code == 503
    assert "实时语音插件未接入" in response.json()["detail"]


# ─────────────── Midjourney seam ───────────────


def _midjourney_route(adapter_type: str = "apimart") -> ResolvedModelRoute:
    return ResolvedModelRoute(
        deployment_id=17,
        adapter_type=adapter_type,
        upstream_model_id="midjourney",
        provider_type="apimart",
        credential_config={
            "api_base": "https://api.apimart.ai/v1",
            "api_key": "apimart-secret",
        },
        protocol_options={},
    )


async def test_midjourney_flow_logs_seam_identity(client, session) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.apimart.ai":
            assert request.headers["authorization"] == "Bearer apimart-secret"
        if request.method == "POST":
            return httpx.Response(200, json={"data": [{"task_id": "mj-9"}]})
        if request.url.path == "/v1/midjourney/mj-9":
            return httpx.Response(
                200,
                json={
                    "id": "mj-9",
                    "status": "SUCCESS",
                    "image_urls": ["https://cdn.example/a.png"],
                },
            )
        if request.url.host == "cdn.example":
            return httpx.Response(200, content=b"png")
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        handle = await midjourney.submit_generate(
            session,
            route=_midjourney_route(),
            mode="imagine",
            prompt="paper city",
            size="1:1",
            version="7",
            speed="fast",
            reference_asset_ids=[],
            client=http,
        )
        assert isinstance(handle, MidjourneyHandle)
        assert handle.plugin_id == "apimart"
        assert handle.provider_type == "apimart"
        assert handle.deployment_id == 17
        output = await midjourney.wait_for_output(handle, client=http, poll_interval_s=0)
        assert output.images == [b"png"]

    items = (await client.get("/config/model-invocations?plugin_id=apimart&limit=10")).json()[
        "items"
    ]
    by_operation = {item["operation"]: item for item in items}
    assert set(by_operation) == {"midjourney.imagine", "midjourney.poll"}
    for item in by_operation.values():
        assert item["status"] == "succeeded"
        assert item["capability"] == "midjourney"
        assert item["deployment_id"] == 17
        assert item["model"] == "midjourney"
        assert item["plugin_version"] == "1.0.0"
        assert item["runtime_generation"] == midjourney.midjourney_runtime.generation("apimart")
        assert item["provider_request_id"] == "mj-9"
        assert "apimart-secret" not in json.dumps(item)


async def test_midjourney_replacement_provider_and_binding_errors(session) -> None:
    calls: list[str] = []

    class Provider:
        async def submit_generate(self, route, session, **kwargs):
            assert isinstance(route, PreparedMidjourneyRoute)
            calls.append(route.snapshot.operation)
            return MidjourneyHandle(
                provider_task_id="fake-1",
                base_url="https://fake",
                credential_config=dict(route.credentials),
                model=route.snapshot.model,
                deployment_id=route.snapshot.deployment_id or 0,
                action=kwargs["mode"],
                prompt=kwargs["prompt"],
            )

        async def submit_action(self, route, session, **kwargs):
            calls.append(route.snapshot.operation)
            return MidjourneyHandle(
                provider_task_id="fake-2",
                base_url="https://fake",
                credential_config={},
                model="midjourney",
                deployment_id=17,
                action=kwargs["action"],
                prompt="",
            )

        async def wait_for_output(self, route, handle, **kwargs):
            calls.append(route.snapshot.operation)
            return MidjourneyOutput(
                provider_task_id=handle.provider_task_id,
                status="success",
                action=handle.action,
                prompt=handle.prompt,
                images=[b"x"],
                source_urls=["u"],
                buttons=[],
            )

    handle = register_midjourney_route_provider(
        plugin_id="apimart", provider=Provider(), replace=True
    )
    try:
        submitted = await midjourney.submit_generate(
            session,
            route=_midjourney_route(),
            mode="Imagine",
            prompt=" city ",
            size="",
            version="7",
            speed="fast",
            reference_asset_ids=[],
        )
        assert submitted.provider_task_id == "fake-1"
        assert submitted.prompt == "city"
        acted = await midjourney.submit_action(
            session, route=_midjourney_route(), task_id="fake-1", action="high-variation",
            speed="fast",
        )
        assert acted.provider_task_id == "fake-2"
        output = await midjourney.wait_for_output(submitted)
        assert output.images == [b"x"]
        assert calls == ["midjourney.imagine", "midjourney.high_variation", "midjourney.poll"]
        # 输入校验仍在分发之前
        with pytest.raises(MidjourneyError, match="提示词不能为空"):
            await midjourney.submit_generate(
                session, route=_midjourney_route(), mode="imagine", prompt=" ",
                size="", version="7", speed="fast", reference_asset_ids=[],
            )
    finally:
        handle.dispose()

    # 不是 apimart 插件的路由没有 Midjourney Provider
    with pytest.raises(MidjourneyError) as excinfo:
        await midjourney.submit_generate(
            session, route=_midjourney_route(adapter_type="openai"), mode="imagine",
            prompt="x", size="", version="7", speed="fast", reference_asset_ids=[],
        )
    assert excinfo.value.kind == "binding"
    assert excinfo.value.retryable is False
    resumed = midjourney.resume_handle(
        _midjourney_route(adapter_type="openai"), "mj-1", action="imagine", prompt="x"
    )
    assert resumed.plugin_id == "openai"
    with pytest.raises(MidjourneyError, match="未声明操作 midjourney.poll"):
        await midjourney.wait_for_output(resumed, poll_interval_s=0)

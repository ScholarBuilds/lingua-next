"""OpenAI Videos / 火山 Seedance 协议测试，不调真实付费接口。"""

import inspect
import json

import httpx
import pytest
from sqlalchemy import select

from domain import storage as storage_mod
from domain import video_generation
from domain.model_catalog import ResolvedModelRoute
from domain.models import ModelInvocation, StudioMediaAsset
from domain.storage import LocalStorage
from domain.video_generation import submit, wait_for_output
from tests.test_studio import noise_png, seed_asset


def _route(**overrides) -> ResolvedModelRoute:
    values = {
        "deployment_id": 1,
        "adapter_type": "openai",
        "upstream_model_id": "sora-2",
        "provider_type": "openai_video",
        "credential_config": {
            "api_base": "https://api.openai.com/v1",
            "api_key": "secret",
        },
        "protocol_options": {},
    }
    values.update(overrides)
    return ResolvedModelRoute(**values)


def _install_transport(monkeypatch, handler) -> None:
    real_client = httpx.AsyncClient

    def factory(base_url: str, timeout: float = 180.0):
        return real_client(
            transport=httpx.MockTransport(handler),
            timeout=timeout,
            base_url=base_url,
        )

    monkeypatch.setattr(video_generation, "_client", factory)


def test_video_public_runtime_has_no_static_adapter_dispatch() -> None:
    assert "adapter_type" not in inspect.getsource(video_generation._submit_impl)
    assert "adapter_type" not in inspect.getsource(video_generation.resume_handle)
    assert "protocol ==" not in inspect.getsource(video_generation._wait_for_output_impl)


@pytest.fixture
def video_storage(tmp_path):
    storage = LocalStorage(tmp_path)
    storage_mod.set_storage(storage)
    yield storage
    storage_mod.set_storage(None)


async def test_openai_video_submit_poll_and_content_download(session, monkeypatch) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["authorization"] == "Bearer secret"
        if request.method == "POST" and request.url.path == "/v1/videos":
            assert b"sora-2" in request.content
            assert b"1280x720" in request.content
            return httpx.Response(200, json={"id": "video-1", "status": "queued"})
        if request.url.path == "/v1/videos/video-1":
            return httpx.Response(200, json={"id": "video-1", "status": "completed"})
        if request.url.path == "/v1/videos/video-1/content":
            return httpx.Response(
                200,
                content=b"mp4-bytes",
                headers={"content-type": "video/mp4"},
            )
        return httpx.Response(404)

    _install_transport(monkeypatch, handler)
    handle = await submit(
        session,
        route=_route(),
        prompt="A paper boat",
        duration=4,
        aspect_ratio="16:9",
        resolution="720p",
    )
    assert handle.provider_task_id == "video-1"
    output = await wait_for_output(handle)
    assert output.data == b"mp4-bytes"
    assert output.mime == "video/mp4"
    assert [request.url.path for request in requests] == [
        "/v1/videos",
        "/v1/videos/video-1",
        "/v1/videos/video-1/content",
    ]
    invocations = list(
        (
            await session.execute(select(ModelInvocation).order_by(ModelInvocation.created_at))
        ).scalars()
    )
    assert [item.operation for item in invocations] == [
        "video.generate",
        "video.generate",
    ]
    assert invocations[0].request["phase"] == "submit"
    assert invocations[1].request["phase"] == "wait"
    assert invocations[1].request["provider_task_id"] == "video-1"
    assert invocations[1].request["route"] == invocations[0].request["route"]
    assert invocations[0].runtime_generation is not None
    assert invocations[1].runtime_generation == invocations[0].runtime_generation
    assert all(item.status == "succeeded" for item in invocations)


async def test_volcengine_video_submits_json_and_downloads_url(session, monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            body = json.loads(request.content)
            assert body["model"] == "doubao-seedance-2-0-fast-260128"
            assert body["duration"] == 8
            return httpx.Response(200, json={"id": "seedance-1", "status": "queued"})
        if request.url.path.endswith("/seedance-1"):
            return httpx.Response(
                200,
                json={
                    "id": "seedance-1",
                    "status": "succeeded",
                    "content": {"video_url": "https://cdn.example/seedance.mp4"},
                },
            )
        if request.url.host == "cdn.example":
            return httpx.Response(200, content=b"video", headers={"content-type": "video/mp4"})
        return httpx.Response(404)

    _install_transport(monkeypatch, handler)
    route = _route(
        adapter_type="volcengine",
        upstream_model_id="doubao-seedance-2-0-fast-260128",
        provider_type="volcengine_video",
        credential_config={
            "api_base": "https://ark.cn-beijing.volces.com/api/v3",
            "api_key": "ark-key",
        },
    )
    handle = await submit(
        session,
        route=route,
        prompt="A crane flying",
        duration=8,
        aspect_ratio="16:9",
        resolution="720p",
        options={"generate_audio": True},
    )
    output = await wait_for_output(handle)
    assert output.data == b"video"
    assert output.source_url == "https://cdn.example/seedance.mp4"


async def test_volcengine_video_preserves_multi_reference_roles_and_native_options(
    session, video_storage, monkeypatch
) -> None:
    assets = [await seed_asset(session, video_storage, noise_png()) for _ in range(3)]
    submitted: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        submitted.update(json.loads(request.content))
        return httpx.Response(200, json={"id": "seedance-multi", "status": "queued"})

    _install_transport(monkeypatch, handler)
    route = _route(
        adapter_type="volcengine",
        upstream_model_id="doubao-seedance-2-0-fast-260128",
        provider_type="volcengine_video",
        credential_config={
            "api_base": "https://ark.cn-beijing.volces.com/api/v3",
            "api_key": "ark-key",
        },
    )
    await submit(
        session,
        route=route,
        prompt="Keep the character consistent",
        duration=8,
        aspect_ratio="9:16",
        resolution="1080p",
        references=[
            {"asset_id": assets[0].id, "role": "first_frame"},
            {"asset_id": assets[1].id, "role": "last_frame"},
            {"asset_id": assets[2].id, "role": "reference_image"},
        ],
        options={
            "generate_audio": True,
            "watermark": True,
            "camera_fixed": False,
            "seed": 17,
        },
    )

    assert submitted["ratio"] == "9:16"
    assert submitted["resolution"] == "1080p"
    assert submitted["generate_audio"] is True
    assert submitted["watermark"] is True
    assert submitted["camera_fixed"] is False
    assert submitted["seed"] == 17
    assert [item["role"] for item in submitted["content"][1:]] == [
        "first_frame",
        "last_frame",
        "reference_image",
    ]
    assert all(
        item["image_url"]["url"].startswith("data:image/png;base64,")
        for item in submitted["content"][1:]
    )


async def test_volcengine_video_keeps_managed_video_and_audio_reference_roles(
    session, video_storage, monkeypatch
) -> None:
    video = StudioMediaAsset(
        kind="video",
        name="motion.mp4",
        mime="video/mp4",
        sha256="a" * 64,
        storage_key="media/reference/motion.mp4",
        bytes=100,
        source_url="https://cdn.example/motion.mp4",
    )
    audio = StudioMediaAsset(
        kind="audio",
        name="rhythm.mp3",
        mime="audio/mpeg",
        sha256="b" * 64,
        storage_key="media/reference/rhythm.mp3",
        bytes=100,
        source_url="asset://ark-audio-1",
    )
    session.add_all([video, audio])
    await session.commit()
    submitted: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        submitted.update(json.loads(request.content))
        return httpx.Response(200, json={"id": "seedance-media", "status": "queued"})

    _install_transport(monkeypatch, handler)
    await submit(
        session,
        route=_route(
            adapter_type="volcengine",
            upstream_model_id="doubao-seedance-2-0-fast-260128",
            provider_type="volcengine_video",
            credential_config={
                "api_base": "https://ark.cn-beijing.volces.com/api/v3",
                "api_key": "ark-key",
            },
        ),
        prompt="Follow motion and rhythm",
        duration=8,
        aspect_ratio="16:9",
        resolution="720p",
        media_references=[
            {"media_asset_id": video.id, "kind": "video"},
            {"media_asset_id": audio.id, "kind": "audio"},
        ],
        options={"multimodal": True},
    )

    assert submitted["content"][1:] == [
        {
            "type": "video_url",
            "video_url": {"url": "https://cdn.example/motion.mp4"},
            "role": "reference_video",
        },
        {
            "type": "audio_url",
            "audio_url": {"url": "asset://ark-audio-1"},
            "role": "reference_audio",
        },
    ]


async def test_volcengine_video_falls_back_to_local_frames_and_inline_audio(
    session, video_storage, monkeypatch
) -> None:
    await video_storage.write("media/reference/local.mp4", b"video")
    await video_storage.write("media/reference/local.mp3", b"audio")
    video = StudioMediaAsset(
        kind="video",
        name="local.mp4",
        mime="video/mp4",
        sha256="c" * 64,
        storage_key="media/reference/local.mp4",
        bytes=5,
        duration_ms=2500,
    )
    audio = StudioMediaAsset(
        kind="audio",
        name="local.mp3",
        mime="audio/mpeg",
        sha256="d" * 64,
        storage_key="media/reference/local.mp3",
        bytes=5,
    )
    session.add_all([video, audio])
    await session.commit()
    frame_times: list[float] = []
    submitted: dict = {}

    def fake_frame(_path, at_s: float) -> bytes:
        frame_times.append(at_s)
        return noise_png()

    def handler(request: httpx.Request) -> httpx.Response:
        submitted.update(json.loads(request.content))
        return httpx.Response(200, json={"id": "seedance-local", "status": "queued"})

    monkeypatch.setattr(video_generation.shutil, "which", lambda _name: "/usr/bin/ffmpeg")
    monkeypatch.setattr(video_generation.studio_frames, "_ffmpeg_frame", fake_frame)
    _install_transport(monkeypatch, handler)
    await submit(
        session,
        route=_route(
            adapter_type="volcengine",
            upstream_model_id="doubao-seedance-2-0-fast-260128",
            provider_type="volcengine_video",
            credential_config={
                "api_base": "https://ark.cn-beijing.volces.com/api/v3",
                "api_key": "ark-key",
            },
        ),
        prompt="Use local references",
        duration=8,
        aspect_ratio="16:9",
        resolution="720p",
        media_references=[
            {"media_asset_id": video.id, "kind": "video"},
            {"media_asset_id": audio.id, "kind": "audio"},
        ],
    )

    assert frame_times == [0.0, 1.225, 2.45]
    media_content = submitted["content"][1:]
    assert [item["type"] for item in media_content] == [
        "image_url",
        "image_url",
        "image_url",
        "audio_url",
    ]
    assert all(
        item["image_url"]["url"].startswith("data:image/jpeg;base64,")
        for item in media_content[:3]
    )
    assert media_content[3]["audio_url"]["url"] == "data:audio/mpeg;base64,YXVkaW8="


async def test_video_protocol_rejects_invalid_reference_combinations(
    session, video_storage
) -> None:
    assets = [await seed_asset(session, video_storage, noise_png()) for _ in range(2)]
    volcengine = _route(
        adapter_type="volcengine",
        provider_type="volcengine_video",
        credential_config={
            "api_base": "https://ark.cn-beijing.volces.com/api/v3",
            "api_key": "ark-key",
        },
    )
    with pytest.raises(video_generation.VideoGenerationError, match="固定机位"):
        await submit(
            session,
            route=volcengine,
            prompt="Static shot",
            duration=5,
            aspect_ratio="16:9",
            resolution="720p",
            references=[{"asset_id": assets[0].id, "role": "first_frame"}],
            options={"camera_fixed": True},
        )

    with pytest.raises(video_generation.VideoGenerationError, match="最多只支持 1 张"):
        await submit(
            session,
            route=_route(),
            prompt="Two references",
            duration=4,
            aspect_ratio="16:9",
            resolution="720p",
            references=[
                {"asset_id": assets[0].id, "role": "first_frame"},
                {"asset_id": assets[1].id, "role": "last_frame"},
            ],
        )

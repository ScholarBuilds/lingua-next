from __future__ import annotations

import json

import httpx
import pytest

from domain import image_pipeline, imagegen, modelscope_image
from domain.model_catalog import ResolvedModelRoute
from domain.models import ImageAsset


def route() -> ResolvedModelRoute:
    return ResolvedModelRoute(
        deployment_id=17,
        adapter_type="modelscope",
        upstream_model_id="Tongyi-MAI/Z-Image-Turbo",
        provider_type="modelscope",
        credential_config={"api_key": "ms-secret"},
        protocol_options={},
    )


async def test_modelscope_async_submit_poll_and_download_contract():
    polls = 0
    submitted: dict = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal polls
        if request.url.host == "api-inference.modelscope.cn":
            assert request.headers["authorization"] == "Bearer ms-secret"
        if request.method == "POST":
            assert request.url.path == "/v1/images/generations"
            assert request.headers["x-modelscope-async-mode"] == "true"
            submitted.update(json.loads(request.content))
            return httpx.Response(200, json={"task_id": "task-1"})
        if request.url.path == "/v1/tasks/task-1":
            assert request.headers["x-modelscope-task-type"] == "image_generation"
            polls += 1
            if polls == 1:
                return httpx.Response(200, json={"task_status": "RUNNING"})
            return httpx.Response(
                200,
                json={
                    "task_status": "SUCCEED",
                    "output_images": ["https://cdn.example/result.png"],
                },
            )
        assert request.url == httpx.URL("https://cdn.example/result.png")
        return httpx.Response(200, content=b"png-bytes")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await modelscope_image.generate(
            "A golden cat",
            route=route(),
            size="1024x1024",
            n=1,
            extra={
                "negative_prompt": "text, watermark",
                "seed": 7,
                "steps": 12,
                "guidance": 3.5,
                "image_url": ["data:image/png;base64,AA=="],
                "loras": {"org/style-lora": 0.8},
                "ignored": "must-not-leak",
            },
            client=client,
            poll_interval_s=0,
        )

    assert result.images == [b"png-bytes"]
    assert result.task_ids == ["task-1"]
    assert submitted == {
        "model": "Tongyi-MAI/Z-Image-Turbo",
        "prompt": "A golden cat",
        "size": "1024x1024",
        "negative_prompt": "text, watermark",
        "seed": 7,
        "steps": 12,
        "guidance": 3.5,
        "image_url": ["data:image/png;base64,AA=="],
        "loras": {"org/style-lora": 0.8},
    }


async def test_modelscope_provider_failure_keeps_upstream_detail():
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"task_id": "bad-task"})
        return httpx.Response(
            200,
            json={"task_status": "FAILED", "message": "daily quota exhausted"},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(modelscope_image.ModelScopeImageError) as caught:
            await modelscope_image.generate(
                "cat",
                route=route(),
                size="auto",
                n=1,
                client=client,
                poll_interval_s=0,
            )
    assert caught.value.kind == "provider_failed"
    assert "daily quota exhausted" in str(caught.value)


async def test_imagegen_routes_modelscope_without_openai_sdk(monkeypatch):
    captured: dict = {}

    async def fake_generate(prompt, **kwargs):
        captured.update(prompt=prompt, **kwargs)
        return modelscope_image.ModelScopeImageResult(
            images=[b"one", b"two"], latency_ms=321, task_ids=["a", "b"]
        )

    monkeypatch.setattr(modelscope_image, "generate", fake_generate)
    result = await imagegen._render_images_impl(
        "two cats",
        capability="image-free",
        size="1024x1024",
        n=2,
        extra={"seed": 9},
        route=route(),
    )
    assert result.images == [b"one", b"two"]
    assert result.model_reported == "Tongyi-MAI/Z-Image-Turbo"
    assert result.latency_ms == 321
    assert captured["extra"] == {"seed": 9}


async def test_modelscope_missing_token_fails_before_network():
    broken = ResolvedModelRoute(
        deployment_id=17,
        adapter_type="modelscope",
        upstream_model_id="Tongyi-MAI/Z-Image-Turbo",
        provider_type="modelscope",
        credential_config={},
        protocol_options={},
    )
    with pytest.raises(modelscope_image.ModelScopeImageError) as caught:
        await modelscope_image.generate("cat", route=broken, size="auto", n=1)
    assert caught.value.kind == "auth"


async def test_pipeline_converts_reference_assets_to_native_image_urls(
    session, monkeypatch
):
    asset = ImageAsset(
        sha256="2" * 64,
        storage_key="images/reference.png",
        mime="image/png",
        target_key="free",
        prompt="reference",
    )
    session.add(asset)
    await session.flush()

    class FakeStorage:
        async def read(self, key: str) -> bytes:
            assert key == "images/reference.png"
            return b"raw-reference"

    monkeypatch.setattr(image_pipeline, "get_storage", lambda: FakeStorage())
    monkeypatch.setattr(
        image_pipeline.image_describe,
        "_prepare",
        lambda data, mime: ("image/webp", "ENCODED"),
    )
    options = await image_pipeline._prepare_render_options(
        session,
        {"ref_asset_ids": [asset.id], "seed": 9, "negative_prompt": "text"},
        route(),
    )
    assert options == {
        "seed": 9,
        "negative_prompt": "text",
        "image_url": ["data:image/webp;base64,ENCODED"],
    }


async def test_pipeline_rejects_reference_assets_for_non_modelscope(session):
    openai_route = ResolvedModelRoute(
        deployment_id=18,
        adapter_type="openai",
        upstream_model_id="gpt-image-2",
        provider_type="openai",
        credential_config={"api_key": "secret"},
        protocol_options={},
    )
    with pytest.raises(imagegen.ImageGenError, match="ModelScope adapter") as caught:
        await image_pipeline._prepare_render_options(
            session,
            {"ref_asset_ids": [1]},
            openai_route,
        )
    assert caught.value.kind == "binding"

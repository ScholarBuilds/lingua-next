"""Gemini 原生图片 adapter 的协议级测试（MockTransport，不出网）。"""

import base64
import json

import httpx
import pytest

from domain import gemini_image, imagegen
from domain.gemini_image import (
    GeminiImageError,
    GeminiImageResult,
    generate,
    nearest_aspect_ratio,
)
from domain.imagegen import ImageGenError
from domain.model_catalog import ResolvedModelRoute


def _install_transport(monkeypatch, handler) -> None:
    real_client = httpx.AsyncClient

    def factory(**kwargs):
        return real_client(
            transport=httpx.MockTransport(handler),
            timeout=kwargs.get("timeout"),
        )

    monkeypatch.setattr(gemini_image.httpx, "AsyncClient", factory)


def test_nearest_aspect_ratio_uses_gemini_supported_value() -> None:
    assert nearest_aspect_ratio("1024x1024") == "1:1"
    assert nearest_aspect_ratio("2048x1152") == "16:9"
    # 业务里的 2.5:1 宽幅在 Gemini 公共比例里映射到 21:9。
    assert nearest_aspect_ratio("3840x1536") == "21:9"


async def test_generate_uses_exact_model_and_native_payload(monkeypatch) -> None:
    calls: list[httpx.Request] = []
    image = b"\x89PNG\r\n\x1a\nresult"

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(
            200,
            json={
                "candidates": [{
                    "content": {
                        "parts": [
                            {"text": "rendered"},
                            {"inlineData": {
                                "mimeType": "image/png",
                                "data": base64.b64encode(image).decode(),
                            }},
                        ]
                    }
                }],
                "usageMetadata": {"totalTokenCount": 21},
            },
        )

    _install_transport(monkeypatch, handler)
    result = await generate(
        "draw a fox",
        model="models/gemini-3-pro-image-preview",
        credential_config={
            "api_key": "secret",
            "api_base": "https://generativelanguage.googleapis.com/v1beta",
        },
        protocol_options=None,
        size="2048x1152",
        n=1,
    )

    assert result.images == [image]
    assert result.model_reported == "gemini-3-pro-image-preview"
    assert result.usage == {"totalTokenCount": 21}
    assert result.revised_prompts == ["rendered"]
    assert len(calls) == 1
    request = calls[0]
    assert request.url.path.endswith(
        "/v1beta/models/gemini-3-pro-image-preview:generateContent"
    )
    assert request.headers["x-goog-api-key"] == "secret"
    body = json.loads(request.content)
    assert body["contents"][0]["parts"] == [{"text": "draw a fox"}]
    assert body["generationConfig"] == {
        "responseModalities": ["TEXT", "IMAGE"],
        "imageConfig": {"aspectRatio": "16:9", "imageSize": "2K"},
    }


async def test_edit_embeds_all_reference_images_and_25_omits_image_size(monkeypatch) -> None:
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "candidates": [{
                    "content": {"parts": [{
                        "inline_data": {
                            "mime_type": "image/png",
                            "data": base64.b64encode(b"edited").decode(),
                        }
                    }]}
                }]
            },
        )

    _install_transport(monkeypatch, handler)
    result = await generate(
        "keep the face, change the background",
        model="gemini-2.5-flash-image",
        credential_config={"api_key": "secret"},
        protocol_options=None,
        size="2048x2048",
        n=1,
        images=[("portrait.jpg", b"\xff\xd8\xffone"), ("style.png", b"\x89PNG\r\n\x1a\ntwo")],
    )

    assert result.images == [b"edited"]
    parts = bodies[0]["contents"][0]["parts"]
    assert parts[0]["text"].startswith("keep the face")
    assert [part["inline_data"]["mime_type"] for part in parts[1:]] == [
        "image/jpeg",
        "image/png",
    ]
    assert bodies[0]["generationConfig"]["imageConfig"] == {"aspectRatio": "1:1"}


async def test_multiple_candidates_are_independent_calls_and_usage_is_merged(monkeypatch) -> None:
    count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal count
        count += 1
        return httpx.Response(
            200,
            json={
                "candidates": [{"content": {"parts": [{
                    "inlineData": {"data": base64.b64encode(f"image-{count}".encode()).decode()}
                }]}}],
                "usageMetadata": {"totalTokenCount": 10},
            },
        )

    _install_transport(monkeypatch, handler)
    result = await generate(
        "variations",
        model="gemini-3-pro-image-preview",
        credential_config={"api_key": "secret"},
        protocol_options=None,
        size="1024x1024",
        n=2,
    )
    assert result.images == [b"image-1", b"image-2"]
    assert result.usage == {"totalTokenCount": 20}


async def test_auth_error_is_classified(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "invalid key"}})

    _install_transport(monkeypatch, handler)
    with pytest.raises(GeminiImageError) as caught:
        await generate(
            "x",
            model="gemini-3-pro-image-preview",
            credential_config={"api_key": "bad"},
            protocol_options=None,
            size="1024x1024",
            n=1,
        )
    assert caught.value.kind == "auth"
    assert "401" in str(caught.value)


async def test_imagegen_dispatches_native_gemini_route(monkeypatch) -> None:
    captured: dict = {}

    async def fake_generate(prompt, **kwargs):
        captured.update({"prompt": prompt, **kwargs})
        return GeminiImageResult(
            images=[b"native"],
            model_reported=kwargs["model"],
            usage={"totalTokenCount": 7},
            latency_ms=12,
        )

    monkeypatch.setattr(gemini_image, "generate", fake_generate)
    route = ResolvedModelRoute(
        deployment_id=9,
        adapter_type="gemini",
        upstream_model_id="gemini-3-pro-image-preview",
        provider_type="gemini_image",
        credential_config={"api_key": "secret"},
        protocol_options={"gemini_supports_image_size": True},
    )
    result = await imagegen.render_images(
        "a fox",
        alias="image-free",
        size="2048x1152",
        n=1,
        route=route,
    )
    assert result.images == [b"native"]
    assert captured["model"] == "gemini-3-pro-image-preview"
    assert captured["size"] == "2048x1152"
    assert captured["protocol_options"] == {"gemini_supports_image_size": True}

    with pytest.raises(ImageGenError, match="蒙版") as caught:
        await imagegen.edit_images(
            "replace",
            alias="image-free",
            images=[("one.png", b"one")],
            mask=("mask.png", b"mask"),
            size="1024x1024",
            route=route,
        )
    assert caught.value.kind == "binding"

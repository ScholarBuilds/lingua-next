import base64
import json

import httpx
import pytest

from domain import openai_image_protocols as protocols
from domain.model_catalog import (
    ModelCatalogError,
    ResolvedModelRoute,
    validate_protocol_options,
)

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def route(
    mode: str,
    *,
    adapter: str = "openai",
    options: dict | None = None,
) -> ResolvedModelRoute:
    return ResolvedModelRoute(
        deployment_id=8,
        adapter_type=adapter,
        upstream_model_id="gpt-image-2-2k",
        provider_type="openai_compatible",
        credential_config={"api_base": "https://images.example/v1", "api_key": "secret"},
        protocol_options={
            "image_request_mode": mode,
            "poll_interval": 0.05,
            "initial_poll_delay": 0,
            "task_timeout": 2,
            **(options or {}),
        },
    )


def install_transport(monkeypatch, handler):
    real_client = httpx.AsyncClient

    def factory(**kwargs):
        return real_client(
            transport=httpx.MockTransport(handler),
            timeout=kwargs.get("timeout"),
            follow_redirects=kwargs.get("follow_redirects", False),
        )

    monkeypatch.setattr(protocols.httpx, "AsyncClient", factory)


async def test_openai_json_uses_json_reference_contract(monkeypatch) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={"data": [{"b64_json": base64.b64encode(PNG).decode()}]},
        )

    install_transport(monkeypatch, handler)
    result = await protocols.render(
        route=route("openai-json"),
        prompt="keep the subject",
        size="1024x1536",
        quality="high",
        n=1,
        images=[("reference.png", PNG)],
    )
    assert result.images == [PNG]
    assert requests[0].url.path == "/v1/images/generations"
    body = json.loads(requests[0].content)
    assert body["extra_body"]["response_format"] == "url"
    assert body["extra_body"]["image"][0].startswith("data:image/png;base64,")
    assert "quality" not in body


@pytest.mark.parametrize(
    ("mode", "adapter", "submit_path", "poll_path", "submit_payload"),
    [
        (
            "openai-video-proxy",
            "openai",
            "/v1/videos",
            "/v1/videos/job-1",
            {"id": "job-1", "status": "queued"},
        ),
        (
            "tudou-async",
            "tudou",
            "/v1/images/generations/async",
            "/v1/tasks/job-1",
            {"task_id": "job-1", "status": "pending"},
        ),
        (
            "openai",
            "apimart",
            "/v1/images/generations",
            "/v1/tasks/job-1",
            {"data": {"task_id": "job-1", "status": "processing"}},
        ),
    ],
)
async def test_async_request_modes_submit_and_poll(
    monkeypatch,
    mode: str,
    adapter: str,
    submit_path: str,
    poll_path: str,
    submit_payload: dict,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST":
            return httpx.Response(200, json=submit_payload)
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "images": [{"b64_json": base64.b64encode(PNG).decode()}],
            },
        )

    install_transport(monkeypatch, handler)
    result = await protocols.render(
        route=route(mode, adapter=adapter),
        prompt="a studio portrait",
        size="2048x2048",
        quality="medium",
        n=1,
        images=[],
    )
    assert result.images == [PNG]
    assert [(request.method, request.url.path) for request in requests] == [
        ("POST", submit_path),
        ("GET", poll_path),
    ]
    body = json.loads(requests[0].content)
    if adapter == "tudou":
        assert body["model"] == "gpt-image-2-all"
        assert body["size"] == "2048x2048"
        assert body["resolution"] == "2k"
    if adapter == "apimart":
        assert body["n"] == 1
        assert body["size"] == "1:1"
        assert body["resolution"] == "2k"


async def test_responses_background_poll_extracts_image(monkeypatch) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST":
            body = json.loads(request.content)
            assert body["background"] is True
            assert body["tools"][0]["action"] == "edit"
            assert body["input"][0]["content"][1]["type"] == "input_image"
            return httpx.Response(200, json={"id": "resp-1", "status": "in_progress"})
        return httpx.Response(
            200,
            json={
                "id": "resp-1",
                "status": "completed",
                "output": [
                    {
                        "type": "image_generation_call",
                        "status": "completed",
                        "result": base64.b64encode(PNG).decode(),
                    }
                ],
            },
        )

    install_transport(monkeypatch, handler)
    result = await protocols.render(
        route=route("openai-responses"),
        prompt="change the lighting",
        size="1024x1536",
        quality="high",
        n=1,
        images=[("reference.png", PNG)],
    )
    assert result.images == [PNG]
    assert requests[0].url.path == "/v1/responses"
    assert requests[1].url.path == "/v1/responses/resp-1"


async def test_responses_rejected_background_falls_back_to_sse(monkeypatch) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        body = json.loads(request.content)
        if body.get("background") is True:
            return httpx.Response(400, json={"error": {"message": "unsupported"}})
        assert body["stream"] is True
        event = {
            "type": "response.image_generation_call.partial_image",
            "partial_image_b64": base64.b64encode(PNG).decode(),
        }
        return httpx.Response(
            200,
            content=f"data: {json.dumps(event)}\n\ndata: [DONE]\n\n",
            headers={"content-type": "text/event-stream"},
        )

    install_transport(monkeypatch, handler)
    result = await protocols.render(
        route=route("openai-responses"),
        prompt="a paper sculpture",
        size="1024x1024",
        quality="medium",
        n=1,
        images=[],
    )

    assert result.images == [PNG]
    assert len(requests) == 2


def test_protocol_options_are_typed_and_scan_nested_secrets() -> None:
    assert validate_protocol_options(
        {
            "image_request_mode": "OPENAI-RESPONSES",
            "task_path_template": "/responses/{task_id}",
            "poll_interval": "1.5",
            "initial_poll_delay": 10,
            "task_timeout": 300,
        }
    ) == {
        "image_request_mode": "openai-responses",
        "task_path_template": "/responses/{task_id}",
        "poll_interval": 1.5,
        "initial_poll_delay": 10.0,
        "task_timeout": 300.0,
    }
    with pytest.raises(ModelCatalogError, match="未知图片请求模式"):
        validate_protocol_options({"image_request_mode": "invented"})
    with pytest.raises(ModelCatalogError, match="必须包含"):
        validate_protocol_options({"task_path_template": "/tasks/static"})
    with pytest.raises(ModelCatalogError, match="不能保存密钥"):
        validate_protocol_options({"nested": {"api_token": "leak"}})

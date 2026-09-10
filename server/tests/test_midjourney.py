"""APIMart Midjourney 协议与持久任务测试，不调真实计费接口。"""

from __future__ import annotations

import base64
import io
import json

import httpx
import pytest
from PIL import Image
from sqlalchemy import select

from domain import midjourney
from domain import storage as storage_mod
from domain.model_catalog import ResolvedModelRoute
from domain.models import ImageAsset, ModelDeployment, ModelInvocation, ProviderCredential
from domain.storage import LocalStorage
from tests.test_studio import noise_png


def _route() -> ResolvedModelRoute:
    return ResolvedModelRoute(
        deployment_id=17,
        adapter_type="apimart",
        upstream_model_id="midjourney",
        provider_type="apimart",
        credential_config={
            "api_base": "https://api.apimart.ai/v1",
            "api_key": "apimart-secret",
        },
        protocol_options={},
    )


@pytest.fixture
def midjourney_storage(tmp_path):
    storage = LocalStorage(tmp_path)
    storage_mod.set_storage(storage)
    yield storage
    storage_mod.set_storage(None)


async def _asset(session, storage: LocalStorage, data: bytes, key: str = "refs/a.png"):
    await storage.write(key, data)
    row = ImageAsset(
        sha256=("a" if key.endswith("a.png") else "b") * 64,
        storage_key=key,
        mime="image/png",
        target_key="free",
        prompt="reference",
    )
    session.add(row)
    await session.flush()
    return row


async def test_midjourney_imagine_submit_poll_download_and_log(
    session, midjourney_storage
) -> None:
    reference = await _asset(session, midjourney_storage, noise_png())
    submitted: dict = {}
    polls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal polls
        if request.url.host == "api.apimart.ai":
            assert request.headers["authorization"] == "Bearer apimart-secret"
        if request.method == "POST":
            assert request.url.path == "/v1/midjourney/generations"
            submitted.update(json.loads(request.content))
            return httpx.Response(
                200,
                json={"code": 200, "data": [{"status": "submitted", "task_id": "mj-1"}]},
            )
        if request.url.path == "/v1/midjourney/mj-1":
            polls += 1
            if polls == 1:
                return httpx.Response(200, json={"id": "mj-1", "status": "IN_PROGRESS"})
            return httpx.Response(
                200,
                json={
                    "id": "mj-1",
                    "status": "SUCCESS",
                    "action": "IMAGINE",
                    "prompt": "paper city",
                    "image_urls": [
                        "https://cdn.example/1.png",
                        "https://cdn.example/2.png",
                        "https://cdn.example/3.png",
                        "https://cdn.example/4.png",
                    ],
                    "buttons": [
                        {"customId": "MJ::JOB::upsample::1::abc", "label": "U1"}
                    ],
                },
            )
        if request.url.host == "cdn.example":
            return httpx.Response(200, content=f"image-{request.url.path}".encode())
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        handle = await midjourney.submit_generate(
            session,
            route=_route(),
            mode="imagine",
            prompt="paper city",
            size="16:9",
            version="8.2",
            speed="fast",
            reference_asset_ids=[reference.id],
            options={"stylize": 300},
            client=client,
        )
        output = await midjourney.wait_for_output(
            handle,
            client=client,
            poll_interval_s=0,
        )

    assert handle.provider_task_id == "mj-1"
    assert output.images == [b"image-/1.png", b"image-/2.png", b"image-/3.png", b"image-/4.png"]
    assert output.buttons == [{"custom_id": "MJ::JOB::upsample::1::abc", "label": "U1"}]
    assert submitted["prompt"] == "paper city"
    assert submitted["size"] == "16:9"
    assert submitted["version"] == "8.2"
    assert submitted["speed"] == "fast"
    assert submitted["stylize"] == 300
    assert submitted["image_urls"][0].startswith("data:image/png;base64,")

    invocations = list(
        (
            await session.execute(select(ModelInvocation).order_by(ModelInvocation.created_at))
        ).scalars()
    )
    assert [row.operation for row in invocations] == ["midjourney.imagine", "midjourney.poll"]
    assert invocations[0].request["reference_asset_ids"] == [reference.id]
    assert "image_urls" not in invocations[0].request
    assert all(row.status == "succeeded" for row in invocations)


async def test_midjourney_inpaint_modal_and_mask_conversion(
    session, midjourney_storage
) -> None:
    mask = Image.new("RGB", (64, 64), "black")
    for x in range(16, 48):
        for y in range(16, 48):
            mask.putpixel((x, y), (255, 255, 255))
    buffer = io.BytesIO()
    mask.save(buffer, format="PNG")
    mask_asset = await _asset(session, midjourney_storage, buffer.getvalue(), "refs/mask.png")
    submitted: list[tuple[str, dict]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            body = json.loads(request.content)
            submitted.append((request.url.path, body))
            task_id = "modal-wait" if request.url.path.endswith("/inpaint") else "modal-result"
            return httpx.Response(200, json={"data": [{"task_id": task_id}]})
        if request.url.path.endswith("/modal-wait"):
            return httpx.Response(200, json={"id": "modal-wait", "status": "MODAL"})
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        first = await midjourney.submit_action(
            session,
            route=_route(),
            task_id="parent-1",
            action="inpaint",
            speed="relax",
            client=client,
        )
        waiting = await midjourney.wait_for_output(first, client=client, poll_interval_s=0)
        assert waiting.modal_required is True

        followup = await midjourney.submit_action(
            session,
            route=_route(),
            task_id=waiting.provider_task_id,
            action="modal",
            speed="fast",
            prompt="red sofa",
            mask_asset_id=mask_asset.id,
            client=client,
        )

    assert followup.provider_task_id == "modal-result"
    assert submitted[0] == (
        "/v1/midjourney/generations/inpaint",
        {
            "task_id": "parent-1",
            "speed": "relax",
            "metadata": {"lingua_deployment_id": 17},
        },
    )
    modal_body = submitted[1][1]
    assert modal_body["task_id"] == "modal-wait"
    assert modal_body["prompt"] == "red sofa"
    encoded = modal_body["mask_url"].split(",", 1)[1]
    converted = Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGBA")
    assert converted.getpixel((32, 32))[3] == 0
    assert converted.getpixel((0, 0))[3] == 255


async def test_midjourney_route_creates_recoverable_canvas_task(
    client, session, monkeypatch
) -> None:
    credential = ProviderCredential(
        name="APIMart",
        kind="image",
        provider_type="apimart",
        config={"api_key": "secret"},
    )
    session.add(credential)
    await session.flush()
    deployment = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id="midjourney",
        display_name="Midjourney",
        adapter_type="apimart",
        media_types=["image"],
    )
    session.add(deployment)
    await session.commit()
    queued: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            queued.append((args, kwargs))

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.studio.get_queue", fake_queue)
    response = await client.post(
        "/studio/midjourney/runs",
        json={
            "deployment_id": deployment.id,
            "mode": "imagine",
            "prompt": "paper city",
            "size": "1:1",
            "version": "8.2",
            "speed": "relax",
            "reference_asset_ids": [],
            "source_context": {
                "canvas_id": 7,
                "node_id": "mj-output",
                "source_node_id": "mj-source",
            },
        },
    )
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["task_type"] == "midjourney.generate"
    assert body["canvas_id"] == 7
    assert body["node_id"] == "mj-output"
    assert body["invocation"]["_tool_runtime"]["operation"] == "midjourney.generate"
    assert queued == [(('generate_midjourney', body["id"]), {})]


async def test_midjourney_action_route_preserves_button_custom_id(
    client, session, monkeypatch
) -> None:
    credential = ProviderCredential(
        name="APIMart actions",
        kind="image",
        provider_type="apimart",
        config={"api_key": "secret"},
    )
    session.add(credential)
    await session.flush()
    deployment = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id="midjourney",
        display_name="Midjourney actions",
        adapter_type="apimart",
        media_types=["image"],
    )
    session.add(deployment)
    await session.commit()
    queued: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            queued.append((args, kwargs))

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.studio.get_queue", fake_queue)
    response = await client.post(
        "/studio/midjourney/actions",
        json={
            "deployment_id": deployment.id,
            "task_id": "mj-parent-1",
            "action": "upscale",
            "speed": "turbo",
            "custom_id": "MJ::JOB::upsample::1::abc",
            "source_context": {
                "canvas_id": 9,
                "node_id": "mj-output-2",
                "source_node_id": "mj-source-2",
            },
        },
    )

    assert response.status_code == 202, response.text
    body = response.json()
    assert body["task_type"] == "midjourney.action"
    assert body["invocation"]["custom_id"] == "MJ::JOB::upsample::1::abc"
    assert body["invocation"]["task_id"] == "mj-parent-1"
    assert body["invocation"]["speed"] == "turbo"
    assert queued == [(('generate_midjourney', body["id"]), {})]

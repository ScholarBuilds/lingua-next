"""RunningHub 在线目录与同步合同测试。"""

import json

import httpx

from domain import runninghub_catalog


def _install_transport(monkeypatch, handler) -> None:
    real_client = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(runninghub_catalog, "routed_http_client", factory)


def test_collect_workflow_fields_skips_links_and_preserves_media_shape() -> None:
    fields = runninghub_catalog.collect_workflow_fields(
        {
            "10": {
                "class_type": "LoadImage",
                "inputs": {"image": "input.png", "linked": ["9", 0]},
                "_meta": {"title": "参考图"},
            },
            "20": {"class_type": "Text", "inputs": {"prompt": "hello", "seed": 8}},
        }
    )
    assert [field["id"] for field in fields] == ["10::image", "20::prompt", "20::seed"]
    assert fields[0]["fieldType"] == "IMAGE"
    assert fields[0]["required"] is True
    assert fields[0]["enabled"] is False
    assert fields[2]["fieldType"] == "NUMBER"
    assert (
        runninghub_catalog.normalize_source_id(
            "https://www.runninghub.ai/run/workflow/wf_123", "workflow"
        )
        == "wf_123"
    )


async def test_fetch_models_uses_wallet_key_and_keeps_model_schema(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/openapi/v2/models"
        assert request.headers["authorization"] == "Bearer wallet-key"
        return httpx.Response(
            200,
            json={
                "data": {
                    "models": [
                        {
                            "name_en": "z-image/turbo",
                            "name_cn": "Z-Image 极速",
                            "endpoint": "rhart-image/z-image/turbo",
                            "output_type": "image",
                            "params": [
                                {
                                    "fieldKey": "prompt",
                                    "type": "TEXT",
                                    "defaultValue": "",
                                }
                            ],
                        }
                    ]
                }
            },
        )

    _install_transport(monkeypatch, handler)
    items = await runninghub_catalog.fetch_models(
        {
            "api_base": "https://www.runninghub.ai",
            "api_key": "points-key",
            "wallet_api_key": "wallet-key",
        }
    )
    assert items == [
        {
            "id": "z-image/turbo",
            "endpoint": "rhart-image/z-image/turbo",
            "title": "Z-Image 极速",
            "output_type": "image",
            "params": [{"fieldKey": "prompt", "type": "TEXT", "defaultValue": ""}],
        }
    ]


async def test_fetch_app_and_workflow_normalize_online_fields(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/webapp/apiCallDemo":
            assert request.url.params["apiKey"] == "points-key"
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "title": "换装应用",
                        "inputs": [
                            {"fieldName": "prompt", "defaultValue": "dress", "required": True},
                            {"fieldName": "image", "fieldType": "IMAGE"},
                        ],
                    },
                },
            )
        if request.url.path == "/api/openapi/getJsonApiFormat":
            assert json.loads(request.content) == {
                "apiKey": "points-key",
                "workflowId": "wf-1",
            }
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "title": "云端工作流",
                        "prompt": json.dumps(
                            {
                                "1": {
                                    "class_type": "Text",
                                    "inputs": {"prompt": "hello"},
                                }
                            }
                        ),
                    },
                },
            )
        return httpx.Response(404)

    _install_transport(monkeypatch, handler)
    config = {"api_base": "https://www.runninghub.ai", "api_key": "points-key"}
    app = await runninghub_catalog.fetch_app(config, "app-1")
    workflow = await runninghub_catalog.fetch_workflow(config, "wf-1")
    assert app["title"] == "换装应用"
    assert [field["fieldType"] for field in app["ui_schema"]["fields"]] == [
        "TEXT",
        "IMAGE",
    ]
    assert workflow["title"] == "云端工作流"
    assert workflow["ui_schema"]["fields"][0]["enabled"] is False


async def test_upsert_remote_is_idempotent_and_never_stores_credentials(session) -> None:
    definition = {
        "kind": "app",
        "source_id": "app-1",
        "title": "App One",
        "description": "",
        "payload": {"id": "app-1", "app_id": "app-1", "type": "app"},
        "ui_schema": {
            "fields": [
                {
                    "id": "app::prompt",
                    "nodeId": "app",
                    "fieldName": "prompt",
                    "enabled": True,
                }
            ]
        },
    }
    first = await runninghub_catalog.upsert_remote(session, definition=definition)
    second = await runninghub_catalog.upsert_remote(
        session,
        definition=definition,
        title="Renamed",
        description="safe note",
    )
    assert second.id == first.id
    assert second.title == "Renamed"
    packed = json.dumps({"payload": second.payload, "ui_schema": second.ui_schema})
    assert "api_key" not in packed
    assert second.payload["note"] == "safe note"

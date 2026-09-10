"""外部采集与 Photoshop 连接器协议测试。"""

import asyncio
import base64
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.db import get_session
from app.main import app
from app.routers import studio_connectors
from domain import storage as storage_mod
from domain import studio_assets
from domain.models import (
    Base,
    ImageAsset,
    ModelDeployment,
    ProviderCredential,
    StudioAssetGroup,
    StudioCanvas,
)
from tests.test_studio import FakeStorage, noise_png


@pytest.fixture
def fake_storage():
    fake = FakeStorage()
    storage_mod.set_storage(fake)
    yield fake
    storage_mod.set_storage(None)


async def test_inline_image_and_video_enter_unified_asset_library(client, fake_storage) -> None:
    group = (await client.post("/studio/asset-groups", json={"name": "网页采集"})).json()
    image = base64.b64encode(noise_png()).decode()
    video = base64.b64encode(b"\x00\x00\x00\x18ftypmp42connector-video").decode()
    response = await client.post(
        "/studio/connectors/import",
        json={
            "group_id": group["id"],
            "items": [
                {
                    "data": f"data:image/png;base64,{image}",
                    "name": "reference.png",
                },
                {
                    "data": video,
                    "content_type": "video/mp4",
                    "name": "clip.mp4",
                },
            ],
        },
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["ok"] is True and payload["count"] == 2
    assert [item["kind"] for item in payload["items"]] == ["image", "video"]
    image_id = payload["items"][0]["asset_id"]
    media_id = payload["items"][1]["media_asset_id"]
    assert (await client.get(f"/images/assets/{image_id}")).json()["group_id"] == group["id"]
    assert (await client.get(f"/studio/media-assets/{media_id}")).json()["group_id"] == group["id"]

    catalog = (await client.get("/studio/connectors/catalog")).json()
    assert [item["id"] for item in catalog["images"]] == [image_id]
    assert [item["id"] for item in catalog["media"]] == [media_id]
    assert catalog["groups"][0]["name"] == "网页采集"


async def test_import_reports_bad_inline_item_without_rolling_back_good_one(
    client,
    fake_storage,
) -> None:
    image = base64.b64encode(noise_png()).decode()
    response = await client.post(
        "/studio/connectors/import",
        json={
            "items": [
                {"data": image, "content_type": "image/png", "name": "good.png"},
                {
                    "data": base64.b64encode(b"not-an-image").decode(),
                    "content_type": "image/png",
                    "name": "bad.png",
                },
            ]
        },
    )
    items = response.json()["items"]
    assert [item["ok"] for item in items] == [True, False]
    assert "文件头" in items[1]["reason"]


async def test_group_name_is_created_and_jpeg_bridge_returns_photoshop_safe_image(
    client,
    fake_storage,
) -> None:
    image = base64.b64encode(noise_png()).decode()
    imported = await client.post(
        "/studio/connectors/import",
        json={
            "group_name": "Photoshop 导入",
            "items": [{"data": image, "content_type": "image/png", "name": "layer.png"}],
        },
    )
    payload = imported.json()
    assert imported.status_code == 201
    assert payload["group_id"] is not None
    asset_id = payload["items"][0]["asset_id"]

    jpeg = await client.get(f"/studio/connectors/images/{asset_id}/jpeg?width=64")
    assert jpeg.status_code == 200
    assert jpeg.headers["content-type"] == "image/jpeg"
    assert jpeg.content.startswith(b"\xff\xd8\xff")

    catalog = (await client.get("/studio/connectors/catalog")).json()
    assert any(group["name"] == "Photoshop 导入" for group in catalog["groups"])


async def test_import_forwards_per_run_tag_model_and_prompt_without_exposing_secret(
    client,
    fake_storage,
    session,
    monkeypatch,
) -> None:
    credential = ProviderCredential(
        name="视觉分类",
        kind="llm",
        provider_type="openai_compatible",
        config={"api_key": "server-only-secret"},
    )
    session.add(credential)
    await session.flush()
    deployment = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id="vision-chat",
        adapter_type="openai",
        media_types=["chat"],
    )
    session.add(deployment)
    await session.commit()
    await session.refresh(deployment)

    received: list[dict] = []

    async def fake_tag_assets(db, asset_ids, *, settings_override=None):
        received.append({"asset_ids": asset_ids, "settings": settings_override})
        return []

    monkeypatch.setattr(studio_assets, "tag_assets", fake_tag_assets)
    image = base64.b64encode(noise_png()).decode()
    response = await client.post(
        "/studio/connectors/import",
        json={
            "auto_tag": True,
            "tag_deployment_id": deployment.id,
            "tag_prompt": "  优先识别商业用途  ",
            "items": [{"data": image, "content_type": "image/png", "name": "picked.png"}],
        },
    )

    assert response.status_code == 201, response.text
    asset_id = response.json()["items"][0]["asset_id"]
    assert received == [
        {
            "asset_ids": [asset_id],
            "settings": {
                "deployment_id": deployment.id,
                "user_prompt": "优先识别商业用途",
            },
        }
    ]
    assert "server-only-secret" not in response.text


async def test_import_rejects_unknown_tag_deployment_before_ingesting(
    client,
    fake_storage,
) -> None:
    image = base64.b64encode(noise_png()).decode()
    response = await client.post(
        "/studio/connectors/import",
        json={
            "auto_tag": True,
            "tag_deployment_id": 999,
            "items": [{"data": image, "content_type": "image/png", "name": "picked.png"}],
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "分类模型部署不存在"
    assert (await client.get("/studio/connectors/catalog")).json()["images"] == []


async def test_connector_revisions_detect_asset_metadata_and_canvas_changes(session) -> None:
    initial = await studio_connectors.connector_revisions(session)

    group = StudioAssetGroup(name="实时分组")
    session.add(group)
    await session.commit()
    with_group = await studio_connectors.connector_revisions(session)
    assert with_group["assets"] != initial["assets"]
    assert with_group["canvas"] == initial["canvas"]

    group.name = "实时分组已改名"
    await session.commit()
    renamed = await studio_connectors.connector_revisions(session)
    assert renamed["assets"] != with_group["assets"]

    session.add(
        StudioCanvas(
            title="UXP 实时画布",
            kind="smart",
            project="default",
            nodes=[],
            connections=[],
        )
    )
    await session.commit()
    with_canvas = await studio_connectors.connector_revisions(session)
    assert with_canvas["assets"] == renamed["assets"]
    assert with_canvas["canvas"] != renamed["canvas"]


async def test_edit_job_rejects_unknown_deployment_before_queueing(client, session) -> None:
    reference = ImageAsset(
        sha256="2" * 64,
        storage_key="images/connector-ref.png",
        mime="image/png",
        target_key="free",
        prompt="reference",
    )
    session.add(reference)
    await session.commit()

    response = await client.post(
        "/studio/connectors/edit-job",
        json={
            "prompt": "turn it into a night scene",
            "deployment_id": 999,
            "ref_asset_ids": [reference.id],
        },
    )
    assert response.status_code == 400
    assert "模型部署" in response.json()["detail"]


async def test_chrome_extension_origin_is_allowed_by_cors(client) -> None:
    origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    response = await client.options(
        "/studio/connectors/catalog",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin


# ==================== 连接状态与安装位置 ====================


@pytest.fixture
def db_engine_sync():
    """给 TestClient 用的会话工厂：它自己起事件循环，异步 fixture 的引擎过不去。"""
    holder: dict[str, object] = {}

    async def _override():
        engine = holder.get("engine")
        if engine is None:
            engine = create_async_engine(
                "sqlite+aiosqlite://",
                poolclass=StaticPool,
                connect_args={"check_same_thread": False},
            )
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            holder["engine"] = engine
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            yield session

    yield _override
    engine = holder.get("engine")
    if engine is not None:
        asyncio.run(engine.dispose())  # type: ignore[union-attr]


@pytest.fixture
def clean_presence():
    studio_connectors.reset_connector_presence()
    yield
    studio_connectors.reset_connector_presence()


async def test_status_reports_unknown_when_no_connector_has_ever_reported(
    client, clean_presence
) -> None:
    payload = (await client.get("/studio/connectors/status")).json()

    states = {item["id"]: item["state"] for item in payload["connectors"]}
    assert states == {"chrome": "unknown", "photoshop": "unknown"}
    for item in payload["connectors"]:
        # 没信号就别编：既不能说已连接，也不能说没装
        assert item["last_seen_at"] is None
        assert item["seen_seconds_ago"] is None
        assert "判不出来" in item["state_note"]


async def test_connector_request_marks_itself_connected_without_touching_web_reads(
    client, clean_presence
) -> None:
    # Web 前端读状态不带 connector 参数，读多少次都不该把自己算成连接器
    await client.get("/studio/connectors/status")
    assert (await client.get("/studio/connectors/status")).json()["connectors"][0][
        "state"
    ] == "unknown"

    await client.get(
        "/studio/connectors/catalog",
        params={"connector": "chrome", "connector_version": "1.1.0"},
    )
    payload = (await client.get("/studio/connectors/status")).json()

    chrome = next(item for item in payload["connectors"] if item["id"] == "chrome")
    photoshop = next(item for item in payload["connectors"] if item["id"] == "photoshop")
    assert chrome["state"] == "connected"
    assert chrome["version"] == "1.1.0"
    assert chrome["channel"] == "http"
    assert chrome["seen_seconds_ago"] is not None and chrome["seen_seconds_ago"] < 5
    # 一个连上不代表另一个也连上
    assert photoshop["state"] == "unknown"


async def test_status_turns_disconnected_once_the_heartbeat_goes_stale(
    client, clean_presence
) -> None:
    await client.get("/studio/connectors/status", params={"connector": "photoshop"})
    stale = studio_connectors.CONNECTOR_ONLINE_WINDOW_S + 600
    studio_connectors._PRESENCE["photoshop"].at -= stale

    payload = (await client.get("/studio/connectors/status")).json()

    photoshop = next(item for item in payload["connectors"] if item["id"] == "photoshop")
    assert photoshop["state"] == "disconnected"
    assert photoshop["last_seen_at"] is not None
    assert "现在没连着" in photoshop["state_note"]


async def test_status_gives_real_absolute_install_paths(client, clean_presence) -> None:
    payload = (await client.get("/studio/connectors/status")).json()

    by_id = {item["id"]: item for item in payload["connectors"]}
    for connector_id, folder in (
        ("chrome", "chrome-local-asset-importer"),
        ("photoshop", "photoshop-asset-connector"),
    ):
        item = by_id[connector_id]
        source = Path(item["source_dir"])
        assert source.is_absolute() and source.name == folder
        # 引导要让用户照着点，路径必须是真的
        assert item["source_dir_exists"] is True
        assert item["entry_exists"] is True
        assert Path(item["entry_path"]).name == "manifest.json"
        assert Path(item["package_path"]).is_absolute()


async def test_unknown_connector_name_is_ignored(client, clean_presence) -> None:
    await client.get("/studio/connectors/status", params={"connector": "figma"})

    payload = (await client.get("/studio/connectors/status")).json()
    assert {item["state"] for item in payload["connectors"]} == {"unknown"}


def test_websocket_handshake_counts_as_a_heartbeat(db_engine_sync) -> None:
    """UXP 面板的实时同步是长连接，握手带上 connector 就够，不用额外轮询。

    路由级依赖挂在整个 connectors 路由上，WebSocket 路由也要照常握手——
    这条链路断了 Photoshop 面板的实时刷新就没了，所以真开一次连接来验。
    """
    studio_connectors.reset_connector_presence()
    app.dependency_overrides[get_session] = db_engine_sync

    try:
        client = TestClient(app)
        with client.websocket_connect(
            "/studio/connectors/events?connector=photoshop&connector_version=1.0.0"
        ) as socket:
            assert socket.receive_json()["type"] == "ready"
    finally:
        app.dependency_overrides.pop(get_session, None)

    seen = studio_connectors._PRESENCE["photoshop"]
    assert seen.channel == "websocket"
    assert seen.version == "1.0.0"
    studio_connectors.reset_connector_presence()


async def test_status_surfaces_the_packaged_artifact_from_the_build_record(
    client, clean_presence, tmp_path, monkeypatch
) -> None:
    """打过包就把产物路径和打包时间带出来，容器里换挂载点走 LINGUA_TOOLS_DIR。"""
    (tmp_path / "chrome-local-asset-importer").mkdir()
    (tmp_path / "chrome-local-asset-importer" / "manifest.json").write_text("{}")
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "lingua-chrome-collector.zip").write_bytes(b"zip")
    record = {"lingua-chrome-collector.zip": {"built_at": "2026-08-23T08:00:00+00:00"}}
    (dist / "BUILD.json").write_text(json.dumps({"artifacts": record}), encoding="utf-8")
    monkeypatch.setenv("LINGUA_TOOLS_DIR", str(tmp_path))

    payload = (await client.get("/studio/connectors/status")).json()

    by_id = {item["id"]: item for item in payload["connectors"]}
    chrome = by_id["chrome"]
    assert chrome["package_exists"] is True
    assert chrome["package_built_at"] == "2026-08-23T08:00:00+00:00"
    assert chrome["source_dir"] == str(tmp_path / "chrome-local-asset-importer")
    # 没打过的那个照实说没有，不拿另一个的产物顶包
    photoshop = by_id["photoshop"]
    assert photoshop["package_exists"] is False
    assert photoshop["package_built_at"] is None
    assert photoshop["source_dir_exists"] is False

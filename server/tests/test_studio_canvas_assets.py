"""画布资产索引：按画布聚合、去重与本地资源批量打包。"""

from io import BytesIO
from zipfile import ZipFile

from domain import storage as storage_mod
from domain.models import StudioCanvas
from domain.studio_media_assets import ingest_one
from tests.test_studio import FakeStorage, noise_png, seed_asset


async def test_canvas_asset_index_and_download(client, session) -> None:
    storage = FakeStorage()
    storage_mod.set_storage(storage)
    try:
        image = await seed_asset(session, storage, noise_png())
        media = await ingest_one(
            session,
            b"audio-data",
            kind="audio",
            name="voice.mp3",
            mime="audio/mpeg",
        )
        canvas = StudioCanvas(
            title="资产验收画布",
            kind="smart",
            nodes=[
                {
                    "id": "n1",
                    "type": "image",
                    "title": "参考图",
                    "items": [
                        {"asset_id": image.id, "kind": "image", "name": "主图.png"},
                        {"asset_id": image.id, "kind": "image", "name": "重复引用.png"},
                    ],
                    "manual_references": [
                        {"media_asset_id": media.id, "kind": "audio", "name": "配音.mp3"},
                    ],
                },
                {
                    "id": "n2",
                    "type": "video",
                    "items": [
                        {"url": "https://cdn.example/clip.mp4", "kind": "video"},
                    ],
                },
            ],
            connections=[],
        )
        session.add(canvas)
        await session.commit()

        response = await client.get("/studio/canvas-assets")
        assert response.status_code == 200
        body = response.json()
        assert body["categories"][0]["count"] == 3
        assert body["categories"][1]["canvas_count"] == 1
        assert body["canvases"][0]["asset_count"] == 3
        assert {item["kind"] for item in body["items"]} == {"image", "audio", "video"}
        assert all(item["canvas_title"] == "资产验收画布" for item in body["items"])

        local_ids = [
            item["id"] for item in body["items"] if item["asset_type"] != "external"
        ]
        archive = await client.post(
            "/studio/canvas-assets/download",
            json={"item_ids": local_ids, "filename": "画布素材.zip"},
        )
        assert archive.status_code == 200
        assert archive.headers["content-type"] == "application/zip"
        with ZipFile(BytesIO(archive.content)) as zipped:
            assert sorted(zipped.namelist()) == ["主图.png", "配音.mp3"]
            assert zipped.read("配音.mp3") == b"audio-data"

        external_only = await client.post(
            "/studio/canvas-assets/download",
            json={
                "item_ids": [
                    item["id"] for item in body["items"] if item["asset_type"] == "external"
                ]
            },
        )
        assert external_only.status_code == 400
        assert "本地资产" in external_only.json()["detail"]
    finally:
        storage_mod.set_storage(None)

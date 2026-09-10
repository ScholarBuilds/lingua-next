from __future__ import annotations

import pytest

from domain import image_assets, studio_asset_storage
from domain import storage as storage_mod
from domain.models import ImageAsset, StudioCanvas
from tests.test_studio import FakeStorage, noise_png, seed_asset


@pytest.fixture
def fake_storage():
    fake = FakeStorage()
    storage_mod.set_storage(fake)
    yield fake
    storage_mod.set_storage(None)


def test_collect_image_refs_understands_ids_urls_and_template_sha() -> None:
    value = {
        "assetIds": [4, 8],
        "preview": "/api/images/assets/9/full?v=1",
        "resource": {"sha256": "a" * 64},
        "media": {"media_asset_id": 4},
    }
    assert studio_asset_storage.collect_image_refs(
        value,
        {4, 8, 9},
        {"a" * 64: 4},
    ) == {4, 8, 9}


async def test_storage_prefixes_route_controls_new_asset_keys(
    client, session, fake_storage
) -> None:
    saved = await client.put(
        "/studio/assets/storage-prefixes",
        json={
            "generated": "creative/generated",
            "upload": "creative/upload",
            "local": "creative/local",
        },
    )
    assert saved.status_code == 200
    assert saved.json()["prefixes"]["upload"] == "creative/upload"

    row = await image_assets.ingest_one(
        session,
        noise_png(),
        target_key="free",
        prompt="upload",
        source="local",
        op="upload",
    )
    await session.commit()
    assert row.storage_key.startswith("creative/upload/")

    invalid = await client.put(
        "/studio/assets/storage-prefixes",
        json={
            "generated": "../escape",
            "upload": "images/upload",
            "local": "images/local",
        },
    )
    assert invalid.status_code == 400
    assert "不合法" in invalid.json()["detail"]


async def test_overview_marks_canvas_references_and_reclaimable_archives(
    client, session, fake_storage
) -> None:
    referenced = await seed_asset(session, fake_storage, noise_png())
    reclaimable = await seed_asset(session, fake_storage, noise_png())
    referenced.status = "archived"
    reclaimable.status = "archived"
    session.add(
        StudioCanvas(
            title="仍在引用",
            project="default",
            nodes=[{"id": "image-1", "type": "image", "asset_id": referenced.id}],
            connections=[],
        )
    )
    await session.commit()

    response = await client.get("/studio/assets/storage")
    assert response.status_code == 200
    payload = response.json()
    items = {item["id"]: item for item in payload["archived_items"]}
    assert items[referenced.id]["reclaimable"] is False
    assert "画布" in items[referenced.id]["references"]
    assert items[reclaimable.id]["reclaimable"] is True
    assert payload["archived_assets"] == 2
    assert payload["reclaimable_assets"] == 1


async def test_purge_is_atomic_when_any_selected_asset_is_referenced(
    client, session, fake_storage
) -> None:
    referenced = await seed_asset(session, fake_storage, noise_png())
    reclaimable = await seed_asset(session, fake_storage, noise_png())
    referenced.status = "archived"
    reclaimable.status = "archived"
    session.add(
        StudioCanvas(
            title="保护引用",
            project="default",
            nodes=[{"asset_id": referenced.id}],
            connections=[],
        )
    )
    await session.commit()

    response = await client.post(
        "/studio/assets/storage/purge",
        json={"asset_ids": [referenced.id, reclaimable.id]},
    )
    assert response.status_code == 409
    assert response.json()["detail"]["blocked"][0]["asset_id"] == referenced.id
    assert await session.get(ImageAsset, referenced.id) is not None
    assert await session.get(ImageAsset, reclaimable.id) is not None
    assert await fake_storage.exists(reclaimable.storage_key)


async def test_purge_deletes_archived_row_and_all_variant_objects(
    client, session, fake_storage
) -> None:
    row = await seed_asset(session, fake_storage, noise_png())
    row.status = "archived"
    row.display_key = f"{row.storage_key}.display"
    row.thumb_key = f"{row.storage_key}.thumb"
    await fake_storage.write(row.display_key, b"display")
    await fake_storage.write(row.thumb_key, b"thumb")
    keys = [row.storage_key, row.display_key, row.thumb_key]
    asset_id = row.id
    await session.commit()

    response = await client.post(
        "/studio/assets/storage/purge", json={"asset_ids": [asset_id]}
    )
    assert response.status_code == 200
    assert response.json()["purged"] == 1
    assert response.json()["removed_objects"] == 3
    session.expire_all()
    assert await session.get(ImageAsset, asset_id) is None
    assert [await fake_storage.exists(key) for key in keys] == [False, False, False]


async def test_purge_rejects_active_assets(client, session, fake_storage) -> None:
    row = await seed_asset(session, fake_storage, noise_png())
    response = await client.post(
        "/studio/assets/storage/purge", json={"asset_ids": [row.id]}
    )
    assert response.status_code == 409
    assert "只能物理清理已归档素材" in response.json()["detail"]

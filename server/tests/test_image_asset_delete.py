"""图片资产真删除与「谁在用它」（DELETE /images/assets/... · /usage · bulk-delete）。

软删（`status='archived'`，BR-105）和真删是两条路：前者留着行与文件，后者要把库行
和它独占的存储对象一起清掉，同时不能顺手删掉别的记录还指着的那个对象。
"""

from __future__ import annotations

import io
import random

import pytest

from domain import image_assets
from domain import storage as storage_mod
from domain.models import ImageAsset, StudioCanvas, Wordlist
from domain.storage import StorageError
from tests.test_studio import FakeStorage

_png_seq = 1000


def wide_png(width: int = 1024) -> bytes:
    """够宽的噪点 PNG：宽度过 768 才会派生出 display / thumb 两个对象，
    只有这样才测得到「派生对象也被删掉」。"""
    global _png_seq
    _png_seq += 1
    from PIL import Image

    rng = random.Random(_png_seq)
    height = max(64, width // 2)
    im = Image.new("RGB", (width, height))

    def pixel() -> tuple[int, int, int]:
        return rng.randrange(256), rng.randrange(256), rng.randrange(256)

    im.putdata([pixel() for _ in range(width * height)])
    out = io.BytesIO()
    im.save(out, format="PNG")
    return out.getvalue()


@pytest.fixture
def fake_storage():
    fake = FakeStorage()
    storage_mod.set_storage(fake)
    yield fake
    storage_mod.set_storage(None)


class ExplodingStorage(FakeStorage):
    """删除必炸的存储替身：文件被外部挪走、权限不对时就是这个行为。"""

    async def delete(self, key: str) -> bool:
        raise StorageError(f"删除失败 {key}: 权限不足")


async def reload(session, asset_id: int) -> ImageAsset | None:
    """从库里重新读一遍。

    测试的 `session` 与请求用的是两个会话，而 `expire_on_commit=False` 让身份映射
    一直缓着旧对象——不先 expunge 的话，`session.get` 直接命中缓存，删掉的行照样
    "查得到"，断言全是假的。
    """
    session.expunge_all()
    return await session.get(ImageAsset, asset_id)


async def ingest(session, *, parent_id: int | None = None, source: str = "workbench") -> ImageAsset:
    row = await image_assets.ingest_one(
        session,
        wide_png(),
        target_key="free",
        prompt="测试图",
        source=source,
        parent_id=parent_id,
    )
    await session.commit()
    return row


class TestDeleteAsset:
    async def test_missing_asset_is_404(self, client, fake_storage) -> None:
        assert (await client.delete("/images/assets/98765")).status_code == 404

    async def test_removes_row_and_all_three_objects(self, client, session, fake_storage) -> None:
        row = await ingest(session)
        keys = [row.storage_key, row.display_key, row.thumb_key]
        assert all(keys), "1024 宽的图应当派生出 display 与 thumb"

        body = (await client.delete(f"/images/assets/{row.id}")).json()
        assert body["deleted"] is True
        assert sorted(body["removed_objects"]) == sorted(keys)
        assert body["storage_clean"] is True
        assert body["failed_objects"] == []
        assert all(key not in fake_storage.blobs for key in keys)
        assert await reload(session, row.id) is None

    async def test_children_block_delete_until_forced(self, client, session, fake_storage) -> None:
        parent = await ingest(session)
        first = await ingest(session, parent_id=parent.id)
        second = await ingest(session, parent_id=parent.id)

        blocked = await client.delete(f"/images/assets/{parent.id}")
        assert blocked.status_code == 409
        detail = blocked.json()["detail"]
        assert detail["children"] == 2
        assert sorted(detail["child_ids"]) == sorted([first.id, second.id])
        assert await reload(session, parent.id) is not None

        forced = await client.delete(f"/images/assets/{parent.id}?force=true")
        assert forced.status_code == 200
        assert sorted(forced.json()["orphaned_children"]) == sorted([first.id, second.id])
        assert await reload(session, parent.id) is None
        # 子代要显式置空，不能留下指向已删行的悬空 parent_id
        for child_id in (first.id, second.id):
            assert (await reload(session, child_id)).parent_id is None

    async def test_storage_failure_still_deletes_the_row_and_says_so(
        self, client, session, fake_storage
    ) -> None:
        row = await ingest(session)
        keys = [row.storage_key, row.display_key, row.thumb_key]
        storage_mod.set_storage(ExplodingStorage())

        body = (await client.delete(f"/images/assets/{row.id}")).json()
        assert body["deleted"] is True
        assert await reload(session, row.id) is None
        assert body["storage_clean"] is False
        assert sorted(item["key"] for item in body["failed_objects"]) == sorted(keys)
        assert body["removed_objects"] == []

    async def test_missing_object_is_reported_apart_from_failure(
        self, client, session, fake_storage
    ) -> None:
        row = await ingest(session)
        fake_storage.blobs.pop(row.thumb_key)

        body = (await client.delete(f"/images/assets/{row.id}")).json()
        assert body["missing_objects"] == [row.thumb_key]
        assert body["failed_objects"] == []
        # 盘上本来就没有这个文件不算删失败，别把它算进"没删干净"
        assert body["storage_clean"] is True

    async def test_object_shared_with_a_wordlist_cover_is_kept(
        self, client, session, fake_storage
    ) -> None:
        row = await ingest(session)
        # apply_wordlist_cover 把 asset.storage_key 原样写进 cover_key，两边同一个对象
        session.add(Wordlist(name="日常问候", cover_key=row.storage_key))
        await session.commit()

        assert (await client.delete(f"/images/assets/{row.id}")).status_code == 409
        body = (await client.delete(f"/images/assets/{row.id}?force=true")).json()
        assert [item["key"] for item in body["kept_objects"]] == [row.storage_key]
        assert body["kept_objects"][0]["held_by"] == ["单词本封面"]
        assert row.storage_key in fake_storage.blobs
        # 派生图是这一行独占的（key 里带 sha，sha 唯一），照删
        assert sorted(body["removed_objects"]) == sorted([row.display_key, row.thumb_key])


class TestAssetUsage:
    async def test_finds_canvas_nodes_children_and_applied_target(
        self, client, session, fake_storage
    ) -> None:
        row = await ingest(session)
        await ingest(session, parent_id=row.id)
        wordlist = Wordlist(name="厨房用具")
        session.add(wordlist)
        await session.flush()
        session.add(
            StudioCanvas(
                title="角色设计",
                project="default",
                nodes=[
                    {"id": "n1", "type": "image", "items": [{"asset_id": row.id}]},
                    {"id": "n2", "type": "image", "items": [{"asset_id": row.id}]},
                    {"id": "n3", "type": "image", "items": [{"asset_id": 99999}]},
                ],
            )
        )
        session.add(StudioCanvas(title="没引用的画布", project="default", nodes=[]))
        await image_assets.mark_applied(session, row, "wordlist", wordlist.id)
        await session.commit()

        body = (await client.get(f"/images/assets/{row.id}/usage")).json()
        assert body["canvases"] == [
            {"id": 1, "title": "角色设计", "node_count": 2, "trashed": False}
        ]
        assert body["children"] == 1
        assert body["applied_to"]["subject_domain"] == "wordlist"
        assert body["applied_to"]["title"] == "厨房用具"
        assert body["deletable"] is False
        assert "2 个节点在用" in body["summary"]
        assert "厨房用具" in body["summary"]

    async def test_unused_asset_reads_as_deletable(self, client, session, fake_storage) -> None:
        row = await ingest(session)
        body = (await client.get(f"/images/assets/{row.id}/usage")).json()
        assert body["canvases"] == []
        assert body["children"] == 0
        assert body["applied_to"] is None
        assert body["deletable"] is True
        assert body["summary"] == "没查到任何引用，删掉不会影响别处"

    async def test_missing_asset_is_404(self, client, fake_storage) -> None:
        assert (await client.get("/images/assets/98765/usage")).status_code == 404


class TestBulkDelete:
    async def test_force_authorization_does_not_extend_to_sixth_asset(
        self, client, session, fake_storage
    ):
        rows = [await ingest(session) for _ in range(6)]
        await ingest(session, parent_id=rows[0].id)
        await ingest(session, parent_id=rows[5].id)
        ids = [row.id for row in rows]
        preview = await client.post("/images/assets/delete-preview", json={"ids": ids})
        assert preview.status_code == 200
        assert len(preview.json()["items"]) == 6
        assert preview.json()["items"][5]["deletable"] is False
        invalid = await client.post("/images/assets/bulk-delete", json={"ids": ids, "force": True})
        assert invalid.status_code == 400
        result = await client.post(
            "/images/assets/bulk-delete", json={"ids": ids, "force_ids": [ids[0]]}
        )
        assert result.status_code == 200, result.text
        assert result.json()["deleted"] == 5
        assert await reload(session, ids[5]) is not None

    async def test_reports_each_id_independently(self, client, session, fake_storage) -> None:
        plain = await ingest(session)
        parent = await ingest(session)
        await ingest(session, parent_id=parent.id)

        body = (
            await client.post(
                "/images/assets/bulk-delete", json={"ids": [plain.id, parent.id, 98765]}
            )
        ).json()
        assert body["deleted"] == 1
        assert body["failed"] == 2
        by_id = {item["asset_id"]: item for item in body["results"]}
        assert by_id[plain.id]["deleted"] is True
        assert by_id[parent.id]["status"] == 409 and by_id[parent.id]["children"] == 1
        assert by_id[98765]["status"] == 404
        # 一张被拦不该连累另一张
        assert await reload(session, plain.id) is None
        assert await reload(session, parent.id) is not None

    async def test_child_listed_first_unblocks_its_parent(
        self, client, session, fake_storage
    ) -> None:
        parent = await ingest(session)
        child = await ingest(session, parent_id=parent.id)

        body = (
            await client.post("/images/assets/bulk-delete", json={"ids": [child.id, parent.id]})
        ).json()
        assert body["deleted"] == 2
        assert await reload(session, parent.id) is None

    async def test_empty_ids_are_rejected(self, client, fake_storage) -> None:
        empty = await client.post("/images/assets/bulk-delete", json={"ids": []})
        assert empty.status_code == 400

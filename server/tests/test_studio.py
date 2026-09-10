"""创作工坊（模块 17 M1）：画布/会话持久化 + /images/edit 资产直引。

守的是几条会静默出错的约束：

- 乐观锁 409 要带最新全量（前端 BR-145 合并靠它）；
- meta 更新不刷 updated_at、不动 version（BR-146，否则打个标签就把画布顶到最前）；
- 文档态不存运行态（BR-143，pending/running 落库后恢复逻辑必碎）；
- 悬空边静默过滤（删节点漏删边是前端常态，报错会让保存失败丢内容）；
- ref_asset_ids 直引从存储读字节（BR-144，禁止下载再上传绕行）。
"""

from __future__ import annotations

import base64
import hashlib
import io
import random
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from domain import imagegen, llm, studio, studio_gpt
from domain import storage as storage_mod
from domain.model_catalog import ResolvedModelRoute
from domain.models import ImageAsset, StudioCanvas
from domain.storage import StorageError
from worker.tasks import edit_image_task

# ---- 测试替身 ----


class FakeStorage:
    """内存版存储：只实现本轮用到的动词。"""

    def __init__(self) -> None:
        self.blobs: dict[str, bytes] = {}

    async def read(self, key: str) -> bytes:
        if key not in self.blobs:
            raise StorageError(f"不存在：{key}")
        return self.blobs[key]

    async def write(self, key: str, data: bytes) -> None:
        self.blobs[key] = data

    async def stat(self, key: str):
        return None

    async def exists(self, key: str) -> bool:
        return key in self.blobs

    async def read_range(self, key: str, start: int, end: int) -> bytes:
        return (await self.read(key))[start : end + 1]

    async def delete(self, key: str) -> bool:
        return self.blobs.pop(key, None) is not None

    def local_path(self, key: str):
        return None

    async def presigned_url(self, key: str, ttl_s: int = 600):
        return None


def test_video_sample_seconds_are_uniform_and_avoid_the_container_end():
    assert studio_gpt.video_sample_seconds(500) == [0.0]
    assert studio_gpt.video_sample_seconds(3000) == [0.0, 1.475, 2.95]
    assert studio_gpt.video_sample_seconds(None) == [0.0, 1.0, 2.0, 3.0, 4.0, 5.0]


@pytest.fixture
def fake_storage():
    fake = FakeStorage()
    storage_mod.set_storage(fake)
    yield fake
    storage_mod.set_storage(None)


_png_seq = 0


def noise_png() -> bytes:
    """随机噪点 PNG：每次内容不同（sha 不撞），且不会触发纯色体检。"""
    global _png_seq
    _png_seq += 1
    from PIL import Image

    rng = random.Random(_png_seq)
    im = Image.new("RGB", (64, 64))
    im.putdata(
        [(rng.randrange(256), rng.randrange(256), rng.randrange(256)) for _ in range(64 * 64)]
    )
    out = io.BytesIO()
    im.save(out, format="PNG")
    return out.getvalue()


async def seed_asset(session, fake_storage: FakeStorage, data: bytes) -> ImageAsset:
    sha = hashlib.sha256(data).hexdigest()
    key = f"images/test/{sha}.png"
    await fake_storage.write(key, data)
    row = ImageAsset(
        sha256=sha, storage_key=key, mime="image/png", width=64, height=64,
        bytes=len(data), target_key="free", prompt="seed", source="workbench",
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


# ---- 项目、画布 CRUD 与乐观锁 ----


class TestStudioProjects:
    async def test_default_create_rename_and_delete_moves_canvases(self, client):
        initial = (await client.get("/studio/projects")).json()["items"]
        assert [(item["id"], item["name"], item["canvas_count"]) for item in initial] == [
            ("default", "默认项目", 0)
        ]

        created = (
            await client.post("/studio/projects", json={"name": "角色设计"})
        ).json()
        assert created["id"] != "default" and created["order"] == 1
        renamed = (
            await client.patch(
                f"/studio/projects/{created['id']}", json={"name": "角色库"}
            )
        ).json()
        assert renamed["name"] == "角色库"

        canvas = (
            await client.post(
                "/studio/canvases",
                json={"title": "三视图", "project": created["id"], "kind": "classic"},
            )
        ).json()
        assert canvas["project"] == created["id"] and canvas["kind"] == "classic"
        listed = (await client.get("/studio/projects")).json()["items"]
        assert next(item for item in listed if item["id"] == created["id"])[
            "canvas_count"
        ] == 1

        deleted = await client.delete(f"/studio/projects/{created['id']}")
        assert deleted.json() == {"ok": True, "moved": 1}
        moved = (await client.get(f"/studio/canvases/{canvas['id']}")).json()
        assert moved["project"] == "default"

    async def test_default_project_cannot_be_deleted(self, client):
        await client.get("/studio/projects")
        response = await client.delete("/studio/projects/default")
        assert response.status_code == 400
        assert "默认项目不可删除" in response.json()["detail"]

    async def test_canvas_project_filter_and_unknown_project(self, client):
        project = (await client.post("/studio/projects", json={"name": "广告"})).json()
        in_project = (
            await client.post("/studio/canvases", json={"project": project["id"]})
        ).json()
        await client.post("/studio/canvases", json={})
        items = (
            await client.get(f"/studio/canvases?project={project['id']}")
        ).json()["items"]
        assert [item["id"] for item in items] == [in_project["id"]]

        missing = await client.post(
            "/studio/canvases", json={"project": "does-not-exist"}
        )
        assert missing.status_code == 404


class TestCanvas:
    async def test_create_and_get(self, client):
        created = (await client.post("/studio/canvases", json={"title": "海报草稿"})).json()
        assert created["title"] == "海报草稿"
        assert created["version"] == 1
        assert created["connections"] == []
        assert created["settings"] == {}
        got = (await client.get(f"/studio/canvases/{created['id']}")).json()
        assert got == created

    async def test_new_canvas_starts_with_one_empty_node(self, client):
        """空白画布对着一片点阵，用户第一反应是"我该点哪"。

        先给一个空节点，"在这里写想画什么"就是第一步的说明书。
        两块画布各自有自己的 id——共用一个 id 的话，把两块画布并排导出再
        合并，两个节点会撞在一起，而这种错要到很久以后才会被发现。
        """
        a = (await client.post("/studio/canvases", json={})).json()
        b = (await client.post("/studio/canvases", json={})).json()
        assert len(a["nodes"]) == 1
        node = a["nodes"][0]
        assert node["type"] == "image" and node["items"] == []
        assert node["w"] == studio.STARTER_NODE_W
        assert a["nodes"][0]["id"] != b["nodes"][0]["id"]

    async def test_save_bumps_version_and_updated_at(self, client):
        cid = (await client.post("/studio/canvases", json={})).json()["id"]
        payload = {
            "nodes": [{"id": "n1", "type": "image", "x": 0, "y": 0}],
            "connections": [],
            "viewport": {"x": 10, "y": -5, "scale": 1.5},
            "base_version": 1,
        }
        resp = await client.put(f"/studio/canvases/{cid}", json=payload)
        assert resp.status_code == 200
        assert resp.json()["version"] == 2
        got = (await client.get(f"/studio/canvases/{cid}")).json()
        assert got["version"] == 2
        assert [n["id"] for n in got["nodes"]] == ["n1"]
        assert got["viewport"] == {"x": 10.0, "y": -5.0, "scale": 1.5}

    async def test_version_conflict_returns_409_with_full_canvas(self, client):
        cid = (await client.post("/studio/canvases", json={})).json()["id"]
        base = {"nodes": [], "connections": [], "viewport": {"x": 0, "y": 0, "scale": 1}}
        assert (
            await client.put(f"/studio/canvases/{cid}", json={**base, "base_version": 1})
        ).status_code == 200
        stale = await client.put(f"/studio/canvases/{cid}", json={**base, "base_version": 1})
        assert stale.status_code == 409
        body = stale.json()
        # 409 必须带最新全量：前端按 BR-145 拿它做本地合并
        assert body["detail"]
        assert body["canvas"]["id"] == cid
        assert body["canvas"]["version"] == 2

    async def test_meta_patch_does_not_touch_updated_at_or_version(self, client):
        created = (await client.post("/studio/canvases", json={})).json()
        cid = created["id"]
        resp = await client.patch(
            f"/studio/canvases/{cid}/meta",
            json={"title": "改了名", "color": "red", "pinned": True},
        )
        assert resp.status_code == 200
        got = (await client.get(f"/studio/canvases/{cid}")).json()
        assert got["title"] == "改了名" and got["color"] == "red" and got["pinned"] is True
        # BR-146：meta 只改标签，不该把画布顶到列表最前
        assert got["updated_at"] == created["updated_at"]
        assert got["version"] == created["version"]

    async def test_dangling_connections_are_filtered(self, client):
        cid = (await client.post("/studio/canvases", json={})).json()["id"]
        payload = {
            "nodes": [
                {"id": "a", "type": "image", "x": 0, "y": 0},
                {"id": "b", "type": "image", "x": 100, "y": 0},
            ],
            "connections": [
                {"from": "a", "to": "b", "kind": "input"},
                {"from": "a", "to": "ghost"},          # 悬空：目标节点不存在
                {"from": "ghost", "to": "b", "kind": "flow"},
                {"from": "a", "to": "b", "kind": "weird"},  # 不认识的 kind 当 flow
            ],
            "viewport": {"x": 0, "y": 0, "scale": 1},
            "base_version": 1,
        }
        assert (await client.put(f"/studio/canvases/{cid}", json=payload)).status_code == 200
        got = (await client.get(f"/studio/canvases/{cid}")).json()
        assert got["connections"] == [
            {"from": "a", "to": "b", "kind": "input"},
            {"from": "a", "to": "b", "kind": "flow"},
        ]

    async def test_runtime_fields_are_stripped(self, client):
        """BR-143：文档态不存运行态，pending/running 由任务查询接口现算。"""
        cid = (await client.post("/studio/canvases", json={})).json()["id"]
        payload = {
            "nodes": [{
                "id": "n1", "type": "image", "x": 0, "y": 0,
                "status": "running", "pending": True, "queued": 3, "progress": 0.4,
                "task_id": "job-9", "items": [{"asset_id": 5, "kind": "image"}],
            }],
            "connections": [],
            "viewport": {"x": 0, "y": 0, "scale": 1},
            "base_version": 1,
        }
        assert (await client.put(f"/studio/canvases/{cid}", json=payload)).status_code == 200
        node = (await client.get(f"/studio/canvases/{cid}")).json()["nodes"][0]
        for key in ("status", "pending", "queued", "progress", "task_id"):
            assert key not in node
        assert node["items"] == [{"asset_id": 5, "kind": "image"}]

    async def test_node_count_limit(self, client):
        cid = (await client.post("/studio/canvases", json={})).json()["id"]
        payload = {
            "nodes": [{"id": f"n{i}", "type": "image"} for i in range(501)],
            "connections": [], "viewport": {"x": 0, "y": 0, "scale": 1}, "base_version": 1,
        }
        resp = await client.put(f"/studio/canvases/{cid}", json=payload)
        assert resp.status_code == 400
        assert "超上限" in resp.json()["detail"]

    async def test_oversized_node_is_rejected(self, client):
        """单节点 200KB 上限：图片字节该走资产库，不该以 base64 混进文档。"""
        cid = (await client.post("/studio/canvases", json={})).json()["id"]
        payload = {
            "nodes": [{"id": "fat", "type": "prompt", "text": "x" * (201 * 1024)}],
            "connections": [], "viewport": {"x": 0, "y": 0, "scale": 1}, "base_version": 1,
        }
        resp = await client.put(f"/studio/canvases/{cid}", json=payload)
        assert resp.status_code == 400
        assert "过大" in resp.json()["detail"]

    async def test_canvas_llm_forwards_history_and_selected_deployment(
        self, client, monkeypatch
    ):
        created = (await client.post("/studio/canvases", json={})).json()
        captured: dict = {}

        async def fake_complete_text(
            alias, messages, temperature=None, *, deployment_id=None
        ):
            captured.update(
                alias=alias,
                messages=messages,
                temperature=temperature,
                deployment_id=deployment_id,
            )
            return "改写后的提示词"

        async def fake_image_blocks(_session, asset_ids):
            assert asset_ids == [7, 9]
            return [
                {"type": "image_url", "image_url": {"url": "data:image/webp;base64,AA=="}}
            ]

        async def fake_video_blocks(_session, asset_ids):
            assert asset_ids == [31]
            return [
                {"type": "text", "text": "视频 1 的关键帧"},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,BB=="}},
            ]

        monkeypatch.setattr(llm, "complete_text", fake_complete_text)
        monkeypatch.setattr(studio_gpt, "image_blocks", fake_image_blocks)
        monkeypatch.setattr(studio_gpt, "video_blocks", fake_video_blocks)
        response = await client.post(
            "/studio/canvas-llm",
            json={
                "canvas_id": created["id"],
                "node_id": "llm-1",
                "message": "把这句话改成电影感画面",
                "system_prompt": "你是视觉提示词编辑",
                "messages": [
                    {"role": "user", "content": "上一轮"},
                    {"role": "assistant", "content": "上一轮结果"},
                ],
                "image_asset_ids": [7, 9],
                "video_media_asset_ids": [31],
                "deployment_id": 123,
                "temperature": 0.4,
            },
        )
        assert response.status_code == 200
        assert response.json() == {"text": "改写后的提示词"}
        assert captured == {
            "alias": "chat-general",
            "messages": [
                {"role": "system", "content": "你是视觉提示词编辑"},
                {"role": "user", "content": "上一轮"},
                {"role": "assistant", "content": "上一轮结果"},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "把这句话改成电影感画面"},
                        {
                            "type": "image_url",
                            "image_url": {"url": "data:image/webp;base64,AA=="},
                        },
                        {"type": "text", "text": "视频 1 的关键帧"},
                        {
                            "type": "image_url",
                            "image_url": {"url": "data:image/jpeg;base64,BB=="},
                        },
                    ],
                },
            ],
            "temperature": 0.4,
            "deployment_id": 123,
        }

    async def test_canvas_llm_validates_canvas_input_and_provider_failures(
        self, client, monkeypatch
    ):
        missing = await client.post(
            "/studio/canvas-llm",
            json={"canvas_id": 999_999, "node_id": "llm-1", "message": "hello"},
        )
        assert missing.status_code == 404

        created = (await client.post("/studio/canvases", json={})).json()
        blank = await client.post(
            "/studio/canvas-llm",
            json={"canvas_id": created["id"], "node_id": "llm-1", "message": "   "},
        )
        assert blank.status_code == 400
        assert blank.json()["detail"] == "LLM 输入不能为空"

        async def unavailable(*_args, **_kwargs):
            raise llm.LLMUnavailable("模型网关不可用")

        monkeypatch.setattr(llm, "complete_text", unavailable)
        failed = await client.post(
            "/studio/canvas-llm",
            json={"canvas_id": created["id"], "node_id": "llm-1", "message": "hello"},
        )
        assert failed.status_code == 503
        assert failed.json()["detail"] == "模型网关不可用"

    async def test_list_orders_pinned_first_and_computes_summary(self, client):
        a = (await client.post("/studio/canvases", json={"title": "旧"})).json()["id"]
        b = (await client.post("/studio/canvases", json={"title": "新"})).json()["id"]
        payload = {
            "nodes": [
                {"id": "n1", "type": "image",
                 "items": [{"asset_id": 11, "kind": "image"}, {"asset_id": 22, "kind": "image"}]},
                {"id": "n2", "type": "prompt", "text": "词"},
            ],
            "connections": [], "viewport": {"x": 0, "y": 0, "scale": 1}, "base_version": 1,
        }
        assert (await client.put(f"/studio/canvases/{a}", json=payload)).status_code == 200
        await client.patch(f"/studio/canvases/{b}/meta", json={"pinned": True})
        items = (await client.get("/studio/canvases")).json()["items"]
        # 置顶优先；a 虽然内容更新在后，也排在置顶的 b 之后
        assert [row["id"] for row in items] == [b, a]
        row_a = items[1]
        assert row_a["node_count"] == 2
        # 封面 = 最后一个带 asset_id 的 image item
        assert row_a["thumb_asset_id"] == 22

    async def test_trash_restore_purge(self, client):
        cid = (await client.post("/studio/canvases", json={})).json()["id"]
        assert (await client.delete(f"/studio/canvases/{cid}")).status_code == 200
        # 软删后：列表不见、详情 404、回收站可见
        assert cid not in [r["id"] for r in (await client.get("/studio/canvases")).json()["items"]]
        assert (await client.get(f"/studio/canvases/{cid}")).status_code == 404
        trashed = (await client.get("/studio/canvases?trashed=1")).json()["items"]
        assert cid in [r["id"] for r in trashed]
        # 恢复后一切照旧
        assert (await client.post(f"/studio/canvases/{cid}/restore", json={})).status_code == 200
        assert (await client.get(f"/studio/canvases/{cid}")).status_code == 200
        # 物理删除后彻底消失
        assert (await client.delete(f"/studio/canvases/{cid}")).status_code == 200
        assert (await client.delete(f"/studio/canvases/{cid}/purge")).status_code == 200
        assert (await client.get(f"/studio/canvases/{cid}")).status_code == 404
        assert (await client.get("/studio/canvases?trashed=1")).json()["items"] == []

    async def test_trash_older_than_30_days_is_purged_on_list(self, client, session):
        session.add(StudioCanvas(title="过期", deleted_at=datetime.now(UTC) - timedelta(days=31)))
        session.add(StudioCanvas(title="还在", deleted_at=datetime.now(UTC) - timedelta(days=29)))
        await session.commit()
        trashed = (await client.get("/studio/canvases?trashed=1")).json()["items"]
        titles = [r["title"] for r in trashed]
        assert titles == ["还在"]


# ---- 删除记录（陈旧客户端整包写回） ----


def _node(node_id: str, **extra) -> dict:
    return {"id": node_id, "type": "image", "x": 0, "y": 0, **extra}


def _doc(nodes: list[dict], base_version: int, connections: list[dict] | None = None) -> dict:
    return {
        "nodes": nodes,
        "connections": connections or [],
        "viewport": {"x": 0, "y": 0, "scale": 1},
        "base_version": base_version,
    }


class TestCanvasDeletionLog:
    """两个标签页开着同一块画布，A 删掉的节点不许被 B 手里的旧文档带回来。

    实测复现过：A 删掉 ntest0 保存成功，B（陈旧）只是拖了一下别的节点，ntest0 就
    回到了服务端。整包 PUT 下，B 眼里的 ntest0 是「我有、服务端没有」，与「我刚新建
    的节点」在载荷里完全一样，客户端分不出来（前端墓碑只记本端删的，B 没有那条），
    判据只能落在服务端的删除记录上。
    """

    def test_stale_document_loses_only_the_node_that_was_deleted(self):
        """A 删掉 ntest0（保存后是 v3），B 手里还是 v2 那份整包文档。

        ntest0 记在 v3、晚于 B 的 base_version=2 → 是 B 读完画布之后才被删的，丢；
        bnew 没有任何记录 → 是 B 自己新建的，留。
        """
        buried = studio.nodes_deleted_after({"ntest0": 3}, 2)
        assert buried == frozenset({"ntest0"})

        nodes, conns, _ = studio.normalize_canvas_payload(
            [_node("ntest0"), _node("keep"), _node("bnew")],
            [{"from": "ntest0", "to": "keep"}, {"from": "keep", "to": "bnew"}],
            None,
            drop_ids=buried,
        )
        assert [n["id"] for n in nodes] == ["keep", "bnew"]
        # 丢掉的节点带走的连线由既有悬空过滤兜住，不必另记一份边的墓碑
        assert conns == [{"from": "keep", "to": "bnew", "kind": "flow"}]

    def test_recreated_node_is_not_blocked(self):
        """记录不晚于 base_version 的不能丢：那是客户端读到删除之后又建出来的同 id 节点。

        ⌘Z 撤销走的就是这条——删掉 n1 的那次保存产出 v3，客户端手里也是 v3，
        撤销后以 base_version=3 重存，3 不晚于 3，节点留下。
        """
        assert studio.nodes_deleted_after({"n1": 3}, 3) == frozenset()
        assert studio.nodes_deleted_after({"n1": 3}, 4) == frozenset()

    def test_log_only_covers_nodes_that_are_gone(self):
        """活着的节点不许留记录，否则更旧的客户端会把这个活节点再删一次。"""
        log = studio.record_node_deletions(
            {"n1": 3}, before_ids=["n1", "n2"], after_ids=["n1"], version=5
        )
        assert log == {"n2": 5}

    def test_log_is_bounded_and_drops_the_oldest(self):
        """满了扔最旧的：记录越旧，还没同步到它的客户端越少。"""
        crowded = {f"n{i}": i for i in range(1, 601)}
        log = studio.record_node_deletions(crowded, before_ids=[], after_ids=[], version=999)
        assert len(log) == studio.MAX_DELETED_NODES
        assert min(log.values()) == 601 - studio.MAX_DELETED_NODES
        assert "n600" in log and "n1" not in log

    async def test_save_records_what_disappeared(self, client):
        cid = (await client.post("/studio/canvases", json={})).json()["id"]
        both = [_node("ntest0"), _node("keep")]
        assert (await client.put(f"/studio/canvases/{cid}", json=_doc(both, 1))).status_code == 200
        assert (
            await client.put(f"/studio/canvases/{cid}", json=_doc([_node("keep")], 2))
        ).status_code == 200

        got = (await client.get(f"/studio/canvases/{cid}")).json()
        assert [n["id"] for n in got["nodes"]] == ["keep"]
        # 记的是这次保存后的新版本：只有 base_version 更小的客户端才可能再送它回来
        assert got["deleted_nodes"]["ntest0"] == 3
        assert "keep" not in got["deleted_nodes"]

    async def test_stale_save_is_told_which_nodes_are_buried(self, client):
        """409 必须把「你读完之后被删掉的」名单交出去。

        前端合并完会以最新 version 重存，那一刻 base_version 已经被洗成最新的，
        服务端再也认不出这批节点是旧副本——只有这一刻还分得清。
        """
        cid = (await client.post("/studio/canvases", json={})).json()["id"]
        both = [_node("ntest0"), _node("keep")]
        await client.put(f"/studio/canvases/{cid}", json=_doc(both, 1))
        await client.put(f"/studio/canvases/{cid}", json=_doc([_node("keep")], 2))

        # B 还拿着 v2 的文档：拖了一下 keep，顺手把 ntest0 整包送了回来
        stale = await client.put(
            f"/studio/canvases/{cid}",
            json=_doc([_node("ntest0"), _node("keep", x=88), _node("bnew")], 2),
        )
        assert stale.status_code == 409
        body = stale.json()
        assert body["buried_nodes"] == ["ntest0"]
        assert "bnew" not in body["buried_nodes"]  # B 自己新建的不在名单里
        assert body["canvas"]["deleted_nodes"]["ntest0"] == 3
        # 冲突这一次什么都没写，服务端仍然没有 ntest0
        got = (await client.get(f"/studio/canvases/{cid}")).json()
        assert [n["id"] for n in got["nodes"]] == ["keep"]

    async def test_undo_puts_the_same_node_id_back(self, client):
        """⌘Z 重建同 id 不能被挡住，重建之后它的记录也要跟着消失。"""
        cid = (await client.post("/studio/canvases", json={})).json()["id"]
        both = [_node("n1"), _node("keep")]
        await client.put(f"/studio/canvases/{cid}", json=_doc(both, 1))
        await client.put(f"/studio/canvases/{cid}", json=_doc([_node("keep")], 2))
        logged = (await client.get(f"/studio/canvases/{cid}")).json()["deleted_nodes"]
        assert logged["n1"] == 3

        # 撤销：删除产出的是 v3，客户端手里也是 v3
        undo = await client.put(f"/studio/canvases/{cid}", json=_doc(both, 3))
        assert undo.status_code == 200
        got = (await client.get(f"/studio/canvases/{cid}")).json()
        assert sorted(n["id"] for n in got["nodes"]) == ["keep", "n1"]
        assert "n1" not in got["deleted_nodes"]

        # 记录清干净了，下一次保存不会再把它当旧副本丢掉
        again = await client.put(f"/studio/canvases/{cid}", json=_doc(both, 4))
        assert again.status_code == 200
        assert sorted(
            n["id"] for n in (await client.get(f"/studio/canvases/{cid}")).json()["nodes"]
        ) == ["keep", "n1"]


# ---- 对话生图 ----


class TestChat:
    async def test_create_save_and_conflict(self, client):
        created = (await client.post("/studio/chats", json={"title": "换风格实验"})).json()
        cid = created["id"]
        assert created["version"] == 1 and created["turns"] == []
        turns = [
            {"role": "user", "text": "画一只猫", "ref_asset_ids": [1]},
            {"role": "assistant", "asset_ids": [3, 7], "latency_ms": 1200},
        ]
        resp = await client.put(f"/studio/chats/{cid}", json={"turns": turns, "base_version": 1})
        assert resp.status_code == 200 and resp.json()["version"] == 2
        stale = await client.put(f"/studio/chats/{cid}", json={"turns": turns, "base_version": 1})
        assert stale.status_code == 409
        assert stale.json()["chat"]["version"] == 2

    async def test_turn_limit_and_text_limit(self, client):
        cid = (await client.post("/studio/chats", json={})).json()["id"]
        too_many = [{"role": "user", "text": "hi"}] * 401
        resp = await client.put(f"/studio/chats/{cid}", json={"turns": too_many, "base_version": 1})
        assert resp.status_code == 400 and "回合数" in resp.json()["detail"]
        long_text = [{"role": "user", "text": "字" * 4001}]
        resp = await client.put(
            f"/studio/chats/{cid}", json={"turns": long_text, "base_version": 1}
        )
        assert resp.status_code == 400 and "文本" in resp.json()["detail"]

    async def test_runtime_fields_dropped_from_turns(self, client):
        cid = (await client.post("/studio/chats", json={})).json()["id"]
        turns = [{"role": "assistant", "asset_ids": [9], "pending": True, "status": "running"}]
        assert (
            await client.put(f"/studio/chats/{cid}", json={"turns": turns, "base_version": 1})
        ).status_code == 200
        saved = (await client.get(f"/studio/chats/{cid}")).json()["turns"][0]
        assert saved == {"role": "assistant", "asset_ids": [9]}

    async def test_meta_patch_keeps_updated_at_and_version(self, client):
        created = (await client.post("/studio/chats", json={})).json()
        cid = created["id"]
        assert (
            await client.patch(f"/studio/chats/{cid}/meta", json={"title": "命名", "pinned": True})
        ).status_code == 200
        got = (await client.get(f"/studio/chats/{cid}")).json()
        assert got["title"] == "命名"
        assert got["updated_at"] == created["updated_at"]
        assert got["version"] == created["version"]

    async def test_list_summary_and_delete(self, client):
        cid = (await client.post("/studio/chats", json={})).json()["id"]
        turns = [
            {"role": "user", "text": "来"},
            {"role": "assistant", "asset_ids": [3, 7]},
            {"role": "assistant", "error": "上游超时"},  # 失败回合没有产图
        ]
        await client.put(f"/studio/chats/{cid}", json={"turns": turns, "base_version": 1})
        items = (await client.get("/studio/chats")).json()["items"]
        row = next(r for r in items if r["id"] == cid)
        assert row["turn_count"] == 3
        # 封面取最后一张真实产图：最后一个 assistant 回合失败了，就往前找
        assert row["last_asset_id"] == 7
        assert (await client.delete(f"/studio/chats/{cid}")).status_code == 200
        assert (await client.get(f"/studio/chats/{cid}")).status_code == 404


# ---- /images/edit 的资产直引（BR-144） ----


class TestEditWithRefAssets:
    @pytest.fixture
    def captured_edit(self, monkeypatch):
        calls: list[dict] = []

        async def fake_edit(
            prompt,
            *,
            alias,
            images,
            mask=None,
            size=None,
            quality="medium",
            n=1,
            input_fidelity=None,
            route=None,
        ):
            calls.append({
                "prompt": prompt, "alias": alias, "images": images,
                "mask": mask, "size": size, "quality": quality, "n": n,
                "input_fidelity": input_fidelity,
            })
            return imagegen.RenderResult(images=[noise_png()], model_reported="fake", latency_ms=5)

        monkeypatch.setattr(imagegen, "edit_images", fake_edit)
        return calls

    async def test_ref_asset_bytes_are_read_from_storage(
        self, client, session, fake_storage, captured_edit
    ):
        data = noise_png()
        asset = await seed_asset(session, fake_storage, data)
        resp = await client.post(
            "/images/edit",
            data={"prompt": "换个黄昏光线", "app_key": "image_to_image",
                  "ref_asset_ids": str(asset.id)},
        )
        assert resp.status_code == 201, resp.text
        # 字节从存储直读，文件名按 asset-{id}.png 约定
        assert captured_edit[0]["images"] == [(f"asset-{asset.id}.png", data)]
        # parent 缺省取第一个直引资产：血缘不断（BR-117）
        assert resp.json()["items"][0]["parent_id"] == asset.id

    async def test_uploads_and_refs_are_combined(
        self, client, session, fake_storage, captured_edit
    ):
        ref = await seed_asset(session, fake_storage, noise_png())
        upload = noise_png()
        resp = await client.post(
            "/images/edit",
            data={"prompt": "把它们融成一张", "app_key": "image_fusion",
                  "ref_asset_ids": str(ref.id)},
            files=[("images", ("up.png", upload, "image/png"))],
        )
        # 多图融合要「合计 ≥2」：一上传 + 一直引应当通过
        assert resp.status_code == 201, resp.text
        names = [name for name, _ in captured_edit[0]["images"]]
        assert names == ["up.png", f"asset-{ref.id}.png"]

    async def test_consistency_edit_passes_high_fidelity(
        self, client, session, fake_storage, captured_edit
    ):
        ref = await seed_asset(session, fake_storage, noise_png())
        resp = await client.post(
            "/images/edit",
            data={
                "prompt": "保持同一个角色，只改表情",
                "app_key": "consistent_edit",
                "ref_asset_ids": str(ref.id),
            },
        )
        assert resp.status_code == 201, resp.text
        assert captured_edit[0]["input_fidelity"] == "high"

    async def test_missing_ref_asset_reports_which_id(self, client, fake_storage, captured_edit):
        resp = await client.post(
            "/images/edit",
            data={"prompt": "改", "app_key": "image_to_image", "ref_asset_ids": "9999"},
        )
        assert resp.status_code == 404
        assert "9999" in resp.json()["detail"]
        assert captured_edit == []

    async def test_no_inputs_at_all_is_rejected(self, client, fake_storage, captured_edit):
        resp = await client.post(
            "/images/edit", data={"prompt": "改", "app_key": "image_to_image"}
        )
        assert resp.status_code == 400
        assert captured_edit == []

    async def test_fusion_still_requires_two_in_total(
        self, client, session, fake_storage, captured_edit
    ):
        ref = await seed_asset(session, fake_storage, noise_png())
        resp = await client.post(
            "/images/edit",
            data={"prompt": "融合", "app_key": "image_fusion", "ref_asset_ids": str(ref.id)},
        )
        assert resp.status_code == 400
        assert "两张" in resp.json()["detail"]

    async def test_async_edit_survives_request_and_finishes_in_worker(
        self,
        client,
        session,
        session_factory,
        fake_storage,
        captured_edit,
        monkeypatch,
    ):
        class FakeQueue:
            def __init__(self):
                self.calls: list[tuple] = []

            async def enqueue_job(self, *args):
                self.calls.append(args)

        queue = FakeQueue()

        async def fake_queue():
            return queue

        monkeypatch.setattr("app.routers.images.get_queue", fake_queue)
        monkeypatch.setattr("worker.tasks.SessionFactory", session_factory)
        ref = await seed_asset(session, fake_storage, noise_png())
        resp = await client.post(
            "/images/edit-jobs",
            data={
                "prompt": "保持角色，换成黄昏光线",
                "app_key": "consistent_edit",
                "ref_asset_ids": str(ref.id),
                "tool_id": "chat-image",
                "source_route": "/studio/chat/7",
                "source_context": '{"chat_id": 7}',
            },
        )
        assert resp.status_code == 202, resp.text
        task_id = resp.json()["studio_task_id"]
        assert queue.calls == [("edit_image_task", task_id)]

        queued = (await client.get(f"/studio/tasks/{task_id}")).json()
        assert queued["status"] == "queued"
        assert queued["tool_id"] == "chat-image"
        assert queued["source_context"] == {"chat_id": 7}
        assert queued["invocation"]["ref_asset_ids"] == [ref.id]

        result = await edit_image_task({}, task_id)
        assert result["ok"] is True
        finished = (await client.get(f"/studio/tasks/{task_id}")).json()
        assert finished["status"] == "succeeded"
        assert finished["result"]["asset_ids"] == result["asset_ids"]
        generated = await session.get(ImageAsset, result["asset_ids"][0])
        assert generated is not None
        assert generated.parent_id == ref.id
        assert captured_edit[0]["images"][0][0] == f"asset-{ref.id}.png"
        assert captured_edit[0]["input_fidelity"] == "high"


# ---- imagegen：size=None 不向上游发 size（auto 语义） ----


class TestEditImagesSizeParam:
    @pytest.fixture
    def fake_client(self, monkeypatch):
        calls: list[dict] = []

        class _Images:
            async def edit(self, **kwargs):
                calls.append(kwargs)
                return SimpleNamespace(
                    data=[SimpleNamespace(b64_json=base64.b64encode(noise_png()).decode())],
                    model="fake-model",
                    usage=None,
                )

        class _Client:
            images = _Images()

            async def close(self):
                pass

        monkeypatch.setattr(
            imagegen, "route_client", lambda route: (_Client(), "fake-model")
        )
        return calls

    @staticmethod
    def _route() -> ResolvedModelRoute:
        """能力必须有部署才走得到线协议：未绑定时 edit_images 直接抛「未绑定」。"""
        return ResolvedModelRoute(
            deployment_id=1,
            adapter_type="openai",
            upstream_model_id="fake-model",
            provider_type="openai_compatible",
            credential_config={"api_base": "https://direct.example/v1", "api_key": "sk-x"},
            protocol_options={},
        )

    async def test_size_none_is_not_sent_upstream(self, fake_client):
        await imagegen.edit_images(
            "p", alias="image-free", images=[("a.png", b"x")], size=None, route=self._route()
        )
        assert "size" not in fake_client[0]

    async def test_explicit_size_is_sent(self, fake_client):
        await imagegen.edit_images(
            "p",
            alias="image-free",
            images=[("a.png", b"x")],
            size="1024x1024",
            route=self._route(),
        )
        assert fake_client[0]["size"] == "1024x1024"

    async def test_openai_adapter_uses_exact_upstream_model(self, monkeypatch):
        calls: list[dict] = []
        client_args: list[dict] = []

        class _Images:
            async def edit(self, **kwargs):
                calls.append(kwargs)
                return SimpleNamespace(
                    data=[SimpleNamespace(b64_json=base64.b64encode(noise_png()).decode())],
                    model="gpt-image-2",
                    usage=None,
                )

        class _Client:
            images = _Images()

            async def close(self):
                return None

        def fake_openai(**kwargs):
            client_args.append(kwargs)
            return _Client()

        monkeypatch.setattr(imagegen, "AsyncOpenAI", fake_openai)
        route = ResolvedModelRoute(
            deployment_id=7,
            adapter_type="openai",
            upstream_model_id="gpt-image-2",
            provider_type="openai_compatible",
            credential_config={
                "api_base": "https://images.example.invalid/v1",
                "api_key": "sk-test",
            },
            protocol_options={},
        )
        await imagegen.edit_images(
            "p",
            alias="image-free",
            images=[("a.png", b"x")],
            route=route,
        )
        assert calls[0]["model"] == "gpt-image-2"
        assert str(client_args[0]["base_url"]) == "https://images.example.invalid/v1"


# ---- 领域层零碎 ----


class TestNormalize:
    def test_nodes_without_id_are_dropped(self):
        nodes, conns, _ = studio.normalize_canvas_payload(
            [{"type": "image"}, {"id": "ok", "type": "image"}], [], None
        )
        assert [n["id"] for n in nodes] == ["ok"]

    def test_viewport_bad_values_fall_back_to_none(self):
        _, _, viewport = studio.normalize_canvas_payload([], [], {"x": "abc", "scale": 1})
        assert viewport is None

    def test_chat_turn_role_whitelist(self):
        turns = studio.normalize_chat_turns(
            [{"role": "system", "text": "越权"}, {"role": "user", "text": "好"}]
        )
        assert [t["role"] for t in turns] == ["user"]

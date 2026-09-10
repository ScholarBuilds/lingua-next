"""创作工坊 M4：工作流模板 / 视频抽帧 / 打标队列（FR-482~484）。

守的是几条会静默出错的约束：

- **字节不进 JSONB**（BR-101/BR-140）：轻量模板只存 sha256；资产化工作流把原始
  字节写入对象存储中的 ZIP，图片库清理后可由包重建。
- **不在库就照实标缺失**（BR-110）：轻量模板找不到图时标 `missing`，不拿别的图
  顶上；只有随包 ZIP 确实带了原字节时 `rebuilt` 才增长。
- **id 重映射两端同改**：漏改 connections 的一端就是一堆连不上的悬空边，
  而画布上「边没画出来」在自动化环境里恰好是已记档的假象，肉眼分不出真假。
- **一帧失败不拖垮整批**：抽 12 帧挂第 7 帧，前 6 帧是好图，退回去只会让人重抽。
- **进度是真实计数**：done/failed 各自是真跑完的条数，不按时间估。

抽帧全程 monkeypatch `_ffmpeg_frame`，**不真跑二进制**；命令拼装单独断言
（`-ss` 放 `-i` 前后都不报错，差别只是快十倍还是慢十倍，肉眼看不出来）。
打标队列用内存版 Redis 替身，真跑 set/get/enqueue 那条路径，只是不连服务。
"""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from urllib.parse import unquote

import pytest

from domain import storage as storage_mod
from domain import studio_assets, studio_frames, studio_templates
from domain.models import ImageAsset, StudioMediaAsset, StudioTemplate, Video
from tests.test_studio import FakeStorage, noise_png, seed_asset


@pytest.fixture
def fake_storage():
    fake = FakeStorage()
    storage_mod.set_storage(fake)
    yield fake
    storage_mod.set_storage(None)


class PathStorage(FakeStorage):
    """带本地路径的存储替身：抽帧靠 `local_path()` 把路径交给 ffmpeg。"""

    def __init__(self, path) -> None:
        super().__init__()
        self._path = path

    def local_path(self, key: str):
        return self._path


# ---- 工作流模板 ----


def _nodes_with(asset_ids: list[int]) -> list[dict]:
    return [
        {
            "id": "n1",
            "type": "image",
            "x": 500,
            "y": 400,
            "items": [{"asset_id": aid, "kind": "image", "w": 64, "h": 64} for aid in asset_ids],
            "prompt_draft": "换成晨景",
            # 运行态字段：存模板时该被剥掉（BR-143）
            "running": True,
        },
        {"id": "n2", "type": "prompt", "x": 700, "y": 400, "text": "暖色调"},
    ]


class TestTemplateSave:
    async def test_asset_id_becomes_sha_and_bytes_stay_out(
        self, client, session, fake_storage
    ):
        """存模板：节点里的 asset_id 换成 sha256，字节一个都不进 payload。"""
        assets = [await seed_asset(session, fake_storage, noise_png()) for _ in range(2)]
        body = {
            "name": "晨景改图",
            "note": "两张参考 + 一个提示词节点",
            "nodes": _nodes_with([a.id for a in assets]),
            "connections": [{"from": "n2", "to": "n1", "kind": "input"}],
        }
        created = (await client.post("/studio/templates", json=body)).json()
        assert created["name"] == "晨景改图"
        assert created["node_count"] == 2
        assert created["asset_count"] == 2

        row = await session.get(StudioTemplate, created["id"])
        payload = row.payload
        items = payload["nodes"][0]["items"]
        assert [i["sha256"] for i in items] == [a.sha256 for a in assets]
        assert all("asset_id" not in i for i in items)  # id 是本库的，换环境就指错图
        assert "running" not in payload["nodes"][0]  # 运行态剥掉

        meta = payload["assets"]
        assert [m["sha256"] for m in meta] == [a.sha256 for a in assets]
        assert meta[0]["width"] == 64 and meta[0]["mime"] == "image/png"
        assert meta[0]["prompt"] == "seed"

        raw = json.dumps(payload, ensure_ascii=False)
        assert "base64" not in raw and len(raw) < 4000  # 字节没混进来

    async def test_empty_nodes_rejected(self, client):
        resp = await client.post("/studio/templates", json={"name": "空的", "nodes": []})
        assert resp.status_code == 422

    async def test_blank_name_rejected(self, client):
        resp = await client.post(
            "/studio/templates", json={"name": "   ", "nodes": [{"id": "n1", "type": "image"}]}
        )
        assert resp.status_code == 400
        assert "不能为空" in resp.json()["detail"]

    async def test_dangling_edge_dropped(self, client):
        """删节点漏删边是前端常态，静默过滤而不是让保存失败。"""
        body = {
            "name": "带悬空边",
            "nodes": [{"id": "n1", "type": "image", "x": 0, "y": 0}],
            "connections": [{"from": "n1", "to": "ghost", "kind": "flow"}],
        }
        created = (await client.post("/studio/templates", json=body)).json()
        applied = (await client.post(f"/studio/templates/{created['id']}/apply", json={})).json()
        assert applied["connections"] == []

    async def test_list_and_delete(self, client):
        first = (
            await client.post(
                "/studio/templates", json={"name": "甲", "nodes": [{"id": "a", "type": "image"}]}
            )
        ).json()
        (
            await client.post(
                "/studio/templates", json={"name": "乙", "nodes": [{"id": "b", "type": "image"}]}
            )
        )
        items = (await client.get("/studio/templates")).json()["items"]
        assert [t["name"] for t in items] == ["乙", "甲"]  # 新的在前

        assert (await client.delete(f"/studio/templates/{first['id']}")).json() == {"ok": True}
        assert [t["name"] for t in (await client.get("/studio/templates")).json()["items"]] == [
            "乙"
        ]
        assert (await client.delete("/studio/templates/9999")).status_code == 404
        assert (await client.post("/studio/templates/9999/apply", json={})).status_code == 404

    async def test_assetized_workflow_keeps_zip_rebuilds_and_downloads(
        self, client, session, fake_storage
    ):
        asset = await seed_asset(session, fake_storage, noise_png())
        original_key = asset.storage_key
        created_response = await client.post(
            "/studio/templates",
            json={
                "name": "可搬家的工作流",
                "nodes": _nodes_with([asset.id]),
                "connections": [{"from": "n2", "to": "n1", "kind": "input"}],
                "include_resources": True,
            },
        )
        assert created_response.status_code == 201, created_response.text
        created = created_response.json()
        assert created["packaged"] is True
        assert created["resource_count"] == 1
        assert created["package_bytes"] > 0

        row = await session.get(StudioTemplate, created["id"])
        package_key = row.payload["package"]["storage_key"]
        assert package_key in fake_storage.blobs
        with zipfile.ZipFile(io.BytesIO(fake_storage.blobs[package_key])) as bundle:
            assert "workflow.json" in bundle.namelist()
            assert any(name.startswith("resources/image-") for name in bundle.namelist())

        # 原资产与字节都清掉，应用资产化工作流仍应从随包 ZIP 重建。
        await session.delete(asset)
        await session.commit()
        await fake_storage.delete(original_key)
        applied_response = await client.post(f"/studio/templates/{created['id']}/apply", json={})
        assert applied_response.status_code == 200, applied_response.text
        applied = applied_response.json()
        assert applied["rebuilt"] == 1
        assert applied["missing"] == []
        assert applied["nodes"][0]["items"][0]["asset_id"] > 0

        renamed = (
            await client.patch(
                f"/studio/templates/{created['id']}",
                json={"name": "已重命名工作流"},
            )
        ).json()
        assert renamed["name"] == "已重命名工作流"

        downloaded = await client.post(f"/studio/templates/{created['id']}/download")
        assert downloaded.status_code == 200
        assert "已重命名工作流.zip" in unquote(downloaded.headers["content-disposition"])
        with zipfile.ZipFile(io.BytesIO(downloaded.content)) as bundle:
            assert "workflow.json" in bundle.namelist()

        imported_response = await client.post(
            "/studio/templates/import",
            files={"file": ("roundtrip.zip", downloaded.content, "application/zip")},
        )
        assert imported_response.status_code == 201, imported_response.text
        imported = imported_response.json()
        assert imported["name"] == "roundtrip"
        assert imported["packaged"] is True

        batch = await client.post(
            "/studio/templates/download",
            json={"ids": [created["id"], imported["id"]]},
        )
        assert batch.status_code == 200
        with zipfile.ZipFile(io.BytesIO(batch.content)) as bundle:
            assert len(bundle.namelist()) == 2
            assert all(name.endswith(".zip") for name in bundle.namelist())

        assert (await client.delete(f"/studio/templates/{created['id']}")).status_code == 200
        assert package_key not in fake_storage.blobs


class TestTemplateApply:
    async def _save(self, client, session, fake_storage, count: int = 2):
        assets = [await seed_asset(session, fake_storage, noise_png()) for _ in range(count)]
        body = {
            "name": "复用测试",
            "nodes": _nodes_with([a.id for a in assets]),
            "connections": [{"from": "n2", "to": "n1", "kind": "input"}],
        }
        created = (await client.post("/studio/templates", json=body)).json()
        return created, assets

    async def test_reuses_existing_assets(self, client, session, fake_storage):
        """库里有同 sha 的图就直接复用，不重复落盘。"""
        created, assets = await self._save(client, session, fake_storage)
        applied = (await client.post(f"/studio/templates/{created['id']}/apply", json={})).json()

        items = applied["nodes"][0]["items"]
        assert [i["asset_id"] for i in items] == [a.id for a in assets]
        assert all("sha256" not in i for i in items)
        assert applied["reused"] == 2
        assert applied["rebuilt"] == 0
        assert applied["missing"] == []
        assert applied["missing_note"] == ""

    async def test_missing_asset_is_reported_not_faked(self, client, session, fake_storage):
        """库里没有的图照实标缺失：不拿别的图顶上，rebuilt 留 0（BR-110）。"""
        created, assets = await self._save(client, session, fake_storage)
        gone = await session.get(ImageAsset, assets[1].id)
        gone_sha = gone.sha256
        await session.delete(gone)
        await session.commit()

        applied = (await client.post(f"/studio/templates/{created['id']}/apply", json={})).json()
        items = applied["nodes"][0]["items"]
        assert items[0]["asset_id"] == assets[0].id
        assert "asset_id" not in items[1] and items[1]["missing"] is True
        assert applied["reused"] == 1
        assert applied["rebuilt"] == 0
        assert applied["missing"] == [{"node_id": applied["nodes"][0]["id"], "sha256": gone_sha}]
        assert applied["missing_note"]
        # 缺的那张的元信息还在模板里，但那只是宽高与提示词，不是图
        assert "放大" not in applied["missing_note"]

    async def test_ids_remapped_and_connections_follow(self, client, session, fake_storage):
        """id 换了，连线两端要跟着换——漏改一端就是画不出来的悬空边。"""
        created, _ = await self._save(client, session, fake_storage)
        applied = (await client.post(f"/studio/templates/{created['id']}/apply", json={})).json()

        new_ids = [n["id"] for n in applied["nodes"]]
        assert new_ids[0] != "n1" and new_ids[1] != "n2"
        assert new_ids[0].endswith("-n1") and new_ids[1].endswith("-n2")
        assert applied["connections"] == [
            {"from": new_ids[1], "to": new_ids[0], "kind": "input"}
        ]

        # 同一份模板导两次，两批 id 必须互不相干（否则第二次导入会覆盖第一次）
        again = (await client.post(f"/studio/templates/{created['id']}/apply", json={})).json()
        assert set(new_ids).isdisjoint({n["id"] for n in again["nodes"]})

    async def test_member_ids_and_history_for_remapped(self, client):
        """group 的成员引用与历史分组的回指也是 id，一样要跟着换。"""
        body = {
            "name": "组与历史",
            "nodes": [
                {"id": "g1", "type": "group", "x": 0, "y": 0, "member_ids": ["p1", "ghost"]},
                {"id": "p1", "type": "prompt", "x": 10, "y": 0, "text": "x"},
                {"id": "h1", "type": "image", "x": 20, "y": 0, "history_for": "p1"},
            ],
            "connections": [],
        }
        created = (await client.post("/studio/templates", json=body)).json()
        applied = (await client.post(f"/studio/templates/{created['id']}/apply", json={})).json()
        by_suffix = {n["id"].rsplit("-", 1)[-1]: n["id"] for n in applied["nodes"]}
        assert applied["nodes"][0]["member_ids"] == [by_suffix["p1"]]  # ghost 被丢掉
        assert applied["nodes"][2]["history_for"] == by_suffix["p1"]

    async def test_coordinates_shifted_as_a_block(self, client, session, fake_storage):
        """整体平移：子图内部相对位置不变，左上角落到指定落点。"""
        created, _ = await self._save(client, session, fake_storage)
        applied = (await client.post(f"/studio/templates/{created['id']}/apply", json={})).json()
        xs = [n["x"] for n in applied["nodes"]]
        ys = [n["y"] for n in applied["nodes"]]
        assert min(xs) == studio_templates.APPLY_ORIGIN_X
        assert min(ys) == studio_templates.APPLY_ORIGIN_Y
        assert xs[1] - xs[0] == 200  # 原来就是 500 与 700

        custom = (
            await client.post(
                f"/studio/templates/{created['id']}/apply",
                json={"offset_x": 1000, "offset_y": -50},
            )
        ).json()
        assert min(n["x"] for n in custom["nodes"]) == 1000
        assert min(n["y"] for n in custom["nodes"]) == -50


# ---- 视频抽帧 ----


async def _seed_video(session, *, title="示例视频", status="ready", duration=120) -> Video:
    row = Video(
        title=title, file_key="videos/demo.mp4", status=status, duration_s=duration
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def _seed_studio_video(
    session, *, name="工坊出片.mp4", duration_ms=8000, status="active", kind="video"
) -> StudioMediaAsset:
    key = f"studio-media/{kind}/{name}"
    row = StudioMediaAsset(
        kind=kind,
        name=name,
        mime="video/mp4" if kind == "video" else "audio/mpeg",
        sha256=hashlib.sha256(key.encode()).hexdigest(),
        storage_key=key,
        bytes=1024,
        duration_ms=duration_ms,
        status=status,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


@pytest.fixture
def video_file(tmp_path):
    path = tmp_path / "demo.mp4"
    path.write_bytes(b"not a real video, ffmpeg is stubbed")
    return path


@pytest.fixture
def frame_storage(video_file):
    fake = PathStorage(video_file)
    storage_mod.set_storage(fake)
    yield fake
    storage_mod.set_storage(None)


class KeyedPathStorage(FakeStorage):
    """按 storage key 给不同本地路径的替身。

    片源撞车只有在「两个 key 指向两个文件」时才测得出来：所有 key 都回同一个
    路径的话，取错片源的用例也会通过。
    """

    def __init__(self, paths: dict) -> None:
        super().__init__()
        self.paths = paths

    def local_path(self, key: str):
        return self.paths.get(key)


@pytest.fixture
def two_source_storage(tmp_path):
    """学习库与工坊各一个真实存在的文件，路径不同。"""
    library = tmp_path / "library.mp4"
    studio = tmp_path / "studio.mp4"
    library.write_bytes(b"library video, ffmpeg is stubbed")
    studio.write_bytes(b"studio video, ffmpeg is stubbed")
    fake = KeyedPathStorage({"videos/demo.mp4": library, "studio-media/video/撞车.mp4": studio})
    storage_mod.set_storage(fake)
    yield {"library": library, "studio": studio}
    storage_mod.set_storage(None)


@pytest.fixture
def stub_ffmpeg(monkeypatch):
    """打掉真二进制：记录每次调用的 (路径, 秒数)，回一张噪点 PNG。"""
    calls: list[tuple[str, float]] = []

    def _fake(path, at_s):
        calls.append((str(path), at_s))
        return noise_png()

    monkeypatch.setattr(studio_frames, "_ffmpeg_frame", _fake)
    monkeypatch.setattr(studio_frames.shutil, "which", lambda name: f"/usr/bin/{name}")
    return calls


class TestFrameCommand:
    def test_seek_before_input(self):
        """`-ss` 必须在 `-i` 前：放后面要从头解码到那一秒，长片慢十倍且不报错。"""
        cmd = studio_frames.frame_command("/tmp/a.mp4", 12.5)
        assert cmd[0] == "ffmpeg"
        assert cmd.index("-ss") < cmd.index("-i")
        assert cmd[cmd.index("-ss") + 1] == "12.500"
        assert cmd[cmd.index("-i") + 1] == "/tmp/a.mp4"
        assert cmd[cmd.index("-frames:v") + 1] == "1"
        assert cmd[-1] == "pipe:1"

    def test_seconds_formatting(self):
        assert studio_frames.fmt_seconds(12.0) == "12"
        assert studio_frames.fmt_seconds(1.5) == "1.5"


class TestFrameSources:
    async def test_only_downloaded_videos_listed(self, client, session):
        ready = await _seed_video(session, title="已就绪")
        degraded = await _seed_video(session, title="产物不达标", status="degraded")
        session.add(Video(title="还没下完", status="downloading"))
        session.add(Video(title="只有字幕", file_key=None, status="ready"))
        await session.commit()

        items = (await client.get("/studio/frames/videos")).json()["items"]
        library = [v for v in items if v["source"] == "library"]
        assert {v["id"] for v in library} == {ready.id, degraded.id}
        assert library[0]["duration_s"] == 120
        assert set(library[0]) == {"source", "id", "ref", "title", "duration_s", "stream_url"}

    async def test_studio_media_videos_listed_too(self, client, session):
        """工坊自己生成或上传的视频也是片源（本轮补的缺口）。"""
        library = await _seed_video(session, title="学习库的片子")
        studio = await _seed_studio_video(session, name="工坊出片.mp4", duration_ms=8500)
        await _seed_studio_video(session, name="已归档.mp4", status="archived")
        await session.commit()

        items = (await client.get("/studio/frames/videos")).json()["items"]
        by_ref = {item["ref"]: item for item in items}
        assert f"library:{library.id}" in by_ref
        assert f"studio:{studio.id}" in by_ref
        assert "已归档.mp4" not in {item["title"] for item in items}
        # 毫秒转秒：不转的话「超过视频时长」会差一千倍
        assert by_ref[f"studio:{studio.id}"]["duration_s"] == 8.5
        # 播放地址由服务端给，两个片源各走各的接口
        assert by_ref[f"library:{library.id}"]["stream_url"] == f"/api/videos/{library.id}/stream"
        assert (
            by_ref[f"studio:{studio.id}"]["stream_url"]
            == f"/api/studio/media-assets/{studio.id}/content"
        )

    async def test_only_video_kind_from_studio(self, client, session):
        """音频与通用文件不是片源。"""
        await _seed_studio_video(session, name="旁白.mp3", kind="audio")
        items = (await client.get("/studio/frames/videos")).json()["items"]
        assert items == []


class TestFrameExtract:
    async def test_each_second_ingested(self, client, session, frame_storage, stub_ffmpeg):
        video = await _seed_video(session, title="威尼斯清晨")
        resp = await client.post(
            "/studio/frames/extract",
            json={"source": "library", "video_id": video.id, "at_seconds": [1.5, 30]},
        )
        body = resp.json()
        assert resp.status_code == 200
        assert body["failed"] == []
        assert [i["at_s"] for i in body["items"]] == [1.5, 30.0]
        assert [c[1] for c in stub_ffmpeg] == [1.5, 30.0]
        assert stub_ffmpeg[0][0].endswith("demo.mp4")

        # 真入库（BR-140）：资产在模块 16 的库里，带 source 与提示词
        rows = [await session.get(ImageAsset, i["asset_id"]) for i in body["items"]]
        assert [r.source for r in rows] == ["frame", "frame"]
        assert [r.target_key for r in rows] == ["free", "free"]
        assert [r.prompt for r in rows] == ["威尼斯清晨 @ 1.5s", "威尼斯清晨 @ 30s"]
        assert all(i["url"].startswith("/api/images/assets/") for i in body["items"])

    async def test_one_failure_does_not_break_the_batch(
        self, client, session, frame_storage, monkeypatch
    ):
        video = await _seed_video(session)

        def _flaky(path, at_s):
            if at_s == 2.0:
                raise studio_frames.StudioFrameError("ffmpeg 失败（1）：Invalid data found")
            return noise_png()

        monkeypatch.setattr(studio_frames, "_ffmpeg_frame", _flaky)
        monkeypatch.setattr(studio_frames.shutil, "which", lambda name: "/usr/bin/ffmpeg")

        body = (
            await client.post(
                "/studio/frames/extract",
                json={"source": "library", "video_id": video.id, "at_seconds": [1, 2, 3]},
            )
        ).json()
        assert [i["at_s"] for i in body["items"]] == [1.0, 3.0]
        # 失败原因原样带出去（BR-110），不翻译成「操作失败」
        assert body["failed"] == [
            {"at_s": 2.0, "error": "ffmpeg 失败（1）：Invalid data found"}
        ]

    async def test_beyond_duration_reported_per_item(
        self, client, session, frame_storage, stub_ffmpeg
    ):
        video = await _seed_video(session, duration=10)
        body = (
            await client.post(
                "/studio/frames/extract",
                json={"source": "library", "video_id": video.id, "at_seconds": [5, 99]},
            )
        ).json()
        assert len(body["items"]) == 1
        assert "超过视频时长" in body["failed"][0]["error"]
        assert [c[1] for c in stub_ffmpeg] == [5.0]  # 超时长的那帧根本没去调 ffmpeg

    async def test_empty_and_over_limit_rejected(self, client, session, frame_storage):
        video = await _seed_video(session)
        empty = await client.post(
            "/studio/frames/extract",
            json={"source": "library", "video_id": video.id, "at_seconds": []},
        )
        assert empty.status_code == 422
        too_many = await client.post(
            "/studio/frames/extract",
            json={"source": "library", "video_id": video.id, "at_seconds": list(range(13))},
        )
        assert too_many.status_code == 422

    def test_domain_guard_matches_the_route(self):
        """领域层自己也拦：路由的 pydantic 约束换掉时不至于悄悄放行。"""
        with pytest.raises(studio_frames.StudioFrameError):
            studio_frames.check_seconds([])
        with pytest.raises(studio_frames.StudioFrameError):
            studio_frames.check_seconds([float(i) for i in range(13)])
        assert studio_frames.check_seconds([1, 2.4449]) == [1.0, 2.445]

    async def test_missing_ffmpeg_says_so(self, client, session, frame_storage, monkeypatch):
        """没装 ffmpeg 就明说，不静默出空图（BR-110）。"""
        video = await _seed_video(session)
        monkeypatch.setattr(studio_frames.shutil, "which", lambda name: None)
        resp = await client.post(
            "/studio/frames/extract",
            json={"source": "library", "video_id": video.id, "at_seconds": [1]},
        )
        assert resp.status_code == 503
        assert "ffmpeg" in resp.json()["detail"]

    async def test_non_local_storage_says_so(self, client, session, fake_storage, stub_ffmpeg):
        """对象存储后端 local_path 返回 None，ffmpeg 拿不到路径——照实说不可用。"""
        video = await _seed_video(session)
        resp = await client.post(
            "/studio/frames/extract",
            json={"source": "library", "video_id": video.id, "at_seconds": [1]},
        )
        assert resp.status_code == 503
        assert "只认路径" in resp.json()["detail"]

    async def test_unknown_video_is_404(self, client, frame_storage, stub_ffmpeg):
        resp = await client.post(
            "/studio/frames/extract",
            json={"source": "library", "video_id": 9999, "at_seconds": [1]},
        )
        assert resp.status_code == 404


class TestFrameSourceRouting:
    """两个片源的 id 各自从 1 开始，取错文件不会报错、只会抽错片。"""

    async def test_same_id_two_sources_read_different_files(
        self, client, session, two_source_storage, stub_ffmpeg
    ):
        video = await _seed_video(session, title="学习库 3 号")
        studio = await _seed_studio_video(session, name="撞车.mp4", duration_ms=60_000)
        # 造出真正的撞车：两张表各自的主键相同
        assert video.id == studio.id

        library_resp = await client.post(
            "/studio/frames/extract",
            json={"source": "library", "video_id": video.id, "at_seconds": [1]},
        )
        studio_resp = await client.post(
            "/studio/frames/extract",
            json={"source": "studio", "video_id": studio.id, "at_seconds": [2]},
        )
        assert library_resp.json()["failed"] == []
        assert studio_resp.json()["failed"] == []
        assert [str(call[0]) for call in stub_ffmpeg] == [
            str(two_source_storage["library"]),
            str(two_source_storage["studio"]),
        ]

    async def test_studio_asset_prompt_and_duration(
        self, client, session, two_source_storage, stub_ffmpeg
    ):
        """提示词用工坊资产名；时长按毫秒换算后再判越界。"""
        studio = await _seed_studio_video(session, name="撞车.mp4", duration_ms=3000)
        body = (
            await client.post(
                "/studio/frames/extract",
                json={"source": "studio", "video_id": studio.id, "at_seconds": [1, 9]},
            )
        ).json()
        row = await session.get(ImageAsset, body["items"][0]["asset_id"])
        assert row.prompt == "撞车.mp4 @ 1s"
        assert "超过视频时长（3.0s）" in body["failed"][0]["error"]

    async def test_source_is_required(self, client, session, frame_storage, stub_ffmpeg):
        """不给 source 直接拒——默认成某一边就是把撞车变成静默取错。"""
        video = await _seed_video(session)
        resp = await client.post(
            "/studio/frames/extract",
            json={"video_id": video.id, "at_seconds": [1]},
        )
        assert resp.status_code == 422

    async def test_unknown_source_rejected(self, client, session, frame_storage, stub_ffmpeg):
        video = await _seed_video(session)
        resp = await client.post(
            "/studio/frames/extract",
            json={"source": "library2", "video_id": video.id, "at_seconds": [1]},
        )
        assert resp.status_code == 422

    async def test_domain_guard_rejects_unknown_source(self):
        """领域层自己也拦：路由的 Literal 换掉时不至于悄悄放行。"""
        with pytest.raises(studio_frames.StudioFrameError):
            studio_frames.check_source("elsewhere")
        assert studio_frames.check_source("studio") == "studio"

    async def test_unknown_studio_asset_is_404(self, client, two_source_storage, stub_ffmpeg):
        resp = await client.post(
            "/studio/frames/extract",
            json={"source": "studio", "video_id": 9999, "at_seconds": [1]},
        )
        assert resp.status_code == 404

    async def test_audio_asset_cannot_be_extracted(
        self, client, session, two_source_storage, stub_ffmpeg
    ):
        """音频资产的 id 也在同一空间里，按视频抽帧要拒。"""
        audio = await _seed_studio_video(session, name="旁白.mp3", kind="audio")
        resp = await client.post(
            "/studio/frames/extract",
            json={"source": "studio", "video_id": audio.id, "at_seconds": [1]},
        )
        assert resp.status_code == 404


# ---- 打标队列 ----


class FakeRedis:
    """内存版 Redis + 队列：真跑 set/get/enqueue 那条路径，只是不连服务。"""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.ttl: dict[str, int] = {}
        self.enqueued: list[tuple] = []
        self.snapshots: list[dict] = []

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        self.store[key] = value
        if ex is not None:
            self.ttl[key] = ex
        self.snapshots.append(json.loads(value))

    async def get(self, key: str):
        return self.store.get(key)

    async def enqueue_job(self, name: str, *args, **kwargs):
        self.enqueued.append((name, args, kwargs))
        return None


@pytest.fixture
def fake_redis():
    fake = FakeRedis()
    studio_assets.set_job_client(fake)
    yield fake
    studio_assets.set_job_client(None)


class TestTagJob:
    async def test_start_enqueues_and_returns_zero_progress(self, client, fake_redis):
        started = (
            await client.post("/studio/assets/tag-job", json={"asset_ids": [11, 22, 33]})
        ).json()
        assert started["total"] == 3
        assert started["done"] == 0 and started["failed"] == 0  # 此刻真的一张都没打
        assert started["status"] == "running" and started["items"] == []

        name, args, kwargs = fake_redis.enqueued[0]
        assert name == studio_assets.TAG_JOB_TASK
        assert args == (started["job_id"], [11, 22, 33])
        assert kwargs["_job_id"].endswith(started["job_id"])

        key = studio_assets.tag_job_key(started["job_id"])
        assert fake_redis.ttl[key] == studio_assets.TAG_JOB_TTL_S

    async def test_task_name_is_registered_in_worker(self):
        """入队名与 worker 注册表必须对得上，否则任务永远跑不起来。"""
        from worker.main import WorkerSettings

        assert studio_assets.TAG_JOB_TASK in {f.__name__ for f in WorkerSettings.functions}

    async def test_progress_counts_are_real(self, client, session, fake_redis, monkeypatch):
        """done/failed 是真跑完的条数，不按时间估。"""
        started = (
            await client.post("/studio/assets/tag-job", json={"asset_ids": [1, 2, 3]})
        ).json()

        async def _tag(_session, asset_id):
            if asset_id == 2:
                raise RuntimeError("别名 tag-vision 没绑定")
            return {"asset_id": asset_id, "caption": f"图{asset_id}", "tags": ["猫咪"]}

        monkeypatch.setattr(studio_assets, "tag_one", _tag)
        await studio_assets.run_tag_job(session, started["job_id"], [1, 2, 3])

        state = (await client.get(f"/studio/assets/tag-job/{started['job_id']}")).json()
        assert state["total"] == 3
        assert state["done"] == 2 and state["failed"] == 1
        assert state["status"] == "done"
        assert [i["asset_id"] for i in state["items"]] == [1, 2, 3]
        assert state["items"][1]["error"] == "别名 tag-vision 没绑定"  # 原文回报
        assert state["items"][0]["caption"] == "图1"

        # 边跑边写：每条都落一次盘，不是跑完一次性补上
        running = [s for s in fake_redis.snapshots if s["status"] == "running"]
        assert [s["done"] + s["failed"] for s in running] == [0, 1, 2, 3]

    async def test_unknown_job_is_404(self, client, fake_redis):
        resp = await client.get("/studio/assets/tag-job/deadbeef")
        assert resp.status_code == 404
        assert "过期" in resp.json()["detail"]

    async def test_empty_asset_ids_rejected(self, client, fake_redis):
        resp = await client.post("/studio/assets/tag-job", json={"asset_ids": []})
        assert resp.status_code == 422
        assert fake_redis.enqueued == []

    async def test_sync_endpoint_still_there(self, client, session, fake_storage, monkeypatch):
        """同步端点保留：单张与小批量前端还在用它，一次往返就拿到结果。"""
        asset = await seed_asset(session, fake_storage, noise_png())

        async def _tag(_session, asset_id):
            return {"asset_id": asset_id, "caption": "一张图", "tags": ["测试"]}

        monkeypatch.setattr(studio_assets, "tag_one", _tag)
        body = (await client.post("/studio/assets/tag", json={"asset_ids": [asset.id]})).json()
        assert body["items"] == [{"asset_id": asset.id, "caption": "一张图", "tags": ["测试"]}]

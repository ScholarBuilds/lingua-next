"""创作工坊 M2：素材分组 / AI 打标 / URL 导入 / 增强预设（FR-474、FR-477）。

守的还是那几条会静默出错的约束：

- **删组不删资产**（BR-140）：图归模块 16 管，工坊只有贴归属的权限；
- **空列表显式拒**：本仓有过「空 keys 当成全都要」跑掉 41 个种子的事故；
- **打标逐条独立**：一条失败不能把已经花过钱的那几条一起回滚掉；
- **导入按魔数判类型**：URL 叫 .png、Content-Type 也说 png，字节却是 webp；
- **增强文案不伪造超分**（BR-150）：中转没有分辨率重建模型，就不许出现那类字样。

打标全程 monkeypatch `image_describe._chat`，不打真实网络；URL 导入走 httpx 的
MockTransport，真跑 stream/aiter_bytes 那条路径，只是不出网。
"""

from __future__ import annotations

import io

import httpx
import pytest

from domain import image_describe, studio_assets, studio_tools
from domain import storage as storage_mod
from domain.models import ImageAsset, StudioAssetGroup
from tests.test_studio import FakeStorage, noise_png, seed_asset


@pytest.fixture
def fake_storage():
    fake = FakeStorage()
    storage_mod.set_storage(fake)
    yield fake
    storage_mod.set_storage(None)


def noise_webp() -> bytes:
    """噪点 webp：内容不是纯色，能过体检，且文件头是 RIFF....WEBP。"""
    from PIL import Image

    im = Image.open(io.BytesIO(noise_png()))
    out = io.BytesIO()
    im.save(out, format="WEBP", quality=90)
    return out.getvalue()


# ---- 分组 CRUD ----


class TestAssetGroups:
    async def test_create_list_patch(self, client):
        lib = (await client.post("/studio/asset-groups", json={"name": "参考图"})).json()
        assert lib["parent_id"] is None and lib["count"] == 0
        sub = (
            await client.post(
                "/studio/asset-groups", json={"name": "建筑", "parent_id": lib["id"]}
            )
        ).json()
        assert sub["parent_id"] == lib["id"]

        items = (await client.get("/studio/asset-groups")).json()["items"]
        assert [g["name"] for g in items] == ["参考图", "建筑"]

        renamed = (
            await client.patch(f"/studio/asset-groups/{sub['id']}", json={"name": "建筑外观"})
        ).json()
        # 只改名不该顺手把组挪到顶级
        assert renamed["name"] == "建筑外观" and renamed["parent_id"] == lib["id"]

        promoted = (
            await client.patch(f"/studio/asset-groups/{sub['id']}", json={"parent_id": None})
        ).json()
        assert promoted["parent_id"] is None

    async def test_three_levels_rejected(self, client):
        """两级封顶：拿二级组当父直接 400，别等侧栏渲染时才发现层数不对。"""
        lib = (await client.post("/studio/asset-groups", json={"name": "库"})).json()
        sub = (
            await client.post("/studio/asset-groups", json={"name": "子", "parent_id": lib["id"]})
        ).json()
        resp = await client.post(
            "/studio/asset-groups", json={"name": "孙", "parent_id": sub["id"]}
        )
        assert resp.status_code == 400
        assert "两级" in resp.json()["detail"]

    async def test_group_cannot_parent_itself(self, client):
        lib = (await client.post("/studio/asset-groups", json={"name": "库"})).json()
        resp = await client.patch(
            f"/studio/asset-groups/{lib['id']}", json={"parent_id": lib["id"]}
        )
        assert resp.status_code == 400

    async def test_unknown_group_is_404(self, client):
        missing = await client.patch("/studio/asset-groups/999", json={"name": "x"})
        assert missing.status_code == 404
        assert (await client.delete("/studio/asset-groups/999")).status_code == 404

    async def test_delete_group_releases_assets_but_keeps_them(
        self, client, session, fake_storage
    ):
        """BR-140：删组只解除归属。图是模块 16 的资产，工坊没有处置权。"""
        lib = (await client.post("/studio/asset-groups", json={"name": "临时"})).json()
        assets = [await seed_asset(session, fake_storage, noise_png()) for _ in range(2)]
        ids = [a.id for a in assets]
        moved = await client.post(
            "/studio/assets/move", json={"asset_ids": ids, "group_id": lib["id"]}
        )
        assert moved.json() == {"moved": 2}

        deleted = await client.delete(f"/studio/asset-groups/{lib['id']}")
        assert deleted.json() == {"ok": True, "released": 2}

        for asset_id in ids:
            row = (await client.get(f"/images/assets/{asset_id}")).json()
            assert row["id"] == asset_id  # 图还在
            assert row["group_id"] is None  # 只是没了归属

    async def test_delete_parent_promotes_children(self, client):
        lib = (await client.post("/studio/asset-groups", json={"name": "库"})).json()
        sub = (
            await client.post("/studio/asset-groups", json={"name": "子", "parent_id": lib["id"]})
        ).json()
        await client.delete(f"/studio/asset-groups/{lib['id']}")
        items = (await client.get("/studio/asset-groups")).json()["items"]
        assert items == [{"id": sub["id"], "name": "子", "parent_id": None, "count": 0}]


class TestMove:
    async def test_move_in_and_out(self, client, session, fake_storage):
        lib = (await client.post("/studio/asset-groups", json={"name": "库"})).json()
        ids = [(await seed_asset(session, fake_storage, noise_png())).id for _ in range(3)]

        assert (
            await client.post(
                "/studio/assets/move", json={"asset_ids": ids, "group_id": lib["id"]}
            )
        ).json() == {"moved": 3}
        groups = (await client.get("/studio/asset-groups")).json()["items"]
        assert groups[0]["count"] == 3

        assert (
            await client.post("/studio/assets/move", json={"asset_ids": ids, "group_id": None})
        ).json() == {"moved": 3}
        assert (await client.get("/studio/asset-groups")).json()["items"][0]["count"] == 0

    async def test_move_to_unknown_group_is_404(self, client, session, fake_storage):
        asset = await seed_asset(session, fake_storage, noise_png())
        resp = await client.post(
            "/studio/assets/move", json={"asset_ids": [asset.id], "group_id": 777}
        )
        assert resp.status_code == 404

    @pytest.mark.parametrize(
        ("path", "body"),
        [
            ("/studio/assets/move", {"asset_ids": [], "group_id": None}),
            ("/studio/assets/tag", {"asset_ids": []}),
            ("/studio/assets/import-urls", {"items": []}),
        ],
    )
    async def test_empty_batch_is_rejected(self, client, path, body):
        """「一个都没选」不能被当成「全都要」——本仓为此跑掉过 41 个种子。"""
        assert (await client.post(path, json=body)).status_code == 422


# ---- AI 打标 ----


def stub_chat(monkeypatch, script):
    """按调用次序回放结果；元素是异常就抛出去。返回记录下来的入参。"""
    calls: list[list[dict]] = []
    seq = iter(script)

    async def fake_chat(messages, **_kwargs):
        calls.append(messages)
        item = next(seq)
        if isinstance(item, Exception):
            raise item
        return item, "fake-vision", 12

    monkeypatch.setattr(image_describe, "_chat", fake_chat)
    return calls


class TestTagging:
    async def test_settings_are_editable_and_injected_into_prompt(
        self, client, session, fake_storage, monkeypatch
    ):
        defaults = (await client.get("/studio/assets/settings")).json()
        assert defaults["deployment_id"] is None
        assert "中文" in defaults["caption_prompt"]

        stored = (
            await client.put(
                "/studio/assets/settings",
                json={
                    "deployment_id": None,
                    "caption_prompt": "只描述画面的空间关系。",
                    "classification_prompt": "只按室内、室外两类打标签。",
                    "user_prompt": "分析并分类。",
                },
            )
        ).json()
        assert stored["classification_prompt"] == "只按室内、室外两类打标签。"

        asset = await seed_asset(session, fake_storage, noise_png())
        calls = stub_chat(monkeypatch, [{"caption": "室内一角", "tags": ["室内"]}])
        tagged = await client.post("/studio/assets/tag", json={"asset_ids": [asset.id]})
        assert tagged.status_code == 200
        assert "空间关系" in calls[0][0]["content"]
        assert "室内、室外" in calls[0][0]["content"]
        assert calls[0][1]["content"][0]["text"] == "分析并分类。"

    async def test_settings_reject_unknown_deployment(self, client):
        response = await client.put(
            "/studio/assets/settings",
            json={
                "deployment_id": 987654,
                "caption_prompt": "描述图片。",
                "classification_prompt": "分类图片。",
                "user_prompt": "开始。",
            },
        )
        assert response.status_code == 404

    async def test_tag_writes_caption_tags_and_stamp(
        self, client, session, fake_storage, monkeypatch
    ):
        asset = await seed_asset(session, fake_storage, noise_png())
        calls = stub_chat(
            monkeypatch,
            [{"caption": "雪山下的木屋", "tags": ["风景", "雪山", "#风景", "冷色调"]}],
        )
        body = (await client.post("/studio/assets/tag", json={"asset_ids": [asset.id]})).json()
        assert body["items"] == [
            {"asset_id": asset.id, "caption": "雪山下的木屋", "tags": ["风景", "雪山", "冷色调"]}
        ]
        # 图是随请求体带上去的，走 data URL
        content = calls[0][1]["content"]
        assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")

        row = (await client.get(f"/images/assets/{asset.id}")).json()
        assert row["caption"] == "雪山下的木屋"
        assert row["tags"] == ["风景", "雪山", "冷色调"]
        assert row["tagged_at"] is not None

    async def test_one_failure_does_not_take_down_the_batch(
        self, client, session, fake_storage, monkeypatch
    ):
        """打标是花钱的调用，第二条超时不该把第一条的结果一起回滚掉。"""
        ids = [(await seed_asset(session, fake_storage, noise_png())).id for _ in range(3)]
        stub_chat(
            monkeypatch,
            [
                {"caption": "第一张", "tags": ["甲"]},
                image_describe.DescribeError("timeout", "视觉模型超时（90s），换张小图或稍后再试"),
                {"caption": "第三张", "tags": ["丙"]},
            ],
        )
        items = (await client.post("/studio/assets/tag", json={"asset_ids": ids})).json()["items"]

        assert items[0]["caption"] == "第一张" and "error" not in items[0]
        assert items[1]["caption"] == "" and items[1]["tags"] == []
        # 失败原因原文回报（BR-110），不翻译成「操作失败」
        assert items[1]["error"] == "视觉模型超时（90s），换张小图或稍后再试"
        assert items[2]["caption"] == "第三张"

        rows = [(await client.get(f"/images/assets/{i}")).json() for i in ids]
        assert [r["caption"] for r in rows] == ["第一张", None, "第三张"]
        # 失败那条的 tagged_at 保持为空，下次筛「未打标」还能捞回来重打
        assert rows[1]["tagged_at"] is None

    async def test_missing_asset_reports_instead_of_raising(self, client, monkeypatch):
        stub_chat(monkeypatch, [])
        items = (await client.post("/studio/assets/tag", json={"asset_ids": [4242]})).json()[
            "items"
        ]
        assert items[0]["asset_id"] == 4242 and "4242" in items[0]["error"]


class TestAssetFilters:
    async def test_asset_can_be_renamed_and_searched_by_name(
        self, client, session, fake_storage
    ):
        asset = await seed_asset(session, fake_storage, noise_png())
        renamed = await client.patch(
            f"/images/assets/{asset.id}", json={"display_name": "北欧客厅参考"}
        )
        assert renamed.status_code == 200
        assert renamed.json()["display_name"] == "北欧客厅参考"

        found = (await client.get("/images/assets?q=北欧客厅")).json()
        assert [item["id"] for item in found["items"]] == [asset.id]

        cleared = await client.patch(
            f"/images/assets/{asset.id}", json={"display_name": None}
        )
        assert cleared.json()["display_name"] is None

    async def test_group_tag_and_untagged_filters(
        self, client, session, fake_storage, monkeypatch
    ):
        lib = (await client.post("/studio/asset-groups", json={"name": "库"})).json()
        tagged = await seed_asset(session, fake_storage, noise_png())
        plain = await seed_asset(session, fake_storage, noise_png())
        stub_chat(monkeypatch, [{"caption": "一只猫", "tags": ["猫", "室内"]}])
        await client.post("/studio/assets/tag", json={"asset_ids": [tagged.id]})
        await client.post(
            "/studio/assets/move", json={"asset_ids": [tagged.id], "group_id": lib["id"]}
        )

        in_group = (await client.get(f"/images/assets?group_id={lib['id']}")).json()
        assert [r["id"] for r in in_group["items"]] == [tagged.id]

        # group_id=0 是「只看没归组的」
        ungrouped = (await client.get("/images/assets?group_id=0")).json()
        assert [r["id"] for r in ungrouped["items"]] == [plain.id]

        by_tag = (await client.get("/images/assets?tag=猫")).json()
        assert [r["id"] for r in by_tag["items"]] == [tagged.id]
        assert (await client.get("/images/assets?tag=狗")).json()["total"] == 0

        untagged = (await client.get("/images/assets?untagged=true")).json()
        assert [r["id"] for r in untagged["items"]] == [plain.id]

    def test_postgres_tag_filter_uses_the_jsonb_operator(self):
        """SQLite 的用例覆盖不到生产方言，而这里踩过一次实打实的线上错。

        `tags` 是 `JSON().with_variant(JSONB)`：变体只换建表与绑参，比较器还是基础
        JSON 的，不先 cast 就会编译成 `tags LIKE '%' || $1::JSONB || '%'`，
        postgres 直接报 `invalid input syntax for type json`。
        """
        from types import SimpleNamespace

        from sqlalchemy.dialects import postgresql

        from app.routers.images import _tag_condition

        dialect = postgresql.dialect()
        fake_session = SimpleNamespace(get_bind=lambda: SimpleNamespace(dialect=dialect))
        sql = str(_tag_condition(fake_session, "猫").compile(dialect=dialect))
        assert "@>" in sql and "LIKE" not in sql.upper()

    async def test_patch_asset_can_set_and_clear_group(self, client, session, fake_storage):
        lib = (await client.post("/studio/asset-groups", json={"name": "库"})).json()
        asset = await seed_asset(session, fake_storage, noise_png())
        put = await client.patch(f"/images/assets/{asset.id}", json={"group_id": lib["id"]})
        assert put.json()["group_id"] == lib["id"]
        # 只改收藏时不该把归属顺手清掉
        kept = await client.patch(f"/images/assets/{asset.id}", json={"favorite": True})
        assert kept.json()["group_id"] == lib["id"]
        cleared = await client.patch(f"/images/assets/{asset.id}", json={"group_id": None})
        assert cleared.json()["group_id"] is None


# ---- URL 批量导入 ----


def stub_fetch(monkeypatch, routes: dict[str, httpx.Response]):
    """把导入用的客户端换成 MockTransport：stream / aiter_bytes 那条路真跑，只是不出网。"""

    def handler(request: httpx.Request) -> httpx.Response:
        return routes.get(str(request.url), httpx.Response(404))

    def fake_client():
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True)

    monkeypatch.setattr(studio_assets, "_import_client", fake_client)


class TestImportUrls:
    async def test_magic_number_beats_extension_and_content_type(
        self, client, fake_storage, monkeypatch
    ):
        """URL 叫 .png、Content-Type 也说 png，字节却是 webp——以文件头为准。"""
        url = "https://example.com/photo.png"
        data = noise_webp()
        assert studio_assets.sniff_mime(data) == "image/webp"
        stub_fetch(
            monkeypatch,
            {url: httpx.Response(200, content=data, headers={"content-type": "image/png"})},
        )
        body = (
            await client.post("/studio/assets/import-urls", json={"items": [{"url": url}]})
        ).json()
        assert body["items"][0]["ok"] is True
        asset = (await client.get(f"/images/assets/{body['items'][0]['asset_id']}")).json()
        assert asset["mime"] == "image/webp"
        assert asset["source"] == "import"
        assert asset["prompt"] == url

    async def test_group_and_name_are_carried(self, client, fake_storage, monkeypatch):
        lib = (await client.post("/studio/asset-groups", json={"name": "外部素材"})).json()
        url = "https://example.com/a.png"
        stub_fetch(
            monkeypatch,
            {url: httpx.Response(200, content=noise_png(), headers={"content-type": "image/png"})},
        )
        body = (
            await client.post(
                "/studio/assets/import-urls",
                json={"items": [{"url": url, "name": "楼梯参考"}], "group_id": lib["id"]},
            )
        ).json()
        asset = (await client.get(f"/images/assets/{body['items'][0]['asset_id']}")).json()
        assert asset["group_id"] == lib["id"] and asset["prompt"] == "楼梯参考"

    async def test_failures_are_reported_per_item(self, client, fake_storage, monkeypatch):
        """一条挂掉不影响其它条，且原因原样回报（BR-110）。"""
        ok_url = "https://example.com/ok.png"
        gone = "https://example.com/gone.png"
        html = "https://example.com/page.html"
        junk = "https://example.com/junk.png"
        stub_fetch(
            monkeypatch,
            {
                ok_url: httpx.Response(
                    200, content=noise_png(), headers={"content-type": "image/png"}
                ),
                gone: httpx.Response(404),
                html: httpx.Response(
                    200, content=b"<!doctype html>", headers={"content-type": "text/html"}
                ),
                junk: httpx.Response(
                    200, content=b"not an image at all", headers={"content-type": "image/png"}
                ),
            },
        )
        items = (
            await client.post(
                "/studio/assets/import-urls",
                json={
                    "items": [
                        {"url": ok_url},
                        {"url": gone},
                        {"url": html},
                        {"url": junk},
                        {"url": "ftp://example.com/x.png"},
                    ]
                },
            )
        ).json()["items"]

        assert [i["ok"] for i in items] == [True, False, False, False, False]
        assert items[1]["reason"] == "HTTP 404"
        assert "text/html" in items[2]["reason"]
        assert "文件头" in items[3]["reason"]
        assert "http" in items[4]["reason"]

    async def test_auto_tag_runs_after_ingest(self, client, fake_storage, monkeypatch):
        url = "https://example.com/b.png"
        stub_fetch(
            monkeypatch,
            {url: httpx.Response(200, content=noise_png(), headers={"content-type": "image/png"})},
        )
        stub_chat(monkeypatch, [{"caption": "一条街", "tags": ["街景"]}])
        body = (
            await client.post(
                "/studio/assets/import-urls",
                json={"items": [{"url": url}], "auto_tag": True},
            )
        ).json()
        asset = (await client.get(f"/images/assets/{body['items'][0]['asset_id']}")).json()
        assert asset["caption"] == "一条街" and asset["tags"] == ["街景"]

    async def test_auto_tag_failure_does_not_break_import(
        self, client, fake_storage, monkeypatch
    ):
        """FR-477：打标失败静默不阻断入库——图已经在库里了，标可以事后补。"""
        url = "https://example.com/c.png"
        stub_fetch(
            monkeypatch,
            {url: httpx.Response(200, content=noise_png(), headers={"content-type": "image/png"})},
        )
        stub_chat(monkeypatch, [image_describe.DescribeError("binding", "别名没绑")])
        body = (
            await client.post(
                "/studio/assets/import-urls",
                json={"items": [{"url": url}], "auto_tag": True},
            )
        ).json()
        assert body["items"][0]["ok"] is True
        asset = (await client.get(f"/images/assets/{body['items'][0]['asset_id']}")).json()
        assert asset["tagged_at"] is None

    async def test_oversized_download_is_cut_off(self, client, fake_storage, monkeypatch):
        url = "https://example.com/huge.png"
        monkeypatch.setattr(studio_assets, "IMPORT_MAX_BYTES", 1024)
        stub_fetch(
            monkeypatch,
            {
                url: httpx.Response(
                    200, content=b"\x89PNG\r\n\x1a\n" + b"x" * 4096,
                    headers={"content-type": "image/png"},
                )
            },
        )
        items = (
            await client.post("/studio/assets/import-urls", json={"items": [{"url": url}]})
        ).json()["items"]
        assert items[0]["ok"] is False and "上限" in items[0]["reason"]


class TestSniff:
    @pytest.mark.parametrize(
        ("data", "expected"),
        [
            (b"\x89PNG\r\n\x1a\n....", "image/png"),
            (b"\xff\xd8\xff\xe0....", "image/jpeg"),
            (b"GIF89a....", "image/gif"),
            (b"RIFF\x00\x00\x00\x00WEBPVP8 ", "image/webp"),
            (b"BM....", "image/bmp"),
            (b"<!doctype html>", None),
            (b"RIFF\x00\x00\x00\x00WAVEfmt ", None),  # RIFF 不等于 webp
        ],
    )
    def test_sniff(self, data: bytes, expected: str | None) -> None:
        assert studio_assets.sniff_mime(data) == expected


# ---- 工坊目录 ----


class TestCatalog:
    async def test_three_presets_and_the_note(self, client):
        body = (await client.get("/studio/catalog")).json()
        assert [p["key"] for p in body["enhance_presets"]] == ["light", "standard", "strong"]
        assert [p["label"] for p in body["enhance_presets"]] == ["轻微", "标准", "强化"]
        for preset in body["enhance_presets"]:
            assert preset["hint"] and preset["prompt"]
        assert body["enhance_note"]

    def test_every_preset_forbids_recomposing(self):
        """增强一旦改了构图就不是增强，是重画——而用户是拿它跟原图做对比滑块看的。"""
        for preset in studio_tools.ENHANCE_PRESETS:
            prompt = preset["prompt"].lower()
            assert "do not change the composition" in prompt
            for word in ("subject", "colour palette", "aspect ratio"):
                assert word in prompt
            assert "do not add, remove, or move any element" in prompt

    def test_note_does_not_claim_upscaling(self):
        """BR-150：本仓中转没有分辨率重建模型，文案里就不许出现那类字样。"""
        note = studio_tools.ENHANCE_NOTE
        for banned in ("放大", "超分", "upscale", "Upscale", "UPSCALE"):
            assert banned not in note
        assert "重绘" in note


class TestNewApps:
    def test_enhance_and_angle_are_edit_apps(self):
        from domain import image_apps

        for key in ("enhance_detail", "angle_shift"):
            app = image_apps.get_app(key)
            assert app.engine == "edit" and app.target_key == "free"
            assert app.needs_image and not app.needs_mask


class TestModel:
    async def test_group_row_defaults(self, session):
        row = StudioAssetGroup(name="库")
        session.add(row)
        await session.commit()
        await session.refresh(row)
        assert row.parent_id is None and row.sort == 0 and row.created_at is not None

    async def test_asset_tag_columns_default_to_empty(self, session, fake_storage):
        asset = await seed_asset(session, fake_storage, noise_png())
        fresh = await session.get(ImageAsset, asset.id)
        assert fresh.group_id is None and fresh.caption is None
        assert fresh.tags is None and fresh.tagged_at is None

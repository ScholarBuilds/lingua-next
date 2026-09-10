"""统一多媒体资产：去重、分组与稳定内容路由。"""

from domain import storage as storage_mod
from domain.models import StudioMediaAsset
from domain.storage import LocalStorage
from domain.studio_media_assets import (
    asset_text,
    document_preview,
    document_text,
    ingest_one,
)


async def test_ingest_deduplicates_and_content_route_works(
    client,
    session,
    tmp_path,
) -> None:
    storage_mod.set_storage(LocalStorage(tmp_path))
    try:
        first = await ingest_one(
            session,
            b"fake-mp4-payload",
            kind="video",
            name="clip.mp4",
            mime="video/mp4",
            source_url="https://cdn.example/clip.mp4",
        )
        await session.commit()
        await session.refresh(first)
        duplicate = await ingest_one(
            session,
            b"fake-mp4-payload",
            kind="video",
            name="duplicate.mp4",
            mime="video/mp4",
        )
        assert duplicate.id == first.id

        listed = await client.get("/studio/media-assets", params={"kind": "video"})
        assert listed.status_code == 200
        assert listed.json()["total"] == 1
        item = listed.json()["items"][0]
        assert item["id"] == first.id
        assert item["url"] == f"/api/studio/media-assets/{first.id}/content"

        content = await client.get(f"/studio/media-assets/{first.id}/content")
        assert content.status_code == 200
        assert content.content == b"fake-mp4-payload"
        assert content.headers["content-type"] == "video/mp4"
    finally:
        storage_mod.set_storage(None)


async def test_media_group_assignment_and_delete_release(client, session, tmp_path) -> None:
    storage_mod.set_storage(LocalStorage(tmp_path))
    try:
        media = await ingest_one(
            session,
            b"audio-payload",
            kind="audio",
            name="voice.mp3",
            mime="audio/mpeg",
        )
        await session.commit()
        await session.refresh(media)
        group = (await client.post("/studio/asset-groups", json={"name": "配音"})).json()

        assigned = await client.patch(
            f"/studio/media-assets/{media.id}",
            json={"group_id": group["id"], "favorite": True},
        )
        assert assigned.status_code == 200
        assert assigned.json()["group_id"] == group["id"]
        assert assigned.json()["favorite"] is True

        filtered = await client.get(
            "/studio/media-assets",
            params={"kind": "audio", "group_id": group["id"], "favorite": True},
        )
        assert filtered.json()["total"] == 1
        searched = await client.get(
            "/studio/media-assets",
            params={"kind": "audio", "q": "voice"},
        )
        assert searched.json()["items"][0]["id"] == media.id

        groups = (await client.get("/studio/asset-groups")).json()["items"]
        assert groups[0]["count"] == 1
        deleted = await client.delete(f"/studio/asset-groups/{group['id']}")
        assert deleted.json() == {"ok": True, "released": 1}
        await session.refresh(media)
        assert media.group_id is None
    finally:
        storage_mod.set_storage(None)


async def test_media_asset_validation(client, session, tmp_path) -> None:
    storage_mod.set_storage(LocalStorage(tmp_path))
    try:
        media = await ingest_one(
            session,
            b"file-payload",
            kind="file",
            name="result.json",
            mime="application/json",
        )
        await session.commit()
        await session.refresh(media)

        unknown_kind = await client.get(
            "/studio/media-assets",
            params={"kind": "document"},
        )
        assert unknown_kind.status_code == 400
        missing_group = await client.patch(
            f"/studio/media-assets/{media.id}",
            json={"group_id": 99999},
        )
        assert missing_group.status_code == 404
        bad_status = await client.patch(
            f"/studio/media-assets/{media.id}",
            json={"status": "deleted"},
        )
        assert bad_status.status_code == 400

        stored = await session.get(StudioMediaAsset, media.id)
        assert stored is not None and stored.status == "active"
    finally:
        storage_mod.set_storage(None)


async def test_upload_media_asset_detects_kind_and_deduplicates(
    client,
    tmp_path,
) -> None:
    storage_mod.set_storage(LocalStorage(tmp_path))
    try:
        uploaded = await client.post(
            "/studio/media-assets",
            files={"file": ("voice.mp3", b"same-audio", "audio/mpeg")},
        )
        assert uploaded.status_code == 201
        item = uploaded.json()
        assert item["kind"] == "audio"
        assert item["mime"] == "audio/mpeg"

        duplicate = await client.post(
            "/studio/media-assets",
            files={"file": ("renamed.bin", b"same-audio", "application/octet-stream")},
        )
        assert duplicate.status_code == 201
        assert duplicate.json()["id"] == item["id"]

        generic = await client.post(
            "/studio/media-assets",
            files={"file": ("notes.json", b"{}", "application/json")},
        )
        assert generic.status_code == 201
        assert generic.json()["kind"] == "file"

        content = await client.get(item["url"].removeprefix("/api"))
        assert content.status_code == 200
        assert "content-disposition" not in content.headers

        deleted = await client.delete(f"/studio/media-assets/{item['id']}")
        assert deleted.status_code == 200
        assert deleted.json() == {"ok": True}
        missing = await client.get(f"/studio/media-assets/{item['id']}")
        assert missing.status_code == 404
    finally:
        storage_mod.set_storage(None)


class TestDocumentText:
    """附件正文抽取（模块 17 · 成套出图会把它当规划上下文）。

    这里守的是**抽不出时的行为**：用户带一个 sketch / docx 进来完全正当，
    那时该返回空串让上层退化成"只知道有这个文件"，而不是抛异常把整次规划带崩。
    """

    def test_reads_plain_text(self) -> None:
        assert document_text("note.txt", "一段说明".encode()) == "一段说明"

    def test_reads_markdown_and_squashes_blank_runs(self) -> None:
        got = document_text("spec.md", "# 标题\n\n\n\n正文".encode())
        assert got == "# 标题\n\n正文"

    def test_reads_gb18030(self) -> None:
        """中文本地文件常是 GBK 家族。解错码不会报错，只会喂一堆乱码进模型。"""
        assert document_text("legacy.txt", "配色规范".encode("gb18030")) == "配色规范"

    def test_truncates_to_limit(self) -> None:
        got = document_text("long.txt", ("字" * 500).encode(), limit=100)
        assert len(got) == 100

    def test_binary_office_formats_return_empty_not_garbage(self) -> None:
        """docx/xlsx 是 zip 包。硬解出来的乱码比"读不出"更糟——模型会当内容用。"""
        assert document_text("plan.docx", b"PK\x03\x04\x14\x00rubbish") == ""
        assert document_text("art.sketch", b"\x00\x01\x02") == ""

    def test_no_extension_is_not_a_crash(self) -> None:
        assert document_text("Makefile", b"all:\n\techo hi") == ""

    def test_broken_pdf_degrades_to_empty(self) -> None:
        """坏 pdf 不该让整次规划失败——见 document_text 的 docstring。"""
        assert document_text("broken.pdf", b"%PDF-1.4 truncated") == ""


async def test_asset_text_reads_an_uploaded_document(client, session, tmp_path) -> None:
    storage_mod.set_storage(LocalStorage(tmp_path))
    try:
        row = await ingest_one(
            session,
            "首页要有搜索条".encode(),
            kind="file",
            name="规范.md",
            mime="text/markdown",
        )
        await session.commit()
        name, text = await asset_text(session, row.id)
        assert name == "规范.md"
        assert "搜索条" in text

        # 不存在的 id 返回两个空串，而不是抛
        assert await asset_text(session, 999999) == ("", "")
    finally:
        storage_mod.set_storage(None)


class TestDocumentPreview:
    """附件预览（模块 17）。`kind` 决定前端怎么渲染。

    pdf **不在这里**：它由浏览器内置阅读器直接渲染原文件，
    比把版式拆成纯文本再拼回去忠实得多，也不用引 pdf.js。
    """

    def test_markdown(self) -> None:
        got = document_preview("spec.md", "# 标题\n正文".encode())
        assert got["kind"] == "markdown"
        assert "# 标题" in got["text"]

    def test_plain_text(self) -> None:
        assert document_preview("a.txt", b"hello")["kind"] == "text"

    def test_csv_becomes_a_table(self) -> None:
        got = document_preview("a.csv", "姓名,分数\n张三,92".encode())
        assert got == {"kind": "table", "rows": [["姓名", "分数"], ["张三", "92"]], "sheet": ""}

    def test_xlsx_becomes_a_table_with_the_sheet_name(self) -> None:
        import io

        from openpyxl import Workbook

        wb = Workbook()
        ws = wb.active
        ws.title = "板块清单"
        ws.append(["序号", "板块"])
        ws.append([1, "我要办事"])
        buf = io.BytesIO()
        wb.save(buf)

        got = document_preview("a.xlsx", buf.getvalue())
        assert got["sheet"] == "板块清单"
        assert got["rows"] == [["序号", "板块"], ["1", "我要办事"]]

    def test_xlsx_trailing_empty_columns_are_trimmed(self) -> None:
        """`max_col` 会把每行补齐到上限。

        不裁的话一张两列的表会渲染出几十个空列，宽得要横向滚动才看得到内容。
        """
        import io

        from openpyxl import Workbook

        wb = Workbook()
        ws = wb.active
        ws.append(["a", "b"])
        ws.append([None, None])  # 尾部空行也该去掉
        buf = io.BytesIO()
        wb.save(buf)

        rows = document_preview("a.xlsx", buf.getvalue())["rows"]
        assert rows == [["a", "b"]]

    def test_broken_workbook_degrades_to_binary(self) -> None:
        """预览失败退化成"下载吧"，不该 500——一个坏附件不能让弹窗打不开。"""
        assert document_preview("a.xlsx", b"not a zip")["kind"] == "binary"

    def test_unknown_format_is_binary(self) -> None:
        assert document_preview("a.sketch", b"\x00\x01")["kind"] == "binary"


async def test_preview_endpoint(client, session, tmp_path) -> None:
    storage_mod.set_storage(LocalStorage(tmp_path))
    try:
        row = await ingest_one(
            session, "# 规范".encode(), kind="file", name="规范.md", mime="text/markdown"
        )
        await session.commit()

        resp = await client.get(f"/studio/media-assets/{row.id}/preview")
        assert resp.status_code == 200
        body = resp.json()
        assert body["kind"] == "markdown"
        assert body["name"] == "规范.md"

        assert (await client.get("/studio/media-assets/999999/preview")).status_code == 404
    finally:
        storage_mod.set_storage(None)

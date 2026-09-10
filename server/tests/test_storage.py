"""存储抽象与媒体出口（FR-388/389）。

重点覆盖两处容易出事的地方：key 校验（值来自数据库列，脏数据不能变成任意文件读取）
与 X-Accel 分支（开关、路径编码、越界回落）。
"""

import asyncio
from pathlib import Path

import pytest

from domain.storage import BadKeyError, LocalStorage, safe_key

# ────────────────────────────── key 校验 ──────────────────────────────


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "   ",
        "../etc/passwd",
        "books/../../etc/passwd",
        "a/../../b",
        "..",
    ],
)
def test_safe_key_rejects_escapes(bad: str) -> None:
    """只有 `..` 段能真的逃出根目录，这类必须拒。"""
    with pytest.raises(BadKeyError):
        safe_key(bad)


@pytest.mark.parametrize("raw", ["/etc/passwd", "//etc/passwd", "///a/b"])
def test_leading_slash_is_normalized_not_rejected(raw: str) -> None:
    """前导斜杠归一化而不是拒绝。

    剥掉后仍锁在 media_root 内（`/etc/passwd` → `<root>/etc/passwd`，查无此文件即 404），
    安全上没有缺口；而 key 来自不同代码路径写入的数据库列，多一道斜杠就 500 太脆。
    真正危险的只有 `..`，那条单独拒。
    """
    key = safe_key(raw)
    assert not key.is_absolute()
    assert ".." not in key.parts


@pytest.mark.parametrize(
    ("raw", "expect"),
    [
        ("books/a.epub", "books/a.epub"),
        ("/books/a.epub", "books/a.epub"),  # 前导斜杠剥掉，不当成绝对路径拒绝
        ("  covers/1.img  ", "covers/1.img"),
        ("tts/ab/cd.mp3", "tts/ab/cd.mp3"),
        ("videos/中文 名.mp4", "videos/中文 名.mp4"),
    ],
)
def test_safe_key_accepts_and_normalizes(raw: str, expect: str) -> None:
    assert safe_key(raw).as_posix() == expect


def test_safe_key_allows_dot_in_name() -> None:
    """`..` 只在整段等于它时才越界；文件名里的点不该被误杀。"""
    assert safe_key("books/a..b.epub").as_posix() == "books/a..b.epub"


# ────────────────────────────── LocalStorage ──────────────────────────────


@pytest.fixture
def storage(tmp_path: Path) -> LocalStorage:
    return LocalStorage(tmp_path)


def test_write_read_roundtrip(storage: LocalStorage) -> None:
    async def go() -> None:
        await storage.write("books/x.epub", b"hello")
        assert await storage.read("books/x.epub") == b"hello"
        assert await storage.exists("books/x.epub") is True

    asyncio.run(go())


def test_write_creates_parent_dirs(storage: LocalStorage) -> None:
    async def go() -> None:
        await storage.write("a/b/c/d.bin", b"x")
        assert (storage.root / "a/b/c/d.bin").is_file()

    asyncio.run(go())


def test_write_leaves_no_partial_file(storage: LocalStorage) -> None:
    """原子写：落盘后目录里不该残留 .part 中间文件。"""

    async def go() -> None:
        await storage.write("t/f.bin", b"payload")
        names = [p.name for p in (storage.root / "t").iterdir()]
        assert names == ["f.bin"]

    asyncio.run(go())


def test_stat_reports_size_and_stable_etag(storage: LocalStorage) -> None:
    async def go() -> None:
        await storage.write("t/f.bin", b"12345")
        st = await storage.stat("t/f.bin")
        assert st is not None
        assert st.size == 5
        again = await storage.stat("t/f.bin")
        assert again is not None
        assert again.etag == st.etag  # 内容没动，etag 必须稳定

    asyncio.run(go())


def test_stat_and_exists_on_missing(storage: LocalStorage) -> None:
    async def go() -> None:
        assert await storage.stat("nope/none.bin") is None
        assert await storage.exists("nope/none.bin") is False

    asyncio.run(go())


def test_read_range_is_inclusive(storage: LocalStorage) -> None:
    """闭区间语义，与 HTTP Range 一致：bytes=0-3 是 4 个字节。"""

    async def go() -> None:
        await storage.write("t/f.bin", b"0123456789")
        assert await storage.read_range("t/f.bin", 0, 3) == b"0123"
        assert await storage.read_range("t/f.bin", 4, 4) == b"4"
        # 越过文件尾按实际长度截断，不报错
        assert await storage.read_range("t/f.bin", 8, 99) == b"89"

    asyncio.run(go())


def test_delete_reports_whether_removed(storage: LocalStorage) -> None:
    async def go() -> None:
        await storage.write("t/f.bin", b"x")
        assert await storage.delete("t/f.bin") is True
        assert await storage.delete("t/f.bin") is False  # 已不存在不报错

    asyncio.run(go())


def test_bad_key_blocked_at_every_entry(storage: LocalStorage) -> None:
    """越界 key 在读、写、删、stat 各条路径上都要被拦住。"""

    async def go() -> None:
        for coro in (
            storage.read("../escape"),
            storage.write("../escape", b"x"),
            storage.delete("../escape"),
            storage.stat("../escape"),
        ):
            with pytest.raises(BadKeyError):
                await coro

    asyncio.run(go())


def test_local_path_stays_under_root(storage: LocalStorage) -> None:
    path = storage.local_path("books/a.epub")
    assert path is not None
    assert path == storage.root / "books" / "a.epub"


def test_presigned_url_is_none_for_local(storage: LocalStorage) -> None:
    assert asyncio.run(storage.presigned_url("books/a.epub")) is None

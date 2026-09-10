"""媒体存储抽象（FR-388）：业务只认 key，不认路径。

为什么不用 fsspec / PyFilesystem2
--------------------------------
本项目对存储的需求只有六个动词，而 fsspec 在 async 场景有几个代价很高的坑：
它的同步 API 在 uvicorn 的事件循环里调用**不会报错**，而是静默阻塞（守卫只在
fsspec 自己的循环里触发），表现为 QPS 无故塌陷；`s3fs.open_async()` 读取时不带
Range，视频拖进度条会每次重拉整个文件。PyFilesystem2 最后一次实质提交在 2022 年。
四十行接口比绕这些坑便宜。

两个逃生口是这个设计的关键，不要在后续重构里删掉：

- `local_path()` —— Starlette 的 `FileResponse` 只接受本地路径，它的 HTTP Range
  支持（206/multipart/If-Range）全绑在这上面。换成对象存储后这套能力要自己重写，
  所以本地后端必须能把真实路径交出来，让上层直接用现成的。
  worker 里 ffmpeg / yt-dlp 这类要落地文件的第三方进程同样只认路径。
- `presigned_url()` —— 将来换云存储时让浏览器直连，绕开应用转发这一跳。
  本地后端返回 None，调用方据此回落到自己发文件。
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Protocol, runtime_checkable

import anyio


class StorageError(Exception):
    """存储层错误，message 面向调用方。"""


class BadKeyError(StorageError):
    """key 不合法（越界、绝对路径、空）。"""


@dataclass(frozen=True)
class StatResult:
    size: int
    mtime: float
    etag: str


def safe_key(key: str) -> PurePosixPath:
    """校验并归一化 key。

    key 多数来自数据库列（video.file_key、book.cover_key…），一旦某条记录被写脏，
    直接拼路径就是任意文件读取。统一在这里拦住绝对路径与 `..`。
    """
    if not key or not key.strip():
        raise BadKeyError("空 key")
    p = PurePosixPath(key.strip().lstrip("/"))
    if p.is_absolute() or any(part == ".." for part in p.parts):
        raise BadKeyError(f"非法 key: {key!r}")
    if not p.parts:
        raise BadKeyError(f"非法 key: {key!r}")
    return p


@runtime_checkable
class Storage(Protocol):
    """媒体存储。实现方只需保证 key 的语义是 posix 相对路径。"""

    async def stat(self, key: str) -> StatResult | None: ...

    async def exists(self, key: str) -> bool: ...

    async def read(self, key: str) -> bytes: ...

    async def read_range(self, key: str, start: int, end: int) -> bytes:
        """读 [start, end] 闭区间（与 HTTP Range 语义一致）。"""
        ...

    async def write(self, key: str, data: bytes) -> None: ...

    async def delete(self, key: str) -> bool:
        """删除；不存在返回 False 而不是报错。"""
        ...

    def local_path(self, key: str) -> Path | None:
        """本地真实路径；非本地后端返回 None。见模块头注释。"""
        ...

    async def presigned_url(self, key: str, ttl_s: int = 600) -> str | None:
        """限时直连 URL；不支持的后端返回 None。见模块头注释。"""
        ...


class LocalStorage:
    """本地文件系统后端。写入走临时文件 + rename，保证读方看不到半截文件。"""

    def __init__(self, root: str | Path) -> None:
        self._root = Path(root)

    @property
    def root(self) -> Path:
        return self._root

    def _abs(self, key: str) -> Path:
        return self._root / safe_key(key)

    async def stat(self, key: str) -> StatResult | None:
        path = self._abs(key)
        try:
            st = await anyio.to_thread.run_sync(os.stat, path)
        except OSError:
            return None
        # 与 Starlette FileResponse 同款弱 etag，换后端时行为不变
        raw = f"{st.st_mtime_ns}-{st.st_size}".encode()
        return StatResult(
            size=st.st_size,
            mtime=st.st_mtime,
            etag=hashlib.md5(raw, usedforsecurity=False).hexdigest(),
        )

    async def exists(self, key: str) -> bool:
        return await self.stat(key) is not None

    async def read(self, key: str) -> bytes:
        path = self._abs(key)
        try:
            return await anyio.to_thread.run_sync(path.read_bytes)
        except OSError as exc:
            raise StorageError(f"读取失败 {key}: {exc}") from exc

    async def read_range(self, key: str, start: int, end: int) -> bytes:
        if start < 0 or end < start:
            raise StorageError(f"非法区间 [{start}, {end}]")
        path = self._abs(key)
        length = end - start + 1

        def _pread() -> bytes:
            with path.open("rb") as fh:
                fh.seek(start)
                return fh.read(length)

        try:
            return await anyio.to_thread.run_sync(_pread)
        except OSError as exc:
            raise StorageError(f"读取失败 {key}: {exc}") from exc

    async def write(self, key: str, data: bytes) -> None:
        path = self._abs(key)

        def _atomic_write() -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(f".{path.name}.part")
            tmp.write_bytes(data)
            tmp.replace(path)  # 同目录 rename 是原子的，读方不会看到半截文件

        try:
            await anyio.to_thread.run_sync(_atomic_write)
        except OSError as exc:
            raise StorageError(f"写入失败 {key}: {exc}") from exc

    async def delete(self, key: str) -> bool:
        path = self._abs(key)

        def _unlink() -> bool:
            try:
                path.unlink()
                return True
            except FileNotFoundError:
                return False

        return await anyio.to_thread.run_sync(_unlink)

    def local_path(self, key: str) -> Path | None:
        return self._abs(key)

    async def presigned_url(self, key: str, ttl_s: int = 600) -> str | None:
        return None  # 本地后端没有直连 URL，调用方自己发文件


_storage: Storage | None = None


def get_storage() -> Storage:
    """进程级单例。换后端时只改这里（配置分派），业务代码不动。"""
    global _storage
    if _storage is None:
        from app.config import get_settings

        _storage = LocalStorage(get_settings().media_root)
    return _storage


def set_storage(storage: Storage | None) -> None:
    """测试替身注入；传 None 恢复默认。"""
    global _storage
    _storage = storage

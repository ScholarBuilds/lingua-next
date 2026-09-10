"""视频抽帧：按秒数取整帧入库（模块 17 FR-483）。

**为什么直接用本地路径而不是读字节**：ffmpeg 是外部进程，只认文件路径；把整个
视频读进内存再喂管道，一部 500MB 的片子就是 500MB 常驻。`storage.local_path()`
是存储抽象刻意留的逃生口（见 domain/storage.py 模块头），这里正是它的用途。
换成非本地后端时它返回 None，那就照实说抽帧不可用，而不是静默出空图（BR-110）。

**为什么 `-ss` 放在 `-i` 前面**：输入端 seek 直接跳到关键帧再解，长片上是秒级；
放后面是输出端 seek，要从头解码到那一秒，十分钟的片子能跑几十秒。

产图一律经 `image_assets.ingest_one` 落资产库（BR-140）：指纹去重、派生尺寸、
用量统计照常生效，同一秒抽两次拿到的是同一行而不是两张一样的图。

**片源分两个 id 空间**：视频学习库的 `video` 与创作域的 `studio_media_asset`，
两张表各自从 1 开始编号，`3` 在两边都存在且是两部完全不同的片子。所以片源一律
用 `(source, id)` 成对表示，裸 int 不接受——混着传的后果不是报错而是抽错片子，
而抽出来的图看着还挺正常。
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import anyio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain import image_assets
from domain.models import StudioMediaAsset, Video
from domain.storage import get_storage

# 一次最多抽几帧。上限不是性能而是语义：抽帧是给「挑一张喂图」用的，
# 真要整片逐帧得走另一条路（那是视频处理，不是素材采集）
MAX_FRAMES = 12
FFMPEG_TIMEOUT_S = 60

# 能抽帧的视频状态：文件已经落地的两种。degraded 是「流程跑完但产物不达标」，
# 视频文件本身是好的，照样能抽
USABLE_STATUS = ("ready", "degraded")

# 片源域。library = 视频学习库（模块 03 的 video 表），studio = 创作域自己
# 生成或上传的视频资产（studio_media_asset）
SOURCE_LIBRARY = "library"
SOURCE_STUDIO = "studio"
SOURCES = (SOURCE_LIBRARY, SOURCE_STUDIO)

NO_FFMPEG = "服务器上没有 ffmpeg（PATH 里找不到），抽帧不可用"


class StudioFrameError(Exception):
    """抽帧不可用。`status` 由路由层原样映射为 HTTP 状态码。"""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def fmt_seconds(value: float) -> str:
    """整秒显示成整数：提示词里的「@ 12s」比「@ 12.0s」像人写的。"""
    return str(int(value)) if float(value).is_integer() else f"{float(value):g}"


def frame_command(path: Path | str, at_s: float) -> list[str]:
    """抽一帧 PNG 到 stdout 的完整命令。

    独立成函数是给测试留的断言点——参数顺序（-ss 在 -i 前）与像素格式一错，
    表现是「图能出但全黑」或「慢十倍」，两种都不会报错。
    """
    return [
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-ss",
        f"{float(at_s):.3f}",
        "-i",
        str(path),
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-c:v",
        "png",
        "pipe:1",
    ]


def _ffmpeg_frame(path: Path, at_s: float) -> bytes:
    """同步跑 ffmpeg 取一帧。测试打这个桩，不真跑二进制。"""
    result = subprocess.run(
        frame_command(path, at_s), capture_output=True, timeout=FFMPEG_TIMEOUT_S
    )
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", "replace").strip()
        raise StudioFrameError(f"ffmpeg 失败（{result.returncode}）：{stderr[:300]}")
    if not result.stdout:
        raise StudioFrameError("ffmpeg 没输出图像数据（这个时间点可能超出视频时长）")
    return result.stdout


def _reason(exc: Exception) -> str:
    """失败原因原样往上带（BR-110）。"""
    message = str(exc).strip()
    return message or type(exc).__name__


# ---- 可抽帧的视频 ----


@dataclass(frozen=True)
class FrameSource:
    """一条可抽帧的片源。id 只在自己的 source 里唯一，两者必须成对使用。"""

    source: str
    id: int
    title: str
    duration_s: float | None
    storage_key: str
    created_at: datetime | None

    @property
    def ref(self) -> str:
        """给前端当选项值用的复合 key。两个片源的 3 号不会撞在一起。"""
        return f"{self.source}:{self.id}"

    @property
    def stream_url(self) -> str:
        """播放地址由服务端给出。前端照 id 自己拼 URL 就是撞车事故的入口——
        `/api/videos/3/stream` 与 `/api/studio/media-assets/3/content` 是两部片子。"""
        if self.source == SOURCE_STUDIO:
            return f"/api/studio/media-assets/{self.id}/content"
        return f"/api/videos/{self.id}/stream"

    def view(self) -> dict:
        return {
            "source": self.source,
            "id": self.id,
            "ref": self.ref,
            "title": self.title,
            "duration_s": self.duration_s,
            "stream_url": self.stream_url,
        }


def check_source(source: str) -> str:
    if source not in SOURCES:
        raise StudioFrameError(f"未知片源：{source}", status=422)
    return source


def _studio_duration_s(duration_ms: int | None) -> float | None:
    """毫秒转秒。工坊资产按毫秒记时长，学习库按秒——统一成秒再往外给，
    否则「超过视频时长」的判断会差一千倍。"""
    if duration_ms is None:
        return None
    return round(duration_ms / 1000, 3)


async def _library_sources(session: AsyncSession) -> list[FrameSource]:
    rows = (
        (
            await session.execute(
                select(Video).where(
                    Video.file_key.is_not(None), Video.status.in_(USABLE_STATUS)
                )
            )
        )
        .scalars()
        .all()
    )
    return [
        FrameSource(
            source=SOURCE_LIBRARY,
            id=row.id,
            title=row.title,
            duration_s=row.duration_s,
            storage_key=row.file_key or "",
            created_at=row.created_at,
        )
        for row in rows
    ]


async def _studio_sources(session: AsyncSession) -> list[FrameSource]:
    rows = (
        (
            await session.execute(
                select(StudioMediaAsset).where(
                    StudioMediaAsset.kind == "video",
                    StudioMediaAsset.status == "active",
                )
            )
        )
        .scalars()
        .all()
    )
    return [
        FrameSource(
            source=SOURCE_STUDIO,
            id=row.id,
            title=row.name,
            duration_s=_studio_duration_s(row.duration_ms),
            storage_key=row.storage_key,
            created_at=row.created_at,
        )
        for row in rows
    ]


async def list_videos(session: AsyncSession) -> list[dict]:
    """两个片源合起来给，新的在前。

    排序在 Python 里做而不是各查各的再首尾相接：两边都按时间倒序才是用户眼里的
    「最近处理过的片子」，分段拼接会把工坊刚生成的视频压在学习库半年前的片子后面。
    """
    rows = [*await _library_sources(session), *await _studio_sources(session)]
    # 排序键取时间戳而不是 datetime 本身：两张表的 created_at 一个带时区一个不带时
    # 直接比会抛 TypeError，而那是运行时才炸的那种错
    rows.sort(
        key=lambda row: (row.created_at.timestamp() if row.created_at else 0.0, row.id),
        reverse=True,
    )
    return [row.view() for row in rows]


async def _load_source(session: AsyncSession, source: str, video_id: int) -> FrameSource:
    check_source(source)
    if source == SOURCE_STUDIO:
        asset = await session.get(StudioMediaAsset, video_id)
        if asset is None or asset.kind != "video":
            raise StudioFrameError(f"工坊视频资产不存在：{video_id}", status=404)
        return FrameSource(
            source=SOURCE_STUDIO,
            id=asset.id,
            title=asset.name,
            duration_s=_studio_duration_s(asset.duration_ms),
            storage_key=asset.storage_key,
            created_at=asset.created_at,
        )
    video = await session.get(Video, video_id)
    if video is None:
        raise StudioFrameError(f"视频不存在：{video_id}", status=404)
    if not video.file_key:
        raise StudioFrameError("这条视频没有本地视频文件，抽不了帧", status=400)
    return FrameSource(
        source=SOURCE_LIBRARY,
        id=video.id,
        title=video.title,
        duration_s=video.duration_s,
        storage_key=video.file_key,
        created_at=video.created_at,
    )


async def _video_path(
    session: AsyncSession, source: str, video_id: int
) -> tuple[FrameSource, Path]:
    row = await _load_source(session, source, video_id)
    path = get_storage().local_path(row.storage_key)
    if path is None:
        raise StudioFrameError(
            "当前存储后端不是本地文件系统，ffmpeg 只认路径，抽帧暂不可用", status=503
        )
    if not path.exists():
        raise StudioFrameError(f"视频文件不在了：{row.storage_key}", status=404)
    return row, path


# ---- 抽帧 ----


def check_seconds(at_seconds: list[float]) -> list[float]:
    """秒数列表的入口校验。空与超量都显式拒——「一个都没选」和「随手拖了一串」
    是两种误操作，静默放过任何一种都会让人以为抽成功了。"""
    if not at_seconds:
        raise StudioFrameError("至少要给一个秒数", status=422)
    if len(at_seconds) > MAX_FRAMES:
        raise StudioFrameError(
            f"一次最多抽 {MAX_FRAMES} 帧，这次给了 {len(at_seconds)} 个", status=422
        )
    return [round(float(s), 3) for s in at_seconds]


async def extract_frames(
    session: AsyncSession, source: str, video_id: int, at_seconds: list[float]
) -> dict:
    """逐帧抽取并入库，**一帧失败只写它自己的 error**，其余照常继续。

    不整批回滚是刻意的：抽 12 帧挂了第 7 帧，前 6 帧已经是好图，退回去只会让人
    重抽一遍且不知道坏在哪。失败项落 `failed`，秒数与原因原样带出去。
    """
    seconds = check_seconds(at_seconds)
    if shutil.which("ffmpeg") is None:
        raise StudioFrameError(NO_FFMPEG, status=503)
    src, path = await _video_path(session, source, video_id)
    # 标题与时长先取成普通变量：单帧失败要 rollback，rollback 会让 ORM 对象过期，
    # 之后再读它的属性会在循环里触发一次隐式的懒加载 IO——异步会话下直接抛
    # greenlet_spawn，表现成「第二帧起全部莫名其妙地失败」。FrameSource 是脱离
    # 会话的普通对象，这里顺带把这个坑堵死了
    title, duration_s = src.title, src.duration_s

    items: list[dict] = []
    failed: list[dict] = []
    for at_s in seconds:
        try:
            if at_s < 0:
                raise StudioFrameError(f"秒数不能是负数：{at_s}")
            if duration_s and at_s > duration_s:
                raise StudioFrameError(
                    f"{fmt_seconds(at_s)}s 超过视频时长（{duration_s}s）"
                )
            data = await anyio.to_thread.run_sync(_ffmpeg_frame, path, at_s)
            row = await image_assets.ingest_one(
                session,
                data,
                target_key="free",
                prompt=f"{title} @ {fmt_seconds(at_s)}s",
                source="frame",
            )
            await session.commit()
            await session.refresh(row)
            items.append(
                {"asset_id": row.id, "url": image_assets.asset_view(row)["url"], "at_s": at_s}
            )
        except Exception as exc:  # ffmpeg / Pillow / 存储各有各的异常类型
            await session.rollback()
            failed.append({"at_s": at_s, "error": _reason(exc)})
    return {"items": items, "failed": failed}

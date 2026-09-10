"""MiniMax H3 分镜的本地裁切与拼接导出。"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import anyio
from sqlalchemy.ext.asyncio import AsyncSession

from domain.models import StudioMediaAsset
from domain.storage import get_storage
from domain.studio_media_assets import ingest_one


class MiniMaxExportError(ValueError):
    def __init__(self, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class MiniMaxClip:
    media_asset_id: int
    start: float
    end: float
    duration: float


def _run(command: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


async def _run_async(command: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    return await anyio.to_thread.run_sync(_run, command, timeout)


def _failure(result: subprocess.CompletedProcess[str], fallback: str) -> str:
    return (result.stderr or fallback).strip()[:300]


async def _source_paths(
    session: AsyncSession,
    clips: list[MiniMaxClip],
) -> list[Path]:
    storage = get_storage()
    paths: list[Path] = []
    for clip in clips:
        row = await session.get(StudioMediaAsset, clip.media_asset_id)
        if row is None:
            raise MiniMaxExportError(f"视频素材不存在：{clip.media_asset_id}", status=404)
        if row.kind != "video":
            raise MiniMaxExportError(f"素材 {clip.media_asset_id} 不是视频")
        path = storage.local_path(row.storage_key)
        if path is None or not path.is_file():
            raise MiniMaxExportError("当前存储后端不提供本地文件，暂不能拼接分镜", status=503)
        paths.append(path)
    return paths


async def export_timeline(
    session: AsyncSession,
    *,
    clips: list[MiniMaxClip],
    filename: str,
) -> StudioMediaAsset:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise MiniMaxExportError("服务器上没有 ffmpeg，无法导出 MiniMax 分镜", status=503)
    if not clips:
        raise MiniMaxExportError("时间轴里还没有可导出的视频")
    if len(clips) > 100:
        raise MiniMaxExportError("一次最多导出 100 个片段")
    sources = await _source_paths(session, clips)
    ffprobe = shutil.which("ffprobe")
    preserve_audio = ffprobe is not None
    if ffprobe is not None:
        for source in sources:
            probe = await _run_async(
                [
                    ffprobe,
                    "-v",
                    "error",
                    "-select_streams",
                    "a:0",
                    "-show_entries",
                    "stream=index",
                    "-of",
                    "csv=p=0",
                    str(source),
                ],
                30,
            )
            if probe.returncode != 0 or not probe.stdout.strip():
                preserve_audio = False
                break

    clean_name = Path(filename or "minimax-timeline.mp4").name
    if not clean_name.lower().endswith(".mp4"):
        clean_name += ".mp4"
    total_seconds = 0.0
    normalize_video = (
        "scale=1280:720:force_original_aspect_ratio=decrease,"
        "pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30"
    )
    with tempfile.TemporaryDirectory(prefix="lingua-minimax-") as temp_dir:
        root = Path(temp_dir)
        parts: list[Path] = []
        for index, (clip, source) in enumerate(zip(clips, sources, strict=True)):
            start = max(0.0, float(clip.start))
            end = max(0.0, float(clip.end))
            source_duration = max(0.0, float(clip.duration))
            if end <= start:
                end = source_duration if source_duration > start else start + 0.1
            trim_duration = max(0.1, end - start)
            total_seconds += trim_duration
            part = root / f"part-{index:03d}.mp4"
            command = [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                f"{start:.3f}",
                "-t",
                f"{trim_duration:.3f}",
                "-i",
                str(source),
            ]
            if preserve_audio:
                command.extend(["-map", "0:v:0", "-map", "0:a:0"])
            else:
                command.extend(
                    [
                        "-f",
                        "lavfi",
                        "-t",
                        f"{trim_duration:.3f}",
                        "-i",
                        "anullsrc=channel_layout=stereo:sample_rate=48000",
                        "-map",
                        "0:v:0",
                        "-map",
                        "1:a:0",
                    ]
                )
            command.extend(
                [
                    "-vf",
                    normalize_video,
                    "-shortest",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-ar",
                    "48000",
                    "-ac",
                    "2",
                    "-movflags",
                    "+faststart",
                    str(part),
                ]
            )
            result = await _run_async(command, 300)
            if result.returncode != 0:
                raise MiniMaxExportError(_failure(result, "视频裁剪失败"), status=500)
            parts.append(part)

        output = root / "timeline.mp4"
        if len(parts) == 1:
            shutil.copyfile(parts[0], output)
        else:
            manifest = root / "concat.txt"
            manifest.write_text(
                "".join(f"file '{part.as_posix()}'\n" for part in parts),
                encoding="utf-8",
            )
            result = await _run_async(
                [
                    ffmpeg,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-f",
                    "concat",
                    "-safe",
                    "0",
                    "-i",
                    str(manifest),
                    "-c",
                    "copy",
                    "-movflags",
                    "+faststart",
                    str(output),
                ],
                300,
            )
            if result.returncode != 0:
                raise MiniMaxExportError(_failure(result, "视频拼接失败"), status=500)
        if not output.is_file() or output.stat().st_size == 0:
            raise MiniMaxExportError("视频导出没有生成文件", status=500)
        row = await ingest_one(
            session,
            output.read_bytes(),
            kind="video",
            name=clean_name,
            mime="video/mp4",
            duration_ms=round(total_seconds * 1000),
            details={
                "operation": "minimax-timeline-export",
                "clips": [
                    {
                        "media_asset_id": clip.media_asset_id,
                        "start": clip.start,
                        "end": clip.end,
                    }
                    for clip in clips
                ],
            },
        )
    await session.commit()
    return row

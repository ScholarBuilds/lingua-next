"""候选视频预览片段：带凭证下前 60 秒 ≤360p，本地播放（需求 09 v5 FR-53/54，BR-18）。

**为什么不用 iframe**：iframe 由浏览器直连 YouTube，服务端 cookies 传不进去（同源策略），
机房出口 IP 一律撞上 "Sign in to confirm you're not a bot"。换 player_client、关代理、
上 Data API 都绕不过——Data API 只给元数据不给播放流。带凭证在服务端取流才是可靠路径。

**为什么不用 yt-dlp 的 download_ranges**：它把 ffmpeg 当下载器直连 googlevideo，本机实测
稳定 ffmpeg exit 187/196（TLS 连接超时），而 yt-dlp 自己的 HTTP 栈同一条 URL 秒开。
故改为：yt-dlp 取直链 → 用 yt-dlp 的 urlopen 发 Range 请求只拉够 60 秒的字节 →
ffmpeg 纯本地裁切（不碰网络）。实测 BBC 6 分钟片 extract 6.2s + 拉流 3.5s + 裁切 0.1s，
产物 1.2MB / 精确 60.0 秒。

**HLS-only 的片子走另一条路**：Shorts 常常 ≤360p 只有 `m3u8_native` 格式，对清单发
Range 请求拿到的是清单文本，ffmpeg 报 "Not detecting m3u8/hls with non standard
extension"。这类短片交给 yt-dlp 整片下载（它的 HLS 分片下载器好使，59 秒 Short 实测
12.3s / 1MB），再本地裁切；超过 FULL_DL_MAX_S 的不下，直接报错让用户去 YouTube 看。
"""

import logging
import shutil
import subprocess
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

PREVIEW_DIR = Path(__file__).resolve().parents[2] / "data" / "preview_cache"
PREVIEW_SECONDS = 60
# 单条上限：超了就按码率反推缩短秒数，保证 -c copy 的快路径不退化成转码
MAX_CLIP_BYTES = 5 * 1024 * 1024
# 缓存总量上限，超限按最近未访问淘汰到 80%
MAX_CACHE_BYTES = 512 * 1024 * 1024
# 360p 优先取带音轨的 progressive（itag 18），退化到 DASH 分离流再合并。
# [protocol^=http] 排掉 m3u8：HLS 给的是清单不是媒体流，Range 拉不到可裁的字节
PROGRESSIVE_FMT = (
    "b[height<=360][acodec!=none][vcodec!=none][protocol^=http]/"
    "b[height<=480][acodec!=none][vcodec!=none][protocol^=http]"
)
SPLIT_FMT = "bv*[height<=360][protocol^=http]+ba[protocol^=http]"
# HLS-only 时整片下载的时长上限：再长就不值得为了 60 秒预览拉全片
FULL_DL_MAX_S = 360
# 额外多拉 5 秒 + 256KB 余量：mp4 的 moov/索引与关键帧对齐都要占字节
_TAIL_SECONDS = 5
_TAIL_BYTES = 256 * 1024

# 同一 video_key 的并发请求只跑一次下载，其余等待（发现页双击/多标签常见）
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


class PreviewError(Exception):
    """片段生成失败（取流被拦、格式不可用、ffmpeg 出错）。"""


def clip_path(video_key: str) -> Path:
    return PREVIEW_DIR / f"{video_key}.mp4"


def cached_clip(video_key: str) -> Path | None:
    """已缓存则返回路径并刷新访问时间（供 LRU 淘汰），否则 None。"""
    path = clip_path(video_key)
    if path.exists() and path.stat().st_size > 0:
        _touch(path)
        return path
    return None


def _touch(path: Path) -> None:
    try:
        now = time.time()
        import os

        os.utime(path, (now, path.stat().st_mtime))
    except OSError:
        pass


def _key_lock(video_key: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(video_key, threading.Lock())


def cache_stats() -> dict:
    files = list(PREVIEW_DIR.glob("*.mp4")) if PREVIEW_DIR.exists() else []
    total = sum(f.stat().st_size for f in files)
    return {"count": len(files), "bytes": total, "limit_bytes": MAX_CACHE_BYTES}


def evict_if_needed() -> int:
    """总量超限时按最近未访问（atime）淘汰到 80%，返回删除条数（BR-18）。"""
    if not PREVIEW_DIR.exists():
        return 0
    files = [(f, f.stat()) for f in PREVIEW_DIR.glob("*.mp4")]
    total = sum(st.st_size for _, st in files)
    if total <= MAX_CACHE_BYTES:
        return 0
    target = int(MAX_CACHE_BYTES * 0.8)
    removed = 0
    for path, st in sorted(files, key=lambda pair: pair[1].st_atime):
        if total <= target:
            break
        path.unlink(missing_ok=True)
        total -= st.st_size
        removed += 1
    logger.info("预览缓存淘汰 %d 条，剩余 %.1fMB", removed, total / 1048576)
    return removed


def _select_format(ydl, info: dict, selector: str) -> dict | None:
    try:
        picked = list(
            ydl.build_format_selector(selector)(
                {"formats": info.get("formats") or [], "incomplete_formats": {}}
            )
        )
    except Exception:  # 选择器无匹配时 yt-dlp 抛的异常类型不稳定
        return None
    return picked[0] if picked else None


def _range_bytes(fmt: dict, seconds: int) -> int:
    """按码率反推「够 seconds 秒」的字节数，落在整文件大小内则取整文件。"""
    tbr = float(fmt.get("tbr") or 0) or 700.0  # kbps；缺失按 700k 保守估
    want = int(tbr * 1000 / 8 * (seconds + _TAIL_SECONDS)) + _TAIL_BYTES
    total = fmt.get("filesize") or fmt.get("filesize_approx")
    return min(want, int(total)) if total else want


def _fetch_prefix(ydl, fmt: dict, dest: Path, seconds: int) -> None:
    """用 yt-dlp 的 HTTP 栈（自带 cookies/UA/代理）发 Range 请求拉前段字节。"""
    import yt_dlp

    want = _range_bytes(fmt, seconds)
    request = yt_dlp.networking.Request(
        fmt["url"],
        headers={**(fmt.get("http_headers") or {}), "Range": f"bytes=0-{want}"},
    )
    try:
        response = ydl.urlopen(request)
        data = response.read()
    except Exception as exc:
        raise PreviewError(f"取流失败：{type(exc).__name__}: {exc}") from exc
    if not data:
        raise PreviewError("取流返回空内容")
    if data[:7] == b"#EXTM3U":
        raise PreviewError("该格式是 HLS 清单而非媒体流")
    dest.write_bytes(data)


def _ffmpeg_cut(inputs: list[Path], dest: Path, seconds: int) -> None:
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-t", str(seconds)]
    for src in inputs:
        cmd += ["-i", str(src)]
    cmd += ["-c", "copy", "-movflags", "+faststart"]
    if len(inputs) > 1:
        cmd += ["-map", "0:v:0", "-map", "1:a:0"]
    cmd.append(str(dest))
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0 or not dest.exists() or dest.stat().st_size == 0:
        raise PreviewError(f"ffmpeg 裁切失败（{result.returncode}）：{result.stderr[:200]}")


def _clip_seconds(fmt: dict, seconds: int) -> int:
    """按单条上限反推可容纳的秒数，保证走 -c copy 快路径而不是转码。"""
    tbr = float(fmt.get("tbr") or 0)
    if tbr <= 0:
        return seconds
    affordable = int(MAX_CLIP_BYTES / (tbr * 1000 / 8))
    return max(15, min(seconds, affordable))


def _download_full(video_key: str, info: dict, base_opts: dict) -> Path:
    """HLS-only 的短片：交给 yt-dlp 整片下载（它自己会拼分片），再本地裁切。"""
    import yt_dlp

    duration = info.get("duration") or 0
    if duration > FULL_DL_MAX_S:
        raise PreviewError(
            f"该视频 ≤360p 只有 HLS 流，且时长 {int(duration)} 秒超过预览下载上限，"
            "请在 YouTube 打开查看"
        )
    dest = PREVIEW_DIR / f".{video_key}.full"
    opts = {
        **base_opts,
        "skip_download": False,
        "format": "b[height<=360]/bv*[height<=360]+ba/worst",
        "outtmpl": f"{dest}.%(ext)s",
        "merge_output_format": "mp4",
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([f"https://www.youtube.com/watch?v={video_key}"])
    except Exception as exc:
        raise PreviewError(f"整片下载失败：{type(exc).__name__}: {exc}") from exc
    got = sorted(PREVIEW_DIR.glob(f".{video_key}.full.*"))
    if not got:
        raise PreviewError("整片下载未产出文件")
    return got[0]


def ensure_clip(
    video_key: str, ytdlp_opts: dict | None = None, seconds: int = PREVIEW_SECONDS
) -> Path:
    """返回该视频的预览片段路径，已缓存直接复用（FR-54）。同步函数，请在线程池调用。"""
    if shutil.which("ffmpeg") is None:
        raise PreviewError("未安装 ffmpeg，无法生成预览片段")

    with _key_lock(video_key):
        cached = cached_clip(video_key)
        if cached is not None:
            return cached

        import yt_dlp

        PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
        opts = {
            "quiet": True, "noprogress": True, "skip_download": True, "noplaylist": True,
            **(ytdlp_opts or {}),
        }
        # 取流自己发 Range 请求，外部下载器与分片并发都用不上
        for key in ("external_downloader", "external_downloader_args",
                    "concurrent_fragment_downloads"):
            opts.pop(key, None)

        started = time.monotonic()
        tmp_parts: list[Path] = []
        tmp_out = PREVIEW_DIR / f".{video_key}.part.mp4"
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                try:
                    info = ydl.extract_info(
                        f"https://www.youtube.com/watch?v={video_key}", download=False
                    )
                except Exception as exc:
                    raise PreviewError(f"取视频信息失败：{exc}") from exc
                if not info:
                    raise PreviewError("视频信息为空")

                clip_s = seconds
                fmt = _select_format(ydl, info, PROGRESSIVE_FMT)
                split = None if fmt is not None else _select_format(ydl, info, SPLIT_FMT)
                if fmt is not None:
                    clip_s = _clip_seconds(fmt, seconds)
                    part = PREVIEW_DIR / f".{video_key}.av.raw"
                    tmp_parts.append(part)
                    _fetch_prefix(ydl, fmt, part, clip_s)
                elif split is not None and split.get("requested_formats"):
                    # 无 progressive：视频与音频分开拉，ffmpeg 合并
                    streams = split["requested_formats"]
                    clip_s = min(_clip_seconds(f, seconds) for f in streams)
                    for idx, stream in enumerate(streams[:2]):
                        part = PREVIEW_DIR / f".{video_key}.{idx}.raw"
                        tmp_parts.append(part)
                        _fetch_prefix(ydl, stream, part, clip_s)
                else:
                    tmp_parts.append(_download_full(video_key, info, opts))

            _ffmpeg_cut(tmp_parts, tmp_out, clip_s)
            final = clip_path(video_key)
            tmp_out.replace(final)
        finally:
            for part in tmp_parts:
                part.unlink(missing_ok=True)
            tmp_out.unlink(missing_ok=True)

        evict_if_needed()
        logger.info(
            "预览片段 %s：%.1fs，%.0fKB", video_key,
            time.monotonic() - started, final.stat().st_size / 1024,
        )
        return final

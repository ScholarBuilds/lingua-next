"""视频源（YouTube）下载配置与错误分型：yt-dlp 参数构造、失败原因判别（FR-21/FR-22）。

凭据 config 形状：{cookies_text, cookies_browser, proxy, quality, login_profile}，全部可选。
cookies_text 为 cookies.txt 原文（敏感字段，Fernet 加密入库），使用时落临时文件。
login_profile=true 的凭据由内置登录流写入（domain/youtube_login），每次使用前
从持久化 profile 现导最新 cookies，导出失败回退存量 cookies_text。
"""

import logging
import os
import shutil
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

YOUTUBE_TEST_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"  # Me at the zoo，19 秒

ALLOWED_BROWSERS = ("chrome", "safari", "edge", "firefox")

# bot 校验 / 登录墙特征（FR-22：凭证失效检测）
_BOT_MARKERS = (
    "sign in to confirm",
    "sign in to continue",
    "not a bot",
    "cookies are no longer valid",
    "captcha",
    "login required",
    "age-restricted",
    "confirm your age",
    "private video",
)
# 网络类失败：可通过代理/重试解决，与凭证无关
_NETWORK_MARKERS = (
    "timed out",
    "timeout",
    "connection refused",
    "connection reset",
    "connection aborted",
    "unable to download webpage",
    "getaddrinfo",
    "name resolution",
    "network is unreachable",
    "proxyerror",
    "tunnel connection",
    "urlopen error",
    "ssl:",
    "eof occurred",
)


def classify_download_error(message: str) -> str:
    """下载失败原因分型：bot_check | network | other（落 video.error_kind 供前端引导）。"""
    lowered = message.lower()
    if any(marker in lowered for marker in _BOT_MARKERS):
        return "bot_check"
    if any(marker in lowered for marker in _NETWORK_MARKERS):
        return "network"
    return "other"


def format_for_quality(quality: object) -> str:
    """画质偏好 → yt-dlp format 串。末位 /b 兜底：直链/generic 源常无 height 元数据。"""
    q = str(quality or "").strip()
    if q in ("max", "best", "最高"):
        return "bv*+ba/b"
    if not q.isdigit():
        q = "1080"  # 默认 1080
    return f"bv*[height<={q}]+ba/b[height<={q}]/b"


def _fresh_profile_cookies(config: dict) -> str:
    """登录 profile 凭据：现导最新 cookies；失败回退存量 cookies_text（可能已过期但好过没有）。"""
    from domain.youtube_login import export_cookies_sync

    try:
        return export_cookies_sync().strip()
    except Exception as exc:
        logger.warning("yt-profile cookies 现导失败，回退存量 cookies_text：%s", exc)
        return (config.get("cookies_text") or "").strip()


def build_ytdlp_opts(config: dict) -> tuple[dict, str | None]:
    """凭据 config → yt-dlp 通用参数；返回 (opts, cookies 临时文件路径)。

    cookies_text 写入临时文件传 cookiefile，调用方在下载结束后负责删除该文件。
    仅限无事件循环的线程调用（login_profile 现导内部走 asyncio.run）。
    """
    opts: dict = {"quiet": True, "noprogress": True}
    cookie_path: str | None = None

    if config.get("login_profile"):
        cookies_text = _fresh_profile_cookies(config)
    else:
        cookies_text = (config.get("cookies_text") or "").strip()
    if cookies_text:
        fd, cookie_path = tempfile.mkstemp(prefix="yt-cookies-", suffix=".txt")
        os.close(fd)
        Path(cookie_path).write_text(cookies_text + "\n", encoding="utf-8")
        opts["cookiefile"] = cookie_path

    browser = (config.get("cookies_browser") or "").strip().lower()
    if browser:
        if browser not in ALLOWED_BROWSERS:
            if cookie_path:
                Path(cookie_path).unlink(missing_ok=True)
            raise ValueError(
                f"不支持的浏览器：{browser}（可选 {'/'.join(ALLOWED_BROWSERS)}）"
            )
        opts["cookiesfrombrowser"] = (browser,)

    proxy = (config.get("proxy") or "").strip()
    opts["proxy"] = proxy

    # 多线程下载：aria2c 多连接分段（业内标准）+ yt-dlp 分片并发；aria2c 缺失自动回退原生
    threads = int(config.get("download_threads") or 8)
    threads = max(1, min(threads, 16))
    opts["concurrent_fragment_downloads"] = threads
    if shutil.which("aria2c"):
        opts["external_downloader"] = {"default": "aria2c"}
        opts["external_downloader_args"] = {
            "aria2c": ["-x", str(threads), "-s", str(threads), "-k", "1M",
                       "--file-allocation=none", "--summary-interval=0"]
        }
        # aria2c 不回调 progress hooks，进度按阶段粗化由调用方处理
    return opts, cookie_path

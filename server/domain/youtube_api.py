"""YouTube Data API v3 客户端：批量元数据（需求 09 v5 FR-56~58）。

与 yt-dlp 的分工（ADR 见需求文档 v5 第 22 节）：

| | yt-dlp | Data API v3 |
| --- | --- | --- |
| 元数据 | 3-8 秒/条 | 毫秒级，一次 50 条 |
| bot 校验 | 受影响（需 cookies） | 不受（key 鉴权） |
| 字幕语言明细 | 逐语言列出 | 仅 `caption` true/false |
| 下载 | 支持 | 不支持 |

故本模块只做「快速批量元数据」，字幕语言探测与下载仍归 yt-dlp。
只用 `videos.list`（1 unit / 次），不用 `search.list`（100 units，日配额只够 100 次，BR-19）。
"""

import logging
import re

import httpx

from domain.network_policy import routed_http_client

logger = logging.getLogger(__name__)

API_BASE = "https://www.googleapis.com/youtube/v3"
BATCH_SIZE = 50  # videos.list 的 id 参数上限
_PARTS = "snippet,contentDetails,statistics"

# ISO-8601 时长：PT1H2M3S / PT45S / P1DT2H（YouTube 极少出现天，仍兼容）
_DURATION_RE = re.compile(
    r"^P(?:(?P<d>\d+)D)?T?(?:(?P<h>\d+)H)?(?:(?P<m>\d+)M)?(?:(?P<s>\d+)S)?$"
)


class YouTubeApiError(Exception):
    """Data API 调用失败（key 无效、网络不通、上游报错）。"""


class QuotaExceeded(YouTubeApiError):
    """日配额耗尽（403 quotaExceeded）——调用方应回退 yt-dlp 并提示（BR-20）。"""


def parse_duration(value: str | None) -> int | None:
    """ISO-8601 时长 → 秒。直播中的视频返回 P0D，解析为 0 视作未知。"""
    if not value:
        return None
    m = _DURATION_RE.match(value.strip())
    if m is None:
        return None
    d, h, mi, s = (int(m.group(k) or 0) for k in ("d", "h", "m", "s"))
    total = ((d * 24 + h) * 60 + mi) * 60 + s
    return total or None


def _pick_thumb(thumbs: dict) -> str | None:
    for key in ("maxres", "standard", "high", "medium", "default"):
        item = thumbs.get(key)
        if isinstance(item, dict) and item.get("url"):
            return item["url"]
    return None


def _to_int(value: object) -> int | None:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _normalize(item: dict) -> dict:
    snippet = item.get("snippet") or {}
    details = item.get("contentDetails") or {}
    stats = item.get("statistics") or {}
    return {
        "video_key": item.get("id"),
        "title": snippet.get("title") or "",
        "channel": snippet.get("channelTitle"),
        "channel_id": snippet.get("channelId"),
        "published_at": snippet.get("publishedAt"),
        "description": (snippet.get("description") or "")[:800],
        "thumb_url": _pick_thumb(snippet.get("thumbnails") or {}),
        "duration_s": parse_duration(details.get("duration")),
        # Data API 只给「有没有字幕」这一个布尔，语言明细要 yt-dlp（或 captions.list，50 units）
        "has_captions": details.get("caption") == "true",
        "definition": details.get("definition"),
        "audio_language": snippet.get("defaultAudioLanguage") or snippet.get("defaultLanguage"),
        "view_count": _to_int(stats.get("viewCount")),
        "like_count": _to_int(stats.get("likeCount")),
    }


def _raise_for_error(payload: dict, status: int) -> None:
    error = payload.get("error") or {}
    reasons = {e.get("reason") for e in (error.get("errors") or []) if isinstance(e, dict)}
    message = error.get("message") or f"HTTP {status}"
    if "quotaExceeded" in reasons or "dailyLimitExceeded" in reasons:
        raise QuotaExceeded(f"Data API 日配额已耗尽：{message}")
    if status in (400, 401, 403):
        raise YouTubeApiError(f"Data API key 无效或无权限：{message}")
    raise YouTubeApiError(f"Data API 请求失败 HTTP {status}：{message}")


async def fetch_videos(
    video_keys: list[str], api_key: str, timeout: float = 15.0
) -> dict[str, dict]:
    """批量拉视频元数据 → {video_key: 归一化字段}。

    自动按 50 条分批；缺失（已删除/私有）的 id 不会出现在结果里，调用方按 key 取用即可。
    """
    keys = [k for k in dict.fromkeys(video_keys) if k]
    if not (keys and api_key):
        return {}

    out: dict[str, dict] = {}
    async with routed_http_client(timeout=timeout) as client:
        for i in range(0, len(keys), BATCH_SIZE):
            chunk = keys[i : i + BATCH_SIZE]
            resp = await client.get(
                f"{API_BASE}/videos",
                params={"part": _PARTS, "id": ",".join(chunk), "key": api_key},
            )
            try:
                payload = resp.json()
            except ValueError as exc:
                raise YouTubeApiError(f"Data API 返回非 JSON：{resp.text[:200]}") from exc
            if resp.status_code >= 400:
                _raise_for_error(payload, resp.status_code)
            for item in payload.get("items") or []:
                normalized = _normalize(item)
                if normalized["video_key"]:
                    out[normalized["video_key"]] = normalized
    return out


def apply_metadata(item, got: dict) -> None:
    """把归一化结果写进候选行（API 与 worker 共用，两处各写一遍迟早漂移）。

    时长/缩略图只在缺失时补——RSS 已给过缩略图，Data API 的 maxres 对老视频常 404。
    """
    item.duration_s = got["duration_s"] or item.duration_s
    item.view_count = got["view_count"]
    item.has_captions = got["has_captions"]
    item.thumb_url = item.thumb_url or got["thumb_url"]
    item.probe_meta = {
        **(item.probe_meta or {}),
        "description": got["description"],
        "audio_language": got["audio_language"],
        "definition": got["definition"],
        "meta_source": "data_api",
    }


async def test_key(api_key: str, timeout: float = 10.0) -> dict:
    """key 连通测试：拉一条固定视频（1 unit），返回 {ok, detail}。"""
    if not api_key:
        return {"ok": False, "detail": "未配置 Data API key"}
    try:
        got = await fetch_videos(["jNQXAC9IVRw"], api_key, timeout=timeout)
    except QuotaExceeded as exc:
        return {"ok": False, "detail": str(exc), "quota": True}
    except (YouTubeApiError, httpx.HTTPError) as exc:
        return {"ok": False, "detail": str(exc)}
    if not got:
        return {"ok": False, "detail": "Data API 返回空结果"}
    return {"ok": True, "detail": "Data API 可用（videos.list 正常）"}

"""YouTube 订阅源解析与 RSS 轮询（需求 09 v4 FR-44/45）。

选型实测（2026-08-18）：

| 方案 | 结果 |
| --- | --- |
| RSS `feeds/videos.xml?channel_id=` | 200 / 1.18s，无需 key、无配额，最近 15 条 |
| yt-dlp `--flat-playlist` | 拿到频道名、channel_id、各视频 id 与时长，能补历史 |
| YouTube Data API v3 | 需 key、配额 1 万 units/天 |

故：订阅时用 yt-dlp 解析一次（拿准 id 与标题），之后靠 RSS 轮询新片。
轮询只写候选表，**绝不触发下载**（BR-16）。

v5 起 Data API 作为可选加速接入（`domain/youtube_api`）：配了 key 就用它批量
回填时长/观看数/字幕标志（毫秒级），本模块的 yt-dlp 路径退为无 key 时的回退，
以及 Data API 给不了的字幕语言明细与字幕正文（FR-57）。
"""

import logging
import re
from datetime import datetime
from xml.etree import ElementTree

from domain.network_policy import routed_http_client

logger = logging.getLogger(__name__)

RSS_BASE = "https://www.youtube.com/feeds/videos.xml"
# youtube-nocookie 内嵌预览：不下载先看（与 Obsidian RSS Dashboard 同做法）
EMBED_BASE = "https://www.youtube-nocookie.com/embed"

_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/",
}

# 直接给 channel_id / playlist_id 时免去一次 yt-dlp 解析
_CHANNEL_ID_RE = re.compile(r"(?:channel/|^)(UC[0-9A-Za-z_-]{22})")
_PLAYLIST_ID_RE = re.compile(r"[?&]list=([0-9A-Za-z_-]{13,})")


class SubscriptionError(Exception):
    """订阅源无法解析（链接不对、频道不存在、网络不通）。"""


def embed_url(video_key: str) -> str:
    return f"{EMBED_BASE}/{video_key}"


def watch_url(video_key: str) -> str:
    return f"https://www.youtube.com/watch?v={video_key}"


def rss_url(kind: str, source_id: str) -> str:
    key = "playlist_id" if kind == "playlist" else "channel_id"
    return f"{RSS_BASE}?{key}={source_id}"


def resolve_source(url: str, ytdlp_opts: dict | None = None) -> dict:
    """订阅链接 → {kind, source_id, title, url, thumb_url}。

    支持频道 URL、@handle、播放列表 URL、单视频链接（取其所属频道）。
    先用正则抠现成的 id，抠不到才走 yt-dlp（一次网络往返）。
    """
    url = url.strip()
    if not url:
        raise SubscriptionError("订阅链接为空")

    playlist = _PLAYLIST_ID_RE.search(url)
    if playlist and "watch?v=" not in url:
        return _probe(url, "playlist", playlist.group(1), ytdlp_opts)

    channel = _CHANNEL_ID_RE.search(url)
    if channel:
        return _probe(url, "channel", channel.group(1), ytdlp_opts)

    return _probe(url, "channel", None, ytdlp_opts)


def _probe(url: str, kind: str, known_id: str | None, ytdlp_opts: dict | None) -> dict:
    """用 yt-dlp 探一次订阅源，拿标题与（必要时）id。"""
    import yt_dlp

    opts = {
        "quiet": True,
        "noprogress": True,
        "extract_flat": "in_playlist",
        "playlistend": 1,  # 只为拿元数据，不列全量
        "skip_download": True,
        **(ytdlp_opts or {}),
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:
        raise SubscriptionError(f"无法解析订阅源：{exc}") from exc
    if not info:
        raise SubscriptionError("订阅源无内容")

    source_id = known_id or info.get("channel_id") or info.get("playlist_id") or info.get("id")
    if not source_id:
        raise SubscriptionError("未能识别频道或播放列表 id")

    title = info.get("channel") or info.get("title") or source_id
    if kind == "playlist":
        title = info.get("playlist_title") or info.get("title") or title
    else:
        # 频道页标题常带 " - Videos" 后缀，去掉更干净
        title = re.sub(r"\s*-\s*(Videos|视频)$", "", str(title))

    thumbs = info.get("thumbnails") or []
    thumb = thumbs[-1].get("url") if thumbs else info.get("thumbnail")
    return {
        "kind": kind,
        "source_id": str(source_id),
        "title": str(title)[:256],
        "url": info.get("channel_url") or info.get("webpage_url") or url,
        "thumb_url": thumb,
    }


async def fetch_feed(kind: str, source_id: str, timeout: float = 20.0) -> list[dict]:
    """拉 RSS → 候选视频列表 [{video_key, title, thumb_url, published_at}]。

    RSS 不含时长，入库时由 yt-dlp 补；这里只要够发现页展示与去重。
    """
    url = rss_url(kind, source_id)
    async with routed_http_client(timeout=timeout, follow_redirects=True) as client:
        resp = await client.get(url)
    if resp.status_code != 200:
        raise SubscriptionError(f"RSS 拉取失败 HTTP {resp.status_code}")

    try:
        root = ElementTree.fromstring(resp.text)
    except ElementTree.ParseError as exc:
        raise SubscriptionError(f"RSS 解析失败：{exc}") from exc

    items: list[dict] = []
    for entry in root.findall("atom:entry", _NS):
        vid = entry.findtext("yt:videoId", namespaces=_NS)
        if not vid:
            continue
        published = entry.findtext("atom:published", namespaces=_NS)
        group = entry.find("media:group", _NS)
        thumb_el = group.find("media:thumbnail", _NS) if group is not None else None
        items.append(
            {
                "video_key": vid,
                "title": (entry.findtext("atom:title", namespaces=_NS) or vid)[:512],
                "thumb_url": thumb_el.get("url") if thumb_el is not None else None,
                "published_at": _parse_time(published),
            }
        )
    return items


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


# ---- 入库前难度预估：只下字幕不下视频（FR-59/60） ----

# 优先官方英文字幕；官方缺失退自动字幕（自动字幕全小写无标点，但算词频与语速够用）
_CAPTION_FORMATS = ("json3", "srv3", "srv1", "vtt")


def _pick_caption(tracks: dict) -> tuple[str, str, str] | None:
    """{lang: [fmt,...]} → (lang, ext, url)，en 优先精确匹配再 en-* 前缀。"""
    langs = sorted(tracks.keys())
    ordered = [lang for lang in langs if lang == "en"] + [
        lang for lang in langs if lang.startswith("en") and lang != "en"
    ]
    for lang in ordered:
        by_ext = {str(f.get("ext")): f.get("url") for f in tracks[lang] if f.get("url")}
        for ext in _CAPTION_FORMATS:
            if by_ext.get(ext):
                return lang, ext, by_ext[ext]
        if by_ext:
            ext, url = next(iter(by_ext.items()))
            return lang, ext, url
    return None


def _parse_json3(raw: str) -> str:
    import json

    events = json.loads(raw).get("events") or []
    lines: list[str] = []
    for event in events:
        text = "".join(seg.get("utf8", "") for seg in (event.get("segs") or []))
        text = text.replace("\n", " ").strip()
        if text:
            lines.append(text)
    return " ".join(lines)


_VTT_DROP = re.compile(r"^(WEBVTT|Kind:|Language:|NOTE\b|\d+$)")
_VTT_TIME = re.compile(r"-->")
_VTT_TAG = re.compile(r"<[^>]+>")


def _parse_vtt(raw: str) -> str:
    lines: list[str] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line or _VTT_TIME.search(line) or _VTT_DROP.match(line):
            continue
        cleaned = _VTT_TAG.sub("", line).strip()
        # 自动字幕的滚动机制会把上一条整句重复一遍，逐行去重避免词数翻倍
        if cleaned and (not lines or lines[-1] != cleaned):
            lines.append(cleaned)
    return " ".join(lines)


def _parse_xml(raw: str) -> str:
    from html import unescape

    texts = re.findall(r"<text[^>]*>(.*?)</text>", raw, re.DOTALL)
    return " ".join(unescape(_VTT_TAG.sub("", t)).replace("\n", " ").strip() for t in texts)


def _m3u8_segments(raw: str) -> list[str]:
    return [ln.strip() for ln in raw.splitlines() if ln.strip().startswith("http")]


def parse_caption(raw: str) -> str:
    """字幕原文 → 纯文本。按内容嗅探格式，不信 ext。

    yt-dlp 在部分 player_client 下给的 "vtt" 其实是 HLS 清单（`#EXTM3U`），
    真正的字幕在清单里的分段 URL——实测 BBC 频道全部走这条路径。
    """
    raw = raw.lstrip("﻿").strip()
    if raw.startswith("{"):
        return _parse_json3(raw)
    if raw.startswith("<"):
        return _parse_xml(raw)
    return _parse_vtt(raw)


def probe_video(video_key: str, ytdlp_opts: dict | None = None,
                with_caption: bool = False) -> dict:
    """拉单个视频的详情（不下载）：时长、描述、字幕可用性、观看数。

    内嵌 iframe 常被 YouTube 的 bot 校验拦下（"Sign in to confirm you're not a bot"），
    且 iframe 是浏览器直连，服务端 cookies 传不进去。而"要不要下载它学英语"真正
    依赖的是时长与字幕情况——这些走服务端凭证拿得到，比看画面更有用。

    with_caption=True 时顺带把英文字幕正文取回（同一次 extract_info，不额外往返），
    供入库前的语速与难度预估（FR-59）。
    """
    import yt_dlp

    opts = {
        "quiet": True,
        "noprogress": True,
        "skip_download": True,
        **(ytdlp_opts or {}),
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            info = ydl.extract_info(watch_url(video_key), download=False)
        except Exception as exc:
            raise SubscriptionError(f"无法获取视频详情：{exc}") from exc
        if not info:
            raise SubscriptionError("视频详情为空")
        caption = _caption_from_info(ydl, info) if with_caption else None

    manual = sorted((info.get("subtitles") or {}).keys())
    auto = sorted((info.get("automatic_captions") or {}).keys())
    en_manual = [c for c in manual if c.startswith("en")]
    en_auto = [c for c in auto if c.startswith("en")]
    out = {
        "video_key": video_key,
        "title": info.get("title") or video_key,
        "channel": info.get("channel") or info.get("uploader"),
        "duration_s": info.get("duration"),
        "view_count": info.get("view_count"),
        "description": (info.get("description") or "")[:800],
        "thumb_url": info.get("thumbnail"),
        # 学英语的关键判据：有没有英文字幕、是官方还是自动
        "has_manual_en": bool(en_manual),
        "has_auto_en": bool(en_auto),
        "subtitle_langs": manual[:12],
        # 无任何英文字幕时仍可下载（走 whisper 转写），但要让用户知道
        "needs_whisper": not (en_manual or en_auto),
    }
    if caption is not None:
        out["caption"] = caption
    return out


def _caption_from_info(ydl, info: dict) -> dict:
    """已有的 info 上挑英文字幕并取回正文 → {text, lang, kind}。"""
    picked = _pick_caption(info.get("subtitles") or {})
    kind = "manual"
    if picked is None:
        picked = _pick_caption(info.get("automatic_captions") or {})
        kind = "auto"
    if picked is None:
        return {"text": "", "lang": None, "kind": "none"}

    lang, _ext, url = picked

    def get(target: str) -> str:
        return ydl.urlopen(target).read().decode("utf-8", "replace")

    try:
        raw = get(url)
        # 部分 player_client 给的 "vtt" 其实是 HLS 清单，真正字幕在分段 URL 里
        if raw.lstrip().startswith("#EXTM3U"):
            raw = "\n".join(get(seg) for seg in _m3u8_segments(raw))
    except Exception as exc:
        logger.warning("字幕取回失败：%s", exc)
        return {"text": "", "lang": lang, "kind": kind, "error": str(exc)[:200]}
    return {"text": parse_caption(raw), "lang": lang, "kind": kind}


# 内置优质英语学习频道（FR-48）：一键订阅，省去自己找频道。
# handle 是稳定标识，channel_id 由 yt-dlp 现场解析——写死 id 容易过期或记错
# （首版凭记忆写的 5 个 id 有 3 个是 404 的）。
RECOMMENDED_CHANNELS: list[dict] = [
    {
        "title": "BBC Learning English",
        "handle": "bbclearningenglish",
        "note": "6 Minute English 等经典栏目，英音、语速适中",
    },
    {
        "title": "Easy English",
        "handle": "easyenglishvideos",
        "note": "街头采访实录，真实口语与多样口音",
    },
    {
        "title": "Rachel's English",
        "handle": "rachelsenglish",
        "note": "美式发音教学，口型与连读讲解细致",
    },
    {
        "title": "English with Lucy",
        "handle": "EnglishwithLucy",
        "note": "英音教学，语法与词汇成体系",
    },
    {
        "title": "TED",
        "handle": "TED",
        "note": "演讲素材，话题广、语言规范",
    },
    {
        "title": "VOA Learning English",
        "handle": "voalearningenglish",
        "note": "慢速英语新闻，适合听力打底",
    },
]


def recommended_url(channel: dict) -> str:
    return f"https://www.youtube.com/@{channel['handle']}"

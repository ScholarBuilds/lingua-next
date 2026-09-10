import asyncio
import logging
import re
import tempfile
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, urlsplit

from fastapi import APIRouter, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from app.config import get_settings
from app.media import file_response, media_response
from app.owner import CurrentOwner
from app.queue import get_queue
from app.routers.dict import SessionDep
from domain.analysis import content_key, get_cached
from domain.credentials import decrypt_config
from domain.difficulty import estimate
from domain.models import (
    OnlineVideoReference,
    ProviderCredential,
    StudyUnit,
    StudyUnitState,
    SubtitleCue,
    SubtitleSentence,
    SubtitleTrack,
    Video,
    VideoFeedItem,
    VideoStudyProgress,
    VideoSubscription,
)
from domain.network_policy import video_config
from domain.preview import PreviewError, cached_clip, ensure_clip
from domain.shadowing import diff_words
from domain.subscriptions import (
    RECOMMENDED_CHANNELS,
    SubscriptionError,
    embed_url,
    probe_video,
    recommended_url,
    resolve_source,
    watch_url,
)
from domain.transcribe import transcribe_audio_logged
from domain.video_enrich import (
    ENRICH_STEPS,
    contains_word,
    first_cue_ordinal,
    pick_primary_track,
)
from domain.video_source import build_ytdlp_opts
from domain.youtube_api import (
    QuotaExceeded,
    YouTubeApiError,
    apply_metadata,
    fetch_videos,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["videos"])

UPLOAD_EXTS = {".mp4", ".mkv", ".webm"}
MEDIA_TYPES = {".mp4": "video/mp4", ".mkv": "video/x-matroska", ".webm": "video/webm"}


class VideoCreate(BaseModel):
    url: str


def _video_card(v: Video) -> dict:
    """列表/详情共用的视频卡片字段（含 v2 AI 加工产物，FR-01）。"""
    return {
        "id": v.id,
        "source_url": v.source_url,
        "media_kind": "local" if v.file_key else "online",
        "capabilities": {"local_media": bool(v.file_key), "online_watch": bool(v.source_url)},
        "title": v.title,
        "title_zh": v.title_zh,
        "channel": v.channel,
        "duration_s": v.duration_s,
        "status": v.status,
        "progress": v.progress,
        "error": v.error,
        "error_kind": v.error_kind,
        "summary_zh": v.summary_zh,
        "difficulty": v.difficulty,
        "accent": v.accent,
        "topics": v.topics or [],
        "vocab_count": v.vocab_count,
        "enrich_status": v.enrich_status,
        "enriched_at": v.enriched_at.isoformat() if v.enriched_at else None,
        "created_at": v.created_at.isoformat() if v.created_at else None,
        "thumb_url": f"/videos/{v.id}/thumb" if v.thumb_key else None,
    }


async def _enqueue_ingest(video_id: int) -> None:
    queue = await get_queue()
    await queue.enqueue_job("ingest_video", video_id, _job_id=f"ingest_video:{video_id}")


class OnlineVideoCreate(BaseModel):
    url: str = Field(max_length=2048)
    title: str = Field(default="YouTube 视频", min_length=1, max_length=512)


@router.post("/videos/online")
async def collect_online(body: OnlineVideoCreate, owner: CurrentOwner, session: SessionDep) -> dict:
    try:
        url = urlsplit(body.url)
        port = url.port
    except ValueError as exc:
        raise HTTPException(422, "无效视频链接") from exc
    if (
        url.scheme != "https"
        or url.hostname not in {"www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"}
        or url.username
        or url.password
        or port
    ):
        raise HTTPException(422, "仅支持 YouTube HTTPS 视频链接")
    key = parse_qs(url.query).get("v", [""])[0]
    if url.hostname == "youtu.be":
        key = url.path.strip("/")
    elif url.path.startswith(("/shorts/", "/live/")):
        key = url.path.split("/")[2]
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", key):
        raise HTTPException(422, "请先打开一个具体视频")
    reference = await session.get(OnlineVideoReference, (owner.id, key))
    if reference:
        return {"id": reference.video_id, "existed": True}
    canonical = watch_url(key)
    video = await session.scalar(select(Video).where(Video.source_url == canonical).limit(1))
    if video is None:
        video = Video(source_url=canonical, title=body.title, status="online")
        session.add(video)
        await session.flush()
    session.add(OnlineVideoReference(user_id=owner.id, video_key=key, video_id=video.id))
    feeds = (
        await session.scalars(select(VideoFeedItem).where(VideoFeedItem.video_key == key))
    ).all()
    for feed in feeds:
        feed.video_id = video.id
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        reference = await session.get(OnlineVideoReference, (owner.id, key))
        if reference is None:
            raise
        return {"id": reference.video_id, "existed": True}
    return {"id": video.id, "existed": False}


@router.post("/videos/{video_id}/retry", status_code=202)
async def retry_video(video_id: int, session: SessionDep) -> dict:
    video = await session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="video not found")
    if video.status not in ("failed", "ready"):
        raise HTTPException(status_code=409, detail=f"当前状态 {video.status} 不可重试")
    video.status = "pending"
    video.error = None
    video.error_kind = None
    video.progress = 0
    await session.commit()
    # 换 job id 绕过 arq 结果保留期内的同 id 去重
    queue = await get_queue()
    await queue.enqueue_job(
        "ingest_video", video_id, _job_id=f"ingest_video:{video_id}:{uuid.uuid4().hex[:6]}"
    )
    return {"id": video_id, "status": "pending"}


@router.post("/videos", status_code=201)
async def create_video(payload: VideoCreate, session: SessionDep) -> dict:
    url = payload.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="invalid url")
    existing = (
        await session.execute(select(Video).where(Video.source_url == url).limit(1))
    ).scalar_one_or_none()
    if existing is not None:  # 同 url 查重：直接返回已有记录
        return {"id": existing.id, "status": existing.status, "existed": True}
    video = Video(source_url=url, title=url[:512], status="pending")
    session.add(video)
    await session.commit()
    await _enqueue_ingest(video.id)
    return {"id": video.id, "status": "pending", "existed": False}


class VideoBatchCreate(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=50)


@router.post("/videos/batch", status_code=202)
async def batch_create_videos(payload: VideoBatchCreate, session: SessionDep) -> list[dict]:
    """批量导入：逐条建 Video 入队（并发由 arq max_jobs 控制，BR-06），逐 url 返回结果。"""
    results: list[dict] = []
    for raw in payload.urls:
        url = raw.strip()
        if not url:
            continue
        if not url.startswith(("http://", "https://")):
            results.append({"url": url, "error": "invalid url"})
            continue
        existing = (
            await session.execute(select(Video).where(Video.source_url == url).limit(1))
        ).scalar_one_or_none()
        if existing is not None:  # 同 url 查重（含本批内重复，逐条 commit 后可查到）
            results.append({"url": url, "id": existing.id, "existed": True})
            continue
        video = Video(source_url=url, title=url[:512], status="pending")
        session.add(video)
        await session.commit()
        await _enqueue_ingest(video.id)
        results.append({"url": url, "id": video.id, "existed": False})
    return results


@router.post("/videos/upload", status_code=201)
async def upload_video(
    file: UploadFile,
    session: SessionDep,
    owner: CurrentOwner,
    target_video_id: int | None = Query(default=None, ge=1),
) -> dict:
    target = None
    if target_video_id is not None:
        reference = await session.scalar(
            select(OnlineVideoReference).where(
                OnlineVideoReference.user_id == owner.id,
                OnlineVideoReference.video_id == target_video_id,
            )
        )
        target = await session.get(Video, target_video_id) if reference else None
        if target is None:
            raise HTTPException(404, "在线收藏不存在")
        if target.file_key or target.status != "online":
            raise HTTPException(409, "该条目已关联媒体或正在处理，不能覆盖")
    ext = Path(file.filename or "").suffix.lower()
    if ext not in UPLOAD_EXTS:
        raise HTTPException(status_code=400, detail="仅支持 mp4/mkv/webm")
    if target is not None:
        claimed = await session.execute(
            update(Video)
            .where(Video.id == target.id, Video.status == "online", Video.file_key.is_(None))
            .values(status="pending")
        )
        if claimed.rowcount != 1:
            await session.rollback()
            raise HTTPException(409, "该条目正在关联媒体，请刷新后查看")
    settings = get_settings()
    file_key = f"videos/upload-{uuid.uuid4().hex[:12]}{ext}"
    dest = Path(settings.media_root) / file_key
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(await file.read())

    title = Path(file.filename or "video").stem[:512]
    video = target or Video(title=title)
    video.file_key, video.status = file_key, "pending"
    session.add(video)
    await session.commit()
    await _enqueue_ingest(video.id)
    return {"id": video.id, "status": "pending"}


@router.get("/videos")
async def list_videos(owner: CurrentOwner, session: SessionDep) -> list[dict]:
    stmt = select(Video).order_by(Video.created_at.desc())
    videos = (await session.execute(stmt)).scalars()
    return [_video_card(v) for v in videos]


@router.get("/videos/{video_id}")
async def video_detail(video_id: int, session: SessionDep) -> dict:
    video = await session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="video not found")
    stmt = (
        select(SubtitleTrack, func.count(SubtitleCue.id))
        .outerjoin(SubtitleCue, SubtitleCue.track_id == SubtitleTrack.id)
        .where(SubtitleTrack.video_id == video_id)
        .group_by(SubtitleTrack.id)
        .order_by(SubtitleTrack.id)
    )
    return {
        **_video_card(video),
        "difficulty_detail": video.difficulty_detail,
        "source_url": video.source_url,
        "tracks": [
            {
                "id": t.id,
                "kind": t.kind,
                "lang": t.lang,
                "label": t.label,
                "is_default": t.is_default,
                "meta": t.meta,
                "cue_count": count,
            }
            for t, count in (await session.execute(stmt)).all()
        ],
    }


@router.post("/videos/{video_id}/enrich", status_code=202)
async def enqueue_enrich(video_id: int, session: SessionDep, only: str | None = None) -> dict:
    """触发/重跑 AI 加工（FR-20）：only=summary|difficulty|phrases|vocab 单项重跑。"""
    if only is not None and only not in ENRICH_STEPS:
        raise HTTPException(status_code=400, detail=f"only 仅支持 {'/'.join(ENRICH_STEPS)}")
    video = await session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="video not found")
    if video.status != "ready":
        raise HTTPException(status_code=409, detail=f"当前状态 {video.status} 不可加工")
    video.enrich_status = "pending"
    await session.commit()
    queue = await get_queue()
    await queue.enqueue_job(
        "enrich_video",
        video_id,
        only,
        _job_id=f"enrich_video:{video_id}:{uuid.uuid4().hex[:6]}",
    )
    return {"id": video_id, "enrich_status": "pending", "only": only}


@router.get("/videos/{video_id}/vocab")
async def video_vocab(video_id: int, session: SessionDep, track_id: int | None = None) -> dict:
    """词卡模式数据源：按轨的全文指纹寻址 analysis_result(video_vocab)。

    `track_id` 不传时沿用主轨（`pick_primary_track`）；用户在设置里换了字幕轨就得
    显式传，否则词卡永远跟着主轨走、与右栏字幕对不上。
    """
    video = await session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="video not found")
    tracks = list(
        (
            await session.execute(select(SubtitleTrack).where(SubtitleTrack.video_id == video_id))
        ).scalars()
    )
    if track_id is not None:
        track = next((t for t in tracks if t.id == track_id), None)
        if track is None:
            raise HTTPException(status_code=404, detail="该视频没有这条字幕轨")
    else:
        track = pick_primary_track(tracks)
    if track is None:
        raise HTTPException(status_code=404, detail="视频没有可用字幕轨")
    texts = (
        await session.execute(
            select(SubtitleCue.text)
            .where(SubtitleCue.track_id == track.id)
            .order_by(SubtitleCue.ordinal)
        )
    ).scalars()
    fingerprint = content_key("\n".join(texts))
    row = await get_cached(session, "document", fingerprint, "", "video_vocab", "llm")
    if row is None:
        raise HTTPException(status_code=404, detail="词汇表尚未生成，请先执行 AI 加工")
    items, healed = await _heal_vocab_ordinals(
        session, track.id, (row.result or {}).get("items") or []
    )
    if healed:
        # 存量 24 条视频的 cue_ordinal 是源字幕行编号，前端拿它查 StudyUnit 会指到
        # 无关的句子。现场改对之后顺手回写，用户不必重跑一遍 AI 加工
        row.result = {**(row.result or {}), "items": items}
        await session.commit()
    return {
        "video_id": video_id,
        "track_id": track.id,
        "items": items,
        "model": row.model,
        "generated_at": row.created_at.isoformat() if row.created_at else None,
    }


async def _heal_vocab_ordinals(session, track_id: int, items: list[dict]) -> tuple[list[dict], int]:
    """校验并修正词卡出处：ordinal 指向的学习句里没有这个词就现场重定位。

    返回 (修正后的条目, 改动条数)。查不到落点的置 None——指错一句无关的话
    比"没有出处"更糟，用户会照着去听一句根本不含这个词的音频。
    """
    if not items:
        return items, 0
    rows = (
        await session.execute(
            select(StudyUnit.ordinal, StudyUnit.text)
            .join(SubtitleSentence, SubtitleSentence.id == StudyUnit.sentence_id)
            .where(StudyUnit.track_id == track_id, SubtitleSentence.is_noise.is_(False))
            .order_by(StudyUnit.ordinal)
        )
    ).all()
    if not rows:
        return items, 0
    unit_texts = [(r[0], r[1]) for r in rows]
    by_ordinal = dict(unit_texts)
    healed = 0
    out: list[dict] = []
    for item in items:
        word = str(item.get("word") or "").strip()
        ordinal = item.get("cue_ordinal")
        text = by_ordinal.get(ordinal) if isinstance(ordinal, int) else None
        if word and (text is None or not contains_word(text, word)):
            fixed = first_cue_ordinal(unit_texts, word)
            if fixed != ordinal:
                item = {**item, "cue_ordinal": fixed}
                healed += 1
        out.append(item)
    return out, healed


@router.get("/videos/{video_id}/stream")
async def stream_video(video_id: int, session: SessionDep) -> Response:
    video = await session.get(Video, video_id)
    if video is None or not video.file_key:
        raise HTTPException(status_code=404, detail="video file not found")
    # Range（拖拽 seek）由发文件的一方负责：应用侧是 starlette FileResponse，
    # nginx 侧是 sendfile，两条路都原生支持单区间 206
    suffix = PurePosixPath(video.file_key).suffix.lower()
    return media_response(video.file_key, media_type=MEDIA_TYPES.get(suffix, "video/mp4"))


@router.get("/videos/{video_id}/thumb")
async def video_thumb(video_id: int, session: SessionDep) -> Response:
    video = await session.get(Video, video_id)
    if video is None or not video.thumb_key:
        raise HTTPException(status_code=404, detail="no thumbnail")
    return media_response(video.thumb_key)


@router.get("/tracks/{track_id}/cues")
async def track_cues(track_id: int, session: SessionDep) -> list[dict]:
    if await session.get(SubtitleTrack, track_id) is None:
        raise HTTPException(status_code=404, detail="track not found")
    cues = (
        await session.execute(
            select(SubtitleCue)
            .where(SubtitleCue.track_id == track_id)
            .order_by(SubtitleCue.ordinal)
        )
    ).scalars()
    return [
        {
            "id": c.id,
            "ordinal": c.ordinal,
            "start_ms": c.start_ms,
            "end_ms": c.end_ms,
            "text": c.text,
            "phrases": c.phrases,  # [[start,end,type,meaning]]，UTF-16 区间（FR-11）
            "words": c.words,  # [[start_ms,end_ms,word]]，卡拉OK高亮（FR-10）
        }
        for c in cues
    ]


async def _youtube_credential(session) -> dict:
    """配置中心的 YouTube 凭据明文（BR-17）：下载 cookies 与 Data API key 同一份。"""
    cred = (
        await session.execute(
            select(ProviderCredential)
            .where(ProviderCredential.kind == "video_source", ProviderCredential.enabled)
            .order_by(ProviderCredential.id)
            .limit(1)
        )
    ).scalar_one_or_none()
    return decrypt_config(cred.config) if cred is not None else {}


async def _data_api_key(session) -> str:
    return ((await _youtube_credential(session)).get("data_api_key") or "").strip()


@asynccontextmanager
async def _ytdlp_opts(session) -> AsyncIterator[dict]:
    """yt-dlp 只读元数据用的参数，退出时删掉临时 cookies 文件。

    必须走线程：login_profile 凭据在 build_ytdlp_opts 里现导 cookies，内部用
    asyncio.run，在事件循环里直接调会静默退化成读存量 cookies_text。
    """
    config = await _youtube_credential(session)
    config = await video_config(config, session)
    opts, cookie_path = await asyncio.to_thread(build_ytdlp_opts, config)
    # 只读元数据，不下载：去掉下载器相关参数
    for key in ("external_downloader", "external_downloader_args", "concurrent_fragment_downloads"):
        opts.pop(key, None)
    try:
        yield opts
    finally:
        if cookie_path:
            Path(cookie_path).unlink(missing_ok=True)


class SubscriptionCreate(BaseModel):
    url: str


@router.get("/subscriptions")
async def list_subscriptions(session: SessionDep) -> list[dict]:
    """订阅列表 + 频道维度学习统计（FR-50）。"""
    subs = (
        (await session.execute(select(VideoSubscription).order_by(VideoSubscription.id)))
        .scalars()
        .all()
    )
    out: list[dict] = []
    for sub in subs:
        rows = (
            await session.execute(
                select(VideoFeedItem.video_id, VideoFeedItem.ignored).where(
                    VideoFeedItem.subscription_id == sub.id
                )
            )
        ).all()
        imported = [vid for vid, _ in rows if vid is not None]
        learned = 0
        difficulty: list[int] = []
        if imported:
            stats = (
                await session.execute(
                    select(Video.id, Video.difficulty).where(Video.id.in_(imported))
                )
            ).all()
            difficulty = [d for _, d in stats if d]
            learned = (
                await session.execute(
                    select(func.count(func.distinct(StudyUnitState.video_id))).where(
                        StudyUnitState.video_id.in_(imported),
                        StudyUnitState.learned.is_(True),
                    )
                )
            ).scalar_one()
        out.append(
            {
                "id": sub.id,
                "kind": sub.kind,
                "source_id": sub.source_id,
                "title": sub.title,
                "url": sub.url,
                "thumb_url": sub.thumb_url,
                "enabled": sub.enabled,
                "last_checked_at": sub.last_checked_at.isoformat() if sub.last_checked_at else None,
                "last_error": sub.last_error,
                "total_items": len(rows),
                "imported": len(imported),
                "pending": sum(1 for vid, ig in rows if vid is None and not ig),
                "learned_videos": learned,
                "avg_difficulty": (
                    round(sum(difficulty) / len(difficulty), 1) if difficulty else None
                ),
            }
        )
    return out


@router.post("/subscriptions", status_code=201)
async def create_subscription(body: SubscriptionCreate, session: SessionDep) -> dict:
    """订阅频道 / 播放列表：yt-dlp 解析一次拿准 id 与标题，之后靠 RSS 轮询。"""
    async with _ytdlp_opts(session) as creds:
        try:
            info = await asyncio.to_thread(resolve_source, body.url, creds)
        except SubscriptionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    existing = (
        await session.execute(
            select(VideoSubscription).where(VideoSubscription.source_id == info["source_id"])
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"已订阅《{existing.title}》")

    sub = VideoSubscription(
        kind=info["kind"],
        source_id=info["source_id"],
        title=info["title"],
        url=info["url"],
        thumb_url=info["thumb_url"],
    )
    session.add(sub)
    await session.commit()
    await session.refresh(sub)
    queue = await get_queue()
    await queue.enqueue_job(
        "poll_subscriptions",
        sub.id,
        _job_id=f"poll:{sub.id}:{uuid.uuid4().hex[:6]}",
    )
    return {"id": sub.id, "title": sub.title, "kind": sub.kind, "queued": True}


@router.delete("/subscriptions/{sub_id}", status_code=204)
async def delete_subscription(sub_id: int, session: SessionDep) -> None:
    sub = await session.get(VideoSubscription, sub_id)
    if sub is None:
        raise HTTPException(status_code=404, detail="subscription not found")
    await session.delete(sub)
    await session.commit()


@router.post("/subscriptions/refresh", status_code=202)
async def refresh_subscriptions(sub_id: int | None = None) -> dict:
    """手动触发轮询（只拉列表，不下载）。"""
    queue = await get_queue()
    await queue.enqueue_job(
        "poll_subscriptions",
        sub_id,
        _job_id=f"poll:{sub_id or 'all'}:{uuid.uuid4().hex[:6]}",
    )
    return {"queued": True}


@router.get("/feed")
async def list_feed(
    session: SessionDep,
    subscription_id: int | None = None,
    include_imported: bool = False,
    include_ignored: bool = False,
    min_duration: int | None = None,
    max_duration: int | None = None,
    only_captioned: bool = False,
    q: str | None = None,
    limit: int = 60,
    paginated: bool = False,
    cursor: int | None = Query(default=None, ge=1),
    include_unknown: bool = False,
    status: str = Query(default="pending", pattern="^(pending|saved|ignored|all)$"),
) -> list[dict] | dict:
    """发现页候选视频（FR-46/49/62）：默认只列未入库未忽略的。"""
    stmt = select(VideoFeedItem, VideoSubscription.title).join(
        VideoSubscription, VideoSubscription.id == VideoFeedItem.subscription_id
    )
    if subscription_id is not None:
        stmt = stmt.where(VideoFeedItem.subscription_id == subscription_id)
    if status == "saved":
        stmt = stmt.where(VideoFeedItem.video_id.is_not(None))
    elif status == "pending" and not include_imported:
        stmt = stmt.where(VideoFeedItem.video_id.is_(None))
    if status == "ignored":
        stmt = stmt.where(VideoFeedItem.ignored.is_(True))
    elif status != "all" and not include_ignored:
        stmt = stmt.where(VideoFeedItem.ignored.is_(False))
    if q:
        stmt = stmt.where(VideoFeedItem.title.ilike(f"%{q}%"))
    if min_duration is not None:
        stmt = stmt.where(VideoFeedItem.duration_s >= min_duration)
    if max_duration is not None:
        stmt = stmt.where(VideoFeedItem.duration_s <= max_duration)
    if only_captioned:
        caption_filter = VideoFeedItem.caption_kind.in_(("manual", "auto"))
        if include_unknown:
            caption_filter = caption_filter | VideoFeedItem.caption_kind.is_(None)
        stmt = stmt.where(caption_filter)
    if paginated:
        total = await session.scalar(select(func.count()).select_from(stmt.subquery()))
        if cursor is not None:
            stmt = stmt.where(VideoFeedItem.id < cursor)
        rows = (await session.execute(stmt.order_by(VideoFeedItem.id.desc()).limit(31))).all()
        return {
            "items": [_feed_card(item, title) for item, title in rows[:30]],
            "total": total,
            "next_cursor": rows[29][0].id if len(rows) > 30 else None,
        }
    rows = (
        await session.execute(
            stmt.order_by(VideoFeedItem.published_at.desc().nullslast()).limit(
                max(1, min(limit, 200))
            )
        )
    ).all()
    return [_feed_card(item, sub_title) for item, sub_title in rows]


def _feed_card(item: VideoFeedItem, channel: str | None) -> dict:
    """候选卡片字段：v5 起时长/观看数/字幕标志/难度都在列表就位（FR-58）。"""
    return {
        "id": item.id,
        "video_key": item.video_key,
        "title": item.title,
        "thumb_url": item.thumb_url,
        "duration_s": item.duration_s,
        "published_at": item.published_at.isoformat() if item.published_at else None,
        "video_id": item.video_id,
        "ignored": item.ignored,
        "channel": channel,
        "view_count": item.view_count,
        "has_captions": item.has_captions,
        "caption_kind": item.caption_kind,
        "wpm": item.wpm,
        "difficulty": item.difficulty,
        "embed_url": embed_url(item.video_key),
        "watch_url": watch_url(item.video_key),
        "preview_url": f"/feed/{item.id}/preview",
        "preview_ready": cached_clip(item.video_key) is not None,
    }


# 卡片上的判据（时长/观看数/字幕标志）优先走 Data API：毫秒级、一次 50 条 1 unit，
# 且不受 bot 校验影响；没配 key 就退回 yt-dlp 逐条探（3-8 秒/条，FR-57）。
async def _apply_data_api(session, items: list[VideoFeedItem]) -> dict:
    """Data API 批量回填候选元数据（FR-58）→ {filled, source, error}。"""
    api_key = await _data_api_key(session)
    pending = [i for i in items if i.duration_s is None or i.view_count is None]
    if not (api_key and pending):
        return {"filled": 0, "source": "none" if not api_key else "cached"}

    try:
        meta = await fetch_videos([i.video_key for i in pending], api_key)
    except QuotaExceeded as exc:
        # 配额耗尽不静默失败：回退 yt-dlp 并把原因带回前端（BR-20）
        logger.warning("Data API 配额耗尽，回退 yt-dlp：%s", exc)
        return {"filled": 0, "source": "quota_exceeded", "error": str(exc)}
    except YouTubeApiError as exc:
        logger.warning("Data API 不可用，回退 yt-dlp：%s", exc)
        return {"filled": 0, "source": "error", "error": str(exc)}

    filled = 0
    for item in pending:
        got = meta.get(item.video_key)
        if got is not None:
            apply_metadata(item, got)
            filled += 1
    if filled:
        await session.commit()
    return {"filled": filled, "source": "data_api"}


@router.post("/feed/refresh-meta")
async def refresh_feed_meta(session: SessionDep, subscription_id: int | None = None) -> dict:
    """批量回填候选元数据（FR-58）：轮询后调一次，卡片即有时长与字幕标志。"""
    stmt = select(VideoFeedItem).where(VideoFeedItem.video_id.is_(None))
    if subscription_id is not None:
        stmt = stmt.where(VideoFeedItem.subscription_id == subscription_id)
    items = (await session.execute(stmt.limit(200))).scalars().all()
    return await _apply_data_api(session, list(items))


async def _probe_and_store(session, item: VideoFeedItem, force: bool = False) -> dict:
    """yt-dlp 探详情 + 字幕难度预估，结果落候选表（FR-59/60）。"""
    async with _ytdlp_opts(session) as creds:
        try:
            detail = await asyncio.to_thread(probe_video, item.video_key, creds, True)
        except SubscriptionError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    caption = detail.pop("caption", None) or {}
    kind = caption.get("kind") or ("none" if detail["needs_whisper"] else "auto")
    # 有英文字幕才预估；没有的只标注"需 whisper 转写"，不猜难度（FR-60）
    est = (
        await estimate(session, caption.get("text", ""), detail.get("duration_s"))
        if caption.get("text")
        else {"wpm": None, "difficulty": None, "cefr_dist": {}, "vocab_count": 0, "word_count": 0}
    )

    item.duration_s = detail.get("duration_s") or item.duration_s
    item.view_count = detail.get("view_count") or item.view_count
    item.caption_kind = kind
    if item.has_captions is None:
        item.has_captions = kind in ("manual", "auto")
    item.wpm = est["wpm"]
    item.difficulty = est["difficulty"]
    item.probe_meta = {
        **(item.probe_meta or {}),
        "description": detail.get("description") or "",
        "cefr_dist": est["cefr_dist"],
        "vocab_count": est["vocab_count"],
        "word_count": est["word_count"],
        "caption_lang": caption.get("lang"),
        "subtitle_langs": detail.get("subtitle_langs") or [],
        "probed_at": datetime.now(UTC).isoformat(),
    }
    await session.commit()
    return {**detail, "caption_kind": kind, **est}


def _detail_view(item: VideoFeedItem, channel: str | None) -> dict:
    """候选详情的对外形状：卡片字段 + 预估明细 + 描述。"""
    meta = item.probe_meta or {}
    return {
        **_feed_card(item, channel),
        "description": meta.get("description") or "",
        "cefr_dist": meta.get("cefr_dist") or {},
        "vocab_count": meta.get("vocab_count"),
        "word_count": meta.get("word_count"),
        "caption_lang": meta.get("caption_lang"),
        "subtitle_langs": meta.get("subtitle_langs") or [],
        "audio_language": meta.get("audio_language"),
        "probed_at": meta.get("probed_at"),
        "needs_whisper": item.caption_kind == "none",
        "has_manual_en": item.caption_kind == "manual",
        "has_auto_en": item.caption_kind == "auto",
    }


@router.get("/feed/{item_id}/detail")
async def feed_item_detail(item_id: int, session: SessionDep, refresh: bool = False) -> dict:
    """候选视频详情 + 入库前难度预估（FR-59/60）。

    走服务端凭证，不受 iframe 的 bot 校验影响。结果落库，重开弹窗直接命中不再重探。
    """
    item = await session.get(VideoFeedItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="feed item not found")

    if refresh or not (item.probe_meta or {}).get("probed_at"):
        await _apply_data_api(session, [item])
        await _probe_and_store(session, item)
    channel = (
        await session.execute(
            select(VideoSubscription.title).where(VideoSubscription.id == item.subscription_id)
        )
    ).scalar_one_or_none()
    return _detail_view(item, channel)


@router.post("/feed/{item_id}/preview")
async def build_preview(item_id: int, session: SessionDep) -> dict:
    """生成可播预览片段（FR-53）：带凭证下前 60 秒 ≤360p，缓存复用。

    iframe 在机房 IP 下会被 bot 校验拦（浏览器直连，服务端 cookies 传不进去），
    这条路径不依赖 iframe，实测 10 秒出片、1-3MB。
    """
    item = await session.get(VideoFeedItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="feed item not found")
    if cached_clip(item.video_key) is not None:
        return {"ready": True, "cached": True, "url": f"/feed/{item_id}/preview"}

    async with _ytdlp_opts(session) as creds:
        try:
            clip = await asyncio.to_thread(ensure_clip, item.video_key, creds)
        except PreviewError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "ready": True,
        "cached": False,
        "url": f"/feed/{item_id}/preview",
        "bytes": clip.stat().st_size,
    }


@router.get("/feed/{item_id}/preview")
async def stream_preview(item_id: int, session: SessionDep) -> Response:
    """已生成的预览片段（支持 Range，可拖动）。未生成返回 404，由前端先 POST 生成。"""
    item = await session.get(VideoFeedItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="feed item not found")
    clip = cached_clip(item.video_key)
    if clip is None:
        raise HTTPException(status_code=404, detail="预览片段尚未生成")
    # 预览片段落在仓库根 data/preview_cache，不在 nginx 挂的媒体卷里，
    # file_response 会据此自动回落到应用直发
    return file_response(clip, media_type="video/mp4", filename=f"{item.video_key}.mp4")


class FeedBatch(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=50)


@router.post("/feed/{item_id}/import", status_code=202)
async def import_feed_item(item_id: int, session: SessionDep) -> dict:
    """单条入库（FR-61）。

    前端「入库」按钮一直在打这个路径，但服务端只实现了 import-batch，
    于是每次点单条都是 404「Not Found」。这里补上，内部走同一段批量逻辑，
    不另写一份，免得两条路径的行为再次分叉。
    """
    item = await session.get(VideoFeedItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="候选不存在，可能订阅源已刷新")
    if item.video_id is not None:
        raise HTTPException(status_code=409, detail="这条已经入库过了")
    out = await _import_feed_items(session, [item_id])
    if not out["queued"]:
        raise HTTPException(status_code=409, detail="这条已经入库过了")
    row = out["queued"][0]
    return {"video_id": row["video_id"], "queued": True, "title": row["title"]}


async def _import_feed_items(session: SessionDep, ids: list[int]) -> dict:
    """候选 → Video 行 + 入队 ingest（单条与批量共用）。已入库的跳过不报错。"""
    items = (
        (await session.execute(select(VideoFeedItem).where(VideoFeedItem.id.in_(ids))))
        .scalars()
        .all()
    )
    queued: list[dict] = []
    skipped: list[int] = []
    for item in items:
        if item.video_id is not None:
            skipped.append(item.id)
            continue
        video = Video(source_url=watch_url(item.video_key), title=item.title, status="pending")
        session.add(video)
        await session.flush()
        item.video_id = video.id
        queued.append({"feed_item_id": item.id, "video_id": video.id, "title": item.title})
    await session.commit()

    queue = await get_queue()
    for row in queued:
        await queue.enqueue_job(
            "ingest_video",
            row["video_id"],
            _job_id=f"ingest_video:{row['video_id']}:{uuid.uuid4().hex[:6]}",
        )
    return {"queued": queued, "skipped": skipped}


@router.post("/feed/import-batch", status_code=202)
async def import_feed_batch(body: FeedBatch, session: SessionDep) -> dict:
    """批量入库（FR-61）：一次入队多条，已入库的跳过而不是整批失败。"""
    return await _import_feed_items(session, body.ids)


@router.get("/feed/queue")
async def feed_queue(session: SessionDep) -> list[dict]:
    """发现页可见的处理队列（FR-61）：从候选入库、尚未 ready 的视频。"""
    rows = (
        await session.execute(
            select(Video, VideoFeedItem.id)
            .join(VideoFeedItem, VideoFeedItem.video_id == Video.id)
            .where(Video.status != "ready")
            .order_by(Video.id.desc())
            .limit(30)
        )
    ).all()
    return [
        {
            "video_id": v.id,
            "feed_item_id": feed_id,
            "title": v.title,
            "status": v.status,
            "progress": v.progress,
            "error": v.error,
            "error_kind": v.error_kind,
        }
        for v, feed_id in rows
    ]


@router.patch("/feed/{item_id}/ignore")
async def ignore_feed_item(item_id: int, session: SessionDep, ignored: bool = True) -> dict:
    """忽略/恢复候选视频（FR-49）：忽略的不再出现在待看列表，可恢复。"""
    item = await session.get(VideoFeedItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="feed item not found")
    item.ignored = ignored
    await session.commit()
    return {"id": item_id, "ignored": ignored}


@router.get("/subscriptions/recommended")
async def recommended_channels(session: SessionDep) -> list[dict]:
    """内置优质英语学习频道（FR-48），标注是否已订阅。

    按 handle 标识：channel_id 由订阅时 yt-dlp 现场解析，避免写死的 id 过期。
    已订阅判定用标题匹配（订阅后标题即来自 YouTube 自身）。
    """
    subscribed_titles = {
        (t or "").lower()
        for t in (await session.execute(select(VideoSubscription.title))).scalars()
    }
    return [
        {
            **ch,
            "url": recommended_url(ch),
            "subscribed": ch["title"].lower() in subscribed_titles,
        }
        for ch in RECOMMENDED_CHANNELS
    ]


@router.get("/tracks/{track_id}/sentences")
async def track_sentences(track_id: int, owner: CurrentOwner, session: SessionDep) -> list[dict]:
    """语法句 + 其下学习句（ADR-007 三级模型）。

    右栏字幕列表与八模式以学习句为单位渲染；词组区间与译文挂在语法句上，
    学习句用 char_start/char_end 从所属句里裁剪自己那段。
    """
    if await session.get(SubtitleTrack, track_id) is None:
        raise HTTPException(status_code=404, detail="track not found")
    rows = (
        (
            await session.execute(
                select(SubtitleSentence)
                .where(SubtitleSentence.track_id == track_id)
                .order_by(SubtitleSentence.ordinal)
            )
        )
        .scalars()
        .all()
    )
    units = (
        (
            await session.execute(
                select(StudyUnit).where(StudyUnit.track_id == track_id).order_by(StudyUnit.ordinal)
            )
        )
        .scalars()
        .all()
    )
    states = {
        st.unit_id: st
        for st in (
            await session.execute(
                select(StudyUnitState).where(
                    StudyUnitState.user_id == owner.id,
                    StudyUnitState.unit_id.in_([u.id for u in units] or [0]),
                )
            )
        ).scalars()
    }
    by_sentence: dict[int, list[dict]] = {}
    for u in units:
        st = states.get(u.id)
        by_sentence.setdefault(u.sentence_id, []).append(
            {
                "id": u.id,
                "ordinal": u.ordinal,
                "start_ms": u.start_ms,
                "end_ms": u.end_ms,
                "text": u.text,
                "char_start": u.char_start,
                "char_end": u.char_end,
                "learned": bool(st and st.learned),
                "starred": bool(st and st.starred),
                "flagged": bool(st and st.flagged),
                "text_override": st.text_override if st else None,
                "dictation_accuracy": st.dictation_accuracy if st else None,
            }
        )
    return [
        {
            "id": r.id,
            "ordinal": r.ordinal,
            "start_ms": r.start_ms,
            "end_ms": r.end_ms,
            "text": r.text,
            "text_zh": r.text_zh,
            "phrases": r.phrases,  # [[start,end,type,meaning]]，UTF-16，相对本句
            "words": r.words,  # [[start_ms,end_ms,surface,char_start,char_end]]
            "is_noise": r.is_noise,
            "src_cue_ids": r.src_cue_ids,
            "units": by_sentence.get(r.id, []),
        }
        for r in rows
    ]


class UnitStatePatch(BaseModel):
    learned: bool | None = None
    starred: bool | None = None
    flagged: bool | None = None
    text_override: str | None = None
    dictation_accuracy: int | None = None


@router.patch("/study-units/{unit_id}/state")
async def patch_unit_state(
    unit_id: int, body: UnitStatePatch, owner: CurrentOwner, session: SessionDep
) -> dict:
    """学习句状态：已学 ✓ / 收藏 / 旗标 / 人工修正 / 听写正确率（FR-31）。

    字幕人工修正会改变句文本，故一并让该句的分析与翻译缓存自然失效（BR-02）。
    """
    unit = await session.get(StudyUnit, unit_id)
    if unit is None:
        raise HTTPException(status_code=404, detail="study unit not found")
    track = await session.get(SubtitleTrack, unit.track_id)
    state = (
        await session.execute(
            select(StudyUnitState).where(
                StudyUnitState.user_id == owner.id,
                StudyUnitState.unit_id == unit_id,
            )
        )
    ).scalar_one_or_none()
    if state is None:
        state = StudyUnitState(
            user_id=owner.id, unit_id=unit_id, video_id=track.video_id if track else 0
        )
        session.add(state)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(state, field, value)
    await session.commit()
    await session.refresh(state)  # onupdate 列 commit 后需 refresh（踩坑索引）
    return {
        "unit_id": unit_id,
        "learned": state.learned,
        "starred": state.starred,
        "flagged": state.flagged,
        "text_override": state.text_override,
        "dictation_accuracy": state.dictation_accuracy,
    }


class ProgressPatch(BaseModel):
    last_pos_s: float | None = None
    mode_idx: dict | None = None
    dict_stats: dict | None = None
    starred: bool | None = None


@router.patch("/videos/{video_id}/progress")
async def patch_video_progress(
    video_id: int, body: ProgressPatch, owner: CurrentOwner, session: SessionDep
) -> dict:
    """视频级进度：播放位置、各模式下标、听写累计、视频收藏（FR-32）。"""
    if await session.get(Video, video_id) is None:
        raise HTTPException(status_code=404, detail="video not found")
    row = (
        await session.execute(
            select(VideoStudyProgress).where(
                VideoStudyProgress.user_id == owner.id,
                VideoStudyProgress.video_id == video_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        row = VideoStudyProgress(user_id=owner.id, video_id=video_id)
        session.add(row)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(row, field, value)

    await session.commit()
    await session.refresh(row)
    return {
        "video_id": video_id,
        "last_pos_s": row.last_pos_s,
        "mode_idx": row.mode_idx or {},
        "dict_stats": row.dict_stats or {},
        "starred": row.starred,
    }


@router.get("/videos/{video_id}/progress")
async def get_video_progress(video_id: int, owner: CurrentOwner, session: SessionDep) -> dict:
    """视频学习进度 + 已学句统计（进度环与继续学习横幅数据源）。"""
    row = (
        await session.execute(
            select(VideoStudyProgress).where(
                VideoStudyProgress.user_id == owner.id,
                VideoStudyProgress.video_id == video_id,
            )
        )
    ).scalar_one_or_none()
    learned = (
        await session.execute(
            select(func.count())
            .select_from(StudyUnitState)
            .where(
                StudyUnitState.user_id == owner.id,
                StudyUnitState.video_id == video_id,
                StudyUnitState.learned.is_(True),
            )
        )
    ).scalar_one()
    total = (
        await session.execute(
            select(func.count())
            .select_from(StudyUnit)
            .join(SubtitleTrack, SubtitleTrack.id == StudyUnit.track_id)
            .join(SubtitleSentence, SubtitleSentence.id == StudyUnit.sentence_id)
            .where(SubtitleTrack.video_id == video_id, SubtitleSentence.is_noise.is_(False))
        )
    ).scalar_one()
    return {
        "video_id": video_id,
        "last_pos_s": row.last_pos_s if row else 0.0,
        "mode_idx": (row.mode_idx if row else None) or {},
        "dict_stats": (row.dict_stats if row else None) or {},
        "starred": bool(row and row.starred),
        "learned": learned,
        "total": total,
    }


SHADOW_EXTS = {".webm", ".ogg", ".mp4", ".m4a", ".wav"}
MAX_SHADOW_BYTES = 20 * 1024 * 1024


@router.post("/study-units/{unit_id}/shadow")
async def shadow_compare(
    unit_id: int,
    file: UploadFile,
    owner: CurrentOwner,
    session: SessionDep,
    sentence_id: int | None = None,
) -> dict:
    """跟读录音 → whisper 转写 → 与原句逐词比对，标出漏读/错读/多读（FR-33）。

    音频一次性用完即删，不落库（BR-12：录音仍只本地暂存，隐私优先）。
    """
    unit = await session.get(StudyUnit, unit_id)
    if unit is None:
        raise HTTPException(status_code=404, detail="study unit not found")

    ext = Path(file.filename or "").suffix.lower()
    if ext not in SHADOW_EXTS:
        raise HTTPException(status_code=400, detail="仅支持 webm/ogg/mp4/m4a/wav 音频")
    data = await file.read()
    if len(data) > MAX_SHADOW_BYTES:
        raise HTTPException(status_code=400, detail="音频超过 20MB 上限")

    state = (
        await session.execute(
            select(StudyUnitState).where(
                StudyUnitState.user_id == owner.id,
                StudyUnitState.unit_id == unit_id,
            )
        )
    ).scalar_one_or_none()
    reference = (state.text_override if state else None) or unit.text
    # v8 右栏按完整语法句展示：整句跟读时与整句原文比对（FR-104）
    if sentence_id is not None:
        sent = await session.get(SubtitleSentence, sentence_id)
        if sent is not None:
            reference = sent.text

    tmp = Path(tempfile.mkstemp(prefix="shadow-", suffix=ext)[1])
    tmp.write_bytes(data)
    try:
        # 原来这里直接 asyncio.to_thread(transcribe_audio,…) 绕过了 ASR seam，
        # 于是这条链路的调用一次都没进过台账（同一个页面的另一个入口 shadowing.py 是进的）
        transcript = await transcribe_audio_logged(
            str(tmp),
            get_settings().whisper_model,
            capability="video.shadow.asr",
            session=session,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail="音频转写失败") from exc
    finally:
        tmp.unlink(missing_ok=True)

    if not transcript.strip():
        raise HTTPException(status_code=422, detail="未识别到语音内容，请重新录制")
    result = diff_words(reference, transcript)
    return {"unit_id": unit_id, "reference": reference, "transcript": transcript, **result}


@router.post("/tracks/{track_id}/translate", status_code=202)
async def enqueue_track_translate(track_id: int, session: SessionDep, engine: str = "auto") -> dict:
    track = await session.get(SubtitleTrack, track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="track not found")
    if track.kind == "translation":
        raise HTTPException(status_code=400, detail="已是翻译轨")
    queue = await get_queue()
    job = await queue.enqueue_job(
        "translate_track", track_id, engine, _job_id=f"translate_track:{track_id}"
    )
    # 同 id 任务在队列或结果保留期内 → arq 返回 None，视为已在处理
    return {"queued": job is not None, "track_id": track_id, "engine": engine}


@router.delete("/videos/{video_id}")
async def delete_video(video_id: int, session: SessionDep) -> dict:
    video = await session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="video not found")
    media_root = Path(get_settings().media_root)
    paths = {media_root / key for key in (video.file_key, video.thumb_key) if key}
    # 下载模式的字幕/中间文件按 {id}.* 命名，一并清掉
    paths.update((media_root / "videos").glob(f"{video_id}.*"))
    await session.delete(video)  # DB 级联删 track/cue
    await session.commit()
    for path in paths:
        path.unlink(missing_ok=True)
    return {"deleted": video_id}

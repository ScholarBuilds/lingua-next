import asyncio
import functools
import json
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import SessionFactory
from domain import deck_ai, image_defaults, ratchet
from domain.analysis import content_key, get_cached, save_result
from domain.articles import (
    extract_html_article,
    fetch_url_html,
    persist_paragraphs,
    replace_article_content,
    split_plain_text,
    utcnow,
    utf16_slice,
)
from domain.canvas_projector import PROJECTABLE_STATUSES, project_flow_run, project_task
from domain.credentials import decrypt_config
from domain.epub import parse_epub
from domain.imports import DocumentParseError, parse_document
from domain.llm import LLMUnavailable, complete_json, complete_text
from domain.models import (
    Article,
    Book,
    DictEntry,
    ImageJob,
    Paragraph,
    PipelineInterrupt,
    PipelineRun,
    PipelineStep,
    ProviderCredential,
    RepairMessage,
    RepairSession,
    Sentence,
    StudioTask,
    StudyUnit,
    SubtitleCue,
    SubtitleIssue,
    SubtitleSentence,
    SubtitleTrack,
    Video,
    VideoFeedItem,
    VideoSubscription,
    Wordlist,
)
from domain.network_policy import video_config
from domain.pipeline import ENRICH_STEP_NAMES, STEPS
from domain.sentence_migration import (
    ISSUE_KIND_RECORDS_LOST,
    migrate_learning_records,
    purge_old_sentence_layer,
    snapshot_learning_records,
)
from domain.studio_tasks import (
    CANCELLED_BY_USER,
    LEASED_STATUSES,
    TERMINAL_STATUSES,
    abort_arq_job,
    clear_cancel_marks,
    fail_image_jobs,
    is_cancel_requested,
    register_worker_job,
    transition,
)
from domain.subtitles import Cue, parse_subtitles
from domain.transcribe import (
    prepare_local_asr_route,
    prepare_preferred_asr_route,
    transcribe_cues,
    transcribe_with_fallback,
)
from domain.translate import translate
from domain.video_enrich import (
    ACCENTS,
    CEFR_LEVELS,
    ENRICH_STEPS,
    PHRASE_TYPES,
    cefr_distribution,
    cefr_level,
    difficulty_stars,
    first_cue_ordinal,
    interpolate_words,
    locate_phrase,
    pick_primary_track,
    tokenize_words,
    video_phrases_prompt,
    video_summary_prompt,
    video_vocab_prompt,
)
from domain.video_source import build_ytdlp_opts, classify_download_error, format_for_quality

logger = logging.getLogger(__name__)

VIDEO_EXTS = {".mp4", ".mkv", ".webm", ".m4v", ".mov"}
THUMB_EXTS = {".webp", ".jpg", ".jpeg", ".png"}
SUB_EXTS = {".vtt", ".srt"}


async def parse_book(ctx: dict, book_id: int) -> dict:
    """解析书籍文件入库：分章 → 分段 → 分句 → 词元标注（服务端唯一执行，BR-01）。

    epub 走 parse_epub，pdf/txt/md 走 parse_document，落库管线完全一致。
    """
    settings = get_settings()
    async with SessionFactory() as session:
        book = await session.get(Book, book_id)
        if book is None or not book.file_key:
            return {"ok": False, "error": "book or file missing"}
        book.status = "parsing"
        await session.commit()

    try:
        path = Path(settings.media_root) / book.file_key
        if path.suffix.lower() == ".epub":
            parsed = parse_epub(str(path))
        else:
            parsed = parse_document(path, fallback_title=book.title)
        if not parsed.chapters:
            raise DocumentParseError("未解析出任何章节/段落")
        cover_key = None
        if parsed.cover:
            cover_key = f"covers/{book_id}.img"
            dest = Path(settings.media_root) / cover_key
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(parsed.cover)

        async with SessionFactory() as session:
            # 重解析幂等：清掉旧章节（级联段落/句子）
            await session.execute(delete(Article).where(Article.book_id == book_id))
            chapters = paragraphs = sentences = 0
            for ordinal, chapter in enumerate(parsed.chapters):
                article = Article(
                    book_id=book_id, ordinal=ordinal, title=chapter.title, source_kind="book"
                )
                session.add(article)
                await session.flush()
                chapters += 1
                p_count, s_count = await persist_paragraphs(session, article.id, chapter.paragraphs)
                paragraphs += p_count
                sentences += s_count
            book = await session.get(Book, book_id)
            book.title = parsed.title or book.title
            book.author = parsed.author or book.author
            book.cover_key = cover_key or book.cover_key
            book.status = "ready"
            book.error = None
            await session.commit()
        return {"ok": True, "chapters": chapters, "paragraphs": paragraphs, "sentences": sentences}
    except Exception as exc:  # 解析失败保留原件与错误原因，可重试（FR-05）
        # 文档类错误 message 直接面向用户（如扫描版 PDF 提示），不加异常类名前缀
        message = (
            str(exc) if isinstance(exc, DocumentParseError) else f"{type(exc).__name__}: {exc}"
        )[:2000]
        async with SessionFactory() as session:
            book = await session.get(Book, book_id)
            if book is not None:
                book.status = "failed"
                book.error = message
                await session.commit()
        raise


async def ingest_article(ctx: dict, article_id: int, raw_text: str | None = None) -> dict:
    """独立文章入库：url 抓正文 / file 解析原件，再走与书籍章节同口径的分段/分句/词元化。"""
    settings = get_settings()
    async with SessionFactory() as session:
        article = await session.get(Article, article_id)
        if article is None:
            return {"ok": False, "error": "article missing"}
        source_kind, source_url = article.source_kind, article.source_url
        file_key, old_title = article.file_key, article.title
        article.status = "parsing"
        article.error = None
        await session.commit()

    try:
        title = None
        if raw_text is not None:
            paragraphs = split_plain_text(raw_text)
        elif source_kind == "file":
            if not file_key:
                raise RuntimeError("file 文章缺少原件 file_key")
            parsed = parse_document(Path(settings.media_root) / file_key, fallback_title=old_title)
            # 单文件文章不分章：章节段落平铺（标题保留为 heading 段）
            paragraphs = [p for chapter in parsed.chapters for p in chapter.paragraphs]
            if parsed.title and parsed.title != old_title:  # pdf 元数据标题优先
                title = parsed.title
        elif source_kind == "url" and source_url:
            html = await fetch_url_html(source_url)
            title, text = extract_html_article(html, url=source_url)
            paragraphs = split_plain_text(text)
        else:
            raise RuntimeError("非 url/file 文章缺少正文文本")
        if not paragraphs:
            raise RuntimeError("正文为空，没有可入库的段落")

        async with SessionFactory() as session:
            article = await session.get(Article, article_id)
            if article is None:
                return {"ok": False, "error": "article missing"}
            p_count, s_count = await replace_article_content(session, article, paragraphs)
            # url 占位标题用抓取标题覆盖；file 文章有 pdf 元数据标题时覆盖文件名
            if title and (source_kind == "file" or article.title == (source_url or "")):
                article.title = title[:512]
            if source_kind == "url":
                article.fetched_at = utcnow()
            await session.commit()
        return {"ok": True, "paragraphs": p_count, "sentences": s_count}
    except Exception as exc:  # 抓取/抽取/解析失败落 article 级错误，可重试
        message = (
            str(exc) if isinstance(exc, DocumentParseError) else f"{type(exc).__name__}: {exc}"
        )[:2000]
        async with SessionFactory() as session:
            article = await session.get(Article, article_id)
            if article is not None:
                article.status = "failed"
                article.error = message
                await session.commit()
        # httpx 异常链上的对象 arq 结果可能无法 pickle，转成纯文本异常
        raise RuntimeError(message) from None


def _article_translate_context(article: Article | None, book_title: str | None) -> str | None:
    """文章 → 翻译语境串：书名 + 篇名，供 LLM 消解领域词歧义。"""
    parts: list[str] = []
    if book_title:
        parts.append(f"书《{book_title}》")
    if article is not None and article.title:
        parts.append(f"篇名《{article.title}》")
    return "；".join(parts) if parts else None


async def translate_article(ctx: dict, article_id: int, engine: str = "auto") -> dict:
    """整章逐句预翻译：缓存优先，已译句跳过，可断点续传。

    与视频同理，翻译带书名/篇名语境消解领域词歧义；语境进 context_hash 位，
    换语境即换缓存槽（ADR-006）。
    """
    async with SessionFactory() as session:
        article = await session.get(Article, article_id)
        book_title = None
        if article is not None and article.book_id is not None:
            book = await session.get(Book, article.book_id)
            book_title = book.title if book is not None else None
        context = _article_translate_context(article, book_title)
        context_hash = content_key(context) if context else ""
        rows = (
            await session.execute(
                select(Sentence, Paragraph.text)
                .join(Paragraph, Sentence.paragraph_id == Paragraph.id)
                .where(Paragraph.article_id == article_id)
                .order_by(Paragraph.ordinal, Sentence.ordinal)
            )
        ).all()
    total = len(rows)
    translated = skipped = 0
    for sentence, para_text in rows:
        text = utf16_slice(para_text, sentence.char_start, sentence.char_end).strip()
        if not text:
            skipped += 1
            continue
        async with SessionFactory() as session:
            cached = await get_cached(
                session, "sentence", sentence.content_hash, context_hash, "translate", "mt"
            )
            if cached is not None:
                skipped += 1
                continue
            outcome = await translate(text, engine=engine, context=context)
            await save_result(
                session,
                "sentence",
                sentence.content_hash,
                context_hash,
                "translate",
                "mt",
                result=outcome,
                model=outcome["engine"],
            )
            translated += 1
    return {"total": total, "translated": translated, "skipped": skipped}


async def _update_video(video_id: int, **fields) -> None:
    async with SessionFactory() as session:
        video = await session.get(Video, video_id)
        if video is None:
            return
        for key, value in fields.items():
            setattr(video, key, value)
        await session.commit()


def _progress_writer(video_id: int, loop: asyncio.AbstractEventLoop) -> Callable[[int], None]:
    """线程安全的进度回写：整数递增才写库，避免 hooks 高频刷。"""
    last = -1

    def write(pct: int) -> None:
        nonlocal last
        pct = max(0, min(int(pct), 100))
        if pct <= last:
            return
        last = pct
        asyncio.run_coroutine_threadsafe(_update_video(video_id, progress=pct), loop)

    return write


async def _video_source_config() -> dict:
    """凭据库解析 YouTube 下载凭证：kind=video_source 首个 enabled，config 解密。

    无凭据时返回空 dict → 走无凭证默认（能下就下，受 bot 校验限制，FR-21 ③）。
    """
    async with SessionFactory() as session:
        cred = (
            await session.execute(
                select(ProviderCredential)
                .where(ProviderCredential.kind == "video_source", ProviderCredential.enabled)
                .order_by(ProviderCredential.id)
                .limit(1)
            )
        ).scalar_one_or_none()
        config = decrypt_config(cred.config) if cred is not None else {}
        return await video_config(config, session)


def _yt_download(
    url: str,
    dest_dir: Path,
    video_id: int,
    on_progress: Callable[[int], None],
    source_config: dict,
) -> dict:
    """yt-dlp 同步下载（跑在线程池），下载进度映射 0-60；凭证来自凭据库。"""
    import yt_dlp

    def hook(d: dict) -> None:
        if d.get("status") != "downloading":
            return
        total = d.get("total_bytes") or d.get("total_bytes_estimate")
        if total:
            on_progress(int(d.get("downloaded_bytes", 0) * 60 / total))

    base_opts, cookie_path = build_ytdlp_opts(source_config)
    opts = {
        **base_opts,
        "format": format_for_quality(source_config.get("quality")),
        "merge_output_format": "mp4",
        "outtmpl": {"default": str(dest_dir / f"{video_id}.%(ext)s")},
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["en", "en-US", "zh-Hans", "zh-CN"],
        "subtitlesformat": "vtt/srt/best",
        "writethumbnail": True,
        "progress_hooks": [hook],
    }
    try:
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
        except yt_dlp.utils.DownloadError as exc:
            # aria2c 对个别分片 URL 不兼容（exit 1），原地回退原生下载器重试一次
            if "aria2c" not in str(exc) or "external_downloader" not in opts:
                raise
            opts.pop("external_downloader", None)
            opts.pop("external_downloader_args", None)
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
    finally:
        if cookie_path:  # cookies 临时文件用完即删，不留明文
            Path(cookie_path).unlink(missing_ok=True)
    if info and "entries" in info:  # 播放列表链接只取第一条
        info = next(iter(info["entries"] or []), None) or {}
    return info or {}


def _whisper_transcribe(
    media_path: str, model_name: str, on_progress: Callable[[int], None]
) -> tuple[list[Cue], float]:
    """旧入口，只剩 scripts/backfill_video_pipeline.py 在用；实现已并入 domain.transcribe。"""
    return transcribe_cues(media_path, model_name, on_progress)


async def _refine_transcript(
    media_path: str, cues: list[Cue], on_progress: Callable[[int], None]
) -> tuple[list[Cue], dict]:
    """转写后处理：标点恢复 + CTC 强制对齐（ADR-007）。

    两步都是增强项，任一失败都保留原始转写继续走，只在轨 meta 上标注降级。
    标点恢复改写的是文本，故先恢复再对齐——对齐要求文本与音频词序列一致，
    而恢复过校验保证了词序列不变。
    """
    from domain.alignment import align_cues
    from domain.punctuation import restore_punctuation

    meta: dict = {}

    # ---- 标点恢复：按 segment 边界分块并发，词序列校验不过则回退原文 ----
    on_progress(96)
    try:
        full, stat = await restore_punctuation([c.text for c in cues])
        meta["punctuation"] = stat
        if stat["restored"]:
            cues = _redistribute_text(cues, full)
    except Exception as exc:
        logger.warning("标点恢复阶段异常，保留原始转写：%s", exc)
        meta["punctuation"] = {"error": str(exc)[:200]}

    # ---- CTC 强制对齐：词跨度实测由 0.220s 收紧到 0.120s ----
    on_progress(97)
    payload = [
        {"start_ms": c.start_ms, "end_ms": c.end_ms, "text": c.text, "words": c.words or []}
        for c in cues
    ]
    changed = await asyncio.to_thread(align_cues, media_path, payload)
    if changed:
        cues = [
            Cue(start_ms=c.start_ms, end_ms=c.end_ms, text=c.text, words=p["words"] or None)
            for c, p in zip(cues, payload, strict=True)
        ]
    meta["alignment"] = {"engine": "ctc" if changed else "dtw", "cues": changed}
    return cues, meta


def _redistribute_text(cues: list[Cue], full: str) -> list[Cue]:
    """标点恢复后的全文按原 cue 词数切回各 cue。

    恢复过词序列校验，故按空白切分后的词数与原 cue 一一对应；
    对不上时放弃改写，保留原文本（宁可没标点也不能错位）。
    """
    tokens = full.split()
    counts = [len(c.text.split()) for c in cues]
    if sum(counts) != len(tokens):
        logger.warning("标点恢复词数与 cue 不符（%d vs %d），保留原文", len(tokens), sum(counts))
        return cues
    out: list[Cue] = []
    pos = 0
    for cue, n in zip(cues, counts, strict=True):
        out.append(
            Cue(
                start_ms=cue.start_ms,
                end_ms=cue.end_ms,
                text=" ".join(tokens[pos : pos + n]),
                words=cue.words,
            )
        )
        pos += n
    return out


async def _insert_track(
    session: AsyncSession,
    video_id: int,
    kind: str,
    lang: str,
    label: str,
    cues: list[Cue],
    is_default: bool = False,
    meta: dict | None = None,
) -> int:
    track = SubtitleTrack(
        video_id=video_id, kind=kind, lang=lang, label=label, is_default=is_default, meta=meta
    )
    session.add(track)
    await session.flush()
    for ordinal, cue in enumerate(cues):
        session.add(
            SubtitleCue(
                track_id=track.id,
                ordinal=ordinal,
                start_ms=cue.start_ms,
                end_ms=cue.end_ms,
                text=cue.text,
                content_hash=content_key(cue.text),
                words=cue.words,
            )
        )
    return track.id


async def build_sentence_layer(
    session: AsyncSession,
    track_id: int,
    max_unit_s: float | None = None,
    max_unit_chars: int | None = None,
    gap_s: float | None = None,
) -> tuple[int, int, dict]:
    """按轨重建语法句与学习句（ADR-007）。返回 (语法句数, 学习句数, 迁移统计)。

    幂等：先清空该轨已有句层再重建，供加工重跑与回填复用。
    三个阈值可覆盖，供追踪页"改参数重切"（FR-76）。

    删旧句之前先把用户学习记录（已学 ✓ / 收藏 / 旗标 / 听写成绩 / 跟读录音）抄下来，
    重建后按归一化词序列迁回新句（`domain.sentence_migration`）——旧写法一进来就
    `delete(SubtitleSentence)`，CASCADE 会把这些一并带走，重跑一次断句等于清空学习痕迹。
    为此新句先占负序号与旧句共存：旧文本还在才有得比对，删除也能按 `ordinal >= 0` 一次扫净。
    """
    from domain.subtitle_sentences import (
        GAP_S,
        MAX_UNIT_CHARS,
        MAX_UNIT_S,
        Limits,
        build_sentences,
    )

    snapshot = await snapshot_learning_records(session, track_id)
    rows = (
        (
            await session.execute(
                select(SubtitleCue)
                .where(SubtitleCue.track_id == track_id)
                .order_by(SubtitleCue.ordinal)
            )
        )
        .scalars()
        .all()
    )
    cues = [
        {"id": c.id, "text": c.text, "words": c.words, "start_ms": c.start_ms, "end_ms": c.end_ms}
        for c in rows
    ]
    limits = Limits(
        max_unit_s=max_unit_s or MAX_UNIT_S,
        max_unit_chars=int(max_unit_chars or MAX_UNIT_CHARS),
        gap_s=gap_s or GAP_S,
    )
    sentences = build_sentences(cues, limits)
    new_sentences: list[SubtitleSentence] = []
    for ordinal, sent in enumerate(sentences):
        new_sentences.append(
            SubtitleSentence(
                track_id=track_id,
                ordinal=-(ordinal + 1),  # 负号占位，与旧句共存期间不撞 (track_id, ordinal)
                start_ms=sent["start_ms"],
                end_ms=sent["end_ms"],
                text=sent["text"],
                content_hash=content_key(sent["text"]),
                words=sent["words"],
                is_noise=sent["is_noise"],
                src_cue_ids=sent["src_cue_ids"],
            )
        )
    session.add_all(new_sentences)
    await session.flush()

    new_units: list[StudyUnit] = []
    for row, sent in zip(new_sentences, sentences, strict=True):
        for unit in sent["units"]:
            new_units.append(
                StudyUnit(
                    sentence_id=row.id,
                    track_id=track_id,
                    ordinal=-(len(new_units) + 1),
                    start_ms=unit["start_ms"],
                    end_ms=unit["end_ms"],
                    text=unit["text"],
                    char_start=unit["char_start"],
                    char_end=unit["char_end"],
                    content_hash=content_key(unit["text"]),
                )
            )
    session.add_all(new_units)
    await session.flush()

    migration = await migrate_learning_records(
        session, track_id, snapshot, new_sentences, new_units
    )
    await purge_old_sentence_layer(session, track_id)
    for ordinal, row in enumerate(new_sentences):
        row.ordinal = ordinal
    for ordinal, unit in enumerate(new_units):
        unit.ordinal = ordinal
    await session.flush()
    return len(new_sentences), len(new_units), migration


async def _ingest_downloaded_subs(video_id: int, videos_dir: Path, info: dict) -> tuple[int, bool]:
    """把 yt-dlp 落盘的 vtt/srt 入库，返回 (轨道数, 是否有官方 en 轨)。"""
    official_langs = set(info.get("subtitles") or {})
    tracks = 0
    has_official_en = False
    for path in sorted(videos_dir.glob(f"{video_id}.*")):
        parts = path.name.split(".")
        if path.suffix.lower() not in SUB_EXTS or len(parts) < 3:
            continue
        lang = parts[-2]
        cues = parse_subtitles(path.read_text(encoding="utf-8", errors="ignore"))
        if not cues:
            continue
        # 官方/自动字幕无词级时间戳：按字符长度比例插值近似，轨级标 approximate（FR-19）
        for cue in cues:
            cue.words = interpolate_words(cue.text, cue.start_ms, cue.end_ms) or None
        official = lang in official_langs
        is_en = lang.lower().startswith("en")
        is_default = official and is_en and not has_official_en
        async with SessionFactory() as session:
            await _insert_track(
                session,
                video_id,
                "official" if official else "auto",
                lang,
                f"{lang} · {'官方' if official else '自动'}",
                cues,
                is_default=is_default,
                meta={"approximate": True},
            )
            await session.commit()
        tracks += 1
        has_official_en = has_official_en or (official and is_en)
    return tracks, has_official_en


# 节点 → 进度区间：进度条按节点分段，不再是笼统的 0-100（FR-69）
# 节点进度区间的唯一事实源是 domain.pipeline 的 StepSpec.progress_span（FR-148），
# 这里只做个查表视图——两处各写一份必然漂
_STEP_PROGRESS: dict[str, tuple[int, int]] = {s.name: s.progress_span for s in STEPS}


@dataclass
class _PipeState:
    """节点之间传递的中间产物；部分重跑时按需从库里补齐。"""

    video_id: int
    source_url: str | None = None
    file_key: str | None = None
    media_path: str | None = None
    cues: list[Cue] | None = None
    cue_meta: dict = dataclass_field(default_factory=dict)
    track_id: int | None = None
    has_official_en: bool = False
    cues_dirty: bool = False
    # 真正跑出这批 cue 的引擎（volc-asr / faster-whisper）。轨的 kind 因存量兼容
    # 仍是 "whisper"，标签里要说实话
    asr_engine: str | None = None
    info: dict = dataclass_field(default_factory=dict)


async def ingest_video(ctx: dict, video_id: int) -> dict:
    """整条入库管线（兼容入口）：等价于从 download 起跑全部节点。"""
    return await run_pipeline(ctx, video_id, trigger="user")


async def run_pipeline(
    ctx: dict,
    video_id: int,
    from_step: str | None = None,
    scope: str = "downstream",
    config_override: dict | None = None,
    trigger: str = "user",
    parent_run_id: int | None = None,
) -> dict:
    """管线统一入口（需求 09 v6 FR-75）：可从任意节点、按指定范围重跑。

    from_step 为空即整条跑。每个节点的起止/异常/metrics/config 落 pipeline_step，
    产出好坏与用了什么模型事后可查——v6 的触发故障正是这些全都没记（ADR-008）。
    """
    from domain.pipeline import PipelineRecorder, resolve_scope

    failed_before: list[str] = []
    if scope == "failed":
        failed_before = await _last_failed_steps(video_id)
    wanted = (
        set(resolve_scope(from_step or "", scope, failed_before))
        if (from_step or scope == "failed")
        else {s.name for s in STEPS}
    )

    recorder = await PipelineRecorder.start(
        SessionFactory,
        video_id,
        trigger=trigger,
        from_step=from_step,
        scope=scope if from_step or scope == "failed" else None,
        config_override=config_override,
        parent_run_id=parent_run_id,
    )
    try:
        result = await _execute_pipeline(ctx, recorder, video_id, wanted)
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"[:2000]
        await recorder.finish("failed", message)
        await _update_video(
            video_id,
            status="failed",
            error=message,
            error_kind=classify_download_error(message),
        )
        # yt-dlp 的 DownloadError 挂着 traceback 对象，arq 结果无法 pickle，转纯文本
        raise RuntimeError(message) from None
    await recorder.finish("success")
    return {"ok": True, "run_id": recorder.run_id, **result}


async def _last_failed_steps(video_id: int) -> list[str]:
    async with SessionFactory() as session:
        run = (
            await session.execute(
                select(PipelineRun)
                .where(PipelineRun.video_id == video_id)
                .order_by(PipelineRun.id.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if run is None:
            return []
        rows = (
            await session.execute(
                select(PipelineStep.name).where(
                    PipelineStep.run_id == run.id, PipelineStep.status == "failed"
                )
            )
        ).scalars()
        return list(rows)


async def _drop_cached_steps(rec, video_id: int, wanted: set[str]) -> set[str]:
    """把输入指纹未变的节点摘出执行集合（FR-196）。

    只对显式声明可缓存、且这次不是用户点名重跑的节点生效——
    用户点名重跑的节点必须真跑，缓存不得覆盖明确意图。
    """
    from domain import artifacts

    explicit = set()
    if rec.overrides:
        explicit = set(rec.overrides)  # 带了配置覆盖的节点视为点名重跑
    keep = set(wanted)
    async with SessionFactory() as session:
        for spec in rec.spec.steps:
            if spec.name not in wanted or spec.name in explicit:
                continue
            if not spec.cacheable or spec.artifact_kind == "none":
                continue
            shas = await artifacts.dep_shas(session, rec.domain, video_id, spec.depends_on)
            if any(not v for v in shas.values()):
                continue  # 上游还没有产物，谈不上命中
            fingerprint = artifacts.input_fingerprint(spec, dep_shas=shas, config={})
            hit = await artifacts.cache_hit(session, rec.domain, video_id, spec.name, fingerprint)
            if hit is not None:
                keep.discard(spec.name)
                await rec.skip(spec.name, "输入未变，复用产物")
    return keep


async def _execute_pipeline(ctx: dict, rec, video_id: int, wanted: set[str]) -> dict:
    """按管线顺序走完十三个节点：要跑的跑，不跑的标 skipped 并从库里补状态。"""
    settings = get_settings()
    media_root = Path(settings.media_root)
    videos_dir = media_root / "videos"
    videos_dir.mkdir(parents=True, exist_ok=True)

    async with SessionFactory() as session:
        video = await session.get(Video, video_id)
        if video is None:
            return {"ok": False, "error": "video missing"}
        state = _PipeState(video_id=video_id, source_url=video.source_url, file_key=video.file_key)

    # 指纹命中的节点直接从执行集合里摘掉，节点自身的 "not in wanted → skip" 分支
    # 会把它标成跳过。这样 13 个 _step_* 一个都不用改（FR-196）。
    wanted = await _drop_cached_steps(rec, video_id, wanted)

    loop = asyncio.get_running_loop()
    report = _progress_writer(video_id, loop)

    await _step_download(ctx, rec, state, videos_dir, media_root, report, wanted)
    await _step_probe(rec, state, media_root, videos_dir, wanted)
    await _step_subtitles(rec, state, videos_dir, wanted)
    await _step_transcribe(rec, state, media_root, settings, report, wanted)
    await _step_punctuate(rec, state, media_root, wanted)
    await _step_align(rec, state, media_root, wanted)
    await _step_sentences(rec, state, wanted)
    await _step_translate(ctx, rec, state, wanted)
    await _run_enrich_steps(rec, state, wanted)
    await _step_verify(rec, state, wanted)

    return {
        "track_id": state.track_id,
        "cues": len(state.cues or []),
        "official_en": state.has_official_en,
    }


def _progress_to(report, step: str) -> None:
    span = _STEP_PROGRESS.get(step)
    if span:
        report(span[0])


async def _step_download(ctx, rec, state, videos_dir, media_root, report, wanted) -> None:
    if "download" not in wanted or not state.source_url:
        reason = "本地导入无需下载" if not state.source_url else "沿用已下载的媒体"
        await rec.skip("download", reason)
        return
    _progress_to(report, "download")
    await _update_video(
        state.video_id, status="downloading", progress=0, error=None, error_kind=None
    )
    quality = rec.cfg("download", "quality")
    async with rec.step("download", {"quality": quality}) as h:
        source_config = await _video_source_config()
        if quality:
            source_config = {**source_config, "quality": quality}
        info = await asyncio.to_thread(
            _yt_download, state.source_url, videos_dir, state.video_id, report, source_config
        )
        media_file = next(
            (
                p
                for p in sorted(videos_dir.glob(f"{state.video_id}.*"))
                if p.suffix.lower() in VIDEO_EXTS and len(p.name.split(".")) == 2
            ),
            None,
        )
        if media_file is None:
            raise RuntimeError("yt-dlp finished but no media file found")
        state.info = info
        state.file_key = str(media_file.relative_to(media_root))
        h.measure(
            file_mb=round(media_file.stat().st_size / 1048576, 1),
            height=info.get("height"),
            format_id=info.get("format_id"),
            ytdlp=_ytdlp_version(),
        )
        h.log(f"下载完成 {media_file.name}")


def _ytdlp_version() -> str | None:
    try:
        import yt_dlp

        return yt_dlp.version.__version__
    except Exception:
        return None


async def _step_probe(rec, state, media_root, videos_dir, wanted) -> None:
    if "probe" not in wanted or not state.info:
        await rec.skip("probe", "无新的下载元数据")
        return
    async with rec.step("probe") as h:
        info = state.info
        thumb_file = next(
            (
                p
                for p in sorted(videos_dir.glob(f"{state.video_id}.*"))
                if p.suffix.lower() in THUMB_EXTS
            ),
            None,
        )
        await _update_video(
            state.video_id,
            title=(info.get("title") or state.source_url or "")[:512],
            channel=(info.get("channel") or info.get("uploader") or None),
            duration_s=int(info["duration"]) if info.get("duration") else None,
            file_key=state.file_key,
            thumb_key=str(thumb_file.relative_to(media_root)) if thumb_file else None,
        )
        h.measure(
            title=info.get("title"),
            channel=info.get("channel"),
            duration_s=info.get("duration"),
            thumb=bool(thumb_file),
        )


async def _step_subtitles(rec, state, videos_dir, wanted) -> None:
    if "subtitles_fetch" not in wanted or not state.info:
        # 部分重跑时官方字幕状态从库里读，决定要不要转写
        state.has_official_en = await _has_official_en(state.video_id)
        await rec.skip("subtitles_fetch", "无新的下载产物")
        return
    async with rec.step("subtitles_fetch") as h:
        count, has_official = await _ingest_downloaded_subs(state.video_id, videos_dir, state.info)
        state.has_official_en = has_official
        h.measure(tracks=count, official_en=has_official)
        h.log("有官方英文字幕，跳过转写" if has_official else "无官方英文字幕，走 whisper")


async def _has_official_en(video_id: int) -> bool:
    async with SessionFactory() as session:
        rows = (
            await session.execute(
                select(SubtitleTrack.kind).where(SubtitleTrack.video_id == video_id)
            )
        ).scalars()
        return "official" in set(rows)


async def _step_transcribe(rec, state, media_root, settings, report, wanted) -> None:
    if "transcribe" not in wanted or state.has_official_en or not state.file_key:
        reason = "有官方英文字幕" if state.has_official_en else "沿用已有转写"
        await rec.skip("transcribe", reason)
        await _load_existing_cues(state)
        return
    _progress_to(report, "transcribe")
    await _update_video(state.video_id, status="transcribing", progress=60)
    state.media_path = str(media_root / state.file_key)
    model_name = rec.cfg("transcribe", "whisper_model") or settings.whisper_model
    # 重跑时显式指定 whisper_model 视为「我就要本地这一档」，不去抢火山
    pinned = bool(rec.cfg("transcribe", "whisper_model"))
    async with SessionFactory() as session:
        route = (
            prepare_local_asr_route(model_name, capability="video.transcribe")
            if pinned
            else await prepare_preferred_asr_route(session, capability="video.transcribe")
        )
    # engine 进标签（要短且可读），model 进台账与产物（要上游真名，核心原则 6）。
    # whisper 的 model 是本机文件系统路径，塞进标签会变成一长串
    engine = route.snapshot.plugin_id
    asr_model = route.snapshot.model
    async with rec.step("transcribe", {"whisper_model": model_name, "asr_model": asr_model}) as h:
        # 转写经 ASR seam：模型单例、线程池与台账身份都在 Provider 里
        transcript = await transcribe_with_fallback(
            route,
            path=state.media_path,
            word_timestamps=True,
            on_progress=report,
            capability="video.transcribe",
        )
        cues, duration = transcript.cues, transcript.duration_s
        state.cues = cues
        state.cues_dirty = True
        state.asr_engine = engine
        h.measure(
            cues=len(cues),
            duration_s=round(duration, 1),
            words=sum(len(c.words or []) for c in cues),
            model=asr_model,
            engine=engine,
        )
        h.produce(
            {
                "cues": len(cues),
                "model": asr_model,
                "engine": engine,
                "duration_s": round(duration, 1),
            },
            key="\n".join(c.text for c in cues),
            summary=f"{len(cues)} 条 · {round(duration)}s",
        )
        if not cues:
            h.log("未检出语音，纯音乐或无音轨")


async def _load_existing_cues(state) -> None:
    """部分重跑：从库里把主轨 cue 读回来当作上游产物。"""
    track, cues = await _primary_cues(state.video_id)
    if track is None:
        return
    state.track_id = track.id
    state.cue_meta = dict(track.meta or {})
    state.cues = [
        Cue(start_ms=c.start_ms, end_ms=c.end_ms, text=c.text, words=c.words) for c in cues
    ]


async def _step_punctuate(rec, state, media_root, wanted) -> None:
    if "punctuate" not in wanted or not state.cues:
        await rec.skip("punctuate", "无转写文本" if not state.cues else "沿用已有标点")
        return
    from domain.punctuation import restore_punctuation

    force = bool(rec.cfg("punctuate", "force"))
    alias = str(rec.cfg("punctuate", "alias"))
    async with rec.step("punctuate", {"alias": alias, "force": force}) as h:
        try:
            full, stat = await restore_punctuation([c.text for c in state.cues], force=force)
            state.cue_meta["punctuation"] = stat
            if stat["restored"]:
                state.cues = _redistribute_text(state.cues, full)
                state.cues_dirty = True
            h.measure(**stat)
        except Exception as exc:  # 增强项失败不阻断，只在 meta 上标降级
            state.cue_meta["punctuation"] = {"error": str(exc)[:200]}
            h.log(f"标点恢复异常，保留原始转写：{exc}")


async def _step_align(rec, state, media_root, wanted) -> None:
    if "align" not in wanted or not state.cues:
        await rec.skip("align", "无转写文本" if not state.cues else "沿用已有对齐")
        return
    from domain.alignment import align_cues

    media_path = state.media_path or (str(media_root / state.file_key) if state.file_key else None)
    if media_path is None:
        await rec.skip("align", "没有媒体文件")
        return
    pad_ms = int(rec.cfg("align", "pad_ms") or 200)
    async with rec.step("align", {"pad_ms": pad_ms}) as h:
        payload = [
            {"start_ms": c.start_ms, "end_ms": c.end_ms, "text": c.text, "words": c.words or []}
            for c in state.cues
        ]
        changed = await asyncio.to_thread(align_cues, media_path, payload, pad_ms)
        if changed:
            state.cues = [
                Cue(start_ms=c.start_ms, end_ms=c.end_ms, text=c.text, words=p["words"] or None)
                for c, p in zip(state.cues, payload, strict=True)
            ]
            state.cues_dirty = True
        engine = "ctc" if changed else "dtw"
        state.cue_meta["alignment"] = {"engine": engine, "cues": changed}
        h.measure(engine=engine, retimed_cues=changed, total_cues=len(state.cues))
        h.produce(
            {"engine": engine, "retimed": changed, "cues": len(state.cues)},
            key="|".join(f"{c.start_ms}-{c.end_ms}" for c in state.cues),
            summary=f"{engine} · 重定时 {changed}",
        )


async def _step_sentences(rec, state, wanted) -> None:
    if "sentences" not in wanted:
        await rec.skip("sentences", "沿用已有句层")
        if state.track_id is None:
            await _load_existing_cues(state)
        return
    if not state.cues:
        await rec.skip("sentences", "无字幕句")
        return
    config = {
        "max_unit_s": float(rec.cfg("sentences", "max_unit_s") or 7.0),
        "max_unit_chars": int(rec.cfg("sentences", "max_unit_chars") or 84),
        "gap_s": float(rec.cfg("sentences", "gap_s") or 0.30),
    }
    async with rec.step("sentences", config) as h:
        from domain.pipeline import PIPELINE_VERSION

        state.cue_meta["pipeline"] = {"version": PIPELINE_VERSION}
        if state.cues_dirty or state.track_id is None:
            state.track_id = await _persist_whisper_track(state)
        else:
            # 句层重建时也清一次 auto 轨：它没有句层，用户切过去是空的（BR-23）
            dropped = await _drop_auto_tracks(state.video_id)
            if dropped:
                h.log(f"清掉 {dropped} 条无句层的 YouTube auto 轨")
        async with SessionFactory() as session:
            n_sent, n_unit, migration = await build_sentence_layer(
                session, state.track_id, **config
            )
            await session.commit()
        if migration["records_lost"]:
            h.log(f"{migration['records_lost']} 条学习记录/录音找不到新落点，已记入问题清单")
        # 长句兜底（FR-102）：pysbd 切不动的超长句，LLM 主动补标点再按标点切开
        from domain.sentence_ops import force_split_long

        async with SessionFactory() as session:
            fallback = await force_split_long(session, state.track_id)
            await session.commit()
        stats = await _sentence_stats(state.track_id)
        h.measure(
            sentences=n_sent,
            units=n_unit,
            **stats,
            **migration,
            long_fallback=fallback["long_sentences"],
            fallback_split=fallback["split_into"],
        )
        h.produce(
            {"sentences": n_sent, "units": n_unit, **stats},
            key=await _sentence_content_key(state.track_id),
            summary=f"{n_sent} 句 / {n_unit} 学习句",
        )
        if fallback["still_long"]:
            h.log(f"兜底后仍有 {len(fallback['still_long'])} 条超长句，见体检报告")
        h.log(f"{n_sent} 语法句 / {n_unit} 学习句")


async def _drop_auto_tracks(video_id: int) -> int:
    """删掉 YouTube auto 轨：ADR-007 判定其不可用，留着只会让用户切过去看到空句层。

    带人工修改的轨不删（BR-36）：auto 轨正常不该被编辑，但真编辑过就说明
    用户在它上面投入过，删掉是不可逆的损失，宁可留一条没用的轨。
    """
    async with SessionFactory() as session:
        edited_tracks = set(
            (
                await session.execute(
                    select(SubtitleSentence.track_id)
                    .join(SubtitleTrack, SubtitleTrack.id == SubtitleSentence.track_id)
                    .where(
                        SubtitleTrack.video_id == video_id,
                        SubtitleTrack.kind == "auto",
                        SubtitleSentence.edited_fields.is_not(None),
                    )
                )
            ).scalars()
        )
        stmt = delete(SubtitleTrack).where(
            SubtitleTrack.video_id == video_id, SubtitleTrack.kind == "auto"
        )
        if edited_tracks:
            logger.info("保留 %d 条含人工修改的 auto 轨", len(edited_tracks))
            stmt = stmt.where(SubtitleTrack.id.notin_(edited_tracks))
        result = await session.execute(stmt)
        await session.commit()
        return result.rowcount or 0


async def _persist_whisper_track(state) -> int:
    """写入/覆盖 whisper 轨；ADR-007 判定 auto 轨不可用，一并清掉（BR-23）。"""
    async with SessionFactory() as session:
        await session.execute(
            delete(SubtitleTrack).where(
                SubtitleTrack.video_id == state.video_id,
                SubtitleTrack.kind.in_(("whisper", "auto")),
            )
        )
        # kind 沿用 "whisper" 是**存量兼容**：库页、学习页、重跑判据、体检、
        # `_primary_cues` 全按这个值查轨，改它要同步迁移存量行与七八处查询。
        # 但标签要说实话——engine 记的是真正跑出这条轨的引擎（volc-asr / faster-whisper）。
        engine = state.asr_engine or "whisper"
        track_id = await _insert_track(
            session,
            state.video_id,
            "whisper",
            "en",
            f"en · {engine}",
            state.cues,
            is_default=True,
            meta=state.cue_meta or None,
        )
        video = await session.get(Video, state.video_id)
        if video is not None and video.duration_s is None and state.cues:
            video.duration_s = int(state.cues[-1].end_ms / 1000)
        await session.commit()
        return track_id


async def _translation_content_key(track_id: int) -> str:
    """译文内容指纹：下游的摘要/词组依赖译文，译文没变就不该让它们陈旧。"""
    async with SessionFactory() as session:
        rows = (
            await session.execute(
                select(SubtitleSentence.text_zh)
                .where(SubtitleSentence.track_id == track_id)
                .order_by(SubtitleSentence.ordinal)
            )
        ).scalars()
        return "\n".join(r or "" for r in rows)


async def _sentence_content_key(track_id: int) -> str:
    """句层内容指纹：句文本按序拼接。译文与词组挂在句上，句变了它们必须跟着重算。"""
    async with SessionFactory() as session:
        rows = (
            await session.execute(
                select(SubtitleSentence.text)
                .where(SubtitleSentence.track_id == track_id)
                .order_by(SubtitleSentence.ordinal)
            )
        ).scalars()
        return "\n".join(rows)


async def _sentence_stats(track_id: int) -> dict:
    from domain.subtitle_sentences import MAX_UNIT_CHARS, MAX_UNIT_S

    async with SessionFactory() as session:
        sents = (
            (
                await session.execute(
                    select(SubtitleSentence).where(SubtitleSentence.track_id == track_id)
                )
            )
            .scalars()
            .all()
        )
        units = (
            (await session.execute(select(StudyUnit).where(StudyUnit.track_id == track_id)))
            .scalars()
            .all()
        )
    over = sum(
        1
        for u in units
        if (u.end_ms - u.start_ms) / 1000 > MAX_UNIT_S + 0.01 or len(u.text) > MAX_UNIT_CHARS
    )
    return {
        "noise": sum(1 for s in sents if s.is_noise),
        "over_limit": over,
        "longest_sentence": max((len(s.text) for s in sents), default=0),
    }


async def _step_translate(ctx, rec, state, wanted) -> None:
    if "translate" not in wanted:
        await rec.skip("translate", "沿用已有译文")
        return
    if state.track_id is None:
        await _load_existing_cues(state)
    if state.track_id is None:
        await rec.skip("translate", "无字幕轨")
        return
    engine = str(rec.cfg("translate", "engine") or "auto")
    refresh = bool(rec.cfg("translate", "refresh"))
    async with rec.step("translate", {"engine": engine, "refresh": refresh}) as h:
        try:
            stat = await translate_track(
                ctx,
                state.track_id,
                engine,
                refresh=refresh,
                override_manual=bool(rec.cfg("translate", "override_manual")),
            )
            h.measure(**{k: v for k, v in stat.items() if isinstance(v, int | str | float)})
            locked = int(stat.get("locked") or 0)
            h.produce(
                {k: v for k, v in stat.items() if isinstance(v, int | str | float)},
                key=await _translation_content_key(state.track_id),
                summary=f"{stat.get('translated', 0)} 句新译"
                + (f" · 保留 {locked} 条人工修改" if locked else ""),
            )
            if locked:
                h.log(f"保留 {locked} 条人工修改的译文（BR-36）")
        except Exception as exc:  # 翻译失败不阻断视频可用（BR-15），但要留痕
            h.log(f"翻译失败，视频仍可用：{exc}")
            raise


async def _run_enrich_steps(rec, state, wanted) -> None:
    """AI 加工四步：彼此独立，单步失败不拖垮其余（各自记 failed）。"""
    todo = [n for n in ENRICH_STEP_NAMES if n in wanted]
    if not todo:
        for name in ENRICH_STEP_NAMES:
            await rec.skip(name, "本次不加工")
        return
    async with SessionFactory() as session:
        video = await session.get(Video, state.video_id)
        title, duration_s = (video.title, video.duration_s) if video else ("", None)
    track, cues = await _primary_cues(state.video_id)
    if track is None or not cues:
        for name in todo:
            await rec.skip(name, "无字幕句，无从加工")
        await _update_video(state.video_id, enrich_status="failed")
        return

    for name in ENRICH_STEP_NAMES:
        if name not in todo:
            await rec.skip(name, "本次不加工")
            continue
        short = name.split(".", 1)[1]
        await _update_video(state.video_id, enrich_status=short)
        try:
            async with rec.step(name) as h:
                if short == "summary":
                    stat = await _enrich_summary(state.video_id, title, cues)
                elif short == "difficulty":
                    stat = await _enrich_difficulty(state.video_id, cues, duration_s)
                elif short == "phrases":
                    stat = await _enrich_phrases(state.video_id, track.id, cues)
                else:
                    stat = await _enrich_vocab(state.video_id, track.id, cues, force=True)
                h.measure(**{k: v for k, v in stat.items() if isinstance(v, int | str | float)})
        except Exception as exc:
            logger.warning("AI 加工 %s 失败：%s", name, exc)
    await _update_video(state.video_id, enrich_status="done", enriched_at=utcnow())


async def _step_verify(rec, state, wanted) -> None:
    """末节点：确定性体检 + LLM 无参考裁判，并据此判 ready / degraded（FR-79/80）。"""
    if "verify" not in wanted:
        await rec.skip("verify", "本次不体检")
        return
    from domain.pipeline_health import inspect

    do_review = bool(rec.cfg("verify", "ai_review"))
    alias = str(rec.cfg("verify", "alias"))
    async with rec.step("verify", {"ai_review": do_review, "alias": alias}) as h:
        async with SessionFactory() as session:
            report = await inspect(session, state.video_id)
        issues = list(report["issues"])
        review_stat: dict = {}
        if do_review and report["metrics"].get("sentences"):
            review_stat = await _run_ai_review(state.video_id, alias)
        await _store_issues(state.video_id, report, review_stat)

        gate = report["gate"]
        await _update_video(state.video_id, status=gate, progress=100, error=None, error_kind=None)
        h.measure(
            gate=gate,
            issues=len(issues) + len(review_stat.get("issues") or []),
            errors=sum(1 for i in issues if i["level"] == "error"),
            ai_issues=len(review_stat.get("issues") or []),
            **{k: v for k, v in report["metrics"].items() if isinstance(v, int | str)},
        )
        for issue in issues:
            h.log(f"[{issue['level']}] {issue['message']}")


async def _run_ai_review(video_id: int, alias: str) -> dict:
    from domain.subtitle_review import review

    async with SessionFactory() as session:
        video = await session.get(Video, video_id)
        track, _cues = await _primary_cues(video_id)
        if track is None:
            return {}
        rows = (
            (
                await session.execute(
                    select(SubtitleSentence)
                    .where(SubtitleSentence.track_id == track.id)
                    .order_by(SubtitleSentence.ordinal)
                )
            )
            .scalars()
            .all()
        )
        payload = [
            {"ordinal": r.ordinal, "text": r.text, "text_zh": r.text_zh, "id": r.id}
            for r in rows
            if not r.is_noise
        ]
        by_ordinal = {r.ordinal: r.id for r in rows}
    if not payload:
        return {}
    context = _video_translate_context(video) or ""
    stat = await review(payload, context=context, alias=alias)
    for issue in stat.get("issues") or []:
        issue["sentence_id"] = by_ordinal.get(issue["ordinal"])
    return stat


async def _store_issues(video_id: int, report: dict, review_stat: dict) -> None:
    """问题清单落库（FR-140）。

    只清 `open` 的——问题是产物的函数，但**人的决定不是**。旧版每次 verify 都
    `DELETE` 全表再重建，于是「采纳 15 条 → 重跑中文轨 → verify → 采纳记录被抹光 →
    LLM 重新裁判 109 句 → 又冒 12 条新问题」，永远处理不完。

    两条抑制规则，避免把人已经处理过的又端上来：
    - 同一句同一类**已被忽略**过 → 不再冒（人说过"这不是问题"）
    - 建议与句子现有文本一致 → 不插（LLM 建议改成它已经是的样子，纯噪声）
    """
    async with SessionFactory() as session:
        # 保留 accepted/dismissed，只清未处理的；学习记录丢失是一次性事故记录而不是
        # 产物的属性，重跑体检时不能顺手把它抹掉（否则重建句层的损失永远看不见）
        await session.execute(
            delete(SubtitleIssue).where(
                SubtitleIssue.video_id == video_id,
                SubtitleIssue.state == "open",
                SubtitleIssue.kind != ISSUE_KIND_RECORDS_LOST,
            )
        )
        await session.flush()

        decided = (
            (
                await session.execute(
                    select(SubtitleIssue).where(
                        SubtitleIssue.video_id == video_id, SubtitleIssue.state != "open"
                    )
                )
            )
            .scalars()
            .all()
        )
        dismissed_keys = {(d.sentence_id, d.kind) for d in decided if d.state == "dismissed"}

        for issue in report["issues"]:
            if (None, issue["code"]) in dismissed_keys:
                continue
            session.add(
                SubtitleIssue(
                    video_id=video_id,
                    source="health",
                    kind=issue["code"],
                    severity=issue["level"],
                    detail=issue["message"],
                    suggestion=issue.get("fix_step"),
                )
            )

        ai_issues = review_stat.get("issues") or []
        sent_ids = [i.get("sentence_id") for i in ai_issues if i.get("sentence_id")]
        current: dict[int, tuple[str, str | None]] = {}
        if sent_ids:
            rows = (
                (
                    await session.execute(
                        select(SubtitleSentence).where(SubtitleSentence.id.in_(sent_ids))
                    )
                )
                .scalars()
                .all()
            )
            current = {r.id: (r.text, r.text_zh) for r in rows}

        for issue in ai_issues:
            sid = issue.get("sentence_id")
            if (sid, issue["kind"]) in dismissed_keys:
                continue
            suggestion = (issue.get("suggestion") or "").strip()
            if sid is not None and suggestion:
                text, text_zh = current.get(sid, ("", None))
                target = text_zh if issue["kind"] == "translation_mismatch" else text
                # 建议 == 现状：这条已经被采纳过或本就没问题，端上来只是噪声
                if (target or "").strip() == suggestion:
                    continue
            session.add(
                SubtitleIssue(
                    video_id=video_id,
                    sentence_id=sid,
                    source="ai",
                    kind=issue["kind"],
                    severity=issue["severity"],
                    detail=issue["detail"],
                    suggestion=issue.get("suggestion"),
                    action=issue.get("action"),
                    anchor=issue.get("anchor"),
                )
            )
        await session.commit()


def _video_translate_context(video: Video | None) -> str | None:
    """视频 → 翻译语境串（中文标题 + 主题标签 + 摘要节选）。

    摘要截断到 120 字：语境是给 LLM 定调用的，长了反而稀释注意力也增加每句开销。
    """
    if video is None:
        return None
    parts: list[str] = []
    title = video.title_zh or video.title
    if title:
        parts.append(f"视频《{title}》")
    if video.topics:
        parts.append("主题：" + "、".join(str(t) for t in video.topics[:3]))
    if video.summary_zh:
        parts.append("内容简介：" + video.summary_zh[:120])
    return "；".join(parts) if parts else None


async def translate_track(
    ctx: dict,
    track_id: int,
    engine: str = "auto",
    refresh: bool = False,
    override_manual: bool = False,
) -> dict:
    """按语法句翻译写入 sentence.text_zh（ADR-007 FR-29）。

    原实现逐 cue 翻译另建 translation 轨，而 cue 是按长度硬切的半句，译文必然残缺；
    且 YouTube auto/zh 轨与 whisper/en 轨切分口径不同，前端按时间中点凑对，
    15 号视频 71 条英文对 190 条中文，凑出的是半句与 `[音乐]`。改为一句一译后
    译文与语法句天然一一对应，不再需要对齐。

    翻译带视频语境（标题/摘要/主题）消解领域词歧义：无语境时 LLM 只能按最常见词义
    翻，英式口语的 the tube 会被译成"管子"。语境进 analysis_result 的 context_hash 位，
    换了语境即换缓存槽，不会命中旧的无语境译文（ADR-006）。

    缓存优先，已有译文的句跳过，可断点续传；refresh=True 忽略两级缓存整轨重翻（FR-76）。
    """
    async with SessionFactory() as session:
        source = await session.get(SubtitleTrack, track_id)
        if source is None:
            return {"ok": False, "error": "track missing"}
        if source.lang.startswith("zh"):
            return {"ok": False, "error": "source track is already Chinese"}
        video_id = source.video_id
        video = await session.get(Video, video_id)
        context = _video_translate_context(video)
        context_hash = content_key(context) if context else ""
        sentences = (
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
        pending = [
            (row.id, row.content_hash, row.text)
            for row in sentences
            if not row.is_noise
            and (refresh or not (row.text_zh or "").strip())
            # 人工改过的译文不进重译候选，除非调用方显式要求覆盖（FR-206）
            and (override_manual or not ratchet.is_locked(row, "text_zh"))
        ]
        locked = ratchet.locked_count(sentences, "text_zh")
        skipped = len(sentences) - len(pending)

    await _update_video(video_id, status="translating")
    translated = cached_hits = 0
    try:
        for sent_id, content_hash, text in pending:
            async with SessionFactory() as session:
                cached = (
                    None
                    if refresh
                    else await get_cached(
                        session, "sentence", content_hash, context_hash, "translate", "mt"
                    )
                )
                if cached is not None:
                    zh = (cached.result or {}).get("text") or ""
                    cached_hits += 1
                else:
                    outcome = await translate(text, engine=engine, context=context)
                    await save_result(
                        session,
                        "sentence",
                        content_hash,
                        context_hash,
                        "translate",
                        "mt",
                        result=outcome,
                        model=outcome["engine"],
                    )
                    zh = outcome["text"]
                    translated += 1
                row = await session.get(SubtitleSentence, sent_id)
                if row is not None:
                    # 二次确认：候选算出后用户可能刚改了这句，写前再挡一道
                    ratchet.apply(row, "text_zh", zh, override=override_manual)
                await session.commit()
    finally:
        # 补译窗口关闭：清掉 zh_refill_at，之后再看到缺口就是真缺（FR-142）。
        # 留着的话 3 分钟宽限期内真实缺失会被当成"正在补"而漏报。
        async with SessionFactory() as session:
            tr = await session.get(SubtitleTrack, track_id)
            if tr is not None and (tr.meta or {}).get("zh_refill_at"):
                meta = dict(tr.meta or {})
                meta.pop("zh_refill_at", None)
                tr.meta = meta
                await session.commit()
        # 不再无条件置 ready——那正是 v6 故障的放行者。按体检结论定 ready / degraded；
        # 走管线时末节点 verify 会再算一次，直接调本任务（/tracks/{id}/translate）
        # 也不会把视频卡在"翻译中"。
        await _apply_gate(video_id)
    return {
        "total": len(sentences),
        "translated": translated,
        "cached": cached_hits,
        "skipped": skipped,
        # 因人工修改而跳过的句数：UI 据此如实说"保留了 N 条人工译文"（FR-206）
        "locked": locked,
        "track_id": track_id,
    }


async def _apply_gate(video_id: int) -> None:
    """按体检结论把视频状态定为 ready / degraded（FR-79）。"""
    from domain.pipeline_health import inspect

    async with SessionFactory() as session:
        report = await inspect(session, video_id)
    await _update_video(video_id, status=report["gate"], progress=100)


async def repair_agent_turn(ctx: dict, session_id: int) -> dict:
    """修复代理跑一轮（需求 09 v7 FR-85~90）：读会话历史 → PydanticAI 代理执行 →
    回复与工具审计落库。

    工具（重跑管线、改句、体检）直调领域函数，不绕 HTTP；单轮可能含多次工具调用，
    重跑下游时以分钟计——SSE 会把执行中的动作实时推给前端，聊天不装死。
    """
    from pydantic_ai.messages import ModelMessagesTypeAdapter
    from pydantic_core import to_jsonable_python

    from domain.model_invocations import ModelInvocationSpan, invocation_context
    from domain.model_runtime import ModelRuntimeError, prepare_chat_route
    from domain.repair_agent import (
        DEFAULT_ALIAS,
        FALLBACK_ALIAS,
        RepairDeps,
        build_agent,
    )

    async with SessionFactory() as session:
        row = await session.get(RepairSession, session_id)
        if row is None:
            return {"ok": False, "error": "session missing"}
        # 别名未在配置中心绑定时回退通用别名，会话不因配置缺失而挂死
        alias = row.model_alias or DEFAULT_ALIAS
        deployment_id = row.model_deployment_id
        from domain.credentials import get_binding

        if alias == DEFAULT_ALIAS and await get_binding(session, DEFAULT_ALIAS) is None:
            alias = FALLBACK_ALIAS
        last_user = (
            (
                await session.execute(
                    select(RepairMessage)
                    .where(
                        RepairMessage.session_id == session_id,
                        RepairMessage.role.in_(("user", "system")),
                    )
                    .order_by(RepairMessage.id.desc())
                    .limit(1)
                )
            )
            .scalars()
            .first()
        )
        prompt = last_user.content if last_user else "请检查这个视频的字幕质量。"
        history_raw = row.history
        video_id, step_name = row.video_id, row.step_name
        confirmed = row.pending_action if row.status == "confirmed" else None
        row.status = "working"
        row.updated_at = datetime.now(UTC)
        await session.commit()

    deps = RepairDeps(
        session_id=session_id,
        video_id=video_id,
        step_name=step_name,
        session_factory=SessionFactory,
        ctx=ctx,
        confirmed_action=confirmed,
    )
    if step_name:
        prompt = f"[用户在「{step_name}」节点发起反馈] {prompt}"

    history = ModelMessagesTypeAdapter.validate_python(history_raw) if history_raw else None
    try:
        route = await prepare_chat_route(
            alias,
            "chat.complete",
            deployment_id=deployment_id,
        )
    except ModelRuntimeError as exc:
        span = await ModelInvocationSpan(
            plugin_id="unresolved",
            operation="chat.complete",
            model=alias,
            capability=alias,
            deployment_id=deployment_id,
            request={"source": "repair.agent", "session_id": session_id},
        ).start()
        await span.fail(exc)
        route = None
    agent = build_agent(alias, route) if route is not None else None
    try:
        if agent is None:
            raise ModelRuntimeError(f"修复代理模型不可用：{alias}")
        with invocation_context(
            source="repair.agent",
            repair_session_id=session_id,
            video_id=video_id,
            step_name=step_name,
        ):
            result = await agent.run(prompt, deps=deps, message_history=history)
        reply = result.output
        new_history = to_jsonable_python(result.all_messages())
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"[:500]
        logger.warning("修复代理轮次失败：%s", message)
        async with SessionFactory() as session:
            row = await session.get(RepairSession, session_id)
            if row is not None:
                row.status = "open"
                await session.commit()
            session.add(
                RepairMessage(
                    session_id=session_id,
                    role="assistant",
                    content=f"这一轮执行失败（{message}）。可以重发消息重试，"
                    "或换更强的模型再来一次。",
                )
            )
            await session.commit()
        return {"ok": False, "error": message}

    async with SessionFactory() as session:
        row = await session.get(RepairSession, session_id)
        if row is not None:
            row.history = new_history
            row.status = "open"
            row.updated_at = datetime.now(UTC)
            if confirmed is not None:
                row.pending_action = None  # 已确认的动作执行完毕，清门
            await session.commit()
        session.add(RepairMessage(session_id=session_id, role="assistant", content=reply))
        await session.commit()
    return {"ok": True, "alias": alias, "deployment_id": deployment_id}


SCENARIO_JOB_TTL = 3600  # 生成进度键存活 1 小时，够前端轮询与失败后回看


def scenario_job_key(job_id: str) -> str:
    return f"scenario_deck_job:{job_id}"


async def generate_scenario_deck(
    ctx: dict,
    job_id: str,
    idea: str,
    level: str | None = None,
    with_examples: bool = True,
    scene: dict | None = None,
    wordlist_id: int | None = None,
    only: list[str] | None = None,
    need_confirm: bool = False,
    with_passage: bool = True,
    config_override: dict | None = None,
) -> dict:
    """AI 场景本生成，跑在多域管线设施上（需求 12 §7.2）。

    与视频管线同构：节点状态落 pipeline_step、产物落 step_artifact、可单独重跑。
    Redis 进度键保留作实时推送通道，不再是唯一事实源。
    """
    from domain.pipeline import PipelineRecorder
    from domain.scenario_decks import (
        DOMAIN,
        STAGES,
        GenerateFailed,
        build_scenario_deck,
        create_shell,
    )

    redis = ctx["redis"]
    key = scenario_job_key(job_id)

    async def publish(payload: dict, status: str = "running") -> None:
        stage = payload.get("stage", "normalize")
        body = {
            **payload,
            "job_id": job_id,
            "status": status,
            "stage_label": STAGES.get(stage, stage),
            "idea": idea,
            "wordlist_id": payload.get("wordlist_id", wordlist_id),
        }
        await redis.set(key, json.dumps(body, ensure_ascii=False), ex=SCENARIO_JOB_TTL)

    await publish({"stage": "normalize", "detail": "排队中", "counts": {}})

    # 主体必须先于 run 存在：空壳建好后拓扑图与重跑才有 subject 可挂
    if wordlist_id is None:
        async with SessionFactory() as session:
            wordlist_id = await create_shell(session, idea)

    recorder = await PipelineRecorder.start(
        SessionFactory,
        wordlist_id,
        kind="generate",
        trigger="user",
        domain=DOMAIN,
        from_step=only[0] if only else None,
        scope="downstream" if only else None,
        config_override=config_override,
    )
    try:
        async with SessionFactory() as session:
            result = await build_scenario_deck(
                session,
                idea,
                wordlist_id=wordlist_id,
                recorder=recorder,
                level=level,
                with_examples=with_examples,
                scene=scene,
                wanted=set(only) if only else None,
                with_passage=with_passage,
                on_progress=publish,
            )
    except (GenerateFailed, LLMUnavailable) as exc:
        await recorder.finish("failed", str(exc))
        await publish(
            {"stage": "failed", "detail": str(exc), "error": str(exc), "wordlist_id": wordlist_id},
            status="failed",
        )
        return {"ok": False, "error": str(exc), "wordlist_id": wordlist_id}
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        await recorder.finish("failed", message)
        await publish(
            {"stage": "failed", "detail": message, "error": message, "wordlist_id": wordlist_id},
            status="failed",
        )
        raise

    if need_confirm:
        # 暂停等人：写 interrupt 后 job 正常结束，绝不在 worker 里等（BR-37）
        await _await_confirm(recorder, wordlist_id, result)
        detail = f"共 {result['counts']['kept']} 词，待确认"
        stage = "confirm"
    else:
        # 默认直接入库：用户没要求过目就不该把本卡在草稿态
        await _auto_confirm(recorder, wordlist_id)
        detail = f"共 {result['counts']['kept']} 词，已入库"
        stage = "done"
    await publish(
        {
            "stage": stage,
            "detail": detail,
            "counts": result["counts"],
            "scene": result["scene"],
            "wordlist_id": wordlist_id,
            "run_id": recorder.run_id,
        },
        status="done",
    )
    return {
        "ok": True,
        "run_id": recorder.run_id,
        "wordlist_id": result["wordlist_id"],
        "counts": result["counts"],
    }


async def _auto_confirm(recorder, wordlist_id: int) -> None:
    """不需要人工确认时直接转正：run 收成 success，本置 ready。"""
    async with SessionFactory() as session:
        wordlist = await session.get(Wordlist, wordlist_id)
        if wordlist is not None:
            wordlist.status = "ready"
        run = await session.get(PipelineRun, recorder.run_id)
        if run is not None:
            run.status = "success"
            run.finished_at = datetime.now(UTC)
        await session.commit()
    await recorder.skip("confirm", "未开启人工确认，已直接入库")


async def _await_confirm(recorder, wordlist_id: int, result: dict) -> None:
    """挂起等人：run 转 awaiting_input，同时落一条 interrupt 记录（FR-199~201）。"""
    async with SessionFactory() as session:
        # 同一主体只应有一个待确认点：重跑会产生新 run，旧的挂起点要作废，
        # 否则确认一次只解掉一条，剩下的永远 waiting
        old_runs = (
            (
                await session.execute(
                    select(PipelineRun.id).where(
                        PipelineRun.domain == "scenario_deck",
                        PipelineRun.subject_id == wordlist_id,
                        PipelineRun.id != recorder.run_id,
                    )
                )
            )
            .scalars()
            .all()
        )
        if old_runs:
            await session.execute(
                update(PipelineInterrupt)
                .where(
                    PipelineInterrupt.run_id.in_(old_runs),
                    PipelineInterrupt.status == "waiting",
                )
                .values(status="expired", resolved_at=datetime.now(UTC))
            )
            await session.execute(
                update(PipelineRun)
                .where(
                    PipelineRun.id.in_(old_runs),
                    PipelineRun.status == "awaiting_input",
                )
                .values(status="success", finished_at=datetime.now(UTC))
            )
        session.add(
            PipelineInterrupt(
                run_id=recorder.run_id,
                step="confirm",
                kind="approve",
                payload={
                    "wordlist_id": wordlist_id,
                    "counts": result["counts"],
                    "title": result["scene"]["title_zh"],
                },
            )
        )
        run = await session.get(PipelineRun, recorder.run_id)
        if run is not None:
            run.status = "awaiting_input"
            run.finished_at = datetime.now(UTC)
        await session.commit()


async def run_due_routines(ctx: dict) -> dict:
    """例程滴答（模块 22）：每分钟同步一次扩展声明的例程，再跑到点的。早报（模块 20）也在这张表里，
    07:30 那一刻由它触发；时间表按系统时区评估。"""
    from domain import extensions, routines

    async with routines.detached_session() as db:
        infos = await extensions.catalog(db)
        await routines.sync(db, extensions.routine_specs(infos))
        await db.commit()
    ran = await routines.run_due()
    return {"ran": ran}


async def poll_subscriptions(ctx: dict, subscription_id: int | None = None) -> dict:
    """轮询订阅源的 RSS，把新片写入候选表（需求 09 v4 FR-45）。

    **只拉列表不下载**（BR-16）：一条 12 分钟视频要吃十几分钟 CPU 与几十 MB 磁盘，
    下不下由人在发现页决定。已入库或已忽略的条目按 video_key 天然去重。
    """
    from domain.subscriptions import SubscriptionError, fetch_feed

    async with SessionFactory() as session:
        q = select(VideoSubscription).where(VideoSubscription.enabled.is_(True))
        if subscription_id is not None:
            q = q.where(VideoSubscription.id == subscription_id)
        subs = [
            (row.id, row.kind, row.source_id, row.title)
            for row in (await session.execute(q)).scalars()
        ]

    total_new = 0
    checked = failed = 0
    for sub_id, kind, source_id, title in subs:
        try:
            items = await fetch_feed(kind, source_id)
        except SubscriptionError as exc:
            failed += 1
            logger.warning("订阅 %s 轮询失败：%s", title, exc)
            async with SessionFactory() as session:
                row = await session.get(VideoSubscription, sub_id)
                if row is not None:
                    row.last_error = str(exc)[:500]
                    row.last_checked_at = datetime.now(UTC)
                await session.commit()
            continue

        async with SessionFactory() as session:
            known = set(
                (
                    await session.execute(
                        select(VideoFeedItem.video_key).where(
                            VideoFeedItem.video_key.in_([i["video_key"] for i in items] or [""])
                        )
                    )
                ).scalars()
            )
            fresh = 0
            for item in items:
                if item["video_key"] in known:
                    continue
                session.add(
                    VideoFeedItem(
                        subscription_id=sub_id,
                        video_key=item["video_key"],
                        title=item["title"],
                        thumb_url=item["thumb_url"],
                        published_at=item["published_at"],
                    )
                )
                fresh += 1
            row = await session.get(VideoSubscription, sub_id)
            if row is not None:
                row.last_checked_at = datetime.now(UTC)
                row.last_error = None
            await session.commit()
        checked += 1
        total_new += fresh
        if fresh:
            logger.info("订阅 %s：新增 %d 条候选", title, fresh)

    filled = await _backfill_feed_meta() if total_new else 0
    return {
        "subscriptions": len(subs),
        "checked": checked,
        "failed": failed,
        "new_items": total_new,
        "meta_filled": filled,
    }


async def _backfill_feed_meta() -> int:
    """轮询后用 Data API 批量补时长/观看数/字幕标志（FR-58），让卡片一眼可判。

    一次 50 条只花 1 unit，日配额 1 万——四次轮询也用不掉个位数。没配 key 就跳过，
    详情弹窗仍会按需走 yt-dlp 补齐（FR-57 回退）。
    """
    from domain.credentials import decrypt_config
    from domain.youtube_api import YouTubeApiError, apply_metadata, fetch_videos

    async with SessionFactory() as session:
        cred = (
            await session.execute(
                select(ProviderCredential)
                .where(ProviderCredential.kind == "video_source", ProviderCredential.enabled)
                .order_by(ProviderCredential.id)
                .limit(1)
            )
        ).scalar_one_or_none()
        api_key = (decrypt_config(cred.config).get("data_api_key") or "").strip() if cred else ""
        if not api_key:
            return 0

        items = (
            (
                await session.execute(
                    select(VideoFeedItem)
                    .where(VideoFeedItem.video_id.is_(None), VideoFeedItem.duration_s.is_(None))
                    .limit(200)
                )
            )
            .scalars()
            .all()
        )
        if not items:
            return 0
        try:
            meta = await fetch_videos([i.video_key for i in items], api_key)
        except YouTubeApiError as exc:
            logger.warning("Data API 回填失败，卡片元数据留待详情按需补：%s", exc)
            return 0

        filled = 0
        for item in items:
            got = meta.get(item.video_key)
            if got is not None:
                apply_metadata(item, got)
                filled += 1
        await session.commit()
        logger.info("Data API 回填候选元数据 %d/%d 条", filled, len(items))
        return filled


# ---- AI 加工任务链（FR-18/FR-20）：摘要 → 难度 → 词组 → 词汇表 ----

# summary-long 别名尚未在网关配置时回退现有 summary 别名（配置中心增补后自动走前者）
_SUMMARY_ALIASES = ("summary-long", "summary")
_PHRASE_ALIASES = ("explain-standard",)
_ENRICH_TEXT_LIMIT = 10_000  # 全字幕文本送 LLM 的截断上限（字符）
_PHRASE_BATCH = 15  # 词组提取每批句数
_LLM_PROVIDER = "llm"


async def _llm_json(aliases: tuple[str, ...], system: str, user: str) -> tuple[dict, str]:
    """按别名顺序尝试 JSON 调用，全部失败抛可 pickle 的 RuntimeError。"""
    last: LLMUnavailable | None = None
    for alias in aliases:
        try:
            parsed, model, _latency = await complete_json(alias, system, user)
            return parsed, model
        except LLMUnavailable as exc:
            last = exc
    raise RuntimeError(f"LLM 不可用（{'/'.join(aliases)}）：{last}")


async def _primary_cues(video_id: int) -> tuple[SubtitleTrack | None, list[SubtitleCue]]:
    """取加工用主字幕轨及其全部 cue（排除翻译轨，选轨规则见 pick_primary_track）。"""
    async with SessionFactory() as session:
        tracks = list(
            (
                await session.execute(
                    select(SubtitleTrack).where(SubtitleTrack.video_id == video_id)
                )
            ).scalars()
        )
        track = pick_primary_track(tracks)
        if track is None:
            return None, []
        cues = list(
            (
                await session.execute(
                    select(SubtitleCue)
                    .where(SubtitleCue.track_id == track.id)
                    .order_by(SubtitleCue.ordinal)
                )
            ).scalars()
        )
        return track, cues


async def _enrich_summary(video_id: int, title: str, cues: list[SubtitleCue]) -> dict:
    """步骤 a：摘要 + 中文标题 + 主题标签 + 口音判定，单次 LLM 调用落 video 行。"""
    text_full = "\n".join(c.text for c in cues)
    truncated = len(text_full) > _ENRICH_TEXT_LIMIT
    system, user = video_summary_prompt(title, text_full[:_ENRICH_TEXT_LIMIT], truncated)
    result, _model = await _llm_json(_SUMMARY_ALIASES, system, user)

    title_zh = str(result.get("title_zh") or "").strip()[:512] or None
    summary_zh = str(result.get("summary_zh") or "").strip() or None
    raw_topics = result.get("topics")
    topics = (
        [str(t).strip() for t in raw_topics if str(t).strip()][:3]
        if isinstance(raw_topics, list)
        else []
    )
    accent = str(result.get("accent") or "").strip().lower()
    await _update_video(
        video_id,
        title_zh=title_zh,
        summary_zh=summary_zh,
        topics=topics or None,
        accent=accent if accent in ACCENTS else None,  # 非法值不落库（不伪造）
    )
    return {"title_zh": bool(title_zh), "topics": len(topics), "accent": accent or None}


async def _enrich_difficulty(
    video_id: int, cues: list[SubtitleCue], duration_s: int | None
) -> dict:
    """步骤 b：ECDICT frq/tag → CEFR 分布 + wpm → 规则映射 1-5 星（无 LLM 依赖）。"""
    tokens = [w for c in cues for w in tokenize_words(c.text)]
    unique = sorted(set(tokens))
    entries: dict[str, tuple[int | None, str | None]] = {}
    async with SessionFactory() as session:
        for i in range(0, len(unique), 1000):  # IN 子句分片，防超长语句
            rows = (
                await session.execute(
                    select(DictEntry.word, DictEntry.frq, DictEntry.tag).where(
                        DictEntry.word.in_(unique[i : i + 1000])
                    )
                )
            ).all()
            entries.update({w: (frq, tag) for w, frq, tag in rows})
    # 分布按去重词型统计，避免 the/a 等高频功能词淹没占比
    levels = [cefr_level(*entries[w]) for w in unique if w in entries]
    dist = cefr_distribution(levels)
    duration = float(duration_s or 0) or (cues[-1].end_ms / 1000 if cues else 0.0)
    wpm = round(len(tokens) / (duration / 60), 1) if duration else 0.0
    stars = difficulty_stars(dist, wpm)
    await _update_video(
        video_id,
        difficulty=stars,
        difficulty_detail={"cefr_dist": dist, "wpm": wpm},
        vocab_count=len(unique),
    )
    return {"difficulty": stars, "wpm": wpm, "vocab_count": len(unique)}


def _normalize_phrases(raw: object) -> list[dict]:
    """LLM 词组结果清洗：text/meaning_zh 必填，type 收敛到三类。"""
    out: list[dict] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        meaning = str(item.get("meaning_zh") or "").strip()
        if not (text and meaning):
            continue
        ptype = str(item.get("type") or "").strip().lower()
        out.append(
            {
                "text": text,
                "type": ptype if ptype in PHRASE_TYPES else "collocation",
                "meaning_zh": meaning,
            }
        )
    return out


async def _enrich_phrases(video_id: int, track_id: int, cues: list) -> dict:
    """步骤 c：逐句词组提取 → 文本定位转 UTF-16 区间落 sentence.phrases（FR-25）。

    定位在语法句而非 cue 上做：cue 由 ASR 按长度硬切，跨 cue 的词组（如被切断的
    `going back to`）在 cue 层根本定位不到（ADR-007）。学习句渲染时按自己的
    字符区间从所属句裁剪。

    句级结果按 content_hash 走 analysis_result 缓存（ADR-006）：字幕编辑后
    hash 变化自然失效重算（BR-02）；定位不到的词组丢弃并计数（不伪造区间）。
    """
    async with SessionFactory() as session:
        cues = (
            (
                await session.execute(
                    select(SubtitleSentence)
                    .where(
                        SubtitleSentence.track_id == track_id,
                        SubtitleSentence.is_noise.is_(False),
                    )
                    .order_by(SubtitleSentence.ordinal)
                )
            )
            .scalars()
            .all()
        )
    phrases_by_ordinal: dict[int, list[dict]] = {}
    pending: list = []
    async with SessionFactory() as session:
        for cue in cues:
            row = await get_cached(
                session, "sentence", cue.content_hash, "", "video_phrases", _LLM_PROVIDER
            )
            if row is not None:
                phrases_by_ordinal[cue.ordinal] = _normalize_phrases(
                    (row.result or {}).get("phrases")
                )
            else:
                pending.append(cue)

    llm_calls = 0
    for i in range(0, len(pending), _PHRASE_BATCH):
        batch = pending[i : i + _PHRASE_BATCH]
        system, user = video_phrases_prompt(
            [{"cue_ordinal": c.ordinal, "text": c.text} for c in batch]
        )
        result, model = await _llm_json(_PHRASE_ALIASES, system, user)
        llm_calls += 1
        returned: dict[int, list[dict]] = {}
        items = result.get("items")
        if isinstance(items, list):
            for item in items:
                if isinstance(item, dict) and isinstance(item.get("cue_ordinal"), int):
                    returned[item["cue_ordinal"]] = _normalize_phrases(item.get("phrases"))
        for cue in batch:  # 未返回的句子也落空结果，缓存命中后不再重复送 LLM
            normalized = returned.get(cue.ordinal, [])
            phrases_by_ordinal[cue.ordinal] = normalized
            async with SessionFactory() as session:
                await save_result(
                    session,
                    "sentence",
                    cue.content_hash,
                    "",
                    "video_phrases",
                    _LLM_PROVIDER,
                    result={"phrases": normalized},
                    model=model,
                )

    located = dropped = 0
    async with SessionFactory() as session:
        db_cues = (
            (
                await session.execute(
                    select(SubtitleSentence).where(SubtitleSentence.track_id == track_id)
                )
            )
            .scalars()
            .all()
        )
        for cue in db_cues:
            spans: list[list] = []
            for phrase in phrases_by_ordinal.get(cue.ordinal) or []:
                span = locate_phrase(cue.text, phrase["text"])
                if span is None:
                    dropped += 1
                    continue
                spans.append([span[0], span[1], phrase["type"], phrase["meaning_zh"]])
                located += 1
            cue.phrases = spans or None  # 重跑幂等：无词组的句子清空旧区间
        await session.commit()
    return {"located": located, "dropped": dropped, "llm_calls": llm_calls}


async def _study_unit_texts(track_id: int) -> list[tuple[int, str]]:
    """按轨取学习句 (ordinal, text)：词卡出处定位的坐标系（前端按 StudyUnit.ordinal 查）。

    噪声句（[Music] / [掌声]）不进播放序列（BR-09），前端的学习句数组里也没有它们，
    定位到那里等于给一个点不开的出处。
    """
    async with SessionFactory() as session:
        rows = (
            await session.execute(
                select(StudyUnit.ordinal, StudyUnit.text)
                .join(SubtitleSentence, SubtitleSentence.id == StudyUnit.sentence_id)
                .where(StudyUnit.track_id == track_id, SubtitleSentence.is_noise.is_(False))
                .order_by(StudyUnit.ordinal)
            )
        ).all()
    return [(r[0], r[1]) for r in rows]


async def _enrich_vocab(
    video_id: int, track_id: int, cues: list[SubtitleCue], force: bool
) -> dict:
    """步骤 d：重点词汇表 20-40 个，落 analysis_result(document/video_vocab)。

    content_hash 为字幕全文指纹（源字幕行，寻址口径不变）；出处由服务端回查定位
    （不信 LLM 编号）。定位落在**学习句**上：字段名沿用 `cue_ordinal`（前端在读），
    装的是 `StudyUnit.ordinal`——前端词卡就是拿它去 StudyUnit 数组里查出处，
    换成源字幕行的编号会指到一句无关的话（实测 36 张卡只有 10 张对）。
    """
    text_full = "\n".join(c.text for c in cues)
    fingerprint = content_key(text_full)
    if not force:  # 自动链路缓存优先；only=vocab 显式重跑走新版本
        async with SessionFactory() as session:
            row = await get_cached(
                session, "document", fingerprint, "", "video_vocab", _LLM_PROVIDER
            )
        if row is not None:
            return {"items": len((row.result or {}).get("items") or []), "cached": True}

    truncated = len(text_full) > _ENRICH_TEXT_LIMIT
    system, user = video_vocab_prompt(text_full[:_ENRICH_TEXT_LIMIT], truncated)
    result, model = await _llm_json(_SUMMARY_ALIASES, system, user)
    unit_texts = await _study_unit_texts(track_id)
    items: list[dict] = []
    raw_items = result.get("items")
    for item in raw_items if isinstance(raw_items, list) else []:
        if not (isinstance(item, dict) and item.get("word") and item.get("meaning_zh")):
            continue
        word = str(item["word"]).strip()
        level = str(item.get("level") or "").strip().upper()
        items.append(
            {
                "word": word,
                "meaning_zh": str(item["meaning_zh"]).strip(),
                "cue_ordinal": first_cue_ordinal(unit_texts, word),
                "level": level if level in CEFR_LEVELS else None,
            }
        )
    async with SessionFactory() as session:
        await save_result(
            session,
            "document",
            fingerprint,
            "",
            "video_vocab",
            _LLM_PROVIDER,
            result={"items": items},
            model=model,
        )
    return {"items": len(items), "cached": False}


async def enrich_video(ctx: dict, video_id: int, only: str | None = None) -> dict:
    """AI 加工（兼容入口，FR-20）：委托给管线跑 enrich.* 节点，跑完接体检。

    only 指定单步时只跑该步；不指定则四步全跑。末节点 verify 依体检结论定
    ready / degraded，不再"跑完就算 ready"（FR-79）。
    """
    from domain.pipeline import PipelineRecorder

    steps = [f"enrich.{only}"] if only in ENRICH_STEPS else list(ENRICH_STEP_NAMES)
    recorder = await PipelineRecorder.start(SessionFactory, video_id, kind="enrich", trigger="user")
    state = _PipeState(video_id=video_id)
    try:
        await _run_enrich_steps(recorder, state, set(steps))
        await _step_verify(recorder, state, {"verify"})
    except Exception as exc:
        await recorder.finish("failed", f"{type(exc).__name__}: {exc}")
        raise
    await recorder.finish("success")
    return {"ok": True, "run_id": recorder.run_id, "steps": steps}


# ---- 创作任务租约：协作取消 + 心跳（模块 17 调研 §2.6/§2.8） ----

LEASE_POLL_SECONDS = 2.0
LEASE_HEARTBEAT_SECONDS = 30.0
# 先让 arq 自己 cancel（它会把任务记成 aborted、不重试）；宽限内没动手再直接 cancel
LEASE_ABORT_GRACE_SECONDS = 1.5


class StudioTaskLease:
    """worker 侧的任务租约：后台协程每 2s 查 Redis 取消标记，每 30s 刷一次 heartbeat_at。

    心跳走独立会话，不与任务主逻辑的 session 打架；长轮询（工作流/视频/MJ 可达
    一小时）期间也有心跳，租约扫描才分得清"还在等上游"与"worker 已经死了"。
    """

    def __init__(self, ctx: dict, task_id: str) -> None:
        self.task_id = task_id
        self.redis = ctx.get("redis")
        self.job_id = str(ctx["job_id"]) if ctx.get("job_id") else None
        self._owner: asyncio.Task | None = None
        self._watcher: asyncio.Task | None = None

    async def begin(self) -> bool:
        """已终态的任务（排队时被取消、重复投递）返回 False，调用方跳过执行。

        排队期间就打了取消标记的（恢复入队后又被取消）同样不开跑，直接收口。
        """
        async with SessionFactory() as session:
            task = await session.get(StudioTask, self.task_id)
            if task is not None and task.status in TERMINAL_STATUSES:
                return False
        if self.redis is not None and await is_cancel_requested(self.redis, self.task_id):
            await self.finish_cancelled()
            await clear_cancel_marks(self.redis, self.task_id)
            return False
        if self.redis is not None and self.job_id:
            await register_worker_job(self.redis, self.task_id, self.job_id)
        self._owner = asyncio.current_task()
        self._watcher = asyncio.create_task(
            self._watch(), name=f"studio-task-lease:{self.task_id}"
        )
        return True

    async def _watch(self) -> None:
        next_heartbeat = time.monotonic() + LEASE_HEARTBEAT_SECONDS
        while True:
            await asyncio.sleep(LEASE_POLL_SECONDS)
            try:
                if self.redis is not None and await is_cancel_requested(
                    self.redis, self.task_id
                ):
                    await self._interrupt_owner()
                    return
                if time.monotonic() >= next_heartbeat:
                    next_heartbeat = time.monotonic() + LEASE_HEARTBEAT_SECONDS
                    await self._touch_heartbeat()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Redis/数据库抖动不该杀掉看门协程：下一轮再试，心跳最多晚一个周期
                logger.warning("任务租约巡检失败 task_id=%s: %s", self.task_id, exc)

    async def _interrupt_owner(self) -> None:
        if self.redis is not None and self.job_id:
            await abort_arq_job(self.redis, self.job_id)
            await asyncio.sleep(LEASE_ABORT_GRACE_SECONDS)
        if self._owner is not None and not self._owner.done():
            self._owner.cancel()

    async def _touch_heartbeat(self) -> None:
        async with SessionFactory() as session:
            await session.execute(
                update(StudioTask)
                .where(
                    StudioTask.id == self.task_id,
                    StudioTask.status.in_(tuple(LEASED_STATUSES)),
                )
                .values(heartbeat_at=datetime.now(UTC))
            )
            await session.commit()

    async def finish_cancelled(self) -> None:
        """被取消时收口成 cancelled；任务函数自己已写终态的不动。"""
        async with SessionFactory() as session:
            task = await session.get(StudioTask, self.task_id)
            if task is None or task.status in TERMINAL_STATUSES:
                return
            transition(
                task,
                "cancelled",
                stage="cancelled",
                error=CANCELLED_BY_USER,
                retryable=True,
            )
            await fail_image_jobs(session, self.task_id, CANCELLED_BY_USER)
            await session.commit()

    async def close(self) -> None:
        if self._watcher is not None:
            self._watcher.cancel()
            # gather 不会把子协程的 CancelledError 抛上来；当前协程自己的取消照常传播
            await asyncio.gather(self._watcher, return_exceptions=True)
            self._watcher = None
        if self.redis is not None:
            try:
                await clear_cancel_marks(self.redis, self.task_id)
            except Exception as exc:
                logger.warning("任务租约清理失败 task_id=%s: %s", self.task_id, exc)


async def _project_finished_task(task_id: str) -> None:
    """任务 succeeded/partial 之后把产物落进画布。

    任务函数自己已经 transition + commit 完终态，这里另开会话读最新行再投影；
    projector 出错只记日志，终态不受影响——画布打开时前端照样能从任务记录里捞回来。
    """
    try:
        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is None or task.status not in PROJECTABLE_STATUSES:
                return
            await project_task(session, task)
    except Exception as exc:
        logger.warning("画布 projector 落图失败 task_id=%s: %s", task_id, exc)


def studio_task_job(
    resolve_task_id: Callable[..., Awaitable[str | None]] | None = None,
):
    """创作任务函数的统一外壳：开跑前跳过已终态任务，执行中协作取消 + 心跳，
    被取消时先把任务收口成 cancelled 再把 CancelledError 抛回 arq；任务函数返回后
    把 succeeded/partial 的产物投影到画布。

    默认第一个位置参数就是 task_id；generate_image 拿的是 image_job_id，传 resolver 换算。
    """

    def decorate(func):
        @functools.wraps(func)
        async def wrapper(ctx: dict, *args, **kwargs):
            if resolve_task_id is not None:
                task_id = await resolve_task_id(*args, **kwargs)
            else:
                task_id = args[0] if args else kwargs.get("task_id")
            if not task_id:
                return await func(ctx, *args, **kwargs)
            lease = StudioTaskLease(ctx, str(task_id))
            if not await lease.begin():
                return {"ok": False, "error": "任务已结束，跳过执行", "task_id": str(task_id)}
            try:
                outcome = await func(ctx, *args, **kwargs)
                await _project_finished_task(str(task_id))
                await _fire_task_terminal_triggers(ctx, str(task_id))
                return outcome
            except asyncio.CancelledError:
                await asyncio.shield(lease.finish_cancelled())
                raise
            finally:
                await lease.close()

        return wrapper

    return decorate


async def _image_job_task_id(image_job_id: int, *_args, **_kwargs) -> str | None:
    async with SessionFactory() as session:
        job = await session.get(ImageJob, int(image_job_id))
        return job.studio_task_id if job is not None else None


@studio_task_job(_image_job_task_id)
async def generate_image(
    ctx: dict,
    image_job_id: int,
    from_step: str | None = None,
    config_override: dict | None = None,
    scope: str = "downstream",
) -> dict:
    """生图任务（模块 16 FR-412）：跑 `image_gen` 管线。

    与场景本生成同构——节点状态落 pipeline_step、产物落 step_artifact、可单步重跑。
    `from_step` 非空即重跑，`config_override` 是节点参数（提示词、风格、尺寸…）。
    """
    from domain.image_pipeline import DOMAIN as IMAGE_DOMAIN
    from domain.image_pipeline import run_image_job
    from domain.imagegen import ImageGenError
    from domain.model_invocations import invocation_context
    from domain.models import ImageAsset, ImageJob, StudioTask
    from domain.pipeline import PipelineRecorder, resolve_scope
    from domain.studio_tasks import transition

    wanted: set[str] | None = None
    if from_step:
        wanted = set(resolve_scope(from_step, scope, domain=IMAGE_DOMAIN))

    recorder = await PipelineRecorder.start(
        SessionFactory,
        image_job_id,
        kind="rerun" if from_step else "generate",
        trigger="user",
        domain=IMAGE_DOMAIN,
        from_step=from_step,
        scope=scope if from_step else None,
        config_override=config_override,
    )
    try:
        async with SessionFactory() as session:
            job = await session.get(ImageJob, image_job_id)
            if job is None:
                raise ImageGenError("api", f"生图任务不存在：{image_job_id}")
            job.status = "running"
            job.error = None
            task = await session.get(StudioTask, job.studio_task_id) if job.studio_task_id else None
            if task is not None:
                transition(task, "running", stage="image_pipeline", progress=1)
            await session.commit()
            context = dict(task.source_context or {}) if task is not None else {}
            with invocation_context(
                task_id=task.id if task is not None else None,
                source="image_pipeline",
                tool_id=task.tool_id if task is not None else None,
                canvas_id=context.get("canvas_id"),
                node_id=context.get("node_id"),
            ):
                result = await run_image_job(session, job, recorder=recorder, wanted=wanted)
            job.status = "done"
            if task is not None:
                asset_ids = list(
                    (
                        await session.execute(
                            select(ImageAsset.id).where(ImageAsset.run_id == recorder.run_id)
                        )
                    ).scalars()
                )
                transition(
                    task,
                    "succeeded",
                    stage="completed",
                    result={"run_id": recorder.run_id, "asset_ids": asset_ids},
                )
            await session.commit()
    except asyncio.CancelledError:
        # 取消是 BaseException，下面的 except Exception 接不住；pipeline_run 不收口
        # 就会留成僵尸（启动对账才清）。任务本身由租约外壳写 cancelled。
        await asyncio.shield(recorder.finish("failed", CANCELLED_BY_USER))
        raise
    except ImageGenError as exc:
        await recorder.finish("failed", str(exc))
        async with SessionFactory() as session:
            job = await session.get(ImageJob, image_job_id)
            if job is not None:
                job.status = "failed"
                job.error = f"{exc.kind}: {exc}"
                task = (
                    await session.get(StudioTask, job.studio_task_id)
                    if job.studio_task_id
                    else None
                )
                if task is not None:
                    transition(
                        task,
                        "failed",
                        stage="image_pipeline",
                        error=job.error,
                        retryable=exc.kind not in {"content", "input"},
                    )
                await session.commit()
        return {"ok": False, "error": str(exc), "kind": exc.kind}
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        await recorder.finish("failed", message)
        async with SessionFactory() as session:
            job = await session.get(ImageJob, image_job_id)
            if job is not None:
                job.status = "failed"
                job.error = message
                task = (
                    await session.get(StudioTask, job.studio_task_id)
                    if job.studio_task_id
                    else None
                )
                if task is not None:
                    transition(
                        task,
                        "failed",
                        stage="image_pipeline",
                        error=message,
                        retryable=True,
                    )
                await session.commit()
        raise

    await recorder.finish("success")
    return {"ok": True, "run_id": recorder.run_id, **result}


@studio_task_job()
async def edit_image_task(ctx: dict, task_id: str) -> dict:
    """执行持久化参考图编辑；输入字节已在入队前落存储。"""
    from domain import image_apps, image_assets, image_prompts, imagegen
    from domain.model_catalog import resolve_model_route
    from domain.model_invocations import invocation_context
    from domain.models import ImageAsset, StudioTask
    from domain.storage import StorageError, get_storage
    from domain.studio_tasks import transition

    storage = get_storage()
    temporary_keys: list[str] = []
    try:
        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is None:
                return {"ok": False, "error": f"创作任务不存在：{task_id}"}
            invocation = task.invocation or {}
            transition(task, "running", stage="load_inputs", progress=5)
            await session.commit()

            app = image_apps.get_app(str(invocation.get("app_key") or "image_to_image"))
            payloads: list[tuple[str, bytes]] = []
            for item in invocation.get("uploads") or []:
                key = str(item["storage_key"])
                temporary_keys.append(key)
                payloads.append((str(item.get("name") or "image.png"), await storage.read(key)))
            for raw_id in invocation.get("ref_asset_ids") or []:
                ref_id = int(raw_id)
                row = await session.get(ImageAsset, ref_id)
                if row is None:
                    raise ValueError(f"参考资产不存在：{ref_id}")
                payloads.append((f"asset-{row.id}.png", await storage.read(row.storage_key)))

            mask_item = invocation.get("mask")
            mask_payload = None
            if isinstance(mask_item, dict):
                mask_key = str(mask_item["storage_key"])
                temporary_keys.append(mask_key)
                mask_payload = (
                    str(mask_item.get("name") or "mask.png"),
                    await storage.read(mask_key),
                )
            transition(task, "running", stage="model_edit", progress=20)
            await session.commit()
            route = await resolve_model_route(
                session,
                str(invocation.get("alias") or "image-free"),
                deployment_id=task.deployment_id,
            )
            model_prompt = image_apps.prepare_edit_prompt(app, str(invocation.get("prompt") or ""))
            context = dict(task.source_context or {})
            with invocation_context(
                task_id=task.id,
                source="image_edit",
                tool_id=task.tool_id,
                canvas_id=context.get("canvas_id"),
                node_id=context.get("node_id"),
            ):
                result = await imagegen.edit_images(
                    model_prompt,
                    alias=str(invocation.get("alias") or "image-free"),
                    images=payloads,
                    mask=mask_payload,
                    size=invocation.get("size"),
                    quality=image_defaults.normalize_quality(invocation.get("quality")),
                    n=max(1, min(int(invocation.get("n") or 1), imagegen.MAX_N)),
                    input_fidelity=app.fixed.get("input_fidelity"),
                    route=route,
                )
            transition(task, "running", stage="save_assets", progress=85)
            # 立刻提交：事件取号与落库之间的窗口回到毫秒级，SSE 游标不会卡着等这条
            await session.commit()
            rows = [
                await image_assets.ingest_one(
                    session,
                    data,
                    target_key=app.target_key,
                    prompt=model_prompt,
                    alias=str(invocation.get("alias") or "image-free"),
                    model_reported=result.model_reported,
                    size_req=invocation.get("size"),
                    quality=image_defaults.normalize_quality(invocation.get("quality")),
                    n_index=index,
                    usage=imagegen.usage_with_latency(result),
                    source="edit",
                    parent_id=invocation.get("parent_id"),
                    op=app.key,
                )
                for index, data in enumerate(result.images)
            ]
            transition(
                task,
                "succeeded",
                stage="completed",
                result={"asset_ids": [row.id for row in rows]},
            )
            await session.commit()
        for key in temporary_keys:
            try:
                await storage.delete(key)
            except StorageError:
                logger.warning("创作任务临时输入清理失败：%s", key)
        return {"ok": True, "asset_ids": [row.id for row in rows]}
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        retryable = True
        if isinstance(exc, imagegen.ImageGenError):
            retryable = exc.kind not in {"content", "input"}
        elif isinstance(exc, (ValueError, image_prompts.PromptError)):
            retryable = False
        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is not None:
                transition(
                    task,
                    "failed",
                    stage="image_edit",
                    error=message,
                    retryable=retryable,
                )
                await session.commit()
        return {"ok": False, "error": message}


@studio_task_job()
async def upscale_image_task(ctx: dict, task_id: str) -> dict:
    """Execute Dreamina native super-resolution and persist its image lineage."""
    from domain import image_assets, imagegen
    from domain.model_catalog import resolve_model_route
    from domain.model_invocations import invocation_context
    from domain.models import ImageAsset, StudioTask
    from domain.storage import get_storage
    from domain.studio_tasks import transition

    try:
        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is None:
                return {"ok": False, "error": f"创作任务不存在：{task_id}"}
            invocation = dict(task.invocation or {})
            source_id = int(invocation.get("asset_id") or 0)
            source = await session.get(ImageAsset, source_id)
            if source is None:
                raise ValueError(f"参考资产不存在：{source_id}")
            route = await resolve_model_route(
                session,
                "image-free",
                deployment_id=task.deployment_id,
            )
            if route is None:
                raise ValueError("即梦图片部署未配置")
            transition(task, "running", stage="image_upscale", progress=15)
            await session.commit()
            data = await get_storage().read(source.storage_key)
            resolution_type = str(invocation.get("resolution_type") or "2k")
            context = dict(task.source_context or {})
            with invocation_context(
                task_id=task.id,
                source="image_upscale",
                tool_id=task.tool_id,
                canvas_id=context.get("canvas_id"),
                node_id=context.get("node_id"),
            ):
                result = await imagegen.upscale_jimeng_image(
                    (f"asset-{source.id}.png", data),
                    resolution_type=resolution_type,
                    route=route,
                )
            transition(task, "running", stage="save_assets", progress=85)
            # 立刻提交：事件取号与落库之间的窗口回到毫秒级，SSE 游标不会卡着等这条
            await session.commit()
            rows = [
                await image_assets.ingest_one(
                    session,
                    item,
                    target_key=source.target_key or "free",
                    prompt=f"upscale {resolution_type}",
                    alias="image-free",
                    model_reported=result.model_reported,
                    size_req=resolution_type,
                    quality=source.quality,
                    n_index=index,
                    usage=imagegen.usage_with_latency(result),
                    source="upscale",
                    parent_id=source.id,
                    op="upscale",
                )
                for index, item in enumerate(result.images)
            ]
            transition(
                task,
                "succeeded",
                stage="completed",
                result={"asset_ids": [row.id for row in rows]},
            )
            await session.commit()
            return {"ok": True, "asset_ids": [row.id for row in rows]}
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        retryable = not (
            isinstance(exc, imagegen.ImageGenError)
            and exc.kind in {"binding", "content", "input"}
        ) and not isinstance(exc, ValueError)
        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is not None:
                transition(
                    task,
                    "failed",
                    stage="image_upscale",
                    error=message,
                    retryable=retryable,
                )
                await session.commit()
        return {"ok": False, "error": message}


@studio_task_job()
async def run_studio_chat(ctx: dict, task_id: str) -> dict:
    """持久 LLM 节点：为画布级联和工具 DAG 提供同一 chat.general 合同。"""
    from domain import studio_gpt
    from domain.model_invocations import invocation_context
    from domain.models import StudioTask
    from domain.studio_tasks import transition

    try:
        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is None:
                return {"ok": False, "error": f"创作任务不存在：{task_id}"}
            invocation = dict(task.invocation or {})
            prompt = str(invocation.get("prompt") or "").strip()
            context_items = [
                str(item).strip()
                for item in invocation.get("context") or []
                if str(item).strip()
            ]
            if context_items:
                context_text = "\n".join(f"- {item}" for item in context_items)
                prompt = f"参考上游结果：\n{context_text}\n\n当前任务：\n{prompt}"
            messages: list[dict] = []
            system_prompt = str(invocation.get("system_prompt") or "").strip()
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            messages.extend(
                {
                    "role": str(item.get("role") or "user"),
                    "content": str(item.get("content") or ""),
                }
                for item in invocation.get("messages") or []
                if isinstance(item, dict)
            )
            image_ids = [int(item) for item in invocation.get("image_asset_ids") or []]
            video_ids = [
                int(item) for item in invocation.get("video_media_asset_ids") or []
            ]
            if image_ids or video_ids:
                image_blocks = await studio_gpt.image_blocks(session, image_ids)
                video_blocks = await studio_gpt.video_blocks(session, video_ids)
                messages.append(
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            *image_blocks,
                            *video_blocks,
                        ],
                    }
                )
            else:
                messages.append({"role": "user", "content": prompt})
            source_context = dict(task.source_context or {})
            deployment_id = task.deployment_id
            temperature = invocation.get("temperature")
            tool_id = task.tool_id
            transition(task, "running", stage="chat_complete", progress=15)
            await session.commit()

        with invocation_context(
            task_id=task_id,
            source="studio_chat",
            tool_id=tool_id,
            canvas_id=source_context.get("canvas_id"),
            node_id=source_context.get("node_id"),
        ):
            response = await complete_text(
                "chat-general",
                messages,
                float(temperature) if temperature is not None else None,
                deployment_id=deployment_id,
            )

        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is None:
                return {"ok": False, "error": f"创作任务不存在：{task_id}"}
            transition(
                task,
                "succeeded",
                stage="completed",
                result={"text": response},
            )
            await session.commit()
        return {"ok": True, "text": response}
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is not None:
                transition(
                    task,
                    "failed",
                    stage="chat_complete",
                    error=message,
                    retryable=isinstance(exc, LLMUnavailable),
                )
                await session.commit()
        return {"ok": False, "error": message}


@studio_task_job()
async def run_studio_workflow(ctx: dict, task_id: str) -> dict:
    """ComfyUI / RunningHub 持久工作流任务。"""
    from domain import image_assets, studio_media_assets, workflow_execution
    from domain.credentials import decrypt_config
    from domain.model_invocations import invocation_context
    from domain.models import ProviderCredential, StudioTask, StudioWorkflow
    from domain.studio_tasks import transition

    try:
        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is None:
                return {"ok": False, "error": f"创作任务不存在：{task_id}"}
            invocation = task.invocation or {}
            workflow = await session.get(StudioWorkflow, int(invocation["workflow_id"]))
            credential = await session.get(ProviderCredential, int(invocation["credential_id"]))
            if workflow is None:
                raise ValueError("工作流不存在")
            if credential is None or not credential.enabled:
                raise ValueError("工作流供应商凭据不可用")
            if credential.provider_type != workflow.provider:
                raise ValueError(
                    f"凭据 {credential.provider_type} 不能运行 {workflow.provider} 工作流"
                )
            config = decrypt_config(credential.config)
            source_context = dict(task.source_context or {})
            if task.provider_task_id:
                handle = workflow_execution.resume_handle(
                    workflow.provider,
                    task.provider_task_id,
                    config,
                    use_wallet=bool(invocation.get("use_wallet")),
                    workflow_key=workflow.key,
                    source_id=workflow.source_id,
                    workflow_kind=workflow.kind,
                )
                transition(
                    task,
                    "recovering",
                    stage="provider_recover",
                    progress=max(20, task.progress or 0),
                )
            else:
                transition(task, "submitting", stage="provider_submit", progress=5)
                await session.commit()
                with invocation_context(
                    task_id=task.id,
                    source="workflow_execute",
                    tool_id=task.tool_id,
                    canvas_id=source_context.get("canvas_id"),
                    node_id=source_context.get("node_id"),
                    workflow_id=workflow.id,
                ):
                    handle = await workflow_execution.submit(
                        session,
                        workflow=workflow,
                        config=config,
                        values=dict(invocation.get("fields") or {}),
                        use_wallet=bool(invocation.get("use_wallet")),
                        instance_type=str(invocation.get("instance_type") or ""),
                    )
                transition(
                    task,
                    "running",
                    stage="provider_running",
                    progress=20,
                    provider_task_id=handle.provider_task_id,
                )
            await session.commit()

        # 轮询可能持续一小时，这期间不占用数据库连接。
        with invocation_context(
            task_id=task_id,
            source="workflow_execute",
            tool_id=task.tool_id,
            canvas_id=source_context.get("canvas_id"),
            node_id=source_context.get("node_id"),
            workflow_id=workflow.id,
        ):
            outputs = await workflow_execution.wait_for_outputs(handle)
        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is None:
                return {"ok": False, "error": f"创作任务不存在：{task_id}"}
            invocation = task.invocation or {}
            workflow = await session.get(StudioWorkflow, int(invocation["workflow_id"]))
            if workflow is None:
                raise ValueError("工作流不存在")
            transition(task, "running", stage="save_outputs", progress=88)
            await session.commit()
            items: list[dict] = []
            for index, output in enumerate(outputs):
                if output.kind == "image":
                    row = await image_assets.ingest_one(
                        session,
                        output.data,
                        target_key="workflow",
                        prompt=workflow.title,
                        alias=workflow.provider,
                        model_reported=workflow.source_id,
                        n_index=index,
                        source="workflow",
                        op=workflow.key,
                    )
                    items.append(
                        {
                            "kind": "image",
                            "name": output.name,
                            "asset_id": row.id,
                            **image_assets.asset_view(row),
                        }
                    )
                    continue
                media = await studio_media_assets.ingest_one(
                    session,
                    output.data,
                    kind=(
                        output.kind if output.kind in studio_media_assets.MEDIA_KINDS else "file"
                    ),
                    name=output.name or f"output-{index + 1}",
                    mime=output.mime,
                    source_task_id=task.id,
                    source_url=output.source_url,
                    details={
                        "workflow_id": workflow.id,
                        "workflow_key": workflow.key,
                        "provider": workflow.provider,
                    },
                )
                items.append(
                    {
                        "media_asset_id": media.id,
                        **studio_media_assets.asset_view(media),
                    }
                )
            transition(
                task,
                "succeeded",
                stage="completed",
                result={
                    "workflow_id": workflow.id,
                    "workflow_title": workflow.title,
                    "provider": workflow.provider,
                    "items": items,
                },
            )
            await session.commit()
            return {"ok": True, "items": items}
    except Exception as exc:
        retryable = True
        if isinstance(exc, workflow_execution.WorkflowExecutionError):
            retryable = exc.retryable
        elif isinstance(exc, (KeyError, TypeError, ValueError)):
            retryable = False
        message = f"{type(exc).__name__}: {exc}"
        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is not None:
                # 上游已明确宣布任务失败，用户重试时应新建上游任务；
                # 连接抖动、本地重启则保留 ID，继续轮询而不重复扣费。
                if (
                    isinstance(exc, workflow_execution.WorkflowExecutionError)
                    and exc.kind == "provider_failed"
                ):
                    task.provider_task_id = None
                transition(
                    task,
                    "failed",
                    stage="workflow_execute",
                    error=message,
                    retryable=retryable,
                )
                await session.commit()
        return {"ok": False, "error": message}


async def _project_flow_outcome(session: AsyncSession, outcome) -> None:
    """tick 收尾：本轮新完成节点的产物落进画布；run 到终态时整份 checkpoint 再扫一遍补漏。"""
    from domain.studio_flows import FLOW_TERMINAL_STATUSES

    terminal = outcome.run.status in FLOW_TERMINAL_STATUSES
    if not terminal and not outcome.completed_node_ids:
        return
    try:
        await project_flow_run(
            session, outcome.run, node_ids=None if terminal else outcome.completed_node_ids
        )
    except Exception as exc:
        logger.warning("画布 projector 落级联产物失败 run_id=%s: %s", outcome.run.id, exc)


async def run_studio_flow(ctx: dict, run_id: str) -> dict:
    """持久化工具 DAG 调度 tick；长任务由子 StudioTask 执行。

    skipped 与 waiting_input 都不是失败：条件不成立的分支本来就该跳过，
    等人工输入的运行由恢复端点重新入队，这一轮到此为止属于正常收尾。
    """
    from domain.models import StudioFlowRun
    from domain.studio_flows import (
        FLOW_ACTIVE_STATUSES,
        FLOW_WAITING_STATUS,
        advance_flow_run,
    )

    queue = ctx.get("redis")
    if queue is None:
        return {"ok": False, "error": "worker Redis 连接不存在"}
    try:
        async with SessionFactory() as session:
            outcome = await advance_flow_run(session, queue, run_id)
            await _project_flow_outcome(session, outcome)
        if outcome.needs_poll:
            await queue.enqueue_job("run_studio_flow", run_id, _defer_by=2)
        return {
            "ok": outcome.run.status in {"succeeded", "partial", FLOW_WAITING_STATUS},
            "status": outcome.run.status,
            "waiting_node_id": outcome.run.waiting_node_id,
            "started_task_ids": list(outcome.started_task_ids),
            "active_task_ids": list(outcome.active_task_ids),
        }
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        async with SessionFactory() as session:
            run = await session.get(StudioFlowRun, run_id)
            if run is not None and run.status in FLOW_ACTIVE_STATUSES:
                run.status = "recovering"
                run.error = f"DAG 调度器中断：{message}"
                run.heartbeat_at = datetime.now(UTC)
                await session.commit()
        return {"ok": False, "status": "recovering", "error": message}


async def scan_flow_triggers(ctx: dict) -> dict:
    """cron 触发器扫描（每分钟）：到点的规则各建一条运行。

    判据是"上次触发之后的下一个 cron 点已经过了"，所以扫描本身晚一两分钟也不会
    漏触发；last_fired_at 与运行落在同一个事务里，重复扫描不会重复建 run。
    """
    from domain.studio_flows import StudioFlowError, due_cron_triggers, fire_trigger

    queue = ctx.get("redis")
    if queue is None:
        return {"ok": False, "error": "worker Redis 连接不存在"}
    fired: list[str] = []
    skipped: list[str] = []
    async with SessionFactory() as session:
        for trigger in await due_cron_triggers(session):
            try:
                run = await fire_trigger(session, queue, trigger)
            except (StudioFlowError, ValueError) as exc:
                skipped.append(f"{trigger.id}: {exc}")
                continue
            fired.append(run.id)
    if fired or skipped:
        print(f"工作流定时触发：{len(fired)} 条已入队、{len(skipped)} 条跳过")
    return {"ok": True, "fired": fired, "skipped": skipped}


async def _fire_task_terminal_triggers(ctx: dict, task_id: str) -> None:
    """任务落终态后匹配 task_terminal 触发器；触发失败只记日志，不影响任务终态。"""
    from domain.studio_flows import fire_task_terminal_triggers

    queue = ctx.get("redis")
    if queue is None:
        return
    try:
        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is None:
                return
            await fire_task_terminal_triggers(session, queue, task)
    except Exception as exc:
        logger.warning("任务终态触发工作流失败 task_id=%s: %s", task_id, exc)


@studio_task_job()
async def generate_studio_video(ctx: dict, task_id: str) -> dict:
    """OpenAI Videos / 火山 Seedance 持久视频任务。"""
    from domain import studio_media_assets, video_generation
    from domain.model_catalog import resolve_model_route
    from domain.model_invocations import invocation_context
    from domain.models import StudioTask
    from domain.studio_tasks import transition

    try:
        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is None:
                return {"ok": False, "error": f"创作任务不存在：{task_id}"}
            invocation = dict(task.invocation or {})
            deployment_id = int(invocation.get("deployment_id") or task.deployment_id or 0)
            route = await resolve_model_route(
                session,
                "video-generate",
                deployment_id=deployment_id,
            )
            if route is None:
                raise ValueError("视频模型部署未配置")
            source_context = dict(task.source_context or {})
            if task.provider_task_id:
                handle = video_generation.resume_handle(route, task.provider_task_id)
                transition(
                    task,
                    "recovering",
                    stage="provider_recover",
                    progress=max(20, task.progress or 0),
                )
            else:
                transition(task, "submitting", stage="provider_submit", progress=5)
                await session.commit()
                with invocation_context(
                    task_id=task.id,
                    source="video_generate",
                    tool_id=task.tool_id,
                    canvas_id=source_context.get("canvas_id"),
                    node_id=source_context.get("node_id"),
                ):
                    handle = await video_generation.submit(
                        session,
                        route=route,
                        prompt=str(invocation.get("prompt") or ""),
                        duration=int(invocation.get("duration") or 4),
                        aspect_ratio=str(invocation.get("aspect_ratio") or "16:9"),
                        resolution=str(invocation.get("resolution") or "720p"),
                        reference_asset_id=invocation.get("reference_asset_id"),
                        references=list(invocation.get("references") or []),
                        media_references=list(invocation.get("media_references") or []),
                        options=dict(invocation.get("options") or {}),
                    )
                transition(
                    task,
                    "running",
                    stage="provider_running",
                    progress=20,
                    provider_task_id=handle.provider_task_id,
                )
            await session.commit()

        with invocation_context(
            task_id=task_id,
            source="video_generate",
            tool_id=task.tool_id,
            canvas_id=source_context.get("canvas_id"),
            node_id=source_context.get("node_id"),
        ):
            output = await video_generation.wait_for_output(handle)
        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is None:
                return {"ok": False, "error": f"创作任务不存在：{task_id}"}
            transition(task, "running", stage="save_output", progress=90)
            await session.commit()
            media = await studio_media_assets.ingest_one(
                session,
                output.data,
                kind="video",
                name=output.name or "video.mp4",
                mime=output.mime,
                source_task_id=task.id,
                source_url=output.source_url,
                details={
                    "deployment_id": task.deployment_id,
                    "model": route.upstream_model_id,
                    "provider": route.provider_type,
                },
            )
            item = {
                "media_asset_id": media.id,
                **studio_media_assets.asset_view(media),
            }
            transition(
                task,
                "succeeded",
                stage="completed",
                result={
                    "deployment_id": task.deployment_id,
                    "model": route.upstream_model_id,
                    "provider": route.provider_type,
                    "items": [item],
                },
            )
            await session.commit()
            return {"ok": True, "item": item}
    except Exception as exc:
        retryable = True
        if isinstance(exc, video_generation.VideoGenerationError):
            retryable = exc.retryable
        elif isinstance(exc, (KeyError, TypeError, ValueError)):
            retryable = False
        message = f"{type(exc).__name__}: {exc}"
        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is not None:
                if (
                    isinstance(exc, video_generation.VideoGenerationError)
                    and exc.kind == "provider_failed"
                ):
                    task.provider_task_id = None
                transition(
                    task,
                    "failed",
                    stage="video_generate",
                    error=message,
                    retryable=retryable,
                )
                await session.commit()
        return {"ok": False, "error": message}


@studio_task_job()
async def generate_midjourney(ctx: dict, task_id: str) -> dict:
    """APIMart Midjourney 生成与二次操作持久任务。"""
    from domain import image_assets, midjourney
    from domain.model_catalog import resolve_model_route
    from domain.model_invocations import invocation_context
    from domain.models import StudioTask
    from domain.studio_tasks import transition

    try:
        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is None:
                return {"ok": False, "error": f"创作任务不存在：{task_id}"}
            invocation = dict(task.invocation or {})
            deployment_id = int(invocation.get("deployment_id") or task.deployment_id or 0)
            route = await resolve_model_route(
                session,
                "midjourney",
                deployment_id=deployment_id,
            )
            if route is None or route.adapter_type != "apimart":
                raise ValueError("Midjourney 需要可用的 APIMart 模型部署")
            source_context = dict(task.source_context or {})
            action = str(
                invocation.get("action")
                or invocation.get("mode")
                or "imagine"
            )
            prompt = str(invocation.get("prompt") or "")
            if task.provider_task_id:
                handle = midjourney.resume_handle(
                    route,
                    task.provider_task_id,
                    action=action,
                    prompt=prompt,
                )
                transition(
                    task,
                    "recovering",
                    stage="provider_recover",
                    progress=max(20, task.progress or 0),
                )
            else:
                transition(task, "submitting", stage="provider_submit", progress=5)
                await session.commit()
                with invocation_context(
                    task_id=task.id,
                    source="midjourney",
                    tool_id=task.tool_id,
                    canvas_id=source_context.get("canvas_id"),
                    node_id=source_context.get("node_id"),
                ):
                    if task.task_type == "midjourney.generate":
                        handle = await midjourney.submit_generate(
                            session,
                            route=route,
                            mode=str(invocation.get("mode") or "imagine"),
                            prompt=prompt,
                            size=str(invocation.get("size") or "1:1"),
                            version=str(invocation.get("version") or "8.2"),
                            speed=str(invocation.get("speed") or "relax"),
                            reference_asset_ids=[
                                int(value)
                                for value in invocation.get("reference_asset_ids") or []
                            ],
                            options=dict(invocation.get("options") or {}),
                        )
                    elif task.task_type == "midjourney.action":
                        handle = await midjourney.submit_action(
                            session,
                            route=route,
                            task_id=str(invocation.get("task_id") or ""),
                            action=action,
                            speed=str(invocation.get("speed") or "relax"),
                            index=invocation.get("index"),
                            direction=invocation.get("direction"),
                            zoom_ratio=invocation.get("zoom_ratio"),
                            custom_id=invocation.get("custom_id"),
                            prompt=prompt,
                            mask_asset_id=invocation.get("mask_asset_id"),
                        )
                    else:
                        raise ValueError(f"未知 Midjourney 任务类型：{task.task_type}")
                transition(
                    task,
                    "running",
                    stage="provider_running",
                    progress=20,
                    provider_task_id=handle.provider_task_id,
                )
            await session.commit()

        with invocation_context(
            task_id=task_id,
            source="midjourney",
            tool_id=task.tool_id,
            canvas_id=source_context.get("canvas_id"),
            node_id=source_context.get("node_id"),
        ):
            output = await midjourney.wait_for_output(handle)

        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is None:
                return {"ok": False, "error": f"创作任务不存在：{task_id}"}
            if output.modal_required:
                result = {
                    "provider_task_id": output.provider_task_id,
                    "action": output.action,
                    "prompt": output.prompt,
                    "buttons": output.buttons,
                    "asset_ids": [],
                    "image_count": 0,
                    "modal_required": True,
                }
                transition(
                    task,
                    "succeeded",
                    stage="modal_required",
                    result=result,
                )
                await session.commit()
                return {"ok": True, **result}

            transition(task, "running", stage="save_assets", progress=90)
            await session.commit()
            rows = []
            for index, data in enumerate(output.images):
                row = await image_assets.ingest_one(
                    session,
                    data,
                    target_key="free",
                    prompt=output.prompt or prompt,
                    alias="midjourney",
                    model_reported=route.upstream_model_id,
                    size_req=str(invocation.get("size") or "") or None,
                    n_index=index,
                    source="workbench",
                    op=f"midjourney.{output.action}",
                )
                row.studio_task_id = task.id
                row.options = {
                    **dict(row.options or {}),
                    "provider_task_id": output.provider_task_id,
                    "source_url": output.source_urls[index],
                    "buttons": output.buttons,
                }
                rows.append(row)
            result = {
                "provider_task_id": output.provider_task_id,
                "action": output.action,
                "prompt": output.prompt,
                "buttons": output.buttons,
                "asset_ids": [row.id for row in rows],
                "image_count": len(rows),
                "modal_required": False,
            }
            transition(task, "succeeded", stage="completed", result=result)
            await session.commit()
            return {"ok": True, **result}
    except Exception as exc:
        retryable = True
        if isinstance(exc, midjourney.MidjourneyError):
            retryable = exc.retryable
        elif isinstance(exc, (KeyError, TypeError, ValueError)):
            retryable = False
        message = f"{type(exc).__name__}: {exc}"
        async with SessionFactory() as session:
            task = await session.get(StudioTask, task_id)
            if task is not None:
                transition(
                    task,
                    "failed",
                    stage="midjourney",
                    error=message,
                    retryable=retryable,
                )
                await session.commit()
        return {"ok": False, "error": message}


async def tag_assets_job(ctx: dict, job_id: str, asset_ids: list[int]) -> dict:
    """素材批量 AI 打标（模块 17 FR-484）。

    改成后台任务的原因很实在：同步端点 200 张要串行调 200 次视觉模型，请求在
    十几分钟里一直挂着（M2 已知余项）。这里入队即返回，进度写 Redis 由前端轮询。

    编排全在 `domain/studio_assets.run_tag_job`，这里只负责开会话与拿 Redis
    连接——arq 已经把连接放在 ctx 里，另开一个池只是白占连接数。
    """
    from domain.studio_assets import run_tag_job, save_tag_job

    client = ctx.get("redis")
    try:
        async with SessionFactory() as session:
            state = await run_tag_job(session, job_id, asset_ids, client=client)
    except Exception as exc:
        # 整个任务挂掉（Redis/DB 断了这类）与「某张图打标失败」是两回事：
        # 后者已经逐条记在 items 里，这里落的是「这批根本没跑完」，原因原样带出去
        message = f"{type(exc).__name__}: {exc}"
        logger.exception("打标任务失败 job_id=%s", job_id)
        await save_tag_job(
            {
                "job_id": job_id,
                "total": len(asset_ids),
                "done": 0,
                "failed": 0,
                "status": "failed",
                "items": [],
                "error": message,
            },
            client=client,
        )
        return {"ok": False, "error": message}
    return {"ok": True, "done": state["done"], "failed": state["failed"]}


async def run_deck_ai(ctx: dict, run_id: int) -> dict:
    """本级 AI 补全：一次只跑一片，没跑完就带着新 cursor 把自己重新入队（见 domain/deck_ai）。"""
    outcome, cursor = await deck_ai.run_slice(run_id)
    if outcome == "continue":
        queue = ctx.get("redis")
        if queue is not None:
            await queue.enqueue_job("run_deck_ai", run_id, _job_id=deck_ai.job_id(run_id, cursor))
    return {"outcome": outcome, "cursor": cursor}

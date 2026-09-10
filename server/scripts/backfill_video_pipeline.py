"""全库回填：按 ADR-007 管线重跑所有视频的转写/标点/对齐/句层/翻译。

并发策略：转写与 CTC 对齐吃满多核（单条实测 360% CPU），盲目并发只会互抢；
真正能压缩的是让 CPU 阶段与 IO 阶段（LLM 标点恢复、翻译）重叠。故用两级并发：
    ASR_WORKERS   条视频并行走 CPU 阶段（转写 → 标点恢复 → 对齐 → 句层）
    TRANS_WORKERS 条视频并行走翻译（纯网络 IO，与 CPU 阶段天然重叠）
每个 whisper 实例 cpu_threads=4，M1 Max 10 核下两条并行仍留余量给对齐。

用法：
    uv run python scripts/backfill_video_pipeline.py            # 全库
    uv run python scripts/backfill_video_pipeline.py 5 13 17    # 指定 video id
    uv run python scripts/backfill_video_pipeline.py --keep-auto  # 保留 YouTube auto 轨
    uv run python scripts/backfill_video_pipeline.py --enrich-only  # 只补 AI 加工
"""

import asyncio
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import delete, select  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.db import SessionFactory  # noqa: E402
from domain.models import SubtitleTrack, Video  # noqa: E402
from worker.tasks import (  # noqa: E402
    _refine_transcript,
    _whisper_transcribe,
    build_sentence_layer,
    enrich_video,
    translate_track,
)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
logger = logging.getLogger("backfill")
logging.getLogger("faster_whisper").setLevel(logging.WARNING)

ASR_WORKERS = 2
TRANS_WORKERS = 3


async def _load_targets(ids: list[int]) -> list[tuple[int, str, str]]:
    """待回填视频：(id, 标题, 媒体相对路径)。无媒体文件的跳过。"""
    async with SessionFactory() as session:
        q = select(Video).where(Video.file_key.is_not(None))
        if ids:
            q = q.where(Video.id.in_(ids))
        rows = (await session.execute(q.order_by(Video.id))).scalars().all()
        return [(v.id, v.title_zh or v.title, v.file_key) for v in rows]


async def _drop_auto_tracks(video_id: int) -> int:
    """删除 YouTube auto/official 轨：全小写无标点且带滚动重复词，两条路都不通
    （pysbd 切不动、LLM 标点恢复过不了词序列校验）。英文源只用 whisper。"""
    async with SessionFactory() as session:
        result = await session.execute(
            delete(SubtitleTrack).where(
                SubtitleTrack.video_id == video_id,
                SubtitleTrack.kind.in_(("auto", "official", "translation")),
            )
        )
        await session.commit()
        return result.rowcount or 0


async def asr_stage(video_id: int, title: str, file_key: str, media_root: Path) -> dict:
    """CPU 阶段：转写 → 标点恢复 → CTC 对齐 → 建轨 → 句层。返回统计。"""
    from worker.tasks import _insert_track

    t0 = time.time()
    media_path = str(media_root / file_key)
    cues, duration = await asyncio.to_thread(
        _whisper_transcribe, media_path, get_settings().whisper_model, lambda _p: None
    )
    t_asr = time.time() - t0
    if not cues:
        logger.warning("[%s] %s 无语音，跳过", video_id, title)
        return {"id": video_id, "title": title, "skipped": True}

    t1 = time.time()
    cues, meta = await _refine_transcript(media_path, cues, lambda _p: None)
    t_refine = time.time() - t1

    dropped = await _drop_auto_tracks(video_id)
    async with SessionFactory() as session:
        await session.execute(
            delete(SubtitleTrack).where(
                SubtitleTrack.video_id == video_id, SubtitleTrack.kind == "whisper"
            )
        )
        track_id = await _insert_track(
            session, video_id, "whisper", "en", "en · whisper", cues,
            is_default=True, meta=meta,
        )
        video = await session.get(Video, video_id)
        if video is not None and duration:
            video.duration_s = int(duration)
        await session.commit()
        n_sent, n_unit, _migration = await build_sentence_layer(session, track_id)
        await session.commit()

    stat = {
        "id": video_id, "title": title, "track_id": track_id,
        "cues": len(cues), "sentences": n_sent, "units": n_unit,
        "dropped_tracks": dropped, "duration": duration,
        "t_asr": t_asr, "t_refine": t_refine,
        "punct": meta.get("punctuation"), "align": meta.get("alignment"),
    }
    logger.info(
        "[%s] %s ASR 完成 %.0fs（转写 %.0fs 精修 %.0fs）→ %d cue / %d 句 / %d 学习句 | 标点 %s | 对齐 %s",
        video_id, title, time.time() - t0, t_asr, t_refine,
        len(cues), n_sent, n_unit, meta.get("punctuation"), meta.get("alignment"),
    )
    return stat


async def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    keep_auto = "--keep-auto" in sys.argv
    ids = [int(a) for a in args]
    targets = await _load_targets(ids)
    if not targets:
        logger.error("没有可回填的视频")
        return

    if "--enrich-only" in sys.argv:
        # 句层重建后补 AI 加工：词组区间挂在语法句上，不重跑就没有高亮（FR-25）
        sem = asyncio.Semaphore(TRANS_WORKERS)

        async def only_enrich(vid: int, title: str) -> None:
            async with sem:
                t = time.time()
                try:
                    out = await enrich_video({}, vid)
                    logger.info(
                        "[%s] %s 加工完成 %.0fs（词组 %d）", vid, title, time.time() - t,
                        ((out.get("steps") or {}).get("phrases") or {}).get("located", 0),
                    )
                except Exception as exc:
                    logger.warning("[%s] %s 加工失败：%s", vid, title, exc)

        await asyncio.gather(*(only_enrich(v, t) for v, t, _ in targets))
        return
    media_root = Path(get_settings().media_root)
    total_s = 0.0
    logger.info("回填 %d 条视频（ASR 并发 %d，翻译并发 %d）", len(targets), ASR_WORKERS, TRANS_WORKERS)

    started = time.time()
    asr_sem = asyncio.Semaphore(ASR_WORKERS)
    trans_sem = asyncio.Semaphore(TRANS_WORKERS)
    results: list[dict] = []

    async def one(video_id: int, title: str, file_key: str) -> None:
        """单条视频：CPU 阶段占 asr_sem，完成后立刻放行下一条，自己转去翻译。"""
        nonlocal total_s
        try:
            async with asr_sem:
                stat = await asr_stage(video_id, title, file_key, media_root)
            if stat.get("skipped"):
                results.append(stat)
                return
            total_s += stat.get("duration") or 0
            async with trans_sem:  # 翻译是纯 IO，与后续视频的转写重叠
                t = time.time()
                out = await translate_track({}, stat["track_id"])
                stat["t_translate"] = time.time() - t
                stat["translated"] = out.get("translated", 0)
                stat["cached"] = out.get("cached", 0)
            logger.info(
                "[%s] %s 翻译完成 %.0fs（新译 %d 缓存命中 %d）",
                video_id, title, stat["t_translate"], stat["translated"], stat["cached"],
            )
            # 词组区间挂在语法句上，句层重建后必须重跑 enrich 才有高亮（FR-25）
            async with trans_sem:
                t = time.time()
                try:
                    out = await enrich_video({}, video_id)
                    stat["t_enrich"] = time.time() - t
                    stat["phrases"] = ((out.get("steps") or {}).get("phrases") or {}).get("located", 0)
                    logger.info(
                        "[%s] %s 加工完成 %.0fs（词组 %d 个）",
                        video_id, title, stat["t_enrich"], stat["phrases"],
                    )
                except Exception as exc:
                    logger.warning("[%s] %s 加工失败：%s", video_id, title, exc)
            results.append(stat)
        except Exception as exc:
            logger.exception("[%s] %s 回填失败：%s", video_id, title, exc)
            results.append({"id": video_id, "title": title, "error": str(exc)[:200]})

    if keep_auto:
        globals()["_drop_auto_tracks"] = lambda _vid: asyncio.sleep(0, result=0)

    await asyncio.gather(*(one(v, t, f) for v, t, f in targets))

    elapsed = time.time() - started
    ok = [r for r in results if "error" not in r and not r.get("skipped")]
    logger.info("=" * 78)
    logger.info(
        "回填结束：%d/%d 成功，墙钟 %.1f 分钟，音频总长 %.1f 分钟（RTF %.2f）",
        len(ok), len(targets), elapsed / 60, total_s / 60,
        elapsed / total_s if total_s else 0,
    )
    for r in sorted(results, key=lambda x: x["id"]):
        if "error" in r:
            logger.info("  %3d %-22s 失败 %s", r["id"], r["title"][:22], r["error"])
        elif r.get("skipped"):
            logger.info("  %3d %-22s 跳过（无语音）", r["id"], r["title"][:22])
        else:
            logger.info(
                "  %3d %-22s %4d cue → %4d 句 → %4d 学习句 | 译 %d | 词组 %d | 删轨 %d",
                r["id"], r["title"][:22], r["cues"], r["sentences"], r["units"],
                r.get("translated", 0), r.get("phrases", 0), r.get("dropped_tracks", 0),
            )


if __name__ == "__main__":
    asyncio.run(main())

"""带语境重翻全库字幕（ADR-006 缓存按 content+context 双指纹寻址）。

旧译文是无语境翻的（the tube → "管子"），context_hash 变了不会命中旧缓存，
但 sentence.text_zh 里还留着旧译文，故先清空再重翻。
"""

import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select, update  # noqa: E402

from app.db import SessionFactory  # noqa: E402
from domain.models import SubtitleSentence, SubtitleTrack, Video  # noqa: E402
from worker.tasks import translate_track  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("retranslate")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpx2").setLevel(logging.WARNING)

CONCURRENCY = 3


async def main() -> None:
    ids = [int(a) for a in sys.argv[1:] if not a.startswith("--")]
    async with SessionFactory() as session:
        q = select(SubtitleTrack).where(SubtitleTrack.kind == "whisper")
        if ids:
            q = q.where(SubtitleTrack.video_id.in_(ids))
        tracks = (await session.execute(q.order_by(SubtitleTrack.video_id))).scalars().all()
        pairs = [(t.id, t.video_id) for t in tracks]
        titles = {
            v.id: (v.title_zh or v.title)
            for v in (await session.execute(select(Video))).scalars()
        }

    logger.info("重翻 %d 条轨（并发 %d）", len(pairs), CONCURRENCY)
    sem = asyncio.Semaphore(CONCURRENCY)

    async def one(track_id: int, video_id: int) -> None:
        async with sem:
            async with SessionFactory() as session:  # 清空旧译文，让 translate_track 全量重翻
                await session.execute(
                    update(SubtitleSentence)
                    .where(SubtitleSentence.track_id == track_id)
                    .values(text_zh=None)
                )
                await session.commit()
            try:
                out = await translate_track({}, track_id)
                logger.info(
                    "[%s] %s 重翻完成：新译 %d 缓存 %d",
                    video_id, titles.get(video_id, "?")[:18],
                    out.get("translated", 0), out.get("cached", 0),
                )
            except Exception as exc:
                logger.warning("[%s] 重翻失败：%s", video_id, exc)

    await asyncio.gather(*(one(t, v) for t, v in pairs))
    logger.info("全部完成")


if __name__ == "__main__":
    asyncio.run(main())

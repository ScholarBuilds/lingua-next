"""给八个考纲本生成封面（FR-420a）。

考纲本是**虚拟本**：由 `dict_entry.tag` 现算，没有 wordlist 行，
所以封面不能走 `wordlist.cover_key`，改落 `deck_cover`（按 deck key 寻址）。

配图主体里的 keywords 取该本**实际跑出来的场景名**（词数最多的几个），
封面因此反映这本书真正装了什么，而不是一句泛泛的「四级词汇」。

用途走 `exam_deck_cover` 而不是场景本那个 `deck_cover`：后者问模型
「这本讲的是哪个真实生活场景」，考纲本没有这个答案（中考、GRE 都不是一个地点），
八本一律被答成「书桌 + 单词卡 + 台灯」，keywords 全程没参与——
八张封面长得一模一样，从图上分不出哪本是哪本。

用法：
    uv run python scripts/build_deck_covers.py            # 缺哪本补哪本
    uv run python scripts/build_deck_covers.py --only zk  # 只做一本
    uv run python scripts/build_deck_covers.py --force    # 已有也重画
"""

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import func, select  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from app.config import get_settings  # noqa: E402
from domain import image_defaults, imagegen  # noqa: E402
from domain.models import DeckCover, DeckScene  # noqa: E402

# key → (中文名, 英文名, 一句话定位, CEFR)
DECKS: dict[str, tuple[str, str, str, str]] = {
    "zk": ("中考词汇", "Junior High School English", "初中毕业升学考试大纲词汇", "A2"),
    "gk": ("高考词汇", "College Entrance Exam English", "普通高等学校招生全国统一考试大纲词汇", "B1"),
    "cet4": ("四级词汇", "CET-4", "大学英语四级考试大纲词汇", "B1"),
    "cet6": ("六级词汇", "CET-6", "大学英语六级考试大纲词汇", "B2"),
    "ky": ("考研词汇", "Postgraduate Entrance English", "全国硕士研究生招生考试英语大纲词汇", "B2"),
    "toefl": ("托福词汇", "TOEFL", "TOEFL 学术英语考试高频词汇", "C1"),
    "ielts": ("雅思词汇", "IELTS", "IELTS 学术与生活场景高频词汇", "C1"),
    "gre": ("GRE 词汇", "GRE", "GRE 研究生入学考试高阶词汇", "C2"),
}


async def top_scenes(session, tag: str, n: int = 8) -> list[str]:
    """该本里词数最多的几个场景，当配图关键词用。

    读 `deck_scene` 而不是词表：场景归属是**本**的属性，同一个词在中考与 GRE 里
    归进的组完全可以不同。早先这里按 `word_scene.scene` 取（那时场景还是全局的），
    列改走 `deck_scene` 之后这个查询就查不出东西了——而封面照样画得出来，
    只是关键词全空，退化成一句泛泛的「四级词汇」。
    """
    rows = (
        await session.execute(
            select(DeckScene.scene, func.count())
            .where(DeckScene.deck == tag)
            .group_by(DeckScene.scene)
            .order_by(func.count().desc())
            .limit(n)
        )
    ).all()
    return [r[0] for r in rows if r[0]]


async def one(Session, key: str, force: bool) -> str:
    async with Session() as session:
        cur = await session.get(DeckCover, key)
        if cur is not None and not force:
            return "已有，跳过"
        name, name_en, desc, cefr = DECKS[key]
        scenes = await top_scenes(session, key)
        subject = {
            "title": name,
            "title_en": name_en,
            "description": desc,
            "category": "考纲词表",
            "cefr": cefr,
            "keywords": scenes,
        }
        result = await imagegen.generate_for(
            session,
            target_key="exam_deck_cover",
            subject=subject,
            alias="image-cover",
            style_key="soft-flat",
            quality=image_defaults.normalize_quality(None),
            n=1,
            subject_domain="deck_key",
            subject_id=None,
            source="script",
        )
        assets = result.get("assets") or []
        if not assets:
            return "生成失败：没有产出资产"
        picked = assets[0]
        if cur is None:
            session.add(
                DeckCover(key=key, storage_key=picked.storage_key, asset_id=picked.id)
            )
        else:
            cur.storage_key = picked.storage_key
            cur.asset_id = picked.id
        await session.commit()
        return f"完成（asset {picked.id}，关键词：{'、'.join(scenes[:4])}）"


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=sorted(DECKS), help="只做这一本")
    ap.add_argument("--force", action="store_true", help="已有封面也重画")
    args = ap.parse_args()

    engine = create_async_engine(get_settings().database_url)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    keys = [args.only] if args.only else list(DECKS)
    for key in keys:
        print(f"  {DECKS[key][0]}（{key}）…", end=" ", flush=True)
        try:
            print(await one(Session, key, args.force))
        except Exception as exc:  # noqa: BLE001 - 单本失败不拖垮其余
            print(f"失败：{type(exc).__name__}: {exc}")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())

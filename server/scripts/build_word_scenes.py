"""给一本考纲词表跑出「场景归属 + 例句」。

用法：
    uv run python scripts/build_word_scenes.py zk            # 中考
    uv run python scripts/build_word_scenes.py cet4 --limit 200   # 先试 200 词
    uv run python scripts/build_word_scenes.py zk --stats     # 只看现状不跑

**断点续跑**：产物按词落 `word_scene`，每批 commit。中断后重跑只补没做完的——
分类看 scene 是否为空、例句看 example_en 是否为空，两步各自续。

**场景表不重新生成**：重跑时从已有行反推（distinct scene/track/root）。
重新生成会得到一套新命名，同一本里前后两半分组名对不上。
"""

import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import func, select  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from app.config import get_settings  # noqa: E402
from domain import word_scenes as ws  # noqa: E402
from domain.models import DeckScene  # noqa: E402

EXAM_TAGS = {
    "zk": "中考", "gk": "高考", "cet4": "四级", "cet6": "六级",
    "ky": "考研", "toefl": "托福", "ielts": "雅思", "gre": "GRE",
}


async def derive_taxonomy(session, deck: str) -> list[dict]:
    """从**这一本**已有的归属反推场景表——重跑时用，避免重新生成出一套新命名。

    只看本本的行：分组是本的属性。第一版按词全局反推，结果是第一本的分法被
    后面七本继承又打碎，中考从 30 组变成 143 组、中位 6 词。
    """
    rows = (
        await session.execute(
            select(DeckScene.scene, DeckScene.track, DeckScene.root)
            .where(DeckScene.deck == deck)
            .distinct()
        )
    ).all()
    return [{"name": r[0], "track": r[1], "root": r[2]} for r in rows if r[0]]


async def run_stage(label: str, jobs: list, worker, sem_size: int) -> None:
    """并发跑一组批次，打进度。单批失败不拖垮整轮。"""
    sem = asyncio.Semaphore(sem_size)
    done = 0
    total = len(jobs)
    t0 = time.perf_counter()
    lock = asyncio.Lock()

    async def one(job):
        nonlocal done
        async with sem:
            try:
                await worker(job)
            except Exception as exc:  # noqa: BLE001 - 单批失败继续，最后统计缺口
                print(f"\n  [{label}] 一批失败：{type(exc).__name__}: {exc}")
            async with lock:
                done += 1
                el = time.perf_counter() - t0
                eta = el / done * (total - done)
                print(f"\r  [{label}] {done}/{total} 批  已用 {el/60:.1f} 分  预计还要 {eta/60:.1f} 分",
                      end="", flush=True)

    await asyncio.gather(*(one(j) for j in jobs))
    print()


# 一个分组装多少词才好学：低于下限独立成组没意义，高于上限一次学不完
MIN_BUCKET, MAX_BUCKET = 18, 95


async def rebalance(Session, deck: str, words: list[dict]) -> None:
    """按分类后的实际词数拆大并小。

    这一步必须在分类之后：建表阶段只看词、不做分配，它算不出每组最终多少词。
    """
    zh = {w["word"]: w.get("translation") for w in words}
    async with Session() as s:
        rows = (await s.execute(
            select(DeckScene.scene, DeckScene.track, DeckScene.root, func.count())
            .where(DeckScene.deck == deck)
            .group_by(DeckScene.scene, DeckScene.track, DeckScene.root)
        )).all()
    big = [(r[0], r[1], r[2], int(r[3])) for r in rows if int(r[3]) > MAX_BUCKET]
    small = [(r[0], r[1], r[2], int(r[3])) for r in rows if int(r[3]) < MIN_BUCKET]
    keep = [r[0] for r in rows if MIN_BUCKET <= int(r[3]) <= MAX_BUCKET]
    if not big and not small:
        print("  分组大小都在区间内，无需重平衡")
        return
    print(f"  重平衡：拆 {len(big)} 个过大组、并 {len(small)} 个零碎组")

    async def words_of(scene: str) -> list[dict]:
        async with Session() as s:
            ws_rows = (await s.execute(
                select(DeckScene.word).where(DeckScene.deck == deck, DeckScene.scene == scene)
            )).scalars().all()
        return [{"word": w, "translation": zh.get(w), "scene": scene} for w in ws_rows]

    # 拆大组
    for scene, track, root, n in big:
        parts = max(2, round(n / ws.WORDS_PER_SCENE))
        batch = await words_of(scene)
        try:
            got = await ws.split_bucket(scene, batch, parts)
        except Exception as exc:  # noqa: BLE001
            print(f"    拆「{scene}」失败，保留原样：{type(exc).__name__}")
            continue
        rows_up = [
            {"word": w, "scene": g, "track": track, "root": root}
            for w, g in got.items()
        ]
        async with Session() as s:
            await ws.upsert_scenes(s, deck, rows_up)
        print(f"    「{scene}」{n} 词 → 拆成 {len(set(got.values()))} 组")

    # 并零碎组：目标是拆后仍在区间内的组
    if small and keep:
        batch: list[dict] = []
        for scene, _t, _r, _n in small:
            batch.extend(await words_of(scene))
        try:
            got = await ws.merge_small(batch, keep)
        except Exception as exc:  # noqa: BLE001
            print(f"    并零碎组失败，保留原样：{type(exc).__name__}")
            got = {}
        if got:
            async with Session() as s:
                tracks = {
                    r[0]: (r[1], r[2]) for r in (await s.execute(
                        select(DeckScene.scene, DeckScene.track, DeckScene.root)
                        .where(DeckScene.deck == deck,
                               DeckScene.scene.in_(list(set(got.values())))).distinct()
                    )).all()
                }
                await ws.upsert_scenes(s, deck, [
                    {"word": w, "scene": g,
                     "track": tracks.get(g, ("theme", None))[0],
                     "root": tracks.get(g, ("theme", None))[1]}
                    for w, g in got.items()
                ])
            print(f"    {len(got)} 个零碎词并入 {len(set(got.values()))} 个既有组")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("tag", choices=sorted(EXAM_TAGS))
    ap.add_argument("--limit", type=int, default=0, help="只处理词频最高的 N 个词（试跑用）")
    ap.add_argument("--stats", action="store_true", help="只报现状，不调用 LLM")
    ap.add_argument("--no-rebalance", action="store_true", help="跳过按实际词数拆大并小")
    ap.add_argument("--rebuild", action="store_true", help="丢掉本本已有分组，重新建表重新分类（例句不动）")
    args = ap.parse_args()

    engine = create_async_engine(get_settings().database_url)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    async with Session() as session:
        words = await ws.load_words(session, args.tag)
        if args.limit:
            words = words[: args.limit]
        names = [w["word"] for w in words]
        print(f"《{EXAM_TAGS[args.tag]}》 {len(words)} 词")

        if args.rebuild:
            await ws.clear_deck(session, args.tag)
            print("  已丢掉本本原有分组，重建（例句保留）")
        scened = await ws.deck_scenes(session, args.tag)
        exed = await ws.word_examples(session, names)
        need_class = [w for w in words if w["word"] not in scened]
        need_ex = [w for w in words if w["word"] not in exed or not exed[w["word"]].example_en]
        done_scene = len([w for w in words if w["word"] in scened])
        done_ex = len(words) - len(need_ex)
        print(f"  现状：有场景 {done_scene} / 有例句 {done_ex}"
              f"　　待办：分类 {len(need_class)} / 造句 {len(need_ex)}")

        if args.stats:
            tax = await derive_taxonomy(session, args.tag)
            print(f"  现有场景表 {len(tax)} 个：")
            for t in tax:
                cnt = (await session.execute(
                    select(DeckScene.word)
                    .where(DeckScene.deck == args.tag, DeckScene.scene == t["name"])
                )).all()
                print(f"    [{t['track']}] {t['name']}{' (' + t['root'] + ')' if t['root'] else ''}: {len(cnt)} 词")
            await engine.dispose()
            return

        # ── 第 1 步：场景表 ──
        tax = await derive_taxonomy(session, args.tag)
        if tax:
            print(f"  沿用已有场景表：{len(tax)} 个分组")
        else:
            want = ws.target_scene_count(len(words))
            print(f"  建场景表（目标 {want} 个，每组约 {ws.WORDS_PER_SCENE} 词）…")
            t0 = time.perf_counter()
            tax = await ws.build_taxonomy(words, want)
            print(f"  得到 {len(tax)} 个分组，用时 {time.perf_counter()-t0:.0f}s")
            by_track: dict[str, int] = {}
            for t in tax:
                by_track[t["track"]] = by_track.get(t["track"], 0) + 1
            print("   ", "  ".join(f"{k}={v}" for k, v in sorted(by_track.items())))

        tax_by_name = {t["name"]: t for t in tax}

        # ── 第 2 步：分类 ──
        if need_class:
            batches = [need_class[i:i + ws.CLASSIFY_BATCH]
                       for i in range(0, len(need_class), ws.CLASSIFY_BATCH)]

            async def do_class(batch):
                got = await ws.classify_batch(batch, tax)
                miss = [w for w in batch if w["word"] not in got]
                if miss:  # 模型漏词是常态，漏掉的单独再要一次
                    got.update(await ws.classify_batch(miss, tax))
                rows = []
                for w in batch:
                    g = got.get(w["word"])
                    if not g:
                        continue
                    t = tax_by_name[g]
                    rows.append({"word": w["word"], "scene": g, "track": t["track"], "root": t["root"]})
                async with Session() as s2:
                    await ws.upsert_scenes(s2, args.tag, rows)

            await run_stage("分类", batches, do_class, ws.CONCURRENCY)

        # ── 第 3 步：例句 ──
        session.expire_all()
        scened = await ws.deck_scenes(session, args.tag)
        exed = await ws.word_examples(session, names)
        need_ex = [
            {**w, "scene": scened[w["word"]].scene}
            for w in words
            if w["word"] in scened
            and (w["word"] not in exed or not exed[w["word"]].example_en)
        ]
        if need_ex:
            batches = [need_ex[i:i + ws.EXAMPLE_BATCH]
                       for i in range(0, len(need_ex), ws.EXAMPLE_BATCH)]

            async def do_ex(batch):
                got = await ws.make_examples(batch)
                miss = [w for w in batch if w["word"] not in got]
                if miss:
                    got.update(await ws.make_examples(miss))
                rows = [
                    {"word": w, "example_en": v["en"], "example_zh": v["zh"], "model": v["model"]}
                    for w, v in got.items()
                ]
                async with Session() as s2:
                    await ws.upsert_examples(s2, rows)

            await run_stage("例句", batches, do_ex, ws.CONCURRENCY)

        # ── 第 4 步：按实际词数重平衡 ──
        # 建表阶段看不到最终词数，过大过小只能等分完了用实际计数修。
        # 实测中考建出的表里「认知判断」176 词、「评价判断」139 词，都吃不下；
        # 另一头「王室称谓」只有 3 词，独立成组没有意义。
        if not args.no_rebalance:
            await rebalance(Session, args.tag, words)

        # ── 收尾统计 ──
        # 必须换个干净 session：写入走的是 s2，外层 session 的 identity map 里
        # 还留着写入前加载的同一批对象，且 expire_on_commit=False 不会让它们失效，
        # 直接再 select 拿回的是旧值（实测因此把 60/60 报成了 0%）
        session.expire_all()
        scened = await ws.deck_scenes(session, args.tag)
        exed = await ws.word_examples(session, names)
        with_scene = len([w for w in names if w in scened])
        with_ex = len([w for w in names if w in exed and exed[w].example_en])
        n = len(names)
        print(
            f"\n完成：{n} 词  →  有场景 {with_scene} ({with_scene/n*100:.1f}%)"
            f"　   有例句 {with_ex} ({with_ex/n*100:.1f}%)"
        )
        if with_scene < n or with_ex < n:
            print("  缺口是模型漏词造成的，直接重跑本脚本即可补齐（只补缺的）")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())

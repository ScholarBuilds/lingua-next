"""误区目录与语法练习卡入库（FR-402、FR-404）。

用法（server 目录）：
    uv run python scripts/seed_grammar_cards.py --misconceptions   # 只灌误区目录
    uv run python scripts/seed_grammar_cards.py --cards --limit 60 # 给前 60 个语法点出题
    uv run python scripts/seed_grammar_cards.py --check

出题优先级：**先给在自己语料里真的出现过的语法点出题**。这些点用户真读到过，
练了立刻能在原文里印证；给一个从没见过的点出题，练完也没有落点。

题型顺序按 structured input 排（FR-404）：指称型 → 情感型 → 语料定位 → 产出型。
语料定位题不在这里生成——它由 `/grammar/points/{id}/locate` 用现成的 occurrence 现出，
零 LLM 成本。
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import func, select  # noqa: E402

from app.db import SessionFactory  # noqa: E402
from domain import exercise  # noqa: E402
from domain.llm import LLMUnavailable, complete_json  # noqa: E402
from domain.misconceptions import CATALOG  # noqa: E402
from domain.models import (  # noqa: E402
    GrammarCard,
    GrammarOccurrence,
    GrammarPoint,
    Misconception,
)

POINTS_PER_CALL = 4


async def seed_misconceptions() -> None:
    async with SessionFactory() as s:
        codes = dict(
            (
                await s.execute(select(GrammarPoint.shorthand_code, GrammarPoint.id))
            ).all()
        )
        by_prefix: dict[str, int] = {}
        for code, pid in codes.items():
            by_prefix.setdefault(code.rsplit(".", 1)[0], pid)
            by_prefix.setdefault(code.split(".")[0], pid)

        # 不能 TRUNCATE ... CASCADE：writing_edit 有指向本表的外键，
        # CASCADE 会连用户的错题本一起清空（实测就这么丢过一次批改记录）。
        # 改成按 code 更新已有行、只插新增的，重跑不伤历史数据
        existing = {
            m.code: m for m in (await s.execute(select(Misconception))).scalars()
        }
        unbound = []
        rows = []
        for m in CATALOG:
            pid = None
            if m.remedial_code:
                pid = (
                    codes.get(m.remedial_code)
                    or by_prefix.get(m.remedial_code)
                    or by_prefix.get(m.remedial_code.split(".")[0])
                )
                if pid is None:
                    unbound.append((m.code, m.remedial_code))
            hit = existing.get(m.code)
            if hit is not None:
                hit.name = m.name
                hit.description = m.description
                hit.feedback = m.feedback
                hit.errant_types = list(m.errant_types)
                hit.remedial_point_id = pid
                continue
            rows.append(
                {
                    "code": m.code,
                    "name": m.name,
                    "description": m.description,
                    "feedback": m.feedback,
                    "errant_types": list(m.errant_types),
                    "remedial_point_id": pid,
                    "hit_count": 0,
                }
            )
        if rows:
            await s.execute(Misconception.__table__.insert(), rows)
        # 目录里删掉的误区：留着历史引用，只是不再新命中
        stale = set(existing) - {m.code for m in CATALOG}
        await s.commit()
    print(f"误区目录：新增 {len(rows)}，更新 {len(CATALOG) - len(rows)}，库内多余 {len(stale)}")
    if unbound:
        print(f"  ⚠ 补救语法点没绑上：{unbound}")


# ─────────────── 出题 ───────────────

CARD_SYSTEM = """你在给中国英语学习者出语法练习题。对给到的每个语法点，出 3 道题。

题型与要求：

1. `referential` —— **指称型结构化输入**。给一句英文和一个问题，问题的答案**必须**
   靠目标语法形式才能得出，语义线索要剥干净。
   例：句子 "He worked at the bank."，问「说的是现在还是过去？」——
   只能靠 -ed 判断。给 2 个选项。
   字段：{"kind":"referential","sentence":"英文句","prompt":"中文问题",
   "choices":["选项1","选项2"],"answer":0,"misconceptions":[{"id":"误区code或自拟短id",
   "value":"1","feedback":"选错时的中文定向反馈"}]}

2. `transform` —— 句型转换。给原句与要求，答案是改写后的英文（可给多个可接受写法）。
   字段：{"kind":"transform","prompt":"中文要求 + 原句","answer":["改写后英文"]}

3. `order` —— 词块排序。把一句话打散成 4-7 个词块。
   字段：{"kind":"order","prompt":"中文提示","tokens":["打散的块"],"answer":["正确顺序"]}

4. `affective` —— **情感型结构化输入**。给 5 句都用了目标结构的英文句子，
   内容是关于学习者自己的（我平时会…、我小时候…），勾「符合我的情况」。
   **无对错、不计分**，作用是让学习者在处理意义的同时反复接触该结构。
   字段：{"kind":"affective","prompt":"中文引导语","statements":["5 句英文"]}

硬要求：
- 句子简单、常用、不超过 12 个词；
- `answer` 必须与 `choices`/`tokens` 严格对应（下标或原样字符串）；
- `order` 的 tokens 必须是 answer 的乱序，一个不多一个不少；
- 只输出 JSON，不要解释。

输出：{"points":[{"point_id":1,"cards":[<上面四种各一>]}]}"""


def _to_question(point_id: int, card: dict) -> tuple[str, str, dict, bool] | None:
    """LLM 产出 → 练习引擎的题目 JSON。校验不过就丢掉这张卡，不落半成品。"""
    kind = card.get("kind")
    if kind == "referential":
        q = {
            "widget": "referential-input",
            "prompt": card.get("prompt", ""),
            "sentence": card.get("sentence", ""),
            "choices": card.get("choices") or [],
            "answer": card.get("answer"),
            "misconceptions": card.get("misconceptions") or [],
            # 本项目的独家优势：这题能出成听力版（豆包 TTS / edge-tts）
            "audio": {"text": card.get("sentence", "")},
        }
        widget, kd, sched = "referential-input", "referential", True
    elif kind == "transform":
        q = {
            "widget": "sentence-transform",
            "prompt": card.get("prompt", ""),
            "answer": card.get("answer") or [],
        }
        widget, kd, sched = "sentence-transform", "production", True
    elif kind == "affective":
        q = {
            "widget": "affective-input",
            "prompt": card.get("prompt", ""),
            "statements": card.get("statements") or [],
        }
        # FR-404 第 2 类：无对错，巩固用，**不计分不进 SRS**
        widget, kd, sched = "affective-input", "affective", False
    elif kind == "order":
        q = {
            "widget": "word-order",
            "prompt": card.get("prompt", ""),
            "tokens": card.get("tokens") or [],
            "answer": card.get("answer") or [],
        }
        widget, kd, sched = "word-order", "production", True
    else:
        return None

    try:
        exercise.validate({**q, "id": f"seed-{point_id}"})
    except exercise.QuestionError as exc:
        print(f"  丢弃 point={point_id} {kind}：{exc}")
        return None
    # 排序题的 tokens 与 answer 必须是同一组词，否则永远判不对
    if widget == "word-order" and sorted(q["tokens"]) != sorted(q["answer"]):
        print(f"  丢弃 point={point_id} order：tokens 与 answer 不是同一组")
        return None
    if widget == "affective-input" and len(q["statements"]) < 3:
        print(f"  丢弃 point={point_id} affective：句子不足 3 句")
        return None
    if widget == "referential-input":
        ans = q["answer"]
        if not isinstance(ans, int) or not (0 <= ans < len(q["choices"])):
            print(f"  丢弃 point={point_id} referential：answer 越界")
            return None
    return widget, kd, q, sched


async def generate(limit: int, only_with_corpus: bool, kind_filter: str | None = None) -> int:
    """出题。`kind_filter` 只补某一类：已经出过选择题的点也要能再补情感型。"""
    async with SessionFactory() as s:
        occ = dict(
            (
                await s.execute(
                    select(GrammarOccurrence.grammar_point_id, func.count()).group_by(
                        GrammarOccurrence.grammar_point_id
                    )
                )
            ).all()
        )
        done = set(
            (
                await s.execute(
                    select(GrammarCard.grammar_point_id)
                    .where(GrammarCard.kind == kind_filter)
                    .distinct()
                    if kind_filter
                    else select(GrammarCard.grammar_point_id).distinct()
                )
            ).scalars()
        )
        points = (
            await s.execute(select(GrammarPoint).order_by(GrammarPoint.order_index))
        ).scalars().all()

    def rank(p: GrammarPoint) -> tuple:
        # 语料里出现得多的排前面；同等情况下 CEFR 低的先出（先学基础）
        return (-(occ.get(p.id, 0)), p.cefr_level or "Z", p.order_index)

    todo = [p for p in points if p.id not in done]
    if only_with_corpus:
        todo = [p for p in todo if occ.get(p.id, 0) > 0]
    todo.sort(key=rank)
    todo = todo[:limit]
    if not todo:
        print("没有待出题的语法点")
        return 0
    print(f"待出题 {len(todo)} 个语法点，每批 {POINTS_PER_CALL}")

    made = 0
    skipped: list[int] = []
    for i in range(0, len(todo), POINTS_PER_CALL):
        chunk = todo[i : i + POINTS_PER_CALL]
        made += await _run_batch(chunk, kind_filter, skipped, retry_singly=True)
        print(f"  {min(i + POINTS_PER_CALL, len(todo))}/{len(todo)} 语法点，累计 {made} 张卡")
    if skipped:
        print(
            f"  ⚠ {len(skipped)} 个语法点被上游内容策略拒绝（逐条重试也不过），"
            f"这批题需要人工出：{skipped}"
        )
    return made


async def _run_batch(
    chunk: list, kind_filter: str | None, skipped: list[int], *, retry_singly: bool
) -> int:
    """跑一批出题。整批被拒时逐条重试，把问题点隔离出来而不是整批丢掉。"""
    payload = json.dumps(
            {
                "points": [
                    {
                        "point_id": p.id,
                        "语法点": p.item_zh or p.item,
                        "英文条目": p.item,
                        "句型": p.sentence_type,
                        "等级": p.cefr_level,
                        "备注": p.note_zh,
                    }
                    for p in chunk
                ]
            },
            ensure_ascii=False,
    )
    try:
        parsed, _m, _ms = await complete_json("grammar-deep", CARD_SYSTEM, payload)
    except LLMUnavailable as exc:
        # 上游偶尔把某一批的措辞判成内容策略违规。为一批放弃剩下几百个语法点，
        # 是把偶发变成了阻断；整批丢掉又会连累同批里没问题的点。
        # 所以整批被拒时逐条重试——多花几次调用，换来把问题隔离到具体某一条
        if not retry_singly or len(chunk) == 1:
            skipped.extend(p.id for p in chunk)
            print(f"  跳过 {[p.id for p in chunk]}：{str(exc)[:100]}")
            return 0
        print(f"  整批被拒（{len(chunk)} 个点），改为逐条重试")
        total = 0
        for one in chunk:
            total += await _run_batch([one], kind_filter, skipped, retry_singly=False)
        return total

    rows = []
    for entry in parsed.get("points", []):
        pid = entry.get("point_id")
        if pid not in {p.id for p in chunk}:
            continue
        for card in entry.get("cards", []):
            built = _to_question(pid, card)
            if built is None:
                continue
            widget, kd, q, sched = built
            if kind_filter and kd != kind_filter:
                continue
            rows.append(
                {
                    "grammar_point_id": pid,
                    "kind": kd,
                    "widget": widget,
                    "payload": q,
                    "schedulable": sched,
                }
            )
    if rows:
        async with SessionFactory() as s:
            await s.execute(GrammarCard.__table__.insert(), rows)
            await s.commit()
    return len(rows)


async def check() -> None:
    async with SessionFactory() as s:
        n_m = (await s.execute(select(func.count()).select_from(Misconception))).scalar_one()
        n_c = (await s.execute(select(func.count()).select_from(GrammarCard))).scalar_one()
        by_widget = (
            await s.execute(
                select(GrammarCard.widget, func.count()).group_by(GrammarCard.widget)
            )
        ).all()
        pts = (
            await s.execute(select(func.count(func.distinct(GrammarCard.grammar_point_id))))
        ).scalar_one()
        bad = 0
        for c in (await s.execute(select(GrammarCard))).scalars():
            try:
                exercise.validate({**c.payload, "widget": c.widget})
            except exercise.QuestionError:
                bad += 1
    print(f"误区 {n_m} 条；语法卡 {n_c} 张，覆盖 {pts} 个语法点")
    print("按题型：", dict(by_widget))
    print(f"Schema 校验不通过的卡：{bad}（应为 0）")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--misconceptions", action="store_true")
    ap.add_argument("--cards", action="store_true")
    ap.add_argument("--limit", type=int, default=60)
    ap.add_argument("--all-points", action="store_true", help="不限于语料里出现过的点")
    ap.add_argument("--kind", help="只补某一类题（如 affective）")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    if args.check:
        await check()
        return
    if args.misconceptions or not args.cards:
        await seed_misconceptions()
    if args.cards:
        n = await generate(args.limit, not args.all_points, args.kind)
        print(f"新增语法卡 {n} 张")
    await check()


if __name__ == "__main__":
    asyncio.run(main())

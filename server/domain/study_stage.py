"""词的学习阶段：全库唯一口径（模块 01 考纲本按场景学）。

在这之前「一个词处于什么阶段」有三套互相矛盾的说法：
`VocabEntry.status`（review.py 派生）、`decks.mastery_bucket`（按 FSRS 卡折算）、
`srs.card_state_name`（按 py-fsrs 的 state）。同一张空卡在 review_log 里叫 `new`、
在掌握度统计里叫 `learning`。再加一档就是四套。

这里把「阶段」收成一个函数，让 `status` 降级成派生缓存。
`mastery_bucket` 一个字不动——它继续是「掌握」的唯一阈值，本模块调用它。

## 五档

| 阶段 | 判据 | 含义 |
| --- | --- | --- |
| `unseen` | 不在 vocab_entry，且没打开过 | 没见过 |
| `learning` | 打开过词卡（exposures ≥ 1），或人工标了「学习中」 | 学习中 |
| `tested` | 通过自测，但 FSRS 还没到 mature | 短期会了 |
| `mastered` | mastery_bucket == mature，或人工标了「已掌握」 | 长期掌握 |
| `hard` | 人工标了「困难词」，或无人工标记且算法判难 | 需重点学习 |

> [!danger] 人工标记压过一切推断
>
> 用户在词卡上按下「已掌握」之后，再让算法把它显示成「学习中」，
> 是在告诉用户「你说的不算」。凡是 `mark` 非空，阶段直接由它决定，
> 不再看 exposures、self_test_at 或 FSRS。清除标记后自动回到推断值。

> [!info] 「看几次算学习过」这个阈值已经删掉
>
> 它配了两个值（次数 + 冷却窗）才能自洽，而收益是零：用户要的是
> **打开就变、并且自己能改**。阈值只是在用户和状态之间加了一道他不关心的算术，
> 还带出「点了没反应」（在冷却窗里）这种查不出原因的现象。
> 现在打开一次即 `learning`，剩下的交给词卡上的手动标记。
"""

from datetime import datetime

from sqlalchemy import and_, case, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from domain import decks
from domain.models import VocabEntry

STAGES = ("unseen", "learning", "tested", "mastered", "hard")
STAGE_BUCKET = {
    "unseen": "new",
    "learning": "learning",
    "tested": "learning",
    "mastered": "mature",
    "hard": "hard",
}

# 人工标记的取值。`hard` 与另外两个不同：它不表示进度，表示「这个词难」，
# 所以它和 learning/mastered 并列而不是叠加——用户一次只表达一件事
MARKS = ("learning", "mastered", "hard")


def normalize_mark(value: object) -> str | None:
    """人工标记来自 HTTP 请求体，非法值一律当「清除」，不抛错。"""
    if isinstance(value, str) and value in MARKS:
        return value
    return None


def stage(vocab: VocabEntry | None) -> str:
    """算一个词的学习阶段。`vocab` 为空表示这个词还没进生词本。"""
    if vocab is None:
        return "unseen"
    mark = normalize_mark(vocab.mark)
    if mark is not None:
        return mark
    if decks.is_difficult(vocab.fsrs_card):
        return "hard"
    if decks.mastery_bucket(vocab.fsrs_card) == "mature":
        return "mastered"
    if vocab.self_test_at is not None:
        return "tested"
    if vocab.last_review_at is not None:
        return "learning"
    return "learning" if (vocab.exposures or 0) >= 1 else "unseen"


def status_of(stage_name: str) -> str:
    """阶段 → 老的 `status` 三态。

    持久化状态仅作缓存，接口与筛选使用同一派生规则。
    """
    if stage_name == "unseen":
        return "new"
    if stage_name == "mastered":
        return "known"
    return "learning"


def sql_stage(dialect: str):
    card = VocabEntry.fsrs_card

    def numeric(key: str, *, boolean: bool = False):
        kind = (
            func.jsonb_typeof(card[key])
            if dialect == "postgresql"
            else func.json_type(card, f"$.{key}")
        )
        types = ["number"] if dialect == "postgresql" else ["integer", "real"]
        number = case((kind.in_(types), card[key].as_float()), else_=None)
        if boolean:
            if dialect == "postgresql":
                return case(
                    (kind == "boolean", case((card[key].as_string() == "true", 1), else_=0)),
                    else_=number,
                )
            return case((kind == "true", 1), (kind == "false", 0), else_=number)
        return number

    state = numeric("state", boolean=True)
    mature = and_(
        card["last_review"].as_string().is_not(None),
        or_(state.is_(None), state.not_in([1, 3])),
        numeric("stability") >= decks.MATURE_STABILITY_DAYS,
    )
    return case(
        (VocabEntry.mark.in_(MARKS), VocabEntry.mark),
        (numeric("difficulty") >= decks.DIFFICULT_THRESHOLD, "hard"),
        (mature, "mastered"),
        (VocabEntry.self_test_at.is_not(None), "tested"),
        (or_(VocabEntry.last_review_at.is_not(None), VocabEntry.exposures >= 1), "learning"),
        else_="unseen",
    )


def sql_filter(mode: str, dialect: str):
    derived = sql_stage(dialect)
    if mode == "new":
        return derived == "unseen"
    if mode == "learning":
        return derived.in_(["learning", "tested"])
    if mode == "mastered":
        return derived == "mastered"
    if mode == "difficult":
        return derived == "hard"
    return True


def is_hard(vocab: VocabEntry | None, card: dict | None) -> bool:
    """困难词 = 用户自己标的，或 FSRS 算出来难。

    两个来源都要认：手动标的是用户意图，FSRS 的 difficulty 是答题结果的估计，
    只认一个都会漏。但**手动标了别的**（比如「已掌握」）时不再看 FSRS——
    用户明说了不难，就不该继续躺在困难词筛选里。
    """
    mark = normalize_mark(vocab.mark) if vocab is not None else None
    if mark is not None:
        return mark == "hard"
    return decks.is_difficult(card)


def touch(vocab: VocabEntry, now: datetime) -> str:
    """记一次「打开了这张词卡」，返回新阶段。

    没有冷却窗：打开就是打开。计数留着是因为它本身有信息量
    （这个词我翻过 12 次还没标掌握），但它不再决定任何阈值。
    """
    vocab.exposures = (vocab.exposures or 0) + 1
    vocab.last_seen_at = now
    new_stage = stage(vocab)
    vocab.status = status_of(new_stage)
    return new_stage


def set_mark(vocab: VocabEntry, mark: object, now: datetime) -> str:
    """人工标记，返回新阶段。传非法值或 None 都表示清除。"""
    normalized = normalize_mark(mark)
    vocab.mark = normalized
    vocab.marked_at = now if normalized is not None else None
    new_stage = stage(vocab)
    vocab.status = status_of(new_stage)
    return new_stage


async def reconcile_status(session: AsyncSession, *, apply: bool = False) -> dict:
    mismatches = []
    cursor = 0
    while True:
        rows = (
            await session.scalars(
                select(VocabEntry).where(VocabEntry.id > cursor).order_by(VocabEntry.id).limit(500)
            )
        ).all()
        if not rows:
            break
        for entry in rows:
            expected = status_of(stage(entry))
            if entry.status != expected:
                mismatches.append({"id": entry.id, "before": entry.status, "after": expected})
        cursor = rows[-1].id
    if apply:
        for item in mismatches:
            await session.execute(
                update(VocabEntry)
                .where(VocabEntry.id == item["id"], VocabEntry.status == item["before"])
                .values(status=item["after"])
            )
        await session.flush()
    return {"count": len(mismatches), "changes": mismatches, "applied": apply}

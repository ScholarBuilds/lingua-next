"""FSRS 复习调度封装：单例 Scheduler + 卡片字典进出转换（模块 05）。"""

from datetime import UTC, datetime, timedelta

from fsrs import Card, Rating, Scheduler, State

# 关闭 fuzzing：按钮上的间隔预览必须与实际调度一致；权重沿用 FSRS-6 默认参数
_scheduler = Scheduler(enable_fuzzing=False)

_STATE_NAMES = {1: "learning", 2: "review", 3: "relearning"}

RATINGS = (1, 2, 3, 4)  # Again / Hard / Good / Easy


def init_card() -> dict:
    """新卡字典：due=当前时刻，处于学习步。"""
    return Card().to_dict()


def mastered_card(now: datetime | None = None, stability_days: float = 30.0) -> dict:
    """直接构造一张"已掌握"的复习卡，供批量标记使用。

    用户明确声明会了时不该走"连点四次 Easy"这种绕路：直接落在 Review 态且
    stability 越过 21 天的成熟线（与 decks.MATURE_STABILITY_DAYS 同口径）。
    """
    now = now or datetime.now(UTC)
    card = Card(
        state=State.Review,
        step=None,
        stability=stability_days,
        difficulty=5.0,
        due=now + timedelta(days=stability_days),
        last_review=now,
    )
    return card.to_dict()


def card_state_name(card_dict: dict | None) -> str:
    """卡片状态名：未入调度或从未复习过的卡视为 new。"""
    if not card_dict or card_dict.get("last_review") is None:
        return "new"
    return _STATE_NAMES.get(card_dict.get("state"), "new")


def review(
    card_dict: dict, rating: int, now: datetime | None = None
) -> tuple[dict, dict, datetime]:
    """按评分推进一次调度，返回 (新卡字典, 复习日志字典, 下次到期时间)。"""
    if rating not in RATINGS:
        raise ValueError(f"rating must be 1-4, got {rating}")
    now = now or datetime.now(UTC)
    card = Card.from_dict(card_dict)
    new_card, log = _scheduler.review_card(card, Rating(rating), review_datetime=now)
    return new_card.to_dict(), log.to_dict(), new_card.due


def preview_intervals(card_dict: dict | None = None) -> dict[int, str]:
    """四档评分各自的下次间隔文案，用于复习按钮标注。card_dict 为空按新卡预览。"""
    now = datetime.now(UTC)
    out: dict[int, str] = {}
    for rating in RATINGS:
        card = Card.from_dict(card_dict) if card_dict else Card(due=now)
        new_card, _ = _scheduler.review_card(card, Rating(rating), review_datetime=now)
        out[rating] = humanize_interval(new_card.due - now)
    return out


def humanize_interval(delta: timedelta) -> str:
    """间隔人话文案：<1 小时用分钟，<1 天用小时，否则用天。"""
    seconds = max(delta.total_seconds(), 0)
    if seconds < 3600:
        return f"{max(1, round(seconds / 60))}分钟"
    if seconds < 86400:
        return f"{max(1, round(seconds / 3600))}小时"
    return f"{max(1, round(seconds / 86400))}天"

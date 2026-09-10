from datetime import UTC, datetime, timedelta

import pytest

from domain import srs


def test_init_card_shape() -> None:
    card = srs.init_card()
    assert card["state"] == 1  # Learning
    assert card["last_review"] is None
    assert card["stability"] is None


def test_card_state_name() -> None:
    assert srs.card_state_name(None) == "new"
    # 已初始化但从未复习过的卡仍算 new
    assert srs.card_state_name(srs.init_card()) == "new"
    reviewed, _, _ = srs.review(srs.init_card(), 3)
    assert srs.card_state_name(reviewed) == "learning"


def test_review_rating_mapping() -> None:
    for rating in (1, 2, 3, 4):
        _, log, _ = srs.review(srs.init_card(), rating)
        assert log["rating"] == rating


def test_review_invalid_rating() -> None:
    with pytest.raises(ValueError):
        srs.review(srs.init_card(), 5)
    with pytest.raises(ValueError):
        srs.review(srs.init_card(), 0)


def test_review_progression() -> None:
    now = datetime.now(UTC)
    # 新卡 Good：仍在学习步，10 分钟后到期
    card, _, due = srs.review(srs.init_card(), 3, now=now)
    assert now < due <= now + timedelta(hours=1)
    # 到期再 Good：毕业进入 Review，间隔以天计
    now2 = due
    card, _, due2 = srs.review(card, 3, now=now2)
    assert card["state"] == 2  # Review
    assert due2 - now2 >= timedelta(days=1)
    # Review 卡 Again：回到 Relearning，间隔缩回当天
    now3 = due2
    card, _, due3 = srs.review(card, 1, now=now3)
    assert card["state"] == 3  # Relearning
    assert due3 - now3 < timedelta(days=1)


def test_easy_longer_than_good() -> None:
    now = datetime.now(UTC)
    base = srs.init_card()
    _, _, due_good = srs.review(dict(base), 3, now=now)
    _, _, due_easy = srs.review(dict(base), 4, now=now)
    assert due_easy > due_good


def test_humanize_interval() -> None:
    assert srs.humanize_interval(timedelta(seconds=30)) == "1分钟"
    assert srs.humanize_interval(timedelta(minutes=10)) == "10分钟"
    assert srs.humanize_interval(timedelta(minutes=90)) == "2小时"
    assert srs.humanize_interval(timedelta(hours=5)) == "5小时"
    assert srs.humanize_interval(timedelta(days=1)) == "1天"
    assert srs.humanize_interval(timedelta(days=1, hours=12)) == "2天"
    assert srs.humanize_interval(timedelta(days=30)) == "30天"


def test_preview_intervals_new_card() -> None:
    intervals = srs.preview_intervals(None)
    assert set(intervals) == {1, 2, 3, 4}
    assert intervals[1].endswith("分钟")  # Again → 学习步 1 分钟
    assert intervals[3].endswith("分钟")  # Good → 学习步 10 分钟
    assert intervals[4].endswith("天")  # Easy → 直接毕业按天


def test_preview_matches_actual_review() -> None:
    # 预览文案与真实评分推进的间隔一致（fuzzing 已关闭）
    card = srs.init_card()
    intervals = srs.preview_intervals(card)
    now = datetime.now(UTC)
    for rating in (1, 2, 3, 4):
        _, _, due = srs.review(dict(card), rating, now=now)
        assert srs.humanize_interval(due - now) == intervals[rating]

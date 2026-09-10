"""学习阶段的五档判定。

四根轴（人工标记 / 接触度 / FSRS 调度 / 自测过关）互不覆盖，判据只有这一处。
守住两件事：**人工标记压过一切推断**，以及「打开过 ≠ 掌握」——
打开一次只到 learning，要过自测才 tested，FSRS 判 mature 才 mastered。
"""

from datetime import UTC, datetime, timedelta

import pytest

from domain import study_stage as ss
from domain.models import VocabEntry

NOW = datetime(2026, 8, 25, 12, 0, tzinfo=UTC)


def _v(**kw) -> VocabEntry:
    return VocabEntry(word="x", **kw)


# ---- 推断档 ----


def test_不在生词本是没见过() -> None:
    assert ss.stage(None) == "unseen"


def test_入了册但没打开过仍是没见过() -> None:
    # 场景入册会建行但不算接触，否则点进一个场景就把 73 个词全标成学习中
    assert ss.stage(_v(exposures=0)) == "unseen"


def test_打开一次就算学习中() -> None:
    assert ss.stage(_v(exposures=1)) == "learning"


def test_打开再多次没过自测也不算通过() -> None:
    assert ss.stage(_v(exposures=99)) == "learning"


def test_过了自测但FSRS未成熟算短期会了() -> None:
    assert ss.stage(_v(exposures=3, self_test_at=NOW, fsrs_card=None)) == "tested"
    assert ss.STAGE_BUCKET["tested"] == "learning"


def test_过了自测且FSRS成熟才算掌握() -> None:
    card = {"last_review": NOW.isoformat(), "state": 2, "stability": 40.0}
    assert ss.stage(_v(exposures=3, self_test_at=NOW, fsrs_card=card)) == "mastered"


# ---- 人工标记压过推断 ----


@pytest.mark.parametrize("mark", ss.MARKS)
def test_人工标记压过推断(mark: str) -> None:
    # 一个从没打开过的词，标了什么就是什么
    assert ss.stage(_v(exposures=0, mark=mark)) == mark


def test_标了已掌握之后再翻看不会退回学习中() -> None:
    """用户按下「已掌握」，再点开看一眼，不该把他的判断冲掉。"""
    v = _v(exposures=1, mark="mastered")
    assert ss.touch(v, NOW) == "mastered"
    assert v.exposures == 2  # 计数照记，只是不影响阶段


def test_标了困难词压过FSRS判的成熟() -> None:
    card = {"last_review": NOW.isoformat(), "state": 2, "stability": 99.0}
    assert ss.stage(_v(self_test_at=NOW, fsrs_card=card, mark="hard")) == "hard"


def test_清除标记后回到推断值() -> None:
    v = _v(exposures=1, mark="mastered")
    assert ss.set_mark(v, None, NOW) == "learning"
    assert v.mark is None
    assert v.marked_at is None


def test_非法标记当清除处理() -> None:
    # 标记来自 HTTP 请求体，乱传不该 500
    v = _v(exposures=1, mark="mastered")
    assert ss.set_mark(v, "nonsense", NOW) == "learning"
    assert v.mark is None


def test_标记会回写派生的status() -> None:
    v = _v(exposures=1)
    ss.set_mark(v, "mastered", NOW)
    assert v.status == "known"
    ss.set_mark(v, "hard", NOW)
    assert v.status == "learning"


# ---- 打开一次即计数 ----


def test_打开就计数没有冷却窗() -> None:
    """阈值与冷却一起删了：用户要的是打开就变。"""
    v = _v(exposures=0)
    assert ss.touch(v, NOW) == "learning"
    assert ss.touch(v, NOW + timedelta(seconds=1)) == "learning"
    assert v.exposures == 2


def test_touch_写最近一次时间() -> None:
    v = _v(exposures=0)
    ss.touch(v, NOW)
    assert v.last_seen_at == NOW


# ---- 困难词 ----


def test_困难词认FSRS也认人工() -> None:
    hard_card = {"difficulty": 8.0}
    assert ss.is_hard(_v(), hard_card) is True
    assert ss.is_hard(_v(mark="hard"), None) is True


def test_人工标了别的就不再看FSRS() -> None:
    """用户明说了「已掌握」，不该继续躺在困难词筛选里。"""
    hard_card = {"difficulty": 9.0}
    assert ss.is_hard(_v(mark="mastered"), hard_card) is False


def test_没入册的词不是困难词() -> None:
    assert ss.is_hard(None, None) is False


# ---- 派生 status ----


def test_状态派生覆盖五档() -> None:
    got = {st: ss.status_of(st) for st in ss.STAGES}
    assert got == {
        "unseen": "new",
        "learning": "learning",
        "tested": "learning",
        "mastered": "known",
        "hard": "learning",
    }

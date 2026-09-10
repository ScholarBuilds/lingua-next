"""人工修正保护（需求 12 FR-205~207、BR-36）。"""

from datetime import UTC, datetime, timedelta

from domain import ratchet
from domain.models import SubtitleSentence


def _row(**kw) -> SubtitleSentence:
    return SubtitleSentence(
        track_id=1, ordinal=0, start_ms=0, end_ms=1000,
        text="hello", content_hash="h", **kw
    )


def test_未标记的字段可被自动写入():
    row = _row(text_zh="机器译文")
    assert ratchet.apply(row, "text_zh", "新的机器译文") is True
    assert row.text_zh == "新的机器译文"


def test_人工改过的字段自动写入被拒():
    row = _row(text_zh="机器译文")
    ratchet.mark(row, "text_zh")
    row.text_zh = "我改的译文"
    assert ratchet.apply(row, "text_zh", "重跑的机器译文") is False
    assert row.text_zh == "我改的译文"


def test_显式覆盖才能盖过人工版本():
    row = _row(text_zh="我改的译文")
    ratchet.mark(row, "text_zh")
    assert ratchet.apply(row, "text_zh", "机器译文", override=True) is True
    assert row.text_zh == "机器译文"


def test_锁只作用于被标记的字段():
    row = _row(text_zh="我改的译文")
    ratchet.mark(row, "text_zh")
    assert ratchet.is_locked(row, "text_zh") is True
    assert ratchet.is_locked(row, "text") is False
    assert ratchet.apply(row, "text", "new text") is True


def test_撤销标记后恢复可写():
    row = _row(text_zh="我改的译文")
    ratchet.mark(row, "text_zh")
    ratchet.clear(row, "text_zh")
    assert ratchet.is_locked(row, "text_zh") is False
    assert ratchet.apply(row, "text_zh", "机器译文") is True


def test_多字段标记互不影响():
    row = _row(text_zh="zh")
    ratchet.mark(row, "text_zh")
    ratchet.mark(row, "text")
    assert set(row.edited_fields) == {"text_zh", "text"}
    ratchet.clear(row, "text_zh")
    assert set(row.edited_fields) == {"text"}


def test_时间戳可传入用于回溯():
    row = _row()
    when = datetime.now(UTC) - timedelta(days=1)
    ratchet.mark(row, "text_zh", when=when)
    assert row.edited_fields["text_zh"] == when.isoformat()


def test_统计锁定条数供重跑前提示():
    rows = [_row(text_zh="a"), _row(text_zh="b"), _row(text_zh="c")]
    ratchet.mark(rows[0], "text_zh")
    ratchet.mark(rows[2], "text_zh")
    assert ratchet.locked_count(rows, "text_zh") == 2

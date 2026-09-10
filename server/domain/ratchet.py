"""人工修正保护（需求 12 FR-205~207，BR-36）。

棘轮只能往一个方向转：任何自动再生成都不得覆盖人工编辑过的字段。
没有这条，用户改十句译文、重跑一次全没了，之后再也不会有人愿意修。
"""

from datetime import UTC, datetime
from typing import Any, Protocol


class Editable(Protocol):
    """带字段级编辑时间戳的产物行。"""

    edited_fields: dict | None


def mark(row: Editable, *fields: str, when: datetime | None = None) -> None:
    """标记这些字段被人工改过；此后自动写入不再覆盖它们。"""
    stamp = (when or datetime.now(UTC)).isoformat()
    marks = dict(row.edited_fields or {})
    for field in fields:
        marks[field] = stamp
    row.edited_fields = marks


def clear(row: Editable, *fields: str) -> None:
    """撤销人工标记：用户主动放弃自己的版本、要求回到自动结果时用。"""
    if not row.edited_fields:
        return
    marks = {k: v for k, v in row.edited_fields.items() if k not in fields}
    row.edited_fields = marks or None


def is_locked(row: Editable, field: str) -> bool:
    return bool((row.edited_fields or {}).get(field))


def apply(
    row: Any, field: str, value: object, *, override: bool = False
) -> bool:
    """自动写入单个字段，返回是否真的写了。

    override 对应重跑弹窗里那个默认关闭的「覆盖人工修改」开关：
    要盖掉人工版本必须是用户显式勾选，不能由代码默默决定。
    """
    if not override and is_locked(row, field):
        return False
    setattr(row, field, value)
    return True


def locked_count(rows: list[Any], field: str) -> int:
    """统计一批行里有多少条该字段被锁住，供重跑前提示"本次将跳过 N 条人工修改"。"""
    return sum(1 for row in rows if is_locked(row, field))

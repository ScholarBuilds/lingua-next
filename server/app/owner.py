"""本机 owner：无账号的单人工作台（CR-006 D2）。

学习状态表的 user_id 列保留，值统一是 OWNER_ID；路由从这里拿 owner，不再从会话里拿用户。
将来真要多用户，是在这个依赖前面加一层鉴权、把 id 换成登录者，不是重新加列。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends

OWNER_ID = "owner"


@dataclass(frozen=True, slots=True)
class LocalOwner:
    id: str = OWNER_ID


def get_owner() -> LocalOwner:
    return LocalOwner()


CurrentOwner = Annotated[LocalOwner, Depends(get_owner)]

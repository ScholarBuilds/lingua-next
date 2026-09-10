"""生图默认参数的单一事实源（需求 17 §6.4.1 · CR-005 §3.5）。

改这个之前先看清楚问题是什么：质量档的默认值原本以字面量 ``"medium"`` 散在
十三处——两个 ``Tunable``、五个函数签名、四个请求体、两个 worker 分支。
「把默认改成 high」这种一句话的需求，落到代码上就是十三次搜索替换，
漏掉一处不会报错，只会让某一条链路继续出中等质量的图，而且极难发现。

所以这里定一条规矩：**生图质量的默认值只能从本模块取**。
新增任何出图路径，默认值写 ``image_defaults.quality()``，不要再写字面量。

三层优先级（与 BR-179 一致）：

1. 调用点显式传的值（用户在某个工具/节点上微调的）——最高
2. 全局默认（配置中心可改，落 ``user_pref``）
3. 出厂默认 ``FALLBACK_QUALITY``——最低

历史任务重试读的是任务自己的快照，不受全局默认变化影响。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - 只为类型标注
    from sqlalchemy.ext.asyncio import AsyncSession

#: 允许的质量档。与 ``image_prompts.QUALITIES`` 同源，这里重述一遍是为了
#: 让本模块不反向依赖提示词层。
QUALITIES = ("low", "medium", "high")

#: 出厂默认。CR-005 §3.5 把它从 medium 提到 high：
#: 用户明确要求全产品默认最好质量，且 CR-003 已裁定调用成本不再是设计约束。
FALLBACK_QUALITY = "high"

PREF_KEY = "image_defaults"

#: 进程内缓存。API 与 worker 是两个进程，各自在启动时 load 一次。
_CACHE: dict[str, str] = {}


def quality() -> str:
    """当前全局默认质量档。没加载过或值不合法都回落出厂默认。"""
    value = _CACHE.get("quality", "")
    return value if value in QUALITIES else FALLBACK_QUALITY


def normalize_quality(value: str | None) -> str:
    """把调用点传进来的值规整成合法档位；空值/非法值走全局默认。

    容忍非法值而不是抛错，是因为这个值常来自历史任务的快照——
    旧任务里可能存着已经废弃的档名，重试时不该直接失败。
    """
    if value is None:
        return quality()
    text = str(value).strip().lower()
    return text if text in QUALITIES else quality()


async def load(session: AsyncSession) -> dict[str, str]:
    """从库里读回全局默认，填进进程缓存。启动时调一次。"""
    from domain.models import UserPref

    row = await session.get(UserPref, PREF_KEY)
    payload = row.value if row is not None and isinstance(row.value, dict) else {}
    _CACHE.clear()
    for key, value in payload.items():
        if isinstance(value, str):
            _CACHE[str(key)] = value
    return dict(_CACHE)


async def save(session: AsyncSession, **values: str) -> dict[str, str]:
    """写全局默认。只接受已知键，非法值直接拒。"""
    from domain.models import UserPref

    if "quality" in values:
        want = str(values["quality"]).strip().lower()
        if want not in QUALITIES:
            raise ValueError(f"未知质量档：{values['quality']}")
        values["quality"] = want
    merged = {**_CACHE, **{k: str(v) for k, v in values.items()}}
    row = await session.get(UserPref, PREF_KEY)
    if row is None:
        session.add(UserPref(key=PREF_KEY, value=merged))
    else:
        row.value = merged
    await session.commit()
    _CACHE.clear()
    _CACHE.update(merged)
    return dict(_CACHE)


def reset_cache() -> None:
    """测试用：把缓存清空，回到出厂默认。"""
    _CACHE.clear()

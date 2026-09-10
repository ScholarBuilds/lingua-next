"""循环节点的 AI 编排（模块 17 · FR-465）。

一句话变成一整套循环配置：跑几轮、串行还是并发、每轮的提示词是什么、
要不要逐张喂上游图。这是蓝本 Infinite-Canvas 没有的——它的循环节点全靠手填，
十二轮就是手写十二条提示词。

> [!warning] 只调文本模型，不出图
>
> 这一步产出的是**配置**，用户看过、改过之后才轮到出图。所以它可以随便重试，
> 也应该鼓励重试——把它做成「先想清楚再开跑」的那一步。

归一化是这个模块的重点：模型会给出 `count: "12张"`、`mode: "并行"`、
带引号的 token 之类的东西。全部收在 `_normalize` 里，路由层拿到的一定是合法值。
"""

from __future__ import annotations

import logging
import re
from typing import Any

from domain.llm import LLMUnavailable, complete_json

logger = logging.getLogger(__name__)

#: 用哪个语义别名。跟批量策划同一条——都是「读需求、吐结构化配置」的活
PLAN_ALIAS = "explain-standard"

#: 轮数上限。产品上不限制轮数（CR-005），这里只挡手滑与模型胡说
LOOP_MAX = 999
#: 并发上限。物理上限，不是产品限制
POOL_MAX = 64
#: 每轮取几张图的上限
BATCH_MAX = 100
#: 需求描述字数上限
MAX_IDEA_CHARS = 800
#: 一次最多给几条轮次提示词。超过就截断——让模型写 500 条提示词只会得到废话
MAX_PROMPTS = 100

#: 提示词里可用的变量。与前端 `canvasStore.applyLoopTokens` 必须一致，
#: 少一个前端就不会替换，用户会在图上看到「《进度》」四个字
TOKENS = {
    "《计数》": "当前是第几轮，从「起始计数」开始数",
    "《总数》": "一共几轮",
    "《进度》": "第几轮/共几轮，例如 3/12",
}


class LoopPlanError(Exception):
    """带分类的失败。`kind` 决定前端把用户导向哪里。"""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


SYSTEM = f"""你在给一个「无限画布」里的**循环节点**写配置。

循环节点是驱动器：它自己不出图，而是让下游的出图节点跑 N 轮，每轮喂一条不同的提示词。

两种模式，选错了结果完全不同：
- serial（循环）：一轮跑完再跑下一轮，后一轮能看到前一轮的产物。**要一致性时用它**
  （同一个角色的多个场景、同一套 UI 的多个页面、连续分镜）。
- parallel（并发）：所有轮同时跑，互不影响。**要多样性时用它**
  （同一个需求的多个风格方案、多个配色、A/B 备选）。

可以在提示词里写这些变量，运行时会被替换：
{chr(10).join(f"- {k}：{v}" for k, v in TOKENS.items())}

严格按这个 JSON 结构返回，不要多余的键，不要 markdown 代码块：
{{
  "title": "给这个循环起个短名字，4-10 个中文字",
  "mode": "serial 或 parallel",
  "count": 轮数，整数,
  "loop_start": 《计数》从几开始，整数，通常是 1,
  "variable_prompts": ["第 1 轮的提示词", "第 2 轮的提示词", "..."],
  "image_input": true 或 false,
  "image_batch_size": 每轮从上游取几张图，整数,
  "why": "一句话说明你为什么这样配（选串行还是并发的理由）"
}}

写 variable_prompts 时：
- **条数要等于 count**。少了会循环取用，多了会被截断，两种都不是用户想要的；
- 每条都是完整可用的提示词，不要写「同上，但改成红色」这种依赖上一条才看得懂的；
- 各条之间要真的不一样——如果你发现每条只差一个词，那说明这个需求应该用
  《计数》变量写成一条，而不是罗列 N 条；那时就只给一条带变量的提示词，
  并把 count 设成用户要的轮数；
- 用户原话里已经写死的（具体的数量、具体的风格名、具体的顺序），照他说的来，
  这条压过你自己的判断。

image_input 只在用户明确提到「对每张图」「上游的图逐张处理」这类意思时才设 true。"""


def build_user_prompt(idea: str, *, upstream_images: int, upstream_prompt: str) -> str:
    """拼用户侧提示词。上游情况要带上——同一句话在有/没有上游图时该配的循环不一样。"""
    lines = [f"需求：{idea}"]
    if upstream_images > 0:
        lines.append(f"这个循环的上游连着 {upstream_images} 张图，可以逐张喂给下游。")
    else:
        lines.append("这个循环上游没有图片输入。")
    if upstream_prompt.strip():
        lines.append(f"上游已有的提示词（可以作为基底改写）：{upstream_prompt.strip()[:500]}")
    return "\n".join(lines)


def _as_int(value: Any, *, default: int, lo: int, hi: int) -> int:
    """从模型给的任意东西里抠出一个整数并夹到区间。

    模型经常返回 `"12张"` / `"3 轮"` / `12.0` / `"约 8"`，直接 int() 会抛。
    """
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        n = int(value)
    else:
        m = re.search(r"-?\d+", str(value or ""))
        if m is None:
            return default
        n = int(m.group())
    return max(lo, min(hi, n))


def _as_mode(value: Any) -> str:
    """归一化模式。模型会说「并行」「parallel」「同时」，也会说「串行」「顺序」。"""
    raw = str(value or "").strip().lower()
    if raw in {"parallel", "concurrent", "并发", "并行", "同时", "同步"}:
        return "parallel"
    return "serial"


def _as_prompts(value: Any) -> list[str]:
    """归一化提示词数组。模型可能给字符串（换行分隔）而不是数组。"""
    if isinstance(value, str):
        items = [line for line in value.splitlines()]
    elif isinstance(value, list):
        items = [str(v) for v in value]
    else:
        return []
    cleaned = [" ".join(str(v).split()) for v in items]
    return [v for v in cleaned if v != ""][:MAX_PROMPTS]


def _normalize(raw: dict) -> dict:
    """把模型输出夹成一份一定能用的配置。

    这里不做「模型没给就报错」——缺字段给默认值，让用户拿到一份可以改的草稿，
    比给他一个报错有用。真正无法接受的只有一种：一条提示词都没有。
    """
    prompts = _as_prompts(raw.get("variable_prompts"))
    if not prompts:
        raise LoopPlanError("api", "模型没给出任何轮次提示词，把需求写具体一点再试")

    count = _as_int(raw.get("count"), default=len(prompts), lo=1, hi=LOOP_MAX)
    # 模型常见的自相矛盾：说要 12 轮却只给 5 条提示词。
    # 以**提示词条数**为准并把 count 拉齐——按 count 循环取用会让第 6 轮起重复前面的，
    # 而用户看到的是「12 轮」，出来却只有 5 种，且看不出原因。
    if len(prompts) > 1 and count != len(prompts):
        logger.info("循环编排：count=%d 与提示词 %d 条不一致，以提示词为准", count, len(prompts))
        count = len(prompts)

    title = " ".join(str(raw.get("title") or "").split())[:20]
    return {
        "title": title or "循环",
        "mode": _as_mode(raw.get("mode")),
        "count": count,
        "loop_start": _as_int(raw.get("loop_start"), default=1, lo=1, hi=LOOP_MAX),
        "variable_prompts": prompts,
        "image_input": bool(raw.get("image_input")),
        "image_batch_size": _as_int(raw.get("image_batch_size"), default=1, lo=1, hi=BATCH_MAX),
        "why": " ".join(str(raw.get("why") or "").split())[:200],
    }


def _classify(exc: LLMUnavailable) -> tuple[str, str]:
    """把网关异常翻成用户能照着做的一句话。"""
    detail = str(exc)
    low = detail.lower()
    if "not found" in low or "does not exist" in low or "404" in low:
        return "binding", f"网关里没有 {PLAN_ALIAS} 这个别名，去配置中心把它绑到一个模型上"
    if "connect" in low or "timeout" in low or "502" in low:
        return "network", f"连不上模型网关：{detail}"
    return "api", f"模型没能给出配置：{detail}"


async def plan_loop(
    idea: str, *, upstream_images: int = 0, upstream_prompt: str = ""
) -> dict:
    """一句话变成一整套循环配置。只调文本模型，不出图。

    返回的每个字段都已归一化到合法取值，调用方可以直接填进节点。
    """
    idea = " ".join(str(idea or "").split())
    if not idea:
        raise LoopPlanError("api", "先写一句话说明这个循环要做什么")
    if len(idea) > MAX_IDEA_CHARS:
        raise LoopPlanError(
            "api", f"需求描述 {len(idea)} 字，超过上限 {MAX_IDEA_CHARS} 字，先精简一下"
        )

    user = build_user_prompt(
        idea,
        upstream_images=max(0, int(upstream_images or 0)),
        upstream_prompt=str(upstream_prompt or ""),
    )
    try:
        raw, _model, _ms = await complete_json(PLAN_ALIAS, SYSTEM, user)
    except LLMUnavailable as exc:
        kind, message = _classify(exc)
        raise LoopPlanError(kind, message) from exc

    return _normalize(raw if isinstance(raw, dict) else {})

"""批量策划的拆解阶段（模块 16 FR-437）。

一句话 → 若干条子任务。这一阶段只调一次文本 LLM，**不出图、不花生图的钱**：
拆完先给用户逐条改（改提示词、改比例、改张数），改完再一起执行。

模块的主要价值在归一化，不在调模型。模型给的 `ratio` / `tier` / `n` 一律不可信，
放行脏数据等于让前端每个格子各写一遍容错，还会在真正出图时才炸。所以出门前逐条
校验：比例不认回落到应用默认、档位不认回落 1k、张数夹到 1~4、名字空了用序号补。
"""

from __future__ import annotations

import json
import logging

from domain.image_apps import ImageApp, get_app
from domain.image_prompts import PromptError
from domain.image_sizes import RATIOS, TIERS, nearest_ratio
from domain.llm import LLMUnavailable, complete_json

logger = logging.getLogger(__name__)

# 拆解只是把中文一句话想成几条中文画面描述，不需要强模型，也不需要视觉
PLAN_ALIAS = "explain-standard"

MAX_IDEA_CHARS = 800
MAX_TASKS_CAP = 12  # 调用方传多少都不放行超过这个数，防止模型吐一大坨
DEFAULT_TIER = "1k"
MAX_N = 4
LABEL_CHARS = 20
PROMPT_CHARS = 400

# 模型换键名装数组是常态，按优先级找
_LIST_KEYS = ("tasks", "items", "plan", "shots", "list")
_LABEL_KEYS = ("label", "name", "title", "名称", "标题")
_PROMPT_KEYS = ("prompt_zh", "prompt", "description", "描述", "提示词")


class BatchError(Exception):
    """批量策划失败。`kind` 分型与 `imagegen.ImageGenError` 同一套语义：

    connect  网关连不上
    auth     密钥无效
    timeout  超时
    binding  别名没绑到具体模型
    content  被上游安全策略拒绝
    api      参数不合法或其余上游错误
    """

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


PLAN_SYSTEM = """你是视觉策划，把用户的一句话需求拆成一组要分别出图的子任务。

只输出 JSON 对象，形如 {"tasks": [{"label": ..., "prompt_zh": ..., "ratio": ...,
"tier": ..., "n": ...}]}，字段含义：
- label: 中文短名，不超过 10 个字，用来在任务列表里区分这一条，例如「吧台特写」。
- prompt_zh: **中文**的画面描述，一到两句，写具体可见的东西（物体、环境、视角），
  不要写英文，不要写画风参数——风格由平台统一控制。
- ratio: 画幅比例，只能从给定的候选里选。
- tier: 分辨率档，只能从给定的候选里选，拿不准就给 "1k"。
- n: 这一条要出几张，1 到 4 之间的整数，一般给 1。

硬要求：
- 条目之间要有实质区别（换角度、换场景、换主体），不要只改几个形容词。
- 条数不要超过给定的上限，宁少勿凑。
- 不描述人物脸部特写；需要人时只写背影、手部或远景剪影。"""


def _text(value: object, limit: int) -> str:
    """取文本：模型常把单值答成数组，拍平后压掉多余空白再截断。"""
    if isinstance(value, list | tuple):
        value = "，".join(str(v).strip() for v in value if str(v).strip())
    return " ".join(str(value or "").split())[:limit]


def _pick(src: dict, keys: tuple[str, ...], limit: int) -> str:
    for key in keys:
        text = _text(src.get(key), limit)
        if text:
            return text
    return ""


def _as_count(value: object) -> int:
    """张数夹到 1~MAX_N。给了 "3"、3.0、None、"很多" 都要落到合法值。"""
    if isinstance(value, bool) or value is None:
        return 1
    if isinstance(value, int | float):
        num = int(value)
    else:
        text = str(value).strip()
        num = int(text) if text.isdigit() else 1
    return max(1, min(MAX_N, num))


def _extract_list(raw: object) -> list:
    if isinstance(raw, list):
        return raw
    if not isinstance(raw, dict):
        return []
    for key in _LIST_KEYS:
        value = raw.get(key)
        if isinstance(value, list):
            return value
    for value in raw.values():
        if isinstance(value, list):
            return value
    return []


def _default_ratio(app: ImageApp) -> str:
    """应用锁了比例就用锁定值，否则按用途的默认尺寸反查最接近的比例。"""
    if app.ratio:
        return app.ratio
    return nearest_ratio(app.target.size)


def _normalize(item: object, *, index: int, app: ImageApp, fallback_ratio: str) -> dict | None:
    """一条子任务归一化。没有画面描述的条目直接丢掉——它没法出图。"""
    if isinstance(item, str):
        item = {"prompt_zh": item}
    if not isinstance(item, dict):
        logger.warning("批量策划：第 %d 条不是对象，丢弃", index)
        return None

    prompt_zh = _pick(item, _PROMPT_KEYS, PROMPT_CHARS)
    if not prompt_zh:
        logger.warning("批量策划：第 %d 条没有画面描述，丢弃", index)
        return None

    if app.ratio:
        # 锁了比例的应用（头像、白底商品图）不许模型改，改了出图就不是那个用途了
        ratio = app.ratio
    else:
        ratio = _text(item.get("ratio"), 12)
        if ratio not in RATIOS:
            if ratio:
                logger.info("批量策划：第 %d 条比例 %r 不认，回落 %s", index, ratio, fallback_ratio)
            ratio = fallback_ratio

    tier = _text(item.get("tier"), 8)
    if tier not in TIERS:
        tier = DEFAULT_TIER

    return {
        "label": _pick(item, _LABEL_KEYS, LABEL_CHARS) or f"子任务 {index}",
        "prompt_zh": prompt_zh,
        "ratio": ratio,
        "tier": tier,
        "n": _as_count(item.get("n")),
    }


def _classify(exc: LLMUnavailable) -> tuple[str, str]:
    """上游异常 → (分型, 面向用户的中文消息)。"""
    detail = str(exc)[:300]
    low = detail.lower()
    if "timeout" in low or "timed out" in low:
        return "timeout", f"拆解超时：{detail}"
    if "connect" in low:
        return "connect", "连不上模型服务，检查供应商地址与网络"
    if "401" in low or "403" in low:
        return "auth", f"上游拒绝鉴权：{detail}"
    if "404" in low:
        return "binding", f"{PLAN_ALIAS} 绑的模型上游不认（HTTP 404）：{detail}"
    return "api", f"拆解失败：{detail}"


def build_plan_prompt(idea: str, app: ImageApp, *, max_tasks: int) -> tuple[str, str]:
    """(system, user)。锁了比例的应用不把候选比例给模型，省得它去挑。"""
    payload: dict = {
        "用户想要的": idea,
        "应用": app.label,
        "应用用途": app.hint,
        "画面方向": app.target.subject_kind,
        "最多拆几条": max_tasks,
        "分辨率档候选": list(TIERS),
    }
    if app.ratio:
        payload["比例已锁定"] = app.ratio
    else:
        payload["比例候选"] = [
            {"key": r.key, "适合": r.hint or r.label} for r in RATIOS.values()
        ]
    return PLAN_SYSTEM, json.dumps(payload, ensure_ascii=False)


async def plan_tasks(idea: str, *, app_key: str, max_tasks: int = 6) -> list[dict]:
    """把一句话拆成若干条子任务。只调文本 LLM，不出图。

    返回 [{"label", "prompt_zh", "ratio", "tier", "n"}, ...]，每条都已归一化到
    合法取值：`ratio` 必在 `image_sizes.RATIOS`，`tier` 必在 `TIERS`，`n` 在 1~4。
    """
    idea = " ".join(str(idea or "").split())
    if not idea:
        raise BatchError("api", "先写一句话说明想要什么，再让 AI 拆")
    if len(idea) > MAX_IDEA_CHARS:
        raise BatchError(
            "api", f"需求描述 {len(idea)} 字，超过上限 {MAX_IDEA_CHARS} 字，先精简一下"
        )
    max_tasks = max(1, min(MAX_TASKS_CAP, int(max_tasks)))

    try:
        app = get_app(app_key)
        fallback_ratio = _default_ratio(app)
        system, user = build_plan_prompt(idea, app, max_tasks=max_tasks)
    except PromptError as exc:
        raise BatchError("api", str(exc)) from exc

    try:
        raw, _model, _ms = await complete_json(PLAN_ALIAS, system, user)
    except LLMUnavailable as exc:
        kind, message = _classify(exc)
        raise BatchError(kind, message) from exc

    items = _extract_list(raw)
    tasks: list[dict] = []
    for index, item in enumerate(items, start=1):
        task = _normalize(item, index=index, app=app, fallback_ratio=fallback_ratio)
        if task is not None:
            tasks.append(task)

    if not tasks:
        raise BatchError("api", "模型没给出可用的子任务，把需求写具体一点再试")
    if len(tasks) > max_tasks:
        logger.info("批量策划：模型给了 %d 条，截断到 %d 条", len(tasks), max_tasks)
        tasks = tasks[:max_tasks]
    return tasks

"""成套出图的 AI 编排（模块 17 · 需求见 `00.需求文档/.../成套出图节点.md`）。

把「我要一套风格一致的登录界面」变成一份**可执行、可编辑的实施方案**，
中间可以反问用户几个问题。用户不填轮数与并发——那些由方案推出来。

三个端点对应三个阶段：

1. ``ask``   —— 读需求，决定还要问什么，返回一组 elicitation 问题；
2. ``draft`` —— 拿着需求 + 已有答案，产出 `SetPlan`；
3. ``patch`` —— 用户改了方案的一部分，按影响面决定要不要回模型。

> [!warning] 数据结构都是抄的，不是自创
>
> 问题的形状抄 **MCP elicitation**（modelcontextprotocol.io，MIT）：
> 单选 = `enum` / `oneOf[{const,title}]`，多选 = `array + items.anyOf + minItems/maxItems`，
> 三动作 `accept | decline | cancel`。
> 方案的形状抄 **Refly WorkflowPlan**（github.com/refly-ai/refly，Apache-2.0）：
> 关键是把张数这类东西建成 plan 级 `variables`，改它们**不重规划**。

> [!warning] cancel 不是答案
>
> 用户关掉提问卡片是 `cancel`，不等于 `decline`（明确不选）。
> `cancel` 的那一问要留在未答清单里可以重开；`decline` 才算答过了。
> 混为一谈的话，用户手滑关掉一个窗口，AI 就当他弃权了。
"""

from __future__ import annotations

import logging
import re
from typing import Any

from domain.llm import LLMUnavailable, complete_json

logger = logging.getLogger(__name__)

#: 用哪个语义别名兜底。前端可以指定别的（用户要「选调研的 AI」）
DEFAULT_ALIAS = "explain-standard"

MAX_IDEA_CHARS = 800
#: 一轮最多问几个问题。问太多用户会烦，问完还能再问下一轮
MAX_QUESTIONS = 4
#: 一个问题最多几个选项
MAX_OPTIONS = 8

#: 回传给模型的"已经问过"标题上限。问了七八轮之后全量回传只会挤掉需求本身
MAX_ASKED = 12
#: 方案最多多少步。不是产品限制，只防模型失控
MAX_STEPS = 200

INTENTS = ("consistent", "varied")


class SetPlanError(Exception):
    """带分型的失败。`kind` 决定前端把用户导向哪里。"""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


# ---------------------------------------------------------------- 通用防御层
# 这几个函数的职责是「模型怎么胡说都能收场」。形状取自 domain/image_batch.py
# 里已经服役的同类实现，换了字段表。


def _text(value: object, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _as_int(value: object, *, default: int, lo: int, hi: int) -> int:
    """从模型给的任意东西里抠一个整数并夹到区间。

    模型经常返回 `"12张"` / `"约 8"` / `12.0`，直接 int() 会抛。
    bool 要单独挡：它是 int 的子类，`True` 会变成 1。
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


def _extract_list(raw: object, *keys: str) -> list:
    """从模型输出里捞出那个数组。

    模型换键名是常态（questions / items / list / data），
    所以先按候选键找，再退化成「取第一个数组值」。
    """
    if isinstance(raw, list):
        return raw
    if not isinstance(raw, dict):
        return []
    for key in keys:
        value = raw.get(key)
        if isinstance(value, list):
            return value
    for value in raw.values():
        if isinstance(value, list):
            return value
    return []


def _split_numbered(text: str) -> list[str]:
    """把「1. xxx\\n2. yyy」这种单字符串拆成多条。

    抄自蓝本 `splitSmartPromptItems` 的启发式：先按编号切，条数 ≥2 才认；
    否则按行切，行数 ≥2 才认；都不满足就当一条。
    **编号前缀要剥掉**——留着的话会跟着进提示词，模型会把「1.」当画面内容。
    """
    raw = str(text or "").strip()
    if raw == "":
        return []
    numbered = re.split(r"(?:^|\n)\s*\d+\s*[.、)）．]\s*", raw)
    parts = [p.strip() for p in numbered if p.strip() != ""]
    if len(parts) >= 2:
        return parts
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip() != ""]
    return lines if len(lines) >= 2 else [raw]


def _classify(exc: LLMUnavailable) -> tuple[str, str]:
    """把网关异常翻成用户能照着做的一句话。"""
    detail = str(exc)
    low = detail.lower()
    if "not found" in low or "does not exist" in low or "404" in low:
        return "binding", f"网关里没有这个别名：{detail}。去配置中心把它绑到一个模型上"
    if "connect" in low or "timeout" in low or "502" in low:
        return "network", f"连不上模型网关：{detail}"
    return "api", f"模型没能给出结果：{detail}"


# ---------------------------------------------------------------- 阶段一：反问

ASK_SYSTEM = f"""你在帮用户规划**一整套图**该怎么生成。用户只给了一句话，
你要判断还缺哪些关键信息，然后**最多问 {MAX_QUESTIONS} 个问题**把它问清楚。

好问题的标准：
- 问了能显著改变最终产出（画面风格、页面清单、目标平台、配色方向）；
- **给选项**，别让用户打字。选项要具体到能直接用，不要「其它」这种；
- 用户已经在原话里说清楚的**不要再问**。他说了「6 张」就别问要几张。

每个问题的形状（这是 MCP elicitation 的受限 JSON Schema，照着填）：
- 单选：{{"type":"single","title":"问题文案",
          "options":[{{"value":"a","label":"选项 A","hint":"一句话说明"}}]}}
- 多选：{{"type":"multi","title":"...","options":[...],"min":1,"max":3}}
- 填空（只在没法给选项时用）：{{"type":"text","title":"...","placeholder":"..."}}

严格返回这个 JSON，不要 markdown 代码块：
{{
  "enough": false,
  "questions": [ ...最多 {MAX_QUESTIONS} 个... ]
}}

信息已经够了就返回 {{"enough": true, "questions": []}}。
**宁可少问**：能自己合理推断的就别问，用户是来出图的不是来做问卷的。"""


def _norm_question(item: object, index: int) -> dict | None:
    if not isinstance(item, dict):
        return None
    title = _text(item.get("title") or item.get("question") or item.get("message"), 120)
    if title == "":
        return None
    kind = str(item.get("type") or "single").strip().lower()
    if kind not in {"single", "multi", "text"}:
        kind = "single"

    opts: list[dict] = []
    for raw in _extract_list(item.get("options"), "options", "choices", "enum")[:MAX_OPTIONS]:
        if isinstance(raw, dict):
            value = _text(raw.get("value") or raw.get("const") or raw.get("label"), 60)
            label = _text(raw.get("label") or raw.get("title") or value, 60)
            hint = _text(raw.get("hint") or raw.get("description"), 120)
        else:
            value = label = _text(raw, 60)
            hint = ""
        if value == "":
            continue
        opts.append({"value": value, "label": label or value, "hint": hint})

    # 说是选择题却一个选项都没给：降级成填空，而不是丢掉这一问
    if kind in {"single", "multi"} and len(opts) < 2:
        kind = "text"

    out: dict[str, Any] = {
        "id": _text(item.get("id"), 40) or f"q{index}",
        "type": kind,
        "title": title,
        "hint": _text(item.get("hint") or item.get("description"), 200),
        "options": opts,
    }
    if kind == "multi":
        out["min"] = _as_int(item.get("min"), default=1, lo=0, hi=len(opts))
        out["max"] = _as_int(item.get("max"), default=len(opts), lo=1, hi=len(opts))
        if out["max"] < out["min"]:
            out["max"] = out["min"]
    if kind == "text":
        out["placeholder"] = _text(item.get("placeholder"), 80)
    return out


#: 附件正文在提示词里最多占多少字。与单个附件的上限分开：带了 6 份文档时，
#: 每份 4000 字会把上下文全吃掉，用户那句需求反而成了最不起眼的一段。
ATTACH_TOTAL_CHARS = 9000


def _attachment_lines(attachments: list[dict]) -> list[str]:
    """把附件渲染成提示词里的一段。没有附件时返回空列表（不留空标题）。

    读不出正文的附件**照样列出来**，只标一句"读不出正文"：
    用户带了 `设计规范.sketch` 这件事本身就是信息，模型至少知道有这么个东西在，
    必要时会在反问里提一句；悄悄丢掉的话，用户会以为它读过了。
    """
    if not attachments:
        return []
    lines = ["用户还带了这些文件："]
    budget = ATTACH_TOTAL_CHARS
    for item in attachments:
        name = _text(item.get("name"), 120) or "未命名文件"
        text = _text(item.get("text"), max(0, budget))
        if text == "":
            lines.append(f"- {name}（读不出正文，只知道有这个文件）")
            continue
        budget -= len(text)
        lines.append(f"- {name} 的正文：\n{text}")
        if budget <= 0:
            lines.append("（后面的附件因为篇幅没有全部读进来）")
            break
    lines.append("这些文件是**约束**，不是灵感来源——里面写死的东西要照做。")
    return lines


def build_ask_user(
    idea: str,
    answered: list[dict],
    upstream_images: int,
    attachments: list[dict] | None = None,
    note: str = "",
    more: bool = False,
    asked: list[str] | None = None,
) -> str:
    lines = [f"用户的需求：{idea}"]
    if upstream_images > 0:
        lines.append(
            f"用户已经选好了 {upstream_images} 张参考图。"
            "**不要问他要不要参考图、参考哪张**——他已经给了。"
            "可以问的是「照着参考图的哪一面来」（构图？配色？质感？还是整体气质）。"
        )
    else:
        lines.append("没有参考图，这批图完全从文字生成。")
    if answered:
        lines.append("已经问过并得到的答复：")
        for a in answered:
            q = _text(a.get("title"), 120)
            v = a.get("answer")
            shown = "、".join(str(x) for x in v) if isinstance(v, list) else _text(v, 200)
            lines.append(f"- {q} → {shown}")
        lines.append("不要重复问上面已经答过的。")
    if asked:
        # 已经摆在界面上、用户还没答的那些也要告诉它。
        # 只发"答过的"的话，它不知道自己问过什么，第二轮就会把
        # 「参考图照着哪一面来」换成「参考图借哪一面」再问一遍（实测）。
        lines.append("这些已经问过了（用户还没答），换个层面问，别换个说法重问：")
        for title in asked[:MAX_ASKED]:
            lines.append(f"- {title}")
    if note:
        lines.append(f"用户自己补了一句：{note}")
    lines.extend(_attachment_lines(attachments or []))
    if more:
        # 默认那条"宁可少问"在这一轮要让位：是用户自己按了"再问我几个"，
        # 这时回一句"没什么可问的了"是答非所问。
        lines.append(
            "用户点名要你**再多问几个**。这一轮不要返回 enough:true，"
            "换一个层面去问（前面问了大方向就问细节：版式、留白、字重、"
            "状态与边界情况），不要把问过的换个说法再问一遍。"
        )
    return "\n".join(lines)


async def ask(
    idea: str,
    *,
    answered: list[dict] | None = None,
    upstream_images: int = 0,
    attachments: list[dict] | None = None,
    note: str = "",
    more: bool = False,
    asked: list[str] | None = None,
    alias: str = DEFAULT_ALIAS,
) -> dict:
    """决定还要问什么。返回 `{enough, questions}`。

    `more=True` 是用户按了"再问我几个"：这一轮**必须**问出东西来。
    """
    idea = _text(idea, MAX_IDEA_CHARS + 1)
    if idea == "":
        raise SetPlanError("api", "先写一句话说明想要做什么")
    if len(idea) > MAX_IDEA_CHARS:
        raise SetPlanError("api", f"需求 {len(idea)} 字，超过上限 {MAX_IDEA_CHARS} 字，先精简一下")

    user = build_ask_user(
        idea,
        answered or [],
        max(0, int(upstream_images or 0)),
        attachments or [],
        _text(note, 400),
        bool(more),
        [_text(t, 120) for t in (asked or []) if _text(t, 120)],
    )
    try:
        raw, _model, _ms = await complete_json(alias, ASK_SYSTEM, user)
    except LLMUnavailable as exc:
        kind, message = _classify(exc)
        raise SetPlanError(kind, message) from exc

    items = _extract_list(raw, "questions", "items", "asks")
    questions = [q for q in (_norm_question(x, i) for i, x in enumerate(items, 1)) if q is not None]
    questions = questions[:MAX_QUESTIONS]
    # 模型说「够了」但又给了问题，以问题为准：它给得出来说明确实还有不确定的
    enough = bool(raw.get("enough")) if isinstance(raw, dict) else False
    # 用户主动要求再问时，模型回"够了"也不作数——它得给出东西，
    # 否则界面上按了按钮什么都不发生，看起来像坏了
    return {"enough": enough and not questions and not more, "questions": questions}


# ---------------------------------------------------------------- 阶段二：方案

PLAN_SYSTEM = """你在把用户的需求变成一份**成套出图的实施方案**。

先判断意图，它决定底层怎么跑：
- consistent（一致成套）：这些图属于同一套东西，风格必须统一
  （一套登录流程的多个页面、同一个角色的多个场景、连续分镜）。
- varied（多样备选）：同一个需求的多个不同方案，用来找灵感、做 A/B。

严格返回这个 JSON，不要 markdown 代码块：
{
  "goal": "一句话目标",
  "intent": "consistent 或 varied",
  "variables": [
    {"key":"count","label":"张数","type":"number","value":8},
    {"key":"ratio","label":"画幅","type":"option","value":"9:16","options":["1:1","9:16","16:9"]}
  ],
  "steps": [
    {"id":"s1","title":"登录页","prompt":"完整可用的出图提示词","dependsOn":[]}
  ],
  "rationale": "一两句话说明你为什么这么排"
}

写 steps 时：
- **每一步的 prompt 都要完整可用**，不能写「同上，但改成红色」这种依赖上一条才看得懂的；
- consistent 时把共同的风格锚点**写进每一条**（配色、字体气质、圆角、光影），
  这是保证一致性的唯一手段；同时 dependsOn 填上一步的 id，表示要串着跑；
- varied 时 dependsOn 一律留空，各步互不依赖；
- steps 的条数就是最终出图张数，要与 variables 里的 count 一致；
- 用户原话里已经说死的（数量、具体风格名、页面清单），**照他说的来**，
  这条压过你自己的判断。

variables 放的是**用户可能会调、但调了不需要重新规划**的东西：张数、画幅、风格强度。
不要把每一步的画面内容塞进 variables。"""


def _norm_variable(item: object) -> dict | None:
    if not isinstance(item, dict):
        return None
    key = _text(item.get("key") or item.get("name"), 40)
    if key == "":
        return None
    kind = str(item.get("type") or "string").strip().lower()
    if kind not in {"number", "option", "string"}:
        kind = "string"
    out: dict[str, Any] = {
        "key": key,
        "label": _text(item.get("label") or key, 40),
        "type": kind,
        "value": item.get("value"),
    }
    if kind == "number":
        out["value"] = _as_int(item.get("value"), default=1, lo=1, hi=MAX_STEPS)
    else:
        out["value"] = _text(item.get("value"), 120)
    opts = [_text(o, 60) for o in _extract_list(item.get("options"), "options")]
    out["options"] = [o for o in opts if o != ""][:MAX_OPTIONS]
    return out


def _norm_steps(raw: object) -> list[dict]:
    items = _extract_list(raw, "steps", "tasks", "items", "list")
    # 模型偶尔把 steps answered 成一整段编号文本
    if not items and isinstance(raw, dict):
        blob = raw.get("steps") or raw.get("plan")
        if isinstance(blob, str):
            items = [{"title": "", "prompt": p} for p in _split_numbered(blob)]

    out: list[dict] = []
    for i, item in enumerate(items[:MAX_STEPS], 1):
        if isinstance(item, str):
            item = {"prompt": item}
        if not isinstance(item, dict):
            continue
        prompt = _text(item.get("prompt") or item.get("text") or item.get("description"), 2000)
        if prompt == "":
            continue
        deps = _extract_list(item.get("dependsOn"), "dependsOn", "depends_on")
        out.append(
            {
                "id": _text(item.get("id"), 40) or f"s{i}",
                "title": _text(item.get("title") or item.get("name"), 60) or f"第 {i} 步",
                "prompt": prompt,
                "dependsOn": [_text(d, 40) for d in deps],
            }
        )

    # id 去重：模型给重复 id 时，patch 会定位到错误的那一步
    seen: set[str] = set()
    for i, step in enumerate(out, 1):
        if step["id"] in seen:
            step["id"] = f"s{i}"
        seen.add(step["id"])
    return out


def normalize_plan(raw: object) -> dict:
    """把模型输出夹成一份一定能执行的方案。"""
    data = raw if isinstance(raw, dict) else {}
    steps = _norm_steps(data)
    if not steps:
        raise SetPlanError("api", "模型没给出任何可执行的步骤，把需求写具体一点再试")

    intent = str(data.get("intent") or "").strip().lower()
    if intent not in INTENTS:
        # 认不出就按一致成套：串行只是慢，并发跑错是同时废一批
        intent = "consistent"

    raw_vars = _extract_list(data.get("variables"), "variables")
    variables = [v for v in (_norm_variable(x) for x in raw_vars) if v is not None]
    # 张数与步数必须一致：界面写着 12、跑出来 5 张且看不出原因，是最难查的一类
    if not any(v["key"] == "count" for v in variables):
        variables.insert(
            0,
            {"key": "count", "label": "张数", "type": "number", "value": len(steps), "options": []},
        )
    for v in variables:
        if v["key"] == "count":
            v["value"] = len(steps)

    return {
        "goal": _text(data.get("goal"), 200) or "成套出图",
        "intent": intent,
        "variables": variables,
        "steps": steps,
        "rationale": _text(data.get("rationale") or data.get("why"), 400),
    }


def build_plan_user(
    idea: str,
    answered: list[dict],
    upstream_images: int,
    want: int | None,
    attachments: list[dict] | None = None,
    note: str = "",
) -> str:
    lines = [f"用户的需求：{idea}"]
    if answered:
        lines.append("澄清问答：")
        for a in answered:
            q = _text(a.get("title"), 120)
            v = a.get("answer")
            shown = "、".join(str(x) for x in v) if isinstance(v, list) else _text(v, 200)
            lines.append(f"- {q} → {shown}")
    if upstream_images > 0:
        lines.append(
            f"用户选了 {upstream_images} 张参考图，出图时会一并送上去。"
            "所以 steps 的提示词里**不要重复描述参考图里已经有的东西**"
            "（那张图会真的发过去，再用文字复述一遍只会互相打架），"
            "只写「要改成什么」「要保持什么」。"
        )
    else:
        lines.append("没有参考图，每条提示词都要能独立成立。")
    if note:
        lines.append(f"用户自己补了一句：{note}")
    lines.extend(_attachment_lines(attachments or []))
    if want is not None:
        lines.append(f"用户明确要 {want} 张，steps 就出 {want} 条，不要多也不要少。")
    return "\n".join(lines)


async def draft(
    idea: str,
    *,
    answered: list[dict] | None = None,
    upstream_images: int = 0,
    want: int | None = None,
    attachments: list[dict] | None = None,
    note: str = "",
    alias: str = DEFAULT_ALIAS,
) -> dict:
    """产出实施方案。只调文本模型，不出图——所以可以随便重来。"""
    idea = _text(idea, MAX_IDEA_CHARS + 1)
    if idea == "":
        raise SetPlanError("api", "先写一句话说明想要做什么")

    user = build_plan_user(
        idea,
        answered or [],
        max(0, int(upstream_images or 0)),
        None if want is None else max(1, min(int(want), MAX_STEPS)),
        attachments or [],
        _text(note, 400),
    )
    try:
        raw, _model, _ms = await complete_json(alias, PLAN_SYSTEM, user)
    except LLMUnavailable as exc:
        kind, message = _classify(exc)
        raise SetPlanError(kind, message) from exc
    return normalize_plan(raw)


# ---------------------------------------------------------------- 阶段三：改动

#: 只碰这些字段时不重规划（Refly 的 variables 分层同款）
LOCAL_KEYS = frozenset({"variables", "title", "prompt", "order"})


def change_tier(ops: list[dict]) -> int:
    """这批改动属于哪一档，决定要不要回模型。

    - 1 档：只动 variables 或某一步的文案 → 本地改，**不进模型**；
    - 2 档：增删步骤、改依赖 → 增量重算受影响的那几条；
    - 3 档：改了目标本身 → 整份重新规划。

    判据要硬。含糊的话会出现「改个张数也要等模型二十秒」，
    或者反过来「改了目标却还按旧方案跑」。
    """
    tier = 1
    for op in ops:
        kind = str(op.get("op") or "").strip()
        if kind == "setGoal":
            return 3
        if kind in {"addStep", "removeStep", "setDependsOn"}:
            tier = max(tier, 2)
        elif kind in {"setVariable", "setStepTitle", "setStepPrompt", "reorder"}:
            tier = max(tier, 1)
        else:
            # 不认识的操作按最保守处理：宁可多重算一次，也不要按旧方案跑
            tier = max(tier, 2)
    return tier


def apply_ops(plan: dict, ops: list[dict]) -> dict:
    """把一档改动落到方案上。纯函数，不碰模型。"""
    out = {
        "goal": plan.get("goal", ""),
        "intent": plan.get("intent", "consistent"),
        "variables": [dict(v) for v in plan.get("variables", [])],
        "steps": [dict(s) for s in plan.get("steps", [])],
        "rationale": plan.get("rationale", ""),
    }
    by_id = {s["id"]: s for s in out["steps"]}
    for op in ops:
        kind = str(op.get("op") or "")
        if kind == "setVariable":
            for v in out["variables"]:
                if v.get("key") == op.get("key"):
                    v["value"] = op.get("value")
        elif kind == "setStepTitle":
            step = by_id.get(str(op.get("id")))
            if step is not None:
                step["title"] = _text(op.get("value"), 60)
        elif kind == "setStepPrompt":
            step = by_id.get(str(op.get("id")))
            if step is not None:
                step["prompt"] = _text(op.get("value"), 2000)
        elif kind == "removeStep":
            out["steps"] = [s for s in out["steps"] if s["id"] != str(op.get("id"))]
        elif kind == "reorder":
            order = [str(x) for x in _extract_list(op.get("value"), "value", "order")]
            rank = {sid: i for i, sid in enumerate(order)}
            out["steps"].sort(key=lambda s: rank.get(s["id"], len(rank)))
    # 步数变了要把 count 拉齐，否则界面写着 8、实际跑 7 条
    for v in out["variables"]:
        if v.get("key") == "count":
            v["value"] = len(out["steps"])
    return out


def to_run_config(plan: dict) -> dict:
    """方案 → 底层执行参数。**纯函数，不经模型**。

    这一层是「参数不暴露给用户」的落点：用户改方案，系统改参数。
    反过来不成立——参数是方案的投影，不是另一处真相。
    """
    steps = plan.get("steps", [])
    consistent = plan.get("intent") != "varied"
    return {
        "mode": "serial" if consistent else "parallel",
        "count": len(steps),
        "loop_start": 1,
        "variable_prompts": [s.get("prompt", "") for s in steps],
        "image_input": False,
        "image_batch_size": 1,
        "title": _text(plan.get("goal"), 20) or "成套",
    }

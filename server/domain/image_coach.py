"""提示词解读与对话式改写（模块 16）：出图之前先看懂，再聊着改。

控制台最终发给生图模型的是一段结构化英文提示词（七段式，`image_prompts.flatten`
出来的 JSON），用户看不懂它要画什么，更没法微调——只能盲出一张再猜哪里不对。
这个模块补两条能力，都不出图、只出字：

- `explain_prompt` 把提示词翻成中文人话，并把用户的中文原话与提示词逐条对照，
  指出「你说了但提示词里没有体现」的部分。花钱之前先看见落差，这是最值钱的一段。
- `chat_prompt` 用中文对话改提示词：用户说「再暗一点」「加点雾」，模型直接给回
  改完的**完整**英文提示词，前端拿 `changed` 决定要不要覆盖右栏。

两条都复用 `image_describe` 那套通路：同一个网关客户端、同一个语义别名
`VISION_ALIAS`（BR-100，业务代码里不出现模型名）、同一套 `DescribeError` 分型，
UI 靠 kind 决定提示什么。另起一套只会让错误语义分叉。
"""

from __future__ import annotations

import json
import re

from domain import image_describe
from domain.image_describe import VISION_ALIAS, DescribeError

__all__ = ["VISION_ALIAS", "DescribeError", "chat_prompt", "explain_prompt"]

# 七段式提示词展开后上千字符，超出部分多半是 constraints 那串长列表，截掉不影响解读
MAX_PROMPT_CHARS = 6000
MAX_IDEA_CHARS = 1000

MAX_POINTS = 8
MAX_MISSING = 6

# 对话历史只留最近 20 条、每条 4000 字符。超了直接截：让用户「删掉前面说过的话
# 才能继续聊」是荒谬的，这里报错没有任何意义
MAX_TURNS = 20
MAX_TURN_CHARS = 4000

ROLES = ("user", "assistant")

# 模型偶尔自作主张加 --ar 16:9 这类画幅参数。画布由调用方按目标尺寸另拼
# （image_prompts.ensure_canvas），漏进去只会和真实画布打架
_CANVAS_FLAG = re.compile(r"\s*--(?:ar|aspect|v|q|s|stylize|style|niji|no)\s+\S+", re.IGNORECASE)


EXPLAIN_SYSTEM = (
    "你给不懂英文提示词的用户讲解一段生图提示词，让他在花钱出图之前知道会得到什么。"
    "只输出 JSON 对象，全部用中文，字段：\n"
    "summary（两三句话，说清这张图最终会画成什么样：画面主体、所在场景、构图、"
    "画风、色调。要具体到能想象出画面，禁止「一张精美的图片」「视觉效果出色」这类空话）、\n"
    "points（数组，每项 {label, text}。label 是中文小标题，如 主体 / 场景 / 构图 / "
    "画风 / 色调 / 明确排除；text 是这一段的中文解读。**只讲提示词里真实写了的段**，"
    "提示词没写的段不要出现，更不要为了凑够几条而编内容）、\n"
    "missing（数组，字符串。把「用户原话」与提示词逐条比对，列出用户提到了、但提示词里"
    "没有体现的要点，每条一句中文，直接说缺什么。提示词已经覆盖全部原话，或者根本没有"
    "用户原话时，返回空数组 []。**没有遗漏就是空数组，禁止为了显得有用而编造遗漏项。**"
    "判定「有没有体现」要看**整段提示词**，不是只看主体那一段：色调写在 palette 里、"
    "光线写在 lighting 里、配角写在 supporting 里，都算已经体现，换了说法也算"
    "（「暖黄灯光」对应 warm amber tones 或 warm lamp light，就是覆盖了）。"
    "只有整段提示词从头到尾都找不到对应内容时才算遗漏。宁可漏报也不要误报——"
    "误报会让用户去补一个本来就有的东西，反而把提示词写坏。）"
)

CHAT_SYSTEM = (
    "你是生图提示词的改写助手。用户用中文说想怎么改，你直接改出新的英文提示词。"
    "只输出 JSON 对象，字段：\n"
    "reply（中文回复，说清**这一轮具体改了什么**，例如「把光线从正午改成黄昏侧逆光，"
    "并加了一层低空薄雾」。禁止「好的，已为您优化」这类没有信息量的话；用户只是提问、"
    "没让你改的时候就正常回答他的问题）、\n"
    "prompt（改完的**完整**英文提示词，必须是能直接发给生图模型的整段，"
    "给增量、给省略号、给「其余不变」一律无效；这一轮只是答疑、没有改动时给 null）。\n"
    "硬要求：\n"
    "- 保持提示词原来的形态：进来是 JSON 结构就还回同结构的 JSON，进来是散文就还回散文。\n"
    "- 只动用户要求改的部分，其余原样保留，不要顺手重写。\n"
    "- 不要要求在图上写字（生图模型拼不对字），也不要输出 --ar、画幅、尺寸之类参数，"
    "画布由调用方另行拼接。"
)


async def _chat(messages: list[dict]) -> tuple[dict, str | None, int]:
    """一次 JSON mode 调用，返回 (解析后 dict, 上游报的 model, 耗时)。

    直接借 `image_describe` 的实现：客户端、超时、异常分型、JSON 兜底解析这四样
    与反推通路完全同源，复制一份出来只会两边慢慢长歪。单测替掉的就是这个函数。
    """
    return await image_describe._chat(messages)


def _text(value: object, limit: int) -> str:
    """取文本字段。模型经常把该给字符串的字段答成数组，直接 str() 会把 Python
    字面量原样漏给用户，这里统一拍平。"""
    if isinstance(value, list | tuple):
        value = "，".join(str(v).strip() for v in value if str(v).strip())
    return " ".join(str(value or "").split())[:limit]


def _clean_points(raw: object) -> list[dict]:
    """收敛分段解读。没有 text 的条目直接丢——空条目在界面上就是一行留白。"""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if isinstance(item, dict):
            label = _text(item.get("label") or item.get("title"), 20)
            text = _text(item.get("text") or item.get("desc"), 400)
        else:
            label, text = "", _text(item, 400)
        if not text:
            continue
        out.append({"label": label or "说明", "text": text})
        if len(out) >= MAX_POINTS:
            break
    return out


def _clean_missing(raw: object) -> list[str]:
    """收敛遗漏项。答成一整段话的按分隔符拆开；答成对象或别的什么就整个丢掉——
    宁可少报，也不能把结构噪声当成「你漏了这个」推给用户。"""
    if isinstance(raw, str):
        items: list[object] = list(re.split(r"[\n；;、]+", raw))
    elif isinstance(raw, list):
        items = list(raw)
    else:
        return []
    out: list[str] = []
    for item in items:
        if isinstance(item, dict):
            line = _text(item.get("text") or item.get("point"), 200)
        elif isinstance(item, list | tuple):
            line = ""
        else:
            line = _text(item, 200)
        if line and line not in out:
            out.append(line)
    return out[:MAX_MISSING]


async def explain_prompt(
    prompt: str,
    *,
    app_label: str,
    style_label: str,
    idea: str = "",
) -> dict:
    """把最终英文提示词讲成中文人话，并对照用户原话找出漏掉的要点。

    `idea` 是用户当初写的那句中文；给了才做比对，没给就不比——没有基准的情况下
    模型报出来的「遗漏」全是它自己想象的。

    返回 {summary, points, missing, model, latency_ms}。
    """
    cleaned = (prompt or "").strip()
    if not cleaned:
        raise DescribeError("api", "提示词是空的，先生成或写一段提示词再看解读")

    note = " ".join((idea or "").split())[:MAX_IDEA_CHARS]
    payload: dict = {
        "用途": app_label,
        "画风": style_label,
        "最终提示词": cleaned[:MAX_PROMPT_CHARS],
    }
    if note:
        payload["用户原话"] = note

    parsed, model, latency_ms = await _chat(
        [
            {"role": "system", "content": EXPLAIN_SYSTEM},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ]
    )

    summary = _text(parsed.get("summary"), 800)
    if not summary:
        raise DescribeError("api", "模型没有给出解读，重试一次")
    return {
        "summary": summary,
        "points": _clean_points(parsed.get("points")),
        # 没有原话就没有比对基准，这时模型给什么都不作数
        "missing": _clean_missing(parsed.get("missing")) if note else [],
        "model": model,
        "latency_ms": latency_ms,
    }


def _history(messages: list[dict] | None) -> list[dict]:
    """清洗对话历史：只认 user / assistant 的非空文本，长的截断，旧的丢掉。"""
    rows: list[dict] = []
    for item in messages or []:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        content = str(item.get("content") or "").strip()
        if role not in ROLES or not content:
            continue
        rows.append({"role": role, "content": content[:MAX_TURN_CHARS]})
    return rows[-MAX_TURNS:]


def _is_structured(prompt: str) -> bool:
    """提示词是不是 JSON 结构形态。管线拿到什么就发什么，改完必须保持同一形态，
    否则 `image_prompts` 那套七段式结构会在一次闲聊里被悄悄拍成散文。"""
    try:
        return isinstance(json.loads(prompt), dict)
    except ValueError:
        return False


def _clean_prompt(raw: object, *, structured: bool, base: str) -> str | None:
    """取出改完的提示词。没动、给了 null、或者改出来跟原来一模一样，都算这轮没改。"""
    if raw is None:
        return None
    if isinstance(raw, dict | list):
        # JSON 形态下模型常直接把结构体答回来，按 image_prompts.flatten 的口径拍平
        text = json.dumps(raw, ensure_ascii=False, indent=2)
    else:
        text = str(raw).strip()
        # JSON 形态不做这步：正则会把结构里的合法内容切坏
        if not structured:
            text = _CANVAS_FLAG.sub("", text).strip()
    if not text or text.lower() in ("null", "none", "n/a"):
        return None
    return None if text.strip() == base.strip() else text


async def chat_prompt(
    messages: list[dict],
    *,
    prompt: str,
    app_label: str,
    style_label: str,
) -> dict:
    """对话式改提示词。`messages` 是 [{role, content}] 的历史，最后一条是这轮诉求。

    返回 {reply, prompt, changed, model, latency_ms}；`prompt` 为 None 表示这轮
    只是答疑，前端不要覆盖右栏。
    """
    base = (prompt or "").strip()
    if not base:
        raise DescribeError("api", "当前没有提示词可改，先生成或写一段提示词")
    history = _history(messages)
    if not history:
        raise DescribeError("api", "没有收到对话内容，说一句想怎么改")

    structured = _is_structured(base)
    payload = {
        "用途": app_label,
        "画风": style_label,
        "提示词形态": "JSON 结构，改完仍要是同结构的 JSON" if structured else "散文，改完仍是散文",
        "当前提示词": base[:MAX_PROMPT_CHARS],
    }
    parsed, model, latency_ms = await _chat(
        [
            {"role": "system", "content": CHAT_SYSTEM},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            *history,
        ]
    )

    reply = _text(parsed.get("reply"), 1200)
    if not reply:
        raise DescribeError("api", "模型没有给出回复，重试一次")
    new_prompt = _clean_prompt(parsed.get("prompt"), structured=structured, base=base)
    return {
        "reply": reply,
        "prompt": new_prompt,
        "changed": new_prompt is not None,
        "model": model,
        "latency_ms": latency_ms,
    }

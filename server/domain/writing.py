"""写作纠错：两段式（FR-403、BR-97）。

> [!danger] 一步式的实测覆盖率只有 40.6%
>
> NAACL 2024 Findings：把整句丢给 GPT-4 让它「找错并解释」，只覆盖 40.6% 的错误。
> **整句一次过是错的架构**，不是提示词写得不够好。

正确流水线：

```
学习者原句
   ↓  LLM 只做一件事：产出修正句（不解释）
修正句
   ↓  ERRANT 对齐成原子编辑（M/R/U × 25 类）
逐条编辑
   ↓  每条单独喂 LLM 生成中文讲解
逐条讲解
   ↓  按 ERRANT 类型归档 → 命中误区 → 关联语法点 → 进 FSRS
```

ERRANT 需要「修正句」作为输入，所以修正句必须先由 LLM 产出（FR-403a）——
这个顺序不能倒，也不能省。
"""

from __future__ import annotations

import json
import logging
import threading

from domain.misconceptions import BY_ERRANT

logger = logging.getLogger(__name__)

_annotator = None
_lock = threading.Lock()

MAX_INPUT_CHARS = 4000


class WritingError(RuntimeError):
    pass


def get_annotator():
    """ERRANT 单例。它内部会加载 spaCy 模型，与 `domain.syntax` 各自一份，
    但 en_core_web_sm 只有 12MB，不值得为共享实例去动 errant 的初始化路径。"""
    global _annotator
    if _annotator is None:
        with _lock:
            if _annotator is None:
                import errant

                _annotator = errant.load("en")
                logger.info("ERRANT 已加载")
    return _annotator


# ─────────────── 第一段：产出修正句 ───────────────

CORRECT_SYSTEM = (
    "你是英语写作批改助手。学习者写了一段英文，你的任务**只有一件**：输出改正后的英文。\n"
    "规则：\n"
    "1. 只改语法、用词、拼写、标点的错误，不改写风格、不换更高级的表达、不扩写；\n"
    "2. 保留原意与原有的句子数量；能不动的词一个都别动；\n"
    "3. 原句没有错误时，原样返回；\n"
    "4. **不要解释、不要加任何说明文字**——解释是下一步的事。\n"
    'JSON 输出：{"corrected": "改正后的英文"}'
)


async def correct_sentence(text: str) -> str:
    """第一段：LLM 只产出修正句。解释留到逐条阶段（BR-97）。"""
    from domain.llm import complete_json

    text = (text or "").strip()
    if not text:
        raise WritingError("空文本")
    if len(text) > MAX_INPUT_CHARS:
        raise WritingError(f"超过 {MAX_INPUT_CHARS} 字符上限")
    parsed, _model, _ms = await complete_json("grammar-deep", CORRECT_SYSTEM, text)
    corrected = str(parsed.get("corrected") or "").strip()
    if not corrected:
        raise WritingError("模型未返回修正句")
    return corrected


# ─────────────── 第二段：原子化 ───────────────


def atomize(original: str, corrected: str) -> list[dict]:
    """ERRANT 对齐 → 原子编辑列表。

    返回的 `o_start`/`o_end` 是**词序号**（ERRANT 的口径），
    `char_start`/`char_end` 是原句里的 UTF-16 偏移，前端直接拿来划线。
    """
    ann = get_annotator()
    orig = ann.parse(original)
    cor = ann.parse(corrected)
    out: list[dict] = []
    for i, e in enumerate(ann.annotate(orig, cor)):
        if e.type in ("noop", "UNK") and not e.o_str and not e.c_str:
            continue
        span = orig[e.o_start : e.o_end]
        if len(span):
            char_start = _u16(original[: span.start_char])
            char_end = _u16(original[: span.end_char])
        else:
            # 插入型编辑（M:*）在原句里没有跨度，锚到插入点前一个词的末尾
            anchor = orig[max(0, e.o_start - 1) : max(1, e.o_start)]
            pos = anchor.end_char if len(anchor) else 0
            char_start = char_end = _u16(original[:pos])
        out.append(
            {
                "ordinal": i,
                "errant_type": e.type,
                "o_start": e.o_start,
                "o_end": e.o_end,
                "o_str": e.o_str,
                "c_str": e.c_str,
                "char_start": char_start,
                "char_end": char_end,
                "misconception_candidates": BY_ERRANT.get(e.type, []),
            }
        )
    return out


def _u16(s: str) -> int:
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in s)


# ─────────────── 第三段：逐条讲解 ───────────────

EXPLAIN_SYSTEM = (
    "你在给中国英语学习者讲解写作错误。系统已用 ERRANT 把修改切成了独立的原子编辑，"
    "每条只涉及一处改动。\n"
    "对每条编辑写一句到两句中文讲解：说清改动是什么、为什么要改、背后是哪条规则。"
    "不要复述整句、不要讲这条编辑之外的内容、不要客套。\n"
    "如果给了候选误区，判断哪个最贴合就填 misconception，都不贴合就留空串。\n"
    'JSON 输出：{"items":[{"ordinal":0,"explanation":"...","misconception":"code 或空串"}]}'
)


async def explain_edits(original: str, corrected: str, edits: list[dict]) -> list[dict]:
    """第三段：**每条编辑单独讲解**。

    一次请求带多条编辑是为了省往返，但提示词明确要求逐条独立作答——
    与「把整句丢过去让它自由发挥」是两回事（那正是 40.6% 覆盖率的做法）。
    """
    from domain.llm import complete_json

    if not edits:
        return []
    payload = json.dumps(
        {
            "原句": original,
            "修正句": corrected,
            "编辑": [
                {
                    "ordinal": e["ordinal"],
                    "errant_type": e["errant_type"],
                    "原文片段": e["o_str"],
                    "改成": e["c_str"],
                    "候选误区": e["misconception_candidates"],
                }
                for e in edits
            ],
        },
        ensure_ascii=False,
    )
    parsed, _model, _ms = await complete_json("grammar-deep", EXPLAIN_SYSTEM, payload)
    by_ord = {int(it.get("ordinal", -1)): it for it in parsed.get("items", [])}
    for e in edits:
        got = by_ord.get(e["ordinal"]) or {}
        e["explanation"] = (got.get("explanation") or "").strip() or None
        code = (got.get("misconception") or "").strip()
        # LLM 只能在候选集合里选，不能自创误区 code——误区必须是可枚举的
        e["misconception"] = code if code in e["misconception_candidates"] else None
        if code and e["misconception"] is None:
            logger.debug("LLM 给了不在候选里的误区 %s，已忽略", code)
    return edits


SUMMARY_SYSTEM = (
    "用一句中文总结这次批改的主要问题类型（不超过 30 字），"
    "没有错误就写「这段没有语法问题」。只输出这句话，不要解释。"
)


async def summarize(original: str, edits: list[dict]) -> str | None:
    from domain.llm import LLMUnavailable, complete_text

    try:
        return (
            await complete_text(
                "translate-fast",
                [
                    {"role": "system", "content": SUMMARY_SYSTEM},
                    {
                        "role": "user",
                        "content": json.dumps(
                            {
                                "原句": original,
                                "错误类型": [e["errant_type"] for e in edits],
                            },
                            ensure_ascii=False,
                        ),
                    },
                ],
            )
        ).strip() or None
    except LLMUnavailable:
        return None

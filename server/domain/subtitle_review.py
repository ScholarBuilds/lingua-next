"""字幕无参考质检：LLM 裁判 + 逐条可采纳的问题清单（需求 09 v6 FR-77）。

没有金标准文本，做不了 WER，业内在这种场景下的做法是 reference-free LLM-as-judge：
让模型基于上下文自洽性挑出可疑处，而不是给一个分数。裁判会误报，所以输出是
**定位到句的问题清单 + 建议改法**，由人逐条采纳或忽略，绝不整段覆盖。

与 `pipeline_health` 的确定性检查（超限率、时间戳单调、译文覆盖）互补：
那边查"结构对不对"，这边查"内容像不像话"。
"""

import asyncio
import json
import logging

from domain.llm import complete_json

logger = logging.getLogger(__name__)

# 每批送审句数：太少浪费往返，太多模型注意力散、定位开始漂
BATCH = 20
CONCURRENCY = 4
# 单条视频最多报这么多问题，免得整屏红字反而没人看
MAX_ISSUES = 40

KINDS = ("wrong_word", "bad_split", "noise", "translation_mismatch")
SEVERITIES = ("info", "warn", "error")

# 修复动作词汇表（v10.7 FR-143）。
#
# 旧版裁判只能说"把文本改成 X"，凡是修法不是文本替换的——去噪、合并、拆分——
# 就只能留个空 suggestion，于是这些问题一键采纳处理不了，非得人进对话让代理做。
# 实测 33 条不可自动应用的问题里，noise「应当清理」、bad_split「疑似断句过细」
# 全是这么卡住的。给它一套动作词汇，问题就能连"怎么修"一起说清楚。
ACTIONS = (
    "replace_text",         # 改英文原文（原有默认）
    "replace_translation",  # 改中文译文
    "mark_noise",           # 移出学习链路（软删除）
    "merge_prev",           # 与上一句合并
    "merge_next",           # 与下一句合并
    "split_at",             # 在 anchor 处拆成两句
    "manual",               # 说不清怎么修，留给人或修复代理
)
# 各 kind 的默认动作：模型没给 action 时按类型兜底，保持旧数据行为不变
_DEFAULT_ACTION = {
    "translation_mismatch": "replace_translation",
    "wrong_word": "replace_text",
    "bad_split": "manual",
    "noise": "mark_noise",
}

_SYSTEM = (
    "你是英语学习素材的字幕质检员。给你一段由 ASR 转写并自动分句的英文字幕及其中文译文，"
    "逐句找出**确有把握**的问题，宁可少报也不要臆测。只报这四类：\n"
    "wrong_word：转写明显听错的词（上下文语义不通、专有名词拼错、同音词误写）。\n"
    "bad_split：断句不当（把一句话拦腰截断，或把两句并成一句）。\n"
    "noise：残留的非语音内容（[Music]、掌声、口播广告词、频道订阅语）。\n"
    "translation_mismatch：中文译文与英文原意不符、漏译、或术语按字面直译错了。\n"
    "输出 JSON：{\"issues\": [{\"ordinal\": 句号, \"kind\": 四类之一, "
    "\"severity\": \"info|warn|error\", \"detail\": \"问题是什么（中文，一句话）\", "
    "\"action\": \"怎么修\", \"suggestion\": \"配合 action 的内容\", "
    "\"anchor\": \"仅 split_at 用\"}]}\n"
    "**action 必须从这些里选**，它决定系统怎么自动修：\n"
    "- replace_text：改英文原文 → suggestion 给完整的新原文\n"
    "- replace_translation：改中文译文 → suggestion 给完整的新译文\n"
    "- mark_noise：这句不是有效语音内容（[Music]、掌声、纯停顿标记、口播广告），"
    "应移出学习链路 → suggestion 留空\n"
    "- merge_prev / merge_next：这句被拦腰截断，应与上/下一句合并 → suggestion 留空\n"
    "- split_at：两句黏成一句，应拆开 → anchor 给第二句开头的原文片段（须与原文完全一致）\n"
    "- manual：你能看出有问题但拿不准怎么改 → suggestion 留空，detail 写清楚疑点\n"
    "宁可选 manual 也不要猜一个错的 suggestion。\n"
    "没有问题就返回 {\"issues\": []}。不要为了凑数而报。"
)


def _clean(raw: object, valid_ordinals: set[int]) -> list[dict]:
    """裁判输出清洗：类型收敛、序号必须落在送审范围内（模型爱编序号）。"""
    out: list[dict] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            ordinal = int(item.get("ordinal"))
        except (TypeError, ValueError):
            continue
        if ordinal not in valid_ordinals:
            continue
        kind = str(item.get("kind") or "").strip()
        detail = str(item.get("detail") or "").strip()
        if kind not in KINDS or not detail:
            continue
        severity = str(item.get("severity") or "warn").strip()
        suggestion = str(item.get("suggestion") or "").strip()
        action = str(item.get("action") or "").strip()
        if action not in ACTIONS:
            action = _DEFAULT_ACTION.get(kind, "manual")
        anchor = str(item.get("anchor") or "").strip()
        # 动作与内容不自洽就降级成 manual，免得端上一个点了必失败的按钮
        if action in ("replace_text", "replace_translation") and not suggestion:
            action = "manual"
        if action == "split_at" and not anchor:
            action = "manual"
        out.append({
            "ordinal": ordinal,
            "kind": kind,
            "severity": severity if severity in SEVERITIES else "warn",
            "detail": detail[:300],
            "suggestion": suggestion[:500] or None,
            "action": action,
            "anchor": anchor[:200] or None,
        })
    return out


def _render(batch: list[dict], context: str) -> str:
    lines = [f"素材背景：{context}"] if context else []
    for row in batch:
        lines.append(f"[{row['ordinal']}] EN: {row['text']}")
        if row.get("text_zh"):
            lines.append(f"      ZH: {row['text_zh']}")
    return "\n".join(lines)


async def _judge(batch: list[dict], context: str, alias: str, sem: asyncio.Semaphore) -> list[dict]:
    valid = {row["ordinal"] for row in batch}
    async with sem:
        try:
            parsed, _model, _ms = await complete_json(alias, _SYSTEM, _render(batch, context))
        except Exception as exc:
            logger.warning("字幕校验批次失败：%s", exc)
            return []
    if isinstance(parsed, str):  # 少数模型会把 JSON 再包一层字符串
        try:
            parsed = json.loads(parsed)
        except json.JSONDecodeError:
            return []
    return _clean((parsed or {}).get("issues"), valid)


async def review(
    sentences: list[dict], context: str = "", alias: str = "explain-standard"
) -> dict:
    """字幕句列表 → {issues, batches, judged}。sentences 需含 ordinal/text[/text_zh]。

    任一批次失败只丢那一批，不影响其余——质检是增强项，不该阻断管线。
    """
    rows = [s for s in sentences if (s.get("text") or "").strip()]
    if not rows:
        return {"issues": [], "batches": 0, "judged": 0}

    batches = [rows[i : i + BATCH] for i in range(0, len(rows), BATCH)]
    sem = asyncio.Semaphore(CONCURRENCY)
    results = await asyncio.gather(
        *(_judge(batch, context, alias, sem) for batch in batches)
    )
    issues = [issue for batch in results for issue in batch]
    # 同一句多条问题保留，但整体截断；error 优先露出
    issues.sort(key=lambda i: (SEVERITIES.index(i["severity"]) * -1, i["ordinal"]))
    return {
        "issues": issues[:MAX_ISSUES],
        "batches": len(batches),
        "judged": len(rows),
        "alias": alias,
    }

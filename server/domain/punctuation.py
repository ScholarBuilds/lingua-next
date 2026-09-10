"""ASR 标点恢复（ADR-007 FR-36/37）。

whisper 的 `condition_on_previous_text` 一旦在某段丢失标点，后续会以无标点前文为
条件持续沿袭，整片退化为小写无标点（5 号视频实测 82% 的段中招）。换更大的模型无效
（large-v3 与 small 的句末标点数 19 vs 17），关掉该参数虽快 40% 却丢 7.7% 的词。

解法是转写后跑一遍 LLM 标点恢复，并用词序列一致性校验兜底：归一化后逐词比对，
不一致的块回退原文。该校验不是形式主义——正是它拦下了 YouTube auto 轨的丢词输出
（7 块仅 1 块通过），从而确定 auto 轨不可用。
"""

import asyncio
import logging
import re

from domain.llm import complete_text

logger = logging.getLogger(__name__)

# 分块上限：按 segment 边界累积，不切断 segment。1600 字符实测单块约 1.5-2s
CHUNK_CHARS = 1600
# 并发块数：纯网络 IO，不占 CPU，可与转写/对齐阶段重叠
CONCURRENCY = 6

_SYSTEM = (
    "You repair punctuation and sentence segmentation in ASR transcripts. Rules: "
    "(1) Output the EXACT same words in the EXACT same order. "
    "(2) Never add, delete, reorder, or substitute any word. "
    "(3) Only insert punctuation (. , ? ! ') and fix capitalization. "
    "(4) ACTIVELY break run-on spoken rambles into complete sentences at semantic "
    "boundaries: aim for sentences of at most ~25 words; long monologues without "
    "pauses MUST be split with periods even if the speaker never paused. "
    "(5) Output only the corrected text, no commentary."
)

_STRIP = ".,!?;:'\"()[]—-"


def normalize_words(text: str) -> list[str]:
    """归一化词序列：小写、去首尾标点，用于一致性校验。"""
    return [w for w in (t.lower().strip(_STRIP) for t in text.split()) if w]


def needs_restore(text: str, min_chars_per_stop: int = 120) -> bool:
    """是否需要标点恢复：句末标点密度过低即判定退化。

    正常英语口语每 40-80 字符一个句末标点；阈值取 120 留足余量，
    避免对本来就正常的转写做无谓调用。
    """
    stops = len(re.findall(r"[.!?]", text))
    if stops == 0:
        return bool(text.strip())
    return len(text) / stops > min_chars_per_stop


def chunk_by_segments(texts: list[str], limit: int = CHUNK_CHARS) -> list[str]:
    """按 segment 边界组块，单块 ≤limit 字符（不切断 segment）。"""
    chunks: list[str] = []
    cur = ""
    for t in texts:
        t = t.strip()
        if not t:
            continue
        if cur and len(cur) + len(t) + 1 > limit:
            chunks.append(cur)
            cur = ""
        cur = f"{cur} {t}".strip()
    if cur:
        chunks.append(cur)
    return chunks


# 二分递归的最小块：再小就切碎了句子，且调用开销占比过高
MIN_SPLIT_CHARS = 400


async def _call_restore(chunk: str, sem: asyncio.Semaphore) -> str | None:
    """调一次 LLM 恢复；返回过了词序列校验的文本，未过或异常返回 None。"""
    async with sem:
        try:
            out = (
                await complete_text(
                    "explain-standard",
                    [{"role": "system", "content": _SYSTEM}, {"role": "user", "content": chunk}],
                    temperature=0,
                )
            ).strip()
        except Exception as exc:
            logger.warning("标点恢复调用失败：%s", exc)
            return None
    if not out:
        return None
    if normalize_words(out) != normalize_words(chunk):
        logger.debug(
            "词序列不一致（原 %d 词 → 出 %d 词）",
            len(normalize_words(chunk)),
            len(normalize_words(out)),
        )
        return None
    return out


def _split_half(chunk: str) -> tuple[str, str] | None:
    """按最接近中点的空白把块二分；无法切分返回 None。"""
    words = chunk.split()
    if len(words) < 4:
        return None
    mid = len(words) // 2
    return " ".join(words[:mid]), " ".join(words[mid:])


async def _restore_chunk(chunk: str, sem: asyncio.Semaphore) -> tuple[str, bool]:
    """恢复单块，三层兜底（FR-39/40/41）。返回 (文本, 是否通过校验)。

    LLM 输出有随机性，一次不过不代表这段救不回来：18 号视频实测 5 块过 3 块，
    未过的两块直接回退原文，留下 1645 字符无标点长段被硬切成 38 个学习句。
    故失败后先重试，再二分成更小块分别恢复——块越小越容易保持词序列一致。
    """
    for _ in range(2):  # 首次 + 重试一次（新请求，不复用上次输出）
        out = await _call_restore(chunk, sem)
        if out is not None:
            return out, True

    half = _split_half(chunk) if len(chunk) > MIN_SPLIT_CHARS else None
    if half is None:
        logger.warning("标点恢复最终失败，回退原文（%d 字符）", len(chunk))
        return chunk, False

    left, right = await asyncio.gather(
        _restore_chunk(half[0], sem), _restore_chunk(half[1], sem)
    )
    # 两半都失败才算整块失败；一半成功也比整块无标点强
    return f"{left[0]} {right[0]}", left[1] or right[1]


async def restore_punctuation(
    texts: list[str], force: bool = False
) -> tuple[str, dict]:
    """转写文本列表 → 标点恢复后的全文 + 统计。

    返回 (full_text, {chunks, passed, failed, restored})；failed 为最终仍未过校验的
    块数，落进轨 meta 供校验脚本报出，不静默留黏连段（FR-41）。

    force=True 绕过"标点密度足够则跳过"的自适应判定，用于人工判断这段标点其实
    有问题时的重跑（FR-76）。
    """
    chunks = chunk_by_segments(texts)
    if not chunks:
        return "", {"chunks": 0, "passed": 0, "failed": 0, "restored": False}

    joined = " ".join(chunks)
    if not force and not needs_restore(joined):
        return joined, {"chunks": len(chunks), "passed": 0, "failed": 0, "restored": False}

    sem = asyncio.Semaphore(CONCURRENCY)
    results = await asyncio.gather(*(_restore_chunk(c, sem) for c in chunks))
    passed = sum(1 for _, ok in results if ok)
    failed = len(results) - passed
    full = " ".join(text for text, _ in results)
    logger.info("标点恢复：%d 块，通过 %d，失败 %d", len(chunks), passed, failed)
    return full, {
        "chunks": len(chunks),
        "passed": passed,
        "failed": failed,
        "restored": passed > 0,
    }

"""跟读比对（ADR-007 FR-33，需求 v3 第 15 节）。

录音经 whisper 转写后与原句做逐词对齐，标出漏读、错读、多读。
不做音素级发音评分——那需要专门的发音评测模型，超出既定边界（BR-03）。

对齐用 LCS 锚定：先求最长公共子序列作为"读对了"的锚点，锚点之间的缺口
按位置一一配对——配得上的算读错，参考侧多出来的算漏读，用户侧多出来的算多读。
与前端听写批改（videoUtils.diffWords）同一算法，口径一致。
"""

import re

_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'-]*")
_STRIP = "'-"


def tokenize(text: str) -> list[str]:
    return _WORD_RE.findall(text)


def _norm(word: str) -> str:
    return word.lower().strip(_STRIP)


def diff_words(reference: str, spoken: str) -> dict:
    """原句 vs 跟读转写 → 逐词批改结果。

    返回 {items: [{word, status, got?}], correct, total, extra, accuracy}，
    status 为 ok（读对）| wrong（读错）| miss（漏读）；extra 为多读词数。
    """
    ref_tokens = tokenize(reference)
    spoken_tokens = tokenize(spoken)
    a = [_norm(w) for w in ref_tokens]
    b = [_norm(w) for w in spoken_tokens]
    n, m = len(a), len(b)

    # LCS 长度表（自后向前，便于回溯时优先匹配）
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            dp[i][j] = dp[i + 1][j + 1] + 1 if a[i] == b[j] else max(dp[i + 1][j], dp[i][j + 1])

    items: list[dict] = []
    extra = 0
    i = j = 0
    ref_gap: list[str] = []
    spoken_gap: list[str] = []

    def flush() -> None:
        """缺口配对：能配上的记读错，参考侧余下记漏读，用户侧余下计多读。"""
        nonlocal extra, ref_gap, spoken_gap
        for k, word in enumerate(ref_gap):
            if k < len(spoken_gap):
                items.append({"word": word, "status": "wrong", "got": spoken_gap[k]})
            else:
                items.append({"word": word, "status": "miss"})
        if len(spoken_gap) > len(ref_gap):
            extra += len(spoken_gap) - len(ref_gap)
        ref_gap, spoken_gap = [], []

    while i < n and j < m:
        if a[i] == b[j]:
            flush()
            items.append({"word": ref_tokens[i], "status": "ok"})
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            ref_gap.append(ref_tokens[i])
            i += 1
        else:
            spoken_gap.append(spoken_tokens[j])
            j += 1
    while i < n:
        ref_gap.append(ref_tokens[i])
        i += 1
    while j < m:
        spoken_gap.append(spoken_tokens[j])
        j += 1
    flush()

    correct = sum(1 for it in items if it["status"] == "ok")
    total = len(ref_tokens)
    return {
        "items": items,
        "correct": correct,
        "total": total,
        "extra": extra,
        "accuracy": round(correct / total * 100) if total else 0,
    }

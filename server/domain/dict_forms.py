"""ECDICT `exchange` 词形变化的解析（FR-508）。

`exchange` 形如 `p:was/3:is/d:been/i:being/s:bes`：`0:` 原形、`1:` 变换类型（`s3`、`dp`
这类多码合写）、其余七个码是具体形态。在这之前全仓只读 `0:` 段（变形 → 原形），
七个形态码没人解析；查词要两个方向都能走，所以收到一处。

`lemma_of` 逐行复刻 web/src/features/reader/WordCard.tsx 的 `lemmaOf`：拆开记按 lemma 寻址，
两边算法不一致的话后台跑出来的结果词卡永远命不中。
"""

# 展示顺序：先动词形态，再形容词级别，最后复数
FORM_ORDER = ("p", "d", "i", "3", "r", "t", "s")
FORM_LABELS = {
    "p": "过去式",
    "d": "过去分词",
    "i": "现在分词",
    "3": "第三人称单数",
    "r": "比较级",
    "t": "最高级",
    "s": "复数",
}


def parse_exchange(exchange: str | None) -> dict[str, str]:
    """`"p:was/3:is"` → `{"p": "was", "3": "is"}`；没有冒号、键或值为空的段跳过，同键后者覆盖。"""
    out: dict[str, str] = {}
    if not exchange:
        return out
    for part in exchange.split("/"):
        idx = part.find(":")
        if idx <= 0:
            continue
        value = part[idx + 1 :]
        if value:
            out[part[:idx]] = value
    return out


def lemma_of(exchange: str | None, word: str) -> str | None:
    """从 exchange 解析原形（"0:xxx" 段），与原词相同则视为没有。"""
    if not exchange:
        return None
    for part in exchange.split("/"):
        idx = part.find(":")
        if idx <= 0:
            continue
        if part[:idx] == "0":
            lemma = part[idx + 1 :]
            return lemma if lemma and lemma != word else None
    return None


def forms_of(word: str, exchange: str | None) -> list[dict]:
    """原形的全部形态，按 `FORM_ORDER`；同一个拼写对应多个码时合成一条（goes = 三单 / 复数）。"""
    parsed = parse_exchange(exchange)
    codes_by_form: dict[str, list[str]] = {}
    for code in FORM_ORDER:
        value = parsed.get(code)
        if not value or value == word:
            continue
        codes_by_form.setdefault(value, []).append(code)
    return [
        {
            "code": codes[0],
            "codes": codes,
            "label": " / ".join(FORM_LABELS[c] for c in codes),
            "word": form,
        }
        for form, codes in codes_by_form.items()
    ]


# 常见屈折后缀回退表：LLM 偶尔给出复数或分词形态，退一步再查一次词典；
# 查词页在词典完全查不到时也用它出候选
FALLBACKS = (
    ("ies", "y"),
    ("es", ""),
    ("s", ""),
    ("ing", ""),
    ("ing", "e"),
    ("ed", ""),
    ("ed", "e"),
)


def lemma_guesses(word: str) -> list[str]:
    out = []
    for suffix, repl in FALLBACKS:
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            out.append(word[: -len(suffix)] + repl)
    return out

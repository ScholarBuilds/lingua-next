"""句法分析：依存 JSON、句内成分着色、构式匹配（模块 14 FR-401、FR-405）。

spaCy 是**新增依赖**——需求文档模块 02 的实现方案表写着「分句/词元用 spaCy」，
但代码里 grep 不到任何 `spacy` import，实际一直是 pysbd + 正则。这里第一次真的引入。

三条边界：

- 服务端**只返回 JSON**，绝不 `displacy.render` 直出 SVG（FR-405d）：
  那是给语言学家看的静态弧线图，前端没有交互余地，且直出 HTML 有 XSS 风险。
- 依存标签是 ClearNLP/OntoNotes 风格（`dobj/pobj/prep/attr`）**不是 UD**
  （`obj/obl/case`）——网上的 UD 中文对照表不能直接用，45 条映射自己写（FR-405e）。
- 结构分析（这里）与讲解（LLM）职责分离，冲突以 LLM 为准并记日志（BR-96）。
"""

from __future__ import annotations

import logging
import threading

logger = logging.getLogger(__name__)

MODEL = "en_core_web_sm"
_nlp = None
_lock = threading.Lock()

# UTF-16 码元偏移与 JS 一致（核心原则 3）。BMP 外字符（emoji）在 Python 里算 1，
# 在 JS 里算 2，正文里出现就会整段错位——这里按码元数重算。
def _u16_len(s: str) -> int:
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in s)


def get_nlp():
    """进程级单例。en_core_web_sm 约 12MB，但每次 load 要 1-2 秒。"""
    global _nlp
    if _nlp is None:
        with _lock:
            if _nlp is None:
                import spacy

                _nlp = spacy.load(MODEL)
                logger.info("spaCy %s 已加载", MODEL)
    return _nlp


# ─────────────── 45 条依存标签中文映射（FR-405e） ───────────────

DEP_ZH: dict[str, str] = {
    "ROOT": "谓语核心",
    "acl": "名词的修饰从句",
    "acomp": "表语形容词",
    "advcl": "状语从句",
    "advmod": "状语",
    "agent": "被动句的施事",
    "amod": "定语形容词",
    "appos": "同位语",
    "attr": "表语",
    "aux": "助动词",
    "auxpass": "被动助动词",
    "case": "格标记",
    "cc": "并列连词",
    "ccomp": "宾语从句",
    "compound": "复合成分",
    "conj": "并列成分",
    "csubj": "主语从句",
    "csubjpass": "被动主语从句",
    "dative": "间接宾语",
    "dep": "未定关系",
    "det": "限定词",
    "dobj": "直接宾语",
    "expl": "形式主语",
    "intj": "感叹词",
    "mark": "从句引导词",
    "meta": "元信息",
    "neg": "否定词",
    "nmod": "名词修饰语",
    "npadvmod": "名词作状语",
    "nsubj": "主语",
    "nsubjpass": "被动主语",
    "nummod": "数词修饰",
    "oprd": "宾语补足语",
    "parataxis": "并置成分",
    "pcomp": "介词的从句宾语",
    "pobj": "介词宾语",
    "poss": "所有格",
    "preconj": "前置连词",
    "predet": "前置限定词",
    "prep": "介词",
    "prt": "动词小品词",
    "punct": "标点",
    "quantmod": "数量修饰",
    "relcl": "定语从句",
    "xcomp": "非限定补足语",
}

POS_ZH: dict[str, str] = {
    "ADJ": "形容词", "ADP": "介词", "ADV": "副词", "AUX": "助动词",
    "CCONJ": "并列连词", "DET": "限定词", "INTJ": "感叹词", "NOUN": "名词",
    "NUM": "数词", "PART": "小品词", "PRON": "代词", "PROPN": "专有名词",
    "PUNCT": "标点", "SCONJ": "从属连词", "SYM": "符号", "VERB": "动词", "X": "其他",
}  # fmt: skip

TAG_ZH: dict[str, str] = {
    "VB": "动词原形", "VBD": "过去式", "VBG": "现在分词/动名词", "VBN": "过去分词",
    "VBP": "一般现在时（非三单）", "VBZ": "一般现在时三单", "MD": "情态动词",
    "NN": "名词单数", "NNS": "名词复数", "NNP": "专有名词", "NNPS": "专有名词复数",
    "JJ": "形容词", "JJR": "比较级", "JJS": "最高级",
    "RB": "副词", "RBR": "副词比较级", "RBS": "副词最高级",
    "PRP": "人称代词", "PRP$": "物主代词", "WP": "疑问代词", "WP$": "疑问物主代词",
    "WDT": "疑问限定词", "WRB": "疑问副词", "DT": "限定词", "IN": "介词/从属连词",
    "CC": "并列连词", "CD": "数词", "TO": "不定式 to", "RP": "动词小品词",
    "EX": "存在句 there", "POS": "所有格标记", "UH": "感叹词", "FW": "外来词",
}  # fmt: skip


# ─────────────── 依存 JSON（FR-405d） ───────────────


def dep_las() -> float:
    """当前实装模型的依存准确率（LAS），从模型 meta 读，不写死。

    三处路由/前端曾各自硬编码 "DEP_LAS 89.87"，那是 en_core_web_sm 旧版本的数；
    升到 3.8.0 后没人跟着改，展示给用户的一直是个不属于当前模型的指标（实测 89.92）。
    """
    perf = get_nlp().meta.get("performance") or {}
    return round(float(perf.get("dep_las", 0.0)) * 100, 2)


def parse_deps(text: str) -> dict:
    """依存分析 → 纯 JSON。格式参考 `displacy.parse_deps`，但自己组装。

    `arcs` 的 `start` 恒小于 `end`，`dir` 标出箭头指向——前端画弧线要这个口径。
    """
    doc = get_nlp()(text)
    words = []
    offset = 0
    for t in doc:
        start = offset
        offset = start + _u16_len(t.text_with_ws)
        words.append(
            {
                "i": t.i,
                "text": t.text,
                "lemma": t.lemma_,
                "pos": t.pos_,
                "pos_zh": POS_ZH.get(t.pos_, t.pos_),
                "tag": t.tag_,
                "tag_zh": TAG_ZH.get(t.tag_, t.tag_),
                "dep": t.dep_,
                "dep_zh": DEP_ZH.get(t.dep_, t.dep_),
                "head": t.head.i,
                "morph": str(t.morph) or None,
                # UTF-16 码元偏移，前端可直接 slice
                "start": start,
                "end": start + _u16_len(t.text),
                "is_punct": t.is_punct,
            }
        )
    arcs = []
    for t in doc:
        if t.head.i == t.i or t.dep_ == "punct":
            continue
        lo, hi = sorted((t.i, t.head.i))
        arcs.append(
            {
                "start": lo,
                "end": hi,
                "label": t.dep_,
                "label_zh": DEP_ZH.get(t.dep_, t.dep_),
                "dir": "left" if t.i < t.head.i else "right",
            }
        )
    return {"text": text, "words": words, "arcs": arcs}


# ─────────────── 句内成分着色（FR-405a） ───────────────

# 依存标签 → 成分角色。默认视图只用这五色，多了就成了给语言学家看的图
ROLE_BY_DEP = {
    "nsubj": "subject", "nsubjpass": "subject", "csubj": "subject",
    "csubjpass": "subject", "expl": "subject",
    "dobj": "object", "dative": "object", "attr": "object",
    "acomp": "object", "oprd": "object", "pobj": "object",
    "advmod": "adverbial", "npadvmod": "adverbial", "prep": "adverbial",
    "advcl": "clause", "relcl": "clause", "ccomp": "clause",
    "xcomp": "clause", "acl": "clause", "pcomp": "clause",
}
ROLE_ZH = {
    "subject": "主语",
    "predicate": "谓语",
    "object": "宾语",
    "adverbial": "状语",
    "clause": "从句",
}
PREDICATE_DEPS = {"aux", "auxpass", "neg", "prt"}


def constituents(text: str, deps: dict | None = None) -> dict:
    """主/谓/宾/状 + 可折叠从句块。纯 CSS + span 就能渲染，零渲染成本。

    从句优先：一个词若落在从句子树里，它属于从句而不是外层的宾语——
    这样「从句折叠成一个色块」才折得干净。

    `deps` 传进来就复用，不传才自己算。调用方多半两个都要
    （路由里 `constituents` + `parse_deps` 各一次，本函数内部原先又调一次
    `parse_deps`，同一句被完整解析三遍，182 字符实测 21.7ms 里约 14ms 是白跑的）。
    """
    doc = get_nlp()(text)
    spans: list[dict] = []
    taken: set[int] = set()

    def claim(indices: set[int], role: str, head_i: int) -> None:
        fresh = {i for i in indices if i not in taken and not doc[i].is_punct}
        if not fresh:
            return
        taken.update(fresh)
        lo, hi = min(fresh), max(fresh)
        # 子树可能不连续（并列插入），按首尾成块并记录真实成员
        spans.append(
            {
                "role": role,
                "role_zh": ROLE_ZH[role],
                "head": head_i,
                "token_start": lo,
                "token_end": hi,
                "tokens": sorted(fresh),
            }
        )

    # 1) 从句先占位
    for t in doc:
        if ROLE_BY_DEP.get(t.dep_) == "clause":
            claim({x.i for x in t.subtree}, "clause", t.i)

    # 2) 谓语：ROOT 动词 + 挂在它上面的助动词/否定词/小品词
    roots = [t for t in doc if t.dep_ == "ROOT"]
    for root in roots:
        core = {root.i} | {c.i for c in root.children if c.dep_ in PREDICATE_DEPS}
        claim(core, "predicate", root.i)

    # 3) 主语 / 宾语 / 状语，按子树整体标
    for t in doc:
        role = ROLE_BY_DEP.get(t.dep_)
        if role in (None, "clause"):
            continue
        if t.dep_ == "pobj" and t.head.dep_ == "prep":
            continue  # 介词短语整体已由 prep 领走
        claim({x.i for x in t.subtree}, role, t.i)

    spans.sort(key=lambda s: (s["token_start"], s["token_end"]))
    words = (deps if deps is not None else parse_deps(text))["words"]
    return {"text": text, "words": words, "spans": spans, "legend": ROLE_ZH}


# ─────────────── 从句边界（发音评测第 0 层用，FR-398c） ───────────────


def clause_boundaries(text: str, n_words: int) -> list[int]:
    """返回「该停顿」的词下标（该词之后是边界）。

    标点是最强信号，spaCy 额外认出无标点的从句起点与并列连词前。
    返回的是**词下标**，与调用方按空格切出来的词序列对齐——
    所以只在词数一致时才给结果，对不上宁可不给（宁缺毋滥）。
    """
    doc = get_nlp()(text)
    words = [t for t in doc if not t.is_space]
    # spaCy 会把标点切成独立 token，调用方的词序列不含标点，两边先对齐
    content = [t for t in words if not t.is_punct]
    if len(content) != n_words:
        logger.debug("从句边界词数不符（%d vs %d），跳过", len(content), n_words)
        return []
    pos_of = {t.i: k for k, t in enumerate(content)}
    out: set[int] = set()
    for t in words:
        if t.is_punct and t.text in ",;:.!?—":
            prev = [c for c in content if c.i < t.i]
            if prev:
                out.add(pos_of[prev[-1].i])
        elif t.dep_ in ("mark", "cc") or (t.dep_ == "advcl" and t.i > 0):
            k = pos_of.get(t.i)
            if k:
                out.add(k - 1)
    return sorted(out)


# ─────────────── 构式匹配（FR-401） ───────────────

_matcher = None
_matcher_keys: tuple[str, ...] = ()


def build_matcher(patterns: dict[str, list]) -> object:
    """按传入的规则集构建 DependencyMatcher。规则来自 `grammar_construction` 表。

    一个 key 可以带**多个候选子图**：同一个语法结构在不同复杂度的句子里
    挂法会变（反义疑问句在简单句里 tag 是 ROOT，主句一复杂就变成 ROOT 的 conj）。
    存成节点列表的列表即表示多选一，单个节点列表仍按原样处理。
    """
    from spacy.matcher import DependencyMatcher

    m = DependencyMatcher(get_nlp().vocab)
    for key, pattern in patterns.items():
        # 节点列表 vs 节点列表的列表：看第一项是不是 dict
        alts = pattern if pattern and isinstance(pattern[0], list) else [pattern]
        try:
            m.add(key, alts)
        except Exception as exc:  # noqa: BLE001 - 单条规则写错不该拖垮整批
            logger.warning("构式规则 %s 无效，已跳过：%s", key, exc)
    return m


# 句子多长开始明显掉精度。spaCy 的 DEP_LAS 是在混合长度语料上报的 89.87，
# 长句上实际更低；这两个数是分档的界，不是测出来的阈值
CONF_LEN_OK, CONF_LEN_BAD = 25, 45


def match_confidence(doc, token_ids: list[int]) -> float:
    """这条构式命中有多可信（0-100）。

    > [!warning] 这是启发式排序值，不是概率
    >
    > 没有标注数据能校准成概率，所以这个数只用来**排序与分档**，
    > 界面不显示百分比。BR-97 要求低置信度的命中只画成分树、不指概念——
    > 指错概念比不指更糟：学习者会照着一个不相干的讲解去理解句子。
    >
    > 三个扣分项都对应 spaCy 自己暴露出来的不确定信号：

    | 信号 | 为什么它指示不可信 |
    | --- | --- |
    | 所在句有多个 ROOT | 一句话没被解析成一棵树，是真的解析失败 |
    | 所在句过长 | 依存解析在长句上误差累积 |
    | 命中区间内有 `dep` 关系 | `dep` 是 spaCy 的兜底标签，意思就是「这条关系没认出来」 |

    **三个信号都在「命中所在的那一句」里算，不在整段里算**。
    首版按整段算 ROOT 数，结果「不止一句话」被当成了「解析失败」——
    粘两句正常英文进来就掉 30 分，而真正解析崩掉的残句反而可能只有一个 ROOT。
    信号指向的东西整个是错的。
    """
    sent = doc
    if token_ids:
        try:
            sent = doc[min(token_ids)].sent
        except (ValueError, IndexError):
            sent = doc
    score = 100.0
    roots = sum(1 for t in sent if t.dep_ == "ROOT")
    if roots != 1:
        score -= 30
    n = len(sent)
    if n > CONF_LEN_BAD:
        score -= 25
    elif n > CONF_LEN_OK:
        score -= 25 * (n - CONF_LEN_OK) / (CONF_LEN_BAD - CONF_LEN_OK)
    if token_ids:
        lo, hi = min(token_ids), max(token_ids)
        unknown = sum(1 for t in doc[lo : hi + 1] if t.dep_ == "dep")
        score -= min(30, unknown * 15)
    return round(max(0.0, min(100.0, score)), 1)


def match_constructions(text: str, matcher) -> list[dict]:
    """在一句话里找出所有命中的构式，返回 UTF-16 偏移的片段。"""
    doc = get_nlp()(text)
    out: list[dict] = []
    seen: set[tuple[str, int, int]] = set()
    for match_id, token_ids in matcher(doc):
        key = doc.vocab.strings[match_id]
        if not token_ids:
            continue
        lo, hi = min(token_ids), max(token_ids)
        span = doc[lo : hi + 1]
        sig = (key, span.start_char, span.end_char)
        if sig in seen:
            continue
        seen.add(sig)
        out.append(
            {
                "key": key,
                "char_start": _u16_len(text[: span.start_char]),
                "char_end": _u16_len(text[: span.end_char]),
                "snippet": span.text,
                "tokens": sorted(token_ids),
                "confidence": match_confidence(doc, list(token_ids)),
            }
        )
    return out

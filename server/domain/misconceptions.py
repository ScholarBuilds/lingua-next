"""误区目录（FR-402）：把「答错」建模成可命名的具体误区。

领域模型抄 [oppia](https://github.com/oppia/oppia) 的 `state_domain`：

```
答案规则  →  命中某个误区  →  定向反馈  →  跳转补救内容  →  再练对应题
```

为什么值得比「LLM 写段评语」多做这一层：**误区是有限的、可枚举的、可统计的**。
它能回答「你这个错误犯过 5 次」和「这类错误该补哪一课」，LLM 的自由文本回答不了。

`errant_types` 是与 ERRANT 55 类标签的双向映射（FR-402c）：写作纠错命中的 ERRANT
类型能定位到误区，误区能反查该补哪个语法点。**不自建错误分类体系**（BR-98）。
"""

from __future__ import annotations

from dataclasses import dataclass, field

# ERRANT 的完整标签集合，用于校验映射里没有拼错的类型名（BR-98）
ERRANT_OPS = ("M", "R", "U")
ERRANT_CATS = (
    "ADJ", "ADJ:FORM", "ADV", "CONJ", "CONTR", "DET", "MORPH", "NOUN", "NOUN:INFL",
    "NOUN:NUM", "NOUN:POSS", "ORTH", "OTHER", "PART", "PREP", "PRON", "PUNCT",
    "SPELL", "VERB", "VERB:FORM", "VERB:INFL", "VERB:SVA", "VERB:TENSE", "WO",
)  # fmt: skip
ERRANT_TYPES = frozenset(
    [f"{op}:{cat}" for op in ERRANT_OPS for cat in ERRANT_CATS] + ["UNK", "R:WO"]
)


@dataclass(frozen=True)
class MisconceptionSpec:
    code: str
    name: str
    description: str
    feedback: str
    errant_types: tuple[str, ...]
    # 补救语法点的 CEFR-J shorthand_code 前缀，seed 时解析成 id
    remedial_code: str | None = None
    tags: tuple[str, ...] = field(default_factory=tuple)


CATALOG: list[MisconceptionSpec] = [
    # ── 动词形态 ──
    MisconceptionSpec(
        "aux-then-past", "助动词后仍用过去式",
        "did/didn't 已经承担了时态，后面的实义动词却仍用过去式。",
        "时态已经由 did 承担，后面的动词恢复原形：didn't went → didn't go。",
        ("R:VERB:TENSE", "R:VERB:FORM"),
        "TA.PAST.do", ("时态与体",),
    ),
    MisconceptionSpec(
        "sva-third-person", "第三人称单数漏 -s",
        "主语是第三人称单数时，一般现在时的动词要加 -s/-es。",
        "主语是他/她/它或单数名词时，动词要加 -s：he go → he goes。",
        ("R:VERB:SVA",),
        "TA.PRESENT.does", ("时态与体",),
    ),
    MisconceptionSpec(
        "sva-plural-s", "复数主语误加 -s",
        "主语是复数却给动词加了第三人称单数的 -s。",
        "复数主语用动词原形：they goes → they go。",
        ("R:VERB:SVA",),
        "TA.PRESENT.do", ("时态与体",),
    ),
    MisconceptionSpec(
        "past-tense-missing", "该用过去式却用了现在式",
        "有明确的过去时间标记，动词却没变过去式。",
        "yesterday / last week 这类时间词要求过去式：go → went。",
        ("R:VERB:TENSE",),
        "TA.PAST.do", ("时态与体",),
    ),
    MisconceptionSpec(
        "perfect-vs-past", "现在完成与一般过去混用",
        "带具体过去时间点的句子用了现在完成时，或指经历却用了一般过去。",
        "有具体过去时间点用一般过去；讲经历、讲对现在的影响用现在完成。",
        ("R:VERB:TENSE",),
        "TA.PRPF.AFF", ("时态与体",),
    ),
    MisconceptionSpec(
        "modal-then-inflected", "情态动词后动词未用原形",
        "can/must/should 之后的动词加了 -s 或变成了过去式。",
        "情态动词后一律用动词原形：can goes → can go。",
        ("R:VERB:FORM",),
        "MD.can.AFF", ("情态动词",),
    ),
    MisconceptionSpec(
        "to-infinitive-form", "to 之后未用动词原形",
        "不定式的 to 后面用了 -ing 或过去式。",
        "to 引导不定式时后接原形：to going → to go。",
        ("R:VERB:FORM",),
        "TO.OBJ", ("非谓语动词",),
    ),
    MisconceptionSpec(
        "gerund-after-prep-missing", "介词后用了动词原形",
        "介词后面应该用动名词，却用了原形或不定式。",
        "介词后接 -ing：good at draw → good at drawing。",
        ("R:VERB:FORM",),
        "VG.PREP", ("非谓语动词",),
    ),
    MisconceptionSpec(
        "passive-missing-be", "被动语态漏了 be",
        "只写了过去分词，没有配 be 动词。",
        "被动语态是 be + 过去分词，be 不能省：the door closed → the door was closed。",
        ("M:VERB", "M:VERB:FORM"),
        "PASS.PRESENT", ("被动语态",),
    ),
    MisconceptionSpec(
        "passive-wrong-participle", "被动语态用了过去式而非过去分词",
        "be 后面接了动词过去式而不是过去分词。",
        "be 后要用过去分词：was wrote → was written。",
        ("R:VERB:FORM",),
        "PASS.PAST", ("被动语态",),
    ),
    MisconceptionSpec(
        "progressive-missing-be", "进行时漏了 be",
        "只写了 -ing 形式，没有配 be 动词。",
        "进行时是 be + -ing：I working → I am working。",
        ("M:VERB", "M:VERB:FORM"),
        "TA.PRPRG.AFF", ("时态与体",),
    ),
    MisconceptionSpec(
        "double-past", "一句里重复标记过去",
        "助动词与实义动词同时用了过去形式。",
        "过去标记只能出现一次：did went → did go。",
        ("R:VERB:TENSE", "R:VERB:FORM"),
        "TA.PAST.do", ("时态与体",),
    ),
    # ── 名词与限定词 ──
    MisconceptionSpec(
        "plural-missing", "可数名词复数漏 -s",
        "数量大于一却用了单数形式。",
        "可数名词复数要加 -s/-es：three book → three books。",
        ("R:NOUN:NUM", "M:NOUN:NUM"),
        "DT.pl", ("限定词与数量",),
    ),
    MisconceptionSpec(
        "uncountable-plural", "不可数名词误加复数",
        "information/advice/equipment 这类不可数名词被加了 -s。",
        "不可数名词没有复数形式：informations → information。",
        ("R:NOUN:NUM", "U:NOUN:NUM"),
        "QUANT.much", ("限定词与数量",),
    ),
    MisconceptionSpec(
        "article-missing", "漏冠词",
        "可数名词单数前没有 a/an/the。",
        "单数可数名词前必须有限定词：I bought book → I bought a book。",
        ("M:DET",),
        "DT.a", ("限定词与数量",),
    ),
    MisconceptionSpec(
        "article-extra", "多余冠词",
        "在专有名词、不可数名词或复数泛指前多加了冠词。",
        "泛指的复数与不可数名词前不加冠词：the informations → information。",
        ("U:DET",),
        "DT.a", ("限定词与数量",),
    ),
    MisconceptionSpec(
        "a-vs-an", "a / an 用反",
        "按拼写而不是按读音选择 a 或 an。",
        "看**读音**不看字母：an hour（h 不发音）、a university（读 /juː/）。",
        ("R:DET",),
        "DT.a", ("限定词与数量",),
    ),
    MisconceptionSpec(
        "the-vs-zero", "定冠词该用未用",
        "已知信息或唯一事物前漏了 the。",
        "上文提过、双方都知道、世上唯一的东西前用 the。",
        ("M:DET", "R:DET"),
        "DT.the", ("限定词与数量",),
    ),
    MisconceptionSpec(
        "possessive-form", "所有格写法错误",
        "'s 与 s' 混用，或漏了撇号。",
        "单数加 's，复数以 s 结尾只加 '：the boys' books。",
        ("R:NOUN:POSS", "M:NOUN:POSS"),
        "PGEN.my", ("代词",),
    ),
    # ── 代词 ──
    MisconceptionSpec(
        "pronoun-case", "人称代词主宾格混用",
        "该用主格的位置用了宾格，或反之。",
        "作主语用 I/he/she/they，作宾语用 me/him/her/them。",
        ("R:PRON",),
        "PP.I_am", ("代词",),
    ),
    MisconceptionSpec(
        "pronoun-agreement", "代词与先行词不一致",
        "代词的数或性与它指代的名词不匹配。",
        "代词要与先行词的数一致：every student … their → his or her（或把主语改复数）。",
        ("R:PRON",),
        "PIND.everyone", ("代词",),
    ),
    MisconceptionSpec(
        "reflexive-misuse", "反身代词误用",
        "在该用宾格的位置用了 myself/himself。",
        "只有主语和宾语是同一人时才用反身代词。",
        ("R:PRON",),
        "PREFL.myself", ("代词",),
    ),
    # ── 介词与连词 ──
    MisconceptionSpec(
        "prep-time", "时间介词用错",
        "in/on/at 的时间用法混淆。",
        "at 用于钟点、on 用于具体某天、in 用于月份年份与较长时段。",
        ("R:PREP",),
        "IN.PREP", ("介词",),
    ),
    MisconceptionSpec(
        "prep-extra", "多余介词",
        "及物动词后多加了介词。",
        "discuss / enter / marry 后面直接跟宾语，不加介词。",
        ("U:PREP",),
        "IN.PREP", ("介词",),
    ),
    MisconceptionSpec(
        "prep-missing", "漏介词",
        "需要介词的搭配漏掉了介词。",
        "listen 后要加 to、depend 后要加 on。",
        ("M:PREP",),
        "IN.PREP", ("介词",),
    ),
    MisconceptionSpec(
        "although-but", "although 与 but 连用",
        "汉语「虽然…但是…」的直译，英语里两个连词只能留一个。",
        "although 与 but 只能用一个：Although it rained, we went（去掉 but）。",
        ("U:CONJ", "R:CONJ"),
        "CL_after.IN", ("连词与从句",),
    ),
    MisconceptionSpec(
        "because-so", "because 与 so 连用",
        "汉语「因为…所以…」的直译。",
        "because 与 so 只能用一个。",
        ("U:CONJ", "R:CONJ"),
        "CC.so", ("连词与从句",),
    ),
    # ── 句法结构 ──
    MisconceptionSpec(
        "word-order-adverb", "状语位置不当",
        "频度副词或时间状语放错了位置。",
        "频度副词放在实义动词前、be 动词后：I always am → I am always。",
        ("R:WO",),
        "RB.freq", ("副词",),
    ),
    MisconceptionSpec(
        "indirect-question-inversion", "间接疑问句用了疑问语序",
        "从句里仍然把助动词提到主语前面。",
        "间接疑问句用陈述语序：I don't know where does he live → where he lives。",
        ("R:WO",),
        "INDQ.know", ("间接引语",),
    ),
    MisconceptionSpec(
        "there-be-agreement", "there be 的数不一致",
        "there is/are 没有跟随后面的名词。",
        "be 的单复数看它后面的名词：There is many books → There are many books。",
        ("R:VERB:SVA",),
        "EX.PRESENT", ("there be 句型",),
    ),
    MisconceptionSpec(
        "double-negative", "双重否定",
        "一个否定句里同时用了 not 和 no/nothing/never。",
        "英语一个否定句只留一个否定词：didn't see nothing → didn't see anything。",
        ("R:OTHER", "U:ADV"),
        "TA.PRESENT.do.NEG", ("时态与体",),
    ),
    MisconceptionSpec(
        "run-on-comma", "逗号连接两个完整句",
        "两个独立句子只用逗号连接，没有连词或句号。",
        "两个完整句之间要用句号、分号或并列连词，不能只用逗号。",
        ("R:PUNCT", "M:CONJ"),
        "CC.and", ("连词与从句",),
    ),
    MisconceptionSpec(
        "adj-vs-adv", "形容词与副词混用",
        "该用副词修饰动词的位置用了形容词。",
        "修饰动词用副词：He runs quick → He runs quickly。",
        ("R:ADJ", "R:ADV", "R:MORPH"),
        "RBDEG.enough", ("副词",),
    ),
    MisconceptionSpec(
        "comparative-double", "比较级重复标记",
        "同时用了 more 和 -er。",
        "more 与 -er 只能用一个：more taller → taller。",
        ("R:ADJ:FORM",),
        "COMP.than", ("比较与级",),
    ),
    MisconceptionSpec(
        "spelling", "拼写错误",
        "词形拼错，与语法结构无关。",
        "拼写问题，语法结构本身没错。",
        ("R:SPELL", "R:ORTH"),
        None, ("拼写",),
    ),
    MisconceptionSpec(
        "contraction", "缩写形式错误",
        "its/it's、your/you're 这类同音异形混用。",
        "it's = it is；its 是物主代词，没有撇号。",
        ("R:CONTR", "R:ORTH"),
        None, ("拼写",),
    ),
]

BY_CODE = {m.code: m for m in CATALOG}

# ERRANT 类型 → 候选误区（一个类型可能对应多个误区，判定时结合上下文选）
BY_ERRANT: dict[str, list[str]] = {}
for _m in CATALOG:
    for _t in _m.errant_types:
        BY_ERRANT.setdefault(_t, []).append(_m.code)

# 写错的类型名不会报错、只会永远匹配不上，所以在导入期就校验
_bad = {t for m in CATALOG for t in m.errant_types if t not in ERRANT_TYPES}
assert not _bad, f"误区里出现了 ERRANT 没有的类型：{sorted(_bad)}"

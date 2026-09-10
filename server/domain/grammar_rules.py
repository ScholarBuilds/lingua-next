"""构式识别规则（FR-401a）：spaCy DependencyMatcher 模式。

**只写高频构式，不追全覆盖**。EGP 有 1240 条，CEFR-J 有 501 条，但 30-50 条高频
已覆盖日常阅读的绝大部分，长尾的投入产出比断崖式下降（模块 14 §10）。
语义细腻的长尾交给 LLM 兜底（FR-401c）。

每条规则绑一个 CEFR-J `shorthand_code`。绑不上的规则在 seed 时会报出来，
不静默丢——「规则跑了但没挂到语法点上」比没有规则更难查。

DependencyMatcher 的模式是**依存子图**不是词序列：`REL_OP` 里 `>` 是直接子节点、
`>>` 是任意后代、`<` 是父节点、`.` 是紧邻的下一个词。
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Construction:
    key: str
    point_code: str  # 绑定的 CEFR-J shorthand_code
    description: str
    pattern: list[dict]
    example: str  # 自检用：seed 时会验证这句能被本规则命中
    tags: tuple[str, ...] = field(default_factory=tuple)


# 反义疑问句附加部分能用的主语，封闭类
TAG_SUBJECTS = ["i", "you", "he", "she", "it", "we", "they", "there", "one"]
_TAG_SUBJ_ATTRS = {"DEP": {"IN": ["nsubj", "expl", "advmod"]}, "LOWER": {"IN": TAG_SUBJECTS}}


def _anchor(rid: str, attrs: dict) -> dict:
    return {"RIGHT_ID": rid, "RIGHT_ATTRS": attrs}


def _child(left: str, rid: str, attrs: dict, op: str = ">") -> dict:
    return {"LEFT_ID": left, "REL_OP": op, "RIGHT_ID": rid, "RIGHT_ATTRS": attrs}


RULES: list[Construction] = [
    # ── 时态与体 ──
    Construction(
        "present-perfect", "TA.PRPF.AFF", "现在完成时：have/has + 过去分词",
        [
            _anchor("v", {"TAG": "VBN"}),
            # 限定 VBZ/VBP，否则 had known 会同时命中现在完成与过去完成
            _child("v", "aux", {"DEP": "aux", "LEMMA": "have", "TAG": {"IN": ["VBZ", "VBP"]}}),
        ],
        "She has finished her homework.", ("时态与体",),
    ),
    Construction(
        "present-perfect-progressive", "TA.PRPFPRG.AFF",
        "现在完成进行时：have/has been + 现在分词",
        [
            _anchor("v", {"TAG": "VBG"}),
            _child("v", "have", {"DEP": "aux", "LEMMA": "have", "TAG": {"IN": ["VBZ", "VBP"]}}),
            _child("v", "been", {"DEP": "aux", "LEMMA": "be", "TAG": "VBN"}),
        ],
        "They have been waiting for an hour.", ("时态与体",),
    ),
    Construction(
        "past-perfect", "TA.PSPF.AFF", "过去完成时：had + 过去分词",
        [
            _anchor("v", {"TAG": "VBN"}),
            _child("v", "aux", {"DEP": "aux", "LEMMA": "have", "TAG": "VBD"}),
        ],
        "He had left before I arrived.", ("时态与体",),
    ),
    Construction(
        "present-progressive", "TA.PRPRG.AFF", "现在进行时：am/is/are + 现在分词",
        [
            _anchor("v", {"TAG": "VBG"}),
            _child("v", "aux", {"DEP": "aux", "LEMMA": "be", "TAG": {"IN": ["VBZ", "VBP"]}}),
        ],
        "She is reading a book.", ("时态与体",),
    ),
    Construction(
        "past-progressive", "TA.PSPRG.AFF", "过去进行时：was/were + 现在分词",
        [
            _anchor("v", {"TAG": "VBG"}),
            _child("v", "aux", {"DEP": "aux", "LEMMA": "be", "TAG": "VBD"}),
        ],
        "They were playing football.", ("时态与体",),
    ),
    Construction(
        "future-will", "TA.FUT.will.AFF", "将来时：will + 动词原形",
        [
            _anchor("v", {"TAG": "VB"}),
            _child("v", "aux", {"DEP": "aux", "LOWER": {"IN": ["will", "'ll"]}}),
        ],
        "I will call you tomorrow.", ("时态与体",),
    ),
    Construction(
        "going-to", "TA.FUT.begoing.AFF", "be going to + 动词原形",
        [
            _anchor("go", {"LEMMA": "go", "TAG": "VBG"}),
            _child("go", "aux", {"DEP": "aux", "LEMMA": "be"}),
            _child("go", "v", {"DEP": "xcomp", "TAG": "VB"}),
        ],
        "It is going to rain.", ("时态与体",),
    ),
    Construction(
        "used-to", "MD.used_to", "used to + 动词原形（过去习惯）",
        [
            _anchor("used", {"LOWER": "used"}),
            _child("used", "v", {"DEP": "xcomp", "TAG": "VB"}),
        ],
        "I used to live in Beijing.", ("情态动词",),
    ),
    # ── 被动语态 ──
    Construction(
        "passive-simple", "PASS.PRESENT", "被动语态：be + 过去分词",
        [
            _anchor("v", {"TAG": "VBN"}),
            _child("v", "auxp", {"DEP": "auxpass"}),
        ],
        "The window was broken by the storm.", ("被动语态",),
    ),
    Construction(
        "passive-with-agent", "PASS.PAST", "被动语态带 by 施事",
        [
            _anchor("v", {"TAG": "VBN"}),
            _child("v", "auxp", {"DEP": "auxpass"}),
            _child("v", "by", {"DEP": "agent"}),
        ],
        "The letter was written by my father.", ("被动语态",),
    ),
    Construction(
        "passive-modal", "PASS.MD", "情态动词被动：can/must/should + be + 过去分词",
        [
            _anchor("v", {"TAG": "VBN"}),
            _child("v", "auxp", {"DEP": "auxpass"}),
            _child("v", "md", {"DEP": "aux", "TAG": "MD"}),
        ],
        "This problem can be solved easily.", ("被动语态",),
    ),
    # ── 情态动词 ──
    Construction(
        "modal-can", "MD.can.AFF", "can / could 表能力或可能",
        [
            _anchor("v", {"POS": "VERB"}),
            _child("v", "md", {"DEP": "aux", "LOWER": {"IN": ["can", "could"]}}),
        ],
        "She can swim very well.", ("情态动词",),
    ),
    Construction(
        "modal-should", "MD.should.AFF", "should 表建议或应该",
        [
            _anchor("v", {"POS": "VERB"}),
            _child("v", "md", {"DEP": "aux", "LOWER": "should"}),
        ],
        "You should see a doctor.", ("情态动词",),
    ),
    Construction(
        "modal-must", "MD.must.AFF", "must 表必须或推测",
        [
            _anchor("v", {"POS": "VERB"}),
            _child("v", "md", {"DEP": "aux", "LOWER": "must"}),
        ],
        "You must finish it today.", ("情态动词",),
    ),
    Construction(
        "modal-may-might", "MD.may.AFF", "may / might 表可能或许可",
        [
            _anchor("v", {"POS": "VERB"}),
            _child("v", "md", {"DEP": "aux", "LOWER": {"IN": ["may", "might"]}}),
        ],
        "It may rain later.", ("情态动词",),
    ),
    Construction(
        "had-better", "MD.had_better", "had better + 动词原形",
        [
            _anchor("v", {"TAG": "VB"}),
            _child("v", "had", {"DEP": "aux", "LOWER": {"IN": ["had", "'d"]}}),
            _child("v", "better", {"DEP": "advmod", "LOWER": "better"}),
        ],
        "You had better go now.", ("情态动词",),
    ),
    # ── 非谓语动词 ──
    Construction(
        "to-infinitive-purpose", "TO.ADV", "不定式作目的状语",
        [
            _anchor("v", {"TAG": "VB", "DEP": "advcl"}),
            _child("v", "to", {"DEP": "aux", "LOWER": "to"}),
        ],
        "She went out to buy some milk.", ("非谓语动词",),
    ),
    Construction(
        "to-infinitive-object", "TO.OBJ", "不定式作宾语",
        [
            _anchor("head", {"POS": "VERB"}),
            _child("head", "v", {"DEP": "xcomp", "TAG": "VB"}),
            _child("v", "to", {"DEP": "aux", "LOWER": "to"}),
        ],
        "I want to learn Spanish.", ("非谓语动词",),
    ),
    Construction(
        "gerund-subject", "VG.SUBJ", "动名词作主语",
        [
            _anchor(
                "v",
                {
                    "DEP": {"IN": ["nsubj", "csubj", "nsubjpass"]},
                    # 句首动名词常被标成 NN（Swimming is good exercise），只认 VBG 会漏
                    "TAG": {"IN": ["VBG", "NN"]},
                    "LOWER": {"REGEX": "ing$"},
                },
            )
        ],
        "Swimming is good exercise.", ("非谓语动词",),
    ),
    Construction(
        "gerund-object", "VG.OBJ", "动名词作宾语",
        [
            _anchor("head", {"POS": "VERB"}),
            _child("head", "v", {"DEP": {"IN": ["dobj", "xcomp"]}, "TAG": "VBG"}),
        ],
        "He enjoys playing the guitar.", ("非谓语动词",),
    ),
    Construction(
        "gerund-after-prep", "VG.PREP", "介词后接动名词",
        [
            _anchor("prep", {"DEP": "prep"}),
            _child("prep", "v", {"DEP": "pcomp", "TAG": "VBG"}),
        ],
        "She is good at drawing pictures.", ("非谓语动词",),
    ),
    Construction(
        "participle-premodifier", "VN.PRE", "过去分词作前置定语",
        # 只认 TAG=VBN。词汇化程度高的分词（broken/written/fried）spaCy 标成 JJ，
        # 与真形容词无法区分——这类漏检交给 LLM 兜底（FR-401c），
        # 不为了凑命中率把 JJ 全收进来（那会把 "a happy child" 也算成分词定语）
        [_anchor("v", {"DEP": "amod", "TAG": "VBN"})],
        "The stolen car was found yesterday.", ("非谓语动词",),
    ),
    Construction(
        "participle-clause", "VG.ADVCL", "现在分词作状语从句",
        [_anchor("v", {"TAG": "VBG", "DEP": "advcl"})],
        "Walking down the street, I met an old friend.", ("非谓语动词",),
    ),
    # ── 关系从句 ──
    Construction(
        "relative-who-subject", "PREL.who", "关系代词 who 作主语",
        [
            _anchor("v", {"DEP": "relcl"}),
            _child("v", "who", {"DEP": "nsubj", "LOWER": {"IN": ["who", "that"]}}),
        ],
        "The man who lives next door is a doctor.", ("关系从句",),
    ),
    Construction(
        "relative-which-object", "PRELO.which", "关系代词 which/that 作宾语",
        [
            _anchor("v", {"DEP": "relcl"}),
            _child("v", "wh", {"DEP": "dobj", "LOWER": {"IN": ["which", "that", "whom"]}}),
        ],
        "The book which I bought yesterday is interesting.", ("关系从句",),
    ),
    Construction(
        "relative-whose", "PRELGEN.whose", "关系代词 whose 表所属",
        [_anchor("wh", {"LOWER": "whose", "DEP": "poss"})],
        "I know a girl whose father is a pilot.", ("关系从句",),
    ),
    Construction(
        "relative-where", "RBREL.where", "关系副词 where 引导定语从句",
        [
            _anchor("v", {"DEP": "relcl"}),
            _child("v", "wh", {"LOWER": {"IN": ["where", "when", "why"]}, "DEP": "advmod"}),
        ],
        "This is the house where I was born.", ("关系从句",),
    ),
    Construction(
        "contact-clause", "PRELO.zero", "省略关系代词的接触从句",
        [
            _anchor("v", {"DEP": "relcl"}),
            # 主语不能是关系代词，否则 who lives 也会被算成"省略了关系代词"
            _child(
                "v", "subj",
                {
                    "DEP": "nsubj",
                    "POS": {"IN": ["PRON", "NOUN", "PROPN"]},
                    "LOWER": {"NOT_IN": ["who", "which", "that", "whom", "whose"]},
                },
            ),
        ],
        "The film I saw last night was great.", ("关系从句",),
    ),
    # ── 比较与级 ──
    Construction(
        "comparative-than", "COMP.than", "比较级（-er）+ than",
        [
            _anchor("adj", {"TAG": {"IN": ["JJR", "RBR"]}}),
            _child("adj", "than", {"LOWER": "than"}),
        ],
        "He is taller than his brother.", ("比较与级",),
    ),
    Construction(
        "comparative-more-than", "COMP.more", "more + 形容词 + than",
        [
            _anchor("adj", {"POS": {"IN": ["ADJ", "ADV"]}}),
            _child("adj", "more", {"DEP": "advmod", "TAG": {"IN": ["JJR", "RBR"]}}),
            _child("adj", "than", {"LOWER": "than"}),
        ],
        "This book is more interesting than that one.", ("比较与级",),
    ),
    Construction(
        "superlative", "COMP.SUP", "最高级",
        [_anchor("adj", {"TAG": {"IN": ["JJS", "RBS"]}})],
        "She is the tallest student in the class.", ("比较与级",),
    ),
    Construction(
        "as-as", "COMP.as_as", "as ... as 同级比较",
        [
            _anchor("adj", {"POS": {"IN": ["ADJ", "ADV"]}}),
            _child("adj", "as1", {"LOWER": "as", "DEP": "advmod"}),
            _child("adj", "as2", {"LOWER": "as", "DEP": {"IN": ["prep", "mark", "cc"]}}),
        ],
        "He runs as fast as his brother.", ("比较与级",),
    ),
    Construction(
        "too-to", "RBDEG.too_to", "too + 形容词 + to 不定式",
        [
            _anchor("adj", {"POS": {"IN": ["ADJ", "ADV"]}}),
            _child("adj", "too", {"LOWER": "too", "DEP": "advmod"}),
            _child("adj", "v", {"DEP": "xcomp", "TAG": "VB"}),
        ],
        "The box is too heavy to carry.", ("比较与级",),
    ),
    Construction(
        "enough-to", "RBDEG.enough", "形容词 + enough + to 不定式",
        [
            _anchor("adj", {"POS": {"IN": ["ADJ", "ADV"]}}),
            _child("adj", "enough", {"LOWER": "enough"}),
        ],
        "He is old enough to drive.", ("比较与级",),
    ),
    # ── 句型与从句 ──
    Construction(
        "there-be", "EX.PRESENT", "there be 存在句",
        [
            _anchor("be", {"LEMMA": "be"}),
            _child("be", "there", {"DEP": "expl", "LOWER": "there"}),
        ],
        "There is a book on the table.", ("there be 句型",),
    ),
    Construction(
        "ditransitive", "VP.SVOO", "双宾语句型 SVOO",
        [
            _anchor("v", {"POS": "VERB"}),
            _child("v", "iobj", {"DEP": "dative"}),
            _child("v", "dobj", {"DEP": "dobj"}),
        ],
        "She gave me a present.", ("基本句型",),
    ),
    Construction(
        "svoc", "VP.SVOC", "宾语补足语句型 SVOC",
        [
            _anchor("v", {"POS": "VERB"}),
            _child("v", "obj", {"DEP": "dobj"}),
            _child("v", "oc", {"DEP": {"IN": ["oprd", "xcomp", "acomp"]}}),
        ],
        "We call him Tom.", ("基本句型",),
    ),
    Construction(
        "causative", "CAUS.make", "使役动词 have/let/make + 宾语 + 原形",
        [
            _anchor("v", {"LEMMA": {"IN": ["make", "let", "have"]}}),
            # 「宾语」在依存上是内嵌从句的主语，不是主句的 dobj
            _child("v", "inf", {"DEP": {"IN": ["ccomp", "xcomp", "oprd"]}, "TAG": "VB"}),
            _child("inf", "obj", {"DEP": "nsubj"}),
        ],
        "She made him clean his room.", ("使役与感官",),
    ),
    Construction(
        "perception-verb", "PERC.see", "感官动词 see/hear/feel + 宾语 + 原形/分词",
        [
            _anchor("v", {"LEMMA": {"IN": ["see", "hear", "feel", "watch", "notice"]}}),
            _child("v", "comp", {"DEP": {"IN": ["ccomp", "xcomp", "oprd"]}, "POS": "VERB"}),
            _child("comp", "obj", {"DEP": "nsubj"}),
        ],
        "I saw him cross the road.", ("使役与感官",),
    ),
    Construction(
        "phrasal-verb", "PHV.VP", "短语动词：动词 + 小品词",
        [
            _anchor("v", {"POS": "VERB"}),
            _child("v", "prt", {"DEP": "prt"}),
        ],
        "Please turn off the light.", ("短语动词",),
    ),
    Construction(
        "subordinate-because", "CL_after.IN", "从属连词引导状语从句",
        [
            _anchor("v", {"DEP": "advcl"}),
            # 从句带助动词时 mark 会挂到助动词上，与 advcl 隔一层，必须用 >>。
            # 排掉 if：条件句有更贴切的 conditional-if 规则，两条都命中只是噪声
            _child("v", "mark", {"DEP": "mark", "LOWER": {"NOT_IN": ["if", "unless"]}}, ">>"),
        ],
        "I stayed home because it was raining.", ("连词与从句",),
    ),
    Construction(
        "that-clause-object", "CL.that", "that 引导的宾语从句",
        [
            _anchor("v", {"DEP": "ccomp"}),
            _child("v", "mark", {"DEP": "mark", "LOWER": "that"}),
        ],
        "I think that he is right.", ("连词与从句",),
    ),
    Construction(
        "indirect-question", "INDQ.know", "间接疑问句",
        [
            _anchor("v", {"DEP": "ccomp"}),
            _child("v", "wh", {"LOWER": {"IN": ["what", "where", "when", "why", "how", "who"]}}),
        ],
        "I don't know where he lives.", ("间接引语",),
    ),
    Construction(
        "reported-speech", "INDSP.say", "间接引语：say/tell + 从句",
        [
            _anchor("v", {"LEMMA": {"IN": ["say", "tell", "explain", "report"]}}),
            _child("v", "cl", {"DEP": "ccomp"}),
        ],
        "He said that he was tired.", ("间接引语",),
    ),
    # ── 条件与虚拟 ──
    Construction(
        "conditional-if", "SUBJ.if1", "if 条件句",
        [
            _anchor("v", {"DEP": "advcl"}),
            _child("v", "if", {"DEP": "mark", "LOWER": "if"}),
        ],
        "If it rains, we will stay at home.", ("虚拟与条件",),
    ),
    Construction(
        "conditional-would", "SUBJ.if2", "would + 动词原形（虚拟主句）",
        [
            _anchor("v", {"TAG": "VB"}),
            _child("v", "md", {"DEP": "aux", "LOWER": {"IN": ["would", "'d"]}}),
        ],
        "I would go if I had time.", ("虚拟与条件",),
    ),
    Construction(
        "wish-clause", "SUBJ.wish", "wish 引导的虚拟语气",
        [
            _anchor("v", {"LEMMA": "wish"}),
            _child("v", "cl", {"DEP": "ccomp"}),
        ],
        "I wish I were taller.", ("虚拟与条件",),
    ),
    # ── 疑问、祈使、强调 ──
    Construction(
        "wh-question", "INT.what", "wh- 特殊疑问句",
        [
            _anchor("v", {"DEP": "ROOT"}),
            _child(
                "v", "wh",
                {
                    "LOWER": {"IN": ["what", "where", "when", "why", "how", "who", "which"]},
                    # 必须在句首，否则定语从句里的 who 也会被当成特殊疑问句
                    "IS_SENT_START": True,
                },
                ">>",
            ),
            _child("v", "aux", {"DEP": "aux"}),
        ],
        "What did you do yesterday?", ("疑问句",),
    ),
    Construction(
        # 句首约束是必须的：不加它，任何 wh- 疑问句里的原形动词都会被当成祈使句
        "imperative", "IMP.do.AFF", "祈使句",
        [_anchor("v", {"TAG": "VB", "DEP": "ROOT", "IS_SENT_START": True})],
        "Close the door, please.", ("祈使句",),
    ),
    Construction(
        "imperative-please", "IMP.please", "Please + 祈使句",
        [
            _anchor("v", {"TAG": "VB", "DEP": "ROOT"}),
            _child("v", "please", {"LOWER": "please", "IS_SENT_START": True}),
        ],
        "Please close the door.", ("祈使句",),
    ),
    Construction(
        "cleft-it-is", "EMP.cleft", "It is ... that 强调句",
        [
            _anchor("be", {"LEMMA": "be"}),
            _child("be", "it", {"DEP": "nsubj", "LOWER": "it"}),
            _child("be", "cl", {"DEP": {"IN": ["relcl", "ccomp", "acl"]}}),
        ],
        "It was John that broke the window.", ("强调与倒装",),
    ),
    Construction(
        "negative-inversion", "INV.NEG", "否定词前置引发的倒装",
        [
            _anchor("v", {"POS": {"IN": ["VERB", "AUX"]}}),
            _child(
                "v", "neg",
                {"LOWER": {"IN": ["never", "rarely", "seldom", "hardly", "little", "no"]},
                 "DEP": {"IN": ["advmod", "neg"]}},
            ),
            _child("v", "aux", {"DEP": "aux"}),
        ],
        "Never have I seen such a thing.", ("强调与倒装",),
    ),
    Construction(
        "exclamation", "EXCL.what", "感叹句 What/How ...!",
        [
            _anchor("head", {"POS": {"IN": ["NOUN", "ADJ", "ADV"]}}),
            _child("head", "wh", {"LOWER": {"IN": ["what", "how"]}}),
        ],
        "What a beautiful day it is!", ("感叹句",),
    ),
    Construction(
        "tag-question", "TAG.AFF", "反义疑问句",
        # 反义疑问句的判据是**位置**不是词性：附加部分的主语在助动词之后（倒装），
        # 主句在助动词之前。首版只写「ROOT 是 AUX 且有代词 nsubj」，两头都错：
        #   漏：`You don't like it, do you?` 里的 do 被标成 VERB 不是 AUX
        #   误：`What a beautiful day it is!` 的 is + it 照样命中
        # `>--` / `>++` 把「子节点且在左/右」一次表达出来，正反例见单测
        # 两个候选形状：主句简单时 tag 是 ROOT，主句一复杂 tag 就变成 ROOT 的 conj
        #   There is a problem, isn't there?                  → tag 是 ROOT
        #   There were too many people for us to..., weren't there? → tag 是 conj
        [
            [
                _anchor("tag", {"DEP": "ROOT", "POS": {"IN": ["AUX", "VERB"]}}),
                _child(
                    "tag", "main", {"DEP": {"IN": ["ccomp", "advcl", "conj", "parataxis"]}}, ">--"
                ),
                # 附加部分的主语是封闭类，列举比放宽词性安全：
                # 放宽成 advmod/ADV 会让「…, obviously.」这类句尾副词误命中
                _child("tag", "subj", _TAG_SUBJ_ATTRS, ">++"),
            ],
            [
                _anchor("tag", {"DEP": "conj", "POS": {"IN": ["AUX", "VERB"]}}),
                # conj 形状下主句就是 tag 的中心词，不用再单独约束；
                # 靠「主语在 tag 右边」把 "He came and she left." 挡在外面
                _child("tag", "subj", _TAG_SUBJ_ATTRS, ">++"),
            ],
        ],
        "You are coming, aren't you?", ("反义疑问句",),
    ),
    Construction(
        "so-that", "CL.so_that", "so ... that 结果状语从句",
        [
            # 结果从句挂在被 so 修饰的那个形容词/副词上，不是主句谓语上
            _anchor("adj", {"POS": {"IN": ["ADJ", "ADV"]}}),
            _child("adj", "so", {"DEP": "advmod", "LOWER": "so"}),
            _child("adj", "cl", {"DEP": {"IN": ["ccomp", "advcl"]}}),
        ],
        "He ran so fast that nobody could catch him.", ("连词与从句",),
    ),
]

RULES_BY_KEY = {r.key: r for r in RULES}

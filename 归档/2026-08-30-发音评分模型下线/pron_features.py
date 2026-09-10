"""发音评分的特征函数（FR-399）。

**这份实现同时服务运行时打分与离线校准**。放在一处不是洁癖：
特征函数一旦有两份，校准拟合的东西与线上算的东西会慢慢分叉，
而这种偏差不会报错，只会让分数悄悄失准。

## 两级结构

```
逐音素原始量（GOP / 时长 / 帧级置信度）
        ↓  词级特征
每个词一个预测分  ←── 词模型（在 ~1.5 万个词上拟合）
        ↓  聚合（均值 / 最差 / 低分率）
整句准确度        ←── 句模型（在 2.5 千个句子上拟合）
```

为什么分两级：重音这类特征只在多音节词上有意义，而**只有约两成的词是多音节**——
在句子层面平均掉之后信号就没了（实测句级重音特征 ρ 仅 0.036）。
放到词级它有自己的位置，再由聚合把「有几个词读崩了」带到句子上。
词级还顺带把训练样本从 2,500 句变成上万个词。

## 三组原始信号

| 组 | 回答什么 | 来源 |
| --- | --- | --- |
| GOP | 每个音读得像不像 | `log P(p|frames) − max_q log P(q|frames)` |
| 时长 | 音长对不对（长短元音不分、词尾吞音、加音） | Viterbi 帧区间 |
| 重音 | 重音放对了没有 | espeak 重音标记 + 同词各元音的时长与清晰度 |

## 为什么 GOP 要按音素归一化

/θ/ 的 GOP 天然比 /ɑː/ 低——它与 /s/ /f/ 声学上本来就近，即使读对了后验也分散。
拿一个绝对阈值切下去，等于把「这个音素难」判成「这个人读得差」。
`Refs.gop` 存每个音素在**读得好的语料**上的 GOP 均值与标准差，
z 分数把音素身份从质量信号里剥出来；时长基准 `Refs.dur` 同理。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

# 长短元音对：中国学习者最典型的时长问题是不区分这两组
LONG_VOWELS = frozenset({"iː", "uː", "ɑː", "ɔː", "ɜː", "oː", "eɪ", "aɪ", "ɔɪ", "aʊ", "oʊ", "əʊ"})
SHORT_VOWELS = frozenset({"ɪ", "ʊ", "ʌ", "ɛ", "æ", "ɒ", "ə", "ɐ", "e", "ɚ"})

# GOP 低于此值算「这个音读得不像」。−1.0 约等于正确音位的后验只有次优的 1/e
GOP_LOW = -1.0
# 归一化后的低分线：比「读得好的同音素」低一个标准差
GOP_Z_LOW = -1.0
# 时长偏离参考多少算异常：log 比值 0.7 ≈ 2 倍
DUR_OUTLIER_LOG = 0.7
# 基准表里一个音素至少要有多少样本才收录。少于此数的基准是噪声，不如不用
REF_MIN_SAMPLES = 20
# 每个音素带几个竞争者的 LPR，与 phoneme_asr.LPR_TOPK 对齐
LPR_TOPK = 8
# 时间窗里不到一半的帧认这个音，就算「模型基本没认出来」
TOP1_LOW = 0.5

# 帧级统计量缺失时的兜底：空区间意味着这个音根本没对齐上，一律按最差处理
_MISS = {"top1": 0.0, "margin": -3.0, "margin_min": -6.0, "entropy": 2.0, "lpr": -20.0}

# 音素级特征顺序 = 音素模型系数顺序。**改动必须重新校准**
PHONE_FEATURE_NAMES = (
    "p_gop",
    "p_gop_z",
    "p_top1",
    "p_margin",
    "p_margin_min",
    "p_entropy",
    "p_ref_gop",
    "p_ctx_gop",
    "p_rel_dur",
    "p_dur_dev",
    "p_dur_signed",
    "p_conf",
    "p_peak",
    "p_is_vowel",
    "p_stress",
    "p_pos_in_word",
    "p_word_len",
    "p_is_word_final",
    # LPR：参考音素比第 1…8 强的竞争者各高多少。GOP 只看最强的那一个，
    # 这组把整个竞争格局的形状带上（Kaldi recipe 的核心特征）
    *(f"p_lpr{i + 1}" for i in range(LPR_TOPK)),
    # 二次项：质量信号在两端都会饱和——GOP 再高一个标准差不会更对，
    # 再低一个标准差也已经是「完全没读出来」。线性项抓不到这个形状
    "p_gop_z_sq",
    "p_top1_sq",
    "p_margin_sq",
    "p_dur_dev_sq",
)

# 音素预测分低于此值算「这个音没读到位」（专家音素级分是 0-2）
PHONE_LOW = 1.6

# 词级特征顺序 = 词模型系数顺序。**改动必须重新校准**
WORD_FEATURE_NAMES = (
    "w_gop_mean",
    "w_gop_min",
    "w_gop_low_rate",
    "w_gop_vowel_mean",
    "w_gop_z_mean",
    "w_gop_z_min",
    "w_top1_mean",
    "w_top1_min",
    "w_margin_min",
    "w_entropy_mean",
    "w_dur_dev",
    "w_dur_outlier_rate",
    "w_conf_mean",
    "w_conf_min",
    "w_n_phones",
    "w_multi_syllable",
    "w_stress_dur_hit",
    "w_stress_dur_ratio",
    "w_stress_conf_gap",
    # 音素模型在本词上的聚合
    "w_phone_mean",
    "w_phone_min",
)

# 句级特征顺序 = 句模型系数顺序
FEATURE_NAMES = (
    "gop_mean",
    "gop_low_rate",
    "gop_p10",
    "gop_vowel_mean",
    # 按音素归一化后的 GOP：把「音素难」从「读得差」里剥出来
    "gop_z_mean",
    "gop_z_p10",
    "gop_z_low_rate",
    # 最差的三个音：均值抹掉的正是打分时最看重的那部分
    "gop_z_worst3",
    # 帧级后验统计：与 GOP 线性无关的另一组信号，见 phoneme_asr._frame_stats
    "top1_mean",
    "top1_low_rate",
    "margin_p10",
    "entropy_mean",
    "dur_dev",
    "dur_outlier_rate",
    "vowel_len_contrast",
    "phones_per_sec",
    # 插入率：贪心解码出的音素数 / 参考音素数。
    # 普通话母语者在辅音簇与词尾加元音（sk → sɪk）是高频问题，这个比值直接抓它
    "insert_ratio",
    # 自由解码与参考序列的编辑距离。GOP 走强制对齐，问的是「按这个文本对齐后每个音有多像」；
    # 这一组走自由解码，问的是「不告诉它文本，它听成了什么」。两条路互相独立
    "per",
    "sub_rate",
    "del_rate",
    "ins_rate",
    # 词尾辅音的相对时长：吞掉词尾辅音是另一类高频问题，均值掩盖不了它
    "final_cons_dur",
    # 音素模型的聚合
    "phone_pred_mean",
    "phone_pred_min",
    "phone_pred_p10",
    "phone_pred_low_rate",
    "phone_pred_worst3",
    # 词模型的聚合：没有词模型时这几项取中性值，句模型退化成纯句级特征
    "word_pred_mean",
    "word_pred_min",
    "word_pred_low_rate",
    "word_pred_worst2",
)

# 重音特征算但**不进模型**，理由见 `STRESS_NOTE`
STRESS_FEATURES = ("stress_dur_hit", "stress_dur_ratio", "stress_conf_ratio")
STRESS_NOTE = (
    "speechocean762 的词级 stress 标注 2097/2102 都是满分——这份语料里几乎没有重音错误，"
    "拿它拟合重音权重等于在 5 个样本上学。消融实测 GOP+重音（0.542）反而低于纯 GOP（0.551）。"
    "所以重音特征保留计算与展示（界面要能说「重音落在了第二个音节」），但不进评分模型。"
)

# 词级预测分低于此值算「这个词读崩了」（专家词级分是 0-10）
WORD_LOW = 6.0


def _mean(xs: list[float], default: float = 0.0) -> float:
    return sum(xs) / len(xs) if xs else default


def _worst_k(xs: list[float], k: int, default: float = 0.0) -> float:
    """最差的 k 个的均值。

    句子级均值会把「有两三个音彻底读崩」这件事抹平，而人打分时恰恰最看重它。
    分位数只取一个点，最差几个的均值更稳。
    """
    if not xs:
        return default
    s = sorted(xs)[:k]
    return sum(s) / len(s)


def _percentile(xs: list[float], q: float, default: float = 0.0) -> float:
    if not xs:
        return default
    s = sorted(xs)
    k = max(0, min(len(s) - 1, int(round(q * (len(s) - 1)))))
    return s[k]


# ─────────────── 基准表 ───────────────


@dataclass(frozen=True)
class Refs:
    """每个音素「读对时是什么样」的基准表。

    两张表都**只从专家 accuracy ≥ 9 的语料**统计：基准要回答的是
    「读对时这个音是什么样」，拿全体语料算等于把错误也算进基准。

    - `dur`：相对时长（该音帧数 / 本句音素平均帧数），除以本句均值是为了不随语速漂移
    - `gop`：`(均值, 标准差)`，供 `gop_z` 做 z 归一化

    基准只能用 train 拟合。用上 test 就是泄漏，报出来的 ρ 会虚高。
    """

    dur: dict[str, float]
    gop: dict[str, tuple[float, float]]
    # 音素身份的固定顺序。音素模型的 one-hot 块按它排，所以必须随权重一起落盘
    symbols: tuple[str, ...] = ()
    index: dict[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.symbols:
            object.__setattr__(self, "symbols", tuple(sorted(self.gop)))
        if not self.index:
            object.__setattr__(self, "index", {s: i for i, s in enumerate(self.symbols)})

    @staticmethod
    def build(records: list[dict], min_accuracy: int = 9) -> Refs:
        dur_acc: dict[str, list[float]] = {}
        gop_acc: dict[str, list[float]] = {}
        for rec in records:
            if (rec.get("expert", {}).get("accuracy") or 0) < min_accuracy:
                continue
            phones = rec.get("raw", {}).get("phones") or []
            durs = [float(p["frames"]) for p in phones if p["frames"] > 0]
            if len(durs) < 3:
                continue
            avg = _mean(durs, 1.0) or 1.0
            for p in phones:
                if p["frames"] > 0:
                    dur_acc.setdefault(p["symbol"], []).append(p["frames"] / avg)
                if p.get("gop") is not None:
                    gop_acc.setdefault(p["symbol"], []).append(float(p["gop"]))
        dur = {s: _mean(v) for s, v in dur_acc.items() if len(v) >= REF_MIN_SAMPLES}
        gop: dict[str, tuple[float, float]] = {}
        for s, v in gop_acc.items():
            if len(v) < REF_MIN_SAMPLES:
                continue
            mu = _mean(v)
            sd = (sum((x - mu) ** 2 for x in v) / len(v)) ** 0.5
            # 标准差兜个下限：某个音素恰好方差极小时，z 分数会被放大成几十
            gop[s] = (mu, max(0.25, sd))
        return Refs(dur=dur, gop=gop)

    @staticmethod
    def from_json(obj: dict | None) -> Refs:
        obj = obj or {}
        gop_raw = obj.get("gop") or {}
        return Refs(
            dur={k: float(v) for k, v in (obj.get("dur") or {}).items()},
            gop={k: (float(v[0]), float(v[1])) for k, v in gop_raw.items() if len(v) == 2},
            symbols=tuple(obj.get("symbols") or ()),
        )

    def to_json(self) -> dict:
        return {
            "dur": {k: round(v, 4) for k, v in self.dur.items()},
            "gop": {k: [round(v[0], 4), round(v[1], 4)] for k, v in self.gop.items()},
            "symbols": list(self.symbols),
        }

    def gop_z(self, symbol: str, gop: float) -> float:
        """GOP 的 z 分数。基准里没有这个音素时返回 0（当「没信息」处理，不是「很差」）。"""
        base = self.gop.get(symbol)
        if not base:
            return 0.0
        return (gop - base[0]) / base[1]

    def ref_gop(self, symbol: str) -> float:
        """该音素在读得好的语料上的 GOP 均值。模型靠它知道「这个音本来就难」。"""
        base = self.gop.get(symbol)
        return base[0] if base else -1.5


def align_rates(raw: dict) -> dict[str, float]:
    """自由解码序列与参考序列的编辑距离统计。

    替换率是里面最有用的一项：加音减音会改变长度（`insert_ratio` 能看到），
    而**替换完全不改长度**——θ 读成 s 在长度比上一点痕迹都没有。

    `hyp` 是 v2 抽取产物才有的字段。缺它时全部给 0（当「没有额外信息」处理），
    此时句模型退化成只看强制对齐那一路。
    """
    hyp = raw.get("hyp")
    phones = raw.get("phones") or []
    if not hyp or not phones:
        return {"per": 0.0, "sub_rate": 0.0, "del_rate": 0.0, "ins_rate": 0.0}
    from domain.phoneme_asr import align_phonemes

    ref = [p["symbol"] for p in phones]
    pairs = align_phonemes(ref, hyp)
    n = float(len(ref)) or 1.0
    kinds = [k for k, _, _ in pairs]
    sub = kinds.count("substitution")
    dele = kinds.count("deletion")
    ins = kinds.count("insertion")
    return {
        "per": (sub + dele + ins) / n,
        "sub_rate": sub / n,
        "del_rate": dele / n,
        "ins_rate": ins / n,
    }


def _stat(phone: dict, key: str) -> float:
    """取帧级统计量。缺键或为 None 都按「这个音没对齐上」的最差值处理。"""
    v = phone.get(key)
    return float(v) if v is not None else _MISS[key]


def _rel_durations(phones: list[dict]) -> dict[int, float]:
    """相对时长（按本句均值归一），键是 phone 在列表里的下标。"""
    durs = [float(p["frames"]) for p in phones if p["frames"] > 0]
    avg = _mean(durs, 1.0) or 1.0
    return {i: p["frames"] / avg for i, p in enumerate(phones) if p["frames"] > 0}


def _dur_logs(phones: list[dict], rel: dict[int, float], refs: Refs) -> dict[int, float]:
    """`log(实际相对时长 / 基准)`，**带符号**：正=拖长或加音，负=吞音。

    方向有诊断价值——词尾辅音偏短是吞音，辅音簇里偏长是插进了元音，
    取绝对值会把这两类混成一个数。绝对值版本另算（`p_dur_dev`）。
    """
    out: dict[int, float] = {}
    for i, p in enumerate(phones):
        base = refs.dur.get(p["symbol"])
        r = rel.get(i)
        if base and r:
            out[i] = math.log(r / base)
    return out


# ─────────────── 音素级 ───────────────


def build_phone_features(raw: dict, refs: Refs) -> list[dict]:
    """每个音素一个特征向量。

    这一级是信号最密的地方：speechocean762 给了逐音素 0/1/2 专家标注，
    全量约 3.5 万个点且有真方差；句级只有 2,500 条、词级标注 90% 是满分。
    模型在这里学的是「这个音在这个位置上，GOP 多低才算真读错」——
    词尾清辅音天然 GOP 低，句中重读元音低就是真问题，两者不该一个阈值。
    """
    phones = raw.get("phones") or []
    if not phones:
        return []
    rel = _rel_durations(phones)
    logs = _dur_logs(phones, rel, refs)

    by_word: dict[int, list[int]] = {}
    for i, p in enumerate(phones):
        by_word.setdefault(p["word"], []).append(i)
    pos_in_word: dict[int, tuple[int, int]] = {}
    for idx in by_word.values():
        for k, i in enumerate(idx):
            pos_in_word[i] = (k, len(idx))

    raw_gops = [float(p["gop"]) if p.get("gop") is not None else None for p in phones]

    out = []
    for i, p in enumerate(phones):
        k, n = pos_in_word.get(i, (0, 1))
        gop = raw_gops[i] if raw_gops[i] is not None else -3.0
        lprs = p.get("lpr") or []
        # 邻居的 GOP：孤立的一个低点多半是对齐抖动，连成一片才是真读崩了
        ctx = [
            raw_gops[j]
            for j in (i - 1, i + 1)
            if 0 <= j < len(phones) and raw_gops[j] is not None
        ]
        out.append(
            {
                "word": p["word"],
                "symbol": p["symbol"],
                "p_gop": gop,
                "p_gop_z": refs.gop_z(p["symbol"], gop),
                "p_top1": _stat(p, "top1"),
                "p_margin": _stat(p, "margin"),
                "p_margin_min": _stat(p, "margin_min"),
                "p_entropy": _stat(p, "entropy"),
                "p_ref_gop": refs.ref_gop(p["symbol"]),
                "p_ctx_gop": _mean(ctx, gop),
                "p_rel_dur": rel.get(i, 1.0),
                "p_dur_dev": abs(logs.get(i, 0.0)),
                "p_dur_signed": logs.get(i, 0.0),
                "p_conf": float(p["conf"]) if p.get("conf") is not None else -1.0,
                "p_peak": float(p.get("peak") or 0),
                "p_is_vowel": 1.0 if p.get("vowel") else 0.0,
                "p_stress": float(p.get("stress") or 0),
                "p_pos_in_word": k / max(1, n - 1) if n > 1 else 0.0,
                "p_word_len": float(n),
                "p_is_word_final": 1.0 if k == n - 1 else 0.0,
                **{
                    f"p_lpr{j + 1}": (
                        float(lprs[j]) if j < len(lprs) else _MISS["lpr"]
                    )
                    for j in range(LPR_TOPK)
                },
                "p_gop_z_sq": refs.gop_z(p["symbol"], gop) ** 2,
                "p_top1_sq": _stat(p, "top1") ** 2,
                "p_margin_sq": _stat(p, "margin") ** 2,
                "p_dur_dev_sq": logs.get(i, 0.0) ** 2,
            }
        )
    return out


def phone_vector(feats: dict, refs: Refs) -> list[float]:
    """音素特征向量 = 固定特征 + 音素身份 one-hot + 身份×GOP_z 交互。

    为什么要把音素身份显式放进去：`gop_z` 只减掉了每个音素的均值与方差，
    **「GOP → 分数」这条映射的斜率随音素而变这件事丢了**——/θ/ 的 GOP 掉 1 个
    标准差与 /ɑː/ 掉 1 个标准差，严重程度并不一样。one-hot 给每个音素一个截距，
    交互项给它一个斜率。文献里这是消融中单一最高杠杆的输入
    （HMamba 去掉音素身份，音素级 PCC 0.739→0.624）。

    向量长度随 `refs.symbols` 变，所以符号表必须与权重一起落盘。
    """
    base = [float(feats.get(n, 0.0)) for n in PHONE_FEATURE_NAMES]
    n_sym = len(refs.symbols)
    onehot = [0.0] * n_sym
    inter = [0.0] * n_sym
    i = refs.index.get(str(feats.get("symbol") or ""))
    if i is not None:
        onehot[i] = 1.0
        inter[i] = float(feats.get("p_gop_z", 0.0))
    return base + onehot + inter


def phone_vector_len(refs: Refs) -> int:
    return len(PHONE_FEATURE_NAMES) + 2 * len(refs.symbols)


def predict_phones(raw: dict, refs: Refs, weights: list[float] | None) -> list[float]:
    """每个音素的预测分（0-2 刻度）。没有音素模型时返回空表。"""
    if not weights or len(weights) != phone_vector_len(refs) + 1:
        return []
    out = []
    for pf in build_phone_features(raw, refs):
        v = phone_vector(pf, refs)
        s = sum(w * x for w, x in zip(weights[:-1], v, strict=True)) + weights[-1]
        out.append(max(0.0, min(2.0, s)))
    return out


# ─────────────── 词级 ───────────────


def build_word_features(
    raw: dict, refs: Refs, phone_weights: list[float] | None = None
) -> list[dict]:
    """每个词一个特征向量。词的划分来自 espeak 的空格分隔。"""
    phones = raw.get("phones") or []
    if not phones:
        return []
    rel = _rel_durations(phones)
    logs = _dur_logs(phones, rel, refs)
    pp = predict_phones(raw, refs, phone_weights)

    by_word: dict[int, list[int]] = {}
    for i, p in enumerate(phones):
        by_word.setdefault(p["word"], []).append(i)

    out: list[dict] = []
    for wi in sorted(by_word):
        idx = by_word[wi]
        gops = [float(phones[i]["gop"]) for i in idx if phones[i].get("gop") is not None]
        zs = [
            refs.gop_z(phones[i]["symbol"], float(phones[i]["gop"]))
            for i in idx
            if phones[i].get("gop") is not None
        ]
        vgops = [
            float(phones[i]["gop"])
            for i in idx
            if phones[i].get("vowel") and phones[i].get("gop") is not None
        ]
        confs = [float(phones[i]["conf"]) for i in idx if phones[i].get("conf") is not None]
        wdevs = [abs(logs[i]) for i in idx if i in logs]
        tops = [_stat(phones[i], "top1") for i in idx]
        margins = [_stat(phones[i], "margin_min") for i in idx]
        ents = [_stat(phones[i], "entropy") for i in idx]

        vowels = [i for i in idx if phones[i].get("vowel")]
        stressed = [i for i in vowels if phones[i]["stress"] == 1]
        others = [i for i in vowels if phones[i]["stress"] != 1]
        multi = 1.0 if len(vowels) >= 2 else 0.0
        if multi and stressed and others:
            s_dur = _mean([float(phones[i]["frames"]) for i in stressed])
            o_durs = [float(phones[i]["frames"]) for i in others]
            hit = 1.0 if s_dur >= max(o_durs) else 0.0
            ratio = s_dur / (_mean(o_durs, 1.0) or 1.0)
            s_conf = _mean([float(phones[i]["conf"]) for i in stressed if phones[i].get("conf")])
            o_conf = _mean(
                [float(phones[i]["conf"]) for i in others if phones[i].get("conf")], 0.0
            )
            gap = s_conf - o_conf
        else:
            # 单音节词没有重音位置可言：给中性值，不要给 0（那会被模型当成「重音全错」）
            hit, ratio, gap = 0.5, 1.0, 0.0

        out.append(
            {
                "word": wi,
                "w_gop_mean": _mean(gops, -3.0),
                "w_gop_min": min(gops) if gops else -6.0,
                "w_gop_low_rate": (
                    sum(1 for g in gops if g < GOP_LOW) / len(gops) if gops else 1.0
                ),
                "w_gop_vowel_mean": _mean(vgops, -3.0),
                "w_gop_z_mean": _mean(zs, 0.0),
                "w_gop_z_min": min(zs) if zs else 0.0,
                "w_top1_mean": _mean(tops, 0.0),
                "w_top1_min": min(tops) if tops else 0.0,
                "w_margin_min": min(margins) if margins else _MISS["margin_min"],
                "w_entropy_mean": _mean(ents, _MISS["entropy"]),
                "w_dur_dev": _mean(wdevs, 0.0),
                "w_dur_outlier_rate": (
                    sum(1 for d in wdevs if d > DUR_OUTLIER_LOG) / len(wdevs) if wdevs else 0.0
                ),
                "w_conf_mean": _mean(confs, -1.0),
                "w_conf_min": min(confs) if confs else -3.0,
                "w_n_phones": float(len(idx)),
                "w_multi_syllable": multi,
                "w_stress_dur_hit": hit,
                "w_stress_dur_ratio": ratio,
                "w_stress_conf_gap": gap,
                # 缺音素模型时给中性满分，词模型于是只看自己的特征
                "w_phone_mean": _mean([pp[i] for i in idx if i < len(pp)], 2.0),
                "w_phone_min": (
                    min([pp[i] for i in idx if i < len(pp)], default=2.0) if pp else 2.0
                ),
            }
        )
    return out


def word_vector(feats: dict) -> list[float]:
    return [float(feats.get(n, 0.0)) for n in WORD_FEATURE_NAMES]


def predict_words(
    raw: dict,
    refs: Refs,
    weights: list[float] | None,
    phone_weights: list[float] | None = None,
) -> list[float]:
    """每个词的预测分（0-10 刻度）。没有词模型时返回空表。"""
    if not weights or len(weights) != len(WORD_FEATURE_NAMES) + 1:
        return []
    out = []
    for wf in build_word_features(raw, refs, phone_weights):
        v = word_vector(wf)
        s = sum(w * x for w, x in zip(weights[:-1], v, strict=True)) + weights[-1]
        out.append(max(0.0, min(10.0, s)))
    return out


# ─────────────── 句级 ───────────────


def build_features(
    raw: dict,
    refs: Refs,
    word_weights: list[float] | None = None,
    phone_weights: list[float] | None = None,
) -> dict[str, float]:
    """一条语料的原始量 → 句级特征向量。运行时与校准共用。"""
    phones = raw.get("phones") or []
    step = float(raw.get("frame_seconds") or 0.02)
    if not phones:
        # 键集合要与正常路径完全一致（含重音三项），否则读 `stress_dur_hit` 的调用方
        # 在空输入上会拿到 KeyError 而不是中性值
        return {**dict.fromkeys(FEATURE_NAMES, 0.0), **dict.fromkeys(STRESS_FEATURES, 0.0)}

    gops = [float(p["gop"]) for p in phones if p.get("gop") is not None]
    zs = [refs.gop_z(p["symbol"], float(p["gop"])) for p in phones if p.get("gop") is not None]
    vowel_gops = [float(p["gop"]) for p in phones if p.get("vowel") and p.get("gop") is not None]
    tops = [_stat(p, "top1") for p in phones]
    margins = [_stat(p, "margin") for p in phones]
    ents = [_stat(p, "entropy") for p in phones]

    rel = _rel_durations(phones)
    logs = _dur_logs(phones, rel, refs)
    devs = [abs(v) for v in logs.values()]

    long_rel = [rel[i] for i, p in enumerate(phones) if p["symbol"] in LONG_VOWELS and i in rel]
    short_rel = [rel[i] for i, p in enumerate(phones) if p["symbol"] in SHORT_VOWELS and i in rel]
    total_sec = max(1e-6, sum(float(p["frames"]) for p in phones) * step)

    # 词尾辅音：每个词最后一个非元音音素
    last_of_word: dict[int, int] = {}
    for i, p in enumerate(phones):
        last_of_word[p["word"]] = i
    final_cons = [
        rel[i]
        for i in last_of_word.values()
        if i in rel and not phones[i].get("vowel")
    ]
    ref_len = float(raw.get("ref_len") or len(phones)) or 1.0
    hyp_len = float(raw.get("hyp_len") or ref_len)

    # 句级重音：只在多元音词上有意义，两成左右的词而已，所以它主要靠词级模型发挥
    words = build_word_features(raw, refs, phone_weights)
    multi = [w for w in words if w["w_multi_syllable"] > 0]

    preds = predict_words(raw, refs, word_weights, phone_weights)
    ppred = predict_phones(raw, refs, phone_weights)
    return {
        "gop_mean": _mean(gops, -3.0),
        "gop_low_rate": (sum(1 for g in gops if g < GOP_LOW) / len(gops) if gops else 1.0),
        "gop_p10": _percentile(gops, 0.10, -6.0),
        "gop_vowel_mean": _mean(vowel_gops, -3.0),
        "gop_z_mean": _mean(zs, 0.0),
        "gop_z_p10": _percentile(zs, 0.10, 0.0),
        "gop_z_low_rate": (sum(1 for z in zs if z < GOP_Z_LOW) / len(zs) if zs else 0.0),
        "gop_z_worst3": _worst_k(zs, 3, 0.0),
        "top1_mean": _mean(tops, 0.0),
        "top1_low_rate": (
            sum(1 for t in tops if t < TOP1_LOW) / len(tops) if tops else 1.0
        ),
        "margin_p10": _percentile(margins, 0.10, _MISS["margin"]),
        "entropy_mean": _mean(ents, _MISS["entropy"]),
        "dur_dev": _mean(devs, 0.0),
        "dur_outlier_rate": (
            sum(1 for d in devs if d > DUR_OUTLIER_LOG) / len(devs) if devs else 0.0
        ),
        "vowel_len_contrast": _mean(long_rel, 1.0) - _mean(short_rel, 1.0),
        "phones_per_sec": len(phones) / total_sec,
        "stress_dur_hit": _mean([w["w_stress_dur_hit"] for w in multi], 0.5),
        "stress_dur_ratio": _mean([w["w_stress_dur_ratio"] for w in multi], 1.0),
        "stress_conf_ratio": _mean([w["w_stress_conf_gap"] for w in multi], 0.0),
        "insert_ratio": hyp_len / ref_len,
        **align_rates(raw),
        "final_cons_dur": _mean(final_cons, 1.0),
        # 没有词模型时给中性值：句模型于是退化成纯句级特征，不会因为缺件出怪分
        "phone_pred_mean": _mean(ppred, 2.0),
        "phone_pred_min": min(ppred) if ppred else 2.0,
        "phone_pred_p10": _percentile(ppred, 0.10, 2.0),
        "phone_pred_low_rate": (
            sum(1 for x in ppred if x < PHONE_LOW) / len(ppred) if ppred else 0.0
        ),
        "phone_pred_worst3": _worst_k(ppred, 3, 2.0),
        "word_pred_mean": _mean(preds, 8.0),
        "word_pred_min": min(preds) if preds else 8.0,
        "word_pred_low_rate": (
            sum(1 for p in preds if p < WORD_LOW) / len(preds) if preds else 0.0
        ),
        "word_pred_worst2": _worst_k(preds, 2, 8.0),
    }


def apply_score_map(value: float, score_map: dict | None) -> float:
    """把模型输出映回专家刻度（分段线性插值）。没有映射表就原样返回。

    拟合秩的模型输出是「排第几」，不是「专家会打几分」。映射表由校准脚本
    从 train 的预测分位数与专家分位数对齐得到——单调变换，不影响 Spearman ρ，
    只把刻度换回人能读的那个。
    """
    if not score_map:
        return value
    xs = score_map.get("pred") or []
    ys = score_map.get("expert") or []
    if len(xs) < 2 or len(xs) != len(ys):
        return value
    if value <= xs[0]:
        return float(ys[0])
    if value >= xs[-1]:
        return float(ys[-1])
    for i in range(1, len(xs)):
        if value <= xs[i]:
            span = xs[i] - xs[i - 1]
            t = (value - xs[i - 1]) / span if span else 0.0
            return float(ys[i - 1] + t * (ys[i] - ys[i - 1]))
    return float(ys[-1])


def feature_vector(feats: dict[str, float]) -> list[float]:
    """按 `FEATURE_NAMES` 的固定顺序取值。顺序错了模型就全乱，所以只有这一个出口。"""
    return [float(feats.get(name, 0.0)) for name in FEATURE_NAMES]

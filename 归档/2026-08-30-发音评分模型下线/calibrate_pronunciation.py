"""发音评分校准（FR-399、AC-95）。

用法（server 目录）：
    # 第一步：抽原始量（慢，0.5 秒/条），产物可反复用
    uv run python scripts/extract_pronunciation_features.py --split train
    uv run python scripts/extract_pronunciation_features.py --split test
    # 第二步：拟合与评估（秒级，可反复调）
    uv run python scripts/calibrate_pronunciation.py
    uv run python scripts/calibrate_pronunciation.py --ablate       # 逐组特征看贡献
    uv run python scripts/calibrate_pronunciation.py --experiments  # 模型形态与超参一次比完
    uv run python scripts/calibrate_pronunciation.py --report

> [!danger] 跳过校准，打分就是玄学
>
> FR-399c 原话。这个脚本就是把「猜」换成「拟合」的那一步——
> 而且它真的推翻过一版算法：首版只用 CTC 对齐置信度，ρ 只有 0.246。

**在 train 上拟合，在 test 上评估**。单特征单调映射时同集拟合评估不影响 ρ，
多特征线性模型就不行了——同集报出来的数会因为过拟合虚高。
基准表（音素时长、音素 GOP 均值方差）同样只用 train 统计，否则是泄漏。

产物 `data/phonetics/calibration.json` 含：音素基准表、三级模型权重、
各维度在 test 上的 Spearman ρ。运行时由 `domain/pronunciation.load_calibration()` 读。

对照锚点：OpenPronounce 用 500 条拟合出 ρ=0.65。
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from domain.pron_features import (  # noqa: E402
    FEATURE_NAMES,
    PHONE_FEATURE_NAMES,
    STRESS_FEATURES,
    WORD_FEATURE_NAMES,
    Refs,
    build_features,
    build_phone_features,
    build_word_features,
    phone_vector,
    word_vector,
)

ROOT = Path(__file__).resolve().parent.parent.parent / "data" / "phonetics"
OUT = ROOT / "calibration.json"

# 特征分组，用于消融：看清每一组到底贡献了多少
GROUPS = {
    "gop": ("gop_mean", "gop_low_rate", "gop_p10", "gop_vowel_mean"),
    "gopz": ("gop_z_mean", "gop_z_p10", "gop_z_low_rate", "gop_z_worst3"),
    "frame": ("top1_mean", "top1_low_rate", "margin_p10", "entropy_mean"),
    "duration": ("dur_dev", "dur_outlier_rate", "vowel_len_contrast", "phones_per_sec"),
    "stress": STRESS_FEATURES,
    "shape": ("insert_ratio", "final_cons_dur"),
    "align": ("per", "sub_rate", "del_rate", "ins_rate"),
    "wordmodel": ("word_pred_mean", "word_pred_min", "word_pred_low_rate", "word_pred_worst2"),
    "phonemodel": (
        "phone_pred_mean",
        "phone_pred_min",
        "phone_pred_p10",
        "phone_pred_low_rate",
        "phone_pred_worst3",
    ),
}
# 上线口径：去掉重音三项（语料无方差，见 STRESS_NOTE）
MODEL_FEATURES = tuple(n for n in FEATURE_NAMES if n not in STRESS_FEATURES)


# ─────────────── 统计 ───────────────


def ranks(v: list[float]) -> list[float]:
    """并列取平均秩。满分扎堆的标签下，并列处理不对会让 ρ 整体偏低。"""
    order = sorted(range(len(v)), key=lambda i: v[i])
    out = [0.0] * len(v)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            out[order[k]] = avg
        i = j + 1
    return out


def spearman(xs: list[float], ys: list[float]) -> float:
    """秩相关。自己实现是为了不给运行时镜像塞一个 scipy。"""
    if len(xs) < 3:
        return 0.0
    rx, ry = ranks(xs), ranks(ys)
    n = len(xs)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry, strict=True))
    dx = sum((a - mx) ** 2 for a in rx) ** 0.5
    dy = sum((b - my) ** 2 for b in ry) ** 0.5
    return num / (dx * dy) if dx and dy else 0.0


def rho_ci(rho: float, n: int) -> tuple[float, float]:
    """Fisher z 变换给的 95% 置信区间。用来判断两个 ρ 的差是不是噪声。"""
    import math

    if n < 5 or abs(rho) >= 1:
        return (rho, rho)
    z = 0.5 * math.log((1 + rho) / (1 - rho))
    se = 1 / math.sqrt(n - 3)
    lo, hi = z - 1.96 * se, z + 1.96 * se
    return (math.tanh(lo), math.tanh(hi))


def cluster_ci(
    pred: list[float],
    y: list[float],
    speakers: list[str],
    n_boot: int = 600,
) -> tuple[float, float]:
    """按**说话人**自助的 95% 区间。

    > [!danger] Fisher-z 在这份语料上把不确定度算窄了一倍
    >
    > `rho_ci` 假设 2500 条语料互相独立，而 speechocean762 是 125 个说话人
    > 每人 20 句，同一个人的句子高度相关。有效样本量远小于 2500，
    > 名义区间宽度只有真实的一半左右——照它判断「涨了没有」会把噪声当成改进。
    >
    > 重采样的单位必须是说话人而不是句子：抽句子等于假装它们独立，
    > 那样自助出来的区间和 Fisher-z 一样窄。
    """
    import random

    by_spk: dict[str, list[int]] = {}
    for i, sp in enumerate(speakers):
        by_spk.setdefault(sp, []).append(i)
    keys = sorted(by_spk)
    if len(keys) < 10:
        return rho_ci(spearman(pred, y), len(pred))

    rng = random.Random(20260819)
    stats: list[float] = []
    for _ in range(n_boot):
        idx: list[int] = []
        for _ in range(len(keys)):
            idx.extend(by_spk[keys[rng.randrange(len(keys))]])
        stats.append(spearman([pred[i] for i in idx], [y[i] for i in idx]))
    stats.sort()
    lo = stats[int(0.025 * len(stats))]
    hi = stats[min(len(stats) - 1, int(0.975 * len(stats)))]
    return lo, hi


def ridge_fit(X: list[list[float]], y: list[float], alpha: float = 1.0) -> list[float]:
    """带截距的岭回归。

    用岭不用普通最小二乘：几个特征彼此相关（`gop_mean` 与 `gop_p10` 尤其），
    OLS 在共线上会给出绝对值很大、互相抵消的系数——数值上拟合得好，
    换一批数据就翻车。alpha 由 `--alpha` 可调，默认 1.0。

    标准化用的均值方差只来自传进来的这批数据（调用方保证是 train）。
    """
    import numpy as np

    A = np.asarray(X, dtype=np.float64)
    # 标准化后再加惩罚，否则量纲大的特征（phones_per_sec ~ 10）被罚得比小的重
    mu, sigma = A.mean(axis=0), A.std(axis=0)
    sigma[sigma < 1e-9] = 1.0
    Z = (A - mu) / sigma
    Z = np.hstack([Z, np.ones((Z.shape[0], 1))])
    b = np.asarray(y, dtype=np.float64)
    reg = alpha * np.eye(Z.shape[1])
    reg[-1, -1] = 0.0  # 不惩罚截距
    w = np.linalg.solve(Z.T @ Z + reg, Z.T @ b)
    # 折回原始量纲，调用方直接点乘原始特征即可
    coef = w[:-1] / sigma
    intercept = float(w[-1] - (w[:-1] * mu / sigma).sum())
    return [*coef.tolist(), intercept]


def quantile_map(pred: list[float], y: list[float], k: int = 21) -> dict:
    """预测值 → 专家刻度的分位数对齐表。

    拟合秩的模型输出是「排第几」；把它的分位数与专家分的分位数对齐，
    就换回了 0-10 刻度。单调变换不改 Spearman ρ，只改刻度。
    """
    if len(pred) < k or len(y) < k:
        return {}
    ps, ys = sorted(pred), sorted(y)

    def at(v: list[float], q: float) -> float:
        i = max(0, min(len(v) - 1, int(round(q * (len(v) - 1)))))
        return float(v[i])

    qs = [i / (k - 1) for i in range(k)]
    return {
        "pred": [round(at(ps, q), 6) for q in qs],
        "expert": [round(at(ys, q), 4) for q in qs],
    }


def predict(weights: list[float], vec: list[float]) -> float:
    return sum(w * x for w, x in zip(weights[:-1], vec, strict=True)) + weights[-1]


# ─────────────── 数据 ───────────────


def tie_ceiling(y: list[float]) -> float:
    """给定这组标签的并列结构，Spearman 能到的最大值。

    专家分是 0-10 的整数且严重扎堆，一个**排序完全正确**的连续预测值也拿不到 1.0：
    并列组内部预测值必然有先后，而标签的秩是相同的。这部分损失与模型无关，
    不把它算出来，就没法判断「0.58 是模型差还是标签就这样」。
    """
    r = ranks(y)
    n = len(y)
    if n < 3:
        return 0.0
    mr = sum(r) / n
    sd_r = (sum((a - mr) ** 2 for a in r) / n) ** 0.5
    ideal = list(range(1, n + 1))
    mi = sum(ideal) / n
    sd_i = (sum((a - mi) ** 2 for a in ideal) / n) ** 0.5
    return sd_r / sd_i if sd_i else 0.0


def human_ceiling(split: str) -> dict:
    """人自己能做到多少：每位专家 vs 另外四位的共识，取平均。

    > [!info] 这个数决定了「够不够好」的判据
    >
    > 官方论文只说「五位专家独立打分」，没报一致性。但每位专家的原始分随数据集
    > 发布在 `resource/scores-detail.json` 里，所以能直接算。
    > 拿单个专家 vs **不含他自己**的四人共识，正是模型所处的位置；
    > 拿专家 vs 发布标签会虚高（他自己就在标签里）。
    """
    detail_path = ROOT / "speechocean762" / "resource" / "scores-detail.json"
    utt2spk = ROOT / "speechocean762" / split / "utt2spk"
    if not detail_path.exists() or not utt2spk.exists():
        return {}
    detail = json.loads(detail_path.read_text(encoding="utf-8"))
    keys = [line.split()[0] for line in utt2spk.read_text(encoding="utf-8").splitlines()]
    keys = [k for k in keys if k in detail and len(detail[k].get("accuracy") or []) == 5]
    if len(keys) < 100:
        return {}
    cols = [[float(detail[k]["accuracy"][i]) for k in keys] for i in range(5)]
    per_rater = []
    for i in range(5):
        rest = [
            sum(cols[j][t] for j in range(5) if j != i) / 4.0 for t in range(len(keys))
        ]
        per_rater.append(spearman(cols[i], rest))
    pairs = [spearman(cols[i], cols[j]) for i in range(5) for j in range(i + 1, 5)]
    return {
        "n": len(keys),
        "expert_vs_peer_consensus": round(sum(per_rater) / len(per_rater), 4),
        "per_rater": [round(v, 4) for v in per_rater],
        "pairwise_mean": round(sum(pairs) / len(pairs), 4),
    }


def load(split: str) -> list[dict]:
    path = ROOT / f"raw_{split}.jsonl"
    if not path.exists():
        print(f"缺 {path}，先跑 extract_pronunciation_features.py --split {split}")
        sys.exit(1)
    out, broken = [], 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            # 抽取还在跑的时候可以先拟合看趋势，最后一行可能只写了一半
            broken += 1
    if broken:
        print(f"{split}：跳过 {broken} 行不完整记录（抽取仍在进行？）")
    return out


def prepare(
    records: list[dict],
    refs: Refs,
    names: tuple[str, ...],
    word_weights: list[float] | None = None,
    phone_weights: list[float] | None = None,
):
    X, y_acc, y_total = [], [], []
    for r in records:
        feats = build_features(r["raw"], refs, word_weights, phone_weights)
        X.append([float(feats.get(n, 0.0)) for n in names])
        y_acc.append(float(r["expert"].get("accuracy") or 0))
        y_total.append(float(r["expert"].get("total") or 0))
    return X, y_acc, y_total


def phone_dataset(records: list[dict], refs: Refs, scores: dict):
    """音素级样本。

    espeak 的 IPA 音素与 speechocean762 的 ARPAbet 音素**按词内位置对齐**——
    同一个词的两种音标转写，逐位对应在音素数相同时可靠。数不同的词整词跳过
    （实测约 8%）。对不齐的标签比没有标签更糟。
    """
    X, y = [], []
    for r in records:
        gold_words = (scores.get(r["utt"]) or {}).get("words") or []
        feats = build_phone_features(r["raw"], refs)
        by_word: dict[int, list[dict]] = {}
        for f in feats:
            by_word.setdefault(f["word"], []).append(f)
        if len(by_word) != len(gold_words):
            continue
        for wi, gw in zip(sorted(by_word), gold_words, strict=True):
            mine = by_word[wi]
            gold_acc = gw.get("phones-accuracy") or []
            if len(mine) != len(gold_acc):
                continue
            for f, a in zip(mine, gold_acc, strict=True):
                if a is None:
                    continue
                X.append(phone_vector(f, refs))
                y.append(float(a))
    return X, y


def word_dataset(records: list[dict], refs: Refs, phone_weights: list[float] | None):
    """词级样本。词数对不上的语料整条跳过（espeak 偶尔把 "for the" 并成一个 token，约 2%）。"""
    X, y = [], []
    for r in records:
        gold = r["expert"].get("word_accuracy") or []
        feats = build_word_features(r["raw"], refs, phone_weights)
        if len(feats) != len(gold) or not gold:
            continue
        for wf, g in zip(feats, gold, strict=True):
            if g is None:
                continue
            X.append(word_vector(wf))
            y.append(float(g))
    return X, y


def fit_phone_model(
    records: list[dict], refs: Refs, scores: dict, alpha: float
) -> tuple[list[float], int]:
    X, y = phone_dataset(records, refs, scores)
    if len(X) < 500:
        return [], 0
    return ridge_fit(X, y, alpha), len(X)


def fit_word_model(
    records: list[dict],
    refs: Refs,
    alpha: float,
    phone_weights: list[float] | None = None,
) -> tuple[list[float], int]:
    X, y = word_dataset(records, refs, phone_weights)
    if len(X) < 200:
        return [], 0
    return ridge_fit(X, y, alpha), len(X)


def speaker_of(utt: str, table: dict[str, str]) -> str:
    """语料 id → 说话人 id。查不到时退回 id 前四位（speechocean762 的编号规则）。"""
    return table.get(utt) or utt[:4]


def load_utt2spk(split: str) -> dict[str, str]:
    path = ROOT / "speechocean762" / split / "utt2spk"
    if not path.exists():
        return {}
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) == 2:
            out[parts[0]] = parts[1]
    return out


def oof_prepare(
    train: list[dict],
    scores: dict,
    names: tuple[str, ...],
    alpha: float,
    k: int = 5,
):
    """交叉折外（out-of-fold）构造句级训练特征。

    > [!danger] 同集堆叠会让句模型高估子模型
    >
    > 音素/词模型在 train 上拟合，再拿它们在**同一批 train** 上的预测当句级特征，
    > 这些预测天然比在新数据上准（模型见过这些行）。句模型于是给
    > `word_pred_*` / `phone_pred_*` 压上过高的权重，换到 test 就掉。
    > 折外预测让训练期看到的子模型输出与线上一样「没见过」。

    基准表也逐折重建：它同样是从 train 统计出来的量，留在折内就是同一类泄漏。
    """
    # **按说话人分折**。同一个人的几十条语料口音一致，散进不同折等于让子模型
    # 提前见过这个人的发音——折外的意义就没了。官方 train/test 划分本身也是
    # 说话人零重叠（各 125 人），这里保持同一口径
    spk = load_utt2spk("train")
    by_spk: dict[str, list[dict]] = {}
    for r in train:
        by_spk.setdefault(speaker_of(r["utt"], spk), []).append(r)
    speakers = sorted(by_spk)
    folds = [
        [r for si in speakers[i::k] for r in by_spk[si]]
        for i in range(k)
    ]
    X, y_acc, y_total = [], [], []
    for i in range(k):
        hold = folds[i]
        rest = [r for j, f in enumerate(folds) if j != i for r in f]
        if not hold or not rest:
            continue
        refs_i = Refs.build(rest)
        pw, _ = fit_phone_model(rest, refs_i, scores, alpha)
        ww, _ = fit_word_model(rest, refs_i, alpha, pw)
        Xi, ya, yt = prepare(hold, refs_i, names, ww, pw)
        X += Xi
        y_acc += ya
        y_total += yt
    return X, y_acc, y_total


# ─────────────── 主流程 ───────────────


def evaluate(
    names: tuple[str, ...],
    train: list[dict],
    test: list[dict],
    refs: Refs,
    alpha: float,
    word_weights: list[float] | None = None,
    phone_weights: list[float] | None = None,
    rank_target: bool = False,
    squares: tuple[str, ...] = (),
    oof: dict | None = None,
):
    if oof is not None:
        Xtr, ytr, _ = oof_prepare(train, oof["scores"], names, oof["alpha"])
    else:
        Xtr, ytr, _ = prepare(train, refs, names, word_weights, phone_weights)
    Xte, yte, yte_total = prepare(test, refs, names, word_weights, phone_weights)
    if squares:
        cols = [names.index(s) for s in squares if s in names]
        Xtr = [x + [x[c] ** 2 for c in cols] for x in Xtr]
        Xte = [x + [x[c] ** 2 for c in cols] for x in Xte]
    # 拟合秩而不是原分：让模型不去迁就满分扎堆那一大坨，
    # 代价是输出不再是「专家会打几分」，可解读性没了
    target = ranks(ytr) if rank_target else ytr
    w = ridge_fit(Xtr, target, alpha)
    pred = [predict(w, x) for x in Xte]
    # 拟合秩时输出不是专家刻度，配一张分位数对齐表把它换回来
    smap = quantile_map([predict(w, x) for x in Xtr], ytr) if rank_target else {}
    return {
        "weights": w,
        "score_map": smap,
        "rho_accuracy": spearman(pred, yte),
        "rho_total": spearman(pred, yte_total),
        "pred": pred,
    }


def sub_models(train: list[dict], refs: Refs, scores: dict, alpha: float):
    phone_w, n_phones = fit_phone_model(train, refs, scores, alpha)
    word_w, n_words = fit_word_model(train, refs, alpha, phone_w)
    return phone_w, n_phones, word_w, n_words


def split_by_speaker(records: list[dict], every: int = 5) -> tuple[list[dict], list[dict]]:
    """把 train 切成拟合集与验证集，**按说话人切**。

    每 `every` 个说话人抽 1 个进验证集。同一个人的语料必须整组同去向——
    散开就等于让模型提前听过这个人的口音，验证集报的数会偏高。
    """
    spk = load_utt2spk("train")
    by: dict[str, list[dict]] = {}
    for r in records:
        by.setdefault(speaker_of(r["utt"], spk), []).append(r)
    speakers = sorted(by)
    val_spk = set(speakers[::every])
    fit = [r for si in speakers if si not in val_spk for r in by[si]]
    val = [r for si in speakers if si in val_spk for r in by[si]]
    return fit, val


def run_experiments(train, test, refs, scores, base_alpha: float) -> None:
    """一次比完模型形态与超参。

    > [!danger] 选型不能在 test 上做
    >
    > 在 test 上挑 alpha 与模型形态，再报同一个 test 的 ρ，报出来的是**挑出来的**数——
    > 变体越多虚高越明显。所以选型全部在从 train 里按说话人切出的验证集上完成，
    > test 只在最后动一次，用来报赢家的成绩。
    """
    fit, val = split_by_speaker(train)
    refs_fit = Refs.build(fit)
    print(f"\n选型用：拟合 {len(fit)} 条 / 验证 {len(val)} 条（按说话人切，与 test 无关）")

    print("\n══ 实验一：子模型 alpha ══")
    print(f"{'子模型 alpha':<16}{'验证集 ρ':>14}")
    best_sub, best_rho = base_alpha, -1.0
    cache: dict[float, tuple] = {}
    for a in (0.3, 1.0, 3.0, 10.0, 30.0):
        pw, _, ww, _ = sub_models(fit, refs_fit, scores, a)
        cache[a] = (pw, ww)
        r = evaluate(MODEL_FEATURES, fit, val, refs_fit, base_alpha, ww, pw)
        print(f"{a:<16.1f}{r['rho_accuracy']:>14.3f}")
        if r["rho_accuracy"] > best_rho:
            best_sub, best_rho = a, r["rho_accuracy"]
    phone_f, word_f = cache[best_sub]
    print(f"→ 子模型 alpha 取 {best_sub}（验证 ρ={best_rho:.3f}）")

    print("\n══ 实验二：句模型 alpha ══")
    print(f"{'句模型 alpha':<16}{'验证集 ρ':>14}")
    best_alpha, best_rho2 = base_alpha, -1.0
    for a in (0.1, 0.3, 1.0, 3.0, 10.0, 30.0, 100.0, 300.0, 1000.0, 3000.0):
        r = evaluate(MODEL_FEATURES, fit, val, refs_fit, a, word_f, phone_f)
        print(f"{a:<16.1f}{r['rho_accuracy']:>14.3f}")
        if r["rho_accuracy"] > best_rho2:
            best_alpha, best_rho2 = a, r["rho_accuracy"]
    print(f"→ 句模型 alpha 取 {best_alpha}（验证 ρ={best_rho2:.3f}）")

    print("\n══ 实验三：模型形态 ══")
    # 单特征 |ρ| 最大的几项加二次项：非线性主要可能出现在最强的那几维上。
    # 强弱也在验证集上判，不看 test
    Xv, yv, _ = prepare(val, refs_fit, MODEL_FEATURES, word_f, phone_f)
    strength = sorted(
        ((abs(spearman([x[i] for x in Xv], yv)), n) for i, n in enumerate(MODEL_FEATURES)),
        reverse=True,
    )
    top = tuple(n for _, n in strength[:5])
    oof_cfg = {"scores": scores, "alpha": best_sub}
    variants = [
        ("基线线性", {}),
        (f"+ 二次项（{len(top)} 项最强特征）", {"squares": top}),
        ("拟合秩（可解读性换 ρ）", {"rank_target": True}),
        ("秩 + 二次项", {"rank_target": True, "squares": top}),
        ("折外堆叠", {"oof": oof_cfg}),
        ("折外堆叠 + 二次项", {"oof": oof_cfg, "squares": top}),
        ("折外堆叠 + 秩", {"oof": oof_cfg, "rank_target": True}),
    ]
    print(f"{'变体':<30}{'验证集 ρ':>14}")
    results = {}
    for label, kw in variants:
        r = evaluate(MODEL_FEATURES, fit, val, refs_fit, best_alpha, word_f, phone_f, **kw)
        results[label] = r["rho_accuracy"]
        print(f"{label:<30}{r['rho_accuracy']:>14.3f}")

    best_label = max(results, key=lambda k: results[k])
    print(f"\n验证集上最好的是「{best_label}」ρ={results[best_label]:.3f}")
    print(f"验证集最强单特征：{', '.join(f'{n}({s:.3f})' for s, n in strength[:5])}")

    # 只到这里才碰 test：用全量 train 重新拟合，报一次成绩。
    # 赢家与「基线线性」都报——赢家若是拟合秩，它的输出不再是专家刻度，
    # 值不值得为这点 ρ 换掉可解读性，要看两个数摆在一起
    phone_w, _, word_w, _ = sub_models(train, refs, scores, best_sub)
    labels = [a for a, _ in variants]
    for tag, label in (("赢家", best_label), ("基线线性（可解读）", "基线线性")):
        kw = dict(variants[labels.index(label)][1])
        final = evaluate(MODEL_FEATURES, train, test, refs, best_alpha, word_w, phone_w, **kw)
        lo, hi = rho_ci(final["rho_accuracy"], len(test))
        print(
            f"\n{tag}「{label}」在 test 上：ρ(accuracy)={final['rho_accuracy']:.3f} "
            f"95% CI [{lo:.3f}, {hi:.3f}]，ρ(total)={final['rho_total']:.3f}（n={len(test)}）"
        )
    print(
        "\n置信区间是判断「涨了没有」的唯一依据："
        "两个变体的 CI 大面积重叠时，差的那 0.01 就是噪声，不要当成改进。"
    )


def run(alpha: float, ablate: bool, experiments: bool, oof: bool, rank_target: bool) -> None:
    train, test = load("train"), load("test")
    print(f"train {len(train)} 条，test {len(test)} 条")

    refs = Refs.build(train)
    print(
        f"基准表（只用 train 里专家 accuracy ≥9 的语料统计）："
        f"时长 {len(refs.dur)} 个音素、GOP {len(refs.gop)} 个音素"
    )

    scores = json.loads((ROOT / "so762_scores.json").read_text(encoding="utf-8"))
    phone_w, n_phones = fit_phone_model(train, refs, scores, alpha)
    if phone_w:
        px, py = phone_dataset(test, refs, scores)
        pred = [predict(phone_w, v) for v in px]
        # 三级 ρ 必须各自配天花板才有可比性：音素级 82% 的标注是满分 2.0、
        # 词级 89% 是满分 10，并列把它们的上限压得比句级低得多。
        # 不给上限，「词级 0.33」读起来像比「句级 0.58」差一半，其实达成率相当
        cap = tie_ceiling(py)
        print(
            f"音素模型：train {n_phones} 个音素 → test {len(px)} 个，"
            f"音素级 ρ={spearman(pred, py):.3f}（上限 {cap:.3f}，达成 "
            f"{spearman(pred, py) / cap * 100 if cap else 0:.0f}%）"
        )
    else:
        print("音素级样本不足，跳过音素模型")

    word_w, n_words = fit_word_model(train, refs, alpha, phone_w)
    if word_w:
        wx, wy = word_dataset(test, refs, phone_w)
        pred = [predict(word_w, v) for v in wx]
        cap = tie_ceiling(wy)
        print(
            f"词模型：train {n_words} 个词 → test {len(wx)} 个词，"
            f"词级 ρ={spearman(pred, wy):.3f}（上限 {cap:.3f}，达成 "
            f"{spearman(pred, wy) / cap * 100 if cap else 0:.0f}%）"
        )
    else:
        print("词级样本不足，跳过词模型")

    if experiments:
        run_experiments(train, test, refs, scores, alpha)
        return

    if ablate:
        print(f"\n{'特征组':<28}{'test ρ(accuracy)':>18}{'test ρ(total)':>16}")
        combos = [
            ("仅 GOP", GROUPS["gop"]),
            ("仅归一化 GOP", GROUPS["gopz"]),
            ("仅时长", GROUPS["duration"]),
            ("仅重音", GROUPS["stress"]),
            ("仅词模型聚合", GROUPS["wordmodel"]),
            ("仅音素模型聚合", GROUPS["phonemodel"]),
            ("仅帧级后验", GROUPS["frame"]),
            ("仅自由解码编辑距离", GROUPS["align"]),
            ("GOP + 归一化 GOP", GROUPS["gop"] + GROUPS["gopz"]),
            ("GOP + 帧级后验", GROUPS["gop"] + GROUPS["frame"]),
            ("GOP + 编辑距离", GROUPS["gop"] + GROUPS["align"]),
            ("归一化 GOP + 帧级后验", GROUPS["gopz"] + GROUPS["frame"]),
            ("GOP + 时长", GROUPS["gop"] + GROUPS["duration"]),
            ("GOP + 重音", GROUPS["gop"] + GROUPS["stress"]),
            ("GOP + 时长 + 形态", GROUPS["gop"] + GROUPS["duration"] + GROUPS["shape"]),
            ("上线口径（去重音）", MODEL_FEATURES),
            ("全部（含重音）", FEATURE_NAMES),
        ]
        for label, names in combos:
            r = evaluate(names, train, test, refs, alpha, word_w, phone_w)
            print(f"{label:<28}{r['rho_accuracy']:>18.3f}{r['rho_total']:>16.3f}")
        return

    oof_cfg = {"scores": scores, "alpha": alpha} if oof else None
    full = evaluate(
        MODEL_FEATURES, train, test, refs, alpha, word_w, phone_w,
        oof=oof_cfg, rank_target=rank_target,
    )
    # 单特征相关性：看清每个特征自己带多少信号（符号也要看，负相关是正常的）
    Xte, yte, _ = prepare(test, refs, FEATURE_NAMES, word_w, phone_w)
    print(f"\n{'单特征':<22}{'与专家 accuracy 的 ρ':>22}")
    singles = {}
    for i, name in enumerate(FEATURE_NAMES):
        rho = spearman([x[i] for x in Xte], yte)
        singles[name] = round(rho, 4)
        print(f"{name:<22}{rho:>22.3f}")

    spk_table = load_utt2spk("test")
    speakers = [speaker_of(r["utt"], spk_table) for r in test]
    lo, hi = cluster_ci(full["pred"], yte, speakers)
    nominal = rho_ci(full["rho_accuracy"], len(test))
    ceil = tie_ceiling(yte)
    human = human_ceiling("test")
    print(f"\n{'模型':<22}{'test ρ(accuracy)':>18}{'test ρ(total)':>16}")
    print(f"{'全特征线性':<22}{full['rho_accuracy']:>18.3f}{full['rho_total']:>16.3f}")
    print(
        f"95% CI [{lo:.3f}, {hi:.3f}]（按说话人自助，n={len(test)} / "
        f"{len(set(speakers))} 人；名义 Fisher-z 给的是 "
        f"[{nominal[0]:.3f}, {nominal[1]:.3f}]，窄了约 "
        f"{(nominal[1] - nominal[0]) and (hi - lo) / (nominal[1] - nominal[0]):.1f} 倍）"
    )
    print(f"标签并列给的 ρ 上限 {ceil:.3f}，达成 {full['rho_accuracy'] / ceil * 100:.0f}%")
    if human:
        h = human["expert_vs_peer_consensus"]
        print(
            f"人的水平：单个专家预测另外四人的共识 ρ={h:.3f}"
            f"（各人 {min(human['per_rater']):.3f}-{max(human['per_rater']):.3f}，"
            f"两两一致 {human['pairwise_mean']:.3f}，n={human['n']}）"
        )
        print(f"→ 模型达到人的 {full['rho_accuracy'] / h * 100:.0f}%")

    report = {
        "n_train": len(train),
        "n_test": len(test),
        "alpha": alpha,
        "features": list(MODEL_FEATURES),
        "weights": [round(w, 6) for w in full["weights"]],
        "word_features": list(WORD_FEATURE_NAMES),
        "word_weights": [round(w, 6) for w in word_w] if word_w else [],
        "n_train_words": n_words,
        "phone_features": list(PHONE_FEATURE_NAMES),
        "phone_weights": [round(w, 6) for w in phone_w] if phone_w else [],
        "n_train_phones": n_phones,
        "stress_excluded": list(STRESS_FEATURES),
        "oof_stacking": oof,
        "rank_target": rank_target,
        "score_map": full.get("score_map") or None,
        "refs": refs.to_json(),
        "rho": {
            "accuracy": round(full["rho_accuracy"], 4),
            "accuracy_ci": [round(lo, 4), round(hi, 4)],
            "accuracy_ci_method": "按说话人聚类自助 600 次；Fisher-z 的 iid 假设在本语料不成立",
            "total": round(full["rho_total"], 4),
        },
        "single_feature_rho": singles,
        "tie_ceiling": round(ceil, 4),
        "human_ceiling": human,
        "expert_scale": 10,
        "anchor": "OpenPronounce 用 500 条拟合出 ρ=0.65",
        "protocol": "在 train 上拟合，在 test 上评估；基准表也只用 train 统计",
        "completeness_note": (
            "completeness 不由本模型给：它来自 diff_words 的词级比对，"
            "与声学特征无关，也不需要校准。"
        ),
    }
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n已写入 {OUT}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--alpha", type=float, default=1.0)
    ap.add_argument("--ablate", action="store_true", help="逐组特征看贡献")
    ap.add_argument("--experiments", action="store_true", help="模型形态与超参一次比完")
    ap.add_argument("--oof", action="store_true", help="句模型用折外堆叠特征拟合")
    ap.add_argument("--rank", action="store_true", help="拟合秩而非原分，配分位数映射换回刻度")
    ap.add_argument("--report", action="store_true")
    args = ap.parse_args()
    if args.report:
        if not OUT.exists():
            print("还没跑过校准")
            sys.exit(1)
        print(OUT.read_text(encoding="utf-8"))
        return
    run(args.alpha, args.ablate, args.experiments, args.oof, args.rank)


if __name__ == "__main__":
    main()

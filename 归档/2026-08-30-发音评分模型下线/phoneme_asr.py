"""音素识别与 GOP（FR-398 第 1/2 层）。

两件新件：

| 件 | 规格 |
| --- | --- |
| `wav2vec2-lv-60-espeak-cv-ft-ONNX` 的 `model_int8.onnx` | 318 MB，Apache-2.0，392-token IPA 词表 |
| `espeak-ng` 二进制 | 生成参考音素序列，**只当外部命令调**，不链接库（规避 GPL 传染） |

与已跑通的 MMS-300M **完全同架构**（wav2vec2-large，`inputs_to_logits_ratio=320`），
单例加载照抄 `domain/alignment.py` 的 `_get_aligner` 模式。

> [!warning] 这一层的结论精度天花板很低
>
> 开源最强英文 IPA 模型在带口音语音上的 PER 约 19%，词级误读标注 precision 约 20%。
> 所以本模块的输出一律叫 `hint` 不叫 `error`，且每条都带 `confidence`——
> BR-90 要求音素级只给推测语气与弱视觉权重，那条规则在这里落地成数据形状。
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from domain.kernel.capability_seam import (
    CapabilitySeam,
    PreparedRoute,
    RouteRequest,
    RouteSnapshot,
)
from domain.plugin_runtime import RegistrationHandle

logger = logging.getLogger(__name__)

MODEL_DIR = Path(__file__).resolve().parent.parent / "data" / "models" / "wav2vec2-espeak"
SAMPLE_RATE = 16000
# wav2vec2-large 的下采样率：每 320 个采样点出一帧 logits
INPUTS_TO_LOGITS_RATIO = 320
ESPEAK_VOICE = "en-us"

_session = None
_vocab: dict[str, int] | None = None
_id2tok: list[str] | None = None
_lock = threading.Lock()


class PhonemeAsrUnavailable(RuntimeError):
    """缺模型或缺 espeak-ng。属于「这层没开」，不是错误。"""


# ─────────────── 参考音素序列（espeak-ng） ───────────────


def espeak_available() -> bool:
    return shutil.which("espeak-ng") is not None


def reference_phonemes(text: str) -> list[str]:
    """英文句子 → IPA 音素序列（espeak-ng 记法）。

    必须用 espeak-ng 而不是 ipa-dict：音素识别模型本身就是 espeak G2P 训练的，
    符号体系不同源会造成**系统性误报**（BR-91）。
    """
    if not espeak_available():
        raise PhonemeAsrUnavailable("espeak-ng 未安装")
    proc = subprocess.run(
        ["espeak-ng", "-v", ESPEAK_VOICE, "-q", "--ipa=1", text],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    if proc.returncode != 0:
        raise PhonemeAsrUnavailable(f"espeak-ng 失败：{proc.stderr.strip()[:120]}")
    return _split_espeak(proc.stdout)


def _split_espeak(raw: str) -> list[str]:
    """`--ipa=1` 用下划线分音素、空格分词。重音记号不是音素，剥掉。"""
    return [p.symbol for p in _split_espeak_rich(raw)]


@dataclass(frozen=True)
class RefPhone:
    """参考音素 + 它在句子里的位置信息。

    重音与词边界原先被 `_split_espeak` 一起丢掉了。丢掉它们，评分就只剩
    「每个音单独读得像不像」，读不出「重音放错了音节」——而后者恰恰是
    中国学习者最典型的问题之一，speechocean762 也单独给了词级 stress 分。
    """

    symbol: str
    stress: int  # 0 无 / 1 主重音 / 2 次重音
    word_idx: int
    is_vowel: bool


# espeak 的元音符号集合（含 r 化与双元音的首字符）
_VOWEL_STARTS = "aeiouæɑɐɒɔəɚɛɜɝɪʊʌ"


def _split_espeak_rich(raw: str) -> list[RefPhone]:
    out: list[RefPhone] = []
    for wi, word in enumerate(raw.split()):
        for tok in word.split("_"):
            tok = tok.strip()
            if not tok:
                continue
            stress = 1 if tok.startswith("ˈ") else 2 if tok.startswith("ˌ") else 0
            sym = tok.lstrip("ˈˌ")
            if not sym:
                continue
            out.append(
                RefPhone(sym, stress, wi, sym[0] in _VOWEL_STARTS)
            )
    return out


def reference_phones_rich(text: str) -> list[RefPhone]:
    """带重音与词边界的参考音素序列。"""
    if not espeak_available():
        raise PhonemeAsrUnavailable("espeak-ng 未安装")
    proc = subprocess.run(
        ["espeak-ng", "-v", ESPEAK_VOICE, "-q", "--ipa=1", text],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    if proc.returncode != 0:
        raise PhonemeAsrUnavailable(f"espeak-ng 失败：{proc.stderr.strip()[:120]}")
    return _split_espeak_rich(proc.stdout)


# ─────────────── 模型 ───────────────


def _load() -> tuple[object, dict[str, int], list[str]]:
    global _session, _vocab, _id2tok
    if _session is None:
        with _lock:
            if _session is None:
                if not MODEL_DIR.exists():
                    raise PhonemeAsrUnavailable(f"音素模型未下载（{MODEL_DIR}）")
                try:
                    import onnxruntime as ort
                except ImportError as exc:
                    raise PhonemeAsrUnavailable("onnxruntime 未安装") from exc
                # 优先 fp32：实测与 int8 同速（RTF 0.11，M1），没有理由用有损版本。
                # 只下了 int8 时照样能跑，两者解码结果实测一致
                path = next(
                    (MODEL_DIR / n for n in ("model.onnx", "model_int8.onnx")
                     if (MODEL_DIR / n).exists()),
                    None,
                )
                if path is None:
                    raise PhonemeAsrUnavailable(f"{MODEL_DIR} 下没有 model.onnx")
                opts = ort.SessionOptions()
                opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                _session = ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])
                _vocab = json.loads((MODEL_DIR / "vocab.json").read_text(encoding="utf-8"))
                _id2tok = [""] * (max(_vocab.values()) + 1)
                for tok, idx in _vocab.items():
                    _id2tok[idx] = tok
                logger.info("音素识别模型已加载（%d token）", len(_vocab))
    return _session, _vocab, _id2tok  # type: ignore[return-value]


BLANK_ID = 0  # <pad> 即 CTC blank
# 每个音素保留多少个竞争者的 LPR。8 足够刻画竞争格局的形状，
# 再多的都是远低于参考音素的噪声
LPR_TOPK = 8


# 多语言词表里混着别的语言的声调标记（`i1` `i5` 之类）。
# 英文推理时不屏蔽掉，argmax 会挑出这些伪音素（FR-398g）。
def _english_mask(id2tok: list[str]) -> list[bool]:
    """返回每个 token 是否保留。

    > [!danger] blank 永远不能被屏蔽
    >
    > `<pad>` 是 CTC 的 blank，它在静音帧上的概率接近 1.0。把它按「不是英文音素」
    > 一起屏蔽掉，每一帧就都被迫吐出一个真音素——解码结果从
    > `ʃ iː s ɛ l z` 变成 `n t k t ʃ j iː i s j ɛ l d z`，看上去像模型不准，
    > 其实是掩码写错了。首版就踩在这里。
    """
    keep = []
    for i, tok in enumerate(id2tok):
        if i == BLANK_ID:
            keep.append(True)
            continue
        bad = (
            not tok
            or tok.startswith("<")
            or any(ch.isdigit() for ch in tok)  # 声调标记
            or any("一" <= ch <= "鿿" for ch in tok)
        )
        keep.append(not bad)
    return keep


def _log_softmax(x):
    import numpy as np

    m = x.max(axis=-1, keepdims=True)
    e = x - m
    return e - np.log(np.exp(e).sum(axis=-1, keepdims=True))


def emissions(audio) -> tuple[object, list[str]]:
    """波形 → (log_softmax 后的 logits, id→token 表)。"""
    import numpy as np

    session, _vocab_, id2tok = _load()
    x = np.asarray(audio, dtype=np.float32)
    # wav2vec2 的输入要做零均值单位方差归一（preprocessor_config 的 do_normalize）
    x = (x - x.mean()) / (x.std() + 1e-7)
    name = session.get_inputs()[0].name
    logits = session.run(None, {name: x[None, :]})[0][0]
    mask = _english_mask(id2tok)
    for i, keep in enumerate(mask):
        if not keep and i < logits.shape[1]:
            logits[:, i] = -1e9
    return _log_softmax(logits), id2tok


def greedy_phonemes(logp, id2tok: list[str]) -> list[str]:
    """CTC 贪心解码：取 argmax，合并重复，去掉 blank。"""
    import numpy as np

    ids = np.argmax(logp, axis=-1)
    out: list[str] = []
    prev = -1
    for i in ids:
        i = int(i)
        if i != prev and i != BLANK_ID:
            tok = id2tok[i] if i < len(id2tok) else ""
            if tok and not tok.startswith("<"):
                out.append(tok)
        prev = i
    return out


# ─────────────── 音素比对（FR-398f） ───────────────

# 发音特征距离：替换代价按特征差异加权，不用等权编辑距离。
# 规则形状抄 OpenPronounce（MIT）的置信度调整，数值按英语教学常识收敛。
_VOICE_PAIRS = {
    ("p", "b"), ("t", "d"), ("k", "ɡ"), ("f", "v"), ("θ", "ð"),
    ("s", "z"), ("ʃ", "ʒ"), ("tʃ", "dʒ"),
}  # fmt: skip
_LENGTH_PAIRS = {("iː", "ɪ"), ("uː", "ʊ"), ("ɑː", "ʌ"), ("ɔː", "ɒ"), ("ɜː", "ə")}
_NEAR = {("l", "n"), ("n", "ŋ"), ("v", "w"), ("θ", "s"), ("ð", "d"), ("ð", "z"), ("ɹ", "l")}


# 查表一律用无序对：写规则时不必关心哪个音在前
_COST_TABLE: dict[frozenset[str], float] = {
    **{frozenset(p): 0.35 for p in _VOICE_PAIRS},
    **{frozenset(p): 0.40 for p in _LENGTH_PAIRS},
    **{frozenset(p): 0.50 for p in _NEAR},
}
_VOWEL_CHARS = "aeiouæɑɒɔəɛɜɪʊʌ"


def substitution_cost(a: str, b: str) -> float:
    """替换代价 0-1。清浊之别、长短之别、已知易混对都比「完全不同」便宜。"""
    if a == b:
        return 0.0
    hit = _COST_TABLE.get(frozenset((a, b)))
    if hit is not None:
        return hit
    a_v = a[0] in _VOWEL_CHARS
    b_v = b[0] in _VOWEL_CHARS
    return 0.8 if a_v == b_v else 1.0


def align_phonemes(ref: list[str], hyp: list[str]) -> list[tuple[str, str | None, str | None]]:
    """Needleman-Wunsch 全局对齐，替换代价按发音特征加权（FR-398f）。

    返回 [(kind, ref_phone, hyp_phone)]，kind ∈ match|substitution|deletion|insertion。
    """
    n, m = len(ref), len(hyp)
    gap = 0.9
    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = i * gap
    for j in range(1, m + 1):
        dp[0][j] = j * gap
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            dp[i][j] = min(
                dp[i - 1][j - 1] + substitution_cost(ref[i - 1], hyp[j - 1]),
                dp[i - 1][j] + gap,
                dp[i][j - 1] + gap,
            )
    out: list[tuple[str, str | None, str | None]] = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            sub = dp[i - 1][j - 1] + substitution_cost(ref[i - 1], hyp[j - 1])
            if abs(dp[i][j] - sub) < 1e-9:
                kind = "match" if ref[i - 1] == hyp[j - 1] else "substitution"
                out.append((kind, ref[i - 1], hyp[j - 1]))
                i, j = i - 1, j - 1
                continue
        if i > 0 and abs(dp[i][j] - (dp[i - 1][j] + gap)) < 1e-9:
            out.append(("deletion", ref[i - 1], None))
            i -= 1
            continue
        out.append(("insertion", None, hyp[j - 1]))
        j -= 1
    out.reverse()
    return out


# ─────────────── GOP（第 2 层，FR-398h） ───────────────


def gop_scores(logp, ref_ids: list[int]) -> list[float]:
    """GOP(p) = log P(p|frames) − max_q log P(q|frames)。

    帧区间由**强制对齐**给出：`get_alignments(emissions, tokens, tokenizer)` 的词表
    来自 `tokenizer.get_vocab()`，把 IPA 模型的词表传进去就能对参考音素做对齐，
    无需改库代码（FR-398h）。这里用同构的轻量 CTC 对齐（Viterbi），
    避免为一个词表差异引入整套 tokenizer。
    """
    import numpy as np

    T, V = logp.shape
    n = len(ref_ids)
    if n == 0 or T == 0:
        return []
    # 扩展序列：blank 夹在每个 token 之间，标准 CTC 对齐布局
    ext = [0] * (2 * n + 1)
    for k, tok in enumerate(ref_ids):
        ext[2 * k + 1] = tok
    S = len(ext)
    neg = -1e30
    dp = np.full((T, S), neg, dtype=np.float64)
    bp = np.zeros((T, S), dtype=np.int8)
    dp[0, 0] = logp[0, ext[0]]
    if S > 1:
        dp[0, 1] = logp[0, ext[1]]
    for t in range(1, T):
        for s in range(S):
            best, arg = dp[t - 1, s], 0
            if s > 0 and dp[t - 1, s - 1] > best:
                best, arg = dp[t - 1, s - 1], 1
            if s > 1 and ext[s] != 0 and ext[s] != ext[s - 2] and dp[t - 1, s - 2] > best:
                best, arg = dp[t - 1, s - 2], 2
            dp[t, s] = best + logp[t, ext[s]]
            bp[t, s] = arg
    s = S - 1 if S < 2 or dp[T - 1, S - 1] >= dp[T - 1, S - 2] else S - 2
    path = [0] * T
    for t in range(T - 1, -1, -1):
        path[t] = s
        # bp 是 int8；NumPy 2 的弱标量规则会让 `s -= bp[...]` 把 s 也降成 int8，
        # 序列一长（S > 127）就 OverflowError。显式转 int 保持 s 是 Python 整数
        s -= int(bp[t, s])
    # 每个真实 token 的帧区间 → GOP
    frames: dict[int, list[int]] = {}
    for t, s in enumerate(path):
        if s % 2 == 1:
            frames.setdefault(s // 2, []).append(t)
    best_per_frame = logp.max(axis=-1)
    out: list[float] = []
    for k in range(n):
        idx = frames.get(k)
        if not idx:
            out.append(float("nan"))
            continue
        num = float(logp[idx, ref_ids[k]].mean())
        den = float(best_per_frame[idx].mean())
        out.append(round(num - den, 4))
    return out


def phoneme_frames(logp, ref_ids: list[int]) -> list[tuple[int, int]]:
    """参考音素序列 → 每个音素的帧区间 [start, end)。

    与 `gop_scores` 走同一条 Viterbi 路径，所以时间戳与 GOP 天然对齐。
    """
    import numpy as np

    T, _ = logp.shape
    n = len(ref_ids)
    if n == 0 or T == 0:
        return []
    ext = [0] * (2 * n + 1)
    for k, tok in enumerate(ref_ids):
        ext[2 * k + 1] = tok
    S = len(ext)
    neg = -1e30
    dp = np.full((T, S), neg, dtype=np.float64)
    bp = np.zeros((T, S), dtype=np.int8)
    dp[0, 0] = logp[0, ext[0]]
    if S > 1:
        dp[0, 1] = logp[0, ext[1]]
    for t in range(1, T):
        for s_i in range(S):
            best, arg = dp[t - 1, s_i], 0
            if s_i > 0 and dp[t - 1, s_i - 1] > best:
                best, arg = dp[t - 1, s_i - 1], 1
            if (
                s_i > 1
                and ext[s_i] != 0
                and ext[s_i] != ext[s_i - 2]
                and dp[t - 1, s_i - 2] > best
            ):
                best, arg = dp[t - 1, s_i - 2], 2
            dp[t, s_i] = best + logp[t, ext[s_i]]
            bp[t, s_i] = arg
    s_i = S - 1 if S < 2 or dp[T - 1, S - 1] >= dp[T - 1, S - 2] else S - 2
    path = [0] * T
    for t in range(T - 1, -1, -1):
        path[t] = s_i
        s_i -= int(bp[t, s_i])
    spans: dict[int, list[int]] = {}
    for t, s_v in enumerate(path):
        if s_v % 2 == 1:
            spans.setdefault(s_v // 2, []).append(t)
    return [
        (min(spans[k]), max(spans[k]) + 1) if k in spans else (0, 0) for k in range(n)
    ]


def fill_spans(frames: list[tuple[int, int]], total: int) -> list[list[int]]:
    """把 CTC 的峰值帧区间铺满成连续时长。

    CTC 把每个 token 压在一两个峰值帧上，中间全是 blank。原始区间做不了两件事：
    逐音素高亮只亮 20ms 就灭；当时长特征用则每个音素都是 1-2 帧，毫无区分度。
    按相邻音素的中点分配中间的 blank 帧，是 CTC 对齐取时长的标准处理。
    """
    spans = [list(f) for f in frames]
    for k in range(len(spans) - 1):
        gap = spans[k + 1][0] - spans[k][1]
        if gap > 0:
            half = gap // 2
            spans[k][1] += half
            spans[k + 1][0] -= gap - half
    if spans:
        spans[-1][1] = max(spans[-1][1], min(total, spans[-1][1] + 2))
    return spans


def phoneme_timings(audio_path: str, text: str) -> list[dict]:
    """示范音频 → 逐音素时间戳（FR-392h）。

    需求里这条原本要引 Montreal Forced Aligner。**不需要**——
    第 2 层的 GOP 已经在做参考音素的强制对齐了，同一条 Viterbi 路径顺手就给出帧区间。
    引 MFA 等于为已经有的能力再装一套 conda 环境。
    """
    from domain.alignment import decode_audio

    ref = reference_phonemes(text)
    audio = decode_audio(audio_path)
    if not ref or audio is None:
        return []
    logp, id2tok = emissions(audio)
    vocab = {tok: i for i, tok in enumerate(id2tok) if tok}
    ids = [vocab.get(p) for p in ref]
    if any(i is None for i in ids):
        raise PhonemeAsrUnavailable("参考音素不在模型词表内")
    frames = phoneme_frames(logp, [int(i) for i in ids])
    gops = gop_scores(logp, [int(i) for i in ids])
    # 每帧 20ms：wav2vec2-large 的 320 采样点 / 16kHz
    step = INPUTS_TO_LOGITS_RATIO / SAMPLE_RATE
    spans = fill_spans(frames, logp.shape[0])
    out = []
    for k, phone in enumerate(ref):
        lo, hi = spans[k]
        g = gops[k] if k < len(gops) else float("nan")
        out.append(
            {
                "phone": phone,
                "start": round(lo * step, 3),
                "end": round(hi * step, 3),
                "gop": None if g != g else round(g, 3),
            }
        )
    return out


# ─────────────── 对外入口 ───────────────


def load_emissions(audio_path: str) -> tuple[object, list[str]]:
    """音频文件 → (log 后验, id→token)。

    单独抽出来是为了**一段音频只推理一次**：一次评测既要音素级提示
    （`phoneme_diagnose`）又要打分用的原始量（`analyze_utterance`），
    两边各自解码等于把 ONNX 前向跑了两遍，延迟直接翻倍。
    """
    from domain.alignment import decode_audio

    audio = decode_audio(audio_path)
    if audio is None:
        raise PhonemeAsrUnavailable("音频无音轨")
    return emissions(audio)


def _frame_stats(logp, ref_id: int, lo: int, hi: int, id2tok: list[str] | None = None) -> dict:
    """峰值铺满区间内的后验统计。**比较只在真音素之间做，blank 一律排除**。

    > [!danger] 不排除 blank，量到的是「CTC 峰有多尖」而不是「读得对不对」
    >
    > CTC 把 token 压在 1-2 个峰值帧上，铺满区间里多数帧的最优是 `<pad>`。
    > 把 blank 算进竞争者，一个读得完全正确的 7 帧元音也只有 1/7 的帧「认对」，
    > 竞争者恒为 `<pad>`——这个量随语速和峰型漂移，与发音质量无关。
    > 首版就是这么写的，实测 `rival` 几乎全是 `<pad>`。

    这几个量必须与 GOP 线性无关才有意义：`lpp`（参考音素的平均对数后验）
    等于 `gop + conf`，线性模型自己就能凑出来，加进去等于没加。下面这些都不是：

    | 量 | 回答什么 |
    | --- | --- |
    | `top1` | 有几帧模型的第一选择（真音素里）就是这个音 |
    | `margin` | 逐帧「参考音素 − 次优真音素」的均值（GOP 是两个均值相减，不同） |
    | `margin_min` | 最差的那一帧有多差——一帧崩了会被均值抹掉 |
    | `entropy` | 真音素之间的后验熵，模型自己有多犹豫 |
    | `rival` | 模型最想吐的那个替代音，替换模式统计（θ→s）靠它 |
    | `lpr` | 参考音素比第 1…k 强的竞争者各高多少（Kaldi 的 LPR，按竞争者强弱排） |

    `lpr` 是标量 GOP 的推广：GOP 只看最强的那一个竞争者，LPR 向量把整个竞争格局
    的形状带上。Kaldi 自己的 speechocean762 recipe 与独立复现都报同一件事——
    标量 GOP → LPP+LPR 向量，音素级 PCC 从 0.25 升到 0.45。
    """
    import numpy as np

    if hi <= lo:
        return {
            "top1": None,
            "margin": None,
            "margin_min": None,
            "entropy": None,
            "rival": None,
        }
    seg = logp[lo:hi]
    cols = np.arange(seg.shape[1])
    ref_col = seg[:, ref_id]
    # 只在真音素里比：blank 与参考音素本身都排除掉
    rival_seg = np.where((cols == ref_id) | (cols == BLANK_ID), -np.inf, seg)
    rival = rival_seg.max(axis=-1)
    margin = ref_col - rival
    # 熵也只在真音素上算：blank 概率接近 1 会把熵压到 0，掩盖真正的犹豫
    nb = np.where(cols == BLANK_ID, -np.inf, seg)
    nb = nb - np.log(np.exp(nb).sum(axis=-1, keepdims=True))
    ent = float(np.mean(-(np.exp(nb) * np.where(np.isfinite(nb), nb, 0.0)).sum(axis=-1)))
    rival_id = int(np.bincount(rival_seg.argmax(axis=-1), minlength=seg.shape[1]).argmax())
    # LPP：每个 token 在本区间上的平均对数后验（Kaldi 的定义）。
    # LPR(p→q) = LPP(p) − LPP(q)，这里只留最强的 LPR_TOPK 个竞争者
    lpp = seg.mean(axis=0)
    lpp_rivals = np.where((cols == ref_id) | (cols == BLANK_ID), -np.inf, lpp)
    topk = np.sort(lpp_rivals)[::-1][:LPR_TOPK]
    lpr = [
        round(float(lpp[ref_id] - v), 4) if np.isfinite(v) else -20.0 for v in topk
    ]
    lpr += [-20.0] * (LPR_TOPK - len(lpr))
    return {
        "lpr": lpr,
        "top1": round(float(np.mean(ref_col >= rival)), 4),
        "margin": round(float(np.mean(margin)), 4),
        "margin_min": round(float(np.min(margin)), 4),
        "entropy": round(ent, 4),
        "rival": (id2tok[rival_id] if id2tok and rival_id < len(id2tok) else None),
    }


def analyze_utterance(audio_path: str, text: str, precomputed=None) -> dict:
    """一次推理，把后续所有特征需要的**原始量**全吐出来。

    刻意只出原始量不出分数：特征工程与打分放在调用方，
    这样调模型时不必重跑推理（一条 5 秒，200 条就是 17 分钟）。

    每个参考音素给：符号、重音位、所属词、对齐到的帧数、GOP、帧级平均置信度。
    """
    phones = reference_phones_rich(text)
    if not phones:
        raise PhonemeAsrUnavailable("参考音素序列为空")
    logp, id2tok = precomputed or load_emissions(audio_path)
    vocab = {tok: i for i, tok in enumerate(id2tok) if tok}
    ids = [vocab.get(p.symbol) for p in phones]
    if any(i is None for i in ids):
        missing = sorted({p.symbol for p, i in zip(phones, ids, strict=True) if i is None})
        raise PhonemeAsrUnavailable(f"参考音素不在词表内：{missing}")
    ref_ids = [int(i) for i in ids]

    raw_frames = phoneme_frames(logp, ref_ids)
    spans = fill_spans(raw_frames, logp.shape[0])
    gops = gop_scores(logp, ref_ids)
    hyp = greedy_phonemes(logp, id2tok)

    # 每个音素区间内的帧级平均置信度：GOP 说「像不像这个音」，
    # 这个说「这一段声学上有多清楚」，两者不同（含混但音位对的段落 GOP 可以不低）
    import numpy as np

    best = logp.max(axis=-1)

    items = []
    for k, ph in enumerate(phones):
        lo, hi = spans[k] if k < len(spans) else (0, 0)
        peak_lo, peak_hi = raw_frames[k] if k < len(raw_frames) else (0, 0)
        n = max(0, hi - lo)
        g = gops[k] if k < len(gops) else float("nan")
        conf = float(np.mean(best[lo:hi])) if n else float("nan")
        item = {
            "symbol": ph.symbol,
            "stress": ph.stress,
            "word": ph.word_idx,
            "vowel": ph.is_vowel,
            "frames": int(n),
            # 峰值帧数：铺满后的时长受邻居影响，峰值宽度是更"硬"的信号
            "peak": int(max(0, peak_hi - peak_lo)),
            "gop": None if g != g else round(float(g), 4),
            "conf": None if conf != conf else round(conf, 4),
        }
        # 统计走**铺满后的区间**而不是峰值帧：CTC 的峰值几乎恒为 1 帧，
        # 在 1 帧上算 top1/熵拿不到新东西。铺满区间回答的是「这个音的整段时间窗里，
        # 模型有多少帧真的认它」——与只看峰值的 GOP 互补
        item.update(_frame_stats(logp, ref_ids[k], lo, hi, id2tok))
        items.append(item)
    return {
        "phones": items,
        "total_frames": int(logp.shape[0]),
        "frame_seconds": INPUTS_TO_LOGITS_RATIO / SAMPLE_RATE,
        "n_words": (phones[-1].word_idx + 1) if phones else 0,
        "hyp_len": len(hyp),
        "ref_len": len(phones),
        # 贪心解码序列本身也存下来。**存了它，以后任何比对类特征都能离线重算**——
        # 不然每加一个编辑距离特征就要把 5000 条音频重跑一遍推理（40 分钟）
        "hyp": hyp,
    }


def phoneme_diagnose(audio_path: str, reference: str, precomputed=None):
    """音频 + 参考文本 → (音素级提示, 已达层数, GOP 统计)。

    抛 `PhonemeAsrUnavailable` 表示这层没开，调用方降级到第 0 层即可。

    第三个返回值是**整句的 GOP 统计**而不只是被标出来的那几个音素——
    校准实测发现，只用 CTC 对齐置信度做 accuracy 与专家分只有 ρ=0.246，
    因为对齐置信度衡量的是「音频与参考文本对不对得上」，
    而 GOP 衡量的才是「每个音素读得有多像」。两件事不一样。
    """
    from domain.pronunciation import PhonemeHint

    ref = reference_phonemes(reference)
    if not ref:
        raise PhonemeAsrUnavailable("参考音素序列为空")
    logp, id2tok = precomputed or load_emissions(audio_path)
    hyp = greedy_phonemes(logp, id2tok)
    pairs = align_phonemes(ref, hyp)

    # 第 2 层：对参考序列做强制对齐拿 GOP。词表里没有的参考音素跳过
    vocab = {tok: i for i, tok in enumerate(id2tok) if tok}
    ref_ids = [vocab.get(p) for p in ref]
    layer = 1
    gops: list[float] = []
    if all(i is not None for i in ref_ids):
        try:
            gops = gop_scores(logp, [int(i) for i in ref_ids])  # type: ignore[arg-type]
            layer = 2
        except Exception as exc:  # noqa: BLE001 - GOP 失败只丢第 2 层
            logger.warning("GOP 计算失败，保留第 1 层：%s", exc)

    # 全句 GOP 统计：只看被标出来的音素会有幸存者偏差
    stats: dict[str, float] = {}
    valid = [g for g in gops if g == g]  # 滤掉 NaN
    if valid:
        stats = {
            "mean_gop": round(sum(valid) / len(valid), 4),
            "low_gop_rate": round(sum(1 for g in valid if g < -1.0) / len(valid), 4),
            "n_phones": float(len(valid)),
        }

    hints: list[PhonemeHint] = []
    ref_i = 0
    for kind, r, h in pairs:
        if kind == "match":
            ref_i += 1
            continue
        if kind == "insertion":
            hints.append(
                PhonemeHint(index=ref_i, expected="", heard=h, kind="insertion", confidence=25.0)
            )
            continue
        gop = gops[ref_i] if ref_i < len(gops) else None
        # 置信度：替换代价越大越可能是真差异，GOP 越低越可能真读错。
        # 两个信号交叉验证压低误报（FR-398i）——单独任一个都不够可靠
        cost = substitution_cost(r or "", h or "") if kind == "substitution" else 0.9
        conf = cost * 60
        if gop is not None and gop == gop:  # 非 NaN
            conf += max(0.0, min(1.0, -gop / 2.0)) * 40
        hints.append(
            PhonemeHint(
                index=ref_i,
                expected=r or "",
                heard=h,
                kind=kind,
                gop=None if gop is None or gop != gop else gop,
                confidence=round(min(100.0, conf), 1),
            )
        )
        ref_i += 1
    return hints, layer, stats


# ─────────────── 音素 seam ───────────────

PHONEME_PLUGIN_ID = "phoneme-onnx"
PHONEME_PROVIDER_TYPE = "onnxruntime"
PHONEME_MODEL_ID = "wav2vec2-espeak-cv-ft-onnx"
PHONEME_OPERATIONS = frozenset({"audio.align", "audio.assess"})
PHONEME_PROVIDER_KIND = "model-phoneme-provider"


@dataclass(frozen=True)
class PhonemeAssessment:
    """一次推理的产物：音素提示、达到的层数、整句 GOP 统计与打分用的原始特征。

    原始特征是三级打分模型的可选件，算不出来不影响提示，置 None 并把原因留在
    ``feature_error``。
    """

    hints: list[Any]
    layer: int
    gop_stats: dict[str, float]
    features: dict[str, Any] | None = None
    feature_error: str | None = None


class PhonemeRouteProvider(Protocol):
    async def align(
        self,
        route: PreparedPhonemeRoute,
        *,
        audio_path: str,
        text: str,
    ) -> list[dict]: ...

    async def assess(
        self,
        route: PreparedPhonemeRoute,
        *,
        audio_path: str,
        reference: str,
    ) -> PhonemeAssessment: ...


@dataclass(frozen=True)
class PreparedPhonemeRoute(PreparedRoute[RouteSnapshot, PhonemeRouteProvider]):
    async def align(self, *, audio_path: str, text: str) -> list[dict]:
        return await self._provider.align(self, audio_path=audio_path, text=text)

    async def assess(self, *, audio_path: str, reference: str) -> PhonemeAssessment:
        return await self._provider.assess(self, audio_path=audio_path, reference=reference)


phoneme_runtime: CapabilitySeam[RouteRequest, RouteSnapshot, PhonemeRouteProvider] = (
    CapabilitySeam(PHONEME_PROVIDER_KIND, label="音素", ready_source="phoneme")
)


def register_phoneme_route_provider(
    *,
    plugin_id: str,
    provider: PhonemeRouteProvider,
    operations: set[str] | frozenset[str] = PHONEME_OPERATIONS,
    replace: bool = False,
) -> RegistrationHandle:
    return phoneme_runtime.register(
        plugin_id=plugin_id,
        provider=provider,
        operations=operations,
        replace=replace,
    )


def prepare_phoneme_route(request: RouteRequest, operation: str) -> PreparedPhonemeRoute:
    return phoneme_runtime.prepare_as(PreparedPhonemeRoute, request, operation)


def prepare_local_phoneme_route(operation: str, *, capability: str) -> PreparedPhonemeRoute:
    """本地 ONNX 路由：无凭据、无部署，model 固定为音素模型名。"""
    return prepare_phoneme_route(
        RouteRequest(
            capability=capability,
            plugin_id=PHONEME_PLUGIN_ID,
            provider_type=PHONEME_PROVIDER_TYPE,
            model=PHONEME_MODEL_ID,
        ),
        operation,
    )


def _audio_request(audio_path: str, **extra: Any) -> dict[str, Any]:
    source = Path(audio_path)
    return {
        "file_name": source.name,
        "audio_bytes": source.stat().st_size if source.exists() else None,
        **extra,
    }


def _assess_utterance(audio_path: str, reference: str) -> PhonemeAssessment:
    """一段音频只推理一次：提示与原始特征共用同一份后验。"""
    emit = load_emissions(audio_path)
    hints, layer, stats = phoneme_diagnose(audio_path, reference, emit)
    features: dict[str, Any] | None = None
    feature_error: str | None = None
    try:
        features = analyze_utterance(audio_path, reference, emit)
    except Exception as exc:  # noqa: BLE001 - 原始特征是打分的可选件，缺了只记原因
        feature_error = f"{type(exc).__name__}: {exc}"
    return PhonemeAssessment(
        hints=list(hints),
        layer=layer,
        gop_stats=dict(stats),
        features=features,
        feature_error=feature_error,
    )


class _OnnxPhonemeProvider:
    async def align(
        self,
        route: PreparedPhonemeRoute,
        *,
        audio_path: str,
        text: str,
    ) -> list[dict]:
        async with route.span(request=_audio_request(audio_path, text=text)) as span:
            timings = await asyncio.to_thread(phoneme_timings, audio_path, text)
            span.finish(response={"timing_count": len(timings)})
            return timings

    async def assess(
        self,
        route: PreparedPhonemeRoute,
        *,
        audio_path: str,
        reference: str,
    ) -> PhonemeAssessment:
        async with route.span(request=_audio_request(audio_path, reference=reference)) as span:
            result = await asyncio.to_thread(_assess_utterance, audio_path, reference)
            span.finish(
                response={
                    "layer": result.layer,
                    "phoneme_hint_count": len(result.hints),
                    "features": result.features is not None,
                    "feature_error": result.feature_error,
                }
            )
            return result


_BUILTIN_PHONEME_PROVIDER_HANDLES = (
    register_phoneme_route_provider(
        plugin_id=PHONEME_PLUGIN_ID,
        provider=_OnnxPhonemeProvider(),
    ),
)

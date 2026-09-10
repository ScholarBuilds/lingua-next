"""词级时间戳强制对齐（ADR-007 FR-38）。

whisper 的词级时间戳由 cross-attention DTW 推出，被吸附到模型的 token 网格上，
词跨度偏松（5 号视频实测中位 0.220s）。CTC 强制对齐直接标注每个词的声学起止，
同一素材实测中位 0.120s，卡拉OK高亮不再"晚半拍"。

模型（MMS-300M ONNX）按进程单例加载，1.2GB 只读一次。任何一步失败都返回 None，
调用方回退 whisper DTW 时间戳——对齐是增强项，不该阻断整条管线。
"""

import logging
import sys
import threading

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000

_aligner = None
_lock = threading.Lock()


def _require_supported_platform() -> None:
    if sys.platform == "win32":
        raise RuntimeError(
            "Windows 暂不支持本地 CTC 强制对齐及依赖它的发音评测；"
            "请使用 macOS/Linux 服务端。已有字幕仍可阅读播放。"
        )


def _get_aligner():
    """进程级单例：ONNX 模型 1.2GB，重复加载会拖垮 worker。"""
    _require_supported_platform()
    global _aligner
    if _aligner is None:
        with _lock:
            if _aligner is None:
                from ctc_forced_aligner import AlignmentSingleton

                _aligner = AlignmentSingleton()
                logger.info("CTC 对齐模型已加载")
    return _aligner


def decode_audio(media_path: str):
    """媒体文件 → 16kHz 单声道 float32 波形（PyAV 解码，支持 mp4/webm 等容器）。

    ctc-forced-aligner 自带的 load_audio 走 librosa/soundfile，不认 mp4 容器。
    """
    import av
    import numpy as np

    with av.open(media_path) as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            return None
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        chunks: list = []
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):  # flush
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        return None
    return np.concatenate(chunks).astype("float32") / 32768.0


def _align_slice(aligner, audio, text: str, offset_ms: int) -> list[list]:
    """对齐一段音频与其文本，时间戳回加 offset_ms。"""
    from ctc_forced_aligner import (
        generate_emissions,
        get_alignments,
        get_spans,
        postprocess_results,
        preprocess_text,
    )

    emissions, stride = generate_emissions(aligner.model, audio)
    tokens_starred, text_starred = preprocess_text(text, romanize=True, language="eng")
    segments, scores, blank = get_alignments(emissions, tokens_starred, aligner.tokenizer)
    spans = get_spans(tokens_starred, segments, blank)
    results = postprocess_results(text_starred, spans, stride, scores)
    return [
        [offset_ms + int(r["start"] * 1000), offset_ms + int(r["end"] * 1000), r["text"]]
        for r in results
        if str(r.get("text", "")).strip()
    ]


# 词间静音达到该值即切块：块内不含长静音，CTC 才不会把词摊进去
BLOCK_GAP_S = 1.0
# 单块音频上限，控制 CTC trellis 规模
BLOCK_SPAN_S = 30.0


def _blocks_by_gaps(flat: list[tuple[int, int, list]]) -> list[list[int]]:
    """按词间静音与跨度把词流切块，返回每块的词下标列表。

    不能按 cue 边界分块：whisper 的 segment 内部也含长静音，5 号视频有三个
    单 cue 就跨 62-70 秒，自成一块时块内静音照样把词摊开（实测最大偏移 58.6s）。
    以词为单位切，静音永远落在块与块之间。
    """
    blocks: list[list[int]] = []
    cur: list[int] = []
    for i, (_, _, w) in enumerate(flat):
        if cur:
            prev = flat[cur[-1]][2]
            gap = (w[0] - prev[1]) / 1000.0
            span = (w[1] - flat[cur[0]][2][0]) / 1000.0
            if gap >= BLOCK_GAP_S or span > BLOCK_SPAN_S:
                blocks.append(cur)
                cur = []
        cur.append(i)
    if cur:
        blocks.append(cur)
    return blocks


def align_cues(media_path: str, cues: list[dict], pad_ms: int = 200) -> int:
    """按词流分块做 CTC 强制对齐，就地改写 cues 的 words 时间戳；返回改写的 cue 数。

    cues 为 [{start_ms, end_ms, text, words}]；words 为 [[start_ms, end_ms, surface]]。
    任一块词数对不上或异常都只跳过该块保留 DTW，不阻断整条管线。
    """
    try:
        aligner = _get_aligner()
        audio = decode_audio(media_path)
    except Exception as exc:
        logger.warning("CTC 对齐初始化失败，保留 DTW 时间戳：%s", exc)
        return 0
    if audio is None:
        logger.warning("CTC 对齐跳过：%s 无音轨", media_path)
        return 0

    flat = [
        (ci, wi, w)
        for ci, c in enumerate(cues)
        for wi, w in enumerate(c.get("words") or [])
    ]
    if not flat:
        return 0

    touched: set[int] = set()
    for block in _blocks_by_gaps(flat):
        head, tail = flat[block[0]][2], flat[block[-1]][2]
        lo = max(0, int((head[0] - pad_ms) / 1000 * SAMPLE_RATE))
        hi = min(len(audio), int((tail[1] + pad_ms) / 1000 * SAMPLE_RATE))
        if hi - lo < SAMPLE_RATE // 10:  # 不足 0.1 秒，无对齐价值
            continue
        text = " ".join(flat[i][2][2] for i in block)
        offset_ms = int(lo / SAMPLE_RATE * 1000)
        try:
            aligned = _align_slice(aligner, audio[lo:hi], text, offset_ms)
        except Exception as exc:
            logger.warning("CTC 对齐块失败（词 %d-%d）：%s", block[0], block[-1], exc)
            continue
        if len(aligned) != len(block):
            # 对齐器的词切分与 whisper 不完全一致（如 "a.m."），该块保留 DTW
            logger.debug("块内词数不符（%d vs %d），保留 DTW", len(aligned), len(block))
            continue
        for idx, a in zip(block, aligned, strict=True):
            ci, wi, _ = flat[idx]
            w = cues[ci]["words"][wi]
            cues[ci]["words"][wi] = [a[0], a[1], w[2]]  # 词面以转写为准
            touched.add(ci)
    logger.info("CTC 对齐完成：%d/%d cue 已重定时", len(touched), len(cues))
    return len(touched)


def align_text(media_path: str, text: str) -> list[dict]:
    """整段音频与其文本做一次 CTC 强制对齐，返回逐词时间戳与置信度。

    与 `align_cues` 的区别：那个是给字幕重定时用的（按词流分块），
    这个是给发音评测用的（一句话一次对齐，且**保留 score**）。

    `score` 是区间求和不是均值，长词天然高分——调用方必须按 `frames` 归一化
    才能横向比较（BR-92）。这里把帧数一并返回，就是为了不让调用方漏掉这步。
    """
    _require_supported_platform()
    from ctc_forced_aligner import (
        generate_emissions,
        get_alignments,
        get_spans,
        postprocess_results,
        preprocess_text,
    )

    aligner = _get_aligner()
    audio = decode_audio(media_path)
    if audio is None or not text.strip():
        return []
    emissions, stride = generate_emissions(aligner.model, audio)
    tokens_starred, text_starred = preprocess_text(text, romanize=True, language="eng")
    segments, scores, blank = get_alignments(emissions, tokens_starred, aligner.tokenizer)
    spans = get_spans(tokens_starred, segments, blank)
    results = postprocess_results(text_starred, spans, stride, scores)
    out: list[dict] = []
    for r in results:
        word = str(r.get("text", "")).strip()
        if not word:
            continue
        frames = max(1, round((r["end"] - r["start"]) * 1000 / stride))
        out.append(
            {
                "text": word,
                "start": float(r["start"]),
                "end": float(r["end"]),
                "score": float(r["score"]),
                "frames": frames,
            }
        )
    return out

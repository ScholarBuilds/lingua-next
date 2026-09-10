"""火山极速版 ASR 与本地 faster-whisper 的同素材对比（离线，不改任何库数据）。

    uv run python scripts/compare_asr.py 21 25 22
    uv run python scripts/compare_asr.py 21 --json out.json

whisper 那一侧直接读库里已跑完的 `subtitle_cue`（管线产物，含 CTC 对齐后的词级时间轴），
火山那一侧现场调一次极速版。两边比四组量：文本差异、标点、词级时间戳、句子切分。

> [!warning] 没有人工转写做基准，所以这里报的是「两个引擎互相差多少」
>
> WER 需要 ground truth，本仓视频的字幕轨全部由 whisper 产出（`kind='whisper'`），
> 拿它当基准等于问「火山有多像 whisper」，那不是我们要的答案。
> 所以文本一栏输出的是**逐词差异清单**，由人判哪边对；
> 时间戳一栏则有真基准可用——CTC 强制对齐是声学标注，ADR-007 里量过中位 0.120s。
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
import time
import uuid
from difflib import SequenceMatcher
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import aiohttp  # noqa: E402
from sqlalchemy import select, text  # noqa: E402

from app.db import SessionFactory  # noqa: E402
from domain.credentials import decrypt_config  # noqa: E402
from domain.models import ProviderCredential  # noqa: E402

FLASH_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash"
FLASH_RESOURCE_ID = "volc.bigasr.auc_turbo"
SENT_END = re.compile(r"[.!?]")


def media_path(file_key: str) -> Path:
    from app.config import get_settings

    return Path(get_settings().media_root) / file_key


def to_wav(src: Path) -> Path:
    """→ 16kHz 单声道 PCM。火山极速版要 raw PCM/wav，mp4 直接喂会被拒。"""
    out = Path(tempfile.mkdtemp(prefix="asr-cmp-")) / f"{src.stem}.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
         "-c:a", "pcm_s16le", str(out)],
        check=True, capture_output=True,
    )
    return out


async def volc_credentials() -> tuple[str, str]:
    async with SessionFactory() as session:
        row = (
            await session.execute(
                select(ProviderCredential).where(
                    ProviderCredential.provider_type == "volc_speech"
                )
            )
        ).scalars().first()
    if row is None:
        raise SystemExit("配置中心里没有 volc_speech 凭据")
    cfg = decrypt_config(row.config)
    return cfg["app_id"], cfg["access_key"]


async def volc_recognize(wav: Path, app_id: str, access_key: str) -> tuple[dict, float]:
    """极速版是同步接口：31 秒音频实测 4.7 秒返回，不需要轮询。

    直连 openspeech.bytedance.com 上传 1.3MB base64 会 SSL 握手超时（本机实测两次），
    走系统代理 4.7 秒完成——与 volc_tts 的小 payload 不同，这里必须显式带 proxy。
    """
    body = {
        "user": {"uid": "lingua"},
        "audio": {
            "format": "wav", "rate": 16000, "bits": 16, "channel": 1,
            "data": base64.b64encode(wav.read_bytes()).decode(),
        },
        "request": {
            "model_name": "bigmodel",
            "enable_itn": True,
            "enable_punc": True,
            "enable_ddc": True,
            "show_utterances": True,
        },
    }
    headers = {
        "X-Api-App-Key": app_id,
        "X-Api-Access-Key": access_key,
        "X-Api-Resource-Id": FLASH_RESOURCE_ID,
        "X-Api-Request-Id": str(uuid.uuid4()),
        "X-Api-Sequence": "-1",
    }
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    started = time.time()
    timeout = aiohttp.ClientTimeout(total=300, connect=30, sock_connect=30)
    last: Exception | None = None
    # 连超时是本机代理在连续大 payload 下的常态（实测 6 次里 2 次），不是服务端拒绝：
    # 同一条音频重试即过。重试不会重复计费，极速版按成功识别的音频时长计。
    for attempt in range(3):
        try:
            async with (
                aiohttp.ClientSession(timeout=timeout) as http,
                http.post(FLASH_URL, json=body, headers=headers, proxy=proxy) as resp,
            ):
                code = resp.headers.get("X-Api-Status-Code")
                message = resp.headers.get("X-Api-Message")
                payload = await resp.text()
            if code != "20000000":
                raise RuntimeError(f"火山返回 {code} {message}: {payload[:200]}")
            return json.loads(payload), time.time() - started
        except (aiohttp.ClientError, TimeoutError) as exc:
            last = exc
            headers["X-Api-Request-Id"] = str(uuid.uuid4())
            await asyncio.sleep(2 * (attempt + 1))
    raise RuntimeError(f"三次重试都失败：{type(last).__name__}: {last}")


def volc_cues(result: dict) -> list[dict]:
    """utterances → 与 subtitle_cue 同形的结构。

    words 里混着 `text=" "` 且 `start_time=-1` 的分隔 token（实测每个词之间一个），
    不滤掉的话词数虚高一倍、时间戳统计全是 -1。
    """
    out = []
    for utt in (result.get("result") or {}).get("utterances") or []:
        words = [
            [w["start_time"], w["end_time"], w["text"].strip()]
            for w in utt.get("words") or []
            if w.get("text", "").strip() and w.get("start_time", -1) >= 0
        ]
        out.append({
            "start_ms": utt["start_time"],
            "end_ms": utt["end_time"],
            "text": utt["text"].strip(),
            "words": words,
        })
    return out


async def whisper_cues(video_id: int) -> tuple[list[dict], dict]:
    async with SessionFactory() as session:
        track = (await session.execute(text(
            "select id, meta from subtitle_track"
            " where video_id=:v and kind='whisper' order by id desc limit 1"
        ), {"v": video_id})).first()
        if track is None:
            return [], {}
        rows = (await session.execute(text(
            "select start_ms, end_ms, text, words from subtitle_cue"
            " where track_id=:t order by ordinal"
        ), {"t": track[0]})).all()
    cues = [
        {"start_ms": r[0], "end_ms": r[1], "text": r[2], "words": r[3] or []}
        for r in rows
    ]
    return cues, track[1] or {}


def norm_words(cues: list[dict]) -> list[str]:
    joined = " ".join(c["text"] for c in cues).lower()
    return re.findall(r"[a-z0-9']+", joined)


def span_stats(cues: list[dict]) -> dict:
    spans = [
        (e - s) / 1000
        for c in cues for s, e, _ in c["words"]
        if e is not None and s is not None and e >= s
    ]
    if not spans:
        return {"n": 0}
    return {
        "n": len(spans),
        "median_s": round(statistics.median(spans), 3),
        "mean_s": round(statistics.fmean(spans), 3),
        "zero_width": sum(1 for x in spans if x == 0),
    }


def punct_stats(cues: list[dict]) -> dict:
    body = " ".join(c["text"] for c in cues)
    return {
        "sentence_end": len(SENT_END.findall(body)),
        "comma": body.count(","),
        "chars": len(body),
    }


def flat_words(cues: list[dict]) -> list[tuple[str, int, int]]:
    out = []
    for cue in cues:
        for start, end, raw in cue["words"]:
            token = re.sub(r"[^a-z0-9']", "", str(raw).lower())
            if token and start is not None and end is not None:
                out.append((token, int(start), int(end)))
    return out


def timing_offsets(w_cues: list[dict], v_cues: list[dict]) -> dict:
    """火山词级时间戳 vs CTC 强制对齐，逐词配对量偏移。

    只取 SequenceMatcher 的 equal 区段——replace/insert/delete 那些词两边识别本身就不同，
    比时间戳没有意义（拿一个词的时间去减另一个词的时间，得到的是噪声）。
    """
    wa, va = flat_words(w_cues), flat_words(v_cues)
    ta, tb = [x[0] for x in wa], [x[0] for x in va]
    starts, ends = [], []
    for tag, i1, i2, j1, _j2 in SequenceMatcher(None, ta, tb).get_opcodes():
        if tag != "equal":
            continue
        for k in range(i2 - i1):
            starts.append(va[j1 + k][1] - wa[i1 + k][1])
            ends.append(va[j1 + k][2] - wa[i1 + k][2])
    if not starts:
        return {"pairs": 0}
    absolute = sorted(abs(x) for x in starts)

    def pct(threshold: int) -> float:
        return round(sum(1 for x in absolute if x <= threshold) / len(absolute), 3)

    return {
        "pairs": len(starts),
        "start_median_ms": round(statistics.median(starts)),
        "start_abs_median_ms": round(statistics.median(absolute)),
        "start_abs_p90_ms": absolute[int(len(absolute) * 0.9) - 1],
        "end_median_ms": round(statistics.median(ends)),
        "within_50ms": pct(50),
        "within_100ms": pct(100),
        "within_200ms": pct(200),
    }


def word_diff(a: list[str], b: list[str], limit: int = 25) -> list[str]:
    lines = []
    for tag, i1, i2, j1, j2 in SequenceMatcher(None, a, b).get_opcodes():
        if tag == "equal":
            continue
        lines.append(f"  {tag:<7} whisper={' '.join(a[i1:i2]) or '∅'!r:<34} 火山={' '.join(b[j1:j2]) or '∅'!r}")
        if len(lines) >= limit:
            lines.append(f"  …（还有更多差异，共 {sum(1 for t,*_ in SequenceMatcher(None,a,b).get_opcodes() if t!='equal')} 处）")
            break
    return lines


async def compare(video_id: int, app_id: str, access_key: str) -> dict:
    async with SessionFactory() as session:
        row = (await session.execute(text(
            "select file_key, title, duration_s, accent from video where id=:v"
        ), {"v": video_id})).first()
    if row is None or not row[0]:
        raise SystemExit(f"video {video_id} 不存在或没有媒体文件")
    src = media_path(row[0])
    if not src.exists():
        raise SystemExit(f"媒体文件不在：{src}")

    wav = to_wav(src)
    raw, elapsed = await volc_recognize(wav, app_id, access_key)
    v_cues = volc_cues(raw)
    w_cues, w_meta = await whisper_cues(video_id)

    wa, wb = norm_words(w_cues), norm_words(v_cues)
    matcher = SequenceMatcher(None, wa, wb)
    return {
        "video_id": video_id,
        "title": row[1],
        "duration_s": row[2],
        "accent": row[3],
        "volc_latency_s": round(elapsed, 2),
        "realtime_factor": round(elapsed / row[2], 3) if row[2] else None,
        "whisper": {
            "cues": len(w_cues), "words": len(wa),
            "punct": punct_stats(w_cues), "spans": span_stats(w_cues),
            "align_engine": (w_meta.get("alignment") or {}).get("engine"),
        },
        "volc": {
            "cues": len(v_cues), "words": len(wb),
            "punct": punct_stats(v_cues), "spans": span_stats(v_cues),
        },
        "agreement": round(matcher.ratio(), 4),
        "timing_offsets": timing_offsets(w_cues, v_cues),
        "diff": word_diff(wa, wb),
        "whisper_cues": w_cues,
        "volc_cues": v_cues,
        "volc_text": " ".join(c["text"] for c in v_cues),
        "whisper_text": " ".join(c["text"] for c in w_cues),
    }


def report(r: dict) -> None:
    w, v = r["whisper"], r["volc"]
    print(f"\n{'='*78}")
    print(f"video {r['video_id']}  {r['duration_s']:.0f}s  {r['accent'] or '-'}  {(r['title'] or '')[:44]}")
    print(f"{'='*78}")
    print(f"火山耗时 {r['volc_latency_s']}s（实时率 {r['realtime_factor']}×）\n")
    rows = [
        ("句子数", w["cues"], v["cues"]),
        ("词数", w["words"], v["words"]),
        ("句末标点", w["punct"]["sentence_end"], v["punct"]["sentence_end"]),
        ("逗号", w["punct"]["comma"], v["punct"]["comma"]),
        ("词跨度中位(s)", w["spans"].get("median_s"), v["spans"].get("median_s")),
        ("词跨度均值(s)", w["spans"].get("mean_s"), v["spans"].get("mean_s")),
        ("零宽跨度", w["spans"].get("zero_width"), v["spans"].get("zero_width")),
    ]
    print(f"{'指标':<16}{'whisper+CTC':>14}{'火山极速版':>14}")
    for name, a, b in rows:
        print(f"{name:<16}{str(a):>14}{str(b):>14}")
    print(f"\n词序列一致度 {r['agreement']:.1%}")
    off = r["timing_offsets"]
    if off.get("pairs"):
        print(
            f"时间戳偏移（火山 − CTC 对齐，{off['pairs']} 个同词配对）："
            f"起点中位 {off['start_median_ms']:+}ms  绝对值中位 {off['start_abs_median_ms']}ms"
            f"  p90 {off['start_abs_p90_ms']}ms"
        )
        print(
            f"  落在 ±50ms 内 {off['within_50ms']:.0%} · ±100ms 内 {off['within_100ms']:.0%}"
            f" · ±200ms 内 {off['within_200ms']:.0%}"
        )
    if r["diff"]:
        print("\n差异（左 whisper 右火山，由人判哪边对）：")
        print("\n".join(r["diff"]))


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("videos", nargs="+", type=int, help="video id")
    ap.add_argument("--json", type=Path, help="把完整结果写到文件")
    args = ap.parse_args()

    app_id, access_key = await volc_credentials()
    results = []
    for vid in args.videos:
        try:
            r = await compare(vid, app_id, access_key)
        except Exception as exc:
            print(f"video {vid} 失败：{type(exc).__name__}: {exc}")
            continue
        results.append(r)
        report(r)
    if args.json and results:
        args.json.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n完整结果 → {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

"""音位示范音：让「点音标」真的发出那个音标的音。

旧实现点 /θ/ 放的是例词 think，理由写在旧注释里——「音位本身没法单独合成，
把 /θ/ 丢给 TTS 得到的是字母名」。**前半句成立，推出的结论不成立**：
合成不出来不等于拿不到。Wikimedia Commons 上有语音学家逐个录的独立音位示范音
（Wikipedia 的 IPA 表、ipachart.com 用的都是这批），取回转码缓存即可。

两条音源，覆盖面互补：

- `commons`：独立音位录音。适合擦音、鼻音、单元音——这些音离开元音环境仍然成立。
- `word-clip`：从示范词的强制对齐结果里切出那一段。**双元音只能走这条**：
  Commons 收的是单个音段，没有 /eɪ/ 这种滑动音。

> [!warning] 切段这条路 2026-08-30 起走不通了
>
> 它靠 `/phonetics/word/{w}/timings` 的强制对齐拿音素区间，而那条路由与它背后的
> 音素模型已随发音评分一起下线（ADR-012）。`ensure_word_timings` 现在是个抛
> `PhonemeAudioUnavailable` 的桩，本文件的 `_from_word_clip` 接得住、按降级处理。
>
> 磁盘上 44/44 都在（`ensure_phoneme_audio` 第一件事就是查缓存直接返回），
> 所以播放不受影响；受影响的只有「缓存没了要重建」这一种情况——
> 而 8 个双元音**只能**走这条路，因此 `server/data/media/phoneme_ipa/`
> 从此按不可再生资产对待，备份在 `归档/2026-08-30-发音评分模型下线/`。

许可：Commons 上这批多为 CC BY-SA 3.0，**要署名**，所以出处一路透到前端显示，
不是可选装饰。word-clip 的音频是本项目 TTS 合成的，无第三方许可牵连。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import shutil
import subprocess
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

import httpx

from domain.network_policy import routed_http_client

logger = logging.getLogger(__name__)

COMMONS_API = "https://commons.wikimedia.org/w/api.php"
# Commons 对无 UA 的请求返回 403，这是它的明文政策而不是偶发失败
# Wikimedia 的 UA 政策要求带一个可识别的项目标识；只写浏览器串或空 UA 会直接 403，
# 标识含糊则更早被限流。这里只写项目名与用途，不放任何个人联系方式。
USER_AGENT = "lingua-next/1.0 (self-hosted personal English study app; non-commercial)"
TIMEOUT = 15.0
# 切段前后各留一点：音素边界由声学模型给，卡死会削掉爆破的起始
CLIP_PAD_S = 0.04
# 单个音素常常不到 100ms，短到听不清；不足就往后补
CLIP_MIN_S = 0.18
# 词尾音素额外往后延这么多。
#
# 对齐给的词尾边界普遍偏早：实测 no 的 /əʊ/ 只报 80ms、they 的 /eɪ/ 报 100ms，
# 而一个重读的词尾双元音实际有 200ms 以上——余下的被算进了「静音」。
# 按报的边界切出来是掐掉滑动尾巴的半个音，正好丢掉双元音最要紧的那一段。
# 只对**词尾**音素延长：词中延长会把下一个音素也切进来。
TAIL_S = 0.22
# 429 后的重试次数与基础退避。Commons 返回 Retry-After 时以它为准
RETRIES = 3
BACKOFF_S = 1.5
# 请求里最多等这么久。Commons 封禁时 Retry-After 能到 600 秒，那不是能在
# 一个 HTTP 请求里等完的量级——超过就直接报错，让前端退到别的档
MAX_WAIT_S = 12.0

# Commons **必须串行取**。并发 6 路批量预热当场吃到 429，
# 表现是一半音位 503、另一半 500（下载那一路的异常没被接住），
# 而缓存已建的音位照常出声——所以线上只会零星失败，最难自查。
# 它家的接口礼仪写得很明白：单客户端串行。这把锁就是那条规矩的落实。
_commons_lock = asyncio.Lock()
_last_call = 0.0
MIN_INTERVAL_S = 0.35


class PhonemeAudioUnavailable(RuntimeError):
    """这个音位既没有 Commons 录音，也切不出词段。"""


@dataclass(frozen=True)
class AudioSource:
    """一个音位的示范音出处。`credit` 为空表示无署名义务（本项目自产）。"""

    strategy: str  # commons | word-clip
    title: str = ""  # Commons 文件标题，word-clip 为空
    license: str = ""
    clip_word: str = ""  # word-clip 用哪个词切，commons 为空
    # 示范词要什么口音。空=跟随「查词发音」场景配的音色（用户在设置里选的那个）。
    # `en-GB` 是硬要求不是偏好：英音的央化双元音（ɪə eə ʊə）在美音里根本不存在，
    # 用美音音色合成出来切到的不是目标音。
    #
    # **记口音不记音色 id**：音色 id 是供应商专有的（Edge 叫 en-GB-SoniaNeural，
    # 火山叫 en_female_authoritative-british_uranus_bigtts）。写死任何一个，
    # 换供应商时这三个音位就悄悄退回美音——错得没有任何迹象。
    clip_accent: str = ""
    # 对齐侧可能吐出的等价写法。**这不是可选优化**：对齐用的是 r 化音素集，
    # tour 出来是 ʊɹ 而不是教学写的 ʊə，不给等价写法这三个音位就永远切不出来
    align_alts: tuple[str, ...] = ()


def cache_paths(media_root: str, symbol: str) -> tuple[Path, Path]:
    """按符号哈希落盘。

    不直接拿 IPA 符号当文件名：θ / ʃ / ɡ 在不同文件系统上的规范化形式不一致
    （macOS 会做 NFD 分解），同一个音位可能落成两份缓存、或者读的时候找不着。
    """
    digest = hashlib.sha256(symbol.encode("utf-8")).hexdigest()[:16]
    root = Path(media_root) / "phoneme_ipa"
    return root / f"{digest}.mp3", root / f"{digest}.json"


async def _commons_get(client: httpx.AsyncClient, url: str, **kw) -> httpx.Response:
    """串行 + 退避地打 Commons。429 按 Retry-After 等，其余错误直接抛。"""
    global _last_call
    last_exc: Exception | None = None
    for attempt in range(RETRIES):
        async with _commons_lock:
            gap = MIN_INTERVAL_S - (asyncio.get_running_loop().time() - _last_call)
            if gap > 0:
                await asyncio.sleep(gap)
            resp = await client.get(url, **kw)
            _last_call = asyncio.get_running_loop().time()
        if resp.status_code != 429:
            resp.raise_for_status()
            return resp
        asked = float(resp.headers.get("Retry-After") or 0)
        # **Retry-After 要么照等，要么别重试**。之前这里取 min(asked, 8s)：
        # 人家说等 10 秒，我们等 8 秒就再打一次——等于每次重试都踩在惩罚窗口里，
        # 于是 Retry-After 从 10 秒一路升到 600 秒，越retry越糟。
        # 等得起就整整等完，等不起就当场认输让上层退档。
        wait = asked or BACKOFF_S * (2**attempt)
        if wait > MAX_WAIT_S:
            raise PhonemeAudioUnavailable(
                f"Commons 限流，要求等 {asked:.0f}s；离线跑 scripts/seed_phoneme_audio.py 预热即可"
            )
        last_exc = PhonemeAudioUnavailable(f"Commons 限流，已等 {wait:.0f}s 仍未放行")
        logger.warning("Commons 429，按 Retry-After 等 %.0fs 后重试（第 %d 次）", wait, attempt + 1)
        await asyncio.sleep(wait)
    raise last_exc or PhonemeAudioUnavailable("Commons 限流")


async def resolve_commons(title: str) -> dict | None:
    """把 Commons 文件标题解析成真实地址与许可。

    必须走 API 不能拼 URL：真实地址里有两级内容哈希目录（`/8/80/`），拼不出来；
    而且 API 会跟随重定向——`Voiceless_postalveolar_fricative` 实际存的是
    `Voiceless_palato-alveolar_sibilant`，直接拼必然 404。
    """
    params = {
        "action": "query",
        "titles": f"File:{title}",
        "prop": "imageinfo",
        "iiprop": "url|size|mime|extmetadata",
        "format": "json",
    }
    try:
        async with routed_http_client(
            timeout=TIMEOUT, follow_redirects=True, headers={"User-Agent": USER_AGENT}
        ) as client:
            resp = await _commons_get(client, COMMONS_API, params=params)
        pages = resp.json().get("query", {}).get("pages", {})
    except Exception as exc:  # noqa: BLE001
        logger.warning("Commons 解析失败 %s: %s", title, exc)
        return None
    for page in pages.values():
        if "missing" in page:
            continue
        info = (page.get("imageinfo") or [{}])[0]
        url = str(info.get("url", "")).split("?")[0]
        if not url:
            continue
        meta = info.get("extmetadata") or {}
        return {
            "url": url,
            "license": str((meta.get("LicenseShortName") or {}).get("value", "")),
        }
    return None


# 一次 API 请求最多带这么多标题。Commons 对匿名调用的上限是 50
BATCH = 50


async def resolve_commons_batch(titles: list[str]) -> dict[str, dict]:
    """一次请求解析一批标题，返回 {标题: {url, license}}。

    **为什么要批量**：逐个解析 36 个音位就是 36 次 API 调用，实测当场吃到 429，
    而且 Retry-After 会从 10 秒一路升到 600 秒——重试本身把惩罚窗口越踩越深。
    合成一次请求之后，同样 36 个标题在被限流的当口也能一次拿全。

    响应里 `normalized` 与 `redirects` 会把标题改写（下划线转空格、旧名转新名），
    要顺着这两张映射回溯，否则改过名的那几个音位查不到自己的结果。
    """
    out: dict[str, dict] = {}
    for i in range(0, len(titles), BATCH):
        chunk = titles[i : i + BATCH]
        params = {
            "action": "query",
            "titles": "|".join(f"File:{t}" for t in chunk),
            "prop": "imageinfo",
            "iiprop": "url|extmetadata",
            "format": "json",
            "formatversion": "2",
        }
        async with routed_http_client(
            timeout=TIMEOUT, follow_redirects=True, headers={"User-Agent": USER_AGENT}
        ) as client:
            resp = await _commons_get(client, COMMONS_API, params=params)
        data = resp.json().get("query", {})
        # 最终标题 → 我们问的那个标题
        back: dict[str, str] = {}
        for t in chunk:
            back[f"File:{t}"] = t
        for hop in ("normalized", "redirects"):
            for m in data.get(hop, []):
                if m["from"] in back:
                    back[m["to"]] = back[m["from"]]
        for page in data.get("pages", []):
            if "missing" in page or not page.get("imageinfo"):
                continue
            asked = back.get(page["title"])
            if asked is None:
                continue
            info = page["imageinfo"][0]
            meta = info.get("extmetadata") or {}
            out[asked] = {
                "url": str(info.get("url", "")).split("?")[0],
                "license": str((meta.get("LicenseShortName") or {}).get("value", "")),
            }
    return out


def _transcode(src: Path, dest: Path) -> None:
    """ogg → mp3。

    Commons 上这批是 Vorbis/ogg，Safari 对 ogg 的支持时有时无——在浏览器里表现为
    「按钮点了没声音也没报错」，是最难自查的一类故障。统一转 mp3 把这个变量消掉。

    顺带做响度归一：这批录音来自不同年份不同录音者，音量差得能到十几 dB，
    连着点两个音位会一个震耳一个听不见。
    """
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(src),
        "-af", "loudnorm=I=-18:TP=-2:LRA=11",
        "-ac", "1", "-ar", "44100", "-b:a", "96k",
        str(dest),
    ]  # fmt: skip
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    if result.returncode != 0 or not dest.exists():
        raise PhonemeAudioUnavailable(f"转码失败：{result.stderr[:200]}")


def _clip(src: Path, dest: Path, start: float, end: float, tail: float = 0.0) -> None:
    """从整词音频里裁一段。`tail` 是词尾音素额外往后延的量。

    延长超出文件末尾没关系，ffmpeg 到 EOF 自然停。
    """
    start = max(0.0, start - CLIP_PAD_S)
    end = max(end + CLIP_PAD_S + tail, start + CLIP_MIN_S)
    dur = end - start
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(src),
        # 淡入淡出各 15ms：从中间切出来的波形两端不在零点，直接播是「啪」的一声爆音
        "-af", f"afade=t=in:st=0:d=0.015,afade=t=out:st={max(0.0, dur - 0.015):.3f}:d=0.015",
        "-ac", "1", "-ar", "44100", "-b:a", "96k",
        str(dest),
    ]  # fmt: skip
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    if result.returncode != 0 or not dest.exists():
        raise PhonemeAudioUnavailable(f"裁切失败：{result.stderr[:200]}")


def match_phone(timings: list[dict], symbol: str, alts: tuple[str, ...] = ()) -> dict | None:
    """在对齐结果里找目标音素。

    三级匹配，逐级放宽：

    1. 严格相等；
    2. `alts` 里的等价写法——对齐用 r 化音素集，tour 出来是 `ʊɹ` 不是教学写的 `ʊə`，
       这三个央化双元音不给等价写法就永远切不出来；
    3. 去掉长音符与重音标记的宽松匹配——教学写 /iː/，对齐常吐 /i/。

    匹配不到就返回 None，让调用方明说「切不出来」。**不要退到「取最接近的一段」**：
    放错一段音比不放更糟，学习者不会怀疑自己听到的是别的音。
    """

    def loose(s: str) -> str:
        return s.replace("ː", "").replace("ˈ", "").replace("ˌ", "")

    wanted = (symbol, *alts)
    for want in wanted:
        for t in timings:
            if t.get("phone") == want:
                return t
    for want in wanted:
        for t in timings:
            if loose(str(t.get("phone", ""))) == loose(want):
                return t
    return None


async def _from_commons(source: AudioSource, mp3: Path, resolved: dict | None = None) -> dict:
    info = resolved if resolved is not None else await resolve_commons(source.title)
    if info is None:
        raise PhonemeAudioUnavailable(f"Commons 上没有 {source.title}")
    # 下载这一路也要接住：漏出去的 httpx.HTTPStatusError 会变成 500，
    # 而这明明是「暂时取不到」，前端该收到 503 才知道可以退到别的档
    try:
        async with routed_http_client(
            timeout=TIMEOUT, follow_redirects=True, headers={"User-Agent": USER_AGENT}
        ) as client:
            resp = await _commons_get(client, info["url"])
    except PhonemeAudioUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        raise PhonemeAudioUnavailable(f"下载失败：{exc}") from exc
    raw = mp3.with_suffix(".src")
    await asyncio.to_thread(raw.write_bytes, resp.content)
    try:
        await asyncio.to_thread(_transcode, raw, mp3)
    finally:
        raw.unlink(missing_ok=True)
    return {
        "strategy": "commons",
        "title": source.title,
        "license": info["license"] or source.license,
        "origin": info["url"],
    }


async def _from_word_clip(
    source: AudioSource,
    symbol: str,
    mp3: Path,
    timings_of: Callable[[str, str], Awaitable[dict]],
) -> dict:
    """从示范词里切。`timings_of` 由调用方注入，避免 domain 反向依赖路由层。"""
    word = source.clip_word
    if not word:
        raise PhonemeAudioUnavailable(f"{symbol} 没有配示范词")
    payload = await timings_of(word, source.clip_accent)
    timings = payload.get("timings") or []
    hit = match_phone(timings, symbol, source.align_alts)
    if hit is None:
        raise PhonemeAudioUnavailable(f"{word} 的对齐结果里没有 {symbol}")
    tail = TAIL_S if timings and hit is timings[-1] else 0.0
    await asyncio.to_thread(
        _clip, Path(payload["audio_path"]), mp3, float(hit["start"]), float(hit["end"]), tail
    )
    return {
        "strategy": "word-clip",
        "title": "",
        "license": "",
        "origin": f"{word} · {float(hit['start']):.2f}–{float(hit['end']):.2f}s",
        "clip_word": word,
        "clip_accent": source.clip_accent,
        "voice": payload.get("voice", ""),
    }


async def ensure_phoneme_audio(
    media_root: str,
    symbol: str,
    source: AudioSource,
    timings_of: Callable[[str, str], Awaitable[dict]],
    resolved: dict | None = None,
    fallback_words: tuple[str, ...] = (),
) -> tuple[Path, dict]:
    """取到这个音位的示范音，落盘缓存后返回路径与出处。

    `resolved` 是批量预解析的结果；给了就不再单独打一次 API。

    **Commons 取不到时降级到切段而不是报错。** 这条是实测逼出来的：
    公共音源站会限流（实测一次 `Retry-After: 600`），一封十分钟，
    期间所有未预热的音位全哑。而切段这条路完全在本地——TTS 加已有的强制对齐——
    覆盖同样是 44/44，只是听感不同：Commons 是语音学家的孤立示范，
    切段是真词里的那一段（带协同发音）。

    质量上 Commons 更适合「认识这个音」，所以它仍是首选；
    但**可用性不该押在它身上**。降级路径在 `info` 里标出来，
    界面按 BR-93 显示出处，用户知道自己听的是哪一种。
    """
    mp3, meta = cache_paths(media_root, symbol)
    if mp3.exists() and meta.exists():
        return mp3, json.loads(meta.read_text(encoding="utf-8"))
    if shutil.which("ffmpeg") is None:
        raise PhonemeAudioUnavailable("未安装 ffmpeg")
    mp3.parent.mkdir(parents=True, exist_ok=True)

    if source.strategy == "commons":
        try:
            info = await _from_commons(source, mp3, resolved)
        except PhonemeAudioUnavailable as exc:
            if not fallback_words:
                raise
            logger.info("%s 的 Commons 录音取不到（%s），改从例词切段", symbol, exc)
            # **逐个试，不能只认第一个例词。** 例词是按词典音标选的，
            # 而切段要的是 TTS **实际读出来**的那一版：/ə/ 的首选例词是 and，
            # 词典记 /ənd/，TTS 却按重读形念成 /æ n d/——对齐结果里根本没有 ə。
            # 只试一个的话这类音位会退回 503，等于降级路径白写。
            info = None
            for word in fallback_words:
                degraded = AudioSource(
                    "word-clip",
                    clip_word=word,
                    align_alts=source.align_alts,
                    clip_accent=source.clip_accent,
                )
                try:
                    info = await _from_word_clip(degraded, symbol, mp3, timings_of)
                except PhonemeAudioUnavailable:
                    continue
                break
            if info is None:
                raise PhonemeAudioUnavailable(
                    f"Commons 取不到，且 {'/'.join(fallback_words)} 里都切不出 {symbol}"
                ) from exc
            info["degraded_from"] = "commons"
    else:
        info = await _from_word_clip(source, symbol, mp3, timings_of)
    info["symbol"] = symbol
    meta.write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
    return mp3, info

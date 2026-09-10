"""ECDICT 补全：例句、带口音的音标与真人录音（模块 01 v10 FR-129~131）。

数据源 dictionaryapi.dev：免费、无 key、无需注册；释义与例句来自 Wiktionary，
音频来自 Wikimedia Commons（CC BY-SA），文件名带口音后缀（`challenge-us.mp3`）。

它不是主档，只做补充——ECDICT 仍是中文释义与考纲/词频标注的唯一来源。
覆盖不齐是常态（实测 challenge 只有美音、schedule 有澳音美音没英音），
所以发音的兜底始终是 TTS，这里拿到什么算什么。

按词落库缓存，查不到的词记 `status='miss'` 负缓存，不反复打网络。
"""

import asyncio
import hashlib
import logging
import re
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from domain.models import DictEnrich
from domain.network_policy import routed_http_client

logger = logging.getLogger(__name__)

API = "https://api.dictionaryapi.dev/api/v2/entries/en"
TIMEOUT = 6.0
MAX_EXAMPLES = 6
#音频文件名后缀 → 口音；ca 归到 us（北美）
_ACCENT_RE = re.compile(r"-(us|uk|au|ca)\.mp3$", re.I)
_ACCENT_MAP = {"us": "us", "ca": "us", "uk": "uk", "au": "au"}


def accent_of(audio_url: str) -> str:
    m = _ACCENT_RE.search(audio_url or "")
    return _ACCENT_MAP.get(m.group(1).lower(), "") if m else ""


def split_ecdict_phonetic(raw: str | None) -> list[str]:
    """ECDICT 把多个读音塞进一个字段用 `.` 或 `,` 分隔（`liv.laiv`、`li:d. led`）。

    只对 ECDICT 的串这么拆——dictionaryapi.dev 的 IPA 用 `.` 作音节分隔符
    （`/ˈtʃæl.əndʒ/`），拿同一套规则去拆会把一个读音劈成两半。
    """
    if not raw or not raw.strip():
        return []
    parts = [p.strip().strip("/[]") for p in re.split(r"[.,]", raw)]
    parts = [p for p in parts if len(p) >= 2]
    return parts if len(parts) > 1 else ([raw.strip()] if raw.strip() else [])


def _normalize(payload: list) -> tuple[list[dict], list[dict]]:
    phonetics: list[dict] = []
    examples: list[dict] = []
    seen_ph: set[tuple[str, str]] = set()
    seen_ex: set[str] = set()
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        for ph in entry.get("phonetics") or []:
            text = (ph.get("text") or "").strip()
            audio = (ph.get("audio") or "").strip()
            if not text and not audio:
                continue
            accent = accent_of(audio)
            key = (text, accent)
            if key in seen_ph:
                continue
            seen_ph.add(key)
            phonetics.append({"text": text, "accent": accent, "audio": audio})
        for meaning in entry.get("meanings") or []:
            pos = meaning.get("partOfSpeech") or ""
            for d in meaning.get("definitions") or []:
                ex = (d.get("example") or "").strip()
                if not ex or ex.lower() in seen_ex or len(examples) >= MAX_EXAMPLES:
                    continue
                seen_ex.add(ex.lower())
                examples.append({
                    "pos": pos,
                    "definition": (d.get("definition") or "").strip(),
                    "example": ex,
                })
    return phonetics, examples


async def _fetch(word: str) -> tuple[str, list[dict], list[dict]]:
    """→ (status, phonetics, examples)。网络异常不抛，降级成 error 让调用方照常返回。"""
    try:
        async with routed_http_client(timeout=TIMEOUT) as client:
            resp = await client.get(f"{API}/{word}")
        if resp.status_code == 404:
            return "miss", [], []
        resp.raise_for_status()
        payload = resp.json()
        if not isinstance(payload, list):
            return "miss", [], []
        ph, ex = _normalize(payload)
        return "ok", ph, ex
    except Exception as exc:  # noqa: BLE001 外部服务，任何异常都只降级不影响查词
        logger.warning("dict_enrich 拉取失败 word=%s: %s", word, exc)
        return "error", [], []


async def get_or_fetch(session: AsyncSession, word: str) -> DictEnrich | None:
    """读缓存，没有就现拉一次并落库。error 不写库，下次再试。"""
    key = word.strip().lower()
    if not key:
        return None
    row = await session.get(DictEnrich, key)
    if row is not None:
        return row
    status, phonetics, examples = await _fetch(key)
    if status == "error":
        return None
    row = DictEnrich(
        word=key, phonetics=phonetics, examples=examples, status=status,
        source="dictionaryapi.dev",
    )
    session.add(row)
    try:
        await session.commit()
    except Exception:  # 并发下同词可能已被写入，回滚后按已有的读
        await session.rollback()
        row = await session.get(DictEnrich, key)
    return row


def audio_cache_path(media_root: str, url: str) -> Path:
    digest = hashlib.sha256(url.encode()).hexdigest()
    return Path(media_root) / "dictaudio" / f"{digest}.mp3"


async def cache_audio(media_root: str, url: str) -> Path | None:
    """真人录音落盘代理：外链可能挂、可能被墙，缓存后由本服务发。"""
    path = audio_cache_path(media_root, url)
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        async with routed_http_client(timeout=TIMEOUT, follow_redirects=True) as client:
            resp = await client.get(url)
        resp.raise_for_status()
        tmp = path.with_suffix(".part")
        await asyncio.to_thread(tmp.write_bytes, resp.content)
        tmp.rename(path)
        return path
    except Exception as exc:  # noqa: BLE001
        logger.warning("词典录音缓存失败 %s: %s", url, exc)
        return None

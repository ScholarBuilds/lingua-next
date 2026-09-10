from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.media import file_response
from app.owner import CurrentOwner
from domain import dict_search
from domain.dict_enrich import cache_audio, get_or_fetch, split_ecdict_phonetic
from domain.dict_gloss import FREQ_BANDS as FREQ_BANDS
from domain.dict_gloss import freq_band as freq_band
from domain.dict_gloss import short_gloss
from domain.models import DictEntry

SessionDep = Annotated[AsyncSession, Depends(get_session)]

router = APIRouter(prefix="/dict", tags=["dict"])


class GlossQuery(BaseModel):
    words: list[str] = Field(min_length=1, max_length=600)


@router.post("/gloss")
async def batch_gloss(payload: GlossQuery, session: SessionDep) -> dict:
    """批量小译（FR-381 生词小译）：词表 → 每词一条极短中文，查不到的不返回。

    一次性取回整章生词，避免逐词请求（一章几十个生词 = 几十次往返）。
    """
    keys = {w.strip().lower() for w in payload.words if w.strip()}
    if not keys:
        return {"gloss": {}}
    rows = (
        await session.execute(
            select(DictEntry.word, DictEntry.translation).where(DictEntry.word.in_(keys))
        )
    ).all()
    gloss = {}
    for word, translation in rows:
        short = short_gloss(translation)
        if short:
            gloss[word] = short
    return {"gloss": gloss}


class SearchQuery(BaseModel):
    q: str = Field(min_length=1, max_length=dict_search.MAX_QUERY_LEN)


def _search_key(q: str) -> str:
    key = dict_search.normalize(q)
    if not key:
        raise HTTPException(status_code=400, detail="empty query")
    if len(key) > dict_search.MAX_QUERY_LEN:
        raise HTTPException(status_code=400, detail="query too long")
    return key


# 这两个路由必须排在 /{word} 之前，否则 /dict/search 会被当成单词 "search" 查出 404
@router.get("/suggest")
async def suggest(q: str, session: SessionDep, owner: CurrentOwner, limit: int = 8) -> dict:
    """⌘K 联想（FR-507）：中英皆可，前几条带极短中文与学习状态。"""
    return await dict_search.suggest(
        session, _search_key(q), owner_id=owner.id, limit=min(max(limit, 1), 20)
    )


@router.get("/search")
async def search(q: str, session: SessionDep, owner: CurrentOwner, limit: int = 20) -> dict:
    """查词页的分组结果（FR-508~510）。索引没建时 200 + ready=false，不是 404。"""
    return await dict_search.search(
        session, _search_key(q), owner_id=owner.id, limit=min(max(limit, 1), 100)
    )


@router.get("/{word}")
async def lookup(word: str, session: SessionDep) -> dict:
    key = word.strip()
    if not key:
        raise HTTPException(status_code=400, detail="empty word")
    entry = await session.get(DictEntry, key)
    if entry is None and key != key.lower():
        entry = await session.get(DictEntry, key.lower())
    if entry is None:
        # 简单词形回退：去掉常见屈折后缀再查一次（完整词形还原在解析管线做）
        stmt = select(DictEntry).where(DictEntry.word == key.lower().rstrip("s")).limit(1)
        entry = (await session.execute(stmt)).scalar_one_or_none()
    if entry is None:
        raise HTTPException(status_code=404, detail="not in local dict")
    return {
        "word": entry.word,
        "phonetic": entry.phonetic,
        "translation": entry.translation,
        "definition": entry.definition,
        "pos": entry.pos,
        "collins": entry.collins,
        "oxford": entry.oxford,
        "tags": entry.tag.split() if entry.tag else [],
        "freq_band": freq_band(entry.frq),
        "frq": entry.frq,
        "exchange": entry.exchange,
        "source": "ECDICT",
    }


# 口音展示序：英音在前（学习者更常被要求英音），其次美音、澳音，最后无标注
_ACCENT_ORDER = {"uk": 0, "us": 1, "au": 2, "": 3}


@router.get("/{word}/enrich")
async def enrich(word: str, session: SessionDep) -> dict:
    """例句 + 带口音的音标/录音（FR-129~131）。

    与 `/dict/{word}` 分开是有意的：本地词典要瞬间出卡，这里要打外网，
    合在一起会让每个新词的首次开卡都多等几百毫秒。前端并行拉、后到后补。
    """
    key = word.strip()
    if not key:
        raise HTTPException(status_code=400, detail="empty word")

    row = await get_or_fetch(session, key)
    entry = await session.get(DictEntry, key.lower())

    merged: list[dict] = []
    seen: set[str] = set()
    for ph in row.phonetics if row else []:
        text = (ph.get("text") or "").strip().strip("/")
        if text and text.lower() in seen:
            continue
        if text:
            seen.add(text.lower())
        merged.append(
            {
                "text": text,
                "accent": ph.get("accent") or "",
                "has_audio": bool(ph.get("audio")),
            }
        )
    # ECDICT 只在外部源没给出读音时兜底：它的音标是非标准转写（`ә` 而非 `ə`），
    # 与标准 IPA 并列会变成同一个读音的两种写法（live 会同时出 lɪv 和 liv）
    if not merged:
        for text in split_ecdict_phonetic(entry.phonetic if entry else None):
            if text.lower() in seen:
                continue
            seen.add(text.lower())
            merged.append({"text": text, "accent": "", "has_audio": False})
    merged.sort(key=lambda p: _ACCENT_ORDER.get(p["accent"], 9))

    return {
        "word": key,
        "phonetics": merged,
        "examples": row.examples if row else [],
        "status": row.status if row else "error",
        "source": "dictionaryapi.dev",
        "license": "Wiktionary / Wikimedia Commons (CC BY-SA)",
    }


@router.get("/{word}/audio")
async def audio(word: str, accent: str, session: SessionDep) -> Response:
    """真人录音代理：外链落盘后由本服务发，避免外站挂掉或被墙时词卡哑火。"""
    row = await get_or_fetch(session, word)
    if row is None or row.status != "ok":
        raise HTTPException(status_code=404, detail="no enrich data")
    url = next(
        (p.get("audio") for p in row.phonetics if p.get("accent") == accent and p.get("audio")),
        None,
    )
    if not url:
        raise HTTPException(status_code=404, detail="no audio for accent")
    path = await cache_audio(get_settings().media_root, url)
    if path is None:
        raise HTTPException(status_code=502, detail="audio fetch failed")
    return file_response(path, media_type="audio/mpeg", headers={"X-Audio-Source": "wikimedia"})

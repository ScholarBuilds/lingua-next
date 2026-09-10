"""音标与发音训练接口（模块 13）。

四块：音位卡片总览与详情、最小对立对听辨训练（HVPT）、音标认读题、结业进度与薄弱雷达。

出题一律走[练习引擎](../../domain/exercise.py)的题目 Schema 与判分纯函数，
本模块只负责**出内容**与**接调度**，不自己写判分。
"""

from __future__ import annotations

import json
import random
from datetime import UTC, datetime
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import Integer, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.media import file_response
from app.owner import CurrentOwner
from app.routers.dict import SessionDep
from domain import exercise, srs
from domain.models import (
    DictEntry,
    MinimalPair,
    Phoneme,
    PhonemeAttempt,
    PhonemeCardState,
    PhonemeDifficulty,
    WordPhoneme,
)
from domain.phoneme_audio import (
    PhonemeAudioUnavailable,
    cache_paths,
    ensure_phoneme_audio,
)
from domain.phoneme_audio_sources import AUDIO_SOURCES, COMMONS_CREDIT
from domain.phoneme_cards import CONTRAST_GROUPS, HVPT_TARGET_SECONDS, SVG_NOTES
from domain.phonetics import ipa_symbols, parse_arpabet, strip_stress

router = APIRouter(prefix="/phonetics", tags=["phonetics"])

# HVPT 的核心是高变异（FR-393e）：每题从这批音色里随机抽，同一个词换人说。
# 只收母语变体（US/GB/AU/CA/IE/NZ）——训练目标是这几种口音的音位范畴，
# 掺进 en-IN / en-SG 会把要建立的范畴边界搅乱。
HVPT_VOICES = [
    "edge:en-US-AriaNeural", "edge:en-US-JennyNeural", "edge:en-US-MichelleNeural",
    "edge:en-US-AnaNeural", "edge:en-US-EmmaNeural", "edge:en-US-AvaNeural",
    "edge:en-US-GuyNeural", "edge:en-US-ChristopherNeural", "edge:en-US-EricNeural",
    "edge:en-US-RogerNeural", "edge:en-US-SteffanNeural", "edge:en-US-AndrewNeural",
    "edge:en-US-BrianNeural",
    "edge:en-GB-SoniaNeural", "edge:en-GB-LibbyNeural", "edge:en-GB-MaisieNeural",
    "edge:en-GB-RyanNeural", "edge:en-GB-ThomasNeural",
    "edge:en-AU-NatashaNeural", "edge:en-AU-WilliamMultilingualNeural",
    "edge:en-CA-ClaraNeural", "edge:en-CA-LiamNeural",
    "edge:en-IE-EmilyNeural", "edge:en-IE-ConnorNeural",
    "edge:en-NZ-MollyNeural", "edge:en-NZ-MitchellNeural",
]  # fmt: skip

MIN_VOICES_PER_DRILL = 6  # AC-92
# 出题词频档：从常用往罕见逐级放宽，凑够题量就停
FREQ_BANDS = (8000, 15000, 30000, 10**9)
DEFAULT_DRILL_SIZE = 10
# 一道听辨题按 12 秒计入训练时长：播两遍音 + 反馈，实测节奏就在这个量级。
# 计时不做前端上报——那会让「结业进度」变成可以刷的数（BR-94 同源考虑）。
SECONDS_PER_ITEM = 12
# 示范音频的默认音色：逐音素高亮要口齿清楚、语速稳定
DEMO_VOICE = "en-US-AriaNeural"


# ──────────────────────────── 音位卡片 ────────────────────────────


def _card_public(p: Phoneme, diff: PhonemeDifficulty | None) -> dict:
    return {
        "symbol": p.symbol,
        "symbol_us": p.symbol_us,
        "arpabet": p.arpabet,
        "kind": p.kind,
        "manner": p.manner,
        "place": p.place,
        "voiced": p.voiced,
        "zh_name": p.zh_name,
        "examples": p.examples or {},
        "common_errors": p.common_errors or [],
        "tips": p.tips,
        "svg_frames": p.svg_frames or [],
        "svg_note": SVG_NOTES.get(p.symbol),
        "chart": (
            {"x": p.chart_x, "y": p.chart_y}
            if p.chart_x is not None
            else None
        ),
        "chart_to": (
            {"x": p.chart_to_x, "y": p.chart_to_y}
            if p.chart_to_x is not None
            else None
        ),
        "highlight": p.highlight or [],
        "contrast_with": p.contrast_with or [],
        # 示范音出处。BR-93 的来源可见原则同样适用于音频：
        # 「语音学家录的独立音位」与「从合成词里切的一段」是两回事，前端要能区分
        "audio": _audio_public(p.symbol),
        # 难度来自 speechocean762 的普通话母语者标注（FR-391），没有则为空——
        # 空不等于「简单」，前端要显示「无数据」而不是 0
        "difficulty": (
            {
                "low_score_rate": diff.low_score_rate,
                "mean_score": diff.mean_score,
                "sample_n": diff.sample_n,
            }
            if diff
            else None
        ),
    }


def _audio_public(symbol: str) -> dict | None:
    """音位示范音的出处。

    **以磁盘上那份缓存为准，不是以计划为准。** Commons 取不到时会降级到切段，
    这时若还按计划报「Wikimedia Commons，CC BY-SA 3.0」，就是给一段本项目
    自己合成的音频挂了别人的许可证——比不署名更糟。BR-93 的来源可见原则
    在这里是硬要求：用户看到的出处必须是他实际听到的那一份。
    """
    src = AUDIO_SOURCES.get(symbol)
    if src is None:
        return None
    strategy, license_, clip_word = src.strategy, src.license, src.clip_word
    _, meta = cache_paths(get_settings().media_root, symbol)
    if meta.exists():
        try:
            cached = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            cached = {}
        strategy = cached.get("strategy", strategy)
        license_ = cached.get("license", "") if strategy == "commons" else ""
        clip_word = cached.get("clip_word", clip_word)
    return {
        "url": f"/api/phonetics/phonemes/{quote(symbol)}/audio",
        "strategy": strategy,
        "license": license_,
        "credit": COMMONS_CREDIT if strategy == "commons" else "",
        "clip_word": clip_word,
    }


async def _difficulty_map(session: AsyncSession) -> dict[str, PhonemeDifficulty]:
    rows = (await session.execute(select(PhonemeDifficulty))).scalars().all()
    return {d.symbol: d for d in rows}


@router.get("/phonemes")
async def list_phonemes(session: SessionDep) -> dict:
    """44 个音位的总览（FR-392a/b）：元音带四边形坐标，辅音带剖面图帧。"""
    cards = (await session.execute(select(Phoneme).order_by(Phoneme.order_index))).scalars().all()
    diffs = await _difficulty_map(session)
    items = [_card_public(c, diffs.get(strip_stress(c.arpabet.split()[0]))) for c in cards]
    return {
        "items": items,
        "vowels": [i for i in items if i["kind"] == "vowel"],
        "consonants": [i for i in items if i["kind"] == "consonant"],
        # IPA 元音四边形按官方版重绘，署名义务在这里兑现（FR-392b）
        "chart_credit": "元音四边形版式依据 International Phonetic Association，CC BY-SA 4.0",
        "svg_credit": "口腔剖面图 drammock/phonetics-teaching-assets，CC0-1.0",
    }


@router.get("/phonemes/{symbol}")
async def phoneme_detail(symbol: str, session: SessionDep) -> dict:
    card = (
        await session.execute(select(Phoneme).where(Phoneme.symbol == symbol))
    ).scalar_one_or_none()
    if card is None:
        raise HTTPException(status_code=404, detail=f"没有音位 {symbol}")
    diffs = await _difficulty_map(session)
    payload = _card_public(card, diffs.get(strip_stress(card.arpabet.split()[0])))

    # 例词补音标与释义：展示链路读 word_phoneme，不读 ECDICT 的脏 phonetic（BR-91）
    words = sorted({w for group in (card.examples or {}).values() for w in group})
    if words:
        rows = (
            await session.execute(
                select(WordPhoneme.word, WordPhoneme.ipa_us, WordPhoneme.ipa_uk, WordPhoneme.source)
                .where(WordPhoneme.word.in_(words))
            )
        ).all()
        gloss = dict(
            (
                await session.execute(
                    select(func.lower(DictEntry.word), DictEntry.translation).where(
                        func.lower(DictEntry.word).in_(words)
                    )
                )
            ).all()
        )
        payload["example_details"] = {
            w: {
                "ipa_us": us,
                "ipa_uk": uk,
                "source": src,
                "gloss": (gloss.get(w) or "").split("\n")[0] or None,
            }
            for w, us, uk, src in rows
        }
    # 关联的对比组：直通听辨训练
    payload["contrast_groups"] = [
        g for g in CONTRAST_GROUPS if card.arpabet.split()[0] in (g["a"], g["b"])
    ]
    return payload


@router.get("/word/{word}")
async def word_phonemes(word: str, session: SessionDep) -> dict:
    """单词的音素分解（FR-397）：给阅读器点词面板里的小控件用。"""
    key = word.strip().lower()
    row = (
        await session.execute(select(WordPhoneme).where(WordPhoneme.word == key))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=f"没有 {word} 的音素数据")
    phones = [strip_stress(p) for p in parse_arpabet(row.arpabet or "")]
    known = dict(
        (
            await session.execute(
                select(Phoneme.arpabet, Phoneme.symbol).where(Phoneme.arpabet.in_(phones))
            )
        ).all()
    )
    return {
        "word": row.word,
        "ipa_us": row.ipa_us,
        "ipa_uk": row.ipa_uk,
        "arpabet": row.arpabet,
        "syllables": row.syllables,
        "stress": row.stress,
        "source": row.source,
        "symbols": ipa_symbols(row.ipa_us or ""),
        # 每个音素能否点进音位卡片：多音素音位（ɪə）在这里拆开就只剩单音素，属正常
        "phones": [{"arpabet": p, "symbol": known.get(p)} for p in phones],
    }


# 各供应商的英音音色。**这张表必须存在**：`clip_accent="en-GB"` 是硬要求
# （央化双元音在美音里不存在），而音色 id 是各家专有的，写死任何一家
# 换供应商时那三个音位就悄悄退回美音，错得没有任何迹象。
GB_VOICE = {
    "edge-tts": "en-GB-SoniaNeural",
    "volcengine": "en_female_authoritative-british_uranus_bigtts",  # 官方标注「教学」
}


async def ensure_word_timings(
    word: str, accent: str | None = None, session: AsyncSession | None = None
) -> dict:
    """逐音素时间戳已随音素模型一起下线（2026-08-30）。

    它靠 `domain.phoneme_asr` 的强制对齐把示范词切成音素区间，而那个模型是
    发音评分那条线的产物，评分下线后它在运行时没有任何消费方——
    `/word/{word}/timings` 前端零调用，音位示范音 44/44 已落盘走缓存。

    保留这个桩而不是删掉签名，是因为 `ensure_phoneme_audio` 的 `timings_of` 注入点
    还在：Commons 限流时它会来试切段，此时要拿到一句能写进降级说明的话，
    而不是一个 ImportError。已缓存的音位不经过这里。
    """
    raise PhonemeAudioUnavailable(
        f"逐音素对齐已下线，切不出 {word} 的音素区间（音位示范音走磁盘缓存不受影响）"
    )


@router.get("/phonemes/{symbol}/audio", response_model=None)
async def phoneme_audio(symbol: str, session: SessionDep) -> Response:
    """音位本身的示范音（**不是例词**）。

    这条路由存在的理由是一条被写反了的规则：点 /θ/ 要听到那个摩擦音，
    而不是 think。旧实现放例词，理由是「音位没法单独 TTS 合成」——
    前半句对，结论错：合成不出来不等于拿不到，见 `domain/phoneme_audio.py`。

    （**TTS 确实做不到**，2026-08-23 用火山 seed-tts-2.0 实测过：
    喂 `θ` 读成 /t aɪ a/、喂 `/θ/` 读成 /s eɪ d a/、喂 `ə` 读成 /ʔ a l/，
    六个里五个错。判定用的是本仓的音素识别模型，不是耳朵。）

    Commons 取不到时降级到从例词切段，不给哑按钮。
    """
    source = AUDIO_SOURCES.get(symbol)
    if source is None:
        raise HTTPException(status_code=404, detail=f"没有音位 {symbol}")
    # 降级用的示范词直接取这个音位已有的例词（FR-392g 按位置分组，词首那个最干净），
    # 不另写一张表：例词本来就是按 CMUdict + 词频算出来的，跟着数据走不会过期
    card = (
        await session.execute(select(Phoneme).where(Phoneme.symbol == symbol))
    ).scalar_one_or_none()
    examples = (card.examples or {}) if card else {}
    # 给一串候选而不是一个：切段要的是 TTS 实际读出来的那一版，
    # 与词典音标未必一致（/ə/ 的首选例词 and 会被念成重读的 /æ n d/）
    # 表里显式指定的示范词排在最前：例词是按词频选的，对某些音位天然不合用
    # （/ə/ 的例词全是虚词，TTS 单念虚词一律用重读形，里头没有弱读音）
    fallback = tuple(
        dict.fromkeys(
            ([source.clip_word] if source.clip_word else [])
            + [w for pos in ("initial", "medial", "final") for w in (examples.get(pos) or [])]
        )
    )[:6]
    try:
        path, _ = await ensure_phoneme_audio(
            get_settings().media_root,
            symbol,
            source,
            # 把本次请求的 session 绑进去：切段要合成示范词，
            # 而合成走哪家由用户配的场景绑定决定，没有 session 就只能退 Edge
            lambda w, accent: ensure_word_timings(w, accent, session),
            fallback_words=fallback,
        )
    except PhonemeAudioUnavailable as exc:
        # 两条路都走不通才报，前端据此退到「在词里」「整词」两档
        raise HTTPException(status_code=503, detail=f"没有 {symbol} 的示范音：{exc}") from exc
    return file_response(path, media_type="audio/mpeg")


# ──────────────────────────── 听辨训练 ────────────────────────────


@router.get("/contrasts")
async def list_contrasts(owner: CurrentOwner, session: SessionDep) -> dict:
    """13 个对比组 + 题库量 + 调度状态（FR-393d）。"""
    counts = dict(
        (
            await session.execute(
                select(MinimalPair.contrast_group, func.count()).group_by(
                    MinimalPair.contrast_group
                )
            )
        ).all()
    )
    states = {
        s.card_key: s
        for s in (
            await session.execute(
                select(PhonemeCardState).where(
                    PhonemeCardState.user_id == owner.id,
                    PhonemeCardState.kind == "contrast",
                )
            )
        ).scalars()
    }
    diffs = await _difficulty_map(session)
    now = datetime.now(UTC)
    items = []
    for g in CONTRAST_GROUPS:
        st = states.get(g["key"])
        hardness = max(
            (diffs[p].low_score_rate for p in (g["a"], g["b"]) if p in diffs),
            default=None,
        )
        items.append(
            {
                **g,
                "pairs": counts.get(g["key"], 0),
                "state": srs.card_state_name(st.fsrs_card if st else None),
                "due": st.due_at.isoformat() if st and st.due_at else None,
                "due_now": bool(st and st.due_at and st.due_at <= now) or st is None,
                "reps": st.reps if st else 0,
                "lapses": st.lapses if st else 0,
                "trained_seconds": st.trained_seconds if st else 0,
                "hardness": hardness,
            }
        )
    # 难的排前面：这张表是本模块的差异化点，用它驱动出题顺序（FR-391）
    items.sort(key=lambda i: (-(i["hardness"] or 0), i["key"]))
    return {"items": items, "voices": len(HVPT_VOICES)}


def _pair_question(pair: MinimalPair, rng: random.Random, group: dict) -> dict:
    """一道二选一强制选择题（FR-393a）。

    题干音频只放**一个**词，选项给两个——这是 identification（g=.95），
    不是让用户判断两词是否相同的 discrimination（g=.57）。
    """
    target_is_a = rng.random() < 0.5
    target = pair.word_a if target_is_a else pair.word_b
    target_ipa = pair.ipa_a if target_is_a else pair.ipa_b
    other_ipa = pair.ipa_b if target_is_a else pair.ipa_a
    choices = [pair.word_a, pair.word_b]
    rng.shuffle(choices)
    answer = choices.index(target)
    wrong_word = choices[1 - answer]
    return {
        "id": f"mp-{pair.id}-{'a' if target_is_a else 'b'}",
        "widget": "minimal-pair",
        "prompt": "听到的是哪个词？",
        "choices": choices,
        "answer": answer,
        "audio": {"text": target, "voice": rng.choice(HVPT_VOICES)},
        "meta": {
            "pair_id": pair.id,
            "group": pair.contrast_group,
            "target": target,
            "target_ipa": target_ipa,
            "other": wrong_word,
            "other_ipa": other_ipa,
            "diff_index": pair.diff_index,
            "phone_a": pair.phone_a,
            "phone_b": pair.phone_b,
            "note": group.get("note"),
        },
        # 答错时的定向反馈（FR-393b）：并排回放、高亮 IPA 差异位、弹剖面图
        "misconceptions": [
            {
                "id": f"confuse-{pair.contrast_group}",
                "match": "equals",
                "value": str(1 - answer),
                "feedback": f"这次读的是 {target} /{target_ipa}/，"
                f"你选的 {wrong_word} 是 /{other_ipa}/——差别只在第 "
                f"{pair.diff_index + 1} 个音素。",
            }
        ],
    }


@router.get("/drill")
async def build_drill(
    session: SessionDep,
    group: str = Query(..., description="对比组 key，如 θ/s"),
    n: int = Query(DEFAULT_DRILL_SIZE, ge=1, le=30),
    seed: int | None = None,
) -> dict:
    """出一组听辨题。同一组题内音色数 ≥6（AC-92）。"""
    meta = next((g for g in CONTRAST_GROUPS if g["key"] == group), None)
    if meta is None:
        raise HTTPException(status_code=404, detail=f"没有对比组 {group}")
    # 逐档放宽词频：优先只用常用词出题，够不着才往下放。
    # ð/z 这种对比在英语里本来就稀缺（全语言不过二十来组），会一路放到底，属正常。
    rows: list[MinimalPair] = []
    band = 0
    for band in FREQ_BANDS:
        rows = (
            await session.execute(
                select(MinimalPair)
                .where(MinimalPair.contrast_group == group)
                .where(MinimalPair.freq_rank <= band)
                .order_by(MinimalPair.freq_rank)
                .limit(120)
            )
        ).scalars().all()
        if len(rows) >= max(2 * n, 12):
            break
    if not rows:
        raise HTTPException(status_code=404, detail=f"对比组 {group} 还没有题库")

    rng = random.Random(seed)
    picked = rng.sample(rows, min(n, len(rows)))
    questions = [_pair_question(p, rng, meta) for p in picked]

    # 音色够不够是硬指标：抽样可能撞车，撞了就按轮转补齐而不是听天由命
    voices = {q["audio"]["voice"] for q in questions}
    if len(voices) < min(MIN_VOICES_PER_DRILL, len(questions)):
        pool = rng.sample(HVPT_VOICES, min(len(HVPT_VOICES), max(len(questions), 6)))
        for i, q in enumerate(questions):
            q["audio"]["voice"] = pool[i % len(pool)]
        voices = {q["audio"]["voice"] for q in questions}

    for q in questions:
        exercise.validate(q)
    return {
        "group": meta,
        "questions": questions,
        "voice_count": len(voices),
        "pool": len(rows),
        "freq_band": band,
    }


# ──────────────────────────── 认读题（FR-395） ────────────────────────────


@router.get("/decode")
async def build_decode(
    session: SessionDep,
    mode: str = Query("ipa2word", pattern="^(ipa2word|word2ipa)$"),
    n: int = Query(DEFAULT_DRILL_SIZE, ge=1, le=30),
    seed: int | None = None,
) -> dict:
    """看音标选词 / 看词选音标。

    练的是「音标符号认读」——这是国内学习者的实际短板，听辨题练不到（FR-395）。
    干扰项从**音标相近**的词里选，不是随机抽词：随机干扰项一眼就能排除，题就白出了。
    """
    rng = random.Random(seed)
    rows = (
        await session.execute(
            select(WordPhoneme.word, WordPhoneme.ipa_us, WordPhoneme.arpabet, DictEntry.frq)
            .join(DictEntry, func.lower(DictEntry.word) == WordPhoneme.word)
            .where(WordPhoneme.ipa_us.is_not(None), WordPhoneme.arpabet.is_not(None))
            .where(DictEntry.frq > 0, DictEntry.frq < 6000)
            .where(func.length(WordPhoneme.word) <= 8)
        )
    ).all()
    if len(rows) < 8:
        raise HTTPException(status_code=503, detail="音标题库尚未建立，先跑 seed_phonemes.py")

    by_len: dict[int, list] = {}
    for r in rows:
        by_len.setdefault(len(parse_arpabet(r.arpabet)), []).append(r)

    questions = []
    for target in rng.sample(rows, min(n, len(rows))):
        n_phones = len(parse_arpabet(target.arpabet))
        siblings = [r for r in by_len.get(n_phones, []) if r.word != target.word]
        distractors = rng.sample(siblings, 3) if len(siblings) >= 3 else rng.sample(rows, 3)
        options = [target, *distractors]
        rng.shuffle(options)
        answer = next(i for i, o in enumerate(options) if o.word == target.word)
        if mode == "ipa2word":
            prompt, choices = f"/{target.ipa_us}/", [o.word for o in options]
        else:
            prompt, choices = target.word, [f"/{o.ipa_us}/" for o in options]
        questions.append(
            {
                "id": f"dec-{mode}-{target.word}",
                "widget": "phoneme-decode",
                "prompt": prompt,
                "choices": choices,
                "answer": answer,
                "meta": {"word": target.word, "ipa": target.ipa_us, "mode": mode},
            }
        )
    for q in questions:
        exercise.validate(q)
    return {"mode": mode, "questions": questions}


# ──────────────────────────── 作答与调度 ────────────────────────────


class AnswerIn(BaseModel):
    kind: str = Field(pattern="^(contrast|decode|encode)$")
    card_key: str = Field(min_length=1, max_length=64)
    question: dict
    response: object = None
    elapsed_ms: int | None = Field(default=None, ge=0)


@router.post("/answer")
async def submit_answer(body: AnswerIn, owner: CurrentOwner, session: SessionDep) -> dict:
    """判分 + 落流水。判分走练习引擎的纯函数，这里只负责持久化。"""
    try:
        result = exercise.score(body.question, body.response)
    except exercise.QuestionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    session.add(
        PhonemeAttempt(
            user_id=owner.id,
            kind=body.kind,
            card_key=body.card_key,
            question_id=str(body.question.get("id", ""))[:128],
            correct=result.correct,
            elapsed_ms=body.elapsed_ms,
            detail={"meta": body.question.get("meta"), **result.detail},
        )
    )
    await session.commit()
    return result.to_dict()


class GradeIn(BaseModel):
    kind: str = Field(pattern="^(contrast|decode|encode)$")
    card_key: str = Field(min_length=1, max_length=64)
    rating: int = Field(ge=1, le=4)
    items: int = Field(default=0, ge=0, le=100)


@router.post("/grade")
async def grade_session(body: GradeIn, owner: CurrentOwner, session: SessionDep) -> dict:
    """一轮练完给一次评分，推进 FSRS（FR-393f）。

    调度逻辑一行不改地复用 `domain/srs.py`：这里只做卡片字典的进出。
    """
    st = (
        await session.execute(
            select(PhonemeCardState).where(
                PhonemeCardState.user_id == owner.id,
                PhonemeCardState.kind == body.kind,
                PhonemeCardState.card_key == body.card_key,
            )
        )
    ).scalar_one_or_none()
    if st is None:
        st = PhonemeCardState(
            user_id=owner.id,
            kind=body.kind,
            card_key=body.card_key,
            fsrs_card=srs.init_card(),
        )
        session.add(st)
        await session.flush()

    card, _log, due = srs.review(st.fsrs_card or srs.init_card(), body.rating)
    st.fsrs_card = card
    st.due_at = due
    st.last_review_at = datetime.now(UTC)
    st.reps += 1
    if body.rating == 1:
        st.lapses += 1
    st.trained_seconds += body.items * SECONDS_PER_ITEM
    await session.commit()
    return {
        "state": srs.card_state_name(card),
        "due": due.isoformat(),
        "intervals": srs.preview_intervals(card),
        "trained_seconds": st.trained_seconds,
    }


@router.get("/progress")
async def progress(owner: CurrentOwner, session: SessionDep) -> dict:
    """结业进度（FR-394）+ 薄弱音位雷达（FR-391）。

    400 分钟不是随口定的：HVPT 元分析显示总训练量到这个点后收益趋平。
    做成进度条比无限刷题诚实，也回答了「练到什么时候算完」。
    """
    # HVPT 的 400 分钟是**听辨训练**的量，不是所有练习的总和。
    # 把认读题的时间也算进去，进度条会虚高，而那条线的依据（元分析）只针对听辨
    total_trained = (
        await session.execute(
            select(func.coalesce(func.sum(PhonemeCardState.trained_seconds), 0)).where(
                PhonemeCardState.user_id == owner.id,
                PhonemeCardState.kind == "contrast"
            )
        )
    ).scalar_one()
    decode_trained = (
        await session.execute(
            select(func.coalesce(func.sum(PhonemeCardState.trained_seconds), 0)).where(
                PhonemeCardState.user_id == owner.id,
                PhonemeCardState.kind != "contrast"
            )
        )
    ).scalar_one()
    per_group = dict(
        (
            await session.execute(
                select(PhonemeCardState.card_key, PhonemeCardState.trained_seconds).where(
                    PhonemeCardState.user_id == owner.id,
                    PhonemeCardState.kind == "contrast"
                )
            )
        ).all()
    )
    stats = (
        await session.execute(
            select(
                PhonemeAttempt.card_key,
                func.count().label("n"),
                func.sum(cast(PhonemeAttempt.correct, Integer)).label("ok"),
            )
            .where(PhonemeAttempt.user_id == owner.id)
            .group_by(PhonemeAttempt.card_key)
        )
    ).all()
    acc = {
        row.card_key: {"n": row.n, "correct": int(row.ok or 0), "rate": (row.ok or 0) / row.n}
        for row in stats
        if row.n
    }
    return {
        "target_seconds": HVPT_TARGET_SECONDS,
        "trained_seconds": int(total_trained),
        # 认读题时长单列：它有价值但不计入 HVPT 的收益趋平线
        "decode_seconds": int(decode_trained),
        "ratio": min(1.0, int(total_trained) / HVPT_TARGET_SECONDS),
        "groups": [
            {
                **g,
                "trained_seconds": per_group.get(g["key"], 0),
                "accuracy": acc.get(g["key"]),
            }
            for g in CONTRAST_GROUPS
        ],
    }

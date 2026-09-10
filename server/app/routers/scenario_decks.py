"""AI 场景本接口（需求 01 v2 §6）：生成入队、进度轮询、草稿确认。

独立前缀避免与 /wordlists/{key} 的路径参数抢匹配；草稿本本身仍存在 wordlist 表，
删除、改名等通用动作复用 /wordlists 的既有接口。
"""

import json
import uuid
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Literal

import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select

from app.config import get_settings
from app.queue import get_queue
from app.routers.dict import SessionDep
from domain import artifacts, decks, passages, pipeline, scenario_decks
from domain.llm import LLMUnavailable
from domain.models import (
    Article,
    PipelineInterrupt,
    PipelineRun,
    UserScenario,
    Wordlist,
    WordlistItem,
)
from domain.scenarios import DraftInvalid, generate_scenario_draft, sanitize_scenario

router = APIRouter(prefix="/scenario-decks", tags=["scenario-decks"])

SEED_FIELDS = ("key", "title_zh", "title_en", "emoji", "category", "cefr", "description")


@lru_cache
def load_seeds() -> list[dict]:
    """种子场景清单（FR-174）：文件缺失或损坏时返回空表，不拖垮书架页。"""
    path = Path(get_settings().scenario_seeds_path)
    if not path.is_file():
        return []
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError:
        return []
    seeds = data.get("seeds") if isinstance(data, dict) else None
    if not isinstance(seeds, list):
        return []
    return [
        {**s, "keywords": s.get("keywords") or []}
        for s in seeds
        if isinstance(s, dict) and all(s.get(f) for f in SEED_FIELDS)
    ]


def _job_key(job_id: str) -> str:
    return f"scenario_deck_job:{job_id}"


class GenerateBody(BaseModel):
    idea: str = Field(min_length=2, max_length=200)
    level: Literal["A1", "A2", "B1", "B2", "C1", "C2"] | None = None
    with_examples: bool = True
    # 默认生成完直接入库；打开后停在 confirm 节点等人过目（用户选定的默认值）
    need_confirm: bool = False
    with_passage: bool = True


@router.post("/generate", status_code=202)
async def generate(body: GenerateBody) -> dict:
    """自定义场景生成：入队后立即返回 job_id，进度走轮询（FR-172）。"""
    job_id = uuid.uuid4().hex
    queue = await get_queue()
    await queue.set(
        _job_key(job_id),
        json.dumps(
            {
                "job_id": job_id,
                "status": "running",
                "stage": "normalize",
                "stage_label": scenario_decks.STAGES["normalize"],
                "detail": "排队中",
                "idea": body.idea,
                "counts": {},
            },
            ensure_ascii=False,
        ),
        ex=3600,
    )
    await queue.enqueue_job(
        "generate_scenario_deck",
        job_id,
        body.idea,
        body.level,
        body.with_examples,
        None,
        None,
        None,
        body.need_confirm,
        body.with_passage,
    )
    return {"job_id": job_id}


@router.get("/jobs/{job_id}")
async def job_status(job_id: str) -> dict:
    queue = await get_queue()
    raw = await queue.get(_job_key(job_id))
    if raw is None:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")
    return json.loads(raw)


@router.get("/seeds")
async def seeds(session: SessionDep) -> list[dict]:
    """种子清单 + 是否已生成，供批量生成时跳过已有场景（FR-175）。"""
    existing = {
        name
        for (name,) in (
            await session.execute(select(Wordlist.name).where(Wordlist.kind == "scenario"))
        ).all()
    }
    return [{**seed, "exists": seed["title_zh"] in existing} for seed in load_seeds()]


class SeedGenerateBody(BaseModel):
    # 必须显式给出要生成哪些：空列表曾被当成"全都要"，一点就跑掉 50 个（实测事故）
    keys: list[str] = Field(min_length=1, max_length=50)
    with_examples: bool = True
    need_confirm: bool = False
    with_passage: bool = True


@router.post("/seeds/generate", status_code=202)
async def generate_seeds(body: SeedGenerateBody, session: SessionDep) -> dict:
    """批量生成种子场景：逐个入队，已存在同名本的跳过并在返回里列明。"""
    seed_map = {s["key"]: s for s in load_seeds()}
    wanted = [seed_map[k] for k in body.keys if k in seed_map]
    if not wanted:
        raise HTTPException(status_code=400, detail="没有匹配的种子场景")
    existing = {
        name
        for (name,) in (
            await session.execute(select(Wordlist.name).where(Wordlist.kind == "scenario"))
        ).all()
    }
    queue = await get_queue()
    jobs: list[dict] = []
    skipped: list[str] = []
    for seed in wanted:
        if seed["title_zh"] in existing:
            skipped.append(seed["key"])
            continue
        job_id = uuid.uuid4().hex
        await queue.set(
            _job_key(job_id),
            json.dumps(
                {
                    "job_id": job_id,
                    "status": "running",
                    "stage": "generate",
                    "stage_label": scenario_decks.STAGES["generate"],
                    "detail": "排队中",
                    "idea": seed["title_zh"],
                    "seed_key": seed["key"],
                    "counts": {},
                },
                ensure_ascii=False,
            ),
            ex=3600,
        )
        # 复用同一个任务：种子已是规范场景，传 scene 让流水线跳过归一化
        await queue.enqueue_job(
            "generate_scenario_deck",
            job_id,
            seed["title_zh"],
            seed.get("cefr"),
            body.with_examples,
            seed,
            None,
            None,
            body.need_confirm,
            body.with_passage,
        )
        jobs.append({"key": seed["key"], "title": seed["title_zh"], "job_id": job_id})
    return {"jobs": jobs, "skipped": skipped}


class RerunBody(BaseModel):
    """从某节点重跑（FR-202）：single 只重算本步，downstream 连下游一起。

    `config` 是节点参数覆盖，形如 `{"cover": {"prompt": "...", "style": "..."}}`。
    首版没有这个字段，导致「在节点里改提示词重出」在非视频域根本落不了地
    （模块 16 FR-413）。
    """

    from_step: str
    scope: Literal["single", "downstream"] = "downstream"
    with_examples: bool = True
    need_confirm: bool = False
    config: dict[str, dict] | None = None


@router.post("/{wordlist_id}/rerun", status_code=202)
async def rerun_scenario(wordlist_id: int, body: RerunBody, session: SessionDep) -> dict:
    """场景本节点级重跑：范围外且已有产物的节点直接复用，不重算也不重新烧 token。"""
    wordlist = await session.get(Wordlist, wordlist_id)
    if wordlist is None or wordlist.kind != "scenario":
        raise HTTPException(status_code=404, detail="场景本不存在")
    spec = pipeline.get_pipeline("scenario_deck")
    if body.from_step not in spec.by_name:
        raise HTTPException(status_code=404, detail=f"未知节点 {body.from_step}")
    wanted = pipeline.resolve_scope(
        body.from_step, body.scope, domain="scenario_deck"
    )
    job_id = uuid.uuid4().hex
    queue = await get_queue()
    await queue.set(
        _job_key(job_id),
        json.dumps(
            {
                "job_id": job_id,
                "status": "running",
                "stage": body.from_step,
                "stage_label": scenario_decks.STAGES.get(body.from_step, body.from_step),
                "detail": "排队中",
                "idea": wordlist.name,
                "wordlist_id": wordlist_id,
                "counts": {},
            },
            ensure_ascii=False,
        ),
        ex=3600,
    )
    await queue.enqueue_job(
        "generate_scenario_deck",
        job_id,
        wordlist.name,
        wordlist.cefr,
        body.with_examples,
        None,
        wordlist_id,
        wanted,
        body.need_confirm,
        True,
        body.config,
    )
    return {"job_id": job_id, "steps": wanted}


@router.get("/{wordlist_id}/draft")
async def draft_detail(wordlist_id: int, session: SessionDep) -> dict:
    """草稿详情：草稿不在 /wordlists 列表里，预览页按 id 直取（BR-32）。"""
    wordlist = await session.get(Wordlist, wordlist_id)
    if wordlist is None or wordlist.kind != "scenario":
        raise HTTPException(status_code=404, detail="场景本不存在")
    rows = (
        await session.execute(
            select(WordlistItem)
            .where(WordlistItem.wordlist_id == wordlist_id)
            .order_by(WordlistItem.ordinal)
        )
    ).scalars()
    items = [
        {
            "word": r.word,
            "translation": r.translation,
            "group_key": r.group_key,
            "group_label": decks.GROUP_LABELS.get(r.group_key or "", r.group_key),
            "example_en": r.example_en,
            "example_zh": r.example_zh,
            "dict_miss": r.dict_miss,
        }
        for r in rows
    ]
    return {
        "id": wordlist.id,
        "key": f"custom:{wordlist.id}",
        "name": wordlist.name,
        "emoji": wordlist.emoji,
        "color_seed": wordlist.color_seed,
        "description": wordlist.description,
        "category": wordlist.category,
        "cefr": wordlist.cefr,
        "status": wordlist.status,
        "source": wordlist.source,
        "total": len(items),
        "items": items,
    }


class DraftEditBody(BaseModel):
    """草稿页可改的字段（FR-176）；词条增删走独立接口。"""

    name: str | None = Field(default=None, min_length=1, max_length=128)
    emoji: str | None = Field(default=None, max_length=16)
    description: str | None = None
    remove_words: list[str] = Field(default_factory=list)


@router.patch("/{wordlist_id}/draft")
async def edit_draft(wordlist_id: int, body: DraftEditBody, session: SessionDep) -> dict:
    wordlist = await _get_draft(session, wordlist_id)
    for field in ("name", "emoji", "description"):
        value = getattr(body, field)
        if value is not None:
            setattr(wordlist, field, value)
    if body.remove_words:
        await session.execute(
            delete(WordlistItem).where(
                WordlistItem.wordlist_id == wordlist_id,
                WordlistItem.word.in_(body.remove_words),
            )
        )
    await session.commit()
    return await draft_detail(wordlist_id, session)


@router.post("/{wordlist_id}/confirm")
async def confirm_draft(wordlist_id: int, session: SessionDep) -> dict:
    """草稿转正：空本不允许确认，避免书架上出现 0 词的场景本。"""
    wordlist = await _get_draft(session, wordlist_id)
    total = (
        await session.execute(
            select(func.count())
            .select_from(WordlistItem)
            .where(WordlistItem.wordlist_id == wordlist_id)
        )
    ).scalar_one()
    if total == 0:
        raise HTTPException(status_code=400, detail="词条已被清空，无法确认")
    wordlist.status = "ready"
    # 确认即解除管线暂停点：interrupt 标 resolved，run 从 awaiting_input 收尾（FR-201）
    resumed = await _resolve_confirm(session, wordlist_id)
    await session.commit()
    return {
        "ok": True,
        "key": f"custom:{wordlist.id}",
        "total": int(total),
        "run_id": resumed,
    }


async def _resolve_confirm(session, wordlist_id: int) -> int | None:
    """把该场景本挂起的 confirm 暂停点收掉，返回被恢复的 run id。"""
    run = (
        await session.execute(
            select(PipelineRun)
            .where(
                PipelineRun.domain == "scenario_deck",
                PipelineRun.subject_id == wordlist_id,
                PipelineRun.status == "awaiting_input",
            )
            .order_by(PipelineRun.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if run is None:
        return None
    interrupts = (
        await session.execute(
            select(PipelineInterrupt).where(
                PipelineInterrupt.run_id == run.id, PipelineInterrupt.status == "waiting"
            )
        )
    ).scalars()
    now = datetime.now(UTC)
    for item in interrupts:
        item.status = "resolved"
        item.resume_value = {"approved": True}
        item.resolved_at = now
    run.status = "success"
    run.finished_at = now
    return run.id


async def _get_draft(session, wordlist_id: int) -> Wordlist:
    wordlist = await session.get(Wordlist, wordlist_id)
    if wordlist is None or wordlist.kind != "scenario":
        raise HTTPException(status_code=404, detail="场景本不存在")
    if wordlist.status != "draft":
        raise HTTPException(status_code=409, detail="该场景本已确认，不在草稿态")
    return wordlist


@router.post("/{wordlist_id}/talk")
async def to_talk_scenario(wordlist_id: int, session: SessionDep) -> dict:
    """场景本一键转陪练场景（FR-182）：返回 talk 侧的 scenario key。

    已生成过的直接复用，不重复调 LLM；本内的句型分组正是天然的关键句素材，
    比让模型再编一遍更贴合用户刚学过的内容。
    """
    wordlist = await session.get(Wordlist, wordlist_id)
    if wordlist is None or wordlist.kind != "scenario":
        raise HTTPException(status_code=404, detail="场景本不存在")
    if wordlist.status != "ready":
        raise HTTPException(status_code=409, detail="草稿本请先确认入库")

    key = f"deck_{wordlist.id}"
    existing = (
        await session.execute(select(UserScenario).where(UserScenario.key == key))
    ).scalar_one_or_none()
    if existing is not None:
        return {"scenario_key": key, "created": False}

    rows = (
        await session.execute(
            select(WordlistItem)
            .where(WordlistItem.wordlist_id == wordlist_id)
            .order_by(WordlistItem.ordinal)
        )
    ).scalars().all()
    patterns = [r for r in rows if r.group_key == "pattern" and r.translation]
    idea = f"{wordlist.name}（{wordlist.description or ''}）"
    try:
        draft = await generate_scenario_draft(idea, wordlist.cefr)
    except (DraftInvalid, LLMUnavailable) as exc:
        raise HTTPException(status_code=502, detail=f"陪练场景生成失败：{exc}") from None

    draft["key"] = key
    if patterns:
        # 用户刚在本里学过的句型直接当关键句，AI 练习时会优先用这些表达
        draft["key_sentences"] = [
            {"en": p.word, "zh": p.translation or ""} for p in patterns[:3]
        ]
    session.add(UserScenario(key=key, data=sanitize_scenario(draft)))
    await session.commit()
    return {"scenario_key": key, "created": True}


@router.post("/{wordlist_id}/discard")
async def discard_draft(wordlist_id: int, session: SessionDep) -> dict:
    """放弃草稿：删本的同时把挂起的 run 标为取消，避免留下永远等待的暂停点。"""
    wordlist = await _get_draft(session, wordlist_id)
    runs = (
        await session.execute(
            select(PipelineRun).where(
                PipelineRun.domain == "scenario_deck",
                PipelineRun.subject_id == wordlist_id,
                PipelineRun.status == "awaiting_input",
            )
        )
    ).scalars()
    now = datetime.now(UTC)
    for run in runs:
        run.status = "cancelled"
        run.finished_at = now
    await session.delete(wordlist)
    await session.commit()
    return {"ok": True}


@router.delete("/drafts/expired")
async def purge_expired(session: SessionDep, hours: int = 24) -> dict:
    """清理过期草稿（FR-177）：用户放弃生成后不该在库里长期留残骸。"""
    cutoff = datetime.now(UTC) - timedelta(hours=max(hours, 1))
    rows = (
        await session.execute(
            select(Wordlist).where(
                Wordlist.kind == "scenario",
                Wordlist.status == "draft",
                Wordlist.created_at < cutoff,
            )
        )
    ).scalars()
    removed = 0
    for row in rows:
        await session.delete(row)
        removed += 1
    await session.commit()
    return {"removed": removed}


class RoleVoiceBody(BaseModel):
    """角色音色映射（FR-275）：{角色名: 音色 name}，空值表示恢复默认。"""

    voices: dict[str, str] = Field(default_factory=dict)


@router.put("/{wordlist_id}/roles")
async def set_role_voices(
    wordlist_id: int, body: RoleVoiceBody, session: SessionDep
) -> dict:
    wordlist = await session.get(Wordlist, wordlist_id)
    if wordlist is None or wordlist.kind != "scenario":
        raise HTTPException(status_code=404, detail="场景本不存在")
    cleaned = {k.strip(): v.strip() for k, v in body.voices.items() if k.strip() and v.strip()}
    wordlist.role_voices = cleaned or None
    await session.commit()
    return {"ok": True, "voices": cleaned}


@router.get("/{wordlist_id}/passage")
async def get_passage(wordlist_id: int, session: SessionDep) -> dict:
    """场景短文（FR-274）：结构取自产物层，正文取自 article 供阅读器使用。"""
    row = await artifacts.current(session, "scenario_deck", wordlist_id, "passage")
    article = (
        await session.execute(
            select(Article).where(
                Article.deck_id == wordlist_id, Article.source_kind == "scenario"
            )
        )
    ).scalar_one_or_none()
    if row is None or article is None:
        raise HTTPException(status_code=404, detail="这个本还没有生成短文")
    payload = row.payload or {}
    return {
        "article_id": article.id,
        "title": article.title,
        "form": payload.get("form", "prose"),
        "roles": payload.get("roles", []),
        "paragraphs": payload.get("paragraphs", []),
        "coverage": payload.get("coverage", {"covered": [], "missing": [], "rate": 0}),
        # 用户给各角色挑的嗓音；未设置的角色由前端按顺序分配默认音色
        "role_voices": (
            (await session.get(Wordlist, wordlist_id)).role_voices or {}
        ),
    }


class ExtendBody(BaseModel):
    """补写一段（FR-261）：把未覆盖的词交给 AI 追加进短文。"""

    words: list[str] = Field(default_factory=list, max_length=40)


@router.post("/{wordlist_id}/passage/extend", status_code=202)
async def extend_passage(wordlist_id: int, body: ExtendBody, session: SessionDep) -> dict:
    """重写一篇短文并要求必须用上指定的词。

    没有做成"在原文后面追加"是因为硬接一段会读着突兀——
    整篇重写并强制包含这些词，读起来才是一篇完整材料。
    """
    wordlist = await session.get(Wordlist, wordlist_id)
    if wordlist is None or wordlist.kind != "scenario":
        raise HTTPException(status_code=404, detail="场景本不存在")
    rows = (
        await session.execute(
            select(WordlistItem.word, WordlistItem.group_key).where(
                WordlistItem.wordlist_id == wordlist_id
            )
        )
    ).all()
    if not rows:
        raise HTTPException(status_code=400, detail="这个本还没有词条")
    vocab = passages.coverable_words([{"en": w, "group": g} for w, g in rows])

    scene = {
        "title_zh": wordlist.name,
        "title_en": wordlist.name,
        "description": wordlist.description,
        "cefr": wordlist.cefr,
    }
    try:
        passage = await passages.generate_passage(
            scene, vocab, must_include=body.words or None
        )
    except (ValueError, LLMUnavailable) as exc:
        raise HTTPException(status_code=502, detail=f"短文生成失败：{exc}") from None
    article_id = await passages.persist_passage(session, wordlist_id, wordlist.name, passage)
    await artifacts.record(
        session,
        domain="scenario_deck",
        subject_id=wordlist_id,
        step="passage",
        payload={**passage, "article_id": article_id},
        input_fp=artifacts.sha256_of({"manual_extend": body.words}),
        summary=(
            f"{passages.FORM_LABEL.get(passage['form'], '短文')} · "
            f"覆盖 {int(passage['coverage']['rate'] * 100)}%"
        ),
    )
    await session.commit()
    return {
        "article_id": article_id,
        "coverage": passage["coverage"],
        "form": passage["form"],
    }

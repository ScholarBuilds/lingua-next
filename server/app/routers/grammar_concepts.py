"""语法概念专栏接口（模块 15）。

概念正文来自 Obsidian 讲义，由 `scripts/import_grammar_notes.py` 导入，
平台只读不写（BR-93）——所以这里没有任何写正文的接口，只有读与掌握度。

与模块 14 的分工：14 出**语法点目录与题**，15 出**讲解与学习路径**。
概念页把两边接起来：讲解正文来自 15，例句与题来自 14 已经建好的
`grammar_occurrence` 与 `grammar_card`。
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.owner import CurrentOwner
from app.routers.dict import SessionDep
from domain import srs
from domain.analysis import content_key, get_cached, save_result
from domain.models import (
    GrammarCard,
    GrammarConcept,
    GrammarConceptState,
    GrammarConstruction,
    GrammarOccurrence,
    GrammarPoint,
    Paragraph,
    SubtitleSentence,
)
from domain.syntax import (
    DEP_ZH,
    build_matcher,
    constituents,
    dep_las,
    match_constructions,
    parse_deps,
)

# 小结、综述、速查这类章节会顺带列举很多结构，映射时容易被挂上一堆构式。
# 把一个「本章小结」当作某个结构的讲解指过去，等于没指——学习者点进去
# 找不到那个结构在哪儿讲。有更具体的概念时排到它们后面
_GENERIC_TITLE = (
    "小结", "总结", "综述", "概述", "综合", "速查", "展望", "常见错误", "本章",
    "练习", "习题", "自测",
)  # fmt: skip


def concept_rank(x: dict) -> tuple:
    """同一个构式挂了多个概念时，谁排前面。

    三条判据按重要性递减：

    1. **小结/综述这类泛泛的章节排最后**——它们顺带列举很多结构，
       指过去学习者找不到那个结构在哪儿讲，等于没指
    2. **主动层优先**，先给「必须掌握」的那条
    3. **专一度**：只挂一个构式的概念讲的就是这个结构本身，
       挂三个的多半是顺带提到

    章节号只做最后的稳定排序，不参与优先级——它是编写顺序，
    与「哪一条更该看」无关。首版拿它当第二判据，结果反义疑问句的句子
    指向了「12.日常口语」而不是「16.反义疑问句」，只因为 12 < 16。
    """
    generic = any(w in x["title"] or w in x["doc_title"] for w in _GENERIC_TITLE)
    return (generic, x["layer"] != "active", x["n_keys"], x["chapter"])


# 低于这个值的命中在界面上做弱化处理：**只是「这句难解析」的提示，不是门禁**。
#
# > [!danger] 句级解析把握度不能用来判断构式命中对不对
# >
# > 首版按 BR-97 设了 60 分的门槛，低于它就不指概念。实测下来这个门槛
# > **从不触发**：2,376 条真实语料命中里 0 条低于 60，构造的脏输入
# > （字幕拼接、无标点长句、两句粘连、OCR 断行）也全在 60 以上。
# >
# > 更要紧的是，唯一一个真实的误命中——`tag-question` 命中
# > 「What a beautiful day it is!」——置信度是满分 100。
# > **命中对不对取决于规则精度，与句子好不好解析无关**，
# > 两者根本不是同一个量。拿它当门禁只会制造「已经防住了」的错觉。
# >
# > 所以门禁撤掉，改由每条规则的正反例单测守精度（那才是抓到 tag-question
# > 那个 bug 的东西）。这个数留作展示：它确实跟解析难度相关，
# > 让读者知道哪几处结论要多留个心眼。
WEAK_PARSE_BELOW = 80.0
# 一句话最多解析多少字符。这个 600 原先注明「与 /grammar/analyze 同口径」，
# 而那条路由已随 spaCy 依存图一起删除，现在这里是唯一出处
MAX_SENTENCE_CHARS = 600

# 例句取几条。展示用，不是语料检索——要看全部命中走
# `/grammar/points/{id}/occurrences`
EXAMPLE_LIMIT = 8
# 太长的句子当例句反而看不清结构
MAX_EXAMPLE_CHARS = 220

router = APIRouter(prefix="/grammar/concepts", tags=["grammar"])

_SENT_END = ".!?;:\u201d\u2019"


def _containing_sentence(text: str, snippet: str) -> str:
    """把命中片段扩展成它所在的整句。

    `grammar_occurrence.snippet` 存的是**匹配到的那一段**（"has almost wickedly
    destroyed"），当语料检索的锚点没问题，当例句就没法看——学习者要看的是
    这个结构在一个完整句子里长什么样。

    按片段在段落里的位置向两侧找句末标点，比用 `char_start/char_end` 稳：
    那对偏移是 UTF-16 码元，而这里拿到的是 Python 的码点字符串，
    英文语料上二者一致但没必要赌。
    """
    i = text.find(snippet)
    if i < 0:
        return snippet
    start = 0
    for k in range(i - 1, -1, -1):
        if text[k] in _SENT_END:
            start = k + 1
            break
    end = len(text)
    for k in range(i + len(snippet), len(text)):
        if text[k] in _SENT_END:
            end = k + 1
            break
    out = text[start:end].strip()
    if not out:
        return snippet
    if len(out) <= MAX_EXAMPLE_CHARS:
        return out
    # 整句太长（十九世纪散文动辄两百字以上）时截一个窗口，而不是退回裸片段：
    # "have taken" 这样的片段学习者看不出任何结构，带上下文的省略号版本才有用
    lo = max(0, i - MAX_EXAMPLE_CHARS // 3)
    hi = min(len(text), i + len(snippet) + MAX_EXAMPLE_CHARS * 2 // 3)
    window = text[lo:hi]
    if lo > 0:
        window = window[window.find(" ") + 1 :] if " " in window else window
        window = "…" + window
    if hi < len(text):
        window = (window[: window.rfind(" ")] if " " in window else window) + "…"
    return window.strip()


def _brief(c: GrammarConcept) -> dict:
    return {
        "slug": c.slug,
        "title": c.title,
        "chapter": c.chapter,
        "doc_title": c.doc_title,
        "layer": c.layer,
        "why_active": c.why_active,
        "authored_by": c.authored_by,
        "order_index": c.order_index,
    }


@router.get("")
async def list_concepts(
    session: SessionDep,
    layer: str | None = Query(None, pattern="^(active|reference)$"),
    chapter: str | None = None,
) -> dict:
    """概念树：章 → 文档 → 概念。

    一次全给：539 个概念的简介总共几十 KB，分页反而让前端要为「跳到某个概念」
    额外发一轮请求。正文不在这里返回，那才是大头。
    """
    stmt = select(GrammarConcept).where(GrammarConcept.status == "active")
    if layer is not None:
        stmt = stmt.where(GrammarConcept.layer == layer)
    if chapter is not None:
        stmt = stmt.where(GrammarConcept.chapter == chapter)
    rows = (
        (await session.execute(stmt.order_by(GrammarConcept.chapter, GrammarConcept.order_index)))
        .scalars()
        .all()
    )

    tree: list[dict] = []
    index: dict[tuple[str, str], dict] = {}
    for c in rows:
        key = (c.chapter, c.doc_title)
        node = index.get(key)
        if node is None:
            chapter_node = next((n for n in tree if n["chapter"] == c.chapter), None)
            if chapter_node is None:
                chapter_node = {"chapter": c.chapter, "docs": []}
                tree.append(chapter_node)
            node = {"doc_title": c.doc_title, "source_path": c.source_path, "concepts": []}
            chapter_node["docs"].append(node)
            index[key] = node
        node["concepts"].append(_brief(c))

    return {
        "chapters": tree,
        "total": len(rows),
        "active": sum(1 for c in rows if c.layer == "active"),
    }


@router.get("/due")
async def due_concepts(
    session: SessionDep, owner: CurrentOwner, limit: int = Query(20, ge=1, le=100)
) -> dict:
    """到期复习队列。**只调度主动层**——参考层的定位是查得到就行（BR-95），
    把它塞进复习队列等于把「学完」这个终点又变成无限。"""
    now = datetime.now(UTC)
    stmt = (
        select(GrammarConcept, GrammarConceptState)
        .outerjoin(
            GrammarConceptState,
            (GrammarConceptState.concept_id == GrammarConcept.id)
            & (GrammarConceptState.user_id == owner.id),
        )
        .where(GrammarConcept.status == "active")
        .where(GrammarConcept.layer == "active")
        .where((GrammarConceptState.id.is_(None)) | (GrammarConceptState.due_at <= now))
        .order_by(func.coalesce(GrammarConceptState.due_at, now), GrammarConcept.id)
        .limit(limit)
    )
    rows = (await session.execute(stmt)).all()
    return {
        "items": [
            {**_brief(c), "state": srs.card_state_name(st.fsrs_card if st else None)}
            for c, st in rows
        ],
        "total": len(rows),
    }


@router.get("/stats")
async def concept_stats(session: SessionDep, owner: CurrentOwner) -> dict:
    """学习进度：主动层学完了多少，参考层有多少可查。"""
    now = datetime.now(UTC)
    total = (
        await session.execute(
            select(func.count())
            .select_from(GrammarConcept)
            .where(GrammarConcept.status == "active")
        )
    ).scalar_one()
    active = (
        await session.execute(
            select(func.count())
            .select_from(GrammarConcept)
            .where(GrammarConcept.status == "active", GrammarConcept.layer == "active")
        )
    ).scalar_one()
    started = (
        await session.execute(
            select(func.count())
            .select_from(GrammarConceptState)
            .where(
                GrammarConceptState.reps > 0,
                GrammarConceptState.user_id == owner.id,
            )
        )
    ).scalar_one()
    due = (
        await session.execute(
            select(func.count())
            .select_from(GrammarConceptState)
            .where(GrammarConceptState.due_at <= now, GrammarConceptState.user_id == owner.id)
        )
    ).scalar_one()
    return {
        "total": total,
        "active": active,
        "reference": total - active,
        "started": started,
        "due": due,
        # 「学完」有终点：主动层全部进入复习循环即可，不是把 539 个都学一遍
        "progress": round(started / active * 100, 1) if active else 0.0,
    }


@router.get("/{slug:path}")
async def concept_detail(slug: str, session: SessionDep) -> dict:
    """概念详情：讲解正文 + 真实语料例句 + 该点的题。

    例句与题不重新造：它们来自模块 14 已经扫好的 `grammar_occurrence`
    与生成好的 `grammar_card`，这里只按映射取过来。
    """
    row = (
        await session.execute(select(GrammarConcept).where(GrammarConcept.slug == slug))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="没有这个概念")

    point_ids = [int(i) for i in (row.grammar_point_ids or []) if isinstance(i, int | str)]
    keys = [str(k) for k in (row.construction_keys or [])]

    points: list[dict] = []
    examples: list[dict] = []
    cards: list[dict] = []
    if point_ids:
        pts = (
            (await session.execute(select(GrammarPoint).where(GrammarPoint.id.in_(point_ids))))
            .scalars()
            .all()
        )
        points = [
            {"id": p.id, "item": p.item, "item_zh": p.item_zh, "cefr_level": p.cefr_level}
            for p in pts
        ]
        occ_stmt = select(GrammarOccurrence).where(
            GrammarOccurrence.grammar_point_id.in_(point_ids)
        )
        if keys:
            occ_stmt = occ_stmt.where(GrammarOccurrence.construction_key.in_(keys))
        occ = (await session.execute(occ_stmt.limit(EXAMPLE_LIMIT))).scalars().all()
        examples = await _expand(session, occ)
        card_rows = (
            (
                await session.execute(
                    select(GrammarCard)
                    .where(GrammarCard.grammar_point_id.in_(point_ids))
                    .order_by(GrammarCard.id)
                    .limit(10)
                )
            )
            .scalars()
            .all()
        )
        cards = [
            {
                "card_id": c.id,
                "kind": c.kind,
                "question": {**c.payload, "widget": c.widget, "id": f"gc-{c.id}"},
            }
            for c in card_rows
        ]

    state = (
        await session.execute(
            select(GrammarConceptState).where(GrammarConceptState.concept_id == row.id)
        )
    ).scalar_one_or_none()

    return {
        **_brief(row),
        "body_md": row.body_md,
        "source_path": row.source_path,
        "points": points,
        "construction_keys": keys,
        "examples": examples,
        "cards": cards,
        "state": {
            "name": srs.card_state_name(state.fsrs_card if state else None),
            "reps": state.reps if state else 0,
            "due": state.due_at.isoformat() if state and state.due_at else None,
            "marked_known": state.marked_known_at is not None if state else False,
        },
    }


class ConceptGradeIn(BaseModel):
    rating: int = Field(ge=1, le=4)


@router.post("/{slug:path}/grade")
async def grade_concept(
    slug: str, body: ConceptGradeIn, session: SessionDep, owner: CurrentOwner
) -> dict:
    """概念掌握度评分。调度直接喂 `domain/srs.py`，不为语法另写一套（BR-96）。"""
    row = (
        await session.execute(select(GrammarConcept).where(GrammarConcept.slug == slug))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="没有这个概念")
    if row.layer != "active":
        raise HTTPException(status_code=400, detail="参考层概念不进复习队列（BR-95）")

    st = (
        await session.execute(
            select(GrammarConceptState).where(
                GrammarConceptState.concept_id == row.id,
                GrammarConceptState.user_id == owner.id,
            )
        )
    ).scalar_one_or_none()
    if st is None:
        st = GrammarConceptState(concept_id=row.id, user_id=owner.id, fsrs_card=srs.init_card())
        session.add(st)
        await session.flush()

    new_card, _log, due = srs.review(st.fsrs_card or srs.init_card(), body.rating)
    st.fsrs_card = new_card
    st.due_at = due
    st.last_review_at = datetime.now(UTC)
    st.reps += 1
    if body.rating == 1:
        st.lapses += 1
    if st.marked_known_at is None and body.rating >= 3:
        st.marked_known_at = datetime.now(UTC)
    await session.commit()
    return {
        "state": srs.card_state_name(new_card),
        "due": due.isoformat(),
        "intervals": srs.preview_intervals(new_card),
    }


async def _expand(session, occ: list[GrammarOccurrence]) -> list[dict]:
    """把命中片段扩成整句。取不到出处原文时退回片段，不让例句区空着。"""
    para_ids = {o.paragraph_id for o in occ if o.source_kind == "article" and o.paragraph_id}
    sent_ids = {o.sentence_id for o in occ if o.source_kind == "subtitle" and o.sentence_id}
    texts: dict[tuple[str, int], str] = {}
    if para_ids:
        for row in (
            (await session.execute(select(Paragraph).where(Paragraph.id.in_(para_ids))))
            .scalars()
            .all()
        ):
            texts[("article", row.id)] = row.text
    if sent_ids:
        for row in (
            (
                await session.execute(
                    select(SubtitleSentence).where(SubtitleSentence.id.in_(sent_ids))
                )
            )
            .scalars()
            .all()
        ):
            texts[("subtitle", row.id)] = row.text

    out = []
    for o in occ:
        key = (
            ("article", o.paragraph_id)
            if o.source_kind == "article"
            else ("subtitle", o.sentence_id)
        )
        host = texts.get(key) if key[1] is not None else None
        out.append(
            {
                "snippet": _containing_sentence(host, o.snippet) if host else o.snippet,
                "matched": o.snippet,
                "construction_key": o.construction_key,
                "source_kind": o.source_kind,
                "source_id": o.source_id,
            }
        )
    return out


# ──────────────────────────── 句子解构（FR-407f） ────────────────────────────

# 构式规则来自库表且极少变，每次请求重建 matcher 要几百毫秒。
# 按 key 集合缓存：规则改了 key 集合就变，缓存自动失效
_matcher_cache: tuple[tuple[str, ...], object] | None = None


async def _load_matcher(session) -> tuple[object, dict[str, GrammarConstruction]]:
    global _matcher_cache
    cons = (
        (await session.execute(select(GrammarConstruction).where(GrammarConstruction.enabled)))
        .scalars()
        .all()
    )
    by_key = {c.key: c for c in cons}
    keys = tuple(sorted(by_key))
    if _matcher_cache is None or _matcher_cache[0] != keys:
        _matcher_cache = (keys, build_matcher({c.key: c.pattern for c in cons}))
    return _matcher_cache[1], by_key


class DeconstructIn(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_SENTENCE_CHARS)


@router.post("/deconstruct")
async def deconstruct(body: DeconstructIn, session: SessionDep, owner: CurrentOwner) -> dict:
    """任意句子 → 成分树 + 命中的构式 + **指回讲义概念**。

    这一跳是专栏与语法书的区别所在：语法点有限而句子无限，
    「学完能看懂所有句子」靠的是遇到陌生句能拆开，不是背过第 47 条规则。
    所以拆完必须能指回「这个结构讲义里在哪一节」。

    > [!warning] 命中对不对靠规则精度，不靠句级把握度（BR-97 修订版）
    >
    > 原本的设计是「解析把握不足就不指概念」。实测证明那个门禁从不触发，
    > 而唯一一个真实误命中的置信度是满分——见 `WEAK_PARSE_BELOW` 的说明。
    > 精度由每条构式规则的正反例单测保证；这里只把「这句难解析」标出来。
    """
    text = body.text.strip()
    context = content_key(f"{owner.id}:sentence-lab:v1")
    cached = await get_cached(
        session, "sentence", content_key(text), context, "deconstruct", "spacy"
    )
    if cached:
        return {**cached.result, "analysis_id": cached.id}
    try:
        deps = parse_deps(text)
        cons_view = constituents(text, deps)
    except Exception as exc:  # noqa: BLE001 - spaCy 缺件时明确报 503 而不是 500
        raise HTTPException(status_code=503, detail=f"句法分析不可用：{exc}") from exc

    matcher, by_key = await _load_matcher(session)
    hits = match_constructions(text, matcher)

    # 概念按构式 key 建索引。挂了构式的概念只有一百多条，一次全取比逐条查 JSON 包含快
    linked = (
        (
            await session.execute(
                select(GrammarConcept).where(
                    GrammarConcept.status == "active",
                    GrammarConcept.construction_keys != [],
                )
            )
        )
        .scalars()
        .all()
    )
    by_construction: dict[str, list[dict]] = {}
    for c in linked:
        for k in c.construction_keys or []:
            by_construction.setdefault(str(k), []).append(
                {
                    "slug": c.slug,
                    "title": c.title,
                    "doc_title": c.doc_title,
                    "chapter": c.chapter,
                    "layer": c.layer,
                    # 这个概念一共挂了几个构式。只挂一个的，讲的就是这个结构本身
                    "n_keys": len(c.construction_keys or []),
                }
            )
    for items in by_construction.values():
        items.sort(key=concept_rank)

    out = []
    weak = 0
    for h in hits:
        easy = h["confidence"] >= WEAK_PARSE_BELOW
        if not easy:
            weak += 1
        con = by_key.get(h["key"])
        out.append(
            {
                **h,
                "description": con.description if con else h["key"],
                "easy_parse": easy,
                "concepts": by_construction.get(h["key"], [])[:3],
            }
        )
    out.sort(key=lambda x: (-x["confidence"], x["char_start"]))

    note = f"结构分析由 spaCy 给出（DEP_LAS {dep_las()}），长难句可能有偏差"
    if weak:
        note += f"；其中 {weak} 处所在的句子较难解析，结论多留个心眼"
    result = {
        "text": text,
        "words": cons_view["words"],
        "spans": cons_view["spans"],
        "legend": cons_view["legend"],
        "arcs": deps["arcs"],
        "dep_labels": DEP_ZH,
        "constructions": out,
        "note": note,
    }
    row = await save_result(
        session, "sentence", content_key(text), context, "deconstruct", "spacy", result
    )
    return {**result, "analysis_id": row.id}

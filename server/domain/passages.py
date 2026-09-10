"""场景短文（需求 01 v2 §15.2）：把本内的词织进一段真实语境。

词只有在句子里、句子只有在情境里才真正被记住。短文存进 article 表与书库文章同构，
阅读器整套能力（点词点句、朗读、双语对照、批注、进度）直接复用——
为它另写一个"简化版阅读器"才是重复造轮子（BR-50）。
"""

import json
import re

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.analysis import content_key, save_result
from domain.articles import PlainParagraph, persist_paragraphs
from domain.llm import complete_json
from domain.models import Article, Paragraph, Sentence

ALIAS = "explain-standard"

# 每 10 个词大约写 50 字，按本的词量推算篇幅（FR-262）
WORDS_PER_TEN = 70
MIN_LENGTH = 120
MAX_LENGTH = 900

FORMS = ("dialogue", "prose")
FORM_LABEL = {"dialogue": "对话", "prose": "短文"}


def target_length(word_count: int) -> int:
    """篇幅按词量推算。偏长一些——写太短必然漏词，而漏词正是这个功能最怕的。"""
    return max(MIN_LENGTH, min(MAX_LENGTH, word_count // 10 * WORDS_PER_TEN))


def _prompt(scene: dict, words: list[str], length: int, extra: list[str] | None) -> tuple[str, str]:
    system = (
        "你是英语教材编者，为给定场景写一篇学习材料，把指定词汇自然地织进去。"
        "只输出 JSON 对象，字段："
        "title（中文标题）、title_en（英文标题）、"
        "form（dialogue 或 prose：有明确角色互动的场景用 dialogue，描述性场景用 prose）、"
        "roles（dialogue 时给出角色名数组，prose 时给空数组）、"
        "paragraphs（数组，每项 {role, en, zh}：role 在 prose 时为空串，"
        "en 是英文段落或一句台词，zh 是对应中文翻译）。"
        "最重要的要求：给定词汇要用上的越多越好，目标是全部用上——这篇材料的价值就在于"
        "把这些词放进真实语境。宁可把篇幅写长一些，也不要漏掉词。"
        "其次：语言自然不生硬；难度符合指定的 CEFR 等级；"
        "同一个词可以在不同句子里重复出现。"
    )
    payload = {
        "scene": {
            "title": scene.get("title_en") or scene.get("title_zh"),
            "description": scene.get("description"),
            "cefr": scene.get("cefr"),
        },
        "words": words,
        "target_length": length,
    }
    if extra:
        payload["must_include"] = extra
        system += "，并且必须把 must_include 里的每个词都用上"
    return system, json.dumps(payload, ensure_ascii=False)


def _clean(raw: dict) -> dict:
    form = str(raw.get("form") or "prose").lower()
    if form not in FORMS:
        form = "prose"
    roles = raw.get("roles")
    paragraphs = []
    for item in raw.get("paragraphs") or []:
        if not isinstance(item, dict):
            continue
        en = str(item.get("en") or "").strip()
        if not en:
            continue
        paragraphs.append(
            {
                "role": str(item.get("role") or "").strip(),
                "en": en,
                "zh": str(item.get("zh") or "").strip(),
            }
        )
    return {
        "title": str(raw.get("title") or "").strip() or "场景短文",
        "title_en": str(raw.get("title_en") or "").strip(),
        "form": form,
        "roles": (
            [str(r).strip() for r in roles if str(r).strip()] if isinstance(roles, list) else []
        ),
        "paragraphs": paragraphs,
    }


_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'-]*")


# 句型组不参与覆盖率：它们是整句（"Can I have the menu, please?"），
# 本来就是从对话里提炼出来的，拿来逐字匹配永远到不了 100%
COVERAGE_EXCLUDED_GROUPS = ("pattern",)


def is_sentence_like(text: str) -> bool:
    """像整句的条目：带问号省略号，或超过三个词。

    按组排除不够——phrase 组里也混着 "for here or to go?" 这类整句。
    判据看内容而不是看它被分到哪一组。
    """
    if any(ch in text for ch in "?？…") or "..." in text:
        return True
    return len(text.split()) > 3


def coverable_words(words: list[dict]) -> list[str]:
    """参与覆盖率统计的条目：排除句型组与像整句的表达。"""
    return [
        w["en"]
        for w in words
        if w.get("group") not in COVERAGE_EXCLUDED_GROUPS and not is_sentence_like(w["en"])
    ]


def coverage(passage: dict, words: list[str]) -> dict:
    """覆盖率（FR-260）：本内词有多少真的出现在短文里。

    按词形小写匹配，顺带认一层常见屈折——短文里写 ordered 不该判定 order 没用上。
    """
    used: set[str] = set()
    for para in passage.get("paragraphs", []):
        # 角色名也算：对话里 waiter 出现在说话人位置，不该判成"没用上"
        for field in ("en", "role"):
            for token in _WORD_RE.findall(para.get(field, "")):
                used.add(token.lower())
    covered: list[str] = []
    missing: list[str] = []
    for word in words:
        low = word.lower()
        hit = low in used or any(
            v in used
            for v in (low + "s", low + "es", low + "ed", low + "ing", low.rstrip("e") + "ing")
        )
        # 多词短语：全部组成词都出现即算用上
        if not hit and " " in low:
            hit = all(part in used for part in low.split() if len(part) > 2)
        (covered if hit else missing).append(word)
    total = len(words) or 1
    return {
        "covered": covered,
        "missing": missing,
        "rate": round(len(covered) / total, 3),
    }


async def generate_passage(
    scene: dict, words: list[str], *, must_include: list[str] | None = None
) -> dict:
    """生成短文，附带覆盖率统计。"""
    system, user = _prompt(scene, words, target_length(len(words)), must_include)
    raw, _model, _ms = await complete_json(ALIAS, system, user)
    passage = _clean(raw if isinstance(raw, dict) else {})
    if not passage["paragraphs"]:
        raise ValueError("模型没有产出任何段落")
    passage["coverage"] = coverage(passage, words)
    return passage


def _render(passage: dict) -> list[PlainParagraph]:
    """短文结构 → 可读段落。对话用「角色：台词」前缀，阅读器直接能读。"""
    out = []
    for para in passage["paragraphs"]:
        text = f"{para['role']}: {para['en']}" if para.get("role") else para["en"]
        out.append(PlainParagraph(kind="text", text=text))
    return out


async def persist_passage(
    session: AsyncSession, deck_id: int, deck_name: str, passage: dict
) -> int:
    """写入 article + paragraph + sentence（FR-263），重跑时替换旧的那篇。

    译文顺带写进翻译缓存：生成时就有 zh，用户点句立刻出译文，
    既不用等也不再消耗一次调用（复用 ADR-006 的内容指纹寻址）。
    """
    existing = (
        await session.execute(
            select(Article).where(Article.deck_id == deck_id, Article.source_kind == "scenario")
        )
    ).scalars().all()
    for row in existing:
        await session.delete(row)
    await session.flush()

    article = Article(
        title=f"{deck_name} · {FORM_LABEL[passage['form']]}",
        source_kind="scenario",
        deck_id=deck_id,
        status="ready",
    )
    session.add(article)
    await session.flush()
    await persist_paragraphs(session, article.id, _render(passage))
    await session.flush()
    await _cache_translations(session, article.id, passage)
    return article.id


async def _cache_translations(session: AsyncSession, article_id: int, passage: dict) -> None:
    """把生成时拿到的译文写进翻译缓存，点句即出译文。"""
    rows = (
        await session.execute(
            select(Sentence, Paragraph.ordinal, Paragraph.text)
            .join(Paragraph, Paragraph.id == Sentence.paragraph_id)
            .where(Paragraph.article_id == article_id)
            .order_by(Paragraph.ordinal, Sentence.ordinal)
        )
    ).all()
    # 段落级译文按段对齐；一段多句时整段译文挂在首句上，其余句留给按需翻译
    by_para: dict[int, str] = {}
    for idx, para in enumerate(passage["paragraphs"]):
        if para.get("zh"):
            by_para[idx] = para["zh"]
    seen: set[int] = set()
    for sentence, para_ordinal, para_text in rows:
        if para_ordinal in seen:
            continue
        zh = by_para.get(para_ordinal)
        if not zh:
            continue
        seen.add(para_ordinal)
        text = para_text[sentence.char_start : sentence.char_end]
        await save_result(
            session,
            "sentence",
            content_key(text),
            "",
            "translate",
            "mt",
            result={"text": zh, "engine": "llm-passage"},
            model="llm-passage",
        )


async def drop_passage(session: AsyncSession, deck_id: int) -> int:
    result = await session.execute(
        delete(Article).where(Article.deck_id == deck_id, Article.source_kind == "scenario")
    )
    return result.rowcount or 0

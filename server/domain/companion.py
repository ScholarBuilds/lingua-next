"""AI 陪读：基于文章全文构建私教问答上下文（M5-B2）。

陪读不建新表：会话复用 TalkSession(mode="companion")，article_id 暂存在
session.summary JSONB（{"article_id": N}），问答回合落 TalkTurn；
路由见 app/routers/companion.py，语音陪读由 realtime.py 复用本模块注入上下文。
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.models import Article, Paragraph

COMPANION_ALIAS = "explain-standard"
HISTORY_TURNS = 16  # 问答历史取最近 8 轮（一问一答为一轮，共 16 条）
MAX_CONTEXT_CHARS = 8000  # 全文超过该长度时改用 窗口 + 首尾摘要 拼接
WINDOW_CHARS = 4000  # 当前段落前后窗口的字符预算
HEAD_TAIL_CHARS = 1200  # 截断时开头 / 结尾各保留的字符数
TRUNCATE_MARK = "……（中间内容因篇幅省略）……"


def assemble_context(
    paragraphs: list[tuple[int, str]], paragraph_ordinal: int | None = None
) -> tuple[str, bool]:
    """拼接陪读正文：全文 ≤ MAX_CONTEXT_CHARS 直接用，否则取当前段落前后窗口
    加首尾摘要并标注截断。paragraphs 为 [(ordinal, text)]，按 ordinal 升序。
    """
    full = "\n\n".join(t for _, t in paragraphs)
    if len(full) <= MAX_CONTEXT_CHARS:
        return full, False

    # 窗口中心：指定段落，未指定则从文章开头展开
    idx = 0
    if paragraph_ordinal is not None:
        for i, (ordinal, _) in enumerate(paragraphs):
            if ordinal == paragraph_ordinal:
                idx = i
                break
    window = [paragraphs[idx][1]]
    lo, hi = idx - 1, idx + 1
    while sum(len(t) for t in window) < WINDOW_CHARS and (lo >= 0 or hi < len(paragraphs)):
        if lo >= 0:
            window.insert(0, paragraphs[lo][1])
            lo -= 1
        if hi < len(paragraphs) and sum(len(t) for t in window) < WINDOW_CHARS:
            window.append(paragraphs[hi][1])
            hi += 1

    head = "\n\n".join(t for _, t in paragraphs[: lo + 1])[:HEAD_TAIL_CHARS]
    tail = "\n\n".join(t for _, t in paragraphs[hi:])[-HEAD_TAIL_CHARS:]
    parts: list[str] = []
    if head:
        parts += [f"[文章开头]\n{head}", TRUNCATE_MARK]
    parts.append(f"[当前阅读位置附近]\n{'\n\n'.join(window)}")
    if tail:
        parts += [TRUNCATE_MARK, f"[文章结尾]\n{tail}"]
    return "\n\n".join(parts), True


async def build_companion_context(
    session: AsyncSession, article_id: int, paragraph_ordinal: int | None = None
) -> dict | None:
    """取文章标题 + 全文（超长走窗口截断），文章不存在返回 None。"""
    article = await session.get(Article, article_id)
    if article is None:
        return None
    rows = (
        await session.execute(
            select(Paragraph.ordinal, Paragraph.text)
            .where(Paragraph.article_id == article_id)
            .order_by(Paragraph.ordinal)
        )
    ).all()
    paragraphs = [(o, t) for o, t in rows if t and t.strip()]
    content, truncated = assemble_context(paragraphs, paragraph_ordinal)
    return {"title": article.title, "content": content, "truncated": truncated}


async def build_video_companion_context(
    session: AsyncSession, video_id: int, unit_ordinal: int | None = None
) -> dict | None:
    """取视频标题 + AI 摘要 + 全片字幕（超长走同一套窗口截断），视频不存在返回 None。

    字幕按语法句而非 cue 拼装：cue 是按长度硬切的半句，喂给陪读会让它引用残句
    （ADR-007）。unit_ordinal 给出当前学习句时，截断窗口围绕该位置展开。
    """
    from domain.models import StudyUnit, SubtitleSentence, SubtitleTrack, Video

    video = await session.get(Video, video_id)
    if video is None:
        return None
    rows = (
        await session.execute(
            select(SubtitleSentence.ordinal, SubtitleSentence.text)
            .join(SubtitleTrack, SubtitleTrack.id == SubtitleSentence.track_id)
            .where(
                SubtitleTrack.video_id == video_id,
                SubtitleTrack.lang.notlike("zh%"),
                SubtitleSentence.is_noise.is_(False),
            )
            .order_by(SubtitleSentence.ordinal)
        )
    ).all()
    sentences = [(o, t) for o, t in rows if t and t.strip()]
    if not sentences:
        return None

    # 学习句序号 → 所属语法句序号，供截断窗口定位
    anchor_ordinal = None
    if unit_ordinal is not None:
        anchor_ordinal = (
            await session.execute(
                select(SubtitleSentence.ordinal)
                .join(StudyUnit, StudyUnit.sentence_id == SubtitleSentence.id)
                .where(StudyUnit.ordinal == unit_ordinal)
                .limit(1)
            )
        ).scalar_one_or_none()

    content, truncated = assemble_context(sentences, anchor_ordinal)
    return {
        "title": video.title_zh or video.title,
        "summary": video.summary_zh,
        "content": content,
        "truncated": truncated,
    }


def build_video_companion_system_prompt(
    title: str, summary: str | None, content: str, truncated: bool
) -> str:
    """视频陪读 system prompt：与文章陪读同口径，额外交代这是视频字幕。"""
    note = "（字幕过长，以下为节选：开头 / 当前观看位置附近 / 结尾）" if truncated else ""
    brief = f"\n视频简介：{summary}" if summary else ""
    return (
        "你是一位英语私教，正在陪学习者看一段英文视频并精读它的字幕。"
        "学习者会就画面内容、口语表达、语法或文化背景提问。"
        "回答规则："
        "1) 用中文讲解，引用字幕中的英文原句时保留英文并给出中文解释；"
        "2) 优先基于字幕内容回答，字幕没有的信息可结合常识补充并注明；"
        "3) 口语材料多俚语与省略，讲解时点明地道说法与书面语的差别；"
        "4) 除非学习者要求展开，回答控制在 300 字以内。"
        f"\n\n视频标题：{title}{brief}\n字幕{note}：\n{content}"
    )


def build_companion_system_prompt(title: str, content: str, truncated: bool) -> str:
    """陪读 system prompt：英语私教身份，中文讲解、引用英文原文。"""
    note = "（正文过长，以下为节选：开头 / 当前阅读位置附近 / 结尾）" if truncated else ""
    return (
        "你是一位英语私教，正在陪学习者精读一篇英文文章。"
        "学习者会就这篇文章提出语法、词义、句子理解或文化背景问题。"
        "回答规则："
        "1) 用中文讲解，引用文章中的英文原文时保留英文原句并给出中文解释；"
        "2) 优先基于文章内容回答，文章没有的信息可结合常识补充并注明；"
        "3) 讲解具体贴近原文，避免空泛；"
        "4) 除非学习者要求展开，回答控制在 300 字以内。"
        f"\n\n文章标题：{title}\n文章内容{note}：\n{content}"
    )


def build_companion_realtime_role(title: str, content: str, truncated: bool) -> str:
    """语音陪读人设：文本版 prompt 加口语化约束（实时链路模型直接说话）。"""
    return (
        build_companion_system_prompt(title, content, truncated)
        + "\n\n当前是语音对话：回复务必简短口语化，每次不超过三句，适合直接朗读。"
        + "对话中会收到学习者显式交来的引用（他点了「问 AI」或选中了一段），形如："
        "「[用户想学这句] \"...\"」整句、「[用户选中了这段] \"...\"」任意片段。"
        "收到即直接讲解该内容的词汇、语法与含义——这是他主动问的，不必再问要不要学。"
        "一次收到多条引用时，先讲最后一条，其余作为对比背景。"
    )


def build_video_companion_realtime_role(
    title: str, summary: str | None, content: str, truncated: bool
) -> str:
    """视频语音陪读人设：文本版 prompt 加口语化约束与点句感知。"""
    return (
        build_video_companion_system_prompt(title, summary, content, truncated)
        + "\n\n当前是语音对话：回复务必简短口语化，每次不超过三句，适合直接朗读。"
        + "对话中会收到学习者显式交来的引用，形如：「[用户想学这句] \"...\"」整句、"
        "「[用户选中了这段] \"...\"」任意片段、「[跟读比对] ...」跟读结果（附漏读/错读词）。"
        "收到即直接讲解——这是他主动问的，不必再问要不要学；跟读比对则针对具体的词点评发音。"
        "另外会收到「[主动检验] ...」，那是让你就学过的内容出一道口头小测，只问一个问题。"
    )

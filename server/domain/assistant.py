"""语音助理（CR-007 模块 20）：耳朵是 ASR、脑子是带工具的文本模型、嘴是 TTS。

第一版是回合制：按住说话 → 转写 → 代理决定说什么、做什么 → 念出来。不走火山全双工对话链路，
因为工具调用必须发生在我们这边（阅读、邮件、日历、复习、任务都是本地领域函数），那条链路是
封闭的对话模型。全双工与打断留给壳落地后再评估（ADR-014 决策 5）。

代理产出三样：一句要念的话、页面要执行的动作（跳转）、要人点头的待办（发邮件）。
发送类动作只起草（D5：发送前必问），点头由 HUD 上的按钮完成。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from pydantic_ai import Agent, RunContext
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, UserPromptPart
from pydantic_ai.models import Model
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain import gmail, workbench_facts
from domain.credentials import CredentialError
from domain.gmail import GmailError
from domain.google_oauth import GoogleAuthError
from domain.model_runtime import PreparedChatRoute
from domain.models import (
    Article,
    Book,
    GoogleAccount,
    MailMessage,
)
from domain.repair_agent import build_model

DEFAULT_CAPABILITY = "assistant"
FALLBACK_CAPABILITY = "chat-general"

PAGES = {
    "今天": "/",
    "首页": "/",
    "阅读": "/read",
    "书架": "/read",
    "视频": "/video",
    "词汇": "/vocab",
    "词库": "/vocab",
    "语法": "/grammar",
    "对话": "/talk",
    "工坊": "/studio",
    "任务": "/tasks",
    "邮件": "/mail",
    "账号": "/accounts",
    "账号与凭据": "/accounts",
}

# 助理页「它能动的东西」按这张表显示；单测保证它与代理实际注册的工具一致
TOOL_CATALOG: tuple[tuple[str, str, str], ...] = (
    ("find_reading", "阅读", "按书名或文章标题找阅读材料"),
    ("open_reading", "阅读", "打开一本书或一篇文章"),
    ("open_page", "工作台", "跳到某一页"),
    ("review_status", "词汇", "现在有几张到期"),
    ("start_review", "词汇", "开始复习"),
    ("inbox_summary", "邮件", "各账号未读与最近几封"),
    ("search_mail", "邮件", "按 Gmail 语法搜邮件"),
    ("read_mail", "邮件", "读一封邮件正文"),
    ("draft_reply", "邮件", "起草回信（发送要你点头）"),
    ("calendar_today", "日历", "今天的日程"),
    ("running_tasks", "任务", "在跑与失败的任务数"),
    ("current_time", "时间", "现在几点、今天几号星期几"),
)

SYSTEM_PROMPT = """你是 Lingua 本地工作台的语音助理。
{identity}
规则：
- 回答要短，像说话，一到三句。你的话会被念出来，不要用 markdown、列表符号、表情。
- 中文为主；英文单词、句子、书名保持原文。
- 能用工具就用工具，不要凭空编。没有连接 Google 账号就直说没连。
- 发邮件只能起草（draft_reply），发送要用户点头；起草完告诉他「等你确认」。
- 打开页面、开始复习这类动作调工具之后只说一句「打开了」就够。
当前所在页面：{route}。选中的对象：{selection}。"""


@dataclass
class AssistantDeps:
    session_factory: Callable[[], AsyncSession]
    route: str = "/"
    selection: str = ""
    identity: str = "用户还没有设置称呼，不要自行猜测名字。"
    actions: list[dict] = field(default_factory=list)
    pending: list[dict] = field(default_factory=list)


@dataclass
class AssistantReply:
    text: str
    actions: list[dict]
    pending: list[dict]


def _short(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def build_agent(model: Model, toolsets: list | None = None) -> Agent[AssistantDeps, str]:
    # toolsets：扩展带来的 MCP 工具集（模块 22），工具名带扩展 id 前缀
    agent: Agent[AssistantDeps, str] = Agent(
        model, deps_type=AssistantDeps, output_type=str, toolsets=toolsets or None
    )

    @agent.system_prompt
    def _system(ctx: RunContext[AssistantDeps]) -> str:
        return SYSTEM_PROMPT.format(
            identity=ctx.deps.identity,
            route=ctx.deps.route or "/",
            selection=ctx.deps.selection or "无",
        )

    @agent.tool
    async def find_reading(ctx: RunContext[AssistantDeps], query: str) -> list[dict]:
        """按书名或文章标题找阅读材料（模糊匹配），返回最多 5 条，含可打开的 article_id。"""
        pattern = f"%{query.strip()}%"
        out: list[dict] = []
        async with ctx.deps.session_factory() as session:
            books = (
                await session.execute(
                    select(Book).where(Book.title.ilike(pattern), Book.status == "ready").limit(5)
                )
            ).scalars()
            for book in books:
                first = await session.scalar(
                    select(Article.id)
                    .where(Article.book_id == book.id, Article.is_section.is_(False))
                    .order_by(Article.ordinal)
                    .limit(1)
                )
                out.append(
                    {
                        "kind": "book",
                        "title": book.title,
                        "author": book.author,
                        "article_id": first,
                    }
                )
            articles = (
                await session.execute(
                    select(Article)
                    .where(
                        Article.book_id.is_(None),
                        Article.title.ilike(pattern),
                        Article.status == "ready",
                    )
                    .limit(5)
                )
            ).scalars()
            for article in articles:
                out.append({"kind": "article", "title": article.title, "article_id": article.id})
        return out[:5]

    @agent.tool
    async def open_reading(ctx: RunContext[AssistantDeps], article_id: int) -> dict:
        """打开一篇文章或一本书（用 find_reading 返回的 article_id）。"""
        async with ctx.deps.session_factory() as session:
            article = await session.get(Article, article_id)
            if article is None:
                return {"ok": False, "error": "没有这篇"}
            title = article.title
        ctx.deps.actions.append(
            {"kind": "navigate", "to": f"/read/{article_id}", "label": f"打开 {title}"}
        )
        return {"ok": True, "title": title}

    @agent.tool
    async def open_page(ctx: RunContext[AssistantDeps], page: str) -> dict:
        """跳到工作台的某一页：今天 / 阅读 / 视频 / 词汇 / 语法 / 对话 / 工坊 / 任务 / 邮件 / 账号。"""  # noqa: E501
        target = PAGES.get(page.strip())
        if target is None:
            return {"ok": False, "error": f"没有「{page}」这一页", "pages": sorted(set(PAGES))}
        ctx.deps.actions.append({"kind": "navigate", "to": target, "label": f"打开{page}"})
        return {"ok": True, "to": target}

    @agent.tool_plain
    async def review_status() -> dict:
        """词汇复习：现在有几张到期。"""
        return await workbench_facts.review_status()

    @agent.tool
    async def start_review(ctx: RunContext[AssistantDeps]) -> dict:
        """开始复习到期词（跳到复习页）。"""
        ctx.deps.actions.append({"kind": "navigate", "to": "/vocab?v=review", "label": "开始复习"})
        return {"ok": True}

    @agent.tool_plain
    async def inbox_summary() -> dict:
        """邮件概况：各账号未读数与最近几封的主题（来自本地缓存，不打 Gmail）。"""
        return await workbench_facts.inbox_summary()

    @agent.tool
    async def search_mail(ctx: RunContext[AssistantDeps], query: str, max_results: int = 5) -> dict:
        """在全部 Google 账号里搜邮件（Gmail 查询语法，如 from:ken newer_than:7d invoice）。"""
        hits: list[dict] = []
        errors: list[str] = []
        async with ctx.deps.session_factory() as session:
            accounts = list((await session.execute(select(GoogleAccount))).scalars())
            if not accounts:
                return {"connected": False, "message": "还没有连接 Google 账号"}
            for account in accounts:
                try:
                    found = await gmail.search(session, account, query, max_results=max_results)
                    for meta in found:
                        row = await gmail.upsert_from_meta(session, account, meta)
                        hits.append(
                            {
                                "message_id": row.id,
                                "account": account.email,
                                "from": row.from_name or row.from_addr,
                                "subject": row.subject,
                                "snippet": _short(row.snippet, 120),
                                "sent_at": row.sent_at.isoformat() if row.sent_at else None,
                            }
                        )
                except (GoogleAuthError, GmailError, CredentialError) as exc:
                    errors.append(f"{account.email}：{exc}")
            await session.commit()
        hits.sort(key=lambda h: h["sent_at"] or "", reverse=True)
        return {"connected": True, "hits": hits[:max_results], "errors": errors}

    @agent.tool
    async def read_mail(ctx: RunContext[AssistantDeps], message_id: int) -> dict:
        """读一封邮件的正文（先用 inbox_summary 或 search_mail 拿到 message_id）。"""
        async with ctx.deps.session_factory() as session:
            row = await session.get(MailMessage, message_id)
            if row is None:
                return {"ok": False, "error": "没有这封邮件"}
            account = await session.get(GoogleAccount, row.account_id)
            try:
                body = await gmail.fetch_body(session, account, row)
            except (GoogleAuthError, GmailError, CredentialError) as exc:
                return {"ok": False, "error": str(exc)}
            await session.commit()
            return {
                "ok": True,
                "from": row.from_name or row.from_addr,
                "from_addr": row.from_addr,
                "subject": row.subject,
                "body": _short(body, 1500),
            }

    @agent.tool
    async def draft_reply(ctx: RunContext[AssistantDeps], message_id: int, body: str) -> dict:
        """起草一封回信。不会发送：发送要用户在界面上点头。"""
        async with ctx.deps.session_factory() as session:
            row = await session.get(MailMessage, message_id)
            if row is None or row.from_addr is None:
                return {"ok": False, "error": "没有这封邮件，或它没有可回复的发件人"}
            account = await session.get(GoogleAccount, row.account_id)
            subject = row.subject if row.subject.startswith("Re:") else f"Re: {row.subject}"
            ctx.deps.pending.append(
                {
                    "type": "send_mail",
                    "label": f"回复 {row.from_name or row.from_addr}",
                    "payload": {
                        "account_id": row.account_id,
                        "to": row.from_addr,
                        "subject": subject,
                        "body": body,
                        "reply_to_message_id": row.id,
                    },
                    "preview": _short(body, 200),
                    "from_account": account.email if account else None,
                }
            )
        return {"ok": True, "pending": "等用户确认后发送"}

    @agent.tool_plain
    async def calendar_today() -> dict:
        """今天的日程（Google 日历）。"""
        return await workbench_facts.calendar_today()

    @agent.tool_plain
    async def running_tasks() -> dict:
        """任务中心概况：在跑几个、失败几个。"""
        return await workbench_facts.running_tasks()

    @agent.tool_plain
    async def current_time() -> dict:
        """本机现在的日期、时间与星期（按系统时区）。"""
        return await workbench_facts.current_time()

    return agent


def history_messages(turns: list[tuple[str, str]]) -> list[ModelMessage]:
    """把最近几轮（role, text）还原成模型消息，让代理记得上文。"""
    out: list[ModelMessage] = []
    for role, text in turns:
        if role == "user":
            out.append(ModelRequest(parts=[UserPromptPart(content=text)]))
        else:
            out.append(ModelResponse(parts=[TextPart(content=text)]))
    return out


async def run_turn(
    model: Model,
    deps: AssistantDeps,
    text: str,
    *,
    history: list[tuple[str, str]] | None = None,
    toolsets: list | None = None,
) -> AssistantReply:
    agent = build_agent(model, toolsets)
    # MCP 工具集要进上下文才会起进程 / 建连接；没有工具集时这一层是空操作
    async with agent:
        result = await agent.run(
            text, deps=deps, message_history=history_messages(history or []) or None
        )
    return AssistantReply(
        text=result.output.strip(), actions=list(deps.actions), pending=list(deps.pending)
    )


def model_for(capability: str, route: PreparedChatRoute) -> Model:
    """带台账的上游模型；复用修复代理那一层，每次模型请求单独记账。"""
    return build_model(capability, route)


__all__ = [
    "DEFAULT_CAPABILITY",
    "FALLBACK_CAPABILITY",
    "TOOL_CATALOG",
    "AssistantDeps",
    "AssistantReply",
    "build_agent",
    "history_messages",
    "model_for",
    "run_turn",
]

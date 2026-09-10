"""Google 账号、Gmail 收件箱、日历（CR-007 模块 18）。

授权回调落在 API 自己身上（桌面类型客户端允许任意 loopback 端口）。发送邮件必须带
``confirm=true``（D5：发送前必问）——这个端点是人点按钮的路径；助理经工具调用发邮件走审批内核，
不走这里。
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select

from app.config import get_settings
from app.routers.config import _audit
from app.routers.dict import SessionDep
from domain import gmail, google_oauth
from domain.articles import replace_article_content, split_plain_text
from domain.credentials import CredentialError, encrypt_config
from domain.gmail import GmailError
from domain.google_oauth import GoogleAuthError
from domain.models import Article, GoogleAccount, MailMessage, ProviderCredential

router = APIRouter(prefix="/google", tags=["google"])


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _redirect_uri() -> str:
    return get_settings().google_redirect_base.rstrip("/") + google_oauth.CALLBACK_PATH


def _account_view(account: GoogleAccount, unread: int) -> dict:
    return {
        "id": account.id,
        "email": account.email,
        "display_name": account.display_name,
        "status": account.status,
        "status_detail": account.status_detail,
        "scopes": account.scopes or [],
        "last_sync_at": _iso(account.last_sync_at),
        "unread": unread,
        "created_at": _iso(account.created_at),
    }


def _message_view(row: MailMessage, account: GoogleAccount | None = None) -> dict:
    return {
        "id": row.id,
        "account_id": row.account_id,
        "account_email": account.email if account is not None else None,
        "gmail_id": row.gmail_id,
        "thread_id": row.thread_id,
        "from_name": row.from_name,
        "from_addr": row.from_addr,
        "to_addrs": row.to_addrs or [],
        "subject": row.subject,
        "snippet": row.snippet,
        "sent_at": _iso(row.sent_at),
        "labels": row.labels or [],
        "unread": row.unread,
        "has_attachments": row.has_attachments,
        "article_id": row.article_id,
        "in_inbox": "INBOX" in (row.labels or []),
    }


async def _unread_counts(session) -> dict[int, int]:
    rows = (
        await session.execute(
            select(MailMessage.account_id, func.count())
            .where(MailMessage.unread.is_(True))
            .group_by(MailMessage.account_id)
        )
    ).all()
    return {account_id: int(n) for account_id, n in rows}


async def _load_account(session, account_id: int) -> GoogleAccount:
    account = await session.get(GoogleAccount, account_id)
    if account is None:
        raise HTTPException(status_code=404, detail="账号不存在")
    return account


def _raise_google(exc: Exception) -> None:
    if isinstance(exc, GoogleAuthError | CredentialError):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if isinstance(exc, GmailError):
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    raise exc


# ---- OAuth ----


@router.get("/oauth/client")
async def oauth_client_status(session: SessionDep) -> dict:
    row = (
        await session.execute(
            select(ProviderCredential)
            .where(ProviderCredential.provider_type == "google_oauth_client")
            .order_by(ProviderCredential.id)
            .limit(1)
        )
    ).scalar_one_or_none()
    return {
        "configured": row is not None and row.enabled,
        "credential_id": row.id if row is not None else None,
        "redirect_uri": _redirect_uri(),
    }


@router.post("/oauth/start")
async def oauth_start(session: SessionDep) -> dict:
    try:
        client_id, _ = await google_oauth.oauth_client(session)
    except GoogleAuthError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    url, state = google_oauth.build_auth_url(client_id, _redirect_uri())
    return {"url": url, "state": state}


def _callback_page(title: str, detail: str) -> HTMLResponse:
    html = (
        "<!doctype html><html lang='zh-CN'><meta charset='utf-8'><title>Lingua</title>"
        "<body style='font:15px/1.6 -apple-system,PingFang SC,sans-serif;"
        "padding:48px;color:#1B1E23'>"
        f"<h1 style='font-size:20px'>{title}</h1><p>{detail}</p>"
        "<p style='color:#7A828C'>可以关掉这个页面，回到 Lingua。</p></body></html>"
    )
    return HTMLResponse(html)


@router.get("/oauth/callback")
async def oauth_callback(
    session: SessionDep, code: str | None = None, state: str | None = None, error: str | None = None
) -> HTMLResponse:
    if error:
        return _callback_page("授权没有完成", f"Google 返回：{error}")
    if not code or not state:
        return _callback_page("授权没有完成", "缺少 code 或 state")
    try:
        verifier = google_oauth.take_verifier(state)
        client_id, client_secret = await google_oauth.oauth_client(session)
        tokens = await google_oauth.exchange_code(
            client_id, client_secret, code, verifier, _redirect_uri()
        )
        info = await google_oauth.fetch_userinfo(str(tokens["access_token"]))
    except GoogleAuthError as exc:
        return _callback_page("授权没有完成", str(exc))
    email = str(info.get("email") or "").strip().lower()
    if not email:
        return _callback_page("授权没有完成", "Google 没有返回邮箱地址")

    account = (
        await session.execute(select(GoogleAccount).where(GoogleAccount.email == email))
    ).scalar_one_or_none()
    stored = encrypt_config({"email": email, "refresh_token": str(tokens["refresh_token"])})
    if account is None:
        cred = ProviderCredential(
            name=email, kind="oauth", provider_type="google_account", config=stored
        )
        session.add(cred)
        await session.flush()
        account = GoogleAccount(
            email=email,
            display_name=str(info.get("name") or "") or None,
            credential_id=cred.id,
            scopes=str(tokens.get("scope") or "").split(),
        )
        session.add(account)
        _audit(session, "google.account.add", f"授权 Google 账号 {email}")
    else:
        cred = await session.get(ProviderCredential, account.credential_id)
        if cred is None:
            cred = ProviderCredential(
                name=email, kind="oauth", provider_type="google_account", config=stored
            )
            session.add(cred)
            await session.flush()
            account.credential_id = cred.id
        else:
            cred.config = stored
        account.scopes = str(tokens.get("scope") or "").split()
        account.status = "ok"
        account.status_detail = None
        google_oauth.forget_token(account.id)
        _audit(session, "google.account.reauth", f"重新授权 Google 账号 {email}")
    await session.commit()
    return _callback_page("已连接", f"{email} 已加入 Lingua。")


# ---- 账号 ----


@router.get("/accounts")
async def list_accounts(session: SessionDep) -> list[dict]:
    rows = (await session.execute(select(GoogleAccount).order_by(GoogleAccount.id))).scalars()
    unread = await _unread_counts(session)
    return [_account_view(a, unread.get(a.id, 0)) for a in rows]


@router.delete("/accounts/{account_id}")
async def remove_account(account_id: int, session: SessionDep) -> dict:
    account = await _load_account(session, account_id)
    cred = await session.get(ProviderCredential, account.credential_id)
    email = account.email
    # 显式逐层删：内存 SQLite 不开外键约束，靠 ondelete 级联在测试里一路绿、在 PG 上才生效
    await session.execute(delete(MailMessage).where(MailMessage.account_id == account.id))
    await session.delete(account)
    if cred is not None:
        await session.delete(cred)
    google_oauth.forget_token(account_id)
    _audit(session, "google.account.remove", f"移除 Google 账号 {email}")
    await session.commit()
    return {"deleted": account_id}


@router.post("/accounts/{account_id}/sync")
async def sync_account(account_id: int, session: SessionDep) -> dict:
    account = await _load_account(session, account_id)
    try:
        synced = await gmail.sync_account(session, account)
    except (GoogleAuthError, GmailError, CredentialError) as exc:
        await session.commit()  # reauth 状态要落库
        _raise_google(exc)
    await session.commit()
    return {"synced": synced, "last_sync_at": _iso(account.last_sync_at)}


# ---- 收件箱 ----


@router.get("/mail/inbox")
async def inbox(session: SessionDep, account_id: int | None = None, limit: int = 100) -> dict:
    accounts = {a.id: a for a in (await session.execute(select(GoogleAccount))).scalars()}
    stmt = select(MailMessage).order_by(
        MailMessage.sent_at.desc().nullslast(), MailMessage.id.desc()
    )
    if account_id is not None:
        stmt = stmt.where(MailMessage.account_id == account_id)
    rows = (await session.execute(stmt.limit(max(1, min(limit, 500))))).scalars()
    unread = await _unread_counts(session)
    return {
        "accounts": [_account_view(a, unread.get(a.id, 0)) for a in accounts.values()],
        "items": [
            _message_view(r, accounts.get(r.account_id))
            for r in rows
            if "INBOX" in (r.labels or [])
        ],
    }


@router.get("/mail/search")
async def search_mail(session: SessionDep, q: str, account_id: int | None = None) -> dict:
    q = q.strip()
    if not q:
        raise HTTPException(status_code=400, detail="q 不能为空")
    stmt = select(GoogleAccount).order_by(GoogleAccount.id)
    if account_id is not None:
        stmt = stmt.where(GoogleAccount.id == account_id)
    accounts = list((await session.execute(stmt)).scalars())
    items: list[dict] = []
    errors: list[dict] = []
    for account in accounts:
        try:
            for meta in await gmail.search(session, account, q):
                meta["account_email"] = account.email
                meta["sent_at"] = _iso(meta.get("sent_at"))
                items.append(meta)
        except (GoogleAuthError, GmailError, CredentialError) as exc:
            errors.append({"account_id": account.id, "email": account.email, "detail": str(exc)})
    await session.commit()
    items.sort(key=lambda m: m.get("sent_at") or "", reverse=True)
    return {"items": items, "errors": errors}


async def _load_message(session, message_id: int) -> tuple[MailMessage, GoogleAccount]:
    row = await session.get(MailMessage, message_id)
    if row is None:
        raise HTTPException(status_code=404, detail="邮件不存在")
    account = await _load_account(session, row.account_id)
    return row, account


@router.get("/mail/messages/{message_id}")
async def message_detail(message_id: int, session: SessionDep) -> dict:
    row, account = await _load_message(session, message_id)
    try:
        body = await gmail.fetch_body(session, account, row)
    except (GoogleAuthError, GmailError, CredentialError) as exc:
        await session.commit()
        _raise_google(exc)
    await session.commit()
    return {**_message_view(row, account), "body_text": body}


@router.post("/mail/messages/{message_id}/archive")
async def archive_message(message_id: int, session: SessionDep) -> dict:
    row, account = await _load_message(session, message_id)
    try:
        await gmail.modify_labels(session, account, row, remove=["INBOX"])
    except (GoogleAuthError, GmailError, CredentialError) as exc:
        await session.commit()
        _raise_google(exc)
    await session.commit()
    return _message_view(row, account)


@router.post("/mail/messages/{message_id}/read")
async def mark_read(message_id: int, session: SessionDep) -> dict:
    row, account = await _load_message(session, message_id)
    if row.unread:
        try:
            await gmail.modify_labels(session, account, row, remove=["UNREAD"])
        except (GoogleAuthError, GmailError, CredentialError) as exc:
            await session.commit()
            _raise_google(exc)
    await session.commit()
    return _message_view(row, account)


@router.post("/mail/messages/{message_id}/import")
async def import_as_article(message_id: int, session: SessionDep) -> dict:
    """收入阅读：正文切段进 article，点词可查、可标注。已收过就直接给那篇。"""
    row, account = await _load_message(session, message_id)
    if row.article_id is not None and await session.get(Article, row.article_id) is not None:
        return {"article_id": row.article_id, "existed": True}
    try:
        body = await gmail.fetch_body(session, account, row)
    except (GoogleAuthError, GmailError, CredentialError) as exc:
        await session.commit()
        _raise_google(exc)
    paragraphs = split_plain_text(body)
    if not paragraphs:
        raise HTTPException(status_code=400, detail="这封邮件没有可读的正文")
    article = Article(
        book_id=None,
        ordinal=0,
        title=(row.subject or "（无主题）")[:512],
        source_kind="mail",
        status="parsing",
    )
    session.add(article)
    await session.flush()
    await replace_article_content(session, article, paragraphs)
    row.article_id = article.id
    await session.commit()
    return {"article_id": article.id, "existed": False}


class SendBody(BaseModel):
    account_id: int
    to: str = Field(min_length=3, max_length=320)
    subject: str = Field(max_length=998)
    body: str = Field(min_length=1)
    reply_to_message_id: int | None = None
    # D5：发送前必问。这个端点是人点按钮的路径，confirm 就是那一下点头
    confirm: bool = False


@router.post("/mail/send", status_code=201)
async def send_mail(body: SendBody, session: SessionDep) -> dict:
    if not body.confirm:
        raise HTTPException(status_code=400, detail="发送前要确认：confirm=true")
    account = await _load_account(session, body.account_id)
    thread_id = None
    in_reply_to = None
    if body.reply_to_message_id is not None:
        original = await session.get(MailMessage, body.reply_to_message_id)
        if original is not None and original.account_id == account.id:
            thread_id = original.thread_id
    try:
        sent = await gmail.send(
            session,
            account,
            to=body.to,
            subject=body.subject,
            body=body.body,
            thread_id=thread_id,
            in_reply_to=in_reply_to,
        )
    except (GoogleAuthError, GmailError, CredentialError) as exc:
        await session.commit()
        _raise_google(exc)
    _audit(session, "mail.send", f"{account.email} → {body.to}：{body.subject[:80]}")
    await session.commit()
    return {"gmail_id": sent.get("id"), "thread_id": sent.get("threadId")}


# ---- 日历 ----


@router.get("/calendar/today")
async def calendar_today(session: SessionDep) -> dict:
    accounts = list(
        (await session.execute(select(GoogleAccount).order_by(GoogleAccount.id))).scalars()
    )
    events: list[dict] = []
    errors: list[dict] = []
    now = datetime.now(UTC)
    for account in accounts:
        try:
            events.extend(await gmail.calendar_today(session, account, now=now))
        except (GoogleAuthError, GmailError, CredentialError) as exc:
            errors.append({"account_id": account.id, "email": account.email, "detail": str(exc)})
    await session.commit()
    events.sort(key=lambda e: str(e.get("start") or ""))
    return {"accounts": len(accounts), "events": events, "errors": errors}

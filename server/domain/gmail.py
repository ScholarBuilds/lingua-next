"""Gmail 与 Calendar（模块 18）：直接打 REST，不引官方 SDK。

用到的只有六个端点（messages.list / get / modify / send、users.getProfile、events.list），
官方客户端库为此要拖进来几十个包和一套发现文档机制；httpx 二十行就够。
收件箱只缓存元数据（列表要的），正文点开时再取；搜索走 Gmail 自己的 q，不在本地做。
"""

from __future__ import annotations

import base64
import re
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from email.utils import parseaddr, parsedate_to_datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain import google_oauth
from domain.models import GoogleAccount, MailMessage

GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me"
CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
METADATA_HEADERS = ("From", "To", "Subject", "Date")


class GmailError(Exception):
    pass


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _get(token: str, url: str, params: dict | None = None) -> dict:
    async with google_oauth.new_client() as client:
        resp = await client.get(url, params=params, headers=_auth(token))
    if resp.status_code != 200:
        raise GmailError(f"Google 接口 {resp.status_code}：{resp.text[:200]}")
    return resp.json()


async def _post(token: str, url: str, payload: dict) -> dict:
    async with google_oauth.new_client() as client:
        resp = await client.post(url, json=payload, headers=_auth(token))
    if resp.status_code not in (200, 201):
        raise GmailError(f"Google 接口 {resp.status_code}：{resp.text[:200]}")
    return resp.json()


# ---- 解析 ----


def _header(payload: dict, name: str) -> str:
    for h in payload.get("headers") or []:
        if str(h.get("name", "")).lower() == name.lower():
            return str(h.get("value") or "")
    return ""


def parse_meta(raw: dict) -> dict:
    """messages.get(format=metadata) → 列表行。"""
    payload = raw.get("payload") or {}
    name, addr = parseaddr(_header(payload, "From"))
    date_raw = _header(payload, "Date")
    sent_at = None
    if date_raw:
        try:
            sent_at = parsedate_to_datetime(date_raw)
            if sent_at.tzinfo is None:
                sent_at = sent_at.replace(tzinfo=UTC)
        except (TypeError, ValueError):
            sent_at = None
    if sent_at is None and raw.get("internalDate"):
        sent_at = datetime.fromtimestamp(int(raw["internalDate"]) / 1000, tz=UTC)
    labels = list(raw.get("labelIds") or [])
    to_raw = _header(payload, "To")
    return {
        "gmail_id": raw["id"],
        "thread_id": raw.get("threadId"),
        "from_name": name or None,
        "from_addr": addr or None,
        "to_addrs": [a.strip() for a in to_raw.split(",") if a.strip()] or None,
        "subject": _header(payload, "Subject"),
        "snippet": str(raw.get("snippet") or ""),
        "sent_at": sent_at,
        "labels": labels,
        "unread": "UNREAD" in labels,
        "has_attachments": any(p.get("filename") for p in _walk_parts(payload)),
    }


def _walk_parts(payload: dict):
    stack = [payload]
    while stack:
        part = stack.pop()
        yield part
        stack.extend(part.get("parts") or [])


def _decode(data: str) -> str:
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded.encode()).decode("utf-8", errors="replace")


_TAG = re.compile(r"<[^>]+>")
_BLANK = re.compile(r"\n{3,}")


def html_to_text(html: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?</\1>", "", html)
    text = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</h[1-6]>", "\n", text)
    text = _TAG.sub("", text)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )
    return _BLANK.sub("\n\n", text).strip()


def extract_text(payload: dict) -> str:
    """优先 text/plain；没有就把 text/html 剥成文本。"""
    plain: list[str] = []
    html: list[str] = []
    for part in _walk_parts(payload):
        mime = str(part.get("mimeType") or "")
        data = (part.get("body") or {}).get("data")
        if not data:
            continue
        if mime == "text/plain":
            plain.append(_decode(data))
        elif mime == "text/html":
            html.append(_decode(data))
    if plain:
        return "\n\n".join(plain).strip()
    if html:
        return html_to_text("\n".join(html))
    return ""


# ---- 同步与读取 ----


async def sync_account(
    session: AsyncSession, account: GoogleAccount, *, max_results: int = 50
) -> int:
    """拉收件箱最近 N 封的元数据，按 (account, gmail_id) upsert。返回本次落库条数。"""
    token = await google_oauth.access_token_for(session, account)
    listing = await _get(
        token, f"{GMAIL}/messages", {"labelIds": "INBOX", "maxResults": max_results}
    )
    ids = [m["id"] for m in listing.get("messages") or []]
    existing = {
        row.gmail_id: row
        for row in (
            await session.execute(select(MailMessage).where(MailMessage.account_id == account.id))
        ).scalars()
    }
    count = 0
    for gid in ids:
        raw = await _get(
            token,
            f"{GMAIL}/messages/{gid}",
            {"format": "metadata", "metadataHeaders": list(METADATA_HEADERS)},
        )
        meta = parse_meta(raw)
        row = existing.get(gid)
        if row is None:
            row = MailMessage(account_id=account.id, **meta)
            session.add(row)
            existing[gid] = row
        else:
            for key, value in meta.items():
                setattr(row, key, value)
        count += 1
    profile = await _get(token, f"{GMAIL}/profile")
    account.history_id = str(profile.get("historyId") or "") or account.history_id
    account.last_sync_at = datetime.now(UTC)
    return count


_META_COLUMNS = (
    "gmail_id",
    "thread_id",
    "from_name",
    "from_addr",
    "to_addrs",
    "subject",
    "snippet",
    "sent_at",
    "labels",
    "unread",
    "has_attachments",
)


async def upsert_from_meta(
    session: AsyncSession, account: GoogleAccount, meta: dict
) -> MailMessage:
    """搜索结果落成本地行（读正文、回复都要本地 id）；已有就更新元数据。"""
    values = {k: meta[k] for k in _META_COLUMNS if k in meta}
    row = (
        await session.execute(
            select(MailMessage).where(
                MailMessage.account_id == account.id, MailMessage.gmail_id == values["gmail_id"]
            )
        )
    ).scalar_one_or_none()
    if row is None:
        row = MailMessage(account_id=account.id, **values)
        session.add(row)
        await session.flush()
    else:
        for key, value in values.items():
            setattr(row, key, value)
    return row


async def fetch_body(session: AsyncSession, account: GoogleAccount, row: MailMessage) -> str:
    if row.body_text is not None:
        return row.body_text
    token = await google_oauth.access_token_for(session, account)
    raw = await _get(token, f"{GMAIL}/messages/{row.gmail_id}", {"format": "full"})
    row.body_text = extract_text(raw.get("payload") or {})
    return row.body_text


async def modify_labels(
    session: AsyncSession,
    account: GoogleAccount,
    row: MailMessage,
    *,
    add: list[str] | None = None,
    remove: list[str] | None = None,
) -> None:
    token = await google_oauth.access_token_for(session, account)
    payload: dict = {}
    if add:
        payload["addLabelIds"] = add
    if remove:
        payload["removeLabelIds"] = remove
    raw = await _post(token, f"{GMAIL}/messages/{row.gmail_id}/modify", payload)
    row.labels = list(raw.get("labelIds") or [])
    row.unread = "UNREAD" in row.labels


async def search(
    session: AsyncSession, account: GoogleAccount, q: str, *, max_results: int = 20
) -> list[dict]:
    """Gmail 自己的查询语法（from: has:attachment newer_than:7d …），不落库。"""
    token = await google_oauth.access_token_for(session, account)
    listing = await _get(token, f"{GMAIL}/messages", {"q": q, "maxResults": max_results})
    out: list[dict] = []
    for item in listing.get("messages") or []:
        raw = await _get(
            token,
            f"{GMAIL}/messages/{item['id']}",
            {"format": "metadata", "metadataHeaders": list(METADATA_HEADERS)},
        )
        meta = parse_meta(raw)
        meta["account_id"] = account.id
        out.append(meta)
    return out


def build_rfc822(
    *, sender: str, to: str, subject: str, body: str, in_reply_to: str | None = None
) -> str:
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = to
    msg["Subject"] = subject
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = in_reply_to
    msg.set_content(body)
    return base64.urlsafe_b64encode(msg.as_bytes()).decode()


async def send(
    session: AsyncSession,
    account: GoogleAccount,
    *,
    to: str,
    subject: str,
    body: str,
    thread_id: str | None = None,
    in_reply_to: str | None = None,
) -> dict:
    token = await google_oauth.access_token_for(session, account)
    payload: dict = {
        "raw": build_rfc822(
            sender=account.email, to=to, subject=subject, body=body, in_reply_to=in_reply_to
        )
    }
    if thread_id:
        payload["threadId"] = thread_id
    return await _post(token, f"{GMAIL}/messages/send", payload)


# ---- 日历 ----


def _local_day_bounds(now: datetime) -> tuple[datetime, datetime]:
    local = now.astimezone()
    start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=1)


async def calendar_today(
    session: AsyncSession, account: GoogleAccount, *, now: datetime | None = None
) -> list[dict]:
    token = await google_oauth.access_token_for(session, account)
    start, end = _local_day_bounds(now or datetime.now(UTC))
    raw = await _get(
        token,
        CALENDAR,
        {
            "timeMin": start.isoformat(),
            "timeMax": end.isoformat(),
            "singleEvents": "true",
            "orderBy": "startTime",
            "maxResults": 20,
        },
    )
    out: list[dict] = []
    for item in raw.get("items") or []:
        begin = item.get("start") or {}
        finish = item.get("end") or {}
        out.append(
            {
                "id": item.get("id"),
                "account_id": account.id,
                "account_email": account.email,
                "summary": item.get("summary") or "（无标题）",
                "start": begin.get("dateTime") or begin.get("date"),
                "end": finish.get("dateTime") or finish.get("date"),
                "all_day": "date" in begin and "dateTime" not in begin,
                "location": item.get("location"),
                "link": item.get("htmlLink"),
            }
        )
    return out

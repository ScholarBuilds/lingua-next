"""Google 账号与邮件（CR-007 模块 18）。

PKCE 授权回调、收件箱同步、正文与收入阅读、发送确认、归档、日历。

Google 那一侧全部用 httpx.MockTransport 顶替：打桩点是 google_oauth.new_client，
gmail 模块也从它拿客户端。
"""

import base64
import json
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select

import domain.credentials as credentials
from domain import gmail, google_oauth
from domain.credentials import decrypt_config
from domain.models import (
    Article,
    ConfigAudit,
    GoogleAccount,
    MailMessage,
    Paragraph,
    ProviderCredential,
)


class _FakeSettings:
    def __init__(self, key: str) -> None:
        self.config_key = key


@pytest.fixture(autouse=True)
def _config_key(monkeypatch):
    key = Fernet.generate_key().decode()
    monkeypatch.setattr(credentials, "get_settings", lambda: _FakeSettings(key))
    google_oauth._pending.clear()  # noqa: SLF001 - 单测隔离
    google_oauth._tokens.clear()  # noqa: SLF001
    return key


def _b64(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


def _message(
    gid: str,
    *,
    subject: str,
    unread: bool,
    body: str | None = None,
    date: str = "Tue, 02 Sep 2026 09:41:00 +0800",
) -> dict:
    labels = ["INBOX"] + (["UNREAD"] if unread else [])
    payload: dict = {
        "headers": [
            {"name": "From", "value": "Ken Harper <ken@northwind.io>"},
            {"name": "To", "value": "scholar@gmail.com"},
            {"name": "Subject", "value": subject},
            {"name": "Date", "value": date},
        ],
    }
    if body is not None:
        payload["mimeType"] = "multipart/alternative"
        payload["parts"] = [
            {"mimeType": "text/plain", "body": {"data": _b64(body)}},
            {"mimeType": "text/html", "body": {"data": _b64("<p>" + body + "</p>")}},
        ]
    return {
        "id": gid,
        "threadId": f"t-{gid}",
        "labelIds": labels,
        "snippet": subject[:40],
        "internalDate": "1788306060000",
        "payload": payload,
    }


class FakeGoogle:
    """按 URL 分发的假 Google；记录每个请求，测试断言用。"""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.inbox = [
            _message(
                "m1",
                subject="Re: Interview slot next week",
                unread=True,
                body="Hi Scholar,\n\nThursday works.\n\nBest,\nKen",
            ),
            _message(
                "m2",
                subject="Invoice for August",
                unread=False,
                body="Attached.",
                date="Mon, 01 Sep 2026 08:02:00 +0800",
            ),
        ]
        self.refresh_ok = True

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        path = urlparse(url).path
        if url.startswith(google_oauth.TOKEN_URL):
            form = parse_qs(request.content.decode())
            if form.get("grant_type") == ["authorization_code"]:
                assert form["code_verifier"], "PKCE verifier 必须带"
                return httpx.Response(
                    200,
                    json={
                        "access_token": "at-1",
                        "refresh_token": "rt-secret",
                        "expires_in": 3600,
                        "scope": " ".join(google_oauth.SCOPES),
                    },
                )
            if not self.refresh_ok:
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(200, json={"access_token": "at-2", "expires_in": 3600})
        if url.startswith(google_oauth.USERINFO_URL):
            return httpx.Response(200, json={"email": "Scholar@Gmail.com", "name": "Scholar"})
        assert request.headers.get("Authorization", "").startswith("Bearer "), (
            "每个 API 请求都要带令牌"
        )
        if path.endswith("/messages") and request.method == "GET":
            q = request.url.params.get("q")
            items = [{"id": m["id"]} for m in self.inbox]
            if q:
                items = [{"id": m["id"]} for m in self.inbox if q.lower() in m["snippet"].lower()]
            return httpx.Response(200, json={"messages": items})
        if path.endswith("/messages/send"):
            return httpx.Response(200, json={"id": "sent-1", "threadId": "t-m1"})
        if path.endswith("/modify"):
            gid = path.split("/")[-2]
            body = json.loads(request.content.decode())
            msg = next(m for m in self.inbox if m["id"] == gid)
            labels = [
                label for label in msg["labelIds"] if label not in body.get("removeLabelIds", [])
            ]
            msg["labelIds"] = labels + [
                label for label in body.get("addLabelIds", []) if label not in labels
            ]
            return httpx.Response(200, json={"id": gid, "labelIds": msg["labelIds"]})
        if "/messages/" in path:
            gid = path.split("/")[-1]
            msg = next(m for m in self.inbox if m["id"] == gid)
            if request.url.params.get("format") == "metadata":
                meta = dict(msg)
                meta["payload"] = {"headers": msg["payload"]["headers"]}
                return httpx.Response(200, json=meta)
            return httpx.Response(200, json=msg)
        if path.endswith("/profile"):
            return httpx.Response(
                200, json={"emailAddress": "scholar@gmail.com", "historyId": "777"}
            )
        if "/calendars/primary/events" in path:
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "id": "ev1",
                            "summary": "与 Ken 通话",
                            "start": {"dateTime": "2026-09-02T15:00:00+08:00"},
                            "end": {"dateTime": "2026-09-02T15:45:00+08:00"},
                            "htmlLink": "https://calendar.google.com/x",
                        },
                        {
                            "id": "ev2",
                            "summary": "All day",
                            "start": {"date": "2026-09-02"},
                            "end": {"date": "2026-09-03"},
                        },
                    ]
                },
            )
        return httpx.Response(404, json={"error": f"no route for {url}"})


@pytest.fixture
def fake_google(monkeypatch):
    fake = FakeGoogle()
    real_client = httpx.AsyncClient

    def factory(timeout: float = 20.0):
        return real_client(transport=httpx.MockTransport(fake.handler), timeout=timeout)

    monkeypatch.setattr(google_oauth, "new_client", factory)
    return fake


async def _configure_client(client) -> None:
    r = await client.post(
        "/vault/credentials",
        json={
            "name": "Google OAuth",
            "provider_type": "google_oauth_client",
            "config": {
                "client_id": "cid.apps.googleusercontent.com",
                "client_secret": "GOCSPX-secret",
            },
        },
    )
    assert r.status_code == 201, r.text


async def _authorize(client) -> dict:
    start = await client.post("/google/oauth/start")
    assert start.status_code == 200, start.text
    state = start.json()["state"]
    cb = await client.get(f"/google/oauth/callback?code=CODE&state={state}")
    assert cb.status_code == 200
    assert "已连接" in cb.text
    accounts = (await client.get("/google/accounts")).json()
    assert len(accounts) == 1
    return accounts[0]


def test_auth_url_uses_pkce_and_offline_consent() -> None:
    url, state = google_oauth.build_auth_url("cid", "http://127.0.0.1:8100/google/oauth/callback")
    params = parse_qs(urlparse(url).query)
    assert params["code_challenge_method"] == ["S256"]
    assert params["access_type"] == ["offline"]
    assert params["prompt"] == ["consent"]
    assert params["state"] == [state]
    assert "gmail.modify" in params["scope"][0]
    assert google_oauth.take_verifier(state)
    with pytest.raises(google_oauth.GoogleAuthError):
        google_oauth.take_verifier(state)  # 一次性


async def test_start_requires_client(client) -> None:
    r = await client.post("/google/oauth/start")
    assert r.status_code == 409
    assert (await client.get("/google/oauth/client")).json()["configured"] is False


async def test_callback_stores_refresh_token_in_vault(client, session, fake_google) -> None:
    await _configure_client(client)
    account = await _authorize(client)
    assert account["email"] == "scholar@gmail.com"  # 小写归一
    assert account["status"] == "ok"
    row = (await session.execute(select(GoogleAccount))).scalar_one()
    cred = await session.get(ProviderCredential, row.credential_id)
    assert cred.kind == "oauth" and cred.provider_type == "google_account"
    assert cred.config["refresh_token"].startswith("enc:")
    assert decrypt_config(cred.config)["refresh_token"] == "rt-secret"
    listed = (await client.get("/vault/credentials")).json()
    mine = next(c for c in listed if c["id"] == cred.id)
    assert mine["secret_kind"] == "oauth"
    assert mine["used_by"] == ["邮件", "日历"]
    # 重新授权同一账号：覆盖令牌，不多一条账号
    await _authorize(client)
    assert len((await client.get("/google/accounts")).json()) == 1


async def test_sync_inbox_and_read_body(client, session, fake_google) -> None:
    await _configure_client(client)
    account = await _authorize(client)
    r = await client.post(f"/google/accounts/{account['id']}/sync")
    assert r.status_code == 200, r.text
    assert r.json()["synced"] == 2
    r = await client.post(f"/google/accounts/{account['id']}/sync")
    assert r.json()["synced"] == 2  # upsert，不翻倍
    assert (await session.execute(select(MailMessage))).scalars().all().__len__() == 2

    inbox = (await client.get("/google/mail/inbox")).json()
    assert [m["subject"] for m in inbox["items"]] == [
        "Re: Interview slot next week",
        "Invoice for August",
    ]
    assert inbox["items"][0]["unread"] is True
    assert inbox["items"][0]["from_name"] == "Ken Harper"
    assert inbox["items"][0]["from_addr"] == "ken@northwind.io"
    assert inbox["accounts"][0]["unread"] == 1

    first = inbox["items"][0]
    detail = (await client.get(f"/google/mail/messages/{first['id']}")).json()
    assert detail["body_text"].startswith("Hi Scholar,")
    # 正文缓存：第二次不再打 Google
    before = len(fake_google.requests)
    await client.get(f"/google/mail/messages/{first['id']}")
    assert len(fake_google.requests) == before

    r = await client.post(f"/google/mail/messages/{first['id']}/read")
    assert r.json()["unread"] is False
    r = await client.post(f"/google/mail/messages/{first['id']}/archive")
    assert r.json()["in_inbox"] is False
    assert [m["gmail_id"] for m in (await client.get("/google/mail/inbox")).json()["items"]] == [
        "m2"
    ]


async def test_import_mail_as_article(client, session, fake_google) -> None:
    await _configure_client(client)
    account = await _authorize(client)
    await client.post(f"/google/accounts/{account['id']}/sync")
    first = (await client.get("/google/mail/inbox")).json()["items"][0]
    r = await client.post(f"/google/mail/messages/{first['id']}/import")
    assert r.status_code == 200, r.text
    article_id = r.json()["article_id"]
    article = await session.get(Article, article_id)
    assert article.source_kind == "mail"
    assert article.title == "Re: Interview slot next week"
    assert article.status == "ready"
    n = await session.scalar(
        select(Paragraph.id).where(Paragraph.article_id == article_id).limit(1)
    )
    assert n is not None
    again = (await client.post(f"/google/mail/messages/{first['id']}/import")).json()
    assert again == {"article_id": article_id, "existed": True}


async def test_send_requires_confirm_and_is_audited(client, session, fake_google) -> None:
    await _configure_client(client)
    account = await _authorize(client)
    body = {
        "account_id": account["id"],
        "to": "ken@northwind.io",
        "subject": "Re: slot",
        "body": "Thursday 3pm works.",
    }
    r = await client.post("/google/mail/send", json=body)
    assert r.status_code == 400
    r = await client.post("/google/mail/send", json={**body, "confirm": True})
    assert r.status_code == 201, r.text
    sent = next(req for req in fake_google.requests if str(req.url).endswith("/messages/send"))
    raw = json.loads(sent.content.decode())["raw"]
    rfc822 = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode()
    assert "To: ken@northwind.io" in rfc822
    assert "Subject: Re: slot" in rfc822
    assert "From: scholar@gmail.com" in rfc822
    audits = (await session.execute(select(ConfigAudit.action))).scalars().all()
    assert "mail.send" in audits


async def test_search_and_calendar(client, fake_google) -> None:
    await _configure_client(client)
    await _authorize(client)
    r = await client.get("/google/mail/search?q=invoice")
    assert r.status_code == 200
    assert [m["subject"] for m in r.json()["items"]] == ["Invoice for August"]
    cal = (await client.get("/google/calendar/today")).json()
    assert cal["accounts"] == 1
    assert [e["summary"] for e in cal["events"]] == ["All day", "与 Ken 通话"]
    assert cal["events"][0]["all_day"] is True


async def test_invalid_grant_marks_account_reauth(client, fake_google) -> None:
    await _configure_client(client)
    account = await _authorize(client)
    fake_google.refresh_ok = False
    r = await client.post(f"/google/accounts/{account['id']}/sync")
    assert r.status_code == 409
    assert "invalid_grant" in r.json()["detail"]
    listed = (await client.get("/google/accounts")).json()
    assert listed[0]["status"] == "reauth"
    assert "重新授权" in listed[0]["status_detail"]


async def test_remove_account_cascades(client, session, fake_google) -> None:
    await _configure_client(client)
    account = await _authorize(client)
    await client.post(f"/google/accounts/{account['id']}/sync")
    r = await client.delete(f"/google/accounts/{account['id']}")
    assert r.status_code == 200
    assert (await client.get("/google/accounts")).json() == []
    creds = (await session.execute(select(ProviderCredential.provider_type))).scalars().all()
    assert "google_account" not in creds


def test_html_fallback_and_parse_meta() -> None:
    text = gmail.html_to_text("<div>Hello<br>World</div><p>&amp; more</p>")
    assert text == "Hello\nWorld\n& more"
    meta = gmail.parse_meta(_message("x", subject="S", unread=True))
    assert meta["unread"] is True
    assert meta["sent_at"] is not None
    assert meta["to_addrs"] == ["scholar@gmail.com"]

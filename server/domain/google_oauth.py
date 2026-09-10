"""Google OAuth（模块 18）：桌面类型客户端 + PKCE，回调落在 API 自己身上。

一个 OAuth 客户端（保险箱里 provider_type=google_oauth_client）服务全部账号；
每个账号授权后拿到自己的刷新令牌，存成一条 kind=oauth 的凭据。访问令牌只在内存里缓存，
过期就用刷新令牌换。刷新令牌失效（invalid_grant，常见于同意屏幕仍在「测试」状态、
7 天过期）把账号标成 reauth，UI 提示重新授权，不静默重试。
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import time
from dataclasses import dataclass

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.credentials import CredentialError, decrypt_config
from domain.models import GoogleAccount, ProviderCredential
from domain.network_policy import routed_http_client

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
SCOPES = (
    "openid",
    "email",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar.readonly",
)
CALLBACK_PATH = "/google/oauth/callback"
_PENDING_TTL_S = 600


class GoogleAuthError(Exception):
    """授权链路的可解释失败（客户端未配、state 不匹配、换令牌被拒）。"""


def new_client(timeout: float = 20.0) -> httpx.AsyncClient:
    """OAuth 换令牌与 API 请求共用客户端代理策略。"""
    return routed_http_client(timeout=timeout)


@dataclass
class _Pending:
    verifier: str
    created_at: float


# state → PKCE verifier；只活在发起授权的这个进程里，十分钟没回来就作废
_pending: dict[str, _Pending] = {}


def _prune_pending(now: float) -> None:
    for state in [s for s, p in _pending.items() if now - p.created_at > _PENDING_TTL_S]:
        _pending.pop(state, None)


def build_auth_url(client_id: str, redirect_uri: str) -> tuple[str, str]:
    """返回 (授权地址, state)。PKCE S256；prompt=consent 才每次都发刷新令牌。"""
    now = time.time()
    _prune_pending(now)
    verifier = secrets.token_urlsafe(48)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    )
    state = secrets.token_urlsafe(24)
    _pending[state] = _Pending(verifier=verifier, created_at=now)
    params = httpx.QueryParams(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(SCOPES),
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
        }
    )
    return f"{AUTH_URL}?{params}", state


def take_verifier(state: str) -> str:
    pending = _pending.pop(state, None)
    if pending is None or time.time() - pending.created_at > _PENDING_TTL_S:
        raise GoogleAuthError("授权已过期或不是本机发起的，请重新点「添加账号」")
    return pending.verifier


async def exchange_code(
    client_id: str, client_secret: str, code: str, verifier: str, redirect_uri: str
) -> dict:
    async with new_client() as client:
        resp = await client.post(
            TOKEN_URL,
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "code_verifier": verifier,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
            },
        )
    if resp.status_code != 200:
        raise GoogleAuthError(f"换取令牌失败（{resp.status_code}）：{resp.text[:200]}")
    tokens = resp.json()
    if not tokens.get("refresh_token"):
        raise GoogleAuthError("Google 没有返回刷新令牌：请在账号的第三方访问里撤销本应用后重新授权")
    return tokens


async def fetch_userinfo(access_token: str) -> dict:
    async with new_client() as client:
        resp = await client.get(USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
    if resp.status_code != 200:
        raise GoogleAuthError(f"读取账号信息失败（{resp.status_code}）")
    return resp.json()


async def refresh_access_token(client_id: str, client_secret: str, refresh_token: str) -> dict:
    async with new_client() as client:
        resp = await client.post(
            TOKEN_URL,
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
        )
    if resp.status_code != 200:
        detail = (
            resp.json().get("error", "")
            if resp.headers.get("content-type", "").startswith("application/json")
            else ""
        )
        raise GoogleAuthError(detail or f"刷新令牌失败（{resp.status_code}）")
    return resp.json()


# ---- 客户端与账号令牌 ----


async def oauth_client(session: AsyncSession) -> tuple[str, str]:
    """保险箱里那条 google_oauth_client；没有就让上层把引导卡摆出来。"""
    row = (
        await session.execute(
            select(ProviderCredential)
            .where(
                ProviderCredential.provider_type == "google_oauth_client",
                ProviderCredential.enabled.is_(True),
            )
            .order_by(ProviderCredential.id)
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is None:
        raise GoogleAuthError("还没有配置 Google OAuth 客户端")
    config = decrypt_config(row.config)
    client_id = str(config.get("client_id") or "").strip()
    client_secret = str(config.get("client_secret") or "").strip()
    if not client_id or not client_secret:
        raise GoogleAuthError("Google OAuth 客户端缺 Client ID 或 Client Secret")
    return client_id, client_secret


# account_id → (access_token, 过期时刻)。进程重启就没了，重新换一次即可
_tokens: dict[int, tuple[str, float]] = {}


def forget_token(account_id: int) -> None:
    _tokens.pop(account_id, None)


async def access_token_for(session: AsyncSession, account: GoogleAccount) -> str:
    cached = _tokens.get(account.id)
    if cached is not None and cached[1] - time.time() > 60:
        return cached[0]
    client_id, client_secret = await oauth_client(session)
    cred = await session.get(ProviderCredential, account.credential_id)
    if cred is None:
        raise GoogleAuthError("账号的凭据不见了，请移除后重新授权")
    refresh_token = str(decrypt_config(cred.config).get("refresh_token") or "")
    if not refresh_token:
        raise CredentialError("账号没有刷新令牌，请重新授权")
    try:
        tokens = await refresh_access_token(client_id, client_secret, refresh_token)
    except GoogleAuthError as exc:
        if "invalid_grant" in str(exc):
            account.status = "reauth"
            account.status_detail = (
                "刷新令牌已失效（常见于同意屏幕仍在测试状态、7 天过期），请重新授权"
            )
            forget_token(account.id)
        raise
    token = str(tokens["access_token"])
    _tokens[account.id] = (token, time.time() + float(tokens.get("expires_in", 3600)))
    if account.status != "ok":
        account.status = "ok"
        account.status_detail = None
    return token

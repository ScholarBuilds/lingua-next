"""客户端外部请求的显式路由；回环连接始终直连。"""

import os
import time
from contextlib import asynccontextmanager
from ipaddress import ip_address
from typing import Literal
from urllib.parse import urlsplit

import aiohttp
import httpx
from pydantic import BaseModel, ConfigDict, field_validator

from domain.models import UserPref

PREF_KEY = "network"


def _is_loopback(host: str) -> bool:
    host = host.lower().rstrip(".")
    if host == "localhost":
        return True
    try:
        address = ip_address(host)
    except ValueError:
        return False
    return address.is_loopback


class NetworkPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    enabled: bool = False
    address: str = "http://127.0.0.1:7890"
    video: bool = True
    speech: bool = False
    scope: Literal["selected", "all"] = "all"

    @field_validator("address")
    @classmethod
    def validate_address(cls, value: str) -> str:
        value = value.strip()
        try:
            url = urlsplit(value)
            valid = (
                url.scheme == "http"
                and url.hostname
                and url.port
                and not url.username
                and not url.password
                and url.path in ("", "/")
                and not url.query
                and not url.fragment
                and not any(char.isspace() for char in value)
            )
        except ValueError:
            valid = False
        if not valid:
            raise ValueError(
                "请填写 HTTP 代理地址和端口，不包含账号密码，例如 http://127.0.0.1:7890"
            )
        return value.rstrip("/")

    def proxy_for(self, scope: str = "all", url: str = "") -> str | None:
        host = (urlsplit(url).hostname or "").lower()
        if _is_loopback(host):
            return None
        selected = self.scope == "all" or (scope in {"video", "speech"} and getattr(self, scope))
        return self.address if self.enabled and selected else None


@asynccontextmanager
async def detached_session():
    from app.db import SessionFactory

    async with SessionFactory() as session:
        yield session


async def load_policy(session=None) -> NetworkPolicy:
    if session is None:
        async with detached_session() as db:
            return await load_policy(db)
    row = await session.get(UserPref, PREF_KEY)
    if row:
        # 旧版仅授权两个用途，升级不得静默扩大到所有外部请求。
        return NetworkPolicy.model_validate({"scope": "selected", **row.value})
    return NetworkPolicy()


class PolicyTransport(httpx.AsyncBaseTransport):
    def __init__(self):
        self._routes: dict[str | None, httpx.AsyncHTTPTransport] = {}

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host.lower()
        if _is_loopback(host):
            proxy = None
        else:
            proxy = (await load_policy()).proxy_for(url=str(request.url))
        if proxy not in self._routes:
            self._routes[proxy] = httpx.AsyncHTTPTransport(proxy=proxy, trust_env=False)
        return await self._routes[proxy].handle_async_request(request)

    async def aclose(self):
        for transport in self._routes.values():
            await transport.aclose()


def routed_http_client(**kwargs) -> httpx.AsyncClient:
    kwargs["trust_env"] = False
    kwargs.setdefault("transport", PolicyTransport())
    return httpx.AsyncClient(**kwargs)


async def speech_proxy() -> str | None:
    return (await load_policy()).proxy_for("speech")


async def subprocess_env() -> dict[str, str]:
    env = {
        key: value
        for key, value in os.environ.items()
        if key.lower()
        not in {
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
        }
    }
    proxy = (await load_policy()).proxy_for()
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        env[key] = proxy or ""
    env["NO_PROXY"] = env["no_proxy"] = "localhost,127.0.0.0/8,::1"
    return env


async def video_config(config: dict, session=None) -> dict:
    policy = await load_policy(session)
    # 空字符串让 yt-dlp 禁用环境代理；网络设置是唯一代理来源。
    return {**config, "proxy": policy.proxy_for("video") or ""}


async def probe_speech_network(policy: NetworkPolicy) -> dict:
    """不发送凭据或音频，只检查到固定服务域名的 HTTPS 链路。"""
    started = time.monotonic()
    route = "proxy" if policy.proxy_for("speech") else "direct"
    try:
        async with (
            aiohttp.ClientSession(trust_env=False, timeout=aiohttp.ClientTimeout(total=8)) as http,
            http.get(
                "https://openspeech.bytedance.com/",
                proxy=policy.proxy_for("speech"),
                allow_redirects=False,
            ) as response,
        ):
            status = response.status
        reachable = status not in (407, 502, 503, 504)
        return {
            "reachable": reachable,
            "route": route,
            "http_status": status,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            "message": (
                "网络可达；尚未验证语音鉴权和 WebSocket 会话"
                if reachable
                else f"代理或上游网关返回 HTTP {status}，请检查网络路径"
            ),
        }
    except (aiohttp.ClientError, TimeoutError) as exc:
        return {
            "reachable": False,
            "route": route,
            "http_status": None,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            "message": f"网络连接失败（{type(exc).__name__}），请检查代理开关、端口和网络规则",
        }

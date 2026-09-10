"""模型 SDK 的 HTTP 客户端与本机地址判定。"""

from urllib.parse import urlparse

import httpx

from domain.network_policy import routed_http_client

LOOPBACK_NAMES = frozenset({"localhost", "::1", "[::1]"})


def is_local(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in LOOPBACK_NAMES or host.startswith("127.")


def http_client(timeout: float, target_url: str) -> httpx.AsyncClient:
    """保留 SDK 构造调用点，HTTP 路由由统一网络策略按请求目标决定。"""
    return routed_http_client(timeout=timeout)

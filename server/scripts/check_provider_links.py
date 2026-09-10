"""探活授权引导里的每一条外链（需求 17 §4.4 · 验收 CR005-I）。

为什么要有这个脚本：本仓踩过「凭记忆写外部资源 ID」的坑——内置频道的
5 个 YouTube channel_id 里有 3 个是 404，而代码不会报错，只是那三个频道永远空着。
引导里的链接同理：写错了不崩，只是用户点过去看到 404，然后自己去搜。

用法::

    uv run python scripts/check_provider_links.py            # 全查
    uv run python scripts/check_provider_links.py --strict   # 有一条不通就退出码 1

判据说明：

- **2xx / 3xx 算通**；
- **401 / 403 也算通**——控制台页面要求登录是正常的，页面本身存在；
- 405 算通：有些站点不认 HEAD，但 URL 是对的；
- 404 / 410 判死；
- 超时与连接失败**不判死**，只标「查不到」——本机网络状况不能拿来给链接定罪。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from domain.provider_onboarding import all_links  # noqa: E402

#: 这些状态码说明「页面在」，只是不让匿名访问
ALIVE_STATUSES = frozenset({401, 403, 405, 429})
TIMEOUT = 15.0


async def probe(client: httpx.AsyncClient, url: str) -> tuple[str, str]:
    """返回 (状态标记, 说明)。标记是 ok / dead / unknown。"""
    try:
        # 先 HEAD，被拒再 GET：部分站点对 HEAD 返回 405 或直接断开
        resp = await client.head(url, follow_redirects=True)
        if resp.status_code >= 400 and resp.status_code not in ALIVE_STATUSES:
            resp = await client.get(url, follow_redirects=True)
    except httpx.HTTPError as exc:
        return "unknown", f"{type(exc).__name__}: {exc}"
    code = resp.status_code
    if code < 400 or code in ALIVE_STATUSES:
        return "ok", f"HTTP {code}"
    return "dead", f"HTTP {code}"


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true", help="有死链就返回退出码 1")
    args = parser.parse_args()

    links = all_links()
    print(f"共 {len(links)} 条外链\n")

    headers = {"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
    dead: list[tuple[str, str, str]] = []
    unknown: list[tuple[str, str, str]] = []

    async with httpx.AsyncClient(timeout=TIMEOUT, headers=headers) as client:
        results = await asyncio.gather(*(probe(client, url) for _, url in links))

    for (ptype, url), (mark, note) in zip(links, results, strict=True):
        icon = {"ok": "✅", "dead": "❌", "unknown": "⚠️ "}[mark]
        print(f"{icon} {ptype:20} {note:28} {url}")
        if mark == "dead":
            dead.append((ptype, url, note))
        elif mark == "unknown":
            unknown.append((ptype, url, note))

    print()
    print(f"通 {len(links) - len(dead) - len(unknown)} · 死 {len(dead)} · 查不到 {len(unknown)}")
    if dead:
        print("\n死链（必须修，宁可退回根域名也别留 404）：")
        for ptype, url, note in dead:
            print(f"  {ptype}: {url}  ({note})")
    if unknown:
        print("\n查不到（多半是本机网络，不判死）：")
        for ptype, url, note in unknown:
            print(f"  {ptype}: {url}  ({note})")

    return 1 if (dead and args.strict) else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

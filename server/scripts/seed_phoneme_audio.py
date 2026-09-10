"""预热 44 个音位的示范音（离线内容生产）。

**为什么必须离线跑一次**：Commons 是有请求礼仪的公共资源，被判定为滥用会返回
`Retry-After: 600`——那不是节流是封禁，一封十分钟，期间所有未缓存的音位全部哑掉。
运行时按需拉虽然有串行锁兜着，但「第一个访问的用户替所有人挨这一刀」不是个好设计。

这批文件是**静态内容**，性质与 `web/public/phonetics/*.svg` 那 51 张剖面图一样，
本来就该在内容生产期落地，而不是在用户点击时才去公网取。跑完之后运行时零外网依赖。

    uv run python scripts/seed_phoneme_audio.py [--force]

> [!danger] 双元音那 8 个自 2026-08-30 起**不可再生**
>
> 它们走的是本地 TTS + 强制对齐切段（ADR-011），而对齐用的音素模型已随发音评分
> 一起下线（ADR-012）。磁盘上 44/44 都在，`needs_fetch` 只对
> `degraded_from == "commons"` 的 27 个返回 True，所以**不加 `--force` 重跑不会碰它们**。
>
> 加了 `--force` 会把它们一起重取，而 8 个双元音 Commons 上不存在、切段也走不通，
> 结果是拿 `.bak` 挪开再放回（脚本本身不会毁数据），但会以退出码 1 结束。
> 备份在 `归档/2026-08-30-发音评分模型下线/phoneme-audio-不可再生.tar.gz`，
> `server/data/media/phoneme_ipa/` 不在 git 里，从此按资产而不是缓存对待。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings  # noqa: E402
from app.db import SessionFactory  # noqa: E402
from app.routers.phonetics import ensure_word_timings  # noqa: E402
from domain.phoneme_audio import (  # noqa: E402
    cache_paths,
    ensure_phoneme_audio,
    resolve_commons_batch,
)
from domain.phoneme_audio_sources import AUDIO_SOURCES  # noqa: E402

# 条目之间的间隔。domain 层已有 0.35s 的串行锁，这里再加一档是给批量预热用的：
# 一次连打 36 条即使串行也会被判定为爬取——实测被限流后 Retry-After 从 10 秒
# 一路升到 600 秒。慢一点换一次跑通，总耗时也就两分钟
PACE_S = 0.4


async def main(force: bool) -> int:
    media_root = get_settings().media_root
    # 开一个会话给示范词合成用：走哪家 TTS 由用户配的「查词发音」绑定决定，
    # 预热和运行时必须是同一家，否则缓存键对不上、跑了等于没跑
    async with SessionFactory() as session:
        return await _run(media_root, force, session)


async def _run(media_root: str, force: bool, session) -> int:
    ok, skipped, failed = 0, 0, []

    def needs_fetch(symbol: str) -> bool:
        mp3, meta = cache_paths(media_root, symbol)
        if force or not (mp3.exists() and meta.exists()):
            return True
        # **降级过的要重取。** 运行时 Commons 拿不到会临时降级到切段并落缓存，
        # 不认这个标记的话「一次限流 = 永远是降级版」——用户再也拿不到
        # 语音学家那版孤立示范音，而且没有任何迹象说明为什么。
        try:
            info = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return True
        return info.get("degraded_from") == "commons"

    todo = [(sym, src) for sym, src in AUDIO_SOURCES.items() if needs_fetch(sym)]
    skipped = len(AUDIO_SOURCES) - len(todo)
    degraded = sum(1 for sym, _ in todo if all(p.exists() for p in cache_paths(media_root, sym)))
    if degraded:
        print(f"其中 {degraded} 个是运行时降级版，本次重取 Commons 原版")



    # 先一次把所有 Commons 标题解析完。逐个解析 = 逐个打 API，
    # 实测当场 429 且 Retry-After 会越滚越大；合成一次就没这个问题
    need = [s.title for _, s in todo if s.strategy == "commons"]
    resolved: dict[str, dict] = {}
    if need:
        print(f"批量解析 {len(need)} 个 Commons 标题…")
        resolved = await resolve_commons_batch(need)
        print(f"解析到 {len(resolved)}/{len(need)}")

    for i, (symbol, source) in enumerate(todo, 1):
        # 有缓存就得先挪开，否则 ensure_phoneme_audio 看到就直接返回。
        # **挪走不是删掉**：这次取失败要放回去——Commons 限流时如果把降级版删了
        # 又拿不到原版，用户手上反而从「有降级音」变成「什么都没有」，比不跑还糟。
        stash = []
        for f in cache_paths(media_root, symbol):
            if f.exists():
                bak = f.with_suffix(f.suffix + ".bak")
                f.replace(bak)
                stash.append((f, bak))
        try:
            path, info = await ensure_phoneme_audio(
                media_root,
                symbol,
                source,
                lambda w, accent: ensure_word_timings(w, accent, session),
                resolved.get(source.title),
            )
        except Exception as exc:  # noqa: BLE001
            for f, bak in stash:  # 放回原样，别让用户比跑之前更惨
                bak.replace(f)
            failed.append((symbol, str(exc)))
            kept = "（保留原有降级版）" if stash else ""
            print(f"[{i:2}/{len(todo)}] {symbol:3} ✗ {exc}{kept}", flush=True)
        else:
            ok += 1
            for _, bak in stash:
                bak.unlink(missing_ok=True)
            size = path.stat().st_size // 1024
            print(f"[{i:2}/{len(todo)}] {symbol:3} ✓ {info['strategy']:9} {size}KB", flush=True)
        await asyncio.sleep(PACE_S)

    print(f"\n新增 {ok} · 已有 {skipped} · 失败 {len(failed)}")
    if failed:
        print("\n失败的音位（点击时会退到「在词里听」，不是哑的）：")
        for symbol, msg in failed:
            print(f"  {symbol}: {msg}")
        # 被限流是可重试的，不该让 CI 挂；真缺文件才算失败
        return 1 if any("限流" not in m for _, m in failed) else 0
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="已有缓存也重新取")
    raise SystemExit(asyncio.run(main(ap.parse_args().force)))

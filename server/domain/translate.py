"""翻译引擎抽象：LLM 快速直译为主（支持流式首 token），google 机翻兜底。

auto 链从配置中心 translate-chain 绑定读取（params.chain 有序，60s 缓存），
绑定缺失时用内置默认 llm → google。bing 端点已失效（见项目踩坑索引），
默认链不含 bing，仅保留为显式引擎供调试；translate-fast 走能力绑定解析到的部署。
"""

import asyncio
import os
import re
import threading
import time
from collections.abc import AsyncGenerator

from domain.llm import complete_text, stream_text
from domain.network_policy import load_policy

FREE_ENGINES = ("bing", "google")
DEFAULT_CHAIN = ("llm", "google")
CHAIN_TTL = 60.0

_chain_cache: tuple[float, tuple[str, ...]] = (0.0, DEFAULT_CHAIN)


async def auto_chain() -> tuple[str, ...]:
    """translate-chain 绑定的引擎降级顺序，60s 缓存；DB 不可用/未绑定回内置默认。"""
    global _chain_cache
    cached_at, chain = _chain_cache
    if time.monotonic() - cached_at < CHAIN_TTL:
        return chain
    resolved = DEFAULT_CHAIN
    try:
        from app.db import SessionFactory
        from domain.credentials import get_binding, normalize_chain

        async with SessionFactory() as session:
            binding = await get_binding(session, "translate-chain")
        parsed = tuple(normalize_chain((binding.params or {}).get("chain") if binding else None))
        if parsed:
            resolved = parsed
    except Exception:  # noqa: BLE001 配置读取失败不阻断翻译，走内置默认链
        pass
    _chain_cache = (time.monotonic(), resolved)
    return resolved


class EngineError(Exception):
    """单个引擎调用失败。"""


def _lang_split(lang_pair: str) -> tuple[str, str]:
    src, _, dst = lang_pair.partition("->")
    return src or "en", dst or "zh"


_free_lock = threading.Lock()


def _free_translate(text: str, engine: str, lang_pair: str, proxy: str | None = None) -> str:
    os.environ.setdefault("translators_default_region", "EN")
    import translators as ts  # 导入即触发网络预热，延迟到首次调用

    src, dst = _lang_split(lang_pair)
    # translators 库的中文代码：google/bing 均接受 zh 系列别名，统一映射
    dst_code = {"zh": "zh-Hans" if engine == "bing" else "zh-CN"}.get(dst, dst)
    src_code = {"zh": "zh-Hans" if engine == "bing" else "zh-CN"}.get(src, src)
    # translators 缓存会话不区分代理；每次更新并串行访问，避免切换出口后复用旧连接。
    with _free_lock:
        import requests
        from translators.server import Tse

        sessions = []

        def open_session(http_client="requests", proxies=None):
            session = requests.Session()
            session.trust_env = False
            session.proxies = proxies or {}
            sessions.append(session)
            return session

        # SDK 只向 Session.proxies 赋值，requests 仍会优先读取环境代理。
        # 工厂替换限于库调用期间，锁避免共享译器跨请求复用不同出口。
        original = Tse.get_client_session
        Tse.get_client_session = staticmethod(open_session)
        try:
            return ts.translate_text(
                text,
                translator=engine,
                from_language=src_code,
                to_language=dst_code,
                timeout=15.0,
                proxies={"http": proxy or "", "https": proxy or "", "all": ""},
                update_session_after_freq=1,
            )
        finally:
            Tse.get_client_session = staticmethod(original)
            for session in sessions:
                session.close()


def _translate_messages(text: str, lang_pair: str, context: str | None = None) -> list[dict]:
    """翻译 prompt；context 给出素材背景，用于消解领域词歧义。

    没有语境时 LLM 只能按最常见词义翻，英式口语里的 tube（地铁）会被译成"管子"、
    quid（英镑）会被直译。素材的标题/摘要/主题足以让它选对词义。
    """
    src, dst = _lang_split(lang_pair)
    system = (
        f"你是翻译引擎。把用户给出的 {src} 文本翻译成 {dst}，只输出译文本身，不要任何解释或引号。"
    )
    if context:
        system += (
            f"\n\n这段文本出自：{context}\n"
            "按这个背景选择词义：地名、专有名词、行业术语与口语说法都要符合该语境"
            "（例如英国生活语境里 the tube 指地铁、quid 指英镑）。"
        )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": text},
    ]


def _strip_think(content: str) -> str:
    """剥离推理模型漏进 content 的 <think> 块（上游已设 reasoning_effort=none，此为保险）。"""
    if "<think>" in content:
        content = re.sub(r"<think>.*?</think>", "", content, flags=re.S)
    return content.strip()


async def _llm_translate(
    text: str, lang_pair: str, context: str | None = None, deployment_id: int | None = None
) -> str:
    try:
        raw = await complete_text(
            "translate-fast",
            _translate_messages(text, lang_pair, context),
            deployment_id=deployment_id,
        )
    except Exception as exc:
        raise EngineError(f"llm: {type(exc).__name__}: {exc}") from exc
    content = _strip_think(raw)
    if not content:
        raise EngineError("llm: empty response")
    return content


async def stream_llm_translate(
    text: str,
    lang_pair: str = "en->zh",
    context: str | None = None,
    deployment_id: int | None = None,
) -> AsyncGenerator[dict, None]:
    """LLM 直译流式版：逐 delta 产出 {type: delta, text}，收尾 {type: done, text}。

    纯文本输出不走 JSON mode，首 token 即可下发；失败抛 EngineError 由上层降级。
    """
    parts: list[str] = []
    try:
        async for event in stream_text(
            "translate-fast",
            _translate_messages(text, lang_pair, context),
            deployment_id=deployment_id,
        ):
            if event["type"] == "delta":
                delta = str(event["text"])
                parts.append(delta)
                yield {"type": "delta", "text": delta}
    except Exception as exc:  # openai 各类异常统一收敛，由 auto 链降级
        raise EngineError(f"llm: {type(exc).__name__}: {exc}") from exc
    full = _strip_think("".join(parts))
    if not full:
        raise EngineError("llm: empty response")
    yield {"type": "done", "text": full}


async def translate(
    text: str,
    engine: str = "auto",
    lang_pair: str = "en->zh",
    context: str | None = None,
    deployment_id: int | None = None,
) -> dict:
    """翻译入口，返回 {text, engine}；engine="auto" 时按 translate-chain 配置降级。

    context 为素材背景（标题/摘要/主题），只有 LLM 引擎能用——免费引擎不接受语境，
    这也是链里 llm 优先的又一个理由。deployment_id 同理，只对 llm 这一档有意义：
    降级到 google 之后没有「模型」这回事。
    """
    engines = await auto_chain() if engine == "auto" else (engine,)
    errors: list[str] = []
    for name in engines:
        try:
            if name == "llm":
                translated = await _llm_translate(text, lang_pair, context, deployment_id)
            elif name in FREE_ENGINES:
                proxy = (await load_policy()).proxy_for()
                translated = await asyncio.to_thread(_free_translate, text, name, lang_pair, proxy)
            else:
                raise EngineError(f"unknown engine: {name}")
            return {"text": translated, "engine": name}
        except EngineError as exc:
            errors.append(str(exc))
        except Exception as exc:  # translators/openai 底层异常统一收敛
            errors.append(f"{name}: {type(exc).__name__}: {exc}")
    raise EngineError("; ".join(errors))

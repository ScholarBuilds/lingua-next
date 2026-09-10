"""流式部分图（模块 16 FR-433）：让「执行中」真的有东西看。

上游 Images API 支持 `stream=true` + `partial_images=1~3`，成图过程中会推真实的中间
图（`image_generation.partial_image` → `image_generation.completed`）。推来的是上游
真实的像素，不是本地编的百分比——BR-110 禁的是后者。

中转是否透传 SSE 未经验证，所以这个模块的第一职责是**诚实探测**：`probe()` 花一
次最便宜的钱向上游要一张 1024 低质量图，收到中间帧才报 `supported=True`。探不通就
写清楚卡在哪一步，调用方据此退回「状态 + 已跑秒数」。

任何情况下都不伪造中间帧、不编百分比（AC-113）。上游不透传流式时 `render_streaming`
直接抛 `ImageGenError`，把回退的决定权交回调用方，而不是自己偷偷改走非流式——调用
方需要知道这次到底走的哪条路。
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from domain import image_defaults, image_prompts, imagegen
from domain.imagegen import ImageGenError, RenderResult
from domain.model_catalog import ResolvedModelRoute
from domain.model_invocations import ModelInvocationSpan

logger = logging.getLogger(__name__)

# 上游允许的部分图张数。给 0 等于关流式，给 4 会被上游拒
MIN_PARTIALS = 1
MAX_PARTIALS = 3

# 流式整体超时。与非流式同一档：慢的是出图本身，不是传输
STREAM_TIMEOUT_S = imagegen.IMAGE_TIMEOUT_S

# 探测用的最小开销请求：1024 见方 + low 档 + 一张部分图
PROBE_SIZE = "1024x1024"
PROBE_QUALITY = "low"
PROBE_PROMPT = "a plain gray circle on a white background, flat vector, no text"

# 事件名后缀。generations 是 image_generation.*，edits 是 image_edit.*，只差前缀
PARTIAL_SUFFIX = "partial_image"
COMPLETED_SUFFIX = "completed"

# 抛给调用方的固定消息，probe 也靠它认出「中转吞了 SSE」这一种失败
NOT_STREAMED = imagegen.IMAGE_STREAM_NOT_SUPPORTED

# SDK 的 generations 方法认得的可选参数。应用注册表锁的 `input_fidelity` 是 edits 专属，
# 不在这张表里——那类参数塞进 extra_body 原样发给上游，而不是撞出 TypeError
SDK_EXTRA = ("background", "moderation", "output_compression", "output_format", "style", "user")


@dataclass
class Partial:
    """一张部分图。`b64` 保持原样不解码——它多半要原封不动推给前端。"""

    index: int
    b64: str
    size: str | None = None


@dataclass
class _Outcome:
    """一次流式调用消费完之后手上有什么。"""

    partials: list[Partial] = field(default_factory=list)
    images: list[bytes] = field(default_factory=list)
    usage: dict | None = None
    model: str | None = None
    revised_prompts: list[str] = field(default_factory=list)
    first_partial_ms: int | None = None
    latency_ms: int = 0


def _build_kwargs(
    prompt: str,
    *,
    capability: str,
    size: str,
    quality: str,
    n: int,
    partial_images: int,
    extra: dict[str, object],
) -> dict:
    """组请求参数。校验与非流式那条路同一套口径，不做静默纠正。"""
    if n < 1 or n > imagegen.MAX_N:
        raise ImageGenError("api", f"单次张数须在 1~{imagegen.MAX_N} 之间，收到 {n}")
    if quality not in image_prompts.QUALITIES:
        raise ImageGenError("api", f"未知质量档：{quality}")
    if not MIN_PARTIALS <= partial_images <= MAX_PARTIALS:
        raise ImageGenError(
            "api", f"部分图张数须在 {MIN_PARTIALS}~{MAX_PARTIALS} 之间，收到 {partial_images}"
        )
    kwargs: dict = {
        # 先占个位；真正发出去的模型名在 _run_stream 里由路由快照覆盖
        "model": capability,
        "prompt": prompt,
        "quality": quality,
        "n": n,
        "stream": True,
        "partial_images": partial_images,
    }
    # 画幅「自动」= 请求里干脆不带 size（与非流式那条路同一口径）。
    # 不分流的话字面量 "auto" 会进请求体，上游只会回一个看不懂的 400
    if not image_prompts.is_auto_size(size):
        kwargs["size"] = image_prompts.validate_size(size)
    # background / output_format / input_fidelity 这类由应用注册表锁死的参数原样透传
    body: dict = {}
    for key, value in extra.items():
        if value is None:
            continue
        if key in SDK_EXTRA:
            kwargs[key] = value
        else:
            body[key] = value
    if body:
        kwargs["extra_body"] = body
    return kwargs


def _dump(obj: object) -> dict | None:
    if obj is None:
        return None
    if hasattr(obj, "model_dump"):
        return obj.model_dump()  # type: ignore[no-any-return]
    if isinstance(obj, dict):
        return obj
    return None


def _decode(b64: str) -> bytes:
    try:
        return base64.b64decode(b64)
    except (binascii.Error, ValueError) as exc:
        raise ImageGenError("api", f"上游返回的图片数据解不开：{exc}") from exc


async def _run_stream(
    kwargs: dict,
    *,
    capability: str,
    route: ResolvedModelRoute | None,
    phase: str,
    timeout_s: float,
    on_partial: Callable[[Partial], Awaitable[None]] | None,
) -> _Outcome:
    """发起流式请求并消费到底。任何失败都转成 `ImageGenError`。"""
    outcome = _Outcome()
    prepared = imagegen.prepare_image_route(capability, "image.stream", route)
    snapshot = prepared.snapshot
    model_name = snapshot.model
    span = await ModelInvocationSpan(
        plugin_id=snapshot.plugin_id,
        plugin_version=snapshot.plugin_version,
        plugin_generation=snapshot.plugin_generation,
        runtime_generation=snapshot.runtime_generation,
        operation=snapshot.operation,
        capability=capability,
        deployment_id=snapshot.deployment_id,
        model=model_name,
        request={"phase": phase, **kwargs, "route": snapshot.view()},
    ).start()
    started = time.monotonic()
    try:
        client, model_name = prepared.open_stream_client(timeout_s)
        kwargs["model"] = model_name
        try:
            async with asyncio.timeout(timeout_s):
                stream = await client.images.generate(**kwargs)
                # 中转不透传 SSE 时这里拿到的是整包响应对象，迭代不了
                if not hasattr(stream, "__aiter__"):
                    raise ImageGenError("api", NOT_STREAMED)
                async for event in stream:
                    await _handle_event(event, outcome, started, on_partial)
        finally:
            await client.close()
    except asyncio.CancelledError as exc:
        await span.fail(exc, status="cancelled")
        raise
    except ImageGenError as exc:
        await span.fail(exc)
        raise
    except TimeoutError as exc:
        error = ImageGenError(
            "timeout", f"流式出图超时（{int(timeout_s)}s），换低一档质量或小一点的尺寸再试"
        )
        await span.fail(error)
        raise error from exc
    except Exception as exc:
        kind, message = imagegen.classify(exc)
        error = ImageGenError(kind, message)
        await span.fail(error)
        raise error from exc

    outcome.latency_ms = int((time.monotonic() - started) * 1000)
    await span.succeed(
        model=outcome.model or model_name,
        response={
            "phase": phase,
            "partial_count": len(outcome.partials),
            "image_count": len(outcome.images),
            "first_partial_ms": outcome.first_partial_ms,
            "revised_prompts": outcome.revised_prompts,
        },
        usage=outcome.usage,
    )
    return outcome


async def _handle_event(
    event: object,
    outcome: _Outcome,
    started: float,
    on_partial: Callable[[Partial], Awaitable[None]] | None,
) -> None:
    event_type = str(getattr(event, "type", "") or "")
    model = getattr(event, "model", None)
    if model:
        outcome.model = str(model)
    revised = getattr(event, "revised_prompt", None)
    if revised:
        outcome.revised_prompts.append(str(revised))

    if event_type.endswith(PARTIAL_SUFFIX):
        b64 = getattr(event, "b64_json", None)
        if not b64:
            return
        index = getattr(event, "partial_image_index", None)
        partial = Partial(
            index=int(index) if index is not None else len(outcome.partials),
            b64=str(b64),
            size=getattr(event, "size", None),
        )
        outcome.partials.append(partial)
        if outcome.first_partial_ms is None:
            outcome.first_partial_ms = int((time.monotonic() - started) * 1000)
        if on_partial is not None:
            await on_partial(partial)
        return

    if event_type.endswith(COMPLETED_SUFFIX):
        usage = _dump(getattr(event, "usage", None))
        if usage:
            outcome.usage = usage
        b64 = getattr(event, "b64_json", None)
        if b64:
            outcome.images.append(_decode(str(b64)))


async def probe(
    capability: str,
    *,
    timeout_s: float = 60.0,
    route: ResolvedModelRoute | None = None,
) -> dict:
    """探一次流式是否真能用。返回 {supported, partials, detail, latency_ms}。

    这会真的出一张图、真的花钱，所以只在用户显式点「探测」时调。
    `supported` 的判据是**收到过至少一张中间图**——只回最终图算不支持，因为那样
    UI 拿不到任何可显示的进展。
    """
    started = time.monotonic()
    try:
        kwargs = _build_kwargs(
            PROBE_PROMPT,
            capability=capability,
            size=PROBE_SIZE,
            quality=PROBE_QUALITY,
            n=1,
            partial_images=MIN_PARTIALS,
            extra={},
        )
        outcome = await _run_stream(
            kwargs,
            capability=capability,
            route=route,
            phase="probe",
            timeout_s=timeout_s,
            on_partial=None,
        )
    except ImageGenError as exc:
        return {
            "supported": False,
            "partials": 0,
            "detail": _failure_detail(exc),
            "latency_ms": int((time.monotonic() - started) * 1000),
        }

    if not outcome.partials:
        got_final = "，最终图倒是拿到了" if outcome.images else "，最终图也没拿到"
        return {
            "supported": False,
            "partials": 0,
            "detail": f"流式连上了，但全程只推来最终图，没有任何中间帧{got_final}——"
            "partial_images 被中转或上游忽略了",
            "latency_ms": outcome.latency_ms,
        }

    first = outcome.first_partial_ms
    return {
        "supported": True,
        "partials": len(outcome.partials),
        "detail": f"收到 {len(outcome.partials)} 张中间图，首帧 {first} ms，全程 "
        f"{outcome.latency_ms} ms",
        "latency_ms": outcome.latency_ms,
    }


def _failure_detail(exc: ImageGenError) -> str:
    """把异常翻成一句「卡在哪」的中文，UI 直接显示。"""
    if str(exc) == NOT_STREAMED:
        return "中转没有透传 SSE：带 stream=true 请求回来的是整包 JSON，拿不到中间图"
    hints = {
        "connect": "连不上中转或上游",
        "auth": "上游拒绝鉴权",
        "timeout": "探测超时",
        "binding": "这个生图能力没绑到具体模型",
        "content": "探测提示词被安全策略拒绝",
        "api": "上游报错",
    }
    return f"{hints.get(exc.kind, '上游报错')}：{exc}"


async def render_streaming(
    prompt: str,
    *,
    # 装的是能力名（image-free 这种）。名字还叫 alias 是因为 app/routers/images.py
    # 按关键字传参，改名得连生图那一组公开出口一起动，见 blockers
    alias: str,
    size: str,
    quality: str = image_defaults.FALLBACK_QUALITY,
    n: int = 1,
    partial_images: int = 2,
    on_partial: Callable[[Partial], Awaitable[None]] | None = None,
    route: ResolvedModelRoute | None = None,
    **extra: object,
) -> RenderResult:
    """流式出图。每收到一张部分图就 `await on_partial(...)`。

    返回值与 `imagegen.render_images` 完全一致，调用方两条路可以共用同一段落库代码。

    上游不透传流式时抛 `ImageGenError("api", NOT_STREAMED)`，由调用方决定要不要改走
    非流式；这里不自己回退，否则「这次有没有中间图」对调用方就成了黑盒。

    流式连上、但一张中间图都没推来的情况**照常返回最终图**：钱已经花了，为了追求
    「有中间帧」而丢掉一张真图没有道理（同 BR-106）。此时 `on_partial` 一次都不会被
    调用，UI 自然退回「状态 + 已跑秒数」。
    """
    kwargs = _build_kwargs(
        prompt,
        capability=alias,
        size=size,
        quality=quality,
        n=n,
        partial_images=partial_images,
        extra=extra,
    )
    outcome = await _run_stream(
        kwargs,
        capability=alias,
        route=route,
        phase="render",
        timeout_s=STREAM_TIMEOUT_S,
        on_partial=on_partial,
    )

    if not outcome.images:
        if outcome.partials:
            raise ImageGenError("api", "流式中途断了：收到了中间图但没有最终图，请重试")
        raise ImageGenError("api", "上游返回了空结果，一张图都没有")
    if not outcome.partials:
        logger.info("流式跑通但零中间帧，capability=%s size=%s", alias, size)

    return RenderResult(
        images=outcome.images,
        model_reported=outcome.model,
        usage=outcome.usage,
        latency_ms=outcome.latency_ms,
        revised_prompts=outcome.revised_prompts,
    )

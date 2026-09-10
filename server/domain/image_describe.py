"""视觉反推与提示词扩写（模块 16 FR-436 / FR-430）：`vision` 通路的全部实现。

这条通路不出图，只出字——传一张图反推出能复现它的英文提示词，或者把用户随手写的
一句中文扩写成结构化提示词。两者都走既有的 LLM 语义别名 `explain-standard`，
业务代码里不出现任何模型名（BR-100）。

为什么不用 `domain.llm.complete_json`：它只收纯文本 system/user，覆盖不了图。
视觉输入要用 OpenAI 兼容的 content 块（`text` + `image_url` 的 data URL），
所以这里自建客户端，写法与 `imagegen._client()` 同源。

失败语义与 `imagegen.ImageGenError` 同一套分型（connect/auth/timeout/binding/
content/api），UI 靠 kind 决定提示什么。
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import re
import time

from openai import APIStatusError, AsyncOpenAI

from domain import gateway, imagegen
from domain.model_invocations import ModelInvocationSpan
from domain.model_runtime import ModelRuntimeError, PreparedChatRoute, prepare_chat_route

# 视觉反推复用既有 LLM 能力别名。它是"看图说话"，不需要单开一个能力
VISION_ALIAS = "explain-standard"

# 看图比纯文本慢，但远快于出图
VISION_TIMEOUT_S = 90.0

# 超过这个体积先压：data URL 是整段塞进请求体的，几十兆的原图会把网关顶掉
MAX_INLINE_BYTES = 4 * 1024 * 1024
COMPRESS_EDGE = 1024
JPEG_QUALITY = 88

MODES = ("recreate", "style")
MAX_TAGS = 8
MAX_TEXT_CHARS = 2000

# 两种模式共用的硬性要求：生图模型拼不对字，让它照着描述文字只会得到一堆乱码
_NO_TEXT_RULE = (
    "硬性要求：**不要描述图上出现的文字内容**（生图模型拼不对字），"
    "画面里有文字就只说它占的位置与排版角色，如 a title bar across the top；"
    "也不要猜品牌名、真人姓名或版权角色的名字。"
)

DESCRIBE_SYSTEM: dict[str, str] = {
    "recreate": (
        "你是给生图模型写提示词的视觉分析师。看一张图，反推出能让生图模型复现它的英文提示词。"
        "只输出 JSON 对象，字段：\n"
        "prompt（英文提示词，分成几段用分号隔开，依次覆盖主体与动作、构图与视角、光线、"
        "材质与质感、色调、整体画风与媒介；具体到能照着画出来，不要写 a nice picture 这类空话）、\n"
        "zh（一句中文，说明这张图画的是什么，给用户看）、\n"
        "tags（3~8 个英文标签，风格或题材，小写，不带 # ）。\n" + _NO_TEXT_RULE
    ),
    "style": (
        "你是给生图模型写提示词的视觉分析师。看一张图，只提炼它的画风，不描述画的是什么。"
        "只输出 JSON 对象，字段：\n"
        "prompt（英文风格提示词，覆盖媒介与技法、线条与笔触、光影处理、配色倾向、质感与颗粒、"
        "整体气质；写成能套到任何主体上的一段话，**不要出现这张图的具体主体、场景或物件**）、\n"
        "zh（一句中文，说明这是什么画风）、\n"
        "tags（3~8 个英文风格标签，小写，不带 # ）。\n" + _NO_TEXT_RULE
    ),
}

DESCRIBE_USER: dict[str, str] = {
    "recreate": "分析这张图，给出能复现它的提示词。",
    "style": "只提炼这张图的画风，不要描述它画了什么。",
}

ENHANCE_SYSTEM = (
    "你把用户随手写的一句话扩写成给生图模型用的英文提示词。"
    "只输出 JSON 对象，字段 prompt：一段英文提示词，依次覆盖主体与动作、构图与视角、光线、"
    "材质、色调、画风；用户原意里的每一个要点都要保留，缺的细节按最常见的画法补齐，"
    "不要改掉用户明确指定的东西。\n"
    "不要要求在图上写字（生图模型拼不对字），也不要输出画幅、尺寸或 --ar 之类的参数，"
    "画布由调用方另行拼接。"
)


class DescribeError(Exception):
    """反推或扩写失败。`kind` 与 `imagegen.ImageGenError` 同一套分型：

    connect  网关连不上
    auth     密钥无效
    timeout  超时
    binding  别名没绑，或绑的模型不会看图
    content  被上游安全策略拒绝
    api      其余上游错误、返回体不可解析、入参不合法
    """

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


def _client(route: PreparedChatRoute) -> AsyncOpenAI:
    return AsyncOpenAI(
        base_url=route.snapshot.base_url,
        api_key=route.secrets.get("api_key") or "not-required",
        timeout=VISION_TIMEOUT_S,
        max_retries=0,
        # 本机网关不能走系统代理，否则全部调用静默 502（见 domain/gateway）
        http_client=gateway.http_client(VISION_TIMEOUT_S, route.snapshot.base_url),
    )


def _classify(exc: Exception) -> tuple[str, str]:
    """分型沿用 imagegen，只把面向用户的话改成这条通路的说法。"""
    kind, message = imagegen.classify(exc)
    if kind == "timeout":
        return kind, f"视觉模型超时（{int(VISION_TIMEOUT_S)}s），换张小图或稍后再试"
    if kind == "binding":
        return kind, (
            f"网关里没有 {VISION_ALIAS} 这个别名，到设置 · 模型服务把它绑到一个支持看图的模型上"
        )
    if kind == "api" and isinstance(exc, APIStatusError) and exc.status_code == 400:
        detail = str(getattr(exc, "message", "") or exc).lower()
        if any(token in detail for token in ("image", "vision", "multimodal", "modality")):
            return "binding", (
                f"{VISION_ALIAS} 绑的模型不接受图片输入，到设置 · 模型服务换一个支持看图的模型"
            )
    return kind, message


# ---- 入参处理 ----


def _compress(data: bytes) -> tuple[bytes, str]:
    """长边缩到 1024 再转 JPEG。原图已经够小的也重编一次——大体积多半来自无损格式。"""
    from PIL import Image

    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception as exc:  # Pillow 的异常类型不稳定，统一收敛
        raise DescribeError("api", f"图片无法解析：{type(exc).__name__}") from exc

    longest = max(im.size)
    if longest > COMPRESS_EDGE:
        ratio = COMPRESS_EDGE / longest
        im = im.resize(
            (max(1, round(im.width * ratio)), max(1, round(im.height * ratio))),
            Image.LANCZOS,
        )
    out = io.BytesIO()
    im.convert("RGB").save(out, format="JPEG", quality=JPEG_QUALITY)
    return out.getvalue(), "image/jpeg"


def _prepare(data: bytes, mime: str) -> tuple[str, str]:
    """校验并按需压缩，返回 (data URL 用的 mime, base64 文本)。"""
    if not data:
        raise DescribeError("api", "没有收到图片数据")
    clean = (mime or "").split(";")[0].strip().lower()
    if not clean.startswith("image/"):
        raise DescribeError("api", f"只接受图片，收到的是 {clean or '空 mime'}")
    if len(data) > MAX_INLINE_BYTES:
        data, clean = _compress(data)
    return clean, base64.b64encode(data).decode()


# ---- 返回体处理 ----


def _loads(content: str) -> dict:
    text = content.strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise DescribeError("api", f"模型没有返回 JSON：{text[:200]}") from None
        try:
            parsed = json.loads(text[start : end + 1])
        except json.JSONDecodeError as exc:
            raise DescribeError("api", f"模型没有返回 JSON：{text[:200]}") from exc
    if not isinstance(parsed, dict):
        raise DescribeError("api", "模型返回的 JSON 不是对象")
    return parsed


def _clean_tags(raw: object) -> list[str]:
    if isinstance(raw, str):
        items: list[object] = list(re.split(r"[,，;；]", raw))
    elif isinstance(raw, list):
        items = list(raw)
    else:
        return []
    out: list[str] = []
    for item in items:
        tag = str(item).strip().lstrip("#").strip().lower()
        if tag and tag not in out:
            out.append(tag)
    return out[:MAX_TAGS]


async def _chat(
    messages: list[dict], *, deployment_id: int | None = None
) -> tuple[dict, str | None, int]:
    """一次 JSON mode 调用，返回 (解析后 dict, 上游报的 model, 耗时)。"""
    try:
        route = await prepare_chat_route(VISION_ALIAS, "chat.complete", deployment_id=deployment_id)
    except ModelRuntimeError as exc:
        span = await ModelInvocationSpan(
            plugin_id="unresolved",
            operation="chat.complete",
            model=VISION_ALIAS,
            capability=VISION_ALIAS,
            deployment_id=deployment_id,
            request={"messages": messages, "response_format": {"type": "json_object"}},
        ).start()
        failure = DescribeError("binding", str(exc))
        await span.fail(failure)
        raise failure from exc
    span = await ModelInvocationSpan(
        plugin_id=route.snapshot.plugin_id,
        plugin_version=route.snapshot.plugin_version,
        plugin_generation=route.snapshot.plugin_generation,
        runtime_generation=route.snapshot.runtime_generation,
        operation="chat.complete",
        model=route.snapshot.model,
        capability=VISION_ALIAS,
        deployment_id=route.snapshot.deployment_id,
        request={
            "messages": messages,
            "response_format": {"type": "json_object"},
            "route": route.snapshot.view(),
        },
    ).start()
    client: AsyncOpenAI | None = None
    started = time.monotonic()
    try:
        client = _client(route)
        resp = await client.chat.completions.create(
            model=route.snapshot.model,
            messages=messages,
            response_format={"type": "json_object"},
        )
    except asyncio.CancelledError as exc:
        await span.fail(exc, status="cancelled")
        raise
    except Exception as exc:
        kind, message = _classify(exc)
        failure = DescribeError(kind, message)
        await span.fail(failure)
        raise failure from exc
    finally:
        if client is not None:
            await client.close()

    latency_ms = int((time.monotonic() - started) * 1000)
    choices = getattr(resp, "choices", None) or []
    if not choices:
        failure = DescribeError("api", "模型返回了空结果")
        await span.fail(failure)
        raise failure
    try:
        parsed = _loads(choices[0].message.content or "")
    except DescribeError as exc:
        await span.fail(exc)
        raise
    model = getattr(resp, "model", None) or route.snapshot.model
    usage = getattr(resp, "usage", None)
    await span.succeed(
        model=model,
        response={"result": parsed},
        usage=usage.model_dump(exclude_none=True) if hasattr(usage, "model_dump") else None,
        provider_request_id=getattr(resp, "id", None),
    )
    return parsed, model, latency_ms


# ---- 对外 ----


async def describe_image(data: bytes, mime: str, *, mode: str = "recreate") -> dict:
    """反推提示词（FR-436）：传一张图的原始字节，拿到能复现它的英文提示词。

    `mode="recreate"` 复现这张图；`mode="style"` 只提炼画风，不描述具体主体——
    后者用来把一张满意的图变成可反复套用的风格。

    返回 {prompt, zh, tags, model, latency_ms}。
    """
    if mode not in MODES:
        raise DescribeError("api", f"未知反推模式：{mode}，只能是 {' / '.join(MODES)}")
    clean_mime, b64 = _prepare(data, mime)

    messages: list[dict] = [
        {"role": "system", "content": DESCRIBE_SYSTEM[mode]},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": DESCRIBE_USER[mode]},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{clean_mime};base64,{b64}"},
                },
            ],
        },
    ]
    parsed, model, latency_ms = await _chat(messages)

    prompt = str(parsed.get("prompt") or "").strip()
    if not prompt:
        raise DescribeError("api", "模型没有给出提示词，换张图或重试")
    return {
        "prompt": prompt,
        "zh": str(parsed.get("zh") or "").strip(),
        "tags": _clean_tags(parsed.get("tags")),
        "model": model,
        "latency_ms": latency_ms,
    }


async def enhance_prompt(text: str, *, app_label: str, style_hint: str = "") -> dict:
    """AI 优化提示词（FR-430）：把随手写的一句话扩写成结构化英文提示词。

    显式按钮触发，不做自动优化——静默改写用户的输入会让"改了提示词却没变化"
    无法归因。返回 {prompt, model, latency_ms}。
    """
    cleaned = (text or "").strip()
    if not cleaned:
        raise DescribeError("api", "提示词是空的，先写一句想画什么")

    payload = {"用户输入": cleaned[:MAX_TEXT_CHARS], "用途": app_label}
    if style_hint.strip():
        payload["风格倾向"] = style_hint.strip()
    messages: list[dict] = [
        {"role": "system", "content": ENHANCE_SYSTEM},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    parsed, model, latency_ms = await _chat(messages)

    prompt = str(parsed.get("prompt") or "").strip()
    if not prompt:
        raise DescribeError("api", "模型没有给出扩写结果，重试一次")
    return {"prompt": prompt, "model": model, "latency_ms": latency_ms}

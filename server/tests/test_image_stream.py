"""流式部分图单测：探测判据、事件消费、失败分型。全程 mock，不联网。"""

import asyncio
import base64
from types import SimpleNamespace

import httpx
import pytest
from openai import APIConnectionError, APIStatusError

import domain.image_stream as image_stream
from domain.image_stream import ImageGenError, Partial, probe, render_streaming
from domain.model_catalog import ResolvedModelRoute

PARTIAL_TYPE = "image_generation.partial_image"
COMPLETED_TYPE = "image_generation.completed"


def _b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


def _partial_event(index: int, payload: str, size: str = "1024x1024"):
    return SimpleNamespace(
        type=PARTIAL_TYPE,
        b64_json=_b64(payload),
        partial_image_index=index,
        size=size,
    )


def _completed_event(payload: str = "final", *, usage: dict | None = None, model=None):
    return SimpleNamespace(
        type=COMPLETED_TYPE,
        b64_json=_b64(payload),
        size="1024x1024",
        usage=SimpleNamespace(model_dump=lambda: usage) if usage else None,
        model=model,
    )


class _FakeStream:
    """按序回放事件；delay 用来把调用拖到超时之外。"""

    def __init__(self, events: list, delay: float = 0.0):
        self._events = list(events)
        self._delay = delay

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._delay:
            await asyncio.sleep(self._delay)
        if not self._events:
            raise StopAsyncIteration
        return self._events.pop(0)


def make_fake_openai(
    events: list | None = None,
    *,
    raise_exc: Exception | None = None,
    plain_response: bool = False,
    delay: float = 0.0,
):
    """替身 AsyncOpenAI。返回 (类, 调用参数列表)。"""
    calls: list[dict] = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            self.images = SimpleNamespace(generate=self._generate)

        async def _generate(self, **kwargs):
            calls.append(kwargs)
            if raise_exc is not None:
                raise raise_exc
            if plain_response:
                # 网关吞掉 SSE：回的是整包响应，没有 __aiter__
                return SimpleNamespace(data=[SimpleNamespace(b64_json=_b64("final"))])
            return _FakeStream(events or [], delay=delay)

        async def close(self):
            pass

    return FakeClient, calls


def _alias_route() -> ResolvedModelRoute:
    """一条直连部署路由。

    能力没绑定部署时 image.stream 直接抛「未绑定」（网关回落已下线），所以这组测线协议
    的用例都得自带路由；上游客户端仍由各用例打桩。
    """
    return ResolvedModelRoute(
        deployment_id=1,
        adapter_type="openai",
        upstream_model_id="gpt-image-2",
        provider_type="openai_compatible",
        credential_config={"api_base": "https://images.example.invalid/v1", "api_key": "sk-x"},
        protocol_options={},
    )


def _conn_error() -> APIConnectionError:
    return APIConnectionError(request=httpx.Request("POST", "http://localhost:4000/v1"))


def _status_error(status: int, message: str) -> APIStatusError:
    request = httpx.Request("POST", "http://localhost:4000/v1")
    response = httpx.Response(status, request=request)
    return APIStatusError(message, response=response, body=None)


# ---- ① 2 张 partial + 1 张 completed ----


async def test_render_streaming_yields_partials_then_final(monkeypatch) -> None:
    events = [
        _partial_event(0, "p0"),
        _partial_event(1, "p1"),
        _completed_event("final", usage={"total_tokens": 42}, model="gpt-image-2"),
    ]
    fake, calls = make_fake_openai(events)
    monkeypatch.setattr(image_stream.imagegen, "AsyncOpenAI", fake)

    seen: list[Partial] = []

    async def on_partial(item: Partial) -> None:
        seen.append(item)

    result = await render_streaming(
        "一只猫",
        alias="image-free",
        size="1024x1024",
        on_partial=on_partial,
        route=_alias_route(),
    )

    assert [p.index for p in seen] == [0, 1]
    assert [base64.b64decode(p.b64) for p in seen] == [b"p0", b"p1"]
    assert seen[0].size == "1024x1024"
    assert result.images == [b"final"]
    assert result.usage == {"total_tokens": 42}
    assert result.model_reported == "gpt-image-2"
    assert result.latency_ms >= 0
    # 请求参数确实开了流式
    assert calls[0]["stream"] is True
    assert calls[0]["partial_images"] == 2


async def test_direct_route_uses_exact_upstream_model_and_base(monkeypatch) -> None:
    events = [_completed_event(model="gpt-image-2")]
    calls: list[dict] = []
    client_args: list[dict] = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            client_args.append(kwargs)
            self.images = SimpleNamespace(generate=self._generate)

        async def _generate(self, **kwargs):
            calls.append(kwargs)
            return _FakeStream(events)

        async def close(self):
            pass

    monkeypatch.setattr(image_stream.imagegen, "AsyncOpenAI", FakeClient)
    route = ResolvedModelRoute(
        deployment_id=7,
        adapter_type="openai",
        upstream_model_id="gpt-image-2",
        provider_type="openai_compatible",
        credential_config={
            "api_base": "https://images.example.invalid/v1",
            "api_key": "sk-test",
        },
        protocol_options={},
    )

    result = await render_streaming(
        "一只猫",
        alias="image-free",
        size="1024x1024",
        route=route,
    )

    assert result.images == [b"final"]
    assert calls[0]["model"] == "gpt-image-2"
    assert str(client_args[0]["base_url"]) == "https://images.example.invalid/v1"


async def test_render_streaming_extra_passthrough(monkeypatch) -> None:
    fake, calls = make_fake_openai([_completed_event()])
    monkeypatch.setattr(image_stream.imagegen, "AsyncOpenAI", fake)

    await render_streaming(
        "透明底图标",
        alias="image-free",
        size="1024x1024",
        background="transparent",
        output_format="png",
        moderation=None,
        route=_alias_route(),
    )
    assert calls[0]["background"] == "transparent"
    assert calls[0]["output_format"] == "png"
    assert "moderation" not in calls[0]  # None 不透传
    assert "extra_body" not in calls[0]


async def test_non_sdk_extra_goes_to_extra_body(monkeypatch) -> None:
    """edits 专属参数（input_fidelity）SDK 不认，塞 extra_body 发给网关，不撞 TypeError。"""
    fake, calls = make_fake_openai([_completed_event()])
    monkeypatch.setattr(image_stream.imagegen, "AsyncOpenAI", fake)

    await render_streaming(
        "人像", alias="image-free", size="1024x1024", input_fidelity="high", route=_alias_route()
    )
    assert "input_fidelity" not in calls[0]
    assert calls[0]["extra_body"] == {"input_fidelity": "high"}


# ---- ② 只有 completed：探测应报不支持 ----


async def test_probe_reports_unsupported_without_partials(monkeypatch) -> None:
    fake, calls = make_fake_openai([_completed_event()])
    monkeypatch.setattr(image_stream.imagegen, "AsyncOpenAI", fake)

    report = await probe("image-free", route=_alias_route())
    assert report["supported"] is False
    assert report["partials"] == 0
    assert "中间帧" in report["detail"]
    assert report["latency_ms"] >= 0
    # 探测用最便宜的一档
    assert calls[0]["size"] == "1024x1024"
    assert calls[0]["quality"] == "low"
    assert calls[0]["partial_images"] == 1


async def test_probe_supported_when_partial_arrives(monkeypatch) -> None:
    fake, _calls = make_fake_openai([_partial_event(0, "p0"), _completed_event()])
    monkeypatch.setattr(image_stream.imagegen, "AsyncOpenAI", fake)

    report = await probe("image-free", route=_alias_route())
    assert report["supported"] is True
    assert report["partials"] == 1
    assert "首帧" in report["detail"]


async def test_render_streaming_without_partials_still_returns(monkeypatch) -> None:
    """零中间帧不算失败：图已经付过费，不能为了「要有中间帧」把它丢掉。"""
    fake, _calls = make_fake_openai([_completed_event()])
    monkeypatch.setattr(image_stream.imagegen, "AsyncOpenAI", fake)

    called = False

    async def on_partial(_item: Partial) -> None:
        nonlocal called
        called = True

    result = await render_streaming(
        "一只猫",
        alias="image-free",
        size="1024x1024",
        on_partial=on_partial,
        route=_alias_route(),
    )
    assert result.images == [b"final"]
    assert called is False  # 没有中间图就一次都不回调，绝不补假帧


async def test_gateway_swallows_sse_raises(monkeypatch) -> None:
    fake, _calls = make_fake_openai(plain_response=True)
    monkeypatch.setattr(image_stream.imagegen, "AsyncOpenAI", fake)

    with pytest.raises(ImageGenError) as info:
        await render_streaming(
            "一只猫", alias="image-free", size="1024x1024", route=_alias_route()
        )
    assert info.value.kind == "api"
    assert str(info.value) == image_stream.NOT_STREAMED

    report = await probe("image-free", route=_alias_route())
    assert report["supported"] is False
    assert "SSE" in report["detail"]


# ---- ③ 连接异常 ----


async def test_connect_error_classified(monkeypatch) -> None:
    fake, _calls = make_fake_openai(raise_exc=_conn_error())
    monkeypatch.setattr(image_stream.imagegen, "AsyncOpenAI", fake)

    with pytest.raises(ImageGenError) as info:
        await render_streaming(
            "一只猫", alias="image-free", size="1024x1024", route=_alias_route()
        )
    assert info.value.kind == "connect"

    report = await probe("image-free", route=_alias_route())
    assert report["supported"] is False
    assert "连不上" in report["detail"]


async def test_binding_error_classified(monkeypatch) -> None:
    fake, _calls = make_fake_openai(raise_exc=_status_error(404, "model not found"))
    monkeypatch.setattr(image_stream.imagegen, "AsyncOpenAI", fake)

    with pytest.raises(ImageGenError) as info:
        await render_streaming(
            "一只猫", alias="image-free", size="1024x1024", route=_alias_route()
        )
    assert info.value.kind == "binding"

    report = await probe("image-free", route=_alias_route())
    assert "没绑到具体模型" in report["detail"]


# ---- ④ 超时 ----


async def test_probe_timeout(monkeypatch) -> None:
    fake, _calls = make_fake_openai([_partial_event(0, "p0")], delay=5.0)
    monkeypatch.setattr(image_stream.imagegen, "AsyncOpenAI", fake)

    report = await probe("image-free", timeout_s=0.05, route=_alias_route())
    assert report["supported"] is False
    assert report["partials"] == 0
    assert "超时" in report["detail"]


async def test_render_streaming_timeout(monkeypatch) -> None:
    fake, _calls = make_fake_openai([_completed_event()], delay=5.0)
    monkeypatch.setattr(image_stream.imagegen, "AsyncOpenAI", fake)
    monkeypatch.setattr(image_stream, "STREAM_TIMEOUT_S", 0.05)

    with pytest.raises(ImageGenError) as info:
        await render_streaming(
            "一只猫", alias="image-free", size="1024x1024", route=_alias_route()
        )
    assert info.value.kind == "timeout"


# ---- 参数校验 ----


async def test_partial_images_out_of_range(monkeypatch) -> None:
    fake, _calls = make_fake_openai([_completed_event()])
    monkeypatch.setattr(image_stream.imagegen, "AsyncOpenAI", fake)

    for bad in (0, 4):
        with pytest.raises(ImageGenError) as info:
            await render_streaming(
                "一只猫",
                alias="image-free",
                size="1024x1024",
                partial_images=bad,
                route=_alias_route(),
            )
        assert info.value.kind == "api"


async def test_bad_quality_and_n(monkeypatch) -> None:
    fake, _calls = make_fake_openai([_completed_event()])
    monkeypatch.setattr(image_stream.imagegen, "AsyncOpenAI", fake)

    with pytest.raises(ImageGenError):
        await render_streaming(
            "x", alias="image-free", size="1024x1024", quality="ultra", route=_alias_route()
        )
    with pytest.raises(ImageGenError):
        await render_streaming(
            "x", alias="image-free", size="1024x1024", n=9, route=_alias_route()
        )


async def test_partial_stream_without_final_raises(monkeypatch) -> None:
    """中途断流：有中间图没最终图，如实报断了，不拿部分图冒充成品。"""
    fake, _calls = make_fake_openai([_partial_event(0, "p0")])
    monkeypatch.setattr(image_stream.imagegen, "AsyncOpenAI", fake)

    with pytest.raises(ImageGenError) as info:
        await render_streaming(
            "一只猫", alias="image-free", size="1024x1024", route=_alias_route()
        )
    assert info.value.kind == "api"
    assert "没有最终图" in str(info.value)

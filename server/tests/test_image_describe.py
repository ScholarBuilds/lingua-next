"""视觉反推与提示词扩写单测：AsyncOpenAI 全程 mock，不打真实网络。"""

import base64
import io
import json
import os
from types import SimpleNamespace

import httpx
import pytest
from openai import APIStatusError

import domain.image_describe as image_describe
from domain.image_describe import DescribeError, describe_image, enhance_prompt
from tests.model_binding_stub import CHAT_MODEL, seed_default_bindings

OK_PAYLOAD = {
    "prompt": "a red apple on a white table; centred composition; soft window light",
    "zh": "白桌上的一颗红苹果",
    "tags": ["#Still Life", "minimal", "minimal", "product photo"],
}


@pytest.fixture(autouse=True)
async def bound_models(session):
    """explain-standard 先绑一条直连部署：没绑定的话路由直接报未绑定，走不到客户端。"""
    return await seed_default_bindings(session)


def make_fake(content: str, *, model: str = "fake-vision"):
    """替身客户端：记下每次 create 的入参，回放给定的返回文本。"""
    calls: list[dict] = []
    built: list[dict] = []

    class FakeClient:
        def __init__(self, **kwargs):
            built.append(kwargs)
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

        async def _create(self, **kwargs):
            calls.append(kwargs)
            message = SimpleNamespace(content=content)
            return SimpleNamespace(model=model, choices=[SimpleNamespace(message=message)])

        async def close(self):
            pass

    return FakeClient, calls, built


def make_raising(exc: Exception):
    built: list[dict] = []

    class FakeClient:
        def __init__(self, **kwargs):
            built.append(kwargs)
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

        async def _create(self, **kwargs):
            raise exc

        async def close(self):
            pass

    return FakeClient, built


def _png(edge: int = 64) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (edge, edge), (200, 30, 30)).save(buf, format="PNG")
    return buf.getvalue()


def _big_bmp(edge: int = 1200) -> bytes:
    """随机噪声 BMP：无压缩，1200 见方就有 4.3MB，稳定越过 4MB 门槛。"""
    from PIL import Image

    im = Image.frombytes("RGB", (edge, edge), os.urandom(edge * edge * 3))
    buf = io.BytesIO()
    im.save(buf, format="BMP")
    return buf.getvalue()


def _data_url(call: dict) -> str:
    blocks = call["messages"][1]["content"]
    return blocks[1]["image_url"]["url"]


# ---- ① 正常解析 ----


async def test_describe_parses_and_cleans(monkeypatch) -> None:
    fake, calls, built = make_fake(json.dumps(OK_PAYLOAD))
    monkeypatch.setattr(image_describe, "AsyncOpenAI", fake)

    result = await describe_image(_png(), "image/png")

    assert result["prompt"].startswith("a red apple")
    assert result["zh"] == "白桌上的一颗红苹果"
    # 标签去 # 、转小写、去重，且不超过 8 个
    assert result["tags"] == ["still life", "minimal", "product photo"]
    assert result["model"] == "fake-vision"
    assert result["latency_ms"] >= 0

    call = calls[0]
    # 模型名由绑定的部署决定，业务代码里只出现能力别名（BR-100），且走 JSON mode
    assert call["model"] == CHAT_MODEL
    assert call["response_format"] == {"type": "json_object"}
    # 视觉输入是 content 块：一段文字 + 一个 data URL
    blocks = call["messages"][1]["content"]
    assert blocks[0]["type"] == "text"
    assert blocks[1]["type"] == "image_url"
    assert _data_url(call).startswith("data:image/png;base64,")
    # 客户端指向绑定部署的端点
    assert str(built[0]["base_url"]).endswith("/v1")


async def test_describe_style_mode_uses_style_system(monkeypatch) -> None:
    fake, calls, _ = make_fake(json.dumps(OK_PAYLOAD))
    monkeypatch.setattr(image_describe, "AsyncOpenAI", fake)

    await describe_image(_png(), "image/png", mode="style")

    system = calls[0]["messages"][0]["content"]
    assert system == image_describe.DESCRIBE_SYSTEM["style"]
    assert "不要描述图上出现的文字内容" in system


async def test_unknown_mode_rejected(monkeypatch) -> None:
    fake, _, built = make_fake(json.dumps(OK_PAYLOAD))
    monkeypatch.setattr(image_describe, "AsyncOpenAI", fake)

    with pytest.raises(DescribeError) as info:
        await describe_image(_png(), "image/png", mode="whatever")
    assert info.value.kind == "api"
    assert built == []


# ---- ② 模型返回非 JSON ----


async def test_non_json_response_raises_api(monkeypatch) -> None:
    fake, _, _ = make_fake("抱歉，我看不了这张图。")
    monkeypatch.setattr(image_describe, "AsyncOpenAI", fake)

    with pytest.raises(DescribeError) as info:
        await describe_image(_png(), "image/png")
    assert info.value.kind == "api"
    assert "非 JSON" in str(info.value) or "没有返回 JSON" in str(info.value)


async def test_json_wrapped_in_prose_still_parses(monkeypatch) -> None:
    fake, _, _ = make_fake(f"```json\n{json.dumps(OK_PAYLOAD)}\n```")
    monkeypatch.setattr(image_describe, "AsyncOpenAI", fake)

    result = await describe_image(_png(), "image/png")
    assert result["prompt"].startswith("a red apple")


async def test_empty_prompt_field_raises(monkeypatch) -> None:
    fake, _, _ = make_fake(json.dumps({"prompt": "  ", "zh": "x", "tags": []}))
    monkeypatch.setattr(image_describe, "AsyncOpenAI", fake)

    with pytest.raises(DescribeError) as info:
        await describe_image(_png(), "image/png")
    assert info.value.kind == "api"


# ---- ③ 空字节 · ④ 非图片 mime：都不该建连接 ----


async def test_empty_bytes_rejected_before_call(monkeypatch) -> None:
    fake, _, built = make_fake(json.dumps(OK_PAYLOAD))
    monkeypatch.setattr(image_describe, "AsyncOpenAI", fake)

    with pytest.raises(DescribeError) as info:
        await describe_image(b"", "image/png")
    assert info.value.kind == "api"
    assert "没有收到图片数据" in str(info.value)
    assert built == []


@pytest.mark.parametrize("mime", ["application/pdf", "", "text/plain"])
async def test_non_image_mime_rejected(monkeypatch, mime: str) -> None:
    fake, _, built = make_fake(json.dumps(OK_PAYLOAD))
    monkeypatch.setattr(image_describe, "AsyncOpenAI", fake)

    with pytest.raises(DescribeError) as info:
        await describe_image(_png(), mime)
    assert info.value.kind == "api"
    assert built == []


# ---- ⑤ 大图先压 ----


async def test_oversized_image_is_downscaled(monkeypatch) -> None:
    from PIL import Image

    raw = _big_bmp()
    assert len(raw) > image_describe.MAX_INLINE_BYTES

    fake, calls, _ = make_fake(json.dumps(OK_PAYLOAD))
    monkeypatch.setattr(image_describe, "AsyncOpenAI", fake)

    await describe_image(raw, "image/bmp")

    url = _data_url(calls[0])
    assert url.startswith("data:image/jpeg;base64,")
    sent = base64.b64decode(url.split(",", 1)[1])
    assert len(sent) < len(raw)
    assert max(Image.open(io.BytesIO(sent)).size) == image_describe.COMPRESS_EDGE


async def test_small_image_sent_untouched(monkeypatch) -> None:
    raw = _png()
    fake, calls, _ = make_fake(json.dumps(OK_PAYLOAD))
    monkeypatch.setattr(image_describe, "AsyncOpenAI", fake)

    await describe_image(raw, "image/png")

    url = _data_url(calls[0])
    assert base64.b64decode(url.split(",", 1)[1]) == raw


async def test_oversized_but_undecodable_raises(monkeypatch) -> None:
    fake, _, built = make_fake(json.dumps(OK_PAYLOAD))
    monkeypatch.setattr(image_describe, "AsyncOpenAI", fake)

    with pytest.raises(DescribeError) as info:
        await describe_image(b"\x00" * (image_describe.MAX_INLINE_BYTES + 1), "image/png")
    assert info.value.kind == "api"
    assert "无法解析" in str(info.value)
    assert built == []


# ---- 上游异常分型 ----


async def test_missing_alias_maps_to_binding(monkeypatch) -> None:
    response = httpx.Response(404, request=httpx.Request("POST", "http://gw/v1/chat"))
    fake, _ = make_raising(APIStatusError("no such model", response=response, body=None))
    monkeypatch.setattr(image_describe, "AsyncOpenAI", fake)

    with pytest.raises(DescribeError) as info:
        await describe_image(_png(), "image/png")
    assert info.value.kind == "binding"
    assert "explain-standard" in str(info.value)


async def test_model_without_vision_maps_to_binding(monkeypatch) -> None:
    response = httpx.Response(400, request=httpx.Request("POST", "http://gw/v1/chat"))
    fake, _ = make_raising(
        APIStatusError("this model does not support image input", response=response, body=None)
    )
    monkeypatch.setattr(image_describe, "AsyncOpenAI", fake)

    with pytest.raises(DescribeError) as info:
        await describe_image(_png(), "image/png")
    assert info.value.kind == "binding"


async def test_auth_failure_maps_to_auth(monkeypatch) -> None:
    response = httpx.Response(401, request=httpx.Request("POST", "http://gw/v1/chat"))
    fake, _ = make_raising(APIStatusError("bad key", response=response, body=None))
    monkeypatch.setattr(image_describe, "AsyncOpenAI", fake)

    with pytest.raises(DescribeError) as info:
        await describe_image(_png(), "image/png")
    assert info.value.kind == "auth"


# ---- 提示词扩写 ----


async def test_enhance_prompt_ok(monkeypatch) -> None:
    fake, calls, _ = make_fake(json.dumps({"prompt": "a cosy reading nook, warm light"}))
    monkeypatch.setattr(image_describe, "AsyncOpenAI", fake)

    result = await enhance_prompt("画个看书的角落", app_label="文生图", style_hint="扁平插画")

    assert result["prompt"] == "a cosy reading nook, warm light"
    assert result["model"] == "fake-vision"
    assert result["latency_ms"] >= 0

    payload = json.loads(calls[0]["messages"][1]["content"])
    assert payload["用户输入"] == "画个看书的角落"
    assert payload["用途"] == "文生图"
    assert payload["风格倾向"] == "扁平插画"
    # 纯文本请求，不该混进 content 块
    assert isinstance(calls[0]["messages"][1]["content"], str)


async def test_enhance_prompt_omits_blank_style(monkeypatch) -> None:
    fake, calls, _ = make_fake(json.dumps({"prompt": "x"}))
    monkeypatch.setattr(image_describe, "AsyncOpenAI", fake)

    await enhance_prompt("一只猫", app_label="文生图")
    assert "风格倾向" not in json.loads(calls[0]["messages"][1]["content"])


@pytest.mark.parametrize("text", ["", "   ", "\n"])
async def test_enhance_prompt_rejects_empty(monkeypatch, text: str) -> None:
    fake, _, built = make_fake(json.dumps({"prompt": "x"}))
    monkeypatch.setattr(image_describe, "AsyncOpenAI", fake)

    with pytest.raises(DescribeError) as info:
        await enhance_prompt(text, app_label="文生图")
    assert info.value.kind == "api"
    assert built == []

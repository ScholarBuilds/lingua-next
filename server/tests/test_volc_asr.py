"""火山极速版 ASR provider：协议解析、音频编码、重试与选路。

全程不发网络请求——`recognize` 用假的 aiohttp 会话打桩。真实链路的实测数字
记在 `domain/volc_asr` 的模块文档与 `scripts/compare_asr.py` 里。
"""

from __future__ import annotations

import json
from typing import Any

import aiohttp
import pytest

from domain import volc_asr
from domain.volc_asr import (
    FLASH_RESOURCE_ID,
    VOLC_ASR_PLUGIN_ID,
    VolcAsrError,
    cues_from_result,
    prepare_volc_asr_route,
    recognize,
    transcription_options,
)


def _result(utterances: list[dict]) -> dict[str, Any]:
    return {"audio_info": {"duration": 1000}, "result": {"text": "x", "utterances": utterances}}


class _FakeResponse:
    def __init__(self, status: str, body: dict | str) -> None:
        self.headers = {"X-Api-Status-Code": status, "X-Api-Message": "OK"}
        self._body = body if isinstance(body, str) else json.dumps(body)

    async def text(self) -> str:
        return self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeSession:
    """按脚本逐次给出响应；元素是异常就抛，用来演网络失败。"""

    def __init__(self, script: list[Any]) -> None:
        self.script = list(script)
        self.calls: list[dict] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def post(self, url, *, data, headers, proxy):
        self.calls.append({"url": url, "headers": dict(headers), "proxy": proxy, "data": data})
        nxt = self.script.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


@pytest.fixture
def fake_http(monkeypatch):
    holder: dict[str, _FakeSession] = {}

    def install(script: list[Any]) -> _FakeSession:
        session = _FakeSession(script)
        monkeypatch.setattr(volc_asr.aiohttp, "ClientSession", lambda **_kw: session)
        monkeypatch.setattr(volc_asr.asyncio, "sleep", _noop)
        holder["session"] = session
        return session

    async def _noop(_seconds):
        return None

    return install


# ──────────────────────────── 协议解析 ────────────────────────────


def test_空白分隔_token_不进词表():
    """words 里每两个词之间夹一条 text=' ' 且时间戳为 -1 的分隔项。

    漏滤的话词数虚高一倍，而 -1 会让词级高亮跳回时间轴原点。
    """
    cues = cues_from_result(
        _result([
            {
                "start_time": 0,
                "end_time": 900,
                "text": "hi there",
                "words": [
                    {"start_time": 0, "end_time": 200, "text": "hi"},
                    {"start_time": -1, "end_time": -1, "text": " "},
                    {"start_time": 300, "end_time": 900, "text": "there"},
                ],
            }
        ])
    )
    assert [w[2] for w in cues[0].words] == ["hi", "there"]
    assert all(w[0] >= 0 for w in cues[0].words)


def test_空文本的_utterance_不产生_cue():
    cues = cues_from_result(
        _result([
            {"start_time": 0, "end_time": 10, "text": "   ", "words": []},
            {"start_time": 20, "end_time": 90, "text": "ok", "words": []},
        ])
    )
    assert [c.text for c in cues] == ["ok"]


def test_没有词级时间戳时_words_是_None():
    """Cue.words 为空列表和 None 在下游不等价：空列表会被当成「对齐过但一个词都没有」。"""
    cues = cues_from_result(_result([{"start_time": 0, "end_time": 5, "text": "ok", "words": []}]))
    assert cues[0].words is None


def test_空结果不炸():
    assert cues_from_result({}) == []
    assert cues_from_result({"result": {}}) == []


# ──────────────────────────── HTTP 协议 ────────────────────────────


@pytest.mark.anyio
async def test_状态码取自响应头而不是_body(fake_http):
    """TTS 的状态在 NDJSON 每行里，ASR 的在 header——照抄 TTS 会把成功当失败。"""
    fake_http([_FakeResponse("20000000", _result([]))])
    assert await recognize(b"x", app_id="a", access_key="k") == _result([])


@pytest.mark.anyio
async def test_上游拒绝直接抛_不重试(fake_http):
    """参数错/未授权/超限重试没有意义，重试只会白烧配额。"""
    session = fake_http([_FakeResponse("45000000", "")])
    with pytest.raises(VolcAsrError, match="45000000"):
        await recognize(b"x", app_id="a", access_key="k")
    assert len(session.calls) == 1


@pytest.mark.anyio
async def test_网络超时会重试并换_request_id(fake_http):
    """上游按 request id 去重，复用会把重试当成同一次请求原样返回。"""
    session = fake_http([
        TimeoutError("connect"),
        aiohttp.ClientError("reset"),
        _FakeResponse("20000000", _result([])),
    ])
    await recognize(b"x", app_id="a", access_key="k")
    ids = [c["headers"]["X-Api-Request-Id"] for c in session.calls]
    assert len(ids) == 3
    assert len(set(ids)) == 3


@pytest.mark.anyio
async def test_重试用尽后抛(fake_http):
    fake_http([TimeoutError("t")] * 3)
    with pytest.raises(VolcAsrError, match="三次重试"):
        await recognize(b"x", app_id="a", access_key="k")


@pytest.mark.anyio
async def test_缺凭据不发请求(fake_http):
    session = fake_http([_FakeResponse("20000000", _result([]))])
    with pytest.raises(VolcAsrError, match="凭据"):
        await recognize(b"x", app_id="", access_key="k")
    assert session.calls == []


@pytest.mark.anyio
async def test_语音默认不继承环境代理(fake_http, monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:7890")
    session = fake_http([_FakeResponse("20000000", _result([]))])
    await recognize(b"x", app_id="a", access_key="k")
    assert session.calls[0]["proxy"] is None


@pytest.mark.anyio
async def test_请求体带上标点开关与_opus_格式(fake_http):
    session = fake_http([_FakeResponse("20000000", _result([]))])
    await recognize(b"opus", app_id="a", access_key="k")
    body = json.loads(session.calls[0]["data"])
    assert body["request"]["enable_punc"] is True
    assert body["request"]["show_utterances"] is True
    assert body["audio"]["rate"] == 16000
    assert body["audio"]["format"] == volc_asr.AUDIO_FORMAT
    assert session.calls[0]["headers"]["X-Api-Resource-Id"] == FLASH_RESOURCE_ID


@pytest.mark.anyio
async def test_不收_brotli(fake_http):
    """上游的错误页会带 `content-encoding: br`，而 aiohttp 没装 brotli 解码器时
    `resp.text()` 抛 ClientPayloadError——那是 ClientError 的子类，会被重试循环
    白白吃掉三次，最后报一个与真实原因无关的错（本机实测复现）。
    """
    session = fake_http([_FakeResponse("20000000", _result([]))])
    await recognize(b"opus", app_id="a", access_key="k")
    assert session.calls[0]["headers"]["Accept-Encoding"] == "identity"


# ──────────────────────────── 音频编码 ────────────────────────────


def test_无音轨返回_None_而不是抛(tmp_path, monkeypatch):
    """本地 whisper 对无音轨样片是 `return [], duration`，火山这条要对齐。

    抛异常的话 `pipeline.step()` 会重抛，整片入库直接 failed，
    而 whisper 那条路是照常跑完、体检记 no_track 判 degraded——
    同一个输入两条路结果不同是最难查的那种差异。
    """

    class _Stream:
        type = "video"

    class _Container:
        streams = [_Stream()]
        duration = 3_000_000

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    import av

    monkeypatch.setattr(av, "open", lambda _p: _Container())
    assert volc_asr.probe_audio("x.mp4") is None


def test_转码失败带上_ffmpeg_的原因(monkeypatch):
    class _Proc:
        returncode = 1
        stdout = b""
        stderr = b"Invalid data found when processing input"

    monkeypatch.setattr(volc_asr.shutil, "which", lambda _n: "/usr/bin/ffmpeg")
    monkeypatch.setattr(volc_asr.subprocess, "run", lambda *a, **k: _Proc())
    with pytest.raises(VolcAsrError, match="Invalid data"):
        volc_asr.opus_bytes("broken.mp4")


def test_超过上游大小上限时不发请求(monkeypatch):
    """100MB 是上游的硬上限。发出去挨拒等于白烧一次上传和几十秒。

    实测 58.8MB 的无损 WAV 已经会 504 网关超时，所以这条闸门要在客户端就拦。
    """

    class _Proc:
        returncode = 0
        stdout = b"x" * (volc_asr.MAX_AUDIO_BYTES + 1)
        stderr = b""

    monkeypatch.setattr(volc_asr.shutil, "which", lambda _n: "/usr/bin/ffmpeg")
    monkeypatch.setattr(volc_asr.subprocess, "run", lambda *a, **k: _Proc())
    with pytest.raises(VolcAsrError, match="上限"):
        volc_asr.opus_bytes("huge.mp4")


def test_缺_ffmpeg_报得明白(monkeypatch):
    monkeypatch.setattr(volc_asr.shutil, "which", lambda _n: None)
    with pytest.raises(VolcAsrError, match="ffmpeg"):
        volc_asr.opus_bytes("x.mp4")


# ──────────────────────────── 选路 ────────────────────────────


def test_路由快照带上游真名而不是能力名():
    """核心原则 6：UI 上标「模型」的位置显示上游真名。"""
    route = prepare_volc_asr_route(
        {"app_id": "1", "access_key": "k"}, capability="video.transcribe"
    )
    view = route.snapshot.view()
    assert view["plugin_id"] == VOLC_ASR_PLUGIN_ID
    assert view["model"] == FLASH_RESOURCE_ID
    assert view["operation"] == "asr.transcribe"


def test_凭据不进脱敏快照():
    route = prepare_volc_asr_route({"app_id": "1", "access_key": "秘密"}, capability="c")
    assert "秘密" not in json.dumps(route.snapshot.view(), ensure_ascii=False)
    assert route.credentials["access_key"] == "秘密"


# ──────────────────────────── 归一化开关 ────────────────────────────


@pytest.mark.parametrize(
    "capability",
    ["video.transcribe", "shadowing.asr", "video.shadow.asr", "talk.turn.asr", "repair.voice.asr"],
)
def test_所有用途一律关掉_itn_与_ddc(capability):
    """曾经按用途分档：字幕开 ITN、跟读关 ITN。那是错的——**跟读比对的参考文本就是字幕**
    （`shadowing.py` 的 `diff_words(reference, transcript)`，reference 取自 subtitle_sentence）。
    一侧写 `2 minutes` 一侧写 `two minutes`，逐词比对把读对的判成读错，
    而两边单独看都「正常」。同一个文本的生产端与消费端用不同归一化，必错。
    """
    options = transcription_options(capability)
    assert options["enable_itn"] is False
    assert options["enable_ddc"] is False
    assert options["enable_punc"] is True


def test_开关经_protocol_options_下发到路由():
    route = prepare_volc_asr_route({"app_id": "1", "access_key": "k"}, capability="shadowing.asr")
    assert route.protocol_options["enable_itn"] is False


def test_插件目录一启动就看得见_volc_asr():
    """volc_asr 只在选路函数体内惰性 import 的话，第一次真走火山之前插件目录里
    没有 volc-asr 这一项，看起来像「声明了但没接线」，而且 API 与 worker 两个进程
    被点亮的时机还不一样。靠 transcribe.py 末尾的 eager import 兜住。
    """
    import domain.transcribe  # noqa: F401
    from domain.model_plugins import wired_operations_index

    assert "asr.transcribe" in wired_operations_index().get(VOLC_ASR_PLUGIN_ID, frozenset())


# ──────────────────────────── 与火山 TTS 共存 ────────────────────────────


@pytest.mark.parametrize(
    ("operation", "expected"),
    [
        ("audio.synthesize", "volcengine"),
        ("realtime.session", "volcengine"),
        ("asr.transcribe", VOLC_ASR_PLUGIN_ID),
    ],
)
def test_同一个凭据类型按操作分给不同插件(operation, expected):
    """火山的 TTS、实时语音、ASR 共用一把 key，凭据类型都是 volc_speech。"""
    import app.main  # noqa: F401  触发全部插件注册
    from domain.model_plugins import adapter_for_provider

    assert adapter_for_provider("volc_speech", operation=operation) == expected


def test_不带操作问_volc_speech_仍然得到_volcengine():
    """`adapter_for_provider(provider_type)` 不带 operation 时按 (-priority, id) 取第一个。

    volc-asr 与 volcengine 曾经同为 priority 70，而 "volc-asr" < "volcengine"——
    于是 `/tts` 的两条分支解析到一个没声明 audio.synthesize 的插件，当场 503，
    **且与配没配 ASR 凭据无关**。调用侧补 operation 是正解，压低优先级是第二道：
    让不带 operation 的问法保持接 ASR 之前的答案。
    """
    import app.main  # noqa: F401
    from domain.model_plugins import adapter_for_provider, get_model_plugin

    assert adapter_for_provider("volc_speech") == "volcengine"
    asr = get_model_plugin(VOLC_ASR_PLUGIN_ID)
    tts = get_model_plugin("volcengine")
    assert "volc_speech" in asr.provider_types and "volc_speech" in tts.provider_types


# ──────────────────────────── 运行时回落 ────────────────────────────


class _StubProvider:
    """按脚本回应：元素是异常就抛，否则当结果返回。"""

    def __init__(self, script: list[Any]) -> None:
        self.script = list(script)
        self.calls = 0

    async def transcribe(self, route, *, path, word_timestamps, on_progress):
        self.calls += 1
        nxt = self.script.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


@pytest.fixture
def two_providers():
    """同时替换火山与本地两个 Provider，返回 (volc_stub, local_stub) 与建路由的函数。

    只替换 Provider 而不是 patch `PreparedAsrRoute.transcribe`——后者是两条路由共用的
    同一个类，打在类上会把回落那条路一起打坏（第一版就是这么写的，测试红了才发现）。
    """
    from domain import transcribe as tr

    made: list = []

    def install(volc_script: list[Any], local_script: list[Any]):
        volc = _StubProvider(volc_script)
        local = _StubProvider(local_script)
        made.append(
            tr.register_asr_route_provider(
                plugin_id=VOLC_ASR_PLUGIN_ID, provider=volc, replace=True
            )
        )
        made.append(
            tr.register_asr_route_provider(
                plugin_id=tr.ASR_PLUGIN_ID, provider=local, replace=True
            )
        )
        return volc, local

    yield install
    for handle in made:
        handle.dispose()


@pytest.mark.anyio
async def test_火山失败时降级到本地_whisper(two_providers):
    """选路期回落只覆盖「凭据读不出来」。一旦选中火山，调用失败就没有第二条路了——
    而失败的现实来源恰恰不在凭据上：免费额度用尽、账号只开了 TTS 没开录音文件识别。

    后果分两类：worker 里 `pipeline.step()` 重抛 → 整条视频管线 failed、
    `video.status='failed'`，而同一条管线的 punctuate 与 align 两步都是「失败即降级」；
    路由里 `repair.py` 直接 500。本地 whisper 一直装着，让它兜住这一次。
    """
    from domain import transcribe as tr

    volc, local = two_providers(
        [VolcAsrError("火山返回 45000000 未授权")],
        [tr.AsrTranscript(text="本地兜住了", cues=[], duration_s=1.0)],
    )
    route = prepare_volc_asr_route(
        {"app_id": "1", "access_key": "k"}, capability="video.transcribe"
    )
    got = await tr.transcribe_with_fallback(route, path="x.mp4", capability="video.transcribe")
    assert got.text == "本地兜住了"
    assert (volc.calls, local.calls) == (1, 1)


@pytest.mark.anyio
async def test_无音轨不触发降级(two_providers):
    """换个引擎也救不了，重跑一遍只是白加载一次 2.9GB 模型。"""
    from domain import transcribe as tr

    volc, local = two_providers(
        [volc_asr.NoAudioTrack("没有音轨")],
        [tr.AsrTranscript(text="不该被调到")],
    )
    route = prepare_volc_asr_route({"app_id": "1", "access_key": "k"}, capability="c")
    with pytest.raises(volc_asr.NoAudioTrack):
        await tr.transcribe_with_fallback(route, path="x.mp4", capability="c")
    assert (volc.calls, local.calls) == (1, 0)


@pytest.mark.anyio
async def test_本地路由不绕降级逻辑(two_providers):
    """已经在本地了就没有第二条路可退，别多包一层 try。"""
    from domain import transcribe as tr

    _volc, local = two_providers([], [tr.AsrTranscript(text="ok")])
    route = tr.prepare_local_asr_route("tiny", capability="c")
    got = await tr.transcribe_with_fallback(route, path="x.mp4", capability="c")
    assert got.text == "ok" and local.calls == 1


@pytest.mark.anyio
async def test_超时按音频体积给而不是一个统一大数(fake_http, monkeypatch):
    """跟读录音是几秒的片子，给它 600s × 3 次重试 = 最坏 30 分钟。

    而这四条短音频链路是同步 HTTP handler，整段时间都占着请求作用域的数据库连接
    （池上限 15）。小 payload 的预算必须明显小于大 payload 的。
    """
    seen: list[float] = []

    class _T:
        def __init__(self, *, total, connect, sock_connect):
            seen.append(total)

    monkeypatch.setattr(volc_asr.aiohttp, "ClientTimeout", _T)
    fake_http([_FakeResponse("20000000", _result([]))])
    await recognize(b"x" * 50_000, app_id="a", access_key="k")
    fake_http([_FakeResponse("20000000", _result([]))])
    await recognize(b"x" * 6_000_000, app_id="a", access_key="k")

    small, large = seen
    assert small < large
    assert small <= 65, "几十 KB 的录音不该拿到分钟级预算"
    assert large >= 120, "5MB 视频音频要留够余量"


@pytest.mark.anyio
async def test_请求路径回落到小模型而不是_large_v3(two_providers, monkeypatch):
    """四条请求路径（跟读/陪练/语音改写/跟读比对）跑在同步 HTTP handler 里，
    回落会把模型加载进 **API 进程**并常驻（`_models` 是进程级单例）。

    实测 large-v3 峰值 3190MB、常驻 2636MB——一个 Web 服务因为 ASR 额度用尽
    就永久多占 2.6GB，而这四条处理的都是几秒的短音频。
    视频管线在 worker 里跑，不受这条影响，仍用 large-v3。
    """
    from domain import transcribe as tr

    _volc, local = two_providers(
        [VolcAsrError("火山返回 45000000 未授权")],
        [tr.AsrTranscript(text="小模型兜住了")],
    )
    seen: list[str] = []
    real = tr.prepare_local_asr_route

    def spy(model, *, capability):
        seen.append(model)
        return real(model, capability=capability)

    monkeypatch.setattr(tr, "prepare_local_asr_route", spy)
    route = prepare_volc_asr_route({"app_id": "1", "access_key": "k"}, capability="shadowing.asr")
    await tr.transcribe_with_fallback(
        route, path="x.webm", capability="shadowing.asr", fallback_model="small"
    )
    assert seen == ["small"], f"回落用了 {seen}，不该是 large-v3"
    assert local.calls == 1


def test_四条请求路径的_helper_默认取小模型配置():
    """`transcribe_audio_logged` 是那四条的唯一入口，它必须自己钉死小模型——
    靠调用方逐个传，漏一处就是一个 2.6GB 的定时炸弹，而且不报错。
    """
    import inspect

    from app.config import get_settings
    from domain import transcribe as tr

    src = inspect.getsource(tr.transcribe_audio_logged)
    assert "whisper_fallback_model" in src
    assert get_settings().whisper_fallback_model == "small"

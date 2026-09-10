"""火山豆包端到端实时语音：二进制帧协议编解码 + aiohttp WebSocket 客户端（模块 06）。

协议为 openspeech v3 二进制帧（4 字节头 + 事件号 + 可选 session id + payload），
事件定义见官方文档《端到端实时语音大模型》。websockets 库解析该服务重复的
server-timing 响应头会崩，故走 aiohttp。凭证只在服务端使用，不下发浏览器。
"""

from __future__ import annotations

import gzip
import json
import struct
import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol

import aiohttp

from domain.credentials import CredentialError, ResolvedBinding, resolve_binding
from domain.kernel.capability_seam import (
    CapabilitySeam,
    PreparedRoute,
    RouteRequest,
    RouteSnapshot,
    SeamError,
)
from domain.model_catalog import ModelCatalogError, ResolvedModelRoute, resolve_model_route
from domain.model_plugins import adapter_for_provider
from domain.network_policy import speech_proxy
from domain.plugin_runtime import RegistrationHandle

DIALOG_URL = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue"
RESOURCE_ID = "volc.speech.dialog"
APP_KEY = "PlgvMymc7f3tQnJ6"  # 官方文档固定值

# 消息类型（byte1 高 4 位）
MSG_FULL_CLIENT = 0b0001
MSG_AUDIO_ONLY_CLIENT = 0b0010
MSG_FULL_SERVER = 0b1001
MSG_AUDIO_ONLY_SERVER = 0b1011  # 官方叫 SERVER_ACK，载荷为 TTS 音频
MSG_ERROR = 0b1111

FLAG_WITH_EVENT = 0b0100
SERIAL_RAW = 0b0000
SERIAL_JSON = 0b0001
COMPRESS_NONE = 0b0000
COMPRESS_GZIP = 0b0001

# 客户端事件
EVENT_START_CONNECTION = 1
EVENT_FINISH_CONNECTION = 2
EVENT_START_SESSION = 100
EVENT_FINISH_SESSION = 102
EVENT_TASK_REQUEST = 200
EVENT_SAY_HELLO = 300
# ChatTTSText：让本会话念我给的文本（三包 start / content / end），只能在 459 ASREnded 之后发；
# 播报中用户开口导致中断时官方明说不必补 end 包
EVENT_CHAT_TTS_TEXT = 500
EVENT_CHAT_TEXT_QUERY = 501  # 用户侧文本 query：模型基于会话人设直接生成语音回复
EVENT_CLIENT_INTERRUPT = 515  # 只在 push_to_talk 模式下有效

# 服务端事件
EVENT_CONNECTION_STARTED = 50
EVENT_CONNECTION_FAILED = 51
EVENT_SESSION_STARTED = 150
EVENT_SESSION_FINISHED = 152
EVENT_SESSION_FAILED = 153
EVENT_USAGE_RESPONSE = 154
EVENT_TTS_SENTENCE_START = 350
EVENT_TTS_RESPONSE = 352
EVENT_TTS_ENDED = 359
EVENT_ASR_INFO = 450
EVENT_ASR_RESPONSE = 451
EVENT_ASR_ENDED = 459
EVENT_CHAT_RESPONSE = 550
EVENT_CHAT_ENDED = 559


class VolcRealtimeError(RuntimeError):
    """握手/会话建立失败或服务端错误帧。"""


@dataclass
class ServerEvent:
    """解析后的服务端帧：音频帧 audio 非空，事件帧 payload 为 JSON 对象。"""

    event: int | None = None
    payload: dict | None = None
    audio: bytes = b""
    error_code: int | None = None
    session_id: str = ""

    @property
    def is_audio(self) -> bool:
        return bool(self.audio)


def _header(msg_type: int, serial: int, compress: int) -> bytearray:
    return bytearray(
        (0x11, (msg_type << 4) | FLAG_WITH_EVENT, (serial << 4) | compress, 0x00)
    )


def build_event_frame(event: int, payload: dict | None = None, session_id: str = "") -> bytes:
    """JSON 载荷客户端事件帧；连接类事件不带 session_id。"""
    body = gzip.compress(json.dumps(payload or {}, ensure_ascii=False).encode())
    frame = _header(MSG_FULL_CLIENT, SERIAL_JSON, COMPRESS_GZIP)
    frame += struct.pack(">i", event)
    if session_id:
        sid = session_id.encode()
        frame += struct.pack(">I", len(sid)) + sid
    frame += struct.pack(">I", len(body)) + body
    return bytes(frame)


def build_audio_frame(session_id: str, audio: bytes, *, compress: bool = True) -> bytes:
    """TaskRequest 上行音频帧：PCM 16k 单声道 int16 小端。

    PCM 几乎压不动，调用方可关闭 gzip 省 CPU（头字节的 compress 位要跟着改）。
    """
    body = gzip.compress(audio) if compress else audio
    compression = COMPRESS_GZIP if compress else COMPRESS_NONE
    frame = _header(MSG_AUDIO_ONLY_CLIENT, SERIAL_RAW, compression)
    frame += struct.pack(">i", EVENT_TASK_REQUEST)
    sid = session_id.encode()
    frame += struct.pack(">I", len(sid)) + sid
    frame += struct.pack(">I", len(body)) + body
    return bytes(frame)


def parse_server_frame(data: bytes) -> ServerEvent:
    """服务端帧 → ServerEvent；帧结构见官方 demo protocol.parse_response。"""
    if len(data) < 8:
        return ServerEvent()
    header_size = data[0] & 0x0F
    msg_type = data[1] >> 4
    flags = data[1] & 0x0F
    serial = data[2] >> 4
    compress = data[2] & 0x0F
    off = header_size * 4
    ev = ServerEvent()

    if msg_type == MSG_ERROR:
        ev.error_code = struct.unpack(">I", data[off:off + 4])[0]
        size = struct.unpack(">I", data[off + 4:off + 8])[0]
        body = data[off + 8:off + 8 + size]
        if compress == COMPRESS_GZIP:
            body = gzip.decompress(body)
        try:
            ev.payload = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            ev.payload = {"raw": body[:200].decode(errors="replace")}
        return ev

    if msg_type not in (MSG_FULL_SERVER, MSG_AUDIO_ONLY_SERVER):
        return ev
    if flags & 0b0001 or flags & 0b0010:  # sequence 字段（对话流通常不带）
        off += 4
    if flags & FLAG_WITH_EVENT:
        ev.event = struct.unpack(">i", data[off:off + 4])[0]
        off += 4
    sid_len = struct.unpack(">I", data[off:off + 4])[0]
    ev.session_id = data[off + 4:off + 4 + sid_len].decode(errors="replace")
    off += 4 + sid_len
    size = struct.unpack(">I", data[off:off + 4])[0]
    body = data[off + 4:off + 4 + size]
    if compress == COMPRESS_GZIP:
        body = gzip.decompress(body)
    if msg_type == MSG_AUDIO_ONLY_SERVER:
        ev.audio = bytes(body)
    elif serial == SERIAL_JSON:
        try:
            ev.payload = json.loads(body) if body else {}
        except (ValueError, UnicodeDecodeError):
            ev.payload = {}
    return ev


def extract_asr_text(payload: dict | None) -> tuple[str, bool]:
    """ASRResponse(451) → (识别文本, 是否中间结果)。"""
    results = (payload or {}).get("results") or []
    if not results or not isinstance(results[0], dict):
        return "", True
    text = str(results[0].get("text") or "").strip()
    interim = bool(results[0].get("is_interim", False))
    return text, interim


def build_session_config(
    system_role: str,
    speaker: str = "zh_female_vv_jupiter_bigtts",
    *,
    model: str,
    end_smooth_window_ms: int = 800,
    input_mod: str | None = None,
) -> dict:
    """StartSession 载荷：下行 PCM float32 24k，人设走 system_role。

    ``dialog.model`` 现已必传（1.2.1.1 = O2.0）；``end_smooth_window_ms`` 是判停静音窗，
    ``input_mod`` 留给 push_to_talk 之类的输入模式，默认不写。
    """
    config: dict[str, Any] = {
        "asr": {"extra": {"end_smooth_window_ms": end_smooth_window_ms}},
        "tts": {
            "speaker": speaker,
            "audio_config": {"channel": 1, "format": "pcm", "sample_rate": 24000},
        },
        "dialog": {
            "bot_name": "Lingua",
            "system_role": system_role,
            "speaking_style": "口语化、简短自然，每次回复不超过三句话。",
            "model": model,
            "extra": {"strict_audit": False},
        },
    }
    if input_mod:
        config["dialog"]["extra"]["input_mod"] = input_mod
    return config


@dataclass
class VolcRealtimeClient:
    """一条火山连接承载一个对话 session，用完即弃。"""

    app_id: str
    access_key: str
    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    compress_audio: bool = True
    _http: aiohttp.ClientSession | None = None
    _ws: aiohttp.ClientWebSocketResponse | None = None

    async def connect(self, timeout: float = 15.0) -> None:
        headers = {
            "X-Api-App-ID": self.app_id,
            "X-Api-Access-Key": self.access_key,
            "X-Api-Resource-Id": RESOURCE_ID,
            "X-Api-App-Key": APP_KEY,
            "X-Api-Connect-Id": str(uuid.uuid4()),
        }
        proxy = await speech_proxy()
        self._http = aiohttp.ClientSession(
            trust_env=False,
            timeout=aiohttp.ClientTimeout(total=None, connect=timeout, sock_connect=timeout)
        )
        try:
            self._ws = await self._http.ws_connect(
                DIALOG_URL, headers=headers, max_msg_size=16 * 1024 * 1024,
                proxy=proxy,
            )
        except aiohttp.ClientError as exc:
            await self.close()
            raise VolcRealtimeError(f"火山握手失败：{exc}") from exc
        await self._ws.send_bytes(build_event_frame(EVENT_START_CONNECTION))
        ev = await self.receive(timeout)
        if ev is None or ev.event != EVENT_CONNECTION_STARTED:
            await self.close()
            raise VolcRealtimeError(f"StartConnection 未确认：{ev}")

    async def start_session(self, config: dict, timeout: float = 15.0) -> None:
        assert self._ws is not None
        await self._ws.send_bytes(
            build_event_frame(EVENT_START_SESSION, config, self.session_id)
        )
        ev = await self.receive(timeout)
        if ev is None or ev.event != EVENT_SESSION_STARTED:
            detail = (ev.payload or {}).get("error") if ev else None
            raise VolcRealtimeError(f"StartSession 失败：{detail or ev}")

    async def say_hello(self, content: str) -> None:
        assert self._ws is not None
        await self._ws.send_bytes(
            build_event_frame(EVENT_SAY_HELLO, {"content": content}, self.session_id)
        )

    async def chat_text_query(self, content: str) -> None:
        """ChatTextQuery(501)：文本代替语音输入，阅读器点句上下文注入走此事件。"""
        assert self._ws is not None
        await self._ws.send_bytes(
            build_event_frame(EVENT_CHAT_TEXT_QUERY, {"content": content}, self.session_id)
        )

    async def chat_tts_text(self, content: str, *, start: bool = False, end: bool = False) -> None:
        """ChatTTSText(500)：start 包带首句、中间包只带 content、end 包收尾。"""
        assert self._ws is not None
        payload: dict = {}
        if start:
            payload["start"] = True
        if end:
            payload["end"] = True
        if content:
            payload["content"] = content
        await self._ws.send_bytes(
            build_event_frame(EVENT_CHAT_TTS_TEXT, payload, self.session_id)
        )

    async def client_interrupt(self) -> None:
        """ClientInterrupt(515)：只对 push_to_talk 模式有效，普通对话模式靠 450 自动打断。"""
        assert self._ws is not None
        await self._ws.send_bytes(
            build_event_frame(EVENT_CLIENT_INTERRUPT, {}, self.session_id)
        )

    async def send_audio(self, chunk: bytes) -> None:
        assert self._ws is not None
        await self._ws.send_bytes(
            build_audio_frame(self.session_id, chunk, compress=self.compress_audio)
        )

    async def receive(self, timeout: float | None = None) -> ServerEvent | None:
        """收一帧；连接关闭返回 None，错误帧抛 VolcRealtimeError。"""
        assert self._ws is not None
        msg = await self._ws.receive(timeout)
        if msg.type == aiohttp.WSMsgType.BINARY:
            ev = parse_server_frame(msg.data)
            if ev.error_code is not None:
                raise VolcRealtimeError(f"服务端错误 {ev.error_code}: {ev.payload}")
            return ev
        if msg.type in (
            aiohttp.WSMsgType.CLOSE,
            aiohttp.WSMsgType.CLOSING,
            aiohttp.WSMsgType.CLOSED,
            aiohttp.WSMsgType.ERROR,
        ):
            return None
        return ServerEvent()  # 文本/心跳帧忽略

    async def finish(self) -> None:
        """FinishSession + FinishConnection，尽力而为不抛错。"""
        if self._ws is None or self._ws.closed:
            return
        try:
            await self._ws.send_bytes(
                build_event_frame(EVENT_FINISH_SESSION, {}, self.session_id)
            )
            await self._ws.send_bytes(build_event_frame(EVENT_FINISH_CONNECTION))
        except (aiohttp.ClientError, ConnectionError):
            pass

    async def close(self) -> None:
        if self._ws is not None and not self._ws.closed:
            await self._ws.close()
        if self._http is not None and not self._http.closed:
            await self._http.close()
        self._ws = None
        self._http = None


# 实时语音 seam

REALTIME_PLUGIN_ID = "volcengine"
REALTIME_OPERATION = "realtime.session"
REALTIME_PROVIDER_KIND = "model-realtime-provider"


class RealtimeSessionClient(Protocol):
    """中继层依赖的会话客户端合同；火山实现是 :class:`VolcRealtimeClient`。"""

    session_id: str

    async def connect(self, timeout: float = 15.0) -> None: ...

    async def start_session(self, config: dict, timeout: float = 15.0) -> None: ...

    async def say_hello(self, content: str) -> None: ...

    async def chat_text_query(self, content: str) -> None: ...

    async def chat_tts_text(
        self, content: str, *, start: bool = False, end: bool = False
    ) -> None: ...

    async def client_interrupt(self) -> None: ...

    async def send_audio(self, chunk: bytes) -> None: ...

    async def receive(self, timeout: float | None = None) -> ServerEvent | None: ...

    async def finish(self) -> None: ...

    async def close(self) -> None: ...


class RealtimeRouteProvider(Protocol):
    def open_client(self, route: PreparedRealtimeRoute) -> RealtimeSessionClient: ...


@dataclass(frozen=True)
class PreparedRealtimeRoute(PreparedRoute[RouteSnapshot, RealtimeRouteProvider]):
    def open_client(self) -> RealtimeSessionClient:
        """按冻结的凭据建一条未连接的会话客户端；连接与事件中继仍由路由层驱动。"""
        return self._provider.open_client(self)


realtime_runtime: CapabilitySeam[RouteRequest, RouteSnapshot, RealtimeRouteProvider] = (
    CapabilitySeam(REALTIME_PROVIDER_KIND, label="实时语音", ready_source="realtime")
)


def register_realtime_route_provider(
    *,
    plugin_id: str,
    provider: RealtimeRouteProvider,
    operations: set[str] | frozenset[str] = frozenset({REALTIME_OPERATION}),
    replace: bool = False,
) -> RegistrationHandle:
    return realtime_runtime.register(
        plugin_id=plugin_id,
        provider=provider,
        operations=operations,
        replace=replace,
    )


def prepare_realtime_route(
    request: RouteRequest,
    operation: str = REALTIME_OPERATION,
) -> PreparedRealtimeRoute:
    return realtime_runtime.prepare_as(PreparedRealtimeRoute, request, operation)


def prepare_realtime_model_route(
    capability: str,
    route: ResolvedModelRoute,
) -> PreparedRealtimeRoute:
    return prepare_realtime_route(RouteRequest.from_model_route(capability, route))


class _VolcRealtimeProvider:
    def open_client(self, route: PreparedRealtimeRoute) -> RealtimeSessionClient:
        credentials = route.credentials
        return VolcRealtimeClient(
            str(credentials.get("app_id") or ""),
            str(credentials.get("access_key") or ""),
        )


_BUILTIN_REALTIME_PROVIDER_HANDLES = (
    register_realtime_route_provider(
        plugin_id=REALTIME_PLUGIN_ID,
        provider=_VolcRealtimeProvider(),
        operations=frozenset({REALTIME_OPERATION}),
    ),
)


REALTIME_CAPABILITY = "realtime-voice"
# 端到端实时语音目前只有火山豆包一家。
_REALTIME_PROVIDER_OPERATIONS = {
    "volc_speech": REALTIME_OPERATION,
    "volc_realtime": REALTIME_OPERATION,
}
_REALTIME_PROVIDER_TYPES = frozenset(_REALTIME_PROVIDER_OPERATIONS)


async def resolve_realtime_route(
    session,
    deployment_id: int | None,
    *,
    capability: str = REALTIME_CAPABILITY,
) -> PreparedRealtimeRoute:
    """解析并冻结实时会话路由。显式 deployment 优先，留空按 ``capability`` 的能力绑定。

    陪练中继使用火山旧协议会话接口。
    """
    if deployment_id is None:
        resolved: ResolvedBinding = await resolve_binding(session, capability)
        provider_type = resolved.provider_type
        operation = _REALTIME_PROVIDER_OPERATIONS.get(provider_type)
        if operation is None:
            raise CredentialError(f"实时语音插件未接入：{provider_type}")
        request = RouteRequest(
            capability=capability,
            plugin_id=adapter_for_provider(provider_type, operation=operation),
            provider_type=provider_type,
            model=resolved.target or "",
            credentials=resolved.config,
        )
        plugin_label = provider_type
    else:
        try:
            route = await resolve_model_route(
                session,
                capability,
                deployment_id=deployment_id,
            )
        except ModelCatalogError as exc:
            raise CredentialError(str(exc)) from exc
        if route is None:
            raise CredentialError("实时语音模型部署不存在")
        request = RouteRequest.from_model_route(capability, route)
        operation = _REALTIME_PROVIDER_OPERATIONS.get(request.provider_type)
        if operation is None:
            raise CredentialError(f"实时语音插件未接入：{request.provider_type}")
        plugin_label = route.adapter_type
    try:
        return prepare_realtime_route(request, operation)
    except SeamError as exc:
        raise CredentialError(f"实时语音模型插件未接入：{plugin_label}") from exc

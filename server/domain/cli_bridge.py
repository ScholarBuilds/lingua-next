"""Bounded local bridges for Codex, Gemini/Antigravity and Dreamina CLIs.

The bridge never invokes a shell. Every generation runs in a dedicated temporary
directory and only validated media from that directory (or an HTTPS result URL)
can cross back into Lingua.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import mimetypes
import os
import re
import shutil
import signal
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from PIL import Image

from domain.network_policy import routed_http_client, subprocess_env

MAX_CLI_OUTPUT_BYTES = 1024 * 1024
MAX_IMAGE_BYTES = 100 * 1024 * 1024
MAX_VIDEO_BYTES = 1024 * 1024 * 1024
MAX_AUDIO_BYTES = 500 * 1024 * 1024
IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif"})
VIDEO_SUFFIXES = frozenset({".mp4", ".webm", ".mov", ".m4v", ".mkv"})
AUDIO_SUFFIXES = frozenset({".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"})
JIMENG_IMAGE_MODELS = ("3.0", "3.1", "4.0", "4.1", "4.5", "4.6", "4.7", "5.0", "5.0Pro")
JIMENG_VIDEO_MODELS = (
    "seedance1.0fast",
    "seedance1.5pro",
    "seedance2.0",
    "seedance2.0fast",
    "seedance2.0_vip",
    "seedance2.0fast_vip",
    "seedance2.0mini",
)
_FAILURE_STATUSES = frozenset(
    {"failure", "failed", "error", "errored", "cancelled", "canceled", "rejected"}
)
_SENSITIVE_TEXT = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+|\b(sk-[A-Za-z0-9_-]{8,})\b")


class CliBridgeError(Exception):
    def __init__(self, kind: str, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.kind = kind
        self.retryable = retryable


@dataclass(frozen=True)
class ProcessResult:
    stdout: str
    stderr: str
    returncode: int


@dataclass(frozen=True)
class CliImageResult:
    images: list[bytes]
    latency_ms: int


@dataclass(frozen=True)
class CliVideoResult:
    name: str
    mime: str
    data: bytes
    source_url: str | None = None


@dataclass(frozen=True)
class CliChatResult:
    text: str
    latency_ms: int


@dataclass
class _LoginSession:
    process: asyncio.subprocess.Process
    root: Path
    started_at: float
    text: str = ""
    reader: asyncio.Task[None] | None = None


_jimeng_login: _LoginSession | None = None


def _safe_detail(value: str) -> str:
    return _SENSITIVE_TEXT.sub(lambda match: f"{match.group(1) or ''}***", value)[:1200]


def _timeout(config: dict[str, Any], default: int, maximum: int = 3600) -> int:
    try:
        return max(5, min(maximum, int(config.get("timeout") or default)))
    except (TypeError, ValueError):
        return default


def resolve_executable(configured: object, fallbacks: tuple[str, ...]) -> str:
    value = str(configured or "").strip().strip('"')
    if value:
        expanded = Path(value).expanduser()
        if expanded.is_absolute() or any(separator in value for separator in ("/", "\\")):
            if expanded.is_file():
                return str(expanded.resolve())
            return ""
        return shutil.which(value) or ""
    for name in fallbacks:
        found = shutil.which(name)
        if found:
            return found
    return ""


async def _read_limited(stream: asyncio.StreamReader | None) -> bytes:
    if stream is None:
        return b""
    chunks: list[bytes] = []
    total = 0
    while chunk := await stream.read(64 * 1024):
        total += len(chunk)
        if total > MAX_CLI_OUTPUT_BYTES:
            raise CliBridgeError("output", "CLI 输出超过 1MB 安全上限", retryable=False)
        chunks.append(chunk)
    return b"".join(chunks)


async def run_cli(
    executable: str,
    args: list[str],
    *,
    cwd: Path,
    timeout: int,
    input_data: bytes | None = None,
) -> ProcessResult:
    if not executable:
        raise CliBridgeError("missing", "未找到 CLI 可执行文件", retryable=False)
    process: asyncio.subprocess.Process | None = None
    readers: list[asyncio.Task[bytes]] = []
    if input_data is not None and len(input_data) > MAX_CLI_OUTPUT_BYTES:
        raise CliBridgeError("input", "CLI 输入超过 1MB 安全上限", retryable=False)
    try:
        process = await asyncio.create_subprocess_exec(
            executable,
            *args,
            cwd=str(cwd),
            stdin=asyncio.subprocess.PIPE if input_data is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=await subprocess_env(),
            start_new_session=True,
        )
        readers = [
            asyncio.create_task(_read_limited(process.stdout)),
            asyncio.create_task(_read_limited(process.stderr)),
        ]
        if input_data is not None and process.stdin is not None:
            process.stdin.write(input_data)
            await process.stdin.drain()
            process.stdin.close()
        stdout, stderr = await asyncio.wait_for(asyncio.gather(*readers), timeout=timeout)
        returncode = await asyncio.wait_for(process.wait(), timeout=5)
    except TimeoutError as exc:
        if process is not None and process.returncode is None:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
            await process.wait()
        raise CliBridgeError("timeout", f"CLI 执行超过 {timeout} 秒") from exc
    except FileNotFoundError as exc:
        raise CliBridgeError("missing", f"未找到 CLI：{executable}", retryable=False) from exc
    except CliBridgeError:
        if process is not None and process.returncode is None:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
            await process.wait()
        raise
    finally:
        for reader in readers:
            if not reader.done():
                reader.cancel()
    return ProcessResult(
        stdout.decode("utf-8", errors="replace").strip(),
        stderr.decode("utf-8", errors="replace").strip(),
        returncode,
    )


async def provider_help(config: dict[str, Any], provider_type: str, command: str = "") -> str:
    command = str(command or "").strip()
    if provider_type == "codex_cli":
        executable = resolve_executable(config.get("executable"), ("codex",))
        allowed = {"", "exec", "login", "logout", "doctor", "mcp", "app", "update"}
    elif provider_type == "gemini_cli":
        executable = _provider_executable(provider_type, config)
        is_agy = executable and Path(executable).name.lower().startswith("agy")
        allowed = (
            {"", "help", "install", "models", "plugin", "plugins", "update", "changelog"}
            if is_agy
            else {"", "help", "mcp", "extensions"}
        )
    elif provider_type == "jimeng_cli":
        executable = _provider_executable(provider_type, config)
        allowed = {
            "",
            "text2image",
            "image2image",
            "image_upscale",
            "text2video",
            "image2video",
            "frames2video",
            "multiframe2video",
            "multimodal2video",
            "query_result",
            "user_credit",
            "login",
            "logout",
        }
    else:
        raise CliBridgeError("input", "该凭据不是本机 CLI", retryable=False)
    if not executable:
        raise CliBridgeError("missing", "未找到 CLI 可执行文件", retryable=False)
    if command not in allowed:
        raise CliBridgeError("input", f"不允许的 CLI 帮助命令：{command}", retryable=False)
    args = [command] if command else []
    args.append("--help")
    result = await run_cli(executable, args, cwd=Path.cwd(), timeout=20)
    _require_success("CLI 帮助", result)
    return result.stdout or result.stderr


async def _read_login_stream(stream: asyncio.StreamReader | None, session: _LoginSession) -> None:
    if stream is None:
        return
    total = len(session.text.encode("utf-8"))
    while chunk := await stream.read(4096):
        total += len(chunk)
        if total > MAX_CLI_OUTPUT_BYTES:
            session.text += "\n[CLI 登录输出已达 1MB 上限]"
            if session.process.returncode is None:
                if os.name == "posix":
                    os.killpg(session.process.pid, signal.SIGKILL)
                else:
                    session.process.kill()
            return
        session.text += chunk.decode("utf-8", errors="replace")


async def _capture_login(session: _LoginSession) -> None:
    await asyncio.gather(
        _read_login_stream(session.process.stdout, session),
        _read_login_stream(session.process.stderr, session),
    )
    await session.process.wait()


async def _stop_login() -> None:
    global _jimeng_login
    session = _jimeng_login
    _jimeng_login = None
    if session is None:
        return
    if session.process.returncode is None:
        if os.name == "posix":
            os.killpg(session.process.pid, signal.SIGTERM)
        else:
            session.process.terminate()
        try:
            await asyncio.wait_for(session.process.wait(), timeout=5)
        except TimeoutError:
            if os.name == "posix":
                os.killpg(session.process.pid, signal.SIGKILL)
            else:
                session.process.kill()
            await session.process.wait()
    if session.reader is not None and not session.reader.done():
        session.reader.cancel()
    shutil.rmtree(session.root, ignore_errors=True)


def _login_qr(text: str) -> str:
    matches = re.findall(r"(?:https?://|dreamina://|data:image/)[^\s\"'<>]+", text)
    for value in matches:
        if value.startswith(("dreamina://", "data:image/")) or any(
            marker in value.lower() for marker in ("login", "qr")
        ):
            return value
    return matches[0] if matches else ""


async def jimeng_login_start(config: dict[str, Any]) -> dict[str, Any]:
    global _jimeng_login
    executable = _provider_executable("jimeng_cli", config)
    if not executable:
        raise CliBridgeError("missing", "未找到即梦 dreamina CLI", retryable=False)
    await _stop_login()
    root = Path(tempfile.mkdtemp(prefix="lingua-jimeng-login-"))
    process = await asyncio.create_subprocess_exec(
        executable,
        "login",
        "--headless",
        cwd=str(root),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=await subprocess_env(),
        start_new_session=True,
    )
    session = _LoginSession(process=process, root=root, started_at=time.time())
    session.reader = asyncio.create_task(_capture_login(session))
    _jimeng_login = session
    await asyncio.sleep(1)
    return await jimeng_login_status(config, verify_credit=False)


async def jimeng_login_status(
    config: dict[str, Any], *, verify_credit: bool = True
) -> dict[str, Any]:
    session = _jimeng_login
    running = session is not None and session.process.returncode is None
    text = session.text.strip() if session is not None else ""
    logged_in: bool | None = None
    credit: Any = None
    if not running and verify_credit:
        executable = _provider_executable("jimeng_cli", config)
        if executable:
            result = await run_cli(executable, ["user_credit"], cwd=Path.cwd(), timeout=30)
            if result.returncode == 0:
                logged_in = True
                credit = _json_payload(result.stdout or result.stderr)
            else:
                logged_in = False
    return {
        "running": running,
        "logged_in": logged_in,
        "text": text,
        "qr_url": _login_qr(text),
        "started_at": session.started_at if session is not None else None,
        "credit": credit,
    }


async def jimeng_logout(config: dict[str, Any]) -> dict[str, Any]:
    executable = _provider_executable("jimeng_cli", config)
    if not executable:
        raise CliBridgeError("missing", "未找到即梦 dreamina CLI", retryable=False)
    await _stop_login()
    result = await run_cli(executable, ["logout"], cwd=Path.cwd(), timeout=30)
    _require_success("即梦退出", result)
    return {"logged_in": False, "text": result.stdout or result.stderr}


def _require_success(label: str, result: ProcessResult) -> None:
    if result.returncode == 0:
        return
    detail = result.stderr or result.stdout or f"exit={result.returncode}"
    lowered = detail.lower()
    auth_error = any(word in lowered for word in ("login", "unauthorized", "token"))
    kind = "auth" if auth_error else "cli"
    raise CliBridgeError(
        kind, f"{label} 调用失败：{_safe_detail(detail)}", retryable=kind != "auth"
    )


def _json_payload(text: str) -> Any:
    value = text.strip()
    if not value:
        return {}
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        pass
    for line in reversed(value.splitlines()):
        try:
            parsed = json.loads(line.strip())
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, (dict, list)):
            return parsed
    return {"text": value}


def _walk(value: Any):
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def _submit_id(payload: Any) -> str:
    for value in _walk(payload):
        if not isinstance(value, dict):
            continue
        for key in ("submit_id", "task_id", "taskId", "id"):
            found = value.get(key)
            if found and re.fullmatch(r"[A-Za-z0-9_-]{8,128}", str(found)):
                return str(found)
    return ""


def _failure_detail(payload: Any) -> str:
    for value in _walk(payload):
        if not isinstance(value, dict):
            continue
        status = str(
            value.get("status") or value.get("gen_status") or value.get("task_status") or ""
        ).lower()
        if status in _FAILURE_STATUSES:
            detail = value.get("message") or value.get("error") or value.get("fail_reason")
            return _safe_detail(str(detail or status))
    return ""


def _media_strings(payload: Any, suffixes: frozenset[str]) -> list[str]:
    found: list[str] = []
    for value in _walk(payload):
        if not isinstance(value, str):
            continue
        text = value.strip().strip("\"'")
        path = urlparse(text).path if text.startswith(("http://", "https://")) else text
        if Path(path).suffix.lower() in suffixes and text not in found:
            found.append(text)
    return found


def _inside(root: Path, value: str) -> Path | None:
    raw = value[7:] if value.startswith("file://") else value
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root.resolve())
    except (OSError, ValueError):
        return None
    return resolved if resolved.is_file() else None


async def _download(url: str, limit: int) -> bytes:
    if not url.startswith(("http://", "https://")):
        raise CliBridgeError("output", "CLI 返回了不支持的产物地址", retryable=False)
    chunks: list[bytes] = []
    total = 0
    try:
        async with (
            routed_http_client(timeout=180, follow_redirects=True) as client,
            client.stream("GET", url) as response,
        ):
            response.raise_for_status()
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > limit:
                    raise CliBridgeError("output", "CLI 产物超过大小上限", retryable=False)
                chunks.append(chunk)
    except httpx.HTTPError as exc:
        raise CliBridgeError("connect", f"CLI 产物下载失败：{exc}") from exc
    return b"".join(chunks)


def _validate_image(data: bytes) -> None:
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise CliBridgeError("output", "CLI 图片产物为空或超过 100MB", retryable=False)
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.verify()
    except Exception as exc:
        raise CliBridgeError("output", "CLI 返回的文件不是有效图片", retryable=False) from exc


async def _collect_media(
    root: Path,
    payload: Any,
    *,
    suffixes: frozenset[str],
    limit: int,
) -> list[tuple[str, bytes, str | None]]:
    values = _media_strings(payload, suffixes)
    values.extend(str(path) for suffix in suffixes for path in root.glob(f"*{suffix}"))
    collected: list[tuple[str, bytes, str | None]] = []
    seen: set[str] = set()
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        source_url: str | None = None
        if value.startswith(("http://", "https://")):
            data = await _download(value, limit)
            name = Path(urlparse(value).path).name or "output"
            source_url = value
        else:
            path = _inside(root, value)
            if path is None:
                continue
            if path.stat().st_size > limit:
                raise CliBridgeError("output", "CLI 产物超过大小上限", retryable=False)
            data = path.read_bytes()
            name = path.name
        collected.append((name, data, source_url))
    return collected


def _write_references(root: Path, references: list[tuple[str, bytes]]) -> list[Path]:
    paths: list[Path] = []
    for index, (name, data) in enumerate(references[:10]):
        suffix = Path(name).suffix.lower()
        if suffix not in IMAGE_SUFFIXES:
            suffix = ".png"
        _validate_image(data)
        path = root / f"reference-{index + 1}{suffix}"
        path.write_bytes(data)
        paths.append(path)
    return paths


def _image_size(size: str) -> str:
    match = re.fullmatch(r"\s*(\d{2,5})[xX*](\d{2,5})\s*", str(size or ""))
    return f"{match.group(1)}x{match.group(2)}" if match else "1024x1024"


def _ratio(size: str) -> str:
    width, height = (int(part) for part in _image_size(size).split("x"))
    choices = ((21, 9), (16, 9), (3, 2), (4, 3), (1, 1), (3, 4), (2, 3), (9, 16))
    left, right = min(choices, key=lambda item: abs(width / height - item[0] / item[1]))
    return f"{left}:{right}"


def _jimeng_resolution(model: str, size: str, *, edit: bool) -> str:
    width, height = (int(part) for part in _image_size(size).split("x"))
    desired = "4k" if max(width, height) > 3072 else ("2k" if max(width, height) > 1536 else "1k")
    if edit and model != "5.0Pro":
        return "4k" if desired == "4k" else "2k"
    if model in {"4.0", "4.1", "4.5", "4.6", "4.7", "5.0"}:
        return "4k" if desired == "4k" else "2k"
    return desired


def _provider_executable(provider_type: str, config: dict[str, Any]) -> str:
    if provider_type == "codex_cli":
        return resolve_executable(config.get("helper_executable"), ("gpt-image-2-skill",))
    if provider_type == "gemini_cli":
        return resolve_executable(config.get("executable"), ("agy", "gemini"))
    if provider_type == "jimeng_cli":
        return resolve_executable(config.get("executable"), ("dreamina",))
    return ""


async def provider_status(config: dict[str, Any], provider_type: str) -> dict[str, Any]:
    if provider_type == "codex_cli":
        codex = resolve_executable(config.get("executable"), ("codex",))
        helper = _provider_executable(provider_type, config)
        if not codex or not helper:
            missing = "Codex CLI" if not codex else "GPT Image 2 helper"
            raise CliBridgeError("missing", f"未找到 {missing}", retryable=False)
        result = await run_cli(codex, ["--version"], cwd=Path.cwd(), timeout=15)
        _require_success("Codex CLI", result)
        return {"installed": True, "version": result.stdout or result.stderr, "helper": helper}
    executable = _provider_executable(provider_type, config)
    label = "Gemini/Antigravity CLI" if provider_type == "gemini_cli" else "即梦 CLI"
    if not executable:
        raise CliBridgeError("missing", f"未找到 {label}", retryable=False)
    result = await run_cli(executable, ["--version"], cwd=Path.cwd(), timeout=15)
    _require_success(label, result)
    status: dict[str, Any] = {
        "installed": True,
        "version": result.stdout or result.stderr,
        "executable": executable,
    }
    if provider_type == "jimeng_cli":
        credit = await run_cli(executable, ["user_credit"], cwd=Path.cwd(), timeout=30)
        _require_success("即梦登录/额度检查", credit)
        status["logged_in"] = True
        status["credit"] = _json_payload(credit.stdout or credit.stderr)
    return status


def provider_models(provider_type: str) -> list[dict[str, Any]]:
    if provider_type == "codex_cli":
        return [
            {"id": "gpt-image-2", "media_types": ["image"]},
            {"id": "gpt-5.5", "media_types": ["chat"]},
        ]
    if provider_type == "gemini_cli":
        return [
            {
                "id": "auto",
                "display_name": "CLI 自动模型",
                "media_types": ["chat", "image"],
            }
        ]
    if provider_type == "jimeng_cli":
        return [
            *({"id": model, "media_types": ["image"]} for model in JIMENG_IMAGE_MODELS),
            *({"id": model, "media_types": ["video"]} for model in JIMENG_VIDEO_MODELS),
        ]
    raise CliBridgeError("input", f"未知 CLI 供应商：{provider_type}", retryable=False)


# ---- 凭据自动探测 ----
#
# 表单上那一排「（可选）」输入框其实是白问的：`resolve_executable` 早就在调用时用
# `shutil.which` 找可执行文件，用户手填的路径只是覆盖。所以打开表单先探一遍，
# 找到了就直接显示路径，找不到才把输入框露出来并给出安装/登录办法。
#
# 脱敏是硬要求：这里只回路径与布尔，auth 文件的内容一个字节都不出去。

# PATH 之外的常见安装位置。服务由 launchd / 双击脚本拉起来时 PATH 会被削到只剩
# 系统目录，which 找不到但文件就在那儿——这类「装了却说没装」最难自查
_EXTRA_BIN_DIRS = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "~/.local/bin",
    "~/.bun/bin",
    "~/.npm-global/bin",
    "~/.yarn/bin",
)
# nvm 按 node 版本分目录装全局包。目录名倒序遍历（字典序，不是语义版本序——
# 这条只是 PATH 被削光时的兜底，正常情况 which 就找到了）
_NVM_ROOT = "~/.nvm/versions/node"


@dataclass(frozen=True)
class ProbeField:
    """一个表单字段的探测结果。``key`` 与 PROVIDER_TYPES 的字段名同名，前端据此回填。"""

    key: str
    label: str
    detected: str | None
    source: str | None  # which | path | nvm | default_path


@dataclass(frozen=True)
class ProbeRemediation:
    problem: str
    howto: str


@dataclass(frozen=True)
class ProbeResult:
    provider_type: str
    found: bool
    fields: tuple[ProbeField, ...]
    #: None 表示这个 CLI 没有能廉价判断登录态的办法，不是「没登录」
    logged_in: bool | None
    remediation: tuple[ProbeRemediation, ...]

    def view(self) -> dict[str, Any]:
        return {
            "provider_type": self.provider_type,
            "found": self.found,
            "fields": [
                {
                    "key": item.key,
                    "label": item.label,
                    "detected": item.detected,
                    "source": item.source,
                }
                for item in self.fields
            ],
            "logged_in": self.logged_in,
            "remediation": [
                {"problem": item.problem, "howto": item.howto} for item in self.remediation
            ],
        }


def _extra_bin_dirs() -> list[tuple[Path, str]]:
    dirs = [(Path(value).expanduser(), "path") for value in _EXTRA_BIN_DIRS]
    nvm = sorted(Path(_NVM_ROOT).expanduser().glob("*/bin"), reverse=True)
    dirs.extend((directory, "nvm") for directory in nvm)
    return dirs


def _detect_executable(names: tuple[str, ...]) -> tuple[str, str] | None:
    for name in names:
        found = shutil.which(name)
        if found:
            return found, "which"
    extra = _extra_bin_dirs()
    for name in names:
        for directory, source in extra:
            candidate = directory / name
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate), source
    return None


def _detect_file(paths: tuple[str, ...]) -> str | None:
    for value in paths:
        candidate = Path(value).expanduser()
        if candidate.is_file():
            return str(candidate)
    return None


def _codex_logged_in(auth_file: str | None) -> bool:
    """只判断有没有凭据，不取值：读出来的 token 一律不出这个函数。"""
    if not auth_file:
        return False
    try:
        payload = json.loads(Path(auth_file).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(payload, dict):
        return False
    if str(payload.get("OPENAI_API_KEY") or "").strip():
        return True
    tokens = payload.get("tokens")
    if not isinstance(tokens, dict):
        return False
    return any(str(tokens.get(key) or "").strip() for key in ("access_token", "refresh_token"))


def _probe_codex() -> ProbeResult:
    codex = _detect_executable(("codex",))
    helper = _detect_executable(("gpt-image-2-skill",))
    auth_file = _detect_file(("~/.codex/auth.json",))
    logged_in = _codex_logged_in(auth_file)
    remediation: list[ProbeRemediation] = []
    if codex is None:
        remediation.append(ProbeRemediation("未找到 Codex CLI", "npm i -g @openai/codex"))
    elif not logged_in:
        remediation.append(ProbeRemediation("Codex 还没登录", "在终端跑 codex login"))
    if helper is None:
        remediation.append(
            ProbeRemediation("未找到 gpt-image-2-skill", "npm i -g gpt-image-2-skill")
        )
    return ProbeResult(
        provider_type="codex_cli",
        found=codex is not None,
        fields=(
            ProbeField("executable", "Codex 路径", *(codex or (None, None))),
            ProbeField("helper_executable", "GPT Image 2 helper 路径", *(helper or (None, None))),
            ProbeField(
                "auth_file",
                "Codex auth.json",
                auth_file,
                "default_path" if auth_file else None,
            ),
        ),
        logged_in=logged_in,
        remediation=tuple(remediation),
    )


def _probe_gemini() -> ProbeResult:
    executable = _detect_executable(("agy", "gemini"))
    # 官方 gemini-cli 与 Antigravity 都把登录态放在 ~/.gemini 下，文件名两代不同
    credential = _detect_file(
        ("~/.gemini/oauth_creds.json", "~/.gemini/google_accounts.json")
    )
    logged_in = credential is not None
    remediation: list[ProbeRemediation] = []
    if executable is None:
        remediation.append(
            ProbeRemediation(
                "未找到 agy / gemini",
                "官方 CLI：npm i -g @google/gemini-cli；用 Antigravity 的把 agy 所在目录"
                "加进 PATH，或在下面手填路径",
            )
        )
    elif not logged_in:
        remediation.append(
            ProbeRemediation("Gemini CLI 还没登录", "在终端跑一次 gemini，按提示完成浏览器授权")
        )
    return ProbeResult(
        provider_type="gemini_cli",
        found=executable is not None,
        fields=(
            ProbeField("executable", "agy / gemini 路径", *(executable or (None, None))),
        ),
        logged_in=logged_in,
        remediation=tuple(remediation),
    )


def _probe_jimeng() -> ProbeResult:
    executable = _detect_executable(("dreamina",))
    remediation: list[ProbeRemediation] = []
    if executable is None:
        remediation.append(
            ProbeRemediation(
                "未找到 dreamina",
                "装好后把它所在目录加进 PATH，或在下面手填路径",
            )
        )
    else:
        # 登录态只能靠跑一次 user_credit 判，那是要拉起子进程的活，不放在打开表单时做
        remediation.append(
            ProbeRemediation("登录态要现场确认", "保存凭据后点这张卡片上的「扫码登录」")
        )
    return ProbeResult(
        provider_type="jimeng_cli",
        found=executable is not None,
        fields=(ProbeField("executable", "dreamina 路径", *(executable or (None, None))),),
        logged_in=None,
        remediation=tuple(remediation),
    )


_PROBES = {
    "codex_cli": _probe_codex,
    "gemini_cli": _probe_gemini,
    "jimeng_cli": _probe_jimeng,
}

PROBE_PROVIDER_TYPES = frozenset(_PROBES)


def probe_provider(provider_type: str) -> ProbeResult:
    """探测一个本机 CLI 供应商的可执行文件与登录态。只回路径与布尔，不回任何密钥。"""
    probe = _PROBES.get(provider_type.strip().lower())
    if probe is None:
        raise CliBridgeError(
            "input", f"该供应商类型不支持自动探测：{provider_type}", retryable=False
        )
    return probe()


def _chat_payload(messages: list[dict[str, Any]]) -> tuple[str, list[bytes]]:
    parts: list[str] = []
    images: list[bytes] = []
    labels = {"system": "系统", "user": "用户", "assistant": "助手", "tool": "工具"}
    for message in messages:
        role = str(message.get("role") or "user")
        content = message.get("content")
        texts: list[str] = []
        blocks = content if isinstance(content, list) else [{"type": "text", "text": content}]
        for block in blocks:
            if not isinstance(block, dict):
                texts.append(str(block))
                continue
            if block.get("type") == "text":
                texts.append(str(block.get("text") or ""))
                continue
            image_url = block.get("image_url")
            url = image_url.get("url") if isinstance(image_url, dict) else ""
            if not isinstance(url, str) or not url.startswith("data:image/"):
                continue
            try:
                images.append(base64.b64decode(url.split(",", 1)[1], validate=True))
            except (IndexError, ValueError):
                continue
        text = "\n".join(value for value in texts if value).strip()
        if text:
            parts.append(f"{labels.get(role, role)}：\n{text}")
    parts.append("请直接回答最后一条用户消息，输出纯文本，不要修改文件。")
    return "\n\n".join(parts), images


async def generate_chat(
    provider_type: str,
    *,
    config: dict[str, Any],
    messages: list[dict[str, Any]],
    model: str,
) -> CliChatResult:
    if provider_type not in {"codex_cli", "gemini_cli"}:
        raise CliBridgeError("input", f"CLI 不支持对话：{provider_type}", retryable=False)
    executable = resolve_executable(
        config.get("executable"),
        ("codex",) if provider_type == "codex_cli" else ("agy", "gemini"),
    )
    if not executable:
        raise CliBridgeError("missing", "未找到对话 CLI", retryable=False)
    timeout = _timeout(config, 900 if provider_type == "codex_cli" else 300)
    prompt, image_data = _chat_payload(messages)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix=f"lingua-{provider_type}-chat-") as temp:
        root = Path(temp)
        references = _write_references(
            root,
            [(f"chat-reference-{index + 1}.png", data) for index, data in enumerate(image_data)],
        )
        if provider_type == "codex_cli":
            last_message = root / "last-message.txt"
            args = [
                "exec",
                "--cd",
                str(root),
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
            ]
            if model:
                args.extend(["--model", model])
            for reference in references:
                args.extend(["--image", str(reference)])
            args.extend(["--output-last-message", str(last_message), "-"])
            result = await run_cli(
                executable,
                args,
                cwd=root,
                timeout=timeout,
                input_data=prompt.encode("utf-8"),
            )
            _require_success("Codex CLI 对话", result)
            text = last_message.read_text(encoding="utf-8").strip() if last_message.exists() else ""
            text = text or result.stdout
        else:
            if references:
                prompt += "\n\n本轮参考图路径：\n" + "\n".join(map(str, references))
            is_agy = Path(executable).name.lower().startswith("agy")
            if is_agy:
                args = ["--print-timeout", f"{timeout}s"]
                if model and model != "auto":
                    args.extend(["--model", model])
                args.extend(["-p", prompt])
            else:
                args = [
                    "--model",
                    model or "auto",
                    "--output-format",
                    "json",
                    "--skip-trust",
                    "--prompt",
                    prompt,
                ]
            result = await run_cli(executable, args, cwd=root, timeout=timeout)
            _require_success("Gemini/Antigravity CLI 对话", result)
            payload = _json_payload(result.stdout)
            text = ""
            if isinstance(payload, dict):
                text = str(
                    payload.get("response")
                    or payload.get("text")
                    or payload.get("content")
                    or payload.get("message")
                    or ""
                )
            text = text or result.stdout
    if not text.strip():
        raise CliBridgeError("output", "CLI 对话返回了空内容")
    return CliChatResult(text=text.strip(), latency_ms=int((time.monotonic() - started) * 1000))


async def _jimeng_query_media(
    executable: str,
    config: dict[str, Any],
    submit_id: str,
    *,
    suffixes: frozenset[str],
    limit: int,
    deadline: float,
) -> tuple[str, bytes, str | None] | None:
    while asyncio.get_running_loop().time() < deadline:
        with tempfile.TemporaryDirectory(prefix="lingua-jimeng-query-") as temp:
            root = Path(temp)
            result = await run_cli(
                executable,
                ["query_result", f"--submit_id={submit_id}", f"--download_dir={root}"],
                cwd=root,
                timeout=min(300, _timeout(config, 180)),
            )
            _require_success("即梦 CLI 任务查询", result)
            payload = _json_payload(result.stdout or result.stderr)
            failure = _failure_detail(payload)
            if failure:
                raise CliBridgeError("provider_failed", f"即梦生成失败：{failure}")
            media = await _collect_media(root, payload, suffixes=suffixes, limit=limit)
            if media:
                return media[0]
        await asyncio.sleep(2)
    return None


async def generate_images(
    provider_type: str,
    *,
    config: dict[str, Any],
    prompt: str,
    model: str,
    size: str,
    n: int,
    references: list[tuple[str, bytes]],
) -> CliImageResult:
    executable = _provider_executable(provider_type, config)
    if not executable:
        raise CliBridgeError("missing", "未找到已配置的 CLI", retryable=False)
    timeout = _timeout(config, 300, 1800)
    started = time.monotonic()
    images: list[bytes] = []
    for index in range(n):
        with tempfile.TemporaryDirectory(prefix=f"lingua-{provider_type}-") as temp:
            root = Path(temp)
            refs = _write_references(root, references)
            output = root / f"output-{index + 1}.png"
            if provider_type == "codex_cli":
                args = ["--json", "--provider", "codex"]
                auth_file = str(config.get("auth_file") or "").strip()
                if auth_file:
                    args.extend(["--auth-file", str(Path(auth_file).expanduser())])
                args.extend(
                    [
                        "images",
                        "edit" if refs else "generate",
                        "--prompt",
                        prompt,
                        "--out",
                        str(output),
                        "--model",
                        model or "gpt-image-2",
                        "--format",
                        "png",
                        "--size",
                        _image_size(size),
                        "--quality",
                        "high",
                    ]
                )
                for ref in refs:
                    args.extend(["--ref-image", str(ref)])
                result = await run_cli(executable, args, cwd=root, timeout=timeout)
                _require_success("GPT Image 2 helper", result)
            elif provider_type == "gemini_cli":
                reference_note = "\n".join(str(ref) for ref in refs)
                task_prompt = (
                    f"任务：{prompt}\n目标尺寸：{_image_size(size)}\n"
                    f"参考图路径：\n{reference_note or '无'}\n"
                    f"将唯一最终图片保存到 {output}。不要修改其他文件；"
                    "无法生成时直接说明失败。"
                )
                is_agy = Path(executable).name.lower().startswith("agy")
                if is_agy:
                    args = ["--print-timeout", f"{timeout}s"]
                    if model and model != "auto":
                        args.extend(["--model", model])
                    args.extend(["--dangerously-skip-permissions", "-p", task_prompt])
                else:
                    args = [
                        "--model",
                        model or "auto",
                        "--output-format",
                        "json",
                        "--skip-trust",
                        "--approval-mode",
                        "yolo",
                        "--prompt",
                        task_prompt,
                    ]
                result = await run_cli(executable, args, cwd=root, timeout=timeout)
                _require_success("Gemini/Antigravity CLI", result)
            else:
                selected = model if model in JIMENG_IMAGE_MODELS else "5.0"
                if refs and selected in {"3.0", "3.1"}:
                    raise CliBridgeError(
                        "input", f"即梦模型 {selected} 不支持参考图编辑", retryable=False
                    )
                if refs:
                    args = [
                        "image2image",
                        f"--images={','.join(str(ref) for ref in refs)}",
                        f"--prompt={prompt}",
                        f"--resolution_type={_jimeng_resolution(selected, size, edit=True)}",
                        "--poll=1",
                        f"--model_version={selected}",
                    ]
                else:
                    args = [
                        "text2image",
                        f"--prompt={prompt}",
                        f"--ratio={_ratio(size)}",
                        f"--resolution_type={_jimeng_resolution(selected, size, edit=False)}",
                        "--poll=1",
                        f"--model_version={selected}",
                    ]
                result = await run_cli(executable, args, cwd=root, timeout=timeout)
                _require_success("即梦 CLI", result)
            payload = _json_payload(result.stdout or result.stderr)
            failure = _failure_detail(payload)
            if failure:
                raise CliBridgeError("provider_failed", f"CLI 生成失败：{failure}")
            media = await _collect_media(
                root, payload, suffixes=IMAGE_SUFFIXES, limit=MAX_IMAGE_BYTES
            )
            if not media and provider_type == "jimeng_cli":
                task_id = _submit_id(payload)
                if task_id:
                    queried = await _jimeng_query_media(
                        executable,
                        config,
                        task_id,
                        suffixes=IMAGE_SUFFIXES,
                        limit=MAX_IMAGE_BYTES,
                        deadline=asyncio.get_running_loop().time() + timeout,
                    )
                    media = [queried] if queried else []
            if not media:
                detail = _safe_detail(result.stdout or result.stderr)
                raise CliBridgeError("output", f"CLI 未返回图片产物：{detail}")
            data = media[0][1]
            _validate_image(data)
            images.append(data)
    return CliImageResult(images=images, latency_ms=int((time.monotonic() - started) * 1000))


async def upscale_jimeng_image(
    *,
    config: dict[str, Any],
    image: tuple[str, bytes],
    resolution_type: str,
) -> CliImageResult:
    """Run Dreamina's native super-resolution command for one stored image."""
    executable = _provider_executable("jimeng_cli", config)
    if not executable:
        raise CliBridgeError("missing", "未找到即梦 dreamina CLI", retryable=False)
    resolution = str(resolution_type or "2k").strip().lower()
    if resolution not in {"2k", "4k", "8k"}:
        raise CliBridgeError("input", "即梦图片放大只支持 2K、4K 或 8K", retryable=False)
    timeout = _timeout(config, 300, 1800)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="lingua-jimeng-upscale-") as temp:
        root = Path(temp)
        reference = _write_references(root, [image])[0]
        result = await run_cli(
            executable,
            [
                "image_upscale",
                f"--image={reference}",
                f"--resolution_type={resolution}",
                "--poll=1",
            ],
            cwd=root,
            timeout=timeout,
        )
        _require_success("即梦图片放大", result)
        payload = _json_payload(result.stdout or result.stderr)
        failure = _failure_detail(payload)
        if failure:
            raise CliBridgeError("provider_failed", f"即梦图片放大失败：{failure}")
        media = await _collect_media(root, payload, suffixes=IMAGE_SUFFIXES, limit=MAX_IMAGE_BYTES)
        if not media:
            task_id = _submit_id(payload)
            if task_id:
                queried = await _jimeng_query_media(
                    executable,
                    config,
                    task_id,
                    suffixes=IMAGE_SUFFIXES,
                    limit=MAX_IMAGE_BYTES,
                    deadline=asyncio.get_running_loop().time() + timeout,
                )
                media = [queried] if queried else []
        if not media:
            raise CliBridgeError(
                "output", f"即梦图片放大未返回产物：{_safe_detail(result.stdout or result.stderr)}"
            )
        data = media[0][1]
        _validate_image(data)
    return CliImageResult(images=[data], latency_ms=int((time.monotonic() - started) * 1000))


def _jimeng_video_args(
    *,
    prompt: str,
    model: str,
    duration: int,
    aspect_ratio: str,
    resolution: str,
    references: list[tuple[Path, str]],
    media_references: list[tuple[Path, str]],
    multimodal: bool,
    poll_seconds: int,
) -> list[str]:
    if model not in JIMENG_VIDEO_MODELS:
        raise CliBridgeError("input", f"即梦视频模型无效：{model}", retryable=False)
    use_multimodal = multimodal or bool(media_references)
    command = (
        "multimodal2video"
        if use_multimodal
        else "frames2video"
        if any(item[1] == "first_frame" for item in references)
        and any(item[1] == "last_frame" for item in references)
        and len(references) == 2
        else "multiframe2video"
        if len(references) > 1
        else "image2video"
        if references
        else "text2video"
    )
    allowed_by_command = {
        "text2video": set(JIMENG_VIDEO_MODELS[2:]),
        "image2video": set(JIMENG_VIDEO_MODELS),
        "multimodal2video": set(JIMENG_VIDEO_MODELS[2:]),
        "frames2video": set(JIMENG_VIDEO_MODELS[1:]),
    }
    allowed = allowed_by_command.get(command)
    if allowed is not None and model not in allowed:
        raise CliBridgeError(
            "input",
            f"即梦 {command} 不支持模型 {model}，可用：{'、'.join(sorted(allowed))}",
            retryable=False,
        )
    if command != "multiframe2video":
        low, high = (
            (5, 10)
            if command == "image2video" and model == "seedance1.0fast"
            else (5, 12)
            if command in {"image2video", "frames2video"} and model == "seedance1.5pro"
            else (4, 15)
        )
        if not low <= duration <= high:
            raise CliBridgeError(
                "input", f"即梦模型 {model} 只支持 {low}-{high} 秒", retryable=False
            )
    selected_resolution = str(resolution or "720p").strip().lower()
    selected_resolution = {"720": "720p", "1080": "1080p", "4kp": "4k"}.get(
        selected_resolution, selected_resolution
    )
    if selected_resolution not in {"720p", "1080p", "4k"}:
        raise CliBridgeError("input", "即梦视频分辨率无效", retryable=False)
    if command == "multiframe2video" and selected_resolution not in {"720p", "1080p"}:
        raise CliBridgeError("input", "即梦多帧视频只支持 720p 或 1080p", retryable=False)
    if (
        command != "multiframe2video"
        and model != "seedance2.0_vip"
        and selected_resolution != "720p"
    ):
        raise CliBridgeError("input", f"即梦模型 {model} 只支持 720p", retryable=False)
    ratio = aspect_ratio if aspect_ratio in {"1:1", "3:4", "16:9", "4:3", "9:16", "21:9"} else ""
    first = next((item for item in references if item[1] == "first_frame"), None)
    last = next((item for item in references if item[1] == "last_frame"), None)
    if use_multimodal:
        video_refs = [item for item in media_references if item[1] == "video"]
        audio_refs = [item for item in media_references if item[1] == "audio"]
        if len(references) > 9 or len(video_refs) > 3 or len(audio_refs) > 3:
            raise CliBridgeError(
                "input", "即梦全能参考最多 9 张图、3 个视频和 3 个音频", retryable=False
            )
        if not references and not video_refs:
            raise CliBridgeError(
                "input",
                "即梦全能参考至少需要一张图片或一个视频，音频不能单独生成视频",
                retryable=False,
            )
        if not ratio:
            raise CliBridgeError("input", "即梦视频比例无效", retryable=False)
        args = [
            "multimodal2video",
            f"--prompt={prompt}",
            f"--duration={duration}",
            f"--ratio={ratio}",
            f"--poll={poll_seconds}",
            f"--model_version={model}",
            f"--video_resolution={selected_resolution}",
        ]
        args.extend(f"--image={item[0]}" for item in references)
        args.extend(f"--video={item[0]}" for item in video_refs)
        args.extend(f"--audio={item[0]}" for item in audio_refs)
    elif first and last and len(references) == 2:
        args = [
            "frames2video",
            f"--first={first[0]}",
            f"--last={last[0]}",
            f"--prompt={prompt}",
            f"--duration={duration}",
            f"--poll={poll_seconds}",
            f"--model_version={model}",
            f"--video_resolution={selected_resolution}",
        ]
    elif len(references) > 1:
        if len(references) > 20:
            raise CliBridgeError("input", "即梦多帧视频最多支持 20 张图片", retryable=False)
        segment_count = len(references) - 1
        segment_duration = max(1, min(8, round(duration / segment_count)))
        args = [
            "multiframe2video",
            f"--images={','.join(str(item[0]) for item in references)}",
            f"--poll={poll_seconds}",
            f"--video_resolution={selected_resolution}",
        ]
        if len(references) <= 2:
            if prompt.strip():
                args.append(f"--prompt={prompt}")
            args.append(f"--duration={segment_duration}")
        else:
            transition_prompts = [line.strip() for line in prompt.splitlines() if line.strip()]
            if len(transition_prompts) == 1:
                transition_prompts *= segment_count
            elif transition_prompts and len(transition_prompts) < segment_count:
                transition_prompts.extend(
                    [transition_prompts[-1]] * (segment_count - len(transition_prompts))
                )
            args.extend(
                f"--transition-prompt={item}" for item in transition_prompts[:segment_count]
            )
            args.extend(f"--transition-duration={segment_duration}" for _ in range(segment_count))
    elif references:
        args = [
            "image2video",
            f"--image={references[0][0]}",
            f"--prompt={prompt}",
            f"--duration={duration}",
            f"--poll={poll_seconds}",
            f"--model_version={model}",
            f"--video_resolution={selected_resolution}",
        ]
    else:
        if not ratio:
            raise CliBridgeError("input", "即梦视频比例无效", retryable=False)
        args = [
            "text2video",
            f"--prompt={prompt}",
            f"--duration={duration}",
            f"--ratio={ratio}",
            f"--poll={poll_seconds}",
            f"--model_version={model}",
            f"--video_resolution={selected_resolution}",
        ]
    return args


async def submit_jimeng_video(
    *,
    config: dict[str, Any],
    prompt: str,
    model: str,
    duration: int,
    aspect_ratio: str,
    resolution: str,
    references: list[tuple[str, bytes, str]],
    media_references: list[tuple[str, bytes, str]],
    multimodal: bool = False,
) -> str:
    executable = _provider_executable("jimeng_cli", config)
    if not executable:
        raise CliBridgeError("missing", "未找到即梦 dreamina CLI", retryable=False)
    poll_seconds = max(1, min(10, int(config.get("submit_poll_seconds") or 1)))
    with tempfile.TemporaryDirectory(prefix="lingua-jimeng-video-") as temp:
        root = Path(temp)
        local_refs: list[tuple[Path, str]] = []
        for index, (name, data, role) in enumerate(references):
            _validate_image(data)
            suffix = Path(name).suffix.lower()
            path = root / f"reference-{index + 1}{suffix if suffix in IMAGE_SUFFIXES else '.png'}"
            path.write_bytes(data)
            local_refs.append((path, role))
        local_media_refs: list[tuple[Path, str]] = []
        for index, (name, data, kind) in enumerate(media_references):
            if kind not in {"video", "audio"}:
                raise CliBridgeError("input", "即梦全能参考类型无效", retryable=False)
            suffixes = VIDEO_SUFFIXES if kind == "video" else AUDIO_SUFFIXES
            limit = MAX_VIDEO_BYTES if kind == "video" else MAX_AUDIO_BYTES
            if not data or len(data) > limit:
                raise CliBridgeError(
                    "input",
                    f"即梦{'视频' if kind == 'video' else '音频'}参考文件为空或超过大小上限",
                    retryable=False,
                )
            suffix = Path(name).suffix.lower()
            fallback = ".mp4" if kind == "video" else ".mp3"
            safe_suffix = suffix if suffix in suffixes else fallback
            path = root / f"{kind}-reference-{index + 1}{safe_suffix}"
            path.write_bytes(data)
            local_media_refs.append((path, kind))
        args = _jimeng_video_args(
            prompt=prompt,
            model=model,
            duration=duration,
            aspect_ratio=aspect_ratio,
            resolution=resolution,
            references=local_refs,
            media_references=local_media_refs,
            multimodal=multimodal,
            poll_seconds=poll_seconds,
        )
        result = await run_cli(
            executable,
            args,
            cwd=root,
            timeout=min(300, _timeout(config, 180)),
        )
        _require_success("即梦视频提交", result)
        payload = _json_payload(result.stdout or result.stderr)
        failure = _failure_detail(payload)
        if failure:
            raise CliBridgeError("provider_failed", f"即梦视频提交失败：{failure}")
        task_id = _submit_id(payload)
        if not task_id:
            raise CliBridgeError("output", "即梦 CLI 未返回可恢复的 submit_id")
        return task_id


async def query_jimeng_video(*, config: dict[str, Any], submit_id: str) -> CliVideoResult | None:
    executable = _provider_executable("jimeng_cli", config)
    if not executable:
        raise CliBridgeError("missing", "未找到即梦 dreamina CLI", retryable=False)
    with tempfile.TemporaryDirectory(prefix="lingua-jimeng-video-query-") as temp:
        root = Path(temp)
        result = await run_cli(
            executable,
            ["query_result", f"--submit_id={submit_id}", f"--download_dir={root}"],
            cwd=root,
            timeout=min(300, _timeout(config, 180)),
        )
        _require_success("即梦视频查询", result)
        payload = _json_payload(result.stdout or result.stderr)
        failure = _failure_detail(payload)
        if failure:
            raise CliBridgeError("provider_failed", f"即梦生成失败：{failure}")
        media = await _collect_media(root, payload, suffixes=VIDEO_SUFFIXES, limit=MAX_VIDEO_BYTES)
        if not media:
            return None
        name, data, source_url = media[0]
        if not data:
            raise CliBridgeError("output", "即梦视频产物为空", retryable=False)
        mime = mimetypes.guess_type(name)[0] or "video/mp4"
        return CliVideoResult(name=name, mime=mime, data=data, source_url=source_url)

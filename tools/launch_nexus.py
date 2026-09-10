#!/usr/bin/env python3
"""一键启动 NEXUS 开发工作台。

默认 desktop 模式使用 SQLite 与 API 进程内任务队列，不依赖 Docker、PostgreSQL、Redis
或独立 Arq worker；`--mode developer` 保留 PostgreSQL + Redis 开发拓扑，`--mode docker`
保留全容器拓扑。每次执行先停掉上一次拉起的 API / worker / Web / 桌面壳，再启动所选拓扑。
服务脱离终端运行，日志在 data/logs/，pid 在 data/run/。
`--dist` 单独构建签名包，不是日常开发启动流程的一部分。默认始终打开当前源码的
Electron 壳；只有显式传入 `--installed` 才打开 `/Applications/NEXUS.app`。

改了代码忘记重启时再跑一遍就行，不用先找进程。
"""

from __future__ import annotations

import argparse
import contextlib
import ipaddress
import json
import os
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SERVER_DIR = PROJECT_ROOT / "server"
WEB_DIR = PROJECT_ROOT / "web"
DESKTOP_DIR = PROJECT_ROOT / "desktop"
COMPOSE_FILE = PROJECT_ROOT / "deploy" / "docker-compose.yml"
LOG_DIR = PROJECT_ROOT / "data" / "logs"
RUN_DIR = PROJECT_ROOT / "data" / "run"
DESKTOP_DATA_DIR = PROJECT_ROOT / "data" / "desktop"
DESKTOP_DATABASE = DESKTOP_DATA_DIR / "nexus.sqlite3"
DESKTOP_QUEUE = DESKTOP_DATA_DIR / "queue.sqlite3"
DESKTOP_MEDIA = DESKTOP_DATA_DIR / "media"
DESKTOP_MODELS = DESKTOP_DATA_DIR / "models"
DESKTOP_GRAMMAR = DESKTOP_DATA_DIR / "grammar"
DESKTOP_BACKUPS = DESKTOP_DATA_DIR / "backups"
DOCKER_PORT = 8080
LOCAL_PORT = 5173
API_PORT = 8100
ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
IS_WIN = os.name == "nt"
IS_MAC = sys.platform == "darwin"
NEXUS_APP = Path("/Applications/NEXUS.app")
NEXUS_EXECUTABLE = NEXUS_APP / "Contents" / "MacOS" / "NEXUS"
# 打包前那版 ad-hoc 包：签名身份每次构建都变，TCC 授权记在它名下已经没用
LEGACY_APP = Path("/Applications/Lingua.app")
DIST_APP = DESKTOP_DIR / "release" / "mac-arm64" / "NEXUS.app"

# 名字 → (命令行里必须都出现的词, 工作目录, 监听端口)：三路找旧进程用
SERVICES: dict[str, tuple[tuple[str, ...], Path, int | None]] = {
    "api": (("uvicorn", "app.main:app"), SERVER_DIR, API_PORT),
    "worker": (("arq", "worker.main"), SERVER_DIR, None),
    "web": (("vite",), WEB_DIR, LOCAL_PORT),
    "desktop": (("lectron",), DESKTOP_DIR, None),
}


def log(tag: str, message: str) -> None:
    print(f"[{tag}] {message}", flush=True)


# ---- 进程发现与停止 ----


def read_pid(name: str) -> int | None:
    path = RUN_DIR / f"{name}.pid"
    try:
        return int(path.read_text().strip())
    except (OSError, ValueError):
        return None


def pid_alive(pid: int) -> bool:
    if IS_WIN:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True
        ).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def process_cwd(pid: int) -> str | None:
    """macOS / Linux 用 lsof 取进程工作目录；只有工作目录在本项目下的才算本项目的进程。"""
    if IS_WIN:
        return None
    if sys.platform.startswith("linux"):
        try:
            return os.readlink(f"/proc/{pid}/cwd")
        except OSError:
            return None
    out = subprocess.run(
        ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], capture_output=True, text=True
    ).stdout
    for line in out.splitlines():
        if line.startswith("n"):
            return line[1:]
    return None


def pids_by_cmdline(words: tuple[str, ...], cwd: Path) -> list[int]:
    if IS_WIN:
        return []
    ps = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    found: list[int] = []
    me = os.getpid()
    for line in ps.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2:
            continue
        pid_text, command = parts
        pid = int(pid_text)
        if pid == me or not all(word in command for word in words):
            continue
        where = process_cwd(pid)
        if where and (where == str(cwd) or where.startswith(str(cwd) + os.sep)):
            found.append(pid)
    return found


def pids_by_command(text: str) -> list[int]:
    """命令行里含这段文本的进程，不看工作目录——装到 /Applications 的壳工作目录是 /。"""
    if IS_WIN:
        return []
    ps = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    me = os.getpid()
    found: list[int] = []
    for line in ps.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and text in parts[1] and int(parts[0]) != me:
            found.append(int(parts[0]))
    return found


def pids_by_port(port: int) -> list[int]:
    if IS_WIN:
        out = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True
        ).stdout
        pids: list[int] = []
        for line in out.splitlines():
            cols = line.split()
            if len(cols) >= 5 and cols[1].endswith(f":{port}") and cols[3] == "LISTENING":
                pids.append(int(cols[4]))
        return pids
    out = subprocess.run(
        ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"], capture_output=True, text=True
    ).stdout
    return [int(p) for p in out.split()]


def terminate(pids: list[int], label: str) -> None:
    live = [p for p in dict.fromkeys(pids) if pid_alive(p)]
    if not live:
        return
    for pid in live:
        try:
            if IS_WIN:
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
            else:
                os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and any(pid_alive(p) for p in live):
        time.sleep(0.2)
    for pid in live:
        if pid_alive(p := pid) and not IS_WIN:
            with contextlib.suppress(OSError):
                os.kill(p, signal.SIGKILL)
    log("STOP", f"{label}：停掉 {len(live)} 个进程 {live}")


def stop_service(name: str) -> None:
    words, cwd, port = SERVICES[name]
    pids: list[int] = []
    if (pid := read_pid(name)) is not None:
        pids.append(pid)
    pids.extend(pids_by_cmdline(words, cwd))
    if name == "desktop" and IS_MAC:
        pids.extend(pids_by_command(str(NEXUS_EXECUTABLE)))
    if port is not None:
        pids.extend(pids_by_port(port))
    terminate(pids, name)
    (RUN_DIR / f"{name}.pid").unlink(missing_ok=True)


def stop_all() -> None:
    for name in ("desktop", "web", "worker", "api"):
        stop_service(name)
    (RUN_DIR / "profile").unlink(missing_ok=True)


# ---- 启动 ----


def spawn(name: str, command: list[str], cwd: Path, env: dict[str, str] | None = None) -> int:
    """脱离终端起进程：独立会话、日志落文件、pid 记文件。关掉终端窗口它们还在。"""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    out = open(LOG_DIR / f"{name}.log", "ab")  # noqa: SIM115 - 交给子进程持有
    out.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} start =====\n".encode())
    kwargs: dict = {
        "cwd": cwd,
        "stdin": subprocess.DEVNULL,
        "stdout": out,
        "stderr": out,
        "env": env,
    }
    if IS_WIN:
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(
            subprocess, "DETACHED_PROCESS", 0
        )
    else:
        kwargs["start_new_session"] = True
    proc = subprocess.Popen(command, **kwargs)
    (RUN_DIR / f"{name}.pid").write_text(str(proc.pid))
    log("START", f"{name} pid {proc.pid}，日志 data/logs/{name}.log")
    return proc.pid


def require_process_running(name: str, pid: int, delay: float = 0.0) -> None:
    if delay > 0:
        time.sleep(delay)
    if not pid_alive(pid):
        raise RuntimeError(f"{name} 启动后立即退出：tail -50 data/logs/{name}.log")


def venv_bin(tool: str) -> Path:
    scripts = "Scripts" if IS_WIN else "bin"
    suffix = ".exe" if IS_WIN else ""
    return SERVER_DIR / ".venv" / scripts / f"{tool}{suffix}"


def pnpm_command(*args: str) -> list[str]:
    executable = shutil.which("pnpm")
    if executable is None:
        raise RuntimeError("没有 pnpm：先安装 Node.js 22，再执行 npm install -g pnpm@11")
    if IS_WIN and Path(executable).suffix.lower() in {".cmd", ".bat", ".ps1"}:
        # Run the JS entry directly: CreateProcess cannot execute npm's batch shim.
        # This also keeps spaces and shell metacharacters in project paths literal.
        base = Path(executable).parent
        candidates = (
            base / "node_modules/pnpm/bin/pnpm.cjs",
            base / "node_modules/corepack/dist/pnpm.js",
        )
        node = shutil.which("node")
        for candidate in candidates:
            if node and candidate.is_file():
                return [node, str(candidate), *args]
        raise RuntimeError("无法定位 pnpm 的 Node 入口，请执行 npm install -g pnpm@11 后重试")
    return [executable, *args]


def ensure_deps() -> None:
    """首次跑：服务端 uv sync、前端与壳 pnpm install。已经装好的什么都不做。"""
    if not venv_bin("uvicorn").is_file():
        if shutil.which("uv") is None:
            raise RuntimeError(
                "没有 uv：Windows 执行 winget install --id astral-sh.uv -e；"
                "macOS 执行 brew install uv"
            )
        log("DEPS", "server/.venv 不在，uv sync")
        subprocess.run(["uv", "sync"], cwd=SERVER_DIR, check=True)
    if shutil.which("pnpm") is None:
        raise RuntimeError("没有 pnpm：安装 Node.js 22 后执行 npm install -g pnpm@11")
    if not (WEB_DIR / "node_modules").is_dir():
        log("DEPS", "web/node_modules 不在，pnpm install")
        subprocess.run(pnpm_command("install", "--frozen-lockfile"), cwd=WEB_DIR, check=True)
    if not electron_bin().is_file():
        log("DEPS", "desktop/node_modules 不在，pnpm install（Electron 二进制走 npmmirror）")
        env = {**os.environ, "ELECTRON_MIRROR": ELECTRON_MIRROR}
        subprocess.run(
            pnpm_command("install", "--frozen-lockfile"), cwd=DESKTOP_DIR, check=True, env=env
        )

def electron_bin() -> Path:
    if IS_WIN:
        return DESKTOP_DIR / "node_modules/electron/dist/electron.exe"
    return DESKTOP_DIR / "node_modules/.bin/electron"


def desktop_build_required() -> bool:
    """Electron 源码、构建配置或产物集变化时才需要重新编译。"""
    source_dir = DESKTOP_DIR / "src"
    output_dir = DESKTOP_DIR / "dist"
    sources = sorted(source_dir.rglob("*.ts"))
    if not sources:
        return True

    expected_outputs = {
        output_dir / source.relative_to(source_dir).with_suffix(".js") for source in sources
    }
    actual_outputs = set(output_dir.rglob("*.js")) if output_dir.is_dir() else set()
    if actual_outputs != expected_outputs:
        return True

    build_inputs = [DESKTOP_DIR / "package.json", DESKTOP_DIR / "tsconfig.json", *sources]
    try:
        newest_input = max(path.stat().st_mtime_ns for path in build_inputs)
        oldest_output = min(path.stat().st_mtime_ns for path in expected_outputs)
    except OSError:
        return True
    return newest_input > oldest_output


# ---- 桌面壳打包（CR-010 D-7） ----


def codesign_info(app_path: Path) -> dict[str, str] | None:
    """codesign -dv 的键值行（stderr）；没签名或不存在返回 None。
    同名键只留第一条：Authority 链的头一条才是签名者。"""
    if not app_path.is_dir():
        return None
    result = subprocess.run(
        ["codesign", "-dv", "--verbose=2", str(app_path)], capture_output=True, text=True
    )
    if result.returncode != 0:
        return None
    info: dict[str, str] = {}
    for line in result.stderr.splitlines():
        key, sep, value = line.partition("=")
        if sep:
            info.setdefault(key.strip(), value.strip())
    return info


def is_adhoc(info: dict[str, str]) -> bool:
    return info.get("Signature") == "adhoc" or info.get("TeamIdentifier", "not set") == "not set"


def nexus_signed() -> bool:
    info = codesign_info(NEXUS_APP)
    return info is not None and not is_adhoc(info)


def codesigning_identities() -> list[tuple[str, str]]:
    out = subprocess.run(
        ["security", "find-identity", "-v", "-p", "codesigning"], capture_output=True, text=True
    ).stdout
    identities: list[tuple[str, str]] = []
    for line in out.splitlines():
        start, end = line.find('"'), line.rfind('"')
        fields = line[:start].split() if start >= 0 else []
        fingerprint = next((field for field in fields if len(field) == 40), "")
        if 0 <= start < end and fingerprint:
            identities.append((fingerprint, line[start + 1 : end]))
    return identities


def resolve_identity(value: str, identities: list[tuple[str, str]]) -> str:
    """显示名先换成 SHA-1；中文证书名经 electron-builder 传给 codesign 会乱码。"""
    if re.fullmatch(r"[0-9A-Fa-f]{40}", value):
        return value
    return next((fingerprint for fingerprint, name in identities if name == value), value)


def pick_identity(explicit: str | None) -> str:
    """--identity > CSC_NAME > 钥匙串里唯一名称的 Apple Development。"""
    identities = codesigning_identities()
    if explicit:
        return resolve_identity(explicit, identities)
    if os.environ.get("CSC_NAME"):
        return resolve_identity(os.environ["CSC_NAME"], identities)
    development: dict[str, str] = {}
    for fingerprint, name in identities:
        if name.startswith("Apple Development"):
            development.setdefault(name, fingerprint)
    if len(development) == 1:
        name, fingerprint = next(iter(development.items()))
        log("DIST", f"用钥匙串里的开发证书签名：{name}")
        return fingerprint
    if not development:
        raise RuntimeError(
            "钥匙串里没有 Apple Development 证书：Xcode › Settings › Accounts 登录 Apple ID "
            "会自动生成一张。ad-hoc 不行——TCC 把麦克风 / 辅助功能授权绑在签名身份上，"
            "ad-hoc 每次构建都是新身份"
        )
    listing = "\n".join(f"  {index + 1}) {name}" for index, name in enumerate(development))
    raise RuntimeError(
        f"钥匙串里有多种开发证书，用 --identity 指定名称或 SHA-1（或设 CSC_NAME）：\n{listing}"
    )


def identity_display_name(fingerprint: str) -> str:
    return next(
        (name for candidate, name in codesigning_identities() if candidate == fingerprint),
        fingerprint,
    )


def sign_app_by_fingerprint(app_path: Path, fingerprint: str) -> None:
    """证书名含非 ASCII 字符时绕过 electron-builder 的身份名转码。"""
    inherit = DESKTOP_DIR / "build" / "entitlements.mac.inherit.plist"
    main = DESKTOP_DIR / "build" / "entitlements.mac.plist"

    def sign(target: Path, entitlements: Path | None = None) -> None:
        command = ["codesign", "--force", "--timestamp", "--options", "runtime"]
        if entitlements is not None:
            command.extend(["--entitlements", str(entitlements)])
        command.extend(["--sign", fingerprint, str(target)])
        if subprocess.run(command).returncode != 0:
            raise RuntimeError(f"按证书 SHA-1 签名失败：{target}")

    nested = [
        path
        for path in app_path.rglob("*")
        if path.is_file()
        and not path.is_symlink()
        and (path.stat().st_mode & 0o111 or path.suffix in {".dylib", ".node", ".so"})
    ]
    for path in sorted(nested, key=lambda item: len(item.parts), reverse=True):
        kind = subprocess.run(
            ["file", "-b", str(path)], capture_output=True, text=True, check=True
        ).stdout
        if "Mach-O" in kind:
            sign(path)

    bundles = [
        path
        for path in app_path.rglob("*")
        if path.is_dir() and path.suffix in {".app", ".framework", ".xpc"}
    ]
    for path in sorted(bundles, key=lambda item: len(item.parts), reverse=True):
        sign(path, inherit if path.suffix == ".app" else None)
    sign(app_path, main)


def dist_desktop(identity: str | None, replace_legacy: bool) -> int:
    """pnpm dist:mac → codesign 校验 → ditto 装到 /Applications/NEXUS.app。不起服务，不碰旧进程。"""
    if not IS_MAC:
        raise RuntimeError("--dist 只做 macOS 包")
    if shutil.which("pnpm") is None:
        raise RuntimeError("没有 pnpm：安装 Node.js 22 后执行 npm install -g pnpm@11")
    if not electron_bin().is_file():
        log("DEPS", "desktop/node_modules 不在，pnpm install（Electron 二进制走 npmmirror）")
        install_env = {**os.environ, "ELECTRON_MIRROR": ELECTRON_MIRROR}
        subprocess.run(
            pnpm_command("install", "--frozen-lockfile"),
            cwd=DESKTOP_DIR, check=True, env=install_env,
        )
    name = pick_identity(identity)
    display_name = identity_display_name(name)
    env = {**os.environ, "CSC_NAME": name, "ELECTRON_MIRROR": ELECTRON_MIRROR}
    if display_name.isascii():
        log("DIST", f"pnpm dist:mac，CSC_NAME={name}")
        if subprocess.run(["pnpm", "dist:mac"], cwd=DESKTOP_DIR, env=env).returncode != 0:
            raise RuntimeError("electron-builder 失败，看上面的报错")
    else:
        log("DIST", f"证书名含非 ASCII 字符，构建后按 SHA-1 签名：{name}")
        unsigned_env = {
            key: value for key, value in env.items() if key not in {"CSC_NAME", "CSC_LINK"}
        }
        unsigned_env["CSC_IDENTITY_AUTO_DISCOVERY"] = "false"
        commands = (
            pnpm_command("build"),
            ["pnpm", "exec", "electron-builder", "--mac", "--arm64", "--dir"],
        )
        for command in commands:
            if subprocess.run(command, cwd=DESKTOP_DIR, env=unsigned_env).returncode != 0:
                raise RuntimeError("electron-builder 未签名构建失败，看上面的报错")
        sign_app_by_fingerprint(DIST_APP, name)
        package = [
            "pnpm",
            "exec",
            "electron-builder",
            "--mac",
            "--arm64",
            "--prepackaged",
            str(DIST_APP),
        ]
        if subprocess.run(package, cwd=DESKTOP_DIR, env=unsigned_env).returncode != 0:
            raise RuntimeError("签名应用的 dmg/zip 打包失败，看上面的报错")
    if not DIST_APP.is_dir():
        raise RuntimeError(f"没找到产物 {DIST_APP}")
    verify = subprocess.run(
        ["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(DIST_APP)],
        capture_output=True,
        text=True,
    )
    if verify.returncode != 0:
        raise RuntimeError(f"codesign --verify 不过：{verify.stderr.strip()}")
    info = codesign_info(DIST_APP) or {}
    if is_adhoc(info):
        raise RuntimeError("产物是 ad-hoc 签名，说明 CSC_NAME 没生效；装了授权也会次次重来，不装")
    log("DIST", f"签名校验通过：{info.get('Authority', '?')}，Team {info.get('TeamIdentifier')}")
    try:
        if NEXUS_APP.exists():
            log("DIST", f"移除旧的 {NEXUS_APP}")
            shutil.rmtree(NEXUS_APP)
        # ditto 保留签名与扩展属性，shutil.copytree 会把 resource fork 丢掉，Gatekeeper 直接拒
        if subprocess.run(["ditto", str(DIST_APP), str(NEXUS_APP)]).returncode != 0:
            raise RuntimeError(f"装到 {NEXUS_APP} 失败")
    except PermissionError as exc:
        raise RuntimeError(f"没有权限写 {NEXUS_APP}：{exc}") from exc
    installed = subprocess.run(
        ["codesign", "--verify", "--deep", "--strict", str(NEXUS_APP)],
        capture_output=True,
        text=True,
    )
    if installed.returncode != 0:
        raise RuntimeError(f"装好的包签名校验不过：{installed.stderr.strip()}")
    log("DIST", f"已安装 {NEXUS_APP}。第一次起来会要麦克风授权；换证书等于换身份，授权要重来")
    if LEGACY_APP.exists():
        if replace_legacy:
            shutil.rmtree(LEGACY_APP)
            log("DIST", f"已移除过时的 ad-hoc 包 {LEGACY_APP}")
        else:
            log(
                "WARN",
                f"{LEGACY_APP} 还在（打包前的 ad-hoc 包，授权已无用）：--replace-legacy 移除",
            )
    return 0


def compose_command(*args: str) -> list[str]:
    return ["docker", "compose", "-f", str(COMPOSE_FILE), *args]


def docker_ready() -> bool:
    try:
        return subprocess.run(["docker", "info"], capture_output=True, timeout=15).returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def ensure_docker(timeout: float) -> None:
    """Docker Desktop 没开就把它拉起来，等到 docker info 通为止。"""
    if shutil.which("docker") is None:
        raise RuntimeError("没有 docker 命令：先装 Docker Desktop。")
    if docker_ready():
        return
    log("DOCKER", "Docker 没在跑，拉起 Docker Desktop…")
    if IS_MAC:
        subprocess.run(["open", "-a", "Docker"], check=False)
    elif IS_WIN:
        exe = (
            Path(os.environ.get("PROGRAMFILES", r"C:\Program Files"))
            / "Docker"
            / "Docker"
            / "Docker Desktop.exe"
        )
        subprocess.Popen([str(exe)]) if exe.is_file() else log(
            "WARN", f"找不到 {exe}，请手动打开 Docker Desktop"
        )
    else:
        subprocess.run(["systemctl", "start", "docker"], check=False)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if docker_ready():
            log("DOCKER", "Docker 就绪")
            return
        time.sleep(3)
    raise RuntimeError(f"等了 {timeout:g} 秒 Docker 还没就绪，打开 Docker Desktop 看看它卡在哪。")


def compose_healthy(service: str) -> bool:
    out = subprocess.run(
        compose_command("ps", "--format", "json", service),
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
    ).stdout.strip()
    for line in out.splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("Health") == "healthy" or (
            row.get("State") == "running" and not row.get("Health")
        ):
            return True
    return False


def ensure_databases(timeout: float) -> None:
    up = compose_command("up", "-d", "--remove-orphans", "postgres", "redis")
    if subprocess.run(up, cwd=PROJECT_ROOT).returncode != 0:
        raise RuntimeError("docker compose up postgres redis 失败")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if compose_healthy("postgres") and compose_healthy("redis"):
            log("DOCKER", "postgres 与 redis 健康")
            return
        time.sleep(2)
    raise RuntimeError(
        "postgres / redis 迟迟不健康：docker compose -f deploy/docker-compose.yml logs postgres"
    )


def migrate() -> None:
    log("DB", "alembic upgrade head")
    result = subprocess.run([str(venv_bin("alembic")), "upgrade", "head"], cwd=SERVER_DIR)
    if result.returncode != 0:
        raise RuntimeError("迁移失败，看上面的报错")


def wait_http(url: str, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status < 500:
                    return True
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(1)
    return False


def desktop_api_env() -> dict[str, str]:
    return {
        **os.environ,
        "LINGUA_RUNTIME_PROFILE": "desktop",
        "LINGUA_DATABASE_URL": f"sqlite+aiosqlite:///{DESKTOP_DATABASE}",
        "LINGUA_DESKTOP_QUEUE_PATH": str(DESKTOP_QUEUE),
        "LINGUA_MEDIA_ROOT": str(DESKTOP_MEDIA),
        "LINGUA_LOCAL_MODELS_ROOT": str(DESKTOP_MODELS),
        "LINGUA_GRAMMAR_DOCS_ROOT": str(DESKTOP_GRAMMAR),
        "LINGUA_GRAMMAR_DOCS_BACKUP_DIR": str(DESKTOP_BACKUPS / "grammar"),
        "LINGUA_VAULT_KEY_BACKEND": "file",
        "LINGUA_API_BASE_URL": f"http://127.0.0.1:{API_PORT}",
        "LINGUA_GOOGLE_REDIRECT_BASE": f"http://127.0.0.1:{API_PORT}",
    }


def alembic_head() -> str:
    result = subprocess.run(
        [str(venv_bin("alembic")), "heads"],
        cwd=SERVER_DIR,
        capture_output=True,
        text=True,
        check=False,
    )
    heads = re.findall(r"^([0-9a-f]+)\s+\(head\)$", result.stdout, flags=re.MULTILINE)
    if result.returncode != 0 or len(heads) != 1:
        raise RuntimeError("无法确定唯一的 Alembic head，不能创建桌面 SQLite 基线")
    return heads[0]


def ensure_desktop_database() -> None:
    for directory in (
        DESKTOP_DATA_DIR,
        DESKTOP_MEDIA,
        DESKTOP_MODELS,
        DESKTOP_GRAMMAR,
        DESKTOP_BACKUPS,
    ):
        directory.mkdir(parents=True, exist_ok=True)
    revision = alembic_head()
    if DESKTOP_DATABASE.is_file():
        try:
            with contextlib.closing(sqlite3.connect(DESKTOP_DATABASE)) as connection:
                current = connection.execute("SELECT version_num FROM alembic_version").fetchone()
        except sqlite3.Error as exc:
            raise RuntimeError(f"桌面 SQLite 无法读取：{exc}") from exc
        if current is None or current[0] != revision:
            result = subprocess.run(
                [str(venv_bin("python")), "-m", "scripts.upgrade_desktop",
                 str(DESKTOP_DATABASE), "--backups", str(DESKTOP_BACKUPS)],
                cwd=SERVER_DIR, capture_output=True, text=True, check=False,
            )
            if result.returncode:
                raise RuntimeError(f"桌面 SQLite 升级失败：{result.stderr}")
        install_public_content()
        return
    log("DB", f"创建桌面 SQLite 基线：{DESKTOP_DATABASE}")
    result = subprocess.run(
        [
            str(venv_bin("python")),
            "-m",
            "scripts.build_desktop_baseline",
            str(DESKTOP_DATABASE),
            "--revision",
            revision,
        ],
        cwd=SERVER_DIR,
        check=False,
    )
    if result.returncode != 0:
        DESKTOP_DATABASE.unlink(missing_ok=True)
        raise RuntimeError("桌面 SQLite 基线创建失败")
    install_public_content()


def install_public_content() -> None:
    starter = PROJECT_ROOT / "starter-content"
    if (starter / "manifest.json").is_file():
        subprocess.run(
            [str(venv_bin("python")), "-m", "scripts.install_public_content",
             "--pack", str(starter), "--database", str(DESKTOP_DATABASE),
             "--media", str(DESKTOP_MEDIA), "--grammar", str(DESKTOP_GRAMMAR)],
            cwd=SERVER_DIR, check=True,
        )


def start_services(timeout: float, *, desktop: bool) -> None:
    api_env = desktop_api_env() if desktop else {
        **os.environ,
        "LINGUA_API_BASE_URL": f"http://127.0.0.1:{API_PORT}",
    }
    api_command = [
        str(venv_bin("uvicorn")),
        "app.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        str(API_PORT),
    ]
    api_pid = spawn("api", api_command, SERVER_DIR, api_env)
    worker_pid = None
    if not desktop:
        worker_pid = spawn(
            "worker",
            [str(venv_bin("arq")), "worker.main.WorkerSettings"],
            SERVER_DIR,
        )
    web_pid = spawn(
        "web",
        pnpm_command("dev", "--host", "0.0.0.0", "--port", str(LOCAL_PORT), "--strictPort"),
        WEB_DIR,
    )
    if not wait_http(f"http://127.0.0.1:{API_PORT}/healthz", timeout):
        raise RuntimeError(f"API {timeout:g} 秒内没起来：tail -50 data/logs/api.log")
    require_process_running("api", api_pid)
    log("API", f"http://127.0.0.1:{API_PORT} 健康")
    if not wait_http(f"http://127.0.0.1:{LOCAL_PORT}/", timeout):
        raise RuntimeError(f"Web {timeout:g} 秒内没起来：tail -50 data/logs/web.log")
    require_process_running("web", web_pid)
    log("WEB", f"http://127.0.0.1:{LOCAL_PORT} 可访问")
    if worker_pid is None:
        log("WORKER", "SQLite 任务队列在 API 进程内运行")
    else:
        require_process_running("worker", worker_pid)
        log("WORKER", f"Arq worker 运行中（pid {worker_pid}）")


def desktop_env() -> dict[str, str]:
    return {
        "LINGUA_URL": f"http://127.0.0.1:{LOCAL_PORT}",
        "LINGUA_API_URL": f"http://127.0.0.1:{API_PORT}",
        "LINGUA_API_BASE_URL": f"http://127.0.0.1:{API_PORT}",
        "LINGUA_REPO_ROOT": str(PROJECT_ROOT),
    }


def start_installed_desktop() -> None:
    """显式打开已安装的 NEXUS.app：`open --env`（macOS 15 起有）把地址传进去，
    壳会记进 userData/launch.json，登录项拉起时没有环境变量也能接上同一套服务。"""
    if not (IS_MAC and nexus_signed()):
        raise RuntimeError(f"没有可用的已签名安装包：{NEXUS_APP}")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    desktop_log = str(LOG_DIR / "desktop.log")
    command = ["open", "-a", str(NEXUS_APP), "--stdout", desktop_log, "--stderr", desktop_log]
    for key, value in desktop_env().items():
        command += ["--env", f"{key}={value}"]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        reason = result.stderr.strip() or f"退出码 {result.returncode}"
        raise RuntimeError(f"open -a NEXUS 失败：{reason}")
    time.sleep(1.5)
    pids = pids_by_command(str(NEXUS_EXECUTABLE))
    if pids:
        (RUN_DIR / "desktop.pid").write_text(str(pids[0]))
    if not pids:
        raise RuntimeError("已安装的 NEXUS.app 打开后未找到运行进程：查看 data/logs/desktop.log")
    log("DESKTOP", f"open -a NEXUS（已安装包，pid {pids[0]}），日志 data/logs/desktop.log")


def start_desktop(use_installed: bool = False) -> None:
    if use_installed:
        start_installed_desktop()
        return
    if not electron_bin().is_file():
        raise RuntimeError("桌面壳没安装：desktop/node_modules 缺少 electron")
    if desktop_build_required():
        log("DESKTOP", "源码或构建配置已变更，tsc 编译壳")
        if subprocess.run(pnpm_command("build"), cwd=DESKTOP_DIR, check=False).returncode != 0:
            raise RuntimeError("桌面壳编译失败：cd desktop && pnpm build")
    else:
        log("DESKTOP", "复用未过期的 desktop/dist")
    pid = spawn("desktop", [str(electron_bin()), "."], DESKTOP_DIR, {**os.environ, **desktop_env()})
    require_process_running("desktop", pid, delay=1.5)
    log("DESKTOP", f"源码 Electron 壳运行中（pid {pid}）")


# ---- 展示 ----


def lan_addresses() -> list[str]:
    found: list[str] = []
    try:
        candidates = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except socket.gaierror:
        candidates = []
    for candidate in candidates:
        address = candidate[4][0]
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError:
            continue
        if parsed.is_loopback or parsed.is_link_local or not parsed.is_private:
            continue
        if address not in found:
            found.append(address)
    return found


def print_urls(port: int) -> None:
    print(f"本机访问：http://127.0.0.1:{port}")
    for address in lan_addresses():
        print(f"局域网访问：http://{address}:{port}")


def status() -> int:
    try:
        profile = (RUN_DIR / "profile").read_text(encoding="utf-8").strip()
    except OSError:
        profile = "unknown"
    for name, (_words, _cwd, port) in SERVICES.items():
        pid = read_pid(name)
        alive = pid is not None and pid_alive(pid)
        extra = ""
        if port is not None:
            extra = f"，端口 {port} {'在听' if pids_by_port(port) else '没人听'}"
        state = "进程内（随 API）" if name == "worker" and profile == "desktop" else (
            "运行中" if alive else "未运行"
        )
        print(f"{name:8s} {state}{f'（pid {pid}）' if alive else ''}{extra}")
    print(f"运行档：{profile}")
    api_ok = wait_http(f"http://127.0.0.1:{API_PORT}/healthz", 3)
    print(f"API 健康检查：{'通过' if api_ok else '不通'}")
    print(f"Docker：{'就绪' if docker_ready() else '没在跑'}")
    if IS_MAC:
        info = codesign_info(NEXUS_APP)
        if info is None:
            print(f"桌面壳包：{NEXUS_APP} 未安装（--dist 构建），启动用开发壳")
        else:
            signed = (
                "已签名" if not is_adhoc(info) else "ad-hoc 签名，启动时不会用它（重新 --dist）"
            )
            print(f"桌面壳包：{NEXUS_APP} {signed}，Team {info.get('TeamIdentifier', 'not set')}")
        if LEGACY_APP.exists():
            print(f"旧包：{LEGACY_APP} 还在（--dist --replace-legacy 移除）")
    return 0


# ---- 入口 ----


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="一键启动 NEXUS 本机开发工作台（每次都重启一遍）")
    parser.add_argument("--no-open", action="store_true", help="起完服务不开桌面壳也不开浏览器")
    parser.add_argument("--browser", action="store_true", help="开浏览器而不是桌面壳")
    parser.add_argument(
        "--installed",
        action="store_true",
        help="显式打开 /Applications/NEXUS.app；默认打开当前源码 Electron 壳",
    )
    parser.add_argument(
        "--stop", action="store_true", help="停掉 API / worker / Web / 桌面壳（Docker 容器留着）"
    )
    parser.add_argument("--status", action="store_true", help="看各进程状态")
    parser.add_argument("--print-only", action="store_true", help="只显示访问地址")
    parser.add_argument(
        "--mode",
        choices=("desktop", "developer", "docker", "local"),
        default="desktop",
        help=("desktop SQLite（默认）；developer PostgreSQL/Redis；"
              "docker 全容器；local 为 desktop 兼容别名"),
    )
    parser.add_argument("--timeout", type=float, default=180, help="每一步最长等待秒数")
    parser.add_argument(
        "--dist",
        action="store_true",
        help="构建并签名桌面壳，装到 /Applications/NEXUS.app（不起服务）",
    )
    parser.add_argument(
        "--identity",
        help="签名身份名称或 SHA-1；不传用 CSC_NAME 或钥匙串里唯一名称的开发证书",
    )
    parser.add_argument(
        "--replace-legacy",
        action="store_true",
        help="--dist 时顺手移除旧的 /Applications/Lingua.app（ad-hoc 包）",
    )
    args = parser.parse_args()
    if args.installed and (args.browser or args.no_open or args.mode in {"developer", "docker"}):
        parser.error("--installed 只能和 desktop 桌面启动一起使用")
    return args


def start_desktop_profile(args: argparse.Namespace) -> int:
    ensure_deps()
    log("STOP", "先停上一次拉起的进程")
    stop_all()
    try:
        ensure_desktop_database()
        start_services(args.timeout, desktop=True)
        if not args.no_open:
            if args.browser:
                webbrowser.open(f"http://127.0.0.1:{LOCAL_PORT}")
            else:
                start_desktop(use_installed=args.installed)
        RUN_DIR.mkdir(parents=True, exist_ok=True)
        (RUN_DIR / "profile").write_text("desktop\n", encoding="utf-8")
    except (Exception, KeyboardInterrupt):
        log("STOP", "本轮启动未完成，清理已拉起的 API / worker / Web / 桌面壳")
        stop_all()
        raise
    print()
    print_urls(LOCAL_PORT)
    print("数据：data/desktop/ · 日志：data/logs/ · 再跑一次就是重启 · 停掉：--stop")
    return 0


def start_developer(args: argparse.Namespace) -> int:
    ensure_deps()
    ensure_docker(args.timeout)
    log("STOP", "先停上一次拉起的进程")
    stop_all()
    try:
        ensure_databases(args.timeout)
        migrate()
        start_services(args.timeout, desktop=False)
        if not args.no_open:
            if args.browser:
                webbrowser.open(f"http://127.0.0.1:{LOCAL_PORT}")
            else:
                start_desktop()
        RUN_DIR.mkdir(parents=True, exist_ok=True)
        (RUN_DIR / "profile").write_text("developer\n", encoding="utf-8")
    except (Exception, KeyboardInterrupt):
        log("STOP", "本轮启动未完成，清理已拉起的 API / worker / Web / 桌面壳")
        stop_all()
        raise
    print()
    print_urls(LOCAL_PORT)
    print("开发服务：PostgreSQL + Redis/Arq · 日志：data/logs/ · 停掉：--stop")
    return 0


def start_docker(args: argparse.Namespace) -> int:
    ensure_docker(args.timeout)
    result = subprocess.run(compose_command("up", "-d", "--build"), cwd=PROJECT_ROOT).returncode
    if result != 0:
        return result
    log("DOCKER", "全容器拓扑已起，等健康检查…")
    if not wait_http(f"http://127.0.0.1:{DOCKER_PORT}/api/healthz", max(1, args.timeout)):
        logs_command = " ".join(compose_command("logs", "--tail=200"))
        print(
            f"超过 {args.timeout:g} 秒仍未通过健康检查：{logs_command}",
            file=sys.stderr,
        )
        return 1
    print_urls(DOCKER_PORT)
    if not args.no_open:
        webbrowser.open(f"http://127.0.0.1:{DOCKER_PORT}")
    return 0


def main() -> int:
    if IS_WIN:
        # CI and redirected Windows terminals may default to cp1252.
        # Apply this to direct Python invocations as well as the batch entry.
        os.environ["PYTHONUTF8"] = "1"
        os.environ["PYTHONIOENCODING"] = "utf-8"
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    args = parse_args()
    if args.print_only:
        print_urls(DOCKER_PORT if args.mode == "docker" else LOCAL_PORT)
        return 0
    if args.status:
        return status()
    if args.stop:
        stop_all()
        log(
            "STOP",
            "API / worker / Web / 桌面壳已停；Docker 容器留着"
            "（要停：docker compose -f deploy/docker-compose.yml down）",
        )
        return 0
    try:
        if args.dist:
            return dist_desktop(args.identity, args.replace_legacy)
        if args.mode == "docker":
            return start_docker(args)
        if args.mode == "developer":
            return start_developer(args)
        return start_desktop_profile(args)
    except RuntimeError as exc:
        log("FAIL", str(exc))
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())

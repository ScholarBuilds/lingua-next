from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import socket
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import uvicorn
from starlette.applications import Starlette
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route

from app.config import get_settings

_INTERNAL_MCP_PATHS = frozenset({"/mcp"})


def _is_internal_mcp_request(scope: dict[str, Any]) -> bool:
    if scope.get("type") != "http":
        return False
    path = str(scope.get("path") or "").rstrip("/") or "/"
    root_path = str(scope.get("root_path") or "").rstrip("/")
    if root_path and path.startswith(f"{root_path}/"):
        path = path[len(root_path) :]
    if path.startswith("/api/"):
        path = path[4:]
    return path in _INTERNAL_MCP_PATHS


def _configure_desktop_profile() -> None:
    os.environ["LINGUA_RUNTIME_PROFILE"] = "desktop"
    os.environ["LINGUA_VAULT_KEY_BACKEND"] = "file"
    get_settings.cache_clear()


def rekey_sqlite_credentials(database: Path, old_key: str) -> dict[str, int]:
    """把用旧主密钥加密的凭据字段换成本机保险箱的主密钥（迁开发库凭据用）。"""
    from domain.vault_key import load_master_key
    from domain.vault_rekey import rekey_sqlite_credentials as rekey

    new_key, source = load_master_key()
    if source != "file":
        raise RuntimeError("桌面凭据主密钥未保存到本地保险箱")
    return rekey(database, old_key, new_key)


class StartupTokenMiddleware:
    """Limit the desktop API to the Electron session that launched this process."""

    def __init__(self, app: Any, token: str) -> None:
        self.app = app
        self.token = token

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if not self.token or _is_internal_mcp_request(scope):
            await self.app(scope, receive, send)
            return
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        origin = headers.get(b"origin", b"").decode("utf-8", "ignore")
        host = headers.get(b"host", b"").decode("utf-8", "ignore")
        if origin:
            parsed = urlsplit(origin)
            if parsed.scheme != "http" or parsed.netloc != host:
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 4403, "reason": "forbidden"})
                else:
                    response = JSONResponse({"detail": "forbidden origin"}, status_code=403)
                    await response(scope, receive, send)
                return
        supplied = headers.get(b"x-nexus-startup-token", b"").decode("utf-8", "ignore")
        if not secrets.compare_digest(supplied, self.token):
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 4401, "reason": "unauthorized"})
            else:
                response = JSONResponse({"detail": "unauthorized"}, status_code=401)
                await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


def _spa_response(web_root: Path, request_path: str) -> Response:
    relative = request_path.lstrip("/")
    candidate = (web_root / relative).resolve()
    try:
        candidate.relative_to(web_root.resolve())
    except ValueError:
        return JSONResponse({"detail": "not found"}, status_code=404)
    if relative and candidate.is_file():
        return FileResponse(candidate)
    index = web_root / "index.html"
    if index.is_file():
        return FileResponse(index)
    return JSONResponse({"detail": "desktop web bundle missing"}, status_code=503)


def create_desktop_app() -> Starlette:
    from app.main import app as api_app

    settings = get_settings()
    web_root = Path(settings.desktop_web_root).expanduser()

    async def healthz(_request: Any) -> JSONResponse:
        return JSONResponse({"status": "ok", "app": settings.app_name, "profile": "desktop"})

    async def spa(request: Any) -> Response:
        return _spa_response(web_root, request.path_params.get("path", ""))

    api = StartupTokenMiddleware(api_app, settings.desktop_startup_token)
    return Starlette(
        routes=[
            Route("/healthz", healthz),
            Mount("/api", app=api),
            Route("/{path:path}", spa),
        ],
        lifespan=api_app.router.lifespan_context,
    )


def _apply_bundled_config_if_needed() -> None:
    """包里带了配置（凭据 / 部署 / 绑定 / 音色 / 设置）就按戳合并进用户库，再换成本机主密钥。

    失败不拦启动：配置合不进去用户还能自己填密钥，但要在 stderr 留下原因，戳不写、下次再试。
    """
    from domain.desktop_config import apply_bundle
    from domain.vault_key import load_master_key

    bundle_db = os.environ.get("LINGUA_DESKTOP_BUNDLE_CONFIG")
    key_file = os.environ.get("LINGUA_DESKTOP_BUNDLE_VAULT_KEY")
    if not bundle_db or not key_file:
        return
    if not Path(bundle_db).is_file() or not Path(key_file).is_file():
        return
    settings = get_settings()
    database = Path(settings.database_url.split("///", 1)[1])
    stamp_file = Path(settings.media_root).expanduser().resolve().parent / "config-stamp.json"
    try:
        local_key, source = load_master_key()
        if source != "file":
            raise RuntimeError("桌面凭据主密钥未保存到本地保险箱")
        result = apply_bundle(database, Path(bundle_db), Path(key_file), local_key, stamp_file)
    except RuntimeError as exc:
        print(
            json.dumps({"type": "config-error", "error": str(exc)}, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return
    print(
        json.dumps({"type": "config-applied", **result}, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )


def _merge_bundled_content_if_needed() -> None:
    """安装包换了内容基线而库文件已存在时，把缺的内容表合并进来（壳经环境变量给基线路径与内容戳）。"""
    from domain.desktop_content import merge_bundled_content

    baseline = os.environ.get("LINGUA_DESKTOP_BASELINE")
    stamp = os.environ.get("LINGUA_DESKTOP_CONTENT_STAMP")
    if not baseline or not stamp:
        return
    settings = get_settings()
    url = settings.database_url
    if not url.startswith("sqlite"):
        return
    database = Path(url.split("///", 1)[1])
    stamp_file = Path(settings.media_root).expanduser().resolve().parent / "content-stamp.json"
    result = merge_bundled_content(database, Path(baseline), stamp, stamp_file)
    if result.get("partial"):
        print(
            json.dumps(
                {
                    "type": "content-warning",
                    "message": "内置内容存在编号冲突，原有数据保留；待合并分组："
                    + "、".join(result["skipped_groups"]),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    if not result.get("skipped"):
        print(
            json.dumps({"type": "content-merged", **result}, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )


async def serve() -> None:
    from domain.vault_key import load_master_key

    _configure_desktop_profile()
    from sqlalchemy.engine import make_url

    from domain.desktop_migrations import upgrade_database

    database = make_url(get_settings().database_url).database
    if database:
        database_path = Path(database)
        await asyncio.to_thread(upgrade_database, database_path, database_path.parent / "backups")
    await asyncio.to_thread(_merge_bundled_content_if_needed)
    await asyncio.to_thread(_apply_bundled_config_if_needed)
    from app.db import SessionFactory
    from domain.study_stage import reconcile_status

    async with SessionFactory() as session:
        await reconcile_status(session, apply=True)
        await session.commit()
    host = "127.0.0.1"
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, 0))
    sock.listen(128)
    port = int(sock.getsockname()[1])
    os.environ["LINGUA_API_BASE_URL"] = f"http://{host}:{port}/api"
    os.environ["LINGUA_GOOGLE_REDIRECT_BASE"] = f"http://{host}:{port}/api"
    get_settings.cache_clear()
    await asyncio.to_thread(load_master_key)
    desktop_app = create_desktop_app()
    server = uvicorn.Server(
        uvicorn.Config(
            desktop_app,
            host=host,
            port=port,
            log_level=os.getenv("LINGUA_LOG_LEVEL", "info"),
            access_log=False,
        )
    )
    server_task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        while not server.started:
            if server_task.done():
                await server_task
                raise RuntimeError("桌面 API 在启动完成前退出")
            await asyncio.sleep(0.05)
        print(json.dumps({"type": "ready", "host": host, "port": port}), flush=True)
        await server_task
    finally:
        if not server_task.done():
            server.should_exit = True
            await server_task
        sock.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rekey-vault", type=Path)
    args = parser.parse_args()
    _configure_desktop_profile()
    if args.rekey_vault is not None:
        old_key = sys.stdin.readline().strip()
        if not old_key:
            raise SystemExit("标准输入中缺少旧凭据主密钥")
        result = rekey_sqlite_credentials(args.rekey_vault, old_key)
        print(json.dumps({"status": "ok", **result}, ensure_ascii=False), flush=True)
        return
    asyncio.run(serve())


if __name__ == "__main__":
    main()

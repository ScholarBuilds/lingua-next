"""媒体文件的统一 HTTP 出口（FR-389）：能交给 nginx 就交给 nginx，否则自己发。

为什么要交给 nginx
------------------
Starlette 的 `FileResponse` 用 anyio 逐 64KB 读文件，每块一次线程池往返——一个
372MB 的视频要跳 5900 多次，实测比同步读慢一个数量级，折算约 1.3 秒 CPU / GB
出流量，这些 CPU 直接从业务请求里抢。鉴权和查库留在应用（它才知道 key 在哪），
传输交给 nginx 的 sendfile，两边各做各擅长的。

开关是 `LINGUA_XACCEL_PREFIX`：
- 留空（本机开发默认）→ 走 FileResponse，不依赖 nginx，`pnpm dev` 直连 8100 照常跑
- 设成 `/__media/`（生产）→ 返回空响应 + `X-Accel-Redirect` 头，nginx 接管

同一份路由代码两种部署都对，不需要为环境写分支。
"""

from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask

from app.config import get_settings
from domain.storage import BadKeyError, get_storage

# 静态媒体的缓存策略：内容按 key 寻址（内容指纹或不可变 id），可以放心久缓存。
# 换了内容的（封面）靠 URL 上的 ?v= 版本参数失效，不靠这里。
DEFAULT_CACHE = "private, max-age=604800"


def _xaccel_target(path: Path) -> str | None:
    """把绝对路径换算成 nginx internal location 下的 URI；不在媒体根下返回 None。

    preview_cache 在仓库根 data/ 下、导出的 apkg 在系统临时目录，都不在 nginx 挂的
    那个卷里——这类文件必须回落到应用自己发，不能硬套 X-Accel。
    """
    settings = get_settings()
    prefix = settings.xaccel_prefix.strip()
    if not prefix:
        return None
    try:
        rel = path.resolve().relative_to(Path(settings.media_root).resolve())
    except (ValueError, OSError):
        return None
    if not prefix.endswith("/"):
        prefix += "/"
    # nginx 收到后会做一次 unescape，这里必须 percent-encode，
    # 否则文件名里的空格、中文、`%`、`?` 会把内部 URI 截断或指错文件
    return prefix + quote(rel.as_posix())


def file_response(
    path: Path,
    *,
    media_type: str | None = None,
    filename: str | None = None,
    headers: dict[str, str] | None = None,
    cache_control: str | None = DEFAULT_CACHE,
    background: BackgroundTask | None = None,
) -> Response:
    """按绝对路径发文件。路径在媒体根下且开了 X-Accel 就交给 nginx。

    `background`（如导出后删临时文件）与 X-Accel 不兼容——nginx 还没读完文件，
    应用侧的清理任务就跑了。带 background 的一律走 FileResponse。
    """
    if not path.is_file():
        raise HTTPException(status_code=404, detail="file not found")

    extra = dict(headers or {})
    if cache_control:
        extra.setdefault("Cache-Control", cache_control)

    target = None if background is not None else _xaccel_target(path)
    if target is None:
        return FileResponse(
            path,
            media_type=media_type,
            filename=filename,
            headers=extra,
            background=background,
        )

    # 空壳响应：只带指路的头。
    # 不要设 Accept-Ranges / ETag / Content-Length——前两个会覆盖或被丢弃，
    # 最后一个 nginx 直接忽略，设了反而让人误以为生效。
    extra["X-Accel-Redirect"] = target
    if media_type:
        # 覆盖 nginx 按扩展名的 mime 推断；媒体文件统一存成 .img/.part 之类时尤其重要
        extra["Content-Type"] = media_type
    if filename:
        extra["Content-Disposition"] = f'attachment; filename="{quote(filename)}"'
    return Response(status_code=200, headers=extra)


def media_response(
    key: str,
    *,
    media_type: str | None = None,
    filename: str | None = None,
    headers: dict[str, str] | None = None,
    cache_control: str | None = DEFAULT_CACHE,
) -> Response:
    """按存储 key 发文件（媒体根下的相对路径）。

    key 的合法性由 storage 层校验：它多半来自数据库列，脏数据不能变成任意文件读取。
    """
    storage = get_storage()
    try:
        path = storage.local_path(key)
    except BadKeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if path is None:
        # 非本地后端：这里将来接 presigned_url 302，本地后端不会走到
        raise HTTPException(status_code=501, detail="当前存储后端不支持直发文件")
    return file_response(
        path,
        media_type=media_type,
        filename=filename,
        headers=headers,
        cache_control=cache_control,
    )

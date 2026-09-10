"""素材库：分组、AI 打标、URL 批量导入（模块 17 FR-477）。

三件事共用一条底线：**资产是模块 16 的，工坊只贴归属与标签**（BR-140）。
所以这里没有任何删图的路径——删组只把 `group_id` 置空，导入走
`image_assets.ingest_one` 让指纹去重、派生尺寸、血缘照常生效。

打标复用 `image_describe` 的客户端与错误分型：它已经把「本机网关不走代理」
「别名没绑」「模型不会看图」这些坑分好型了，另起一套只会把这些坑再踩一遍。
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from uuid import uuid4

import httpx
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from domain import image_assets, image_describe
from domain.models import ImageAsset, StudioAssetGroup, StudioMediaAsset, UserPref
from domain.network_policy import routed_http_client
from domain.storage import get_storage

MAX_NAME = 60

# 打标：给模型的硬要求。中文标签而不是英文——素材库的检索框是中文用的，
# 存英文标签等于每次检索都要用户先自己翻译一遍
TAG_SETTINGS_KEY = "studio_asset_tagging"
DEFAULT_CAPTION_PROMPT = "用一句中文说清图片画的是什么、适合用在哪，40 字以内。"
DEFAULT_CLASSIFICATION_PROMPT = (
    "给出 3~8 个中文标签，覆盖题材、主体、风格、色调、用途，"
    "每个 2~6 字，不带 #。"
)
DEFAULT_TAG_USER_PROMPT = "反推这张图片的描述并完成智能分类。"
TAG_SYSTEM_PREFIX = (
    "你是素材库的标注员。看一张图，只输出 JSON 对象，字段 caption 和 tags。\n"
    "caption 必须是字符串；tags 必须是字符串数组。\n"
)
TAG_SYSTEM_SUFFIX = (
    "\n不要描述图上的文字内容，不要猜品牌名、真人姓名或版权角色的名字。"
)
MAX_TAGS = 8
MAX_CAPTION = 120

# URL 导入的护栏
IMPORT_TIMEOUT_S = 30.0
IMPORT_MAX_BYTES = 20 * 1024 * 1024

# 文件头魔数 → 真实类型。上游用 .png 的 URL 发 webp 字节是常态，
# 扩展名与 Content-Type 都不可信，只有文件头是
_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"BM", "image/bmp"),
)


class StudioAssetError(Exception):
    """分组操作不合法。`status` 由路由层原样映射为 HTTP 状态码。"""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def _now() -> datetime:
    return datetime.now(UTC)


def default_tag_settings() -> dict:
    return {
        "deployment_id": None,
        "caption_prompt": DEFAULT_CAPTION_PROMPT,
        "classification_prompt": DEFAULT_CLASSIFICATION_PROMPT,
        "user_prompt": DEFAULT_TAG_USER_PROMPT,
    }


def _clean_setting(value: object, fallback: str, limit: int) -> str:
    text = str(value or "").strip()
    return (text or fallback)[:limit]


def normalize_tag_settings(raw: object) -> dict:
    source = raw if isinstance(raw, dict) else {}
    deployment = source.get("deployment_id")
    return {
        "deployment_id": deployment if isinstance(deployment, int) and deployment > 0 else None,
        "caption_prompt": _clean_setting(
            source.get("caption_prompt"), DEFAULT_CAPTION_PROMPT, 4000
        ),
        "classification_prompt": _clean_setting(
            source.get("classification_prompt"), DEFAULT_CLASSIFICATION_PROMPT, 4000
        ),
        "user_prompt": _clean_setting(
            source.get("user_prompt"), DEFAULT_TAG_USER_PROMPT, 1000
        ),
    }


async def get_tag_settings(session: AsyncSession) -> dict:
    row = await session.get(UserPref, TAG_SETTINGS_KEY)
    return normalize_tag_settings(row.value if row is not None else None)


async def save_tag_settings(session: AsyncSession, value: dict) -> dict:
    settings = normalize_tag_settings(value)
    row = await session.get(UserPref, TAG_SETTINGS_KEY)
    if row is None:
        session.add(UserPref(key=TAG_SETTINGS_KEY, value=settings))
    else:
        row.value = settings
    await session.commit()
    return settings


def sniff_mime(data: bytes) -> str | None:
    """按文件头判真实类型；认不出返回 None。

    webp 的头是 `RIFF....WEBP`，中间四字节是长度，不能整段比。
    """
    for magic, mime in _MAGIC:
        if data.startswith(magic):
            return mime
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


# ---- 分组 ----


def group_view(row: StudioAssetGroup, count: int = 0) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "parent_id": row.parent_id,
        "count": count,
    }


async def _get_group(session: AsyncSession, group_id: int) -> StudioAssetGroup:
    row = await session.get(StudioAssetGroup, group_id)
    if row is None:
        raise StudioAssetError(f"分组不存在：{group_id}", status=404)
    return row


async def _check_parent(
    session: AsyncSession, parent_id: int | None, *, self_id: int | None
) -> None:
    """两级约束：父组必须自己是顶级，自己也不能带着子组去当别人的子组。"""
    if parent_id is None:
        return
    if self_id is not None and parent_id == self_id:
        raise StudioAssetError("分组不能挂在自己下面")
    parent = await _get_group(session, parent_id)
    if parent.parent_id is not None:
        raise StudioAssetError(
            f"素材分组只有两级：「{parent.name}」已经是二级分组，不能再往下挂"
        )
    if self_id is None:
        return
    child_count = (
        await session.execute(
            select(func.count())
            .select_from(StudioAssetGroup)
            .where(StudioAssetGroup.parent_id == self_id)
        )
    ).scalar_one()
    if child_count:
        raise StudioAssetError(f"这个分组下面还有 {child_count} 个子分组，挂过去会变成三级")


def _clean_name(name: str) -> str:
    cleaned = (name or "").strip()
    if not cleaned:
        raise StudioAssetError("分组名不能为空")
    return cleaned[:MAX_NAME]


async def list_groups(session: AsyncSession) -> list[dict]:
    """全部分组 + 每组直接挂着的资产数（不含子组，子组的数各算各的）。

    一次 group by 取全部计数，不逐组查——分组数不多，但 N+1 是这类侧栏最容易长出来的坑。
    """
    rows = (
        await session.execute(
            select(StudioAssetGroup).order_by(
                StudioAssetGroup.sort, StudioAssetGroup.id
            )
        )
    ).scalars().all()
    image_counts = dict(
        (
            await session.execute(
                select(ImageAsset.group_id, func.count())
                .where(ImageAsset.group_id.is_not(None))
                .group_by(ImageAsset.group_id)
            )
        ).all()
    )
    media_counts = dict(
        (
            await session.execute(
                select(StudioMediaAsset.group_id, func.count())
                .where(StudioMediaAsset.group_id.is_not(None))
                .group_by(StudioMediaAsset.group_id)
            )
        ).all()
    )
    return [
        group_view(row, image_counts.get(row.id, 0) + media_counts.get(row.id, 0))
        for row in rows
    ]


async def create_group(
    session: AsyncSession, *, name: str, parent_id: int | None = None
) -> dict:
    await _check_parent(session, parent_id, self_id=None)
    row = StudioAssetGroup(name=_clean_name(name), parent_id=parent_id)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return group_view(row, 0)


async def patch_group(
    session: AsyncSession,
    group_id: int,
    *,
    name: str | None = None,
    parent_id: int | None = None,
    move_parent: bool = False,
) -> dict:
    """改名或改挂靠。`move_parent=False` 时不动 parent_id——
    调用方要能表达「只改名」，否则每次改名都会顺手把组挪到顶级。"""
    row = await _get_group(session, group_id)
    if move_parent:
        await _check_parent(session, parent_id, self_id=group_id)
        row.parent_id = parent_id
    if name is not None:
        row.name = _clean_name(name)
    await session.commit()
    await session.refresh(row)
    image_count = (
        await session.execute(
            select(func.count())
            .select_from(ImageAsset)
            .where(ImageAsset.group_id == row.id)
        )
    ).scalar_one()
    media_count = (
        await session.execute(
            select(func.count())
            .select_from(StudioMediaAsset)
            .where(StudioMediaAsset.group_id == row.id)
        )
    ).scalar_one()
    return group_view(row, image_count + media_count)


async def delete_group(session: AsyncSession, group_id: int) -> int:
    """删组：解除该组资产的归属，子组升为顶级，返回被释放的资产数。

    **一张图都不删**（BR-140）。外键上的 SET NULL 在 SQLite 默认关外键约束时不生效，
    这里显式改，让行为在两种方言下一致。
    """
    row = await _get_group(session, group_id)
    released_images = (
        await session.execute(
            update(ImageAsset)
            .where(ImageAsset.group_id == group_id)
            .values(group_id=None)
        )
    ).rowcount
    released_media = (
        await session.execute(
            update(StudioMediaAsset)
            .where(StudioMediaAsset.group_id == group_id)
            .values(group_id=None)
        )
    ).rowcount
    await session.execute(
        update(StudioAssetGroup)
        .where(StudioAssetGroup.parent_id == group_id)
        .values(parent_id=None)
    )
    await session.delete(row)
    await session.commit()
    return int(released_images or 0) + int(released_media or 0)


async def move_assets(
    session: AsyncSession, asset_ids: list[int], group_id: int | None
) -> int:
    """批量改归属。`group_id=None` 即移出分组。返回真正改动的行数。"""
    if group_id is not None:
        await _get_group(session, group_id)
    moved = (
        await session.execute(
            update(ImageAsset)
            .where(ImageAsset.id.in_(asset_ids))
            .values(group_id=group_id)
        )
    ).rowcount
    await session.commit()
    return int(moved or 0)


# ---- AI 打标 ----


def _clean_tags(raw: object) -> list[str]:
    items: list[object]
    if isinstance(raw, str):
        items = list(raw.replace("，", ",").split(","))
    elif isinstance(raw, list):
        items = list(raw)
    else:
        return []
    out: list[str] = []
    for item in items:
        tag = str(item).strip().lstrip("#").strip()
        if tag and tag not in out:
            out.append(tag)
    return out[:MAX_TAGS]


async def tag_one(
    session: AsyncSession,
    asset_id: int,
    *,
    settings_override: dict | None = None,
) -> dict:
    """给一张图打标并落库。失败抛异常，由 `tag_assets` 收成逐条结果。"""
    row = await session.get(ImageAsset, asset_id)
    if row is None:
        raise image_describe.DescribeError("api", f"资产不存在：{asset_id}")

    # 打标看的是「画的是什么」，展示图（宽 768 webp）完全够，还省一大截上行字节
    key = image_assets.variant_key(row, "display")
    mime = image_assets.variant_mime(row, "display")
    data = await get_storage().read(key)
    # 复用 image_describe 的入参处理：超过 4MB 会先压，data URL 是整段塞进请求体的
    clean_mime, b64 = image_describe._prepare(data, mime)

    settings = await get_tag_settings(session)
    if settings_override:
        settings = normalize_tag_settings({**settings, **settings_override})
    system_prompt = (
        f"{TAG_SYSTEM_PREFIX}描述规则：{settings['caption_prompt']}\n"
        f"分类规则：{settings['classification_prompt']}{TAG_SYSTEM_SUFFIX}"
    )
    messages: list[dict] = [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": settings["user_prompt"]},
                {"type": "image_url", "image_url": {"url": f"data:{clean_mime};base64,{b64}"}},
            ],
        },
    ]
    deployment_id = settings["deployment_id"]
    if deployment_id is None:
        parsed, _model, _latency = await image_describe._chat(messages)
    else:
        parsed, _model, _latency = await image_describe._chat(
            messages, deployment_id=deployment_id
        )

    caption = str(parsed.get("caption") or "").strip()[:MAX_CAPTION]
    tags = _clean_tags(parsed.get("tags"))
    row.caption = caption
    row.tags = tags
    row.tagged_at = _now()
    return {"asset_id": asset_id, "caption": caption, "tags": tags}


async def tag_assets(
    session: AsyncSession,
    asset_ids: list[int],
    *,
    settings_override: dict | None = None,
) -> list[dict]:
    """批量打标，**逐条独立**：一条失败写进它自己的 error 继续下一条。

    不整批回滚是刻意的——打标是花钱的调用，已经成功的十条不该因为第十一条超时
    白花一遍。失败条的 tagged_at 保持为 null，下次筛「未打标」还能捞回来重打。
    """
    results: list[dict] = []
    for asset_id in asset_ids:
        try:
            if settings_override is None:
                results.append(await tag_one(session, asset_id))
            else:
                results.append(
                    await tag_one(
                        session,
                        asset_id,
                        settings_override=settings_override,
                    )
                )
            await session.commit()
        except Exception as exc:  # 上游异常类型不稳定（网关/存储/解析各一套），统一收敛
            await session.rollback()
            results.append(
                {"asset_id": asset_id, "caption": "", "tags": [], "error": _reason(exc)}
            )
    return results


def _reason(exc: Exception) -> str:
    """失败原因原样往上带（BR-110），别翻译成「操作失败」。"""
    message = str(exc).strip()
    return message or type(exc).__name__


# ---- URL 批量导入 ----


async def fetch_image(client: httpx.AsyncClient, url: str) -> tuple[bytes, str]:
    """拉一张图，返回 (字节, 按魔数判定的真实类型)。不合格直接抛。"""
    cleaned = (url or "").strip()
    if not cleaned.lower().startswith(("http://", "https://")):
        raise StudioAssetError(f"只支持 http/https 链接：{cleaned[:120] or '空链接'}")

    async with client.stream("GET", cleaned) as resp:
        if resp.status_code >= 400:
            raise StudioAssetError(f"HTTP {resp.status_code}")
        declared = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
        if declared and not declared.startswith("image/"):
            raise StudioAssetError(f"不是图片，Content-Type 是 {declared}")
        chunks: list[bytes] = []
        total = 0
        async for chunk in resp.aiter_bytes():
            total += len(chunk)
            if total > IMPORT_MAX_BYTES:
                # 边下边判，不等整个响应体读完——限的是内存，不是礼貌
                raise StudioAssetError(f"超过单张 {IMPORT_MAX_BYTES // 1024 // 1024}MB 上限")
            chunks.append(chunk)
    data = b"".join(chunks)
    if not data:
        raise StudioAssetError("响应体是空的")

    real = sniff_mime(data)
    if real is None:
        raise StudioAssetError("文件头不是已知图片格式（png/jpeg/webp/gif/bmp）")
    return data, real


def _import_client() -> httpx.AsyncClient:
    """导入用的 HTTP 客户端。单独一个工厂是给测试留的打桩点——
    测试换成 MockTransport，stream/aiter_bytes 那条路照跑，只是不出网。"""
    return routed_http_client(timeout=IMPORT_TIMEOUT_S, follow_redirects=True)


async def import_urls(
    session: AsyncSession,
    items: list[dict],
    *,
    group_id: int | None = None,
    auto_tag: bool = False,
) -> list[dict]:
    """服务端拉取 + 入库，逐条独立回报。

    一条失败只写它自己的 reason（原文），不影响其它条——批量导入十条挂一条就
    整批回滚，用户既不知道哪条坏了也拿不到那九条。
    """
    if group_id is not None:
        await _get_group(session, group_id)

    results: list[dict] = []
    fresh_ids: list[int] = []
    async with _import_client() as client:
        for item in items:
            url = str(item.get("url") or "").strip()
            name = str(item.get("name") or "").strip()
            try:
                # 魔数判出的类型只用来在解码前挡住伪装成图片的东西；落库的 mime 与
                # 扩展名由 ingest 内部的 Pillow 解码结果定，两者对同一段字节结论一致
                data, _real_mime = await fetch_image(client, url)
                row = await image_assets.ingest_one(
                    session,
                    data,
                    target_key="free",
                    prompt=name or url,
                    source="import",
                )
                if name and row.display_name is None:
                    row.display_name = name[:160]
                row.group_id = group_id
                await session.commit()
                fresh_ids.append(row.id)
                results.append({"url": url, "ok": True, "asset_id": row.id})
            except Exception as exc:  # httpx / Pillow / 存储各有各的异常类型
                await session.rollback()
                results.append({"url": url, "ok": False, "reason": _reason(exc)})

    if auto_tag and fresh_ids:
        # 打标失败不阻断入库（FR-477）：图已经在库里了，标可以事后补
        await tag_assets(session, fresh_ids)
    return results


# ---- 打标队列（M4 FR-484） ----

# M2 的同步打标 200 张要挂十几分钟，请求早就超时了（M2 已知余项）。改成后台任务：
# 入队即返回，进度写 Redis，前端轮询。同步端点保留——单张与小批量它更省事，
# 一次往返就拿到结果，不用为了三张图去开一个 job。
#
# 进度**必须是真实计数**（BR-110）：done/failed 各自是真跑完的条数，不按时间估、
# 不按「大概几秒一张」推。两者之和就是已处理条数，total - done - failed 是还没轮到的。

TAG_JOB_TTL_S = 3600
TAG_JOB_PREFIX = "studio:tagjob:"
TAG_JOB_TASK = "tag_assets_job"

_job_client: object | None = None


def set_job_client(client: object | None) -> None:
    """测试替身注入；传 None 恢复默认（真 Redis）。与 storage.set_storage 同款口子。"""
    global _job_client
    _job_client = client


async def job_client(client: object | None = None):
    """拿一个既能读写进度又能入队的客户端。

    arq 的 `ArqRedis` 本身就是 redis 客户端，进度存取与任务入队共用一个连接池，
    不必为了存个 JSON 再开一条。
    """
    if client is not None:
        return client
    if _job_client is not None:
        return _job_client
    from app.queue import get_queue

    return await get_queue()


def tag_job_key(job_id: str) -> str:
    return f"{TAG_JOB_PREFIX}{job_id}"


def _new_job_state(job_id: str, asset_ids: list[int]) -> dict:
    return {
        "job_id": job_id,
        "total": len(asset_ids),
        "done": 0,
        "failed": 0,
        "status": "running",
        "items": [],
    }


async def save_tag_job(state: dict, *, client: object | None = None) -> None:
    redis = await job_client(client)
    # TTL 一小时：进度是过程数据，打标结果本身早已落在 image_asset 行上，
    # 过期丢的只是这次的进度条，不是标签
    await redis.set(
        tag_job_key(state["job_id"]),
        json.dumps(state, ensure_ascii=False),
        ex=TAG_JOB_TTL_S,
    )


async def load_tag_job(job_id: str, *, client: object | None = None) -> dict | None:
    redis = await job_client(client)
    raw = await redis.get(tag_job_key(job_id))
    if raw is None:
        return None
    if isinstance(raw, bytes | bytearray):
        raw = raw.decode("utf-8")
    return json.loads(raw)


async def start_tag_job(asset_ids: list[int], *, client: object | None = None) -> dict:
    """建进度、入队，立刻返回初始状态（done=0，因为此刻真的一张都没打）。"""
    redis = await job_client(client)
    job_id = uuid4().hex
    state = _new_job_state(job_id, asset_ids)
    await save_tag_job(state, client=redis)
    await redis.enqueue_job(
        TAG_JOB_TASK, job_id, list(asset_ids), _job_id=f"{TAG_JOB_TASK}:{job_id}"
    )
    return state


async def run_tag_job(
    session: AsyncSession,
    job_id: str,
    asset_ids: list[int],
    *,
    client: object | None = None,
) -> dict:
    """后台跑批：每打完一条就把真实计数写回 Redis，前端轮询看到的是真进度。

    逐条独立与同步版同一条口径——一条失败写它自己的 error，不回滚已经花过钱的那些。
    """
    redis = await job_client(client)
    state = await load_tag_job(job_id, client=redis) or _new_job_state(job_id, asset_ids)
    state["status"] = "running"
    for asset_id in asset_ids:
        try:
            result = await tag_one(session, asset_id)
            await session.commit()
            state["done"] += 1
        except Exception as exc:  # 上游异常类型不稳定（网关/存储/解析各一套）
            await session.rollback()
            result = {"asset_id": asset_id, "caption": "", "tags": [], "error": _reason(exc)}
            state["failed"] += 1
        state["items"].append(result)
        await save_tag_job(state, client=redis)
    state["status"] = "done"
    await save_tag_job(state, client=redis)
    return state

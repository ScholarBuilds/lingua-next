"""图片资产层（模块 16 FR-411）：体检、派生尺寸、内容去重、落库。

三条约束决定了这一层的形状：

1. **图片字节不进任何 JSONB 列**（BR-101）。`step_artifact.payload` 是 JSONB，
   前端的「原始数据」调试块按 6000 字符截断，base64 塞进去会同时撑爆库行与调试
   视图。图片走 `domain/storage.py`，库里只留 key。
2. **同内容不重复落盘**。内容指纹是 sha256，第二次生成出一模一样的图只加引用。
3. **派生尺寸生成一次**。原图按用途的自然比例出，展示图与缩略图由 Pillow 派生；
   换展示位时不用回头重新调模型。
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from domain.models import ImageAsset, UserPref
from domain.storage import BadKeyError, get_storage, safe_key

# 派生尺寸。768 覆盖卡片与列表在 2x 屏下的实际像素，192 够节点缩略图与资产网格。
DISPLAY_WIDTH = 768
THUMB_WIDTH = 192
WEBP_QUALITY = 82

# Infinite-Canvas 允许把生成、上传和本地编辑结果写到三套目录。Lingua 的存储层
# 不能绕过 Storage 直接保存绝对路径，因此把同一交互映射为对象存储内的三个可配置
# 前缀；本地后端时它们就是 media_root 下的真实子目录。
STORAGE_PREFIXES_KEY = "studio_asset_storage_prefixes"
DEFAULT_STORAGE_PREFIXES = {
    "generated": "images/generated",
    "upload": "images/upload",
    "local": "images/local",
}

# 体检门槛
MIN_EDGE = 64
# 整图最大单色占比：这条只用来挡「上游返回了一张纯色图」这一种失败。
#
# 阈值放到 0.98 是有实测依据的：一张完全正常的扁平风插画（白底 + 居中绿苹果，
# gpt-image-2 实出）单色占比就有 **85.5%**。留白多本来就是这个画风的特征，
# 卡得紧就会把付过费的好图当垃圾丢掉。真正的纯色失败是 ~100%。
#
# 尤其不要照抄 scripts/fetch_covers.py 的 0.45——那条判的是「下半部分」且专治
# Gutenberg 的占位封面；拿它来判生成图，上面那张苹果第一个被杀。
MAX_FLAT_RATIO = 0.98
# 判纯色时的取样边长
SAMPLE_EDGE = 96

MIME_BY_FORMAT = {
    "PNG": "image/png",
    "JPEG": "image/jpeg",
    "WEBP": "image/webp",
}
EXT_BY_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
}


class ImageAssetError(Exception):
    """图片不可用：解析失败、尺寸异常、纯色图。消息面向调用方。"""


@dataclass(frozen=True)
class Probe:
    mime: str
    width: int
    height: int
    flat_ratio: float


def _pil():
    """延迟导入：Pillow 只有生图链路要用，其余请求不该为它付导入成本。"""
    from PIL import Image

    return Image


def probe(data: bytes) -> Probe:
    """体检：能不能解析、多大、是不是一张纯色图。"""
    image_mod = _pil()
    try:
        im = image_mod.open(io.BytesIO(data))
        im.load()
    except Exception as exc:  # Pillow 的异常类型不稳定，统一收敛
        raise ImageAssetError(f"返回的不是可解析的图片：{type(exc).__name__}") from exc
    mime = MIME_BY_FORMAT.get(im.format or "", "application/octet-stream")
    w, h = im.size
    if w < MIN_EDGE or h < MIN_EDGE:
        raise ImageAssetError(f"图片过小：{w}x{h}")
    return Probe(mime=mime, width=w, height=h, flat_ratio=flat_ratio(im))


def flat_ratio(im) -> float:
    """整图最大单色像素占比。缩到 96x96 再数，够判纯色且不吃 CPU。

    用 `getcolors` 而不是 `getdata`：后者在 Pillow 14 移除，且要把十万个像素
    拷成 Python list；前者直接给 (计数, 颜色) 对。
    """
    small = im.convert("RGB").resize((SAMPLE_EDGE, SAMPLE_EDGE))
    total = SAMPLE_EDGE * SAMPLE_EDGE
    colors = small.getcolors(maxcolors=total)
    if not colors:  # 理论上不会：maxcolors 已给到像素总数
        return 0.0
    return max(count for count, _ in colors) / total


def check(data: bytes) -> Probe:
    """体检并对不合格的直接抛（BR-107：应用到目标前必须通过体检）。"""
    result = probe(data)
    if result.flat_ratio > MAX_FLAT_RATIO:
        raise ImageAssetError(
            f"生成结果几乎是一张纯色图（单色占 {result.flat_ratio:.0%}），已丢弃"
        )
    return result


def _resize_webp(data: bytes, target_width: int) -> bytes | None:
    """等比缩到指定宽度的 webp；原图本来就更窄则不放大，返回 None。"""
    image_mod = _pil()
    im = image_mod.open(io.BytesIO(data))
    if im.width <= target_width:
        return None
    height = max(1, round(im.height * target_width / im.width))
    out = io.BytesIO()
    im.convert("RGB").resize((target_width, height), image_mod.LANCZOS).save(
        out, format="WEBP", quality=WEBP_QUALITY, method=4
    )
    return out.getvalue()


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize_storage_prefixes(raw: object) -> dict[str, str]:
    source = raw if isinstance(raw, dict) else {}
    result: dict[str, str] = {}
    for bucket, fallback in DEFAULT_STORAGE_PREFIXES.items():
        value = str(source.get(bucket) or fallback).strip().strip("/")
        try:
            normalized = safe_key(value).as_posix()
        except BadKeyError as exc:
            raise ImageAssetError(f"{bucket} 素材目录不合法：{exc}") from exc
        if len(normalized) > 200:
            raise ImageAssetError(f"{bucket} 素材目录不能超过 200 个字符")
        result[bucket] = normalized
    return result


async def get_storage_prefixes(session: AsyncSession) -> dict[str, str]:
    row = await session.get(UserPref, STORAGE_PREFIXES_KEY)
    return normalize_storage_prefixes(row.value if row is not None else None)


async def save_storage_prefixes(
    session: AsyncSession, raw: object
) -> dict[str, str]:
    prefixes = normalize_storage_prefixes(raw)
    row = await session.get(UserPref, STORAGE_PREFIXES_KEY)
    if row is None:
        session.add(UserPref(key=STORAGE_PREFIXES_KEY, value=prefixes))
    else:
        row.value = prefixes
    await session.commit()
    return prefixes


def storage_bucket(*, source: str, op: str | None) -> str:
    if op == "upload":
        return "upload"
    if source in {"local", "frame"}:
        return "local"
    return "generated"


def build_key(
    sha: str,
    mime: str,
    *,
    suffix: str = "",
    prefix: str = DEFAULT_STORAGE_PREFIXES["generated"],
) -> str:
    """按月分目录 + 指纹命名。扩展名给真实类型——本模块自己控制输出格式，
    不需要像书封那样存成 `.img` 再靠文件头嗅探。"""
    month = datetime.now(UTC).strftime("%Y%m")
    ext = EXT_BY_MIME.get(mime, "png")
    normalized_prefix = safe_key(prefix).as_posix()
    return f"{normalized_prefix}/{month}/{sha[:2]}/{sha}{suffix}.{ext}"


async def store_blob(data: bytes, key: str) -> None:
    await get_storage().write(key, data)


async def find_by_sha(session: AsyncSession, sha: str) -> ImageAsset | None:
    return (
        await session.execute(select(ImageAsset).where(ImageAsset.sha256 == sha))
    ).scalar_one_or_none()


async def ingest_one(
    session: AsyncSession,
    data: bytes,
    *,
    target_key: str,
    prompt: str,
    prompt_structure: dict | None = None,
    brief: dict | None = None,
    style_key: str | None = None,
    alias: str | None = None,
    model_reported: str | None = None,
    size_req: str | None = None,
    quality: str | None = None,
    n_index: int = 0,
    usage: dict | None = None,
    subject_domain: str | None = None,
    subject_id: int | None = None,
    run_id: int | None = None,
    step: str | None = None,
    source: str = "pipeline",
    parent_id: int | None = None,
    op: str | None = None,
) -> ImageAsset:
    """一张图入库：体检 → 落盘 → 派生 → 建行。同内容已存在则复用旧行。

    复用时不覆盖旧行的提示词：那一行记的是**这张图当初是怎么来的**，
    用第二次的提示词盖掉会让回溯失真（BR-102）。
    """
    info = check(data)
    sha = sha256_of(data)
    existing = await find_by_sha(session, sha)
    if existing is not None:
        return existing

    prefixes = await get_storage_prefixes(session)
    prefix = prefixes[storage_bucket(source=source, op=op)]
    key = build_key(sha, info.mime, prefix=prefix)
    await store_blob(data, key)

    display_key: str | None = None
    thumb_key: str | None = None
    display = _resize_webp(data, DISPLAY_WIDTH)
    if display is not None:
        display_key = build_key(sha, "image/webp", suffix=".d", prefix=prefix)
        await store_blob(display, display_key)
    thumb = _resize_webp(data, THUMB_WIDTH)
    if thumb is not None:
        thumb_key = build_key(sha, "image/webp", suffix=".t", prefix=prefix)
        await store_blob(thumb, thumb_key)

    row = ImageAsset(
        parent_id=parent_id,
        op=op,
        sha256=sha,
        storage_key=key,
        display_key=display_key,
        thumb_key=thumb_key,
        mime=info.mime,
        width=info.width,
        height=info.height,
        bytes=len(data),
        target_key=target_key,
        style_key=style_key,
        prompt=prompt,
        prompt_structure=prompt_structure,
        brief=brief,
        alias=alias,
        model_reported=model_reported,
        size_req=size_req,
        quality=quality,
        n_index=n_index,
        usage=usage,
        subject_domain=subject_domain,
        subject_id=subject_id,
        run_id=run_id,
        step=step,
        source=source,
    )
    session.add(row)
    await session.flush()
    return row


async def mark_applied(
    session: AsyncSession, asset: ImageAsset, domain: str, subject_id: int
) -> None:
    """把这张标为已应用，并把同一目标上**之前那张**降回候选。

    不降级的话，同一个本换过三次封面就有三张都写着「已应用」，而实际只有一张
    在用——状态在说谎，资产库里就分不清哪张是当前生效的那张。
    """
    await session.execute(
        update(ImageAsset)
        .where(
            ImageAsset.subject_domain == domain,
            ImageAsset.subject_id == subject_id,
            ImageAsset.status == "applied",
            ImageAsset.id != asset.id,
        )
        .values(status="candidate")
    )
    asset.subject_domain = domain
    asset.subject_id = subject_id
    asset.status = "applied"


# ---- 对外视图 ----


def asset_url(asset_id: int, variant: str = "display", version: int | str = 0) -> str:
    """图片 URL。

    两条硬约定（CLAUDE.md 踩坑索引）：
    - **必须带 `/api` 前缀**：`<img src>` 不走 fetch 助手，没前缀会被 nginx 的
      `try_files` 或 vite dev server 回落成 index.html，图片静默失败。
    - **必须带 `?v=`**：媒体响应是一周强缓存，换了图 URL 不变就一周看不到新图。
    """
    return f"/api/images/assets/{asset_id}/{variant}?v={version}"


def asset_view(asset: ImageAsset) -> dict:
    stamp = int(asset.created_at.timestamp()) if asset.created_at else 0
    return {
        "id": asset.id,
        "display_name": asset.display_name,
        "sha": asset.sha256[:12],
        "url": asset_url(asset.id, "display", stamp),
        "thumb_url": asset_url(asset.id, "thumb", stamp),
        "full_url": asset_url(asset.id, "full", stamp),
        "width": asset.width,
        "height": asset.height,
        "bytes": asset.bytes,
        "mime": asset.mime,
        "target_key": asset.target_key,
        "style_key": asset.style_key,
        "prompt": asset.prompt,
        "prompt_structure": asset.prompt_structure,
        "brief": asset.brief,
        "alias": asset.alias,
        "model": asset.model_reported,
        "size_req": asset.size_req,
        "quality": asset.quality,
        "usage": asset.usage,
        "subject_domain": asset.subject_domain,
        "subject_id": asset.subject_id,
        "run_id": asset.run_id,
        "step": asset.step,
        "source": asset.source,
        "group_id": asset.group_id,
        "caption": asset.caption,
        # tags 缺省给空数组而不是 null：前端类型是 string[]，null 会让每个用它的地方
        # 都要先判一次；而「有没有打过标」看 tagged_at，不看 tags 空不空
        "tags": asset.tags or [],
        "tagged_at": asset.tagged_at.isoformat() if asset.tagged_at else None,
        "parent_id": asset.parent_id,
        "op": asset.op,
        "status": asset.status,
        "favorite": asset.favorite,
        "created_at": asset.created_at.isoformat() if asset.created_at else None,
    }


def variant_key(asset: ImageAsset, variant: str) -> str:
    """variant → 实际存储 key；派生图缺失时回落原图，不 404。"""
    if variant == "full":
        return asset.storage_key
    if variant == "thumb":
        return asset.thumb_key or asset.display_key or asset.storage_key
    return asset.display_key or asset.storage_key


def variant_mime(asset: ImageAsset, variant: str) -> str:
    key = variant_key(asset, variant)
    return "image/webp" if key.endswith(".webp") else asset.mime

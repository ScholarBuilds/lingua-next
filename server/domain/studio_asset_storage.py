"""素材物理存储统计、引用保护与归档清理。

Infinite-Canvas 的素材设置直接枚举并删除磁盘目录；Lingua 的业务层只认 Storage key，
因此这里把同一能力收口为“逻辑目录前缀 + 已归档且无引用的对象清理”。物理删除前
会重新扫描画布、会话、任务、DAG、模板、工作流与模型调用快照，避免把仍在使用的
历史资源删成破图。
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from domain import image_assets
from domain.models import (
    Article,
    Book,
    ImageAsset,
    ImageJob,
    ModelInvocation,
    StepArtifact,
    StudioCanvas,
    StudioChat,
    StudioFlow,
    StudioFlowRun,
    StudioGptChat,
    StudioMediaAsset,
    StudioTask,
    StudioTaskEvent,
    StudioTemplate,
    StudioWorkflow,
    Wordlist,
)
from domain.storage import StorageError, get_storage

MAX_PURGE = 200
_ASSET_STRING_RE = re.compile(r"(?:asset:|/images/assets/)(\d+)(?:/|\b)")
_CAMEL_RE = re.compile(r"(?<!^)(?=[A-Z])")
_SINGLE_ID_KEYS = {
    "asset_id",
    "image_asset_id",
    "ref_asset_id",
    "source_asset_id",
    "input_asset_id",
    "parent_asset_id",
    "thumb_asset_id",
    "last_asset_id",
}
_LIST_ID_KEYS = {
    "asset_ids",
    "image_asset_ids",
    "ref_asset_ids",
    "reference_asset_ids",
    "output_asset_ids",
}
_SHA_KEYS = {"sha", "sha256", "asset_sha", "asset_sha256"}


class AssetStorageError(Exception):
    def __init__(
        self,
        message: str,
        status: int = 400,
        *,
        blocked: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.blocked = blocked or []


def _key_name(value: object) -> str:
    return _CAMEL_RE.sub("_", str(value)).replace("-", "_").lower()


def _int_id(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def collect_image_refs(
    value: object,
    candidate_ids: set[int],
    candidate_shas: dict[str, int],
) -> set[int]:
    """从持久 JSON 中找图片资产引用；media_asset_id 不会误算成图片。"""
    found: set[int] = set()

    def walk(current: object, parent_key: str = "") -> None:
        if isinstance(current, dict):
            marker = str(current.get("asset_type") or current.get("kind") or "").lower()
            for raw_key, child in current.items():
                key = _key_name(raw_key)
                if key in _SINGLE_ID_KEYS:
                    asset_id = _int_id(child)
                    if asset_id in candidate_ids:
                        found.add(asset_id)
                elif key in _LIST_ID_KEYS and isinstance(child, list):
                    for item in child:
                        asset_id = _int_id(item)
                        if asset_id in candidate_ids:
                            found.add(asset_id)
                elif key == "id" and marker in {"image", "image_asset"}:
                    asset_id = _int_id(child)
                    if asset_id in candidate_ids:
                        found.add(asset_id)
                elif key in _SHA_KEYS and isinstance(child, str):
                    asset_id = candidate_shas.get(child)
                    if asset_id is not None:
                        found.add(asset_id)
                walk(child, key)
            return
        if isinstance(current, list):
            for child in current:
                walk(child, parent_key)
            return
        if isinstance(current, str):
            for match in _ASSET_STRING_RE.finditer(current):
                asset_id = int(match.group(1))
                if asset_id in candidate_ids:
                    found.add(asset_id)

    walk(value)
    return found


# 存储 key 直接落在别的表的列里：`apply_wordlist_cover` 把 `asset.storage_key`
# 原样写进 `wordlist.cover_key`，两边指的是同一个对象。删资产时不查这张表就会把
# 单词本封面一起删成破图。
KEY_SOURCES: list[tuple[str, Any]] = [
    ("书籍封面/原件", select(Book.cover_key, Book.file_key)),
    ("文章原件", select(Article.file_key)),
    ("单词本封面", select(Wordlist.cover_key)),
    ("工作流缩略图", select(StudioWorkflow.thumbnail_key)),
    ("管线产物", select(StepArtifact.blob_key)),
    ("多媒体海报", select(StudioMediaAsset.poster_key)),
]

# 资产 id / sha 藏在 JSON 里的地方。这些引用没有外键约束，删了资产不会报任何错，
# 只会在画布、会话、任务快照里留下悬空 id。
JSON_SOURCES: list[tuple[str, Any]] = [
    ("画布", select(StudioCanvas.nodes, StudioCanvas.settings)),
    ("对话生图会话", select(StudioChat.turns)),
    ("GPT 创作会话", select(StudioGptChat.turns)),
    ("持久任务", select(StudioTask.invocation, StudioTask.result, StudioTask.source_context)),
    ("任务事件", select(StudioTaskEvent.payload)),
    (
        "持久 DAG",
        select(
            StudioFlowRun.definition_snapshot,
            StudioFlowRun.inputs,
            StudioFlowRun.source_context,
            StudioFlowRun.checkpoint,
        ),
    ),
    ("DAG 定义", select(StudioFlow.definition)),
    ("工作流目录", select(StudioWorkflow.payload, StudioWorkflow.ui_schema)),
    ("工作流资产", select(StudioTemplate.payload)),
    ("生图任务参数", select(ImageJob.options)),
    (
        "模型调用台账",
        select(ModelInvocation.request, ModelInvocation.response, ModelInvocation.context),
    ),
    ("管线产物", select(StepArtifact.payload, StepArtifact.edit_patch)),
]


async def reference_reasons(session: AsyncSession, rows: list[ImageAsset]) -> dict[int, list[str]]:
    ids = {row.id for row in rows}
    if not ids:
        return {}
    shas = {row.sha256: row.id for row in rows}
    reasons: dict[int, set[str]] = defaultdict(set)

    children = (
        await session.execute(select(ImageAsset.parent_id).where(ImageAsset.parent_id.in_(ids)))
    ).scalars()
    for asset_id in children:
        if asset_id is not None:
            reasons[asset_id].add("图片编辑血缘")

    applied = (
        await session.execute(
            select(ImageJob.applied_asset_id).where(ImageJob.applied_asset_id.in_(ids))
        )
    ).scalars()
    for asset_id in applied:
        if asset_id is not None:
            reasons[asset_id].add("生图任务已采用结果")

    keys_by_id = {
        row.id: {key for key in (row.storage_key, row.display_key, row.thumb_key) if key}
        for row in rows
    }
    key_owners = {key: asset_id for asset_id, keys in keys_by_id.items() for key in keys}
    for label, statement in KEY_SOURCES:
        for result_row in (await session.execute(statement)).all():
            for key in result_row:
                asset_id = key_owners.get(key)
                if asset_id is not None:
                    reasons[asset_id].add(label)

    for label, statement in JSON_SOURCES:
        for result_row in (await session.execute(statement)).all():
            hits: set[int] = set()
            for value in result_row:
                hits.update(collect_image_refs(value, ids, shas))
            for asset_id in hits:
                reasons[asset_id].add(label)

    return {asset_id: sorted(labels) for asset_id, labels in reasons.items()}


def _bucket(row: ImageAsset) -> str:
    return image_assets.storage_bucket(source=row.source, op=row.op)


async def _physical_size(row: ImageAsset) -> tuple[int, int]:
    storage = get_storage()
    total = 0
    objects = 0
    seen: set[str] = set()
    for key in (row.storage_key, row.display_key, row.thumb_key):
        if not key or key in seen:
            continue
        seen.add(key)
        stat = await storage.stat(key)
        if stat is not None:
            total += stat.size
            objects += 1
        elif key == row.storage_key:
            # 远端测试替身可能只实现 exists/read；原图大小仍有数据库事实值。
            total += row.bytes
            objects += 1
    return total, objects


async def overview(session: AsyncSession) -> dict[str, Any]:
    rows = list(
        (
            await session.execute(
                select(ImageAsset).order_by(ImageAsset.created_at.desc(), ImageAsset.id.desc())
            )
        ).scalars()
    )
    archived = [row for row in rows if row.status == "archived"]
    refs = await reference_reasons(session, archived)
    prefixes = await image_assets.get_storage_prefixes(session)
    storage = get_storage()
    root = getattr(storage, "root", None)
    bucket_stats = {
        key: {
            "kind": key,
            "prefix": prefix,
            "path": str(storage.local_path(prefix) or prefix),
            "count": 0,
            "archived": 0,
            "bytes": 0,
            "objects": 0,
        }
        for key, prefix in prefixes.items()
    }
    physical: dict[int, tuple[int, int]] = {}
    for row in rows:
        size, objects = await _physical_size(row)
        physical[row.id] = (size, objects)
        item = bucket_stats[_bucket(row)]
        item["count"] += 1
        item["archived"] += int(row.status == "archived")
        item["bytes"] += size
        item["objects"] += objects

    archived_items = []
    for row in archived[:500]:
        size, objects = physical[row.id]
        reasons = refs.get(row.id, [])
        archived_items.append(
            {
                "id": row.id,
                "name": row.display_name or f"素材 #{row.id}",
                "source": row.source,
                "op": row.op,
                "width": row.width,
                "height": row.height,
                "bytes": size,
                "objects": objects,
                "thumb_url": image_assets.asset_url(row.id, "thumb"),
                "created_at": row.created_at.isoformat() if row.created_at else None,
                "reclaimable": not reasons,
                "references": reasons,
            }
        )
    reclaimable = [row for row in archived if row.id not in refs]
    return {
        "backend": "local" if root is not None else "object",
        "root": str(root) if root is not None else None,
        "prefixes": prefixes,
        "defaults": image_assets.DEFAULT_STORAGE_PREFIXES,
        "buckets": list(bucket_stats.values()),
        "total_assets": len(rows),
        "archived_assets": len(archived),
        "reclaimable_assets": len(reclaimable),
        "reclaimable_bytes": sum(physical[row.id][0] for row in reclaimable),
        "archived_items": archived_items,
        "archived_truncated": len(archived) > len(archived_items),
    }


async def purge(session: AsyncSession, asset_ids: list[int]) -> dict[str, Any]:
    ids = list(dict.fromkeys(asset_ids))
    if not ids:
        raise AssetStorageError("至少选择一张已归档素材")
    if len(ids) > MAX_PURGE:
        raise AssetStorageError(f"一次最多物理清理 {MAX_PURGE} 张素材")
    rows = list(
        (
            await session.execute(
                select(ImageAsset).where(ImageAsset.id.in_(ids)).with_for_update()
            )
        ).scalars()
    )
    found = {row.id for row in rows}
    missing = [asset_id for asset_id in ids if asset_id not in found]
    if missing:
        raise AssetStorageError(f"素材不存在：{missing}", status=404)
    not_archived = [row.id for row in rows if row.status != "archived"]
    if not_archived:
        raise AssetStorageError(f"只能物理清理已归档素材：{not_archived}", status=409)
    refs = await reference_reasons(session, rows)
    if refs:
        blocked = [
            {"asset_id": row.id, "references": refs[row.id]} for row in rows if row.id in refs
        ]
        raise AssetStorageError("所选素材仍被引用，未执行任何删除", status=409, blocked=blocked)

    storage = get_storage()
    removed_objects = 0
    removed_bytes = 0
    for row in rows:
        size, _objects = await _physical_size(row)
        for key in dict.fromkeys(
            key for key in (row.storage_key, row.display_key, row.thumb_key) if key
        ):
            try:
                removed_objects += int(await storage.delete(key))
            except StorageError as exc:
                raise AssetStorageError(f"删除对象失败：{exc}", status=502) from exc
        removed_bytes += size
        await session.delete(row)
    await session.commit()
    return {
        "purged": len(rows),
        "removed_objects": removed_objects,
        "removed_bytes": removed_bytes,
    }


# ---- 真删除（DELETE /images/assets/...）----

MAX_BULK_DELETE = 200

# 应用目标的中文名，用于把 subject_domain 拼成人话
SUBJECT_LABELS = {"wordlist": "单词本", "book": "书籍"}


async def child_ids(session: AsyncSession, ids: set[int]) -> dict[int, list[int]]:
    """谁把这些资产当编辑链的源。parent_id 是索引列，这一步很便宜。"""
    if not ids:
        return {}
    rows = (
        await session.execute(
            select(ImageAsset.id, ImageAsset.parent_id)
            .where(ImageAsset.parent_id.in_(ids))
            .order_by(ImageAsset.id.asc())
        )
    ).all()
    out: dict[int, list[int]] = defaultdict(list)
    for child_id, parent_id in rows:
        out[parent_id].append(child_id)
    return dict(out)


async def canvas_usage(
    session: AsyncSession, ids: set[int], shas: dict[str, int]
) -> dict[int, list[dict[str, Any]]]:
    """哪些画布的节点在用这些资产。

    `studio_canvas.nodes` 是整包 JSON，节点里的 `items[].asset_id` 不是外键——删了
    资产库不会拦、也不会报错，画布上只会多一个破图。所以只能整表扫一遍逐节点数。
    引用识别复用 `collect_image_refs`：除 `asset_id` 外还认 `assetIds`、`/api/images/
    assets/12/full` 这类 URL 与 sha，前端换过几种写法都能对上。
    """
    if not ids:
        return {}
    out: dict[int, list[dict[str, Any]]] = defaultdict(list)
    rows = (
        await session.execute(
            select(
                StudioCanvas.id,
                StudioCanvas.title,
                StudioCanvas.nodes,
                StudioCanvas.settings,
                StudioCanvas.deleted_at,
            ).order_by(StudioCanvas.id.asc())
        )
    ).all()
    for canvas_id, title, nodes, settings, deleted_at in rows:
        counts: Counter[int] = Counter()
        for node in nodes or []:
            for asset_id in collect_image_refs(node, ids, shas):
                counts[asset_id] += 1
        # settings 里的引用（画布默认参考图之类）不属于任何节点，算引用但不计节点数
        loose = collect_image_refs(settings, ids, shas)
        for asset_id in sorted(set(counts) | loose):
            out[asset_id].append(
                {
                    "id": canvas_id,
                    "title": title,
                    "node_count": counts.get(asset_id, 0),
                    # 回收站里的画布 30 天内可恢复，它的引用仍然是真引用
                    "trashed": deleted_at is not None,
                }
            )
    return dict(out)


async def key_holders(session: AsyncSession, keys: set[str]) -> dict[str, list[str]]:
    """这些存储对象还被哪些**别的**表的 key 列指着（见 KEY_SOURCES 的注释）。"""
    if not keys:
        return {}
    holders: dict[str, set[str]] = defaultdict(set)
    for label, statement in KEY_SOURCES:
        for result_row in (await session.execute(statement)).all():
            for key in result_row:
                if key in keys:
                    holders[key].add(label)
    return {key: sorted(labels) for key, labels in holders.items()}


def _asset_keys(row: ImageAsset) -> list[str]:
    """一行的三个存储对象，去重后按原图、展示图、缩略图的顺序。"""
    return list(dict.fromkeys(k for k in (row.storage_key, row.display_key, row.thumb_key) if k))


async def _applied_target(session: AsyncSession, row: ImageAsset) -> dict[str, Any] | None:
    if row.status != "applied" or not row.subject_domain or row.subject_id is None:
        return None
    # 就地导入：image_pipeline 在导入时会注册整条生图管线，为了取一个标题
    # 让每个引用本模块的进程都付这份成本不划算
    from domain import image_pipeline

    loader = image_pipeline.LOADERS.get(row.subject_domain)
    subject = await loader(session, row.subject_id) if loader is not None else {}
    return {
        "subject_domain": row.subject_domain,
        "subject_id": row.subject_id,
        "label": SUBJECT_LABELS.get(row.subject_domain, row.subject_domain),
        "title": subject.get("title"),
    }


def _usage_summary(
    canvases: list[dict[str, Any]],
    children: list[int],
    applied_to: dict[str, Any] | None,
    shared: list[dict[str, Any]],
) -> str:
    parts: list[str] = []
    if canvases:
        nodes = sum(item["node_count"] for item in canvases)
        parts.append(f"{len(canvases)} 个画布的 {nodes} 个节点在用")
    if children:
        parts.append(f"{len(children)} 张编辑链子图以它为源")
    if applied_to:
        title = applied_to.get("title") or f"#{applied_to['subject_id']}"
        parts.append(f"已应用到{applied_to['label']}「{title}」")
    if shared:
        parts.append(f"{len(shared)} 个存储对象与别的记录共用")
    if not parts:
        return "没查到任何引用，删掉不会影响别处"
    return "，".join(parts)


async def asset_usage(session: AsyncSession, row: ImageAsset) -> dict[str, Any]:
    """删之前谁在用它。前端拿这一份就能拼出确认弹窗的那句话。"""
    ids = {row.id}
    shas = {row.sha256: row.id}
    canvases = (await canvas_usage(session, ids, shas)).get(row.id, [])
    children = (await child_ids(session, ids)).get(row.id, [])
    applied_to = await _applied_target(session, row)
    holders = await key_holders(session, set(_asset_keys(row)))
    shared = [{"key": key, "held_by": labels} for key, labels in sorted(holders.items())]
    references = (await reference_reasons(session, [row])).get(row.id, [])
    return {
        "asset_id": row.id,
        "display_name": row.display_name,
        "status": row.status,
        "canvases": canvases,
        "children": len(children),
        "child_ids": children,
        "applied_to": applied_to,
        "shared_objects": shared,
        # 全域引用标签（会话、任务快照、DAG、模型台账……），比上面三项更全
        "references": references,
        "deletable": not (children or canvases or applied_to or references),
        "summary": _usage_summary(canvases, children, applied_to, shared),
    }


async def _delete_one(
    session: AsyncSession,
    row: ImageAsset,
    children: list[int],
    canvases: list[dict[str, Any]],
    holders: dict[str, list[str]],
) -> dict[str, Any]:
    asset_id = row.id
    # 先把外键引用显式置空，不靠列上的 ON DELETE SET NULL：SQLite 默认不开外键约束，
    # 靠它会留下指向已删行的悬空 parent_id，同一份代码在两种方言下结果不一样
    if children:
        await session.execute(
            update(ImageAsset).where(ImageAsset.parent_id == asset_id).values(parent_id=None)
        )
    await session.execute(
        update(ImageJob).where(ImageJob.applied_asset_id == asset_id).values(applied_asset_id=None)
    )

    storage = get_storage()
    removed: list[str] = []
    missing: list[str] = []
    kept: list[dict[str, Any]] = []
    failed: list[dict[str, str]] = []
    for key in _asset_keys(row):
        held_by = holders.get(key)
        if held_by:
            kept.append({"key": key, "held_by": held_by})
            continue
        try:
            gone = await storage.delete(key)
        except (StorageError, OSError) as exc:
            # 删不掉对象不该把整个请求打回去：用户要的是这张图从素材库消失，
            # 留个孤儿文件事后能清，删一半又回滚成"还在"才是最难收拾的状态。
            # 但也不假装干净——原样报给调用方。
            failed.append({"key": key, "error": f"{type(exc).__name__}: {exc}"})
            continue
        (removed if gone else missing).append(key)

    await session.delete(row)
    await session.commit()
    return {
        "asset_id": asset_id,
        "deleted": True,
        "status": 200,
        "removed_objects": removed,
        # 库里有 key、盘上已经没有这个文件。不是错误，但也不能算"删掉了"
        "missing_objects": missing,
        "kept_objects": kept,
        "failed_objects": failed,
        "storage_clean": not failed,
        "orphaned_children": children,
        "orphaned_canvases": canvases,
    }


async def delete_assets(
    session: AsyncSession,
    asset_ids: list[int],
    *,
    force: bool = False,
    force_ids: list[int] | None = None,
) -> dict[str, Any]:
    """真删：库行 + 独占的存储对象。逐个删、逐个提交，一个失败不牵连其余。

    有子代的默认拒绝：`parent_id` 置空之后，那条编辑链就再也追不到根了（BR-117），
    这是不可逆的信息丢失，得由调用方显式 force 才做。
    """
    ids = list(dict.fromkeys(asset_ids))
    if not ids:
        raise AssetStorageError("至少选择一张素材")
    if len(ids) > MAX_BULK_DELETE:
        raise AssetStorageError(f"一次最多删除 {MAX_BULK_DELETE} 张素材")
    authorized = set(force_ids or [])
    if force:
        if len(ids) != 1:
            raise AssetStorageError("批量强删必须指定素材 ID 集合")
        authorized.update(ids)
    if not authorized.issubset(ids):
        raise AssetStorageError("强删授权超出删除范围")

    rows = {
        row.id: row
        for row in (
            await session.execute(select(ImageAsset).where(ImageAsset.id.in_(ids)))
        ).scalars()
    }
    # 两次全表级扫描按整批做一次，而不是每张图各做一次
    found = set(rows)
    shas = {row.sha256: row.id for row in rows.values()}
    canvas_map = await canvas_usage(session, found, shas)
    holders = await key_holders(session, {key for row in rows.values() for key in _asset_keys(row)})
    references = await reference_reasons(session, list(rows.values()))

    results: list[dict[str, Any]] = []
    for asset_id in ids:
        row = rows.get(asset_id)
        if row is None:
            results.append(
                {"asset_id": asset_id, "deleted": False, "status": 404, "reason": "资产不存在"}
            )
            continue
        # 子代逐个现查而不是整批预取：同一批里子图排在前面时它已经被删掉，
        # 这时父图就不该再被它拦住。parent_id 有索引，200 次也不贵
        children = (await child_ids(session, {asset_id})).get(asset_id, [])
        other_refs = set(references.get(asset_id, [])) - {"图片编辑血缘"}
        if (children or canvas_map.get(asset_id) or other_refs) and asset_id not in authorized:
            results.append(
                {
                    "asset_id": asset_id,
                    "deleted": False,
                    "status": 409,
                    "reason": "素材仍被引用，需要明确确认后才能删除",
                    "children": len(children),
                    "child_ids": children,
                }
            )
            continue
        results.append(
            await _delete_one(session, row, children, canvas_map.get(asset_id, []), holders)
        )

    deleted = [item for item in results if item["deleted"]]
    return {
        "deleted": len(deleted),
        "failed": len(results) - len(deleted),
        "storage_clean": all(item.get("storage_clean", True) for item in deleted),
        "results": results,
    }

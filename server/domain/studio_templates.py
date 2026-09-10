"""工作流资产：画布子图的存取、打包与重映射（模块 17 FR-482 / F044）。

三条约束决定了这里的全部形状：

- **字节不进 payload**（BR-101/BR-140）。节点里的 `asset_id` 存进模板时换成
  `sha256`，另附一张 `assets` 元信息表（宽高/mime/提示词）。几十兆的 base64
  塞进 JSONB 会撑爆库行，本仓在 `step_artifact.payload` 上已经栽过一次。
- **资产化时字节进对象存储**。`package.storage_key` 只保存 ZIP 的存储键与校验信息，
  原始图片、视频和音频仍不进入 JSONB；这样资产从图片库清掉后还能由包重建。
- **不在库就照实标缺失**（BR-110）。导入时按 sha 反查：在库直接复用既有资产
  （`reused+1`），不在库就把这一项标成 `missing`，**不拿别的图顶上**。
  `rebuilt` 恒为 0——模板里根本没有字节，凭空「重建」只能是伪造；真要重建
  得先有带字节的导出包，那是另一件事。
- **id 全部重映射**。同一份模板可以往同一张画布导好几次，沿用原 id 必然撞；
  重映射后 `connections` 两端要跟着改，漏改一端就是一堆连不上的悬空边。
"""

from __future__ import annotations

import hashlib
import re
import zipfile
from io import BytesIO
from pathlib import PurePosixPath
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain import studio
from domain.models import ImageAsset, StudioTemplate
from domain.storage import StorageError, get_storage

MAX_NAME = 80
MAX_NOTE = 2000
MAX_LIBRARY_DOWNLOADS = 100

# 导入落点：服务端不知道当前画布上已经有什么（apply 不带画布 id），只能把整个
# 子图平移到一个固定落点，保持子图内部相对位置不变，剩下的让用户拖。
# 前端知道现有节点在哪，可以传 offset_x/offset_y 自己挑落点。
APPLY_ORIGIN_X = 120.0
APPLY_ORIGIN_Y = 120.0

# 缺失项的统一说法。UI 原样展示（BR-110）
MISSING_NOTE = "模板只存内容指纹不存字节，这些图当前库里没有，已按缺失留空——没有拿别的图顶替"


class StudioTemplateError(Exception):
    """模板操作不合法。`status` 由路由层原样映射为 HTTP 状态码。"""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def _clean_name(name: str) -> str:
    cleaned = (name or "").strip()
    if not cleaned:
        raise StudioTemplateError("模板名不能为空")
    return cleaned[:MAX_NAME]


def template_view(row: StudioTemplate) -> dict:
    payload = row.payload or {}
    package = payload.get("package") if isinstance(payload.get("package"), dict) else {}
    return {
        "id": row.id,
        "name": row.name,
        "note": row.note or "",
        "node_count": len(payload.get("nodes") or []),
        "asset_count": len(payload.get("assets") or []),
        "resource_count": int(package.get("resource_count") or 0),
        "packaged": bool(package.get("storage_key")),
        "package_bytes": int(package.get("bytes") or 0),
        "created_at": row.created_at.isoformat() if row.created_at else "",
    }


# ---- 存 ----


def _collect_asset_ids(nodes: list[dict]) -> list[int]:
    ids: list[int] = []
    for node in nodes:
        for item in node.get("items") or []:
            if not isinstance(item, dict):
                continue
            asset_id = item.get("asset_id")
            if isinstance(asset_id, int) and asset_id not in ids:
                ids.append(asset_id)
    return ids


async def _asset_meta(session: AsyncSession, asset_ids: list[int]) -> dict[int, dict]:
    """id → 存进模板的元信息。查不到的 id 不进结果，由调用方按缺失处理。"""
    if not asset_ids:
        return {}
    rows = (
        await session.execute(select(ImageAsset).where(ImageAsset.id.in_(asset_ids)))
    ).scalars().all()
    return {
        row.id: {
            "sha256": row.sha256,
            "width": row.width,
            "height": row.height,
            "mime": row.mime,
            "prompt": row.prompt or "",
        }
        for row in rows
    }


def _to_template_item(item: dict, meta: dict[int, dict]) -> dict:
    """节点里的一项：asset_id 换成 sha256，外部 url 原样留着。"""
    out = {k: v for k, v in item.items() if k != "asset_id"}
    asset_id = item.get("asset_id")
    if not isinstance(asset_id, int):
        return out
    info = meta.get(asset_id)
    if info is None:
        # 存的时候资产就已经不在了（被清过库）。标缺失而不是留个死 id：
        # 死 id 导入到别的环境会指向完全不相干的另一张图
        out["missing"] = True
        return out
    out["sha256"] = info["sha256"]
    out.setdefault("w", info["width"])
    out.setdefault("h", info["height"])
    return out


async def save_template(
    session: AsyncSession,
    *,
    name: str,
    note: str,
    nodes: list,
    connections: list,
    include_resources: bool = False,
) -> dict:
    """把选中的子图存成模板。复用画布那套清洗：悬空边过滤、运行态剥离、体积上限。"""
    clean_name = _clean_name(name)
    try:
        clean_nodes, clean_conns, _ = studio.normalize_canvas_payload(nodes, connections, None)
    except studio.StudioError as exc:
        raise StudioTemplateError(str(exc)) from exc
    if not clean_nodes:
        raise StudioTemplateError("模板里一个有效节点都没有")

    meta = await _asset_meta(session, _collect_asset_ids(clean_nodes))
    payload_nodes: list[dict] = []
    used_sha: list[str] = []
    for node in clean_nodes:
        out = dict(node)
        items = node.get("items")
        if isinstance(items, list):
            new_items = [
                _to_template_item(item, meta) for item in items if isinstance(item, dict)
            ]
            out["items"] = new_items
            for item in new_items:
                sha = item.get("sha256")
                if isinstance(sha, str) and sha not in used_sha:
                    used_sha.append(sha)
        payload_nodes.append(out)

    by_sha = {info["sha256"]: info for info in meta.values()}
    payload = {
        "nodes": payload_nodes,
        "connections": clean_conns,
        "assets": [by_sha[sha] for sha in used_sha],
    }
    row = StudioTemplate(
        name=clean_name,
        note=(note or "").strip()[:MAX_NOTE],
        payload=payload,
    )
    session.add(row)
    await session.flush()

    package_key = ""
    if include_resources:
        # 局部导入避免模块初始化时形成 studio_templates ↔ canvas_workflows 环。
        from domain import studio_canvas_workflows

        document, archive = await studio_canvas_workflows.build_export(
            session,
            nodes=clean_nodes,
            connections=clean_conns,
            include_resources=True,
        )
        if archive is None:  # pragma: no cover - include_resources=True 的防御分支
            raise StudioTemplateError("工作流资产包生成失败")
        digest = hashlib.sha256(archive).hexdigest()
        package_key = f"studio-templates/{row.id}/{uuid4().hex[:12]}-{digest[:16]}.zip"
        await get_storage().write(package_key, archive)
        row.payload = {
            **payload,
            "package": {
                "storage_key": package_key,
                "sha256": digest,
                "bytes": len(archive),
                "filename": f"{clean_name}.zip",
                "format": studio_canvas_workflows.FORMAT,
                "resource_count": len(document.get("resources") or []),
            },
        }
    try:
        await session.commit()
    except Exception:
        if package_key:
            await get_storage().delete(package_key)
        raise
    await session.refresh(row)
    return template_view(row)


# ---- 取 ----


async def list_templates(session: AsyncSession) -> list[dict]:
    rows = (
        await session.execute(select(StudioTemplate).order_by(StudioTemplate.id.desc()))
    ).scalars().all()
    return [template_view(row) for row in rows]


async def _get(session: AsyncSession, template_id: int) -> StudioTemplate:
    row = await session.get(StudioTemplate, template_id)
    if row is None:
        raise StudioTemplateError(f"模板不存在：{template_id}", status=404)
    return row


async def delete_template(session: AsyncSession, template_id: int) -> None:
    row = await _get(session, template_id)
    package = (row.payload or {}).get("package")
    package_key = package.get("storage_key") if isinstance(package, dict) else ""
    await session.delete(row)
    await session.commit()
    if isinstance(package_key, str) and package_key:
        await get_storage().delete(package_key)


async def rename_template(
    session: AsyncSession,
    template_id: int,
    *,
    name: str,
) -> dict:
    row = await _get(session, template_id)
    row.name = _clean_name(name)
    package = (row.payload or {}).get("package")
    if isinstance(package, dict):
        row.payload = {
            **(row.payload or {}),
            "package": {**package, "filename": f"{row.name}.zip"},
        }
    await session.commit()
    await session.refresh(row)
    return template_view(row)


def _download_name(value: str, fallback: str = "workflow.zip") -> str:
    name = re.sub(r'[\\/:*?"<>|]+', "_", (value or "").strip())
    name = PurePosixPath(name).name.strip(" .") or fallback
    return name if name.lower().endswith(".zip") else f"{name}.zip"


async def template_package(
    session: AsyncSession,
    template_id: int,
) -> tuple[bytes, str]:
    """读取资产化 ZIP；旧指纹模板则按当前仍可找到的资源即时打包。"""

    row = await _get(session, template_id)
    payload = row.payload or {}
    package = payload.get("package")
    if isinstance(package, dict) and isinstance(package.get("storage_key"), str):
        try:
            data = await get_storage().read(package["storage_key"])
        except StorageError as exc:
            raise StudioTemplateError("工作流资产包文件不存在", status=409) from exc
        digest = str(package.get("sha256") or "")
        if digest and hashlib.sha256(data).hexdigest() != digest:
            raise StudioTemplateError("工作流资产包校验失败", status=409)
        return data, _download_name(str(package.get("filename") or row.name))

    # 兼容 F044 之前保存的指纹模板。这里不伪造缺失资源：能找到的才进入 ZIP，
    # 找不到的在 workflow.json 中保留 missing 标记。
    from domain import studio_canvas_workflows

    restored = await apply_template(session, template_id)
    _, archive = await studio_canvas_workflows.build_export(
        session,
        nodes=restored["nodes"],
        connections=restored["connections"],
        include_resources=True,
    )
    if archive is None:  # pragma: no cover
        raise StudioTemplateError("工作流资产包生成失败")
    return archive, _download_name(row.name)


async def template_packages_archive(
    session: AsyncSession,
    template_ids: list[int],
) -> bytes:
    ordered = list(dict.fromkeys(template_ids))
    if not ordered:
        raise StudioTemplateError("没有选择工作流资产")
    if len(ordered) > MAX_LIBRARY_DOWNLOADS:
        raise StudioTemplateError(f"一次最多下载 {MAX_LIBRARY_DOWNLOADS} 个工作流资产")
    out = BytesIO()
    used: set[str] = set()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as bundle:
        for template_id in ordered:
            data, filename = await template_package(session, template_id)
            base = _download_name(filename)
            stem = base[:-4]
            name = base
            suffix = 2
            while name in used:
                name = f"{stem}-{suffix}.zip"
                suffix += 1
            used.add(name)
            bundle.writestr(name, data)
    return out.getvalue()


async def import_template_package(
    session: AsyncSession,
    *,
    raw: bytes,
    filename: str,
    name: str = "",
) -> dict:
    """校验并导入 JSON/ZIP，再以 Lingua portable ZIP 存入工作流资产库。"""

    from domain import studio_canvas_workflows

    try:
        imported = await studio_canvas_workflows.import_workflow(
            session,
            raw=raw,
            filename=filename,
        )
    except studio_canvas_workflows.CanvasWorkflowError as exc:
        raise StudioTemplateError(str(exc)) from exc
    fallback = PurePosixPath((filename or "workflow").replace("\\", "/")).stem
    return await save_template(
        session,
        name=name or fallback or "导入的工作流",
        note="由工作流文件导入",
        nodes=imported["nodes"],
        connections=imported["connections"],
        include_resources=True,
    )


async def _sha_to_asset(session: AsyncSession, shas: list[str]) -> dict[str, ImageAsset]:
    if not shas:
        return {}
    rows = (
        await session.execute(select(ImageAsset).where(ImageAsset.sha256.in_(shas)))
    ).scalars().all()
    return {row.sha256: row for row in rows}


def _shift(nodes: list[dict], offset_x: float, offset_y: float) -> tuple[float, float]:
    """算出把子图左上角挪到落点所需的平移量。空坐标按 0 处理。"""
    xs = [float(n.get("x") or 0) for n in nodes]
    ys = [float(n.get("y") or 0) for n in nodes]
    return offset_x - min(xs, default=0.0), offset_y - min(ys, default=0.0)


async def apply_template(
    session: AsyncSession,
    template_id: int,
    *,
    offset_x: float = APPLY_ORIGIN_X,
    offset_y: float = APPLY_ORIGIN_Y,
) -> dict:
    """取模板 → sha 反查资产 → 重映射 id → 整体平移，返回可直接追加进画布的子图。"""
    row = await _get(session, template_id)
    payload = row.payload or {}
    package = payload.get("package")
    if isinstance(package, dict) and isinstance(package.get("storage_key"), str):
        from domain import studio_canvas_workflows

        try:
            raw = await get_storage().read(package["storage_key"])
        except StorageError as exc:
            raise StudioTemplateError("工作流资产包文件不存在", status=409) from exc
        digest = str(package.get("sha256") or "")
        if digest and hashlib.sha256(raw).hexdigest() != digest:
            raise StudioTemplateError("工作流资产包校验失败", status=409)
        try:
            restored = await studio_canvas_workflows.import_workflow(
                session,
                raw=raw,
                filename=str(package.get("filename") or f"{row.name}.zip"),
            )
        except studio_canvas_workflows.CanvasWorkflowError as exc:
            raise StudioTemplateError(str(exc)) from exc
        dx, dy = _shift(restored["nodes"], offset_x, offset_y)
        for node in restored["nodes"]:
            node["x"] = float(node.get("x") or 0) + dx
            node["y"] = float(node.get("y") or 0) + dy
        missing = [
            {"node_id": "", "sha256": str(ref)} for ref in restored.get("missing") or []
        ]
        return {
            **restored,
            "missing": missing,
            "missing_note": (
                "工作流资产包中有资源缺失，已按空位保留，没有拿其他素材顶替"
                if missing
                else ""
            ),
        }
    nodes = [n for n in (payload.get("nodes") or []) if isinstance(n, dict) and n.get("id")]
    connections = [c for c in (payload.get("connections") or []) if isinstance(c, dict)]

    shas = [
        item["sha256"]
        for node in nodes
        for item in (node.get("items") or [])
        if isinstance(item, dict) and isinstance(item.get("sha256"), str)
    ]
    found = await _sha_to_asset(session, shas)

    # 前缀带一次性随机段：同一份模板往同一张画布导两次也不会撞 id
    prefix = f"t{row.id}-{uuid4().hex[:6]}-"
    remap = {str(node["id"]): f"{prefix}{node['id']}" for node in nodes}
    dx, dy = _shift(nodes, offset_x, offset_y)

    reused = 0
    missing: list[dict] = []
    out_nodes: list[dict] = []
    for node in nodes:
        new_node = dict(node)
        new_node["id"] = remap[str(node["id"])]
        new_node["x"] = float(node.get("x") or 0) + dx
        new_node["y"] = float(node.get("y") or 0) + dy
        # group 节点的成员引用也是 id，不跟着换就会指到模板里那些不存在的节点
        members = node.get("member_ids")
        if isinstance(members, list):
            new_node["member_ids"] = [remap[str(m)] for m in members if str(m) in remap]
        history_for = node.get("history_for")
        if isinstance(history_for, str) and history_for in remap:
            new_node["history_for"] = remap[history_for]

        items = node.get("items")
        if isinstance(items, list):
            new_items: list[dict] = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                out = {k: v for k, v in item.items() if k != "sha256"}
                sha = item.get("sha256")
                if not isinstance(sha, str):
                    # 外部 url 项与存模板时就已缺失的项，原样带过去
                    new_items.append(out)
                    if item.get("missing"):
                        missing.append({"node_id": new_node["id"], "sha256": None})
                    continue
                asset = found.get(sha)
                if asset is None:
                    out["missing"] = True
                    missing.append({"node_id": new_node["id"], "sha256": sha})
                else:
                    out["asset_id"] = asset.id
                    out.pop("missing", None)
                    reused += 1
                new_items.append(out)
            new_node["items"] = new_items
        out_nodes.append(new_node)

    out_conns = [
        {
            "from": remap[str(c.get("from"))],
            "to": remap[str(c.get("to"))],
            "kind": c.get("kind", "flow"),
        }
        for c in connections
        if str(c.get("from")) in remap and str(c.get("to")) in remap
    ]

    return {
        "nodes": out_nodes,
        "connections": out_conns,
        "reused": reused,
        # 模板里没有字节，永远重建不出图来。这个 0 是事实，不是「还没实现」
        "rebuilt": 0,
        "missing": missing,
        "missing_note": MISSING_NOTE if missing else "",
    }

"""服务端画布 projector：任务与级联的终态产物直接落进 StudioCanvas（调研 §5.3）。

浏览器侧的落图（canvasStore.ts 的 landImageTask / landVideoTask / landWorkflowTask /
landCascadeCheckpointOutputs / ensureTaskNode）只在页签开着时才跑；关了页签、刷新到
一半、换了设备，产物就停在任务记录里等人来捞。这里在 worker 写完终态之后做同一件
事，字段口径与前端逐项对齐，浏览器回来后按 asset_id 并集合并不会出现重复。

写画布走 ``SELECT ... FOR UPDATE``（SQLite 测试下退化为普通 select）：version += 1、
updated_at 刷新、本次落图明细写进 ``settings["projector"]``，SSE 据此把 canvas 帧的
origin 判成 projector。同一 (task_id, node_id, asset_id) 再投影一次什么都不改，
也不 bump version。
"""

from __future__ import annotations

import copy
import hashlib
import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.models import StudioCanvas, StudioFlowRun, StudioTask
from domain.studio import RUNTIME_KEYS

PROJECTABLE_STATUSES = frozenset({"succeeded", "partial"})
IMAGE_TASK_TYPES = frozenset(
    {"image.generate", "image.edit", "image.upscale", "midjourney.generate", "midjourney.action"}
)
MEDIA_ITEM_KINDS = frozenset({"image", "video", "audio", "file"})
LANDING_NODE_TYPES = frozenset({"image", "video", "output"})
PROJECTOR_SETTINGS_KEY = "projector"

# 以下布局常量复制自 web/src/features/studio/canvasStore.ts，两端必须同值：
# 服务端补出来的分支节点要和浏览器 ensureTaskNode 生出来的落在同一个位置，
# 否则同一个任务在两端各生一个节点，合并时按 id 对不上。
IMAGE_NODE_W = 360  # canvasStore.ts `IMAGE_NODE_W`
VIDEO_NODE_W = 320  # ensureTaskNode 里视频源节点缺 w 时的兜底 `320`
EMPTY_NODE_W = 420  # canvasStore.ts `EMPTY_NODE_W`（与 studio.STARTER_NODE_W 同值）
WORKFLOW_NODE_W = 300  # landWorkflowTask 里 `node.w ?? 300`
BRANCH_GAP = 80  # canvasStore.ts `BRANCH_GAP`
WORKFLOW_OUTPUT_DX = 26  # landWorkflowTask 每组产物的横向错位
WORKFLOW_OUTPUT_DY = 210  # landWorkflowTask 每组产物的纵向错位
WORKFLOW_OUTPUT_PLAIN_W = 316  # landWorkflowTask 非图片/视频产物组的节点宽
COMPLETED_TASK_IDS_MAX = 20  # landWorkflowTask `.slice(-20)`
# canvasStore.ts `TYPE_DEFAULT_W`
TYPE_DEFAULT_W: dict[str, int] = {
    "output": 420,
    "prompt": 316,
    "llm": 420,
    "modelscope": 420,
    "midjourney": 440,
    "loop": 360,
    "group": 340,
    "workflow": 340,
    "file": 316,
    "audio": 316,
}
# canvasStore.ts mediaNodeBox / mediaGridBox 的框常量
MEDIA_BOX_W = 520
MEDIA_BOX_H = 440
MEDIA_FALLBACK_W = 520
MEDIA_FALLBACK_H = 360
MEDIA_MIN_EDGE = 72

WORKFLOW_KIND_LABELS = {"image": "图片", "video": "视频", "audio": "音频", "file": "文件"}


@dataclass(frozen=True)
class LandedNode:
    node_id: str
    task_id: str | None
    flow_run_id: str | None
    added: int

    def view(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "task_id": self.task_id,
            "flow_run_id": self.flow_run_id,
            "added": self.added,
        }


@dataclass(frozen=True)
class CanvasProjection:
    canvas_id: int
    version: int
    updated_at: datetime
    landed: tuple[LandedNode, ...]


# ---- 数值与 JS 口径 ----


def _js_round(value: float) -> int:
    """JS 的 Math.round 是 .5 进位；Python 的 round 是四舍六入五成双。"""
    return math.floor(value + 0.5)


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _positive_int(value: Any) -> int | None:
    """对齐 `Number(x)` + `Number.isInteger` + `> 0`：整数、整值浮点、数字字符串都认。"""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, float):
        return int(value) if value.is_integer() and value > 0 else None
    if isinstance(value, str):
        try:
            parsed = float(value.strip())
        except ValueError:
            return None
        return int(parsed) if parsed.is_integer() and parsed > 0 else None
    return None


def _coalesce(item: dict[str, Any], *keys: str) -> Any:
    """JS `a ?? b`：只在 null/undefined 时回落。"""
    for key in keys:
        value = item.get(key)
        if value is not None:
            return value
    return None


# ---- 节点尺寸（canvasStore.ts mediaNodeBox / mediaGridBox / withDefaultSize） ----


def media_node_box(nat_w: Any, nat_h: Any) -> tuple[float, float]:
    if not _is_number(nat_w) or not _is_number(nat_h) or nat_w <= 0 or nat_h <= 0:
        return MEDIA_FALLBACK_W, MEDIA_FALLBACK_H
    fit = min(MEDIA_BOX_W / nat_w, MEDIA_BOX_H / nat_h)
    return max(MEDIA_MIN_EDGE, _js_round(nat_w * fit)), max(MEDIA_MIN_EDGE, _js_round(nat_h * fit))


def media_grid_box(count: int, nat_w: Any, nat_h: Any) -> tuple[float, float]:
    base_w, base_h = media_node_box(nat_w, nat_h)
    if count <= 1:
        return base_w, base_h
    aspect = base_w / max(1, base_h)
    cols = min(4, max(2, math.ceil(math.sqrt(count))))
    rows = math.ceil(count / cols)
    cell_max = max(96, min(220, max(base_w, base_h) * 0.42))
    if base_w >= base_h:
        cell_w: float = cell_max
        cell_h: float = max(80, _js_round(cell_max / aspect))
    else:
        cell_w = max(80, _js_round(cell_max * aspect))
        cell_h = cell_max
    return cols * (cell_w + 8) + 16, rows * (cell_h + 8) + 16


def _box_width_for_items(items: Sequence[dict[str, Any]]) -> float:
    first = items[0] if items else {}
    return media_grid_box(len(items), first.get("w"), first.get("h"))[0]


def with_default_size(node: dict[str, Any]) -> dict[str, Any]:
    if node.get("w") is not None:
        return node
    node_type = node.get("type")
    if node_type in LANDING_NODE_TYPES:
        items = [it for it in (node.get("items") or []) if isinstance(it, dict)]
        return {**node, "w": EMPTY_NODE_W if not items else _box_width_for_items(items)}
    width = TYPE_DEFAULT_W.get(str(node_type))
    return node if width is None else {**node, "w": width}


# ---- 产物 → 画布条目（canvasStore.ts imageResultItems / videoResultItems / workflowTaskItems）


def _media_item(kind: str, item: dict[str, Any], media_id: int | None) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": kind}
    if media_id is not None:
        out["media_asset_id"] = media_id
    out["url"] = item["url"]
    out["poster_url"] = item["poster_url"] if isinstance(item.get("poster_url"), str) else None
    if isinstance(item.get("name"), str):
        out["name"] = item["name"]
    if isinstance(item.get("mime"), str):
        out["mime"] = item["mime"]
    out["duration_ms"] = item["duration_ms"] if _is_number(item.get("duration_ms")) else None
    if _is_number(item.get("width")):
        out["w"] = item["width"]
    if _is_number(item.get("height")):
        out["h"] = item["height"]
    return out


def image_result_items(result: Any) -> list[dict[str, Any]]:
    """图片任务：`result.asset_ids` → `{asset_id, kind: image}`。URL 由前端按 asset_id 现算。"""
    raw = result.get("asset_ids") if isinstance(result, dict) else None
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for value in raw:
        asset_id = _positive_int(value)
        if asset_id is not None:
            out.append({"asset_id": asset_id, "kind": "image"})
    return out


def video_result_items(result: Any) -> list[dict[str, Any]]:
    raw = result.get("items") if isinstance(result, dict) else None
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict) or item.get("kind") != "video":
            continue
        if not isinstance(item.get("url"), str):
            continue
        media_id = _positive_int(_coalesce(item, "media_asset_id", "id"))
        out.append(_media_item("video", item, media_id))
    return out


def workflow_result_items(result: Any) -> list[dict[str, Any]]:
    raw = result.get("items") if isinstance(result, dict) else None
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "")
        if kind not in MEDIA_ITEM_KINDS:
            continue
        if kind == "image":
            asset_id = _positive_int(_coalesce(item, "asset_id", "id"))
            if asset_id is None:
                continue
            entry: dict[str, Any] = {"kind": "image", "asset_id": asset_id}
            if _is_number(item.get("width")):
                entry["w"] = item["width"]
            if _is_number(item.get("height")):
                entry["h"] = item["height"]
            if isinstance(item.get("name"), str):
                entry["name"] = item["name"]
            out.append(entry)
            continue
        if not isinstance(item.get("url"), str):
            continue
        out.append(_media_item(kind, item, _positive_int(_coalesce(item, "media_asset_id", "id"))))
    return out


def item_key(item: dict[str, Any]) -> str:
    if item.get("asset_id") is not None:
        return f"a{item['asset_id']}"
    if item.get("media_asset_id") is not None:
        return f"m{item['media_asset_id']}"
    return f"u{item.get('url') or ''}"


def merge_items(a: Iterable[Any], b: Iterable[Any]) -> list[dict[str, Any]]:
    """canvasStore.ts mergeItems：按 asset_id / media_asset_id / url 去重的有序并集。"""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in [*a, *b]:
        if not isinstance(item, dict):
            continue
        key = item_key(item)
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def task_node_type(task_type: str) -> str | None:
    """canvasStore.ts canvasTaskNodeType：任务类型 → 落点节点类型。"""
    if task_type in IMAGE_TASK_TYPES:
        return "image"
    if task_type == "video.generate":
        return "video"
    if task_type.startswith("workflow."):
        return "workflow"
    return None


def task_items(task: StudioTask, node_type: str) -> list[dict[str, Any]]:
    if node_type == "image":
        return image_result_items(task.result)
    if node_type == "video":
        return video_result_items(task.result)
    return workflow_result_items(task.result)


# ---- 画布文档的内存副本 ----


class _Doc:
    """一次投影内的画布副本；所有改动先落这里，最后整包写回。"""

    def __init__(self, canvas: StudioCanvas) -> None:
        self.nodes: list[Any] = copy.deepcopy(canvas.nodes or [])
        self.connections: list[Any] = copy.deepcopy(canvas.connections or [])
        self.by_id: dict[str, dict[str, Any]] = {
            str(node["id"]): node
            for node in self.nodes
            if isinstance(node, dict) and node.get("id") not in (None, "")
        }
        self.changed = False

    def node(self, node_id: str | None) -> dict[str, Any] | None:
        return self.by_id.get(node_id) if node_id else None

    def add_node(self, node: dict[str, Any]) -> dict[str, Any]:
        sized = with_default_size(node)
        self.nodes.append(sized)
        self.by_id[str(sized["id"])] = sized
        self.changed = True
        return sized

    def connect(self, source_id: str, target_id: str) -> None:
        """与 ensureTaskNode 一致：同一对端点已有任何一条边就不再补。"""
        for conn in self.connections:
            if (
                isinstance(conn, dict)
                and str(conn.get("from")) == source_id
                and str(conn.get("to")) == target_id
            ):
                return
        self.connections.append({"from": source_id, "to": target_id, "kind": "flow"})
        self.changed = True

    def land_items(self, node: dict[str, Any], items: Sequence[dict[str, Any]]) -> int:
        current = [it for it in (node.get("items") or []) if isinstance(it, dict)]
        merged = merge_items(current, items)
        if len(merged) == len(current):
            return 0
        node["items"] = merged
        self.changed = True
        return len(merged) - len(current)


# ---- 节点骨架重建（canvasStore.ts plannedTaskNode / ensureTaskNode） ----


def planned_task_node(
    context: dict[str, Any], node_id: str, node_type: str
) -> dict[str, Any] | None:
    raw = context.get("planned_node")
    if not isinstance(raw, dict) or raw.get("id") != node_id:
        return None
    if raw.get("type") not in (node_type, "output"):
        return None
    if not _is_number(raw.get("x")) or not _is_number(raw.get("y")):
        return None
    # 计划快照来自浏览器内存里的节点，可能带着运行态字段（BR-143），落库前剥掉
    return {k: copy.deepcopy(v) for k, v in raw.items() if k not in RUNTIME_KEYS}


def _node_from_source(
    context: dict[str, Any], node_id: str, node_type: str, source: dict[str, Any]
) -> dict[str, Any] | None:
    if not _is_number(source.get("x")) or not _is_number(source.get("y")):
        return None
    source_w = source.get("w") if _is_number(source.get("w")) else None
    fallback_w = IMAGE_NODE_W if node_type == "image" else VIDEO_NODE_W
    node: dict[str, Any] = {
        "id": node_id,
        "type": "output" if context.get("pending_target") is True else node_type,
        "x": source["x"] + (source_w if source_w is not None else fallback_w) + BRANCH_GAP,
        "y": source["y"],
    }
    if source_w is not None:
        node["w"] = source_w
    node["title"] = "图片输出" if node_type == "image" else "视频输出"
    for key in ("prompt_draft", "prompt_draft_html", "prompt_draft_refs"):
        if source.get(key) is not None:
            node[key] = copy.deepcopy(source[key])
    settings_key = "run_settings" if node_type == "image" else "video_settings"
    if source.get(settings_key) is not None:
        node[settings_key] = copy.deepcopy(source[settings_key])
    node["items"] = []
    return node


def _ensure_task_node(
    doc: _Doc, context: dict[str, Any], node_id: str, node_type: str
) -> dict[str, Any] | None:
    existing = doc.node(node_id)
    if existing is not None:
        return existing if existing.get("type") in (node_type, "output") else None
    born = planned_task_node(context, node_id, node_type)
    raw_source = context.get("source_node_id")
    source_id = raw_source if isinstance(raw_source, str) and raw_source else None
    source = doc.node(source_id)
    if born is None and source is not None and node_type in ("image", "video"):
        born = _node_from_source(context, node_id, node_type, source)
    if born is None:
        return None
    node = doc.add_node(born)
    if source_id is not None and source is not None:
        doc.connect(source_id, node_id)
    return node


# ---- 工作流产物：另起 output 节点（canvasStore.ts landWorkflowTask） ----


def workflow_output_node_id(task_id: str, kind: str) -> str:
    """前端用随机 id；服务端按 (task, kind) 定值，两端各落一次也能按 id 合并成一个。"""
    digest = hashlib.blake2b(f"{task_id}:{kind}".encode(), digest_size=6).hexdigest()
    return f"n{digest}"


def _timeline_with_result(
    timeline: Any, segment_id: str | None, result: dict[str, Any]
) -> dict[str, Any] | None:
    if not isinstance(timeline, dict) or timeline.get("kind") != "minimax" or segment_id is None:
        return None
    segments = timeline.get("segments")
    if not isinstance(segments, list):
        return None
    if not any(isinstance(seg, dict) and seg.get("id") == segment_id for seg in segments):
        return None
    return {
        **timeline,
        "segments": [
            {**seg, "result": result}
            if isinstance(seg, dict) and seg.get("id") == segment_id
            else seg
            for seg in segments
        ],
    }


def _items_already_on_canvas(doc: _Doc, items: Sequence[dict[str, Any]]) -> bool:
    """画布上已有某个节点整组持有这一批产物就别再建一份。

    前端 landWorkflowTask 建 output 节点用的是随机 id，服务端按 (task, kind) 算的定值 id
    跟它对不上；只能按产物引用（asset_id / media_asset_id，都没有才退到 url）判重。
    """
    if not items:
        return False
    keys = {item_key(item) for item in items}
    for candidate in doc.nodes:
        if not isinstance(candidate, dict):
            continue
        held = {item_key(it) for it in (candidate.get("items") or []) if isinstance(it, dict)}
        if keys <= held:
            return True
    return False


def _land_workflow(
    doc: _Doc,
    node: dict[str, Any],
    task: StudioTask,
    context: dict[str, Any],
    items: Sequence[dict[str, Any]],
) -> int:
    """工作流产物另起 output 节点。

    判重看的是「产物节点在不在」，不是 completed_task_ids：前端对带 canvas_id 的任务
    只写 completed_task_ids、不建 output 节点，450ms 防抖保存若抢在投影前面落库，
    按 task.id 判重会让这一次工作流的产物永远缺席。completed_task_ids 与 timeline
    改成缺则补，补不补都不影响建节点。
    """
    if not items:
        return 0
    completed = [tid for tid in (node.get("completed_task_ids") or []) if isinstance(tid, str)]
    groups: dict[str, list[dict[str, Any]]] = {}
    for item in items:
        groups.setdefault(str(item["kind"]), []).append(item)
    raw_segment = context.get("workflow_segment_id")
    segment_id = raw_segment if isinstance(raw_segment, str) else None
    segment_result = next((it for it in items if it["kind"] == "video"), items[0])
    timeline = _timeline_with_result(node.get("workflow_timeline"), segment_id, segment_result)
    if task.id not in completed:
        node["completed_task_ids"] = [*completed, task.id][-COMPLETED_TASK_IDS_MAX:]
        doc.changed = True
    if timeline is not None and timeline != node.get("workflow_timeline"):
        node["workflow_timeline"] = timeline
        doc.changed = True
    base_x = node["x"] if _is_number(node.get("x")) else 0
    base_y = node["y"] if _is_number(node.get("y")) else 0
    node_w = node["w"] if _is_number(node.get("w")) else WORKFLOW_NODE_W
    raw_title = node.get("title")
    title = raw_title if isinstance(raw_title, str) and raw_title else "工作流"
    added = 0
    # index 按完整分组序推进：跳过的 kind 也占位，位置与一次全建时一致
    for index, (kind, grouped) in enumerate(groups.items()):
        output_id = workflow_output_node_id(task.id, kind)
        if output_id in doc.by_id or _items_already_on_canvas(doc, grouped):
            continue
        width = (
            _box_width_for_items(grouped)
            if kind in ("image", "video")
            else WORKFLOW_OUTPUT_PLAIN_W
        )
        doc.add_node(
            {
                "id": output_id,
                "type": "output",
                "x": base_x + node_w + BRANCH_GAP + index * WORKFLOW_OUTPUT_DX,
                "y": base_y + index * WORKFLOW_OUTPUT_DY,
                "w": width,
                "title": f"{title} · {WORKFLOW_KIND_LABELS[kind]}",
                "items": list(grouped),
            }
        )
        doc.connect(str(node["id"]), output_id)
        added += len(grouped)
    return added


# ---- 写回 ----


async def lock_canvas(session: AsyncSession, canvas_id: int) -> StudioCanvas | None:
    """行锁读画布。PostgreSQL 渲染 FOR UPDATE；SQLite 方言忽略该子句，退化为普通 select。"""
    stmt = (
        select(StudioCanvas)
        .where(StudioCanvas.id == canvas_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


def projector_record(canvas: StudioCanvas) -> dict[str, Any] | None:
    """settings.projector；只有它记的版本号就是当前版本时才算「这一版是 projector 写的」。"""
    settings = canvas.settings if isinstance(canvas.settings, dict) else {}
    record = settings.get(PROJECTOR_SETTINGS_KEY)
    if not isinstance(record, dict) or record.get("version") != canvas.version:
        return None
    return record


def canvas_event_view(canvas: StudioCanvas) -> dict[str, Any]:
    """SSE canvas 帧正文。任何一次内容保存都推，projector 写的那版带 landed 明细。"""
    record = projector_record(canvas)
    landed = record.get("landed") if record is not None else None
    return {
        "canvas_id": canvas.id,
        "version": canvas.version,
        "updated_at": canvas.updated_at.isoformat() if canvas.updated_at else "",
        "origin": "projector" if record is not None else "save",
        "landed": [entry for entry in landed if isinstance(entry, dict)]
        if isinstance(landed, list)
        else [],
    }


async def _commit_projection(
    session: AsyncSession, canvas: StudioCanvas, doc: _Doc, landed: Sequence[LandedNode]
) -> CanvasProjection:
    now = datetime.now(UTC)
    canvas.nodes = doc.nodes
    canvas.connections = doc.connections
    canvas.version = int(canvas.version or 0) + 1
    canvas.updated_at = now
    settings = dict(canvas.settings) if isinstance(canvas.settings, dict) else {}
    settings[PROJECTOR_SETTINGS_KEY] = {
        "version": canvas.version,
        "at": now.isoformat(),
        "landed": [entry.view() for entry in landed],
    }
    canvas.settings = settings
    await session.commit()
    return CanvasProjection(canvas.id, canvas.version, now, tuple(landed))


# ---- 入口 ----


async def project_task(session: AsyncSession, task: StudioTask) -> CanvasProjection | None:
    """把一条终态任务的产物落进它的画布落点；没有东西可落（或已落过）返回 None。"""
    if task.status not in PROJECTABLE_STATUSES or task.canvas_id is None or not task.node_id:
        return None
    node_type = task_node_type(task.task_type)
    if node_type is None:
        return None
    context = dict(task.source_context) if isinstance(task.source_context, dict) else {}
    result = task.result if isinstance(task.result, dict) else {}
    # Midjourney 进了局部重绘：没有产物，前端会把空目标节点删掉，服务端不碰
    if node_type == "image" and result.get("modal_required") is True:
        return None
    items = task_items(task, node_type)
    if not items:
        return None
    canvas = await lock_canvas(session, int(task.canvas_id))
    if canvas is None:
        return None
    doc = _Doc(canvas)
    node = _ensure_task_node(doc, context, task.node_id, node_type)
    if node is None:
        return None
    if node_type == "workflow":
        if node.get("type") != "workflow":
            return None
        added = _land_workflow(doc, node, task, context, items)
    else:
        added = doc.land_items(node, items)
    if not doc.changed:
        return None
    raw_run = context.get("flow_run_id")
    landed = LandedNode(
        node_id=task.node_id,
        task_id=task.id,
        flow_run_id=raw_run if isinstance(raw_run, str) else None,
        added=added,
    )
    return await _commit_projection(session, canvas, doc, [landed])


def _definition_contexts(run: StudioFlowRun) -> dict[str, dict[str, Any]]:
    definition = run.definition_snapshot if isinstance(run.definition_snapshot, dict) else {}
    out: dict[str, dict[str, Any]] = {}
    for node in definition.get("nodes") or []:
        if isinstance(node, dict) and node.get("id") is not None:
            context = node.get("source_context")
            out[str(node["id"])] = dict(context) if isinstance(context, dict) else {}
    return out


async def project_flow_run(
    session: AsyncSession,
    run: StudioFlowRun,
    *,
    node_ids: Iterable[str] | None = None,
) -> CanvasProjection | None:
    """按 source_context.node_map 把 checkpoint 里 succeeded/partial 节点的产物落到各自的画布落点。

    同签名图片请求在服务端只建一个 StudioTask，但每个 DAG 节点各有 checkpoint 与落点；
    逐节点投影，复用不会牺牲任一分支。``node_ids`` 限定本轮只看哪些节点，None 为全量。
    """
    context = run.source_context if isinstance(run.source_context, dict) else {}
    canvas_id = _positive_int(context.get("canvas_id"))
    if canvas_id is None:
        return None
    raw_map = context.get("node_map")
    node_map: dict[str, Any] = raw_map if isinstance(raw_map, dict) else {}
    checkpoint = run.checkpoint if isinstance(run.checkpoint, dict) else {}
    raw_states = checkpoint.get("nodes")
    states: dict[str, Any] = raw_states if isinstance(raw_states, dict) else {}
    wanted = None if node_ids is None else {str(node_id) for node_id in node_ids}

    pending: list[tuple[str, str, list[dict[str, Any]], str | None]] = []
    for flow_node_id, state in states.items():
        if wanted is not None and flow_node_id not in wanted:
            continue
        if not isinstance(state, dict) or state.get("status") not in PROJECTABLE_STATUSES:
            continue
        meta = node_map.get(flow_node_id)
        target_id = meta.get("target_node_id") if isinstance(meta, dict) else None
        if not isinstance(target_id, str) or not target_id:
            continue
        items = image_result_items(state.get("result")) or video_result_items(state.get("result"))
        if not items:
            continue
        raw_task_id = state.get("task_id")
        pending.append(
            (flow_node_id, target_id, items, raw_task_id if isinstance(raw_task_id, str) else None)
        )
    if not pending:
        return None

    canvas = await lock_canvas(session, canvas_id)
    if canvas is None:
        return None
    doc = _Doc(canvas)
    contexts = _definition_contexts(run)
    landed: list[LandedNode] = []
    for flow_node_id, target_id, items, task_id in pending:
        target = doc.node(target_id)
        if target is None:
            # 分支骨架不进画布文档：按定义快照里冻结的 planned_node / source_node_id 重建
            node_type = "video" if items[0]["kind"] == "video" else "image"
            target = _ensure_task_node(doc, contexts.get(flow_node_id, {}), target_id, node_type)
            if target is None:
                continue
        elif target.get("type") not in LANDING_NODE_TYPES:
            continue
        added = doc.land_items(target, items)
        if added > 0:
            landed.append(LandedNode(target_id, task_id, run.id, added))
    if not doc.changed:
        return None
    return await _commit_projection(session, canvas, doc, landed)

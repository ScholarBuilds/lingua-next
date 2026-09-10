"""创作工坊的持久化清洗与视图（模块 17 M1）。

画布/会话是前端全量保存的 JSON 文档，服务端不逐字段建模，只守三条底线：

1. **量的上限**——节点数、单节点体积、回合数、单条文本长度。防的是失控的
   防抖保存把一份几十 MB 的文档写进库里。
2. **引用一致**——连线的两端必须是存在的节点，悬空边静默过滤（前端删节点时
   漏删边是常态，报错只会让保存失败丢内容）。
3. **文档态与运行态分离**（BR-143）——pending/running 这类瞬时字段一律剥掉，
   恢复时的运行态由任务查询接口现算。蓝本把 pendingTasks 混存进文档，恢复
   逻辑复杂且易碎，这条是直接吸收的教训。
4. **删除要留痕**——整包 PUT 下「我有、服务端没有」的节点有两种来路（陈旧客户端
   手里的旧副本 / 用户刚建的新节点），载荷里长得一模一样。前端墓碑只记本端删的，
   换个标签页就没有，判据只能落在服务端，见 `nodes_deleted_after`。
"""

from __future__ import annotations

import json
from collections.abc import Collection
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.models import StudioCanvas

MAX_NODES = 500
MAX_NODE_BYTES = 200 * 1024
MAX_TURNS = 400
MAX_TURN_TEXT = 4000

# 删除记录的条数上限，取 MAX_NODES：一块合法画布最多 500 个节点，全选删一次也就
# 产出 500 条，够覆盖任何一次真实删除。满了扔最旧的——记录越旧，还没同步到它的
# 客户端越少，而这份记录本来就只为「比它更旧的客户端」而存在。
MAX_DELETED_NODES = MAX_NODES

# 连线三语义（FR-462）。缺省与不认识的值都当 flow——兼容不变式
CONNECTION_KINDS = {"input", "flow", "history"}

# 运行态字段黑名单（BR-143）。前端节点对象上挂的执行状态，落库前剥掉
RUNTIME_KEYS = {
    "pending", "running", "queued", "generating", "loading",
    "progress", "status", "task_id", "job_id", "run_state",
}

# chat 回合的字段白名单：user 与 assistant 各自会出现的字段，其余（含运行态）丢弃
TURN_KEYS = {"role", "text", "ref_asset_ids", "asset_ids", "error", "latency_ms", "at"}


# 新画布落地时自带的那一个空节点（FR-467）。
#
# 白板恐惧是真的：一片点阵背景加一句"右键新建节点"，用户第一反应是"我该点哪"。
# 先给一个空节点，"在这里写想画什么"就是第一步的说明书，不用去读帮助。
#
# 位置写死而不是算居中：服务端不知道浏览器窗口多大。这个坐标配合默认视口
# (0,0,scale=1) 在任何 ≥1280 宽的窗口里都落在可视区偏左上，看得见就够了。
# 宽度用前端 EMPTY_NODE_W 的同一个数——两处各写一个的话，新画布的节点会比
# 右键建出来的窄一截，而这种不一致没人会去查。
STARTER_NODE_X = 420
STARTER_NODE_Y = 200
STARTER_NODE_W = 420


def starter_nodes(node_id: str) -> list[dict]:
    """新建画布的初始内容。`node_id` 由调用方给，便于测试固定。"""
    return [
        {
            "id": node_id,
            "type": "image",
            "x": STARTER_NODE_X,
            "y": STARTER_NODE_Y,
            "w": STARTER_NODE_W,
            "items": [],
        }
    ]


class StudioError(Exception):
    """文档不合法，message 面向调用方（路由层映射为 400）。"""


def _strip_runtime(node: dict) -> dict:
    return {k: v for k, v in node.items() if k not in RUNTIME_KEYS}


def normalize_canvas_payload(
    nodes: Any,
    connections: Any,
    viewport: Any,
    *,
    drop_ids: Collection[str] = (),
) -> tuple[list[dict], list[dict], dict | None]:
    """画布保存前的宽松清洗。能修的修（悬空边、坏 kind），修不了的才拒。

    `drop_ids` 是服务端认定「这个客户端不该再送上来」的节点（见 `nodes_deleted_after`）。
    在这里丢而不是丢完再清一遍连线：丢掉的 id 不进 `ids`，指向它的边正好被下面那道
    悬空过滤一并带走，不必另记一份边的墓碑。
    """
    if not isinstance(nodes, list) or not isinstance(connections, list):
        raise StudioError("nodes 与 connections 必须是数组")
    if len(nodes) > MAX_NODES:
        raise StudioError(f"节点数超上限（{len(nodes)} > {MAX_NODES}）")

    clean_nodes: list[dict] = []
    ids: set[str] = set()
    for raw in nodes:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue  # 没有 id 的节点连不上任何边，留着只会腐烂
        if str(raw["id"]) in drop_ids:
            continue  # 体积检查也一并跳过：一个要丢的节点不该有资格把整次保存打回 400
        node = _strip_runtime(raw)
        size = len(json.dumps(node, ensure_ascii=False).encode())
        if size > MAX_NODE_BYTES:
            raise StudioError(
                f"节点 {node['id']} 过大（{size} 字节）——图片字节不该进文档，走资产库"
            )
        ids.add(str(node["id"]))
        clean_nodes.append(node)

    clean_conns: list[dict] = []
    for raw in connections:
        if not isinstance(raw, dict):
            continue
        src, dst = str(raw.get("from", "")), str(raw.get("to", ""))
        if src not in ids or dst not in ids:
            continue  # 悬空边静默过滤：删节点漏删边是前端常态
        kind = raw.get("kind", "flow")
        if kind not in CONNECTION_KINDS:
            kind = "flow"
        clean_conns.append({"from": src, "to": dst, "kind": kind})

    clean_viewport: dict | None = None
    if isinstance(viewport, dict):
        try:
            clean_viewport = {
                "x": float(viewport.get("x", 0)),
                "y": float(viewport.get("y", 0)),
                "scale": float(viewport.get("scale", 1)),
            }
        except (TypeError, ValueError):
            clean_viewport = None

    return clean_nodes, clean_conns, clean_viewport


def deletion_log(raw: Any) -> dict[str, int]:
    """把 `studio_canvas.deleted_nodes` 那列读成 {节点 id: 删除生效的 version}。

    列是自由 JSON，迁移前的行读回来是 None，将来也可能被别的代码写脏；在入口收一次口，
    调用方就不必到处判类型。
    """
    if not isinstance(raw, dict):
        return {}
    log: dict[str, int] = {}
    for node_id, version in raw.items():
        if isinstance(version, bool) or not isinstance(version, int):
            continue
        log[str(node_id)] = version
    return log


def nodes_deleted_after(raw: Any, base_version: int) -> frozenset[str]:
    """在 `base_version` 之后才被删掉的那些节点 id。

    这是整包 PUT 唯一能分开「陈旧副本」与「新建节点」的判据：记录的版本晚于客户端
    读到画布的版本 → 它是在这个客户端读完之后才被删的，客户端手里那份是旧副本；
    不晚于 → 客户端读到过删除之后的画布，同 id 节点是它重新建出来的（⌘Z 撤销就是
    这条路），必须留下。

    两个用处，含金量不同：

    - **409 响应**里按客户端的 base_version 算一遍交给前端。前端合并完会以最新
      version 重存，那一刻 base_version 已经被洗成最新的，服务端再也认不出这批
      节点是旧副本——只有在 409 这一刻还分得清，名单必须在这里交出去。
    - **保存路径**上作为兜底。乐观锁已经把 base_version 落后的保存挡在 409 上，
      这里几乎不会命中；留着是因为判据本身与「谁在写」无关，写路径上少一条隐式
      假设（"落后的保存进不来"）就少一处将来会腐烂的耦合。
    """
    return frozenset(
        node_id for node_id, version in deletion_log(raw).items() if version > base_version
    )


def record_node_deletions(
    raw: Any,
    *,
    before_ids: Collection[str],
    after_ids: Collection[str],
    version: int,
) -> dict[str, int]:
    """按一次保存的前后节点集更新删除记录，返回整包新值。

    整个换掉而不是原地改：JSON 列原地改不算脏，SQLAlchemy 不会 UPDATE。

    落库文档里还在的 id 一律不留记录——节点重新建出来之后记录还留着的话，下一个
    版本更旧的客户端会连这个活节点一起被判成旧副本，把它再删一次。
    """
    alive = {str(node_id) for node_id in after_ids}
    log = {
        node_id: at for node_id, at in deletion_log(raw).items() if node_id not in alive
    }
    for node_id in before_ids:
        if str(node_id) not in alive:
            log[str(node_id)] = version
    if len(log) > MAX_DELETED_NODES:
        newest = sorted(log.items(), key=lambda item: (item[1], item[0]), reverse=True)
        log = dict(newest[:MAX_DELETED_NODES])
    return log


def node_ids(nodes: Any) -> list[str]:
    """文档里的节点 id，按原顺序。清洗前后都用得上，脏数据静默跳过。"""
    if not isinstance(nodes, list):
        return []
    return [
        str(node["id"])
        for node in nodes
        if isinstance(node, dict) and node.get("id")
    ]


def normalize_chat_turns(turns: Any) -> list[dict]:
    """会话保存前的清洗：回合上限、单条文本上限、字段白名单。"""
    if not isinstance(turns, list):
        raise StudioError("turns 必须是数组")
    if len(turns) > MAX_TURNS:
        raise StudioError(f"回合数超上限（{len(turns)} > {MAX_TURNS}）")
    clean: list[dict] = []
    for raw in turns:
        if not isinstance(raw, dict):
            continue
        role = raw.get("role")
        if role not in ("user", "assistant"):
            continue
        turn = {k: v for k, v in raw.items() if k in TURN_KEYS}
        text = turn.get("text")
        if isinstance(text, str) and len(text) > MAX_TURN_TEXT:
            raise StudioError(f"单条文本超上限（{len(text)} > {MAX_TURN_TEXT} 字）")
        clean.append(turn)
    return clean


# ---- 视图 ----


def _iso(value) -> str:
    return value.isoformat() if value else ""


def canvas_thumb_asset_id(nodes: list) -> int | None:
    """列表卡片封面：画布里最后一个带 asset_id 的 image item。"""
    for node in reversed(nodes or []):
        if not isinstance(node, dict):
            continue
        for item in reversed(node.get("items") or []):
            if isinstance(item, dict) and item.get("asset_id"):
                return int(item["asset_id"])
    return None


def canvas_summary_view(row) -> dict:
    return {
        "id": row.id,
        "title": row.title,
        "icon": row.icon,
        "kind": row.kind,
        "owner": row.owner,
        "color": row.color,
        "pinned": row.pinned,
        "project": row.project,
        "board_x": row.board_x,
        "board_y": row.board_y,
        "node_count": len(row.nodes or []),
        "thumb_asset_id": canvas_thumb_asset_id(row.nodes or []),
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
    }


def canvas_detail_view(row) -> dict:
    return {
        "id": row.id,
        "title": row.title,
        "icon": row.icon,
        "kind": row.kind,
        "owner": row.owner,
        "color": row.color,
        "pinned": row.pinned,
        "project": row.project,
        "board_x": row.board_x,
        "board_y": row.board_y,
        "nodes": row.nodes or [],
        "connections": row.connections or [],
        "viewport": row.viewport,
        "settings": row.settings or {},
        # 拉全量的一方多半正要做本地合并，把删除记录一并给它：合并时它手里还有
        # 没被洗过的 base_version，能自己判出哪些本地节点是别人删掉的旧副本
        "deleted_nodes": deletion_log(row.deleted_nodes),
        "version": row.version,
        "updated_at": _iso(row.updated_at),
    }


def chat_last_asset_id(turns: list) -> int | None:
    """列表卡片封面：最后一个 assistant 回合的最后一张产图。"""
    for turn in reversed(turns or []):
        if not isinstance(turn, dict) or turn.get("role") != "assistant":
            continue
        asset_ids = turn.get("asset_ids") or []
        if asset_ids:
            return int(asset_ids[-1])
    return None


def chat_summary_view(row) -> dict:
    return {
        "id": row.id,
        "title": row.title,
        "pinned": row.pinned,
        "turn_count": len(row.turns or []),
        "last_asset_id": chat_last_asset_id(row.turns or []),
        "updated_at": _iso(row.updated_at),
    }


def chat_detail_view(row) -> dict:
    return {
        "id": row.id,
        "title": row.title,
        "pinned": row.pinned,
        "turns": row.turns or [],
        "version": row.version,
        "updated_at": _iso(row.updated_at),
    }


# ---- 查询 ----


async def list_canvases_updated_since(
    session: AsyncSession,
    *,
    since: datetime,
    limit: int = 200,
) -> list[StudioCanvas]:
    """自 ``since`` 起内容有过变化的画布，按 updated_at 升序；供 SSE 推 canvas 帧。

    updated_at 只在内容保存与服务端 projector 落图时刷新（BR-146：meta 更新不刷），
    所以这里查到的每一行都对应一次 version 递增。
    """
    stmt = (
        select(StudioCanvas)
        .where(StudioCanvas.updated_at >= since)
        .order_by(StudioCanvas.updated_at, StudioCanvas.id)
        .limit(max(1, min(limit, 500)))
    )
    return list((await session.execute(stmt)).scalars())

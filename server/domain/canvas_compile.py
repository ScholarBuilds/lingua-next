"""画布编译器：把画布文档编译成一次性服务端 DAG（模块 17 F3）。

这段编译原来跑在浏览器里（``web/src/features/studio/canvasStore.ts`` 的
``compileCascadeRun`` / ``compileSetPlanRun``）：拉工作流详情、拉凭据、按轮次
静态展开节点、在客户端挑凭据。三个问题让它必须下沉：

- 凭据能不能用只有服务端说了算，客户端挑出来的可能已经停用；
- 同一份画布在两台机器上编出来的 DAG 必须一样，浏览器版本差异不该影响提交内容；
- 定时触发 / 服务端重跑时根本没有浏览器。

TS 版保留作预演——用户点「运行」之前先在本地看一眼会跑成什么样，并顺手把输出槽
建到画布上；真正提交的定义以本模块为准。两端对同一份画布文档产出等价结果。

模块只依赖画布文档与几张查表（工作流详情、凭据、视频部署），不碰数据库，
所有 IO 由路由层先做完再喂进来。
"""

from __future__ import annotations

import json
import math
import random
import re
from collections.abc import Callable, Collection, Iterable, Mapping, Sequence
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from domain import image_defaults

#: 一次请求最多带几张参考图。与前端 `MAX_REFS` 同值
MAX_REFS = 20
MODELSCOPE_MAX_COUNT = 8
MODELSCOPE_MAX_REFS = 10
MIDJOURNEY_MAX_REFS = 4
VIDEO_MULTIMODAL_MAX_REFS = 9
VIDEO_MULTIFRAME_MAX_REFS = 20
LOOP_MAX = 999
CASCADE_POOL_DEFAULT = 8
CASCADE_POOL_MAX = 64
#: 「明确不指定画幅」。与 `image_prompts.AUTO_SIZE`、前端 size-picker 同值
AUTO_SIZE = "auto"
#: 新建输出槽时每轮往下挪多少
ROUND_DY = 340
IMAGE_NODE_W = 360
#: 多模态参考最多收几条（图 + 视频 + 音频合计）
MEDIA_REF_LIMIT = 36

CASCADE_EXECUTABLE_TYPES = frozenset(
    {"image", "llm", "modelscope", "video", "midjourney", "workflow"}
)

MINIMAX_ASPECTS = (
    "16:9 (Widescreen)",
    "9:16 (Portrait)",
    "1:1 (Square)",
    "4:3 (Standard)",
    "3:4 (Portrait)",
    "21:9 (Ultrawide)",
)

_PROMPT_ROLE = re.compile(r"prompt|positive|caption|description|关键词|提示词|正向")
_DURATION_ROLE = re.compile(r"duration|seconds|时长|秒")
_ASPECT_ROLE = re.compile(r"aspect[_\s-]?ratio|\bratio\b|画面比例|比例")
_MEGAPIXELS_ROLE = re.compile(r"megapixels?|百万像素")
_SEED_ROLE = re.compile(r"\bseed\b|随机种子|种子")
_RATIO_IN_TEXT = re.compile(r"\d+\s*:\s*\d+")


class CanvasCompileError(ValueError):
    """编译失败。文案直接给用户看，所以要说清是哪个节点缺什么。"""


@dataclass(frozen=True)
class CompiledFlow:
    definition: dict[str, Any]
    source_context: dict[str, Any]


@dataclass
class CanvasDoc:
    """一份画布文档。``nodes``/``connections`` 就是库里存的原样。"""

    nodes: list[dict[str, Any]] = field(default_factory=list)
    connections: list[dict[str, Any]] = field(default_factory=list)
    settings: dict[str, Any] = field(default_factory=dict)

    def by_id(self) -> dict[str, dict[str, Any]]:
        return {str(node.get("id")): node for node in self.nodes if node.get("id")}


# ---------------------------------------------------------------- JS 语义补丁


def js_number(value: Any) -> float:
    """等价于 JS 的 ``Number(value)``：转不动返回 NaN，``None`` 当 0。

    直接用 ``float()`` 会在 ``None``/``''``/布尔上和 TS 版分叉，而这些值恰恰
    是画布里最常见的缺省形态。
    """
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if text == "":
            return 0.0
        try:
            return float(text)
        except ValueError:
            return math.nan
    return math.nan


def js_round(value: float) -> int:
    """JS 的 ``Math.round``：.5 一律向上，而不是 Python 的四舍六入五取偶。"""
    if math.isnan(value) or math.isinf(value):
        return 0
    return math.floor(value + 0.5)


def js_str(value: Any) -> str:
    """等价于 JS 的 ``String(value)``：整数浮点不带 ``.0``，布尔小写。"""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def narrow_numbers(value: Any) -> Any:
    """把整数浮点收成 int，与 JS 的 JSON 序列化对齐。

    JS 里 ``6`` 和 ``6.0`` 是同一个数，``JSON.stringify`` 都写成 ``6``；Python 写出来
    是 ``6.0``。上游 ComfyUI/RunningHub 的 INT 字段收到 ``6.0`` 会当类型错误拒掉，
    所以定义出口统一收一次，两端提交的字节才一致。
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else value
    if isinstance(value, dict):
        return {key: narrow_numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [narrow_numbers(item) for item in value]
    return value


def finite(value: Any, fallback: float, minimum: float = 0) -> float:
    parsed = js_number(value)
    return max(minimum, parsed) if math.isfinite(parsed) else fallback


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return int(value) if float(value).is_integer() else None


def _items(node: Mapping[str, Any] | None, key: str = "items") -> list[dict[str, Any]]:
    raw = (node or {}).get(key)
    return [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []


def _conn_kind(connection: Mapping[str, Any]) -> str:
    kind = connection.get("kind")
    return kind if isinstance(kind, str) and kind != "" else "flow"


def conn_key(source: str, target: str, kind: str = "flow") -> str:
    return f"{source}→{target}→{kind}"


def cascade_pool_size(configured: Any, total_rounds: int) -> int:
    """并发模式实际开几个并行槽：节点配置 → 默认 → 物理上限 → 轮数四重夹逼。"""
    parsed = js_number(configured) if configured is not None else math.nan
    want = parsed if math.isfinite(parsed) and parsed > 0 else float(CASCADE_POOL_DEFAULT)
    capped = max(1, min(math.floor(want), CASCADE_POOL_MAX))
    return max(1, min(capped, max(1, total_rounds)))


# ---------------------------------------------------------------- 执行链与轮次


def chain_edges(doc: CanvasDoc) -> list[dict[str, Any]]:
    """执行链只认用户手连的 input 边；历史节点的边一律不算。"""
    by_id = doc.by_id()
    out: list[dict[str, Any]] = []
    for connection in doc.connections:
        if _conn_kind(connection) != "input":
            continue
        source = by_id.get(str(connection.get("from")))
        target = by_id.get(str(connection.get("to")))
        if source is None or target is None:
            continue
        if source.get("history_for") is not None or target.get("history_for") is not None:
            continue
        out.append(connection)
    return out


@dataclass(frozen=True)
class Chain:
    order: list[str]
    edge_keys: list[str]


def cascade_chain(doc: CanvasDoc, start_id: str) -> Chain:
    """沿 input 边拓扑排序。

    - loop 起点：它的直接下游是 root，从 root 往下游铺开；
    - 图节点起点（链尾）：把它的全部上游拉进来，从链头开始跑。
    """
    by_id = doc.by_id()
    start = by_id.get(start_id)
    if start is None:
        return Chain([], [])
    edges = chain_edges(doc)
    from_loop = start.get("type") == "loop"

    member: list[str] = []
    seen: set[str] = set()
    queue: list[str] = []
    if from_loop:
        queue.extend(str(c["to"]) for c in edges if str(c.get("from")) == start_id)
    else:
        queue.append(start_id)
    while queue:
        current = queue.pop(0)
        if current in seen:
            continue
        seen.add(current)
        member.append(current)
        for edge in edges:
            source, target = str(edge.get("from")), str(edge.get("to"))
            if from_loop:
                if source == current and target not in seen:
                    queue.append(target)
            elif target == current and source not in seen:
                queue.append(source)
    # loop 自己不出图，成环时会被 BFS 带进来，摘掉
    if from_loop and start_id in seen:
        seen.discard(start_id)
        member = [node_id for node_id in member if node_id != start_id]

    sub = [
        edge
        for edge in edges
        if str(edge.get("from")) in seen and str(edge.get("to")) in seen
    ]
    indeg = dict.fromkeys(member, 0)
    for edge in sub:
        target = str(edge["to"])
        indeg[target] = indeg.get(target, 0) + 1
    ready = [node_id for node_id in member if indeg.get(node_id, 0) == 0]
    order: list[str] = []
    while ready:
        current = ready.pop(0)
        order.append(current)
        for edge in sub:
            if str(edge.get("from")) != current:
                continue
            target = str(edge["to"])
            left = indeg.get(target, 1) - 1
            indeg[target] = left
            if left == 0:
                ready.append(target)
    # 有环时剩下的按发现顺序补在后面，别让整条链跑不起来
    for node_id in member:
        if node_id not in order:
            order.append(node_id)
    keys = [conn_key(str(e["from"]), str(e["to"]), _conn_kind(e)) for e in sub]
    return Chain(order, keys)


def loop_for(doc: CanvasDoc, order: Sequence[str]) -> dict[str, Any] | None:
    """链上挂的 loop 节点：从链尾出发时也认它的轮数与串并行设置。"""
    by_id = doc.by_id()
    in_chain = set(order)
    for connection in doc.connections:
        # 与 chain_edges 同口径：一条血缘边不该把轮数带进来
        if _conn_kind(connection) != "input" or str(connection.get("to")) not in in_chain:
            continue
        upstream = by_id.get(str(connection.get("from")))
        if upstream is not None and upstream.get("type") == "loop":
            return upstream
    return None


def is_cascade_executable(node: Mapping[str, Any] | None) -> bool:
    return node is not None and node.get("type") in CASCADE_EXECUTABLE_TYPES


def modelscope_count(node: Mapping[str, Any]) -> int:
    return max(1, min(js_round(js_number(node.get("ms_count", 1) or 1)), MODELSCOPE_MAX_COUNT))


def loop_rounds(loop: Mapping[str, Any] | None) -> int:
    """这条链跑几轮。没挂循环就是一轮；挂了但没填轮数按 3 轮算（与前端 `planOf` 同默认）。"""
    if loop is None:
        return 1
    count = loop.get("count")
    return max(1, min(int(js_number(count)) if count is not None else 3, LOOP_MAX))


@dataclass(frozen=True)
class LoopRound:
    index: int
    ordinal: int
    slice: tuple[int, int] | None


def loop_batch(loop: Mapping[str, Any]) -> int:
    """没开逐张喂图时步长恒为 1，否则改「每轮取几张」会连《计数》的步进一起改掉。"""
    if loop.get("image_input") is not True:
        return 1
    return max(1, min(int(js_number(loop.get("image_batch_size", 1) or 1)), 100))


def loop_schedule(loop: Mapping[str, Any]) -> tuple[list[LoopRound], int, int, int]:
    """轮次编排：每轮的编号、取第几条提示词、取哪几张上游图。

    三条规则与前端 `loopSchedule` 逐字对应——步长是 batch 不是 1、《总数》是末轮
    编号不是轮数、取图越界不回绕。
    """
    raw_count = loop.get("count")
    count = max(1, min(int(js_number(raw_count)) if raw_count is not None else 1, LOOP_MAX))
    start = max(1, int(js_number(loop.get("loop_start", 1) or 1)))
    batch = loop_batch(loop)
    end = start + (count - 1) * batch
    rounds = [
        LoopRound(
            index=start + i * batch,
            ordinal=i,
            slice=(start + i * batch, batch) if loop.get("image_input") is True else None,
        )
        for i in range(count)
    ]
    return rounds, start, end, batch


def apply_round_vars(text: str, round_index: int, total: int) -> str:
    return (
        text.replace("《计数》", str(round_index))
        .replace("《总数》", str(total))
        .replace("《进度》", f"{round_index}/{total}")
    )


# ---------------------------------------------------------------- 提示词与参考


def _draft_refs(node: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    raw = (node or {}).get("prompt_draft_refs")
    return [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []


def _member_ids(node: Mapping[str, Any]) -> list[str]:
    raw = node.get("member_ids")
    return [str(item) for item in raw] if isinstance(raw, list) else []


def _member_text(member: Mapping[str, Any]) -> str:
    """组里成员贡献的文字：提示词节点取 ``text``，LLM 节点取上次产出。"""
    return _text(member.get("text") if member.get("type") == "prompt" else member.get("llm_output"))


def loop_prompt_items(doc: CanvasDoc, loop_id: str, seen: set[str] | None = None) -> list[str]:
    """循环节点中继的上游提示词，按连线顺序拉平。

    循环自己不产词，但它把上游的词按轮次轮换取用。少了这一层，
    `提示词 → 循环 → 图片` 这条最常见的链上提示词会整段消失。
    """
    seen = set() if seen is None else seen
    if loop_id in seen:
        return []
    seen.add(loop_id)
    by_id = doc.by_id()
    out: list[str] = []
    for connection in doc.connections:
        if str(connection.get("to")) != loop_id or _conn_kind(connection) == "history":
            continue
        upstream = by_id.get(str(connection.get("from")))
        if upstream is None:
            continue
        kind = upstream.get("type")
        if kind == "loop":
            out.extend(loop_prompt_items(doc, str(upstream["id"]), seen))
            continue
        if kind == "prompt":
            text = _text(upstream.get("text"))
            if text != "":
                out.append(text)
            continue
        if kind == "llm":
            text = _text(upstream.get("llm_output"))
            if text != "":
                out.append(text)
            continue
        if kind == "group":
            for member_id in _member_ids(upstream):
                member = by_id.get(member_id)
                if member is None or member.get("type") not in ("prompt", "llm"):
                    continue
                text = _member_text(member)
                if text != "":
                    out.append(text)
    return out


def compose_prompt(
    doc: CanvasDoc,
    node_id: str,
    loop_contribution: Callable[[str], str] | None = None,
) -> str:
    """直接上游的提示词在前、节点自己的草稿在后，@ 引用另起一张编号映射表。"""
    by_id = doc.by_id()
    parts: list[str] = []

    def take(node: Mapping[str, Any] | None) -> None:
        if node is None:
            return
        kind = node.get("type")
        if kind == "loop":
            text = _text(loop_contribution(str(node["id"]))) if loop_contribution else ""
            if text != "":
                parts.append(text)
            return
        if kind == "prompt":
            text = _text(node.get("text"))
            if text != "":
                parts.append(text)
            return
        if kind == "llm":
            text = _text(node.get("llm_output"))
            if text != "":
                parts.append(text)
            return
        if kind != "group":
            return
        for member_id in _member_ids(node):
            member = by_id.get(member_id)
            if member is None or member.get("type") not in ("prompt", "llm"):
                continue
            text = _member_text(member)
            if text != "":
                parts.append(text)

    for connection in doc.connections:
        if str(connection.get("to")) != node_id or _conn_kind(connection) == "history":
            continue
        take(by_id.get(str(connection.get("from"))))
    node = by_id.get(node_id)
    draft = _text((node or {}).get("prompt_draft"))
    if draft != "":
        parts.append(draft)
    body = "\n".join(dict.fromkeys(parts))

    refs = _draft_refs(node)
    if not refs or body == "":
        return body
    # 只给真正会上送的那几张编号；超限的把正文里的「图N」回写成「@名字」
    kept, dropped = refs[:MAX_REFS], refs[MAX_REFS:]
    text = body
    for index, reference in enumerate(dropped):
        text = text.replace(f"图{MAX_REFS + index + 1}", f"@{reference.get('label', '')}")
    table = "\n".join(
        f"图{index + 1}：{reference.get('label', '')}（asset {reference.get('asset_id')}）"
        for index, reference in enumerate(kept)
    )
    return f"{table}\n\n用户需求：{text}"


def reference_asset_ids(doc: CanvasDoc, node_id: str) -> list[int]:
    """出图使用的参考图顺序：@ 引用 → 附件 → 自身 → 上游 → 手动参考，按真实请求顺序去重。"""
    by_id = doc.by_id()
    out: list[int] = []
    seen: set[int] = set()

    def push(items: Iterable[Mapping[str, Any]]) -> None:
        for item in items:
            asset_id = _int_or_none(item.get("asset_id"))
            if asset_id is None or asset_id in seen or len(out) >= MAX_REFS:
                continue
            seen.add(asset_id)
            out.append(asset_id)

    start = by_id.get(node_id)
    if start is None:
        return out
    push({"asset_id": ref.get("asset_id")} for ref in _draft_refs(start))
    push(_items(start, "attachments"))
    push(_items(start))
    visited = {node_id}
    queue = [node_id]
    while queue and len(out) < MAX_REFS:
        current = queue.pop(0)
        for connection in doc.connections:
            if str(connection.get("to")) != current or _conn_kind(connection) == "history":
                continue
            source = str(connection.get("from"))
            if source in visited:
                continue
            visited.add(source)
            upstream = by_id.get(source)
            if upstream is None or upstream.get("history_for") is not None:
                continue
            if upstream.get("type") in ("image", "output", "group"):
                push(_items(upstream))
            queue.append(source)
    push(_items(start, "manual_references"))
    return out


def reference_media_items(doc: CanvasDoc, node_id: str) -> list[dict[str, Any]]:
    """MiniMax/工作流用的多模态参考：保留图片、视频和音频的类型与顺序。"""
    by_id = doc.by_id()
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    def push(items: Iterable[Mapping[str, Any]]) -> None:
        for item in items:
            kind = item.get("kind")
            if kind not in ("image", "video", "audio"):
                continue
            asset_id = _int_or_none(item.get("asset_id"))
            media_id = _int_or_none(item.get("media_asset_id"))
            url = item.get("url")
            if asset_id is not None:
                key = f"image:{asset_id}"
            elif media_id is not None:
                key = f"{kind}:{media_id}"
            elif isinstance(url, str) and url != "":
                key = f"{kind}:url:{url}"
            else:
                continue
            if key in seen or len(out) >= MEDIA_REF_LIMIT:
                continue
            seen.add(key)
            out.append(dict(item))

    start = by_id.get(node_id)
    if start is None:
        return out
    push(
        {"asset_id": ref.get("asset_id"), "kind": "image", "name": ref.get("label")}
        for ref in _draft_refs(start)
    )
    push(_items(start, "attachments"))
    push(_items(start))
    visited = {node_id}
    queue = [node_id]
    while queue and len(out) < MEDIA_REF_LIMIT:
        current = queue.pop(0)
        for connection in doc.connections:
            if str(connection.get("to")) != current or _conn_kind(connection) == "history":
                continue
            source = str(connection.get("from"))
            if source in visited:
                continue
            visited.add(source)
            upstream = by_id.get(source)
            if upstream is None or upstream.get("history_for") is not None:
                continue
            if upstream.get("type") in ("image", "video", "audio", "output", "group"):
                push(_items(upstream))
            queue.append(source)
    push(_items(start, "manual_references"))
    return out


def loop_upstream_images(doc: CanvasDoc, loop_id: str, seen: set[str] | None = None) -> list[int]:
    """循环节点上游的全部图，按连线顺序拉平。

    这里刻意不做 MAX_REFS 截断：截断要放在切片之后，否则第 11 张起永远切不到，
    而「逐张喂图」的常见用法恰恰是喂几十张。
    """
    seen = set() if seen is None else seen
    if loop_id in seen:
        return []
    seen.add(loop_id)
    by_id = doc.by_id()
    out: list[int] = []
    for connection in doc.connections:
        if str(connection.get("to")) != loop_id or _conn_kind(connection) != "input":
            continue
        upstream = by_id.get(str(connection.get("from")))
        if upstream is None:
            continue
        if upstream.get("type") == "loop":
            out.extend(loop_upstream_images(doc, str(upstream["id"]), seen))
            continue
        for item in _items(upstream):
            asset_id = _int_or_none(item.get("asset_id"))
            if asset_id is not None and asset_id not in out:
                out.append(asset_id)
    return out


# ---------------------------------------------------------------- 工作流字段绑定


def _nullish(*values: Any) -> Any:
    """JS 的 ``??`` 链：只在 null/undefined 时才往后取，空串和 0 都算有值。"""
    for value in values:
        if value is not None:
            return value
    return None


def workflow_fields(detail: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    schema = (detail or {}).get("ui_schema")
    fields = schema.get("fields") if isinstance(schema, dict) else None
    return [f for f in fields if isinstance(f, dict)] if isinstance(fields, list) else []


def workflow_field_id(field_spec: Mapping[str, Any], index: int) -> str:
    raw = field_spec.get("id")
    if isinstance(raw, str) and raw != "":
        return raw
    node_part = js_str(_nullish(field_spec.get("node"), field_spec.get("nodeId"), index))
    input_part = js_str(_nullish(field_spec.get("input"), field_spec.get("fieldName"), index))
    return f"{node_part}::{input_part}"


def workflow_field_label(field_spec: Mapping[str, Any], index: int) -> str:
    return js_str(
        _nullish(
            field_spec.get("name"),
            field_spec.get("label"),
            field_spec.get("input"),
            field_spec.get("fieldName"),
            f"参数 {index + 1}",
        )
    )


def workflow_field_type(field_spec: Mapping[str, Any]) -> str:
    return js_str(_nullish(field_spec.get("type"), field_spec.get("fieldType"), "text")).lower()


def workflow_field_default(field_spec: Mapping[str, Any]) -> Any:
    return _nullish(field_spec.get("default"), field_spec.get("fieldValue"), "")


def workflow_field_media_kind(field_spec: Mapping[str, Any]) -> str | None:
    kind = workflow_field_type(field_spec)
    if "image" in kind:
        return "image"
    if "video" in kind:
        return "video"
    if "audio" in kind:
        return "audio"
    return None


def _runninghub_field_text(field_spec: Mapping[str, Any]) -> str:
    keys = (
        "id", "node", "nodeId", "input", "fieldName", "name",
        "label", "group", "title", "description", "note", "source",
    )
    return " ".join(
        js_str(field_spec[key]) for key in keys if field_spec.get(key) is not None
    ).lower()


def minimax_runninghub_field_role(field_spec: Mapping[str, Any]) -> str | None:
    """对齐 Infinite-Canvas 的 MiniMax RunningHub 语义匹配和固定工作流兜底键。"""
    field_id = workflow_field_id(field_spec, 0)
    text = _runninghub_field_text(field_spec)
    if field_id == "138::value" or _PROMPT_ROLE.search(text):
        return "prompt"
    if field_id == "132::value" or _DURATION_ROLE.search(text):
        return "duration"
    if field_id == "115::aspect_ratio" or _ASPECT_ROLE.search(text):
        return "aspect_ratio"
    if field_id == "115::megapixels" or _MEGAPIXELS_ROLE.search(text):
        return "megapixels"
    if _SEED_ROLE.search(text):
        return "seed"
    return None


def _minimax_runninghub_value(field_spec: Mapping[str, Any], role: str, value: Any) -> Any:
    if role == "duration":
        return max(1, min(60, js_number(value) if _truthy_number(value) else 8))
    if role == "megapixels":
        return max(0.1, min(2, js_number(value) if _truthy_number(value) else 0.4))
    if role == "seed":
        return max(0, js_round(js_number(value) if _truthy_number(value) else 0))
    if role != "aspect_ratio":
        return value
    desired = js_str(_nullish(value, "16:9 (Widescreen)"))
    matched = _RATIO_IN_TEXT.search(desired)
    ratio = matched.group(0).replace(" ", "") if matched else desired
    raw_options = field_spec.get("options")
    options = [js_str(item) for item in raw_options] if isinstance(raw_options, list) else []
    normalized = ratio.replace(" ", "")
    option = next((item for item in options if item.replace(" ", "") == normalized), None)
    if option is None:
        option = next(
            (item for item in options if item.replace(" ", "").startswith(normalized)), None
        )
    if option is not None:
        return option
    default_value = js_str(_nullish(workflow_field_default(field_spec), ""))
    return desired if "(" in default_value else ratio


def _truthy_number(value: Any) -> bool:
    """JS 的 ``Number(value) || fallback``：NaN 和 0 都会落到 fallback。"""
    parsed = js_number(value)
    return math.isfinite(parsed) and parsed != 0


def random_workflow_value(field_spec: Mapping[str, Any], rng: Callable[[], float]) -> int:
    minimum = js_number(_nullish(field_spec.get("min"), 0))
    maximum = min(js_number(_nullish(field_spec.get("max"), 4_294_967_295)), 2**53 - 1)
    low = minimum if math.isfinite(minimum) else 0.0
    high = maximum if math.isfinite(maximum) and maximum >= low else 4_294_967_295.0
    return math.floor(low + rng() * (high - low + 1))


def workflow_media_by_kind(
    media_refs: Sequence[Mapping[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    return {
        kind: [dict(item) for item in media_refs if item.get("kind") == kind]
        for kind in ("image", "video", "audio")
    }


def workflow_timeline_mode(title: str | None) -> str | None:
    normalized = (title or "").lower()
    if "ltx director" in normalized:
        return "ltx"
    if "minimax" in normalized:
        return "minimax"
    return None


def _ordered_ltx_segments(segments: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    normalized = [
        {
            **segment,
            "start": js_round(finite(segment.get("start"), 0)),
            "length": max(1, js_round(finite(segment.get("length"), 1, 1))),
        }
        for segment in segments
    ]
    return sorted(normalized, key=lambda s: (s["start"], str(s.get("id", ""))))


def _ordered_audio_segments(segments: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    normalized = [
        {
            **segment,
            "start": js_round(finite(segment.get("start"), 0)),
            "length": max(1, js_round(finite(segment.get("length"), 1, 1))),
            "trim_start": js_round(finite(segment.get("trim_start"), 0)),
        }
        for segment in segments
    ]
    return sorted(normalized, key=lambda s: (s["start"], str(s.get("id", ""))))


def _reflow(segments: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    cursor = 0.0
    out: list[dict[str, Any]] = []
    for segment in segments:
        item = {**segment, "start": cursor, "length": finite(segment.get("length"), 1, 0.1)}
        cursor += item["length"]
        out.append(item)
    return out


def _initial_segment(
    mode: str,
    node: Mapping[str, Any],
    asset_id: int | None,
    index: int,
    linked_prompt: str,
    rng: Callable[[], float],
) -> dict[str, Any]:
    values = node.get("workflow_values") or {}
    timeline = node.get("workflow_timeline") or {}
    segment_id = f"initial-{node.get('id')}" if asset_id is None else f"ref-{asset_id}-{index}"
    if mode == "ltx":
        frame_rate = finite(_nullish(timeline.get("frame_rate"), values.get("f_frame_rate")), 24, 1)
        return {
            "id": segment_id,
            "start": 0,
            "length": frame_rate,
            "prompt": linked_prompt,
            "type": "text" if asset_id is None else "image",
            "asset_id": asset_id,
            "guideStrength": 1,
        }
    return {
        "id": segment_id,
        "start": 0,
        "length": finite(values.get("f_duration_seconds"), 8, 0.5),
        "prompt": js_str(_nullish(values.get("f_prompt"), linked_prompt)),
        "type": "text" if asset_id is None else "image",
        "asset_id": asset_id,
        "aspect_ratio": js_str(_nullish(values.get("f_aspect_ratio"), MINIMAX_ASPECTS[0])),
        "megapixels": finite(values.get("f_megapixels"), 0.4, 0.1),
        "seed": finite(values.get("f_seed"), math.floor(rng() * 4_294_967_296), 0),
    }


@dataclass(frozen=True)
class ResolvedTimeline:
    segments: list[dict[str, Any]]
    selected_id: str | None
    frame_rate: float | None
    duration_frames: int | None
    audio_segments: list[dict[str, Any]]


def read_timeline(
    mode: str,
    node: Mapping[str, Any],
    refs: Sequence[int],
    linked_prompt: str,
    rng: Callable[[], float],
) -> ResolvedTimeline:
    """只解析出运行参数要用的那几项；纯 UI 的轨道高度、缩放留在前端。"""
    stored = node.get("workflow_timeline")
    stored = stored if isinstance(stored, dict) else {}
    raw_segments = stored.get("segments")
    stored_segments = (
        [s for s in raw_segments if isinstance(s, dict) and isinstance(s.get("id"), str)]
        if stored.get("kind") == mode and isinstance(raw_segments, list)
        else []
    )
    if stored_segments:
        segments = [dict(segment) for segment in stored_segments]
        claimed = {segment.get("asset_id") for segment in segments}
        unclaimed = [asset_id for asset_id in refs if asset_id not in claimed]
        if mode == "minimax":
            cursor = 0
            filled: list[dict[str, Any]] = []
            for segment in segments:
                asset_id = unclaimed[cursor] if cursor < len(unclaimed) else None
                if segment.get("asset_id") is not None or asset_id is None:
                    filled.append(segment)
                    continue
                cursor += 1
                filled.append({**segment, "type": "image", "asset_id": asset_id})
            segments = filled
            segments.extend(
                _initial_segment(mode, node, asset_id, len(segments) + index, linked_prompt, rng)
                for index, asset_id in enumerate(unclaimed[cursor:])
            )
        else:
            segments.extend(
                _initial_segment(mode, node, asset_id, len(segments) + index, linked_prompt, rng)
                for index, asset_id in enumerate(unclaimed)
            )
    else:
        seeds: list[int | None] = list(refs) if refs else [None]
        segments = [
            _initial_segment(mode, node, asset_id, index, linked_prompt, rng)
            for index, asset_id in enumerate(seeds)
        ]

    normalized = _ordered_ltx_segments(segments) if mode == "ltx" else _reflow(segments)
    stored_selected = stored.get("selected_id")
    selected_id = (
        stored_selected
        if any(segment.get("id") == stored_selected for segment in normalized)
        else (normalized[0].get("id") if normalized else None)
    )
    if mode != "ltx":
        return ResolvedTimeline(normalized, selected_id, None, None, [])
    raw_audio = stored.get("audio_segments")
    audio = _ordered_audio_segments(
        [item for item in raw_audio if isinstance(item, dict)]
        if isinstance(raw_audio, list)
        else []
    )
    values = node.get("workflow_values") or {}
    furthest = max(
        [120.0, *[float(s["start"]) + float(s["length"]) for s in normalized]],
    )
    stored_duration = _nullish(stored.get("duration_frames"), values.get("f_duration_frames"))
    duration_frames = js_round(finite(stored_duration, furthest, 1))
    frame_rate = finite(_nullish(stored.get("frame_rate"), values.get("f_frame_rate")), 24, 1)
    return ResolvedTimeline(normalized, selected_id, frame_rate, duration_frames, audio)


def workflow_timeline_run_values(
    mode: str,
    node: Mapping[str, Any],
    refs: Sequence[int],
    linked_prompt: str,
    media_refs: Sequence[Mapping[str, Any]] | None = None,
    rng: Callable[[], float] = random.random,
) -> dict[str, Any]:
    """时间线编辑器写回工作流字段的那一组语义键（f_*）。"""
    if media_refs is None:
        media_refs = [{"asset_id": asset_id, "kind": "image"} for asset_id in refs]
    timeline = read_timeline(mode, node, refs, linked_prompt, rng)
    if mode == "minimax":
        active = next(
            (s for s in timeline.segments if s.get("id") == timeline.selected_id),
            timeline.segments[0] if timeline.segments else None,
        )
        if active is None:
            return {}
        raw_references = active.get("references")
        if isinstance(raw_references, list) and raw_references:
            references: Sequence[Mapping[str, Any]] = [
                item for item in raw_references if isinstance(item, dict)
            ]
        elif active.get("asset_id") is not None:
            references = [{"asset_id": active["asset_id"], "kind": "image"}]
        else:
            references = media_refs
        counts = {"image": 0, "video": 0, "audio": 0}
        typed: list[dict[str, str]] = []
        for reference in references:
            kind = reference.get("kind")
            if kind not in counts:
                continue
            limit = 9 if kind == "image" else 3
            if counts[kind] >= limit:
                continue
            asset_id = _int_or_none(reference.get("asset_id"))
            media_id = _int_or_none(reference.get("media_asset_id"))
            if kind == "image" and asset_id is not None:
                ref = f"asset:{asset_id}"
            elif kind != "image" and media_id is not None:
                ref = f"media:{media_id}"
            else:
                continue
            counts[kind] += 1
            typed.append({"kind": kind, "ref": ref})
        first_image = next((entry for entry in typed if entry["kind"] == "image"), None)
        return {
            "f_reference_image": first_image["ref"] if first_image else "",
            "f_minimax_references": typed,
            "f_prompt": active.get("prompt") or linked_prompt,
            "f_duration_seconds": finite(active.get("length"), 8, 0.5),
            "f_aspect_ratio": _nullish(active.get("aspect_ratio"), MINIMAX_ASPECTS[0]),
            "f_megapixels": finite(active.get("megapixels"), 0.4, 0.1),
            "f_seed": js_round(finite(active.get("seed"), 0, 0)),
        }

    frame_rate = timeline.frame_rate if timeline.frame_rate is not None else 24.0
    values = node.get("workflow_values") or {}
    fallback_prompt = (
        linked_prompt.strip() or _text(values.get("f_global_prompt")) or "."
    )
    duration_frames = timeline.duration_frames if timeline.duration_frames is not None else 120
    segments: list[dict[str, Any]] = []
    for segment in _ordered_ltx_segments(timeline.segments):
        frame: dict[str, Any] = {
            "id": segment.get("id"),
            "start": js_round(float(segment["start"])),
            "length": max(1, js_round(float(segment["length"]))),
            "prompt": _text(segment.get("prompt")) or fallback_prompt,
            "type": segment.get("type"),
        }
        if segment.get("asset_id") is not None:
            frame["asset_id"] = segment["asset_id"]
        if segment.get("type") == "image":
            frame["guideStrength"] = f"{finite(segment.get('guideStrength'), 1, 0):.2f}"
        segments.append(frame)

    relay_lengths: list[int] = []
    relay_prompts: list[str] = []
    cursor = 0
    pending_gap = 0
    for segment in segments:
        if segment["start"] >= duration_frames:
            break
        if segment["start"] > cursor:
            gap = min(segment["start"], duration_frames) - cursor
            if relay_lengths:
                relay_lengths[-1] += gap
            else:
                pending_gap += gap
        clipped = min(segment["start"] + segment["length"], duration_frames) - segment["start"]
        relay_lengths.append(clipped + pending_gap)
        relay_prompts.append(segment["prompt"])
        pending_gap = 0
        cursor = segment["start"] + segment["length"]
    if relay_lengths and min(cursor, duration_frames) < duration_frames:
        relay_lengths[-1] += duration_frames - min(cursor, duration_frames)
    if not relay_lengths:
        relay_lengths.append(duration_frames)
        relay_prompts.append(fallback_prompt)

    audio_segments: list[dict[str, Any]] = []
    for segment in _ordered_audio_segments(timeline.audio_segments):
        entry: dict[str, Any] = {
            "id": segment.get("id"),
            "type": "audio",
            "start": segment["start"],
            "length": segment["length"],
            "trimStart": segment["trim_start"],
            "audioDurationFrames": max(
                segment["length"],
                js_round(finite(segment.get("audio_duration_frames"), segment["length"], 1)),
            ),
        }
        if segment.get("media_asset_id") is not None:
            entry["media_asset_id"] = segment["media_asset_id"]
        if segment.get("url") is not None:
            entry["url"] = segment["url"]
        if segment.get("name") is not None:
            entry["fileName"] = segment["name"]
        audio_segments.append(entry)

    return {
        "f_timeline_data": json.dumps(
            {"segments": segments, "audioSegments": audio_segments},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        "f_local_prompts": " | ".join(relay_prompts),
        "f_segment_lengths": ",".join(str(length) for length in relay_lengths),
        "f_guide_strength": ",".join(
            str(segment["guideStrength"]) for segment in segments if segment["type"] == "image"
        ),
        "f_duration_frames": duration_frames,
        "f_duration_seconds": js_round(duration_frames / frame_rate * 1000) / 1000,
        "f_frame_rate": frame_rate,
    }


@dataclass(frozen=True)
class PreparedWorkflowRun:
    fields: dict[str, Any]
    missing_media: list[str]
    source_context: dict[str, Any]


def prepare_canvas_workflow_run(
    detail: Mapping[str, Any],
    node: Mapping[str, Any],
    media_refs: Sequence[Mapping[str, Any]],
    linked_prompt: str,
    rng: Callable[[], float] = random.random,
) -> PreparedWorkflowRun:
    """手动运行与画布级联共用同一份字段绑定，避免两条入口得到不同任务。"""
    provider = detail.get("provider")
    all_fields = [
        f
        for f in workflow_fields(detail)
        if provider == "comfyui" or f.get("enabled") is not False
    ]
    refs = [
        asset_id
        for item in workflow_media_by_kind(media_refs)["image"]
        if (asset_id := _int_or_none(item.get("asset_id"))) is not None
    ]
    mode = workflow_timeline_mode(_nullish(detail.get("title"), node.get("title")))
    timeline = node.get("workflow_timeline")
    timeline = timeline if isinstance(timeline, dict) else {}
    stored_segments = [s for s in (timeline.get("segments") or []) if isinstance(s, dict)]
    active_segment: dict[str, Any] | None = None
    if mode == "minimax":
        active_segment = next(
            (s for s in stored_segments if s.get("id") == timeline.get("selected_id")),
            stored_segments[0] if stored_segments else None,
        )
    active_references = (active_segment or {}).get("references")
    if isinstance(active_references, list) and active_references:
        minimax_references: Sequence[Mapping[str, Any]] = [
            item for item in active_references if isinstance(item, dict)
        ]
    elif active_segment is not None and active_segment.get("asset_id") is not None:
        minimax_references = [{"asset_id": active_segment["asset_id"], "kind": "image"}]
    else:
        minimax_references = media_refs
    media_by_kind = workflow_media_by_kind(
        minimax_references if mode == "minimax" else media_refs
    )
    values = node.get("workflow_values") or {}
    prepared_values = dict(values)
    if mode is not None:
        prepared_values.update(
            workflow_timeline_run_values(mode, node, refs, linked_prompt, media_refs, rng)
        )

    run_values: dict[str, Any] = {}
    missing_media: list[str] = []
    media_indexes = {"image": 0, "video": 0, "audio": 0}
    random_fields = node.get("workflow_random_fields") or {}
    for index, field_spec in enumerate(all_fields):
        field_id = workflow_field_id(field_spec, index)
        media_kind = workflow_field_media_kind(field_spec)
        if media_kind is not None:
            bucket = media_by_kind[media_kind]
            cursor = media_indexes[media_kind]
            item = bucket[cursor] if cursor < len(bucket) else None
            media_indexes[media_kind] += 1
            explicit = prepared_values.get(field_id)
            if explicit is not None and js_str(explicit).strip() != "":
                run_values[field_id] = explicit
            elif media_kind == "image" and (item or {}).get("asset_id") is not None:
                run_values[field_id] = f"asset:{item['asset_id']}"  # type: ignore[index]
            elif media_kind != "image" and (item or {}).get("media_asset_id") is not None:
                run_values[field_id] = f"media:{item['media_asset_id']}"  # type: ignore[index]
            elif field_spec.get("required") is True:
                missing_media.append(workflow_field_label(field_spec, index))
            continue
        value = prepared_values.get(field_id)
        if value is None and mode == "minimax" and provider == "runninghub":
            role = minimax_runninghub_field_role(field_spec)
            if role is not None:
                semantic_id = (
                    "f_duration_seconds"
                    if role == "duration"
                    else "f_aspect_ratio"
                    if role == "aspect_ratio"
                    else f"f_{role}"
                )
                value = _minimax_runninghub_value(
                    field_spec, role, prepared_values.get(semantic_id)
                )
        if value is None and field_spec.get("bind_prompt") is True and linked_prompt != "":
            value = linked_prompt
        if value is None:
            value = workflow_field_default(field_spec)
        if field_spec.get("random_enabled") is True and random_fields.get(field_id) is not False:
            value = random_workflow_value(field_spec, rng)
        if value is not None:
            run_values[field_id] = value
    context = (
        {"workflow_segment_id": timeline["selected_id"]}
        if mode == "minimax" and timeline.get("selected_id") is not None
        else {}
    )
    return PreparedWorkflowRun(run_values, missing_media, context)


# ---------------------------------------------------------------- 请求参数归一


def size_param(size: Any) -> str:
    """空画幅归一成 ``auto``：老节点存的空串不归一会一直出超宽图。"""
    value = _text(size)
    return AUTO_SIZE if value == "" else value


def normalize_quality(value: Any) -> str:
    return image_defaults.normalize_quality(value if isinstance(value, str) else None)


def modelscope_job_options(
    node: Mapping[str, Any], reference_asset_ids: Sequence[int]
) -> dict[str, Any]:
    """从节点快照生成稳定请求参数；UI 输入在这里统一收口。"""
    options: dict[str, Any] = {}
    negative = _text(node.get("ms_negative_prompt"))
    if negative != "":
        options["negative_prompt"] = negative
    seed = node.get("ms_seed")
    if isinstance(seed, int | float) and not isinstance(seed, bool) and math.isfinite(seed):
        options["seed"] = max(0, min(js_round(seed), 2**31 - 1))
    steps = node.get("ms_steps")
    if isinstance(steps, int | float) and not isinstance(steps, bool) and math.isfinite(steps):
        options["steps"] = max(1, min(js_round(steps), 100))
    guidance = node.get("ms_guidance")
    if isinstance(guidance, int | float) and not isinstance(guidance, bool) and math.isfinite(
        guidance
    ):
        options["guidance"] = max(1.5, min(float(guidance), 20))
    lora_id = _text(node.get("ms_lora_id"))
    if node.get("ms_lora_enabled") is True and lora_id != "":
        strength = node.get("ms_lora_strength")
        options["loras"] = {
            lora_id: max(0.0, min(js_number(strength) if strength is not None else 0.8, 1.0))
        }
    options["ref_asset_ids"] = list(reference_asset_ids[:MODELSCOPE_MAX_REFS])
    return options


def resolve_video_adapter(
    settings: Mapping[str, Any], deployment_adapters: Mapping[int, str]
) -> str:
    """部署目录说了算；目录里没有就退回导入文档保留的供应商提示。"""
    deployment_id = _int_or_none(settings.get("deployment_id"))
    if deployment_id is not None:
        adapter = deployment_adapters.get(deployment_id)
        if adapter in ("volcengine", "jimeng"):
            return adapter
    hint = f"{settings.get('provider_hint') or ''} {settings.get('model_hint') or ''}".lower()
    if any(word in hint for word in ("jimeng", "dreamina", "即梦")):
        return "jimeng"
    if any(word in hint for word in ("volc", "ark", "seedance")):
        return "volcengine"
    return "openai"


def video_request_options(
    settings: Mapping[str, Any], adapter: str, has_references: bool
) -> dict[str, Any]:
    """只下发当前适配器公开协议能承载的参数，避免伪开关。"""
    if adapter == "openai":
        return {}
    if adapter == "jimeng":
        return {"multimodal": settings.get("reference_mode") == "multimodal"}
    options: dict[str, Any] = {
        "generate_audio": settings.get("generate_audio") is True,
        "watermark": settings.get("watermark") is True,
        # 方舟公开协议明确不支持「参考图 + 固定机位」
        "camera_fixed": False if has_references else settings.get("fixed_camera") is True,
    }
    seed = settings.get("seed")
    if isinstance(seed, int | float) and not isinstance(seed, bool) and math.isfinite(seed):
        options["seed"] = max(-1, min(js_round(seed), 2**32 - 1))
    return options


def normalized_video_resolution(
    resolution: Any, adapter: str, model_id: str = "", reference_mode: str = "first_frame"
) -> str:
    requested = js_str(_nullish(resolution, "720p")).lower()
    if adapter != "jimeng":
        return requested
    if reference_mode == "multi_frame":
        return requested if requested in ("720p", "1080p") else "720p"
    if model_id == "seedance2.0_vip" and requested in ("720p", "1080p", "4k"):
        return requested
    return "720p"


def node_label(node: Mapping[str, Any]) -> str:
    title = node.get("title")
    if title is not None:
        return js_str(title)
    return "图片节点" if node.get("type") == "image" else js_str(node.get("type"))


# ---------------------------------------------------------------- DAG 拼装原语


def flow_node_key(round_index: int, order_index: int, copy: int = 0) -> str:
    suffix = "" if copy == 0 else f"_c{copy}"
    return f"r{round_index}_n{order_index}{suffix}"


def task_result_ref(flow_node_id: str, path: str | None = None) -> dict[str, Any]:
    return {"$node": flow_node_id} if path is None else {"$node": flow_node_id, "path": path}


def artifact_projection(
    flow_node_ids: Sequence[str],
    fallback: Sequence[Mapping[str, Any]],
    **options: Any,
) -> dict[str, Any]:
    return {
        "$artifacts": [task_result_ref(node_id) for node_id in flow_node_ids],
        "fallback": [dict(item) for item in fallback],
        **options,
    }


def _compiled_sources_into(
    doc: CanvasDoc, node_id: str, compiled: Mapping[str, list[str]]
) -> list[str]:
    out: list[str] = []
    for connection in doc.connections:
        if str(connection.get("to")) != node_id or _conn_kind(connection) != "input":
            continue
        for flow_node_id in compiled.get(str(connection.get("from")), []):
            if flow_node_id not in out:
                out.append(flow_node_id)
    return out


@dataclass
class RunCtx:
    """一次级联运行的轮次上下文。与前端 `RunCtx` 同形。"""

    canvas_id: int
    order: list[str]
    total: int
    vars: list[str]
    schedule: list[LoopRound]
    #: 《总数》替换成的数：末轮编号，不是轮数
    end_index: int
    loop_id: str | None
    retry_refs: dict[str, list[int]] = field(default_factory=dict)
    retry_media: dict[str, list[dict[str, Any]]] = field(default_factory=dict)


def _round_slot(ctx: RunCtx, round_index: int) -> LoopRound | None:
    position = round_index - 1
    return ctx.schedule[position] if 0 <= position < len(ctx.schedule) else None


def cascade_refs(doc: CanvasDoc, node_id: str, ctx: RunCtx, round_index: int) -> list[int]:
    """这一轮这个节点用的参考图。逐张喂图时按编排切片，切空了不静默回落。"""
    slot = _round_slot(ctx, round_index)
    if slot is not None and slot.slice is not None and ctx.loop_id is not None:
        start, count = slot.slice
        sliced = loop_upstream_images(doc, ctx.loop_id)[start - 1 : start - 1 + count]
        return sliced[:MAX_REFS] if sliced else []
    retry = ctx.retry_refs.get(node_id)
    if retry is not None:
        return retry[:MAX_REFS]
    return reference_asset_ids(doc, node_id)


def cascade_media_refs(doc: CanvasDoc, node_id: str, ctx: RunCtx) -> list[dict[str, Any]]:
    retry = ctx.retry_media.get(node_id)
    if retry is not None:
        return [dict(item) for item in retry]
    return reference_media_items(doc, node_id)


def round_prompt(doc: CanvasDoc, node_id: str, ctx: RunCtx, round_index: int) -> str:
    """这一轮这个节点的静态提示词：上游 + 自己的草稿 + 本轮轮次词，最后替换占位符。"""
    slot = _round_slot(ctx, round_index)
    index = slot.index if slot else round_index
    ordinal = slot.ordinal if slot else round_index - 1

    def contribute(loop_id: str) -> str:
        upstream = loop_prompt_items(doc, loop_id)
        segments: list[str] = []
        if upstream:
            segments.append(upstream[ordinal % len(upstream)])
        if ctx.vars:
            segments.append(ctx.vars[ordinal % len(ctx.vars)].strip())
        return "\n\n".join(segment for segment in segments if segment != "")

    return apply_round_vars(compose_prompt(doc, node_id, contribute), index, ctx.end_index)


@dataclass(frozen=True)
class CompiledPrompt:
    value: Any
    dependencies: list[str]


def compiled_prompt(
    doc: CanvasDoc,
    node: Mapping[str, Any],
    ctx: RunCtx,
    round_index: int,
    compiled: Mapping[str, list[str]],
) -> CompiledPrompt:
    """把提示词编成运行期表达式：上游 LLM 的产出留成 ``$node`` 引用而不是当场取值。"""
    by_id = doc.by_id()
    dependencies: list[str] = []
    parts: list[Any] = []

    def push_text(text: Any) -> None:
        value = _text(text)
        if value != "":
            parts.append(value)

    def take(candidate: Mapping[str, Any] | None) -> None:
        if candidate is None:
            return
        kind = candidate.get("type")
        if kind == "loop":
            slot = _round_slot(ctx, round_index)
            ordinal = slot.ordinal if slot else round_index - 1
            values = loop_prompt_items(doc, str(candidate["id"]))
            if values:
                push_text(values[ordinal % len(values)])
            if ctx.vars:
                push_text(ctx.vars[ordinal % len(ctx.vars)])
            return
        if kind == "prompt":
            push_text(candidate.get("text"))
            return
        if kind == "llm":
            produced = compiled.get(str(candidate["id"]), [])
            if produced:
                parts.append(task_result_ref(produced[0], "text"))
                dependencies.append(produced[0])
            else:
                push_text(candidate.get("llm_output"))
            return
        if kind != "group":
            return
        for member_id in _member_ids(candidate):
            take(by_id.get(member_id))

    node_id = str(node["id"])
    for connection in doc.connections:
        if str(connection.get("to")) != node_id or _conn_kind(connection) == "history":
            continue
        take(by_id.get(str(connection.get("from"))))
    push_text(node.get("prompt_draft"))

    value: Any = (parts[0] if parts else "") if len(parts) <= 1 else {
        "$concat": parts,
        "separator": "\n",
    }
    refs = _draft_refs(node)
    dropped = {
        f"图{MAX_REFS + index + 1}": f"@{reference.get('label', '')}"
        for index, reference in enumerate(refs[MAX_REFS:])
    }
    if dropped:
        if isinstance(value, str):
            for source, target in dropped.items():
                value = value.replace(source, target)
        else:
            value = {"$replace": value, "values": dropped}
    if refs and parts:
        table = "\n".join(
            f"图{index + 1}：{reference.get('label', '')}（asset {reference.get('asset_id')}）"
            for index, reference in enumerate(refs[:MAX_REFS])
        )
        if table != "":
            if isinstance(value, str):
                value = f"{table}\n\n用户需求：{value}"
            else:
                value = {
                    "$concat": [
                        table,
                        {"$concat": ["用户需求：", value], "separator": ""},
                    ],
                    "separator": "\n\n",
                }
    slot = _round_slot(ctx, round_index)
    index = slot.index if slot else round_index
    replacements = {
        "《计数》": str(index),
        "《总数》": str(ctx.end_index),
        "《进度》": f"{index}/{ctx.end_index}",
    }
    if isinstance(value, str):
        for source, target in replacements.items():
            value = value.replace(source, target)
    else:
        value = {"$replace": value, "values": replacements}
    return CompiledPrompt(value, list(dict.fromkeys(dependencies)))


# ---------------------------------------------------------------- 落点与查表


def find_slot(doc: CanvasDoc, source_id: str, round_index: int) -> dict[str, Any] | None:
    """这个源节点第 ``round_index`` 轮的输出槽。

    槽位靠持久化的 ``slot_of`` + ``slot_round`` 认领，跨会话复用同一批节点，
    与前端 ``findSlot`` 同判据。
    """
    for node in doc.nodes:
        if node.get("slot_of") == source_id and _int_or_none(node.get("slot_round")) == round_index:
            return node
    return None


@dataclass(frozen=True)
class TargetSlot:
    id: str
    #: 这个落点是这次运行现开的，产物要带 planned_node 让服务端补建
    branch: bool


def prepare_target(
    doc: CanvasDoc,
    node: Mapping[str, Any],
    round_index: int,
    output_type: str = "image",
    targets: Mapping[str, Mapping[str, str]] | None = None,
    pending: Collection[str] = (),
) -> TargetSlot:
    """这一轮这个节点的落点。

    服务端不动画布，所以只查不建：前端本地预演时已经把新槽位建好并随请求带上来
    （``targets`` 是「画布节点 → 轮次 → 落点」的映射，``pending`` 是这次新建、
    尚未落库的那几个）。没带映射时按 `第一轮落自身 → 已有槽位 → 落自身` 兜底，
    定时触发与服务端重跑走的就是这条。
    """
    node_id = str(node.get("id"))
    override = (targets or {}).get(node_id, {}).get(str(round_index))
    if isinstance(override, str) and override != "":
        return TargetSlot(override, override in pending)
    if node.get("type") == output_type and round_index == 1 and not _items(node):
        return TargetSlot(node_id, False)
    slot = find_slot(doc, node_id, round_index)
    if slot is not None:
        return TargetSlot(str(slot["id"]), str(slot["id"]) in pending)
    return TargetSlot(node_id, False)


@dataclass(frozen=True)
class CompileLookups:
    """编译要用的几张查表，全部由路由层先查好。"""

    #: workflow_id → 工作流详情（含 ui_schema/provider/title）
    workflow_details: Mapping[int, Mapping[str, Any]] = field(default_factory=dict)
    #: 已启用的工作流凭据，按 id 升序
    workflow_credentials: Sequence[Mapping[str, Any]] = field(default_factory=list)
    #: deployment_id → adapter_type
    deployment_adapters: Mapping[int, str] = field(default_factory=dict)


def pick_workflow_credential(
    credentials: Sequence[Mapping[str, Any]], provider: Any, preferred: Any
) -> int | None:
    """凭据只在服务端挑：先认节点上绑的那把，绑的那把停用/换供应商就顺位取。"""
    preferred_id = _int_or_none(preferred)
    for credential in credentials:
        if credential.get("id") == preferred_id and credential.get("provider_type") == provider:
            return _int_or_none(credential.get("id"))
    for credential in credentials:
        if credential.get("provider_type") == provider:
            return _int_or_none(credential.get("id"))
    return None


# ---------------------------------------------------------------- 工作流字段


@dataclass(frozen=True)
class WorkflowRunFields:
    fields: dict[str, Any]
    missing: list[str]
    context: dict[str, Any]


def _active_minimax_segment(
    node: Mapping[str, Any], mode: str | None
) -> dict[str, Any] | None:
    if mode != "minimax":
        return None
    timeline = node.get("workflow_timeline")
    timeline = timeline if isinstance(timeline, dict) else {}
    segments = [s for s in (timeline.get("segments") or []) if isinstance(s, dict)]
    return next(
        (s for s in segments if s.get("id") == timeline.get("selected_id")),
        segments[0] if segments else None,
    )


def workflow_run_fields(
    detail: Mapping[str, Any],
    node: Mapping[str, Any],
    static_media: Sequence[Mapping[str, Any]],
    source_flow_node_ids: Sequence[str],
    prompt: CompiledPrompt,
    static_prompt: str,
    rng: Callable[[], float] = random.random,
) -> WorkflowRunFields:
    """在静态绑定之上，把该由上游产物填的字段换成运行期投影。

    静态那一半与手动运行共用 `prepare_canvas_workflow_run`，这里只覆盖两类：
    媒体字段（上游出了图才知道填什么）与要绑提示词的字段（上游 LLM 还没写）。
    """
    prepared = prepare_canvas_workflow_run(detail, node, static_media, static_prompt, rng)
    fields = dict(prepared.fields)
    provider = detail.get("provider")
    schema_fields = [
        f
        for f in workflow_fields(detail)
        if provider == "comfyui" or f.get("enabled") is not False
    ]
    mode = workflow_timeline_mode(js_str(_nullish(detail.get("title"), node.get("title"))))
    active = _active_minimax_segment(node, mode)
    owns_references = (
        len([r for r in ((active or {}).get("references") or []) if isinstance(r, dict)]) > 0
        or (active or {}).get("asset_id") is not None
    )
    active_prompt = _text((active or {}).get("prompt"))
    values = node.get("workflow_values") or {}
    media_offsets = {"image": 0, "video": 0, "audio": 0}

    for index, field_spec in enumerate(schema_fields):
        field_id = workflow_field_id(field_spec, index)
        media_kind = workflow_field_media_kind(field_spec)
        explicit = values.get(field_id)
        if media_kind is not None:
            offset = media_offsets[media_kind]
            media_offsets[media_kind] += 1
            if explicit is not None and js_str(explicit).strip() != "":
                continue
            # 时间线自己写的这两个语义键不是真字段，别被媒体投影覆盖
            if mode == "minimax" and field_id in ("f_reference_image", "f_minimax_references"):
                continue
            if mode == "minimax" and provider == "runninghub" and owns_references:
                continue
            fields[field_id] = artifact_projection(
                source_flow_node_ids,
                static_media,
                kinds=[media_kind],
                field="ref",
                offset=offset,
                limit=1,
                scalar=True,
                default="",
                fallback_mode="empty-source",
            )
            continue
        binds_prompt = field_spec.get("bind_prompt") is True and (
            mode != "minimax" or active_prompt == ""
        )
        minimax_prompt = (
            mode == "minimax"
            and provider == "runninghub"
            and active_prompt == ""
            and minimax_runninghub_field_role(field_spec) == "prompt"
        )
        if explicit is None and (binds_prompt or minimax_prompt):
            fields[field_id] = prompt.value

    if mode == "minimax" and provider == "comfyui":
        if not owns_references:
            fields["f_reference_image"] = artifact_projection(
                source_flow_node_ids,
                static_media,
                kinds=["image"],
                field="ref",
                limit=1,
                scalar=True,
                default="",
                fallback_mode="empty-source",
            )
            fields["f_minimax_references"] = artifact_projection(
                source_flow_node_ids,
                static_media,
                kinds=["image", "video", "audio"],
                field="typed_ref",
                limits={"image": 9, "video": 3, "audio": 3},
                fallback_mode="empty-source",
            )
        if active_prompt == "":
            fields["f_prompt"] = prompt.value
    return WorkflowRunFields(fields, list(prepared.missing_media), dict(prepared.source_context))


# ---------------------------------------------------------------- 级联编译


def _task_context(
    doc: CanvasDoc,
    ctx: RunCtx,
    node: Mapping[str, Any],
    round_index: int,
    target: TargetSlot | None,
    extra: Mapping[str, Any] | None = None,
    group_id: str | None = None,
) -> dict[str, Any]:
    node_id = str(node["id"])
    out: dict[str, Any] = {
        "canvas_id": ctx.canvas_id,
        "node_id": target.id if target is not None else node_id,
    }
    if target is not None and target.id != node_id:
        out["source_node_id"] = node_id
    target_node = doc.by_id().get(target.id) if target is not None else None
    if target is not None and target.branch and target_node is not None:
        out["planned_node"] = deepcopy(target_node)
        out["pending_target"] = True
    out["execution_group_id"] = group_id if group_id is not None else uuid4().hex
    out["cascade_node_id"] = node_id
    out["cascade_round"] = round_index
    out["cascade_total"] = ctx.total
    out.update(extra or {})
    return out


def _video_roles(reference_mode: str) -> list[str]:
    if reference_mode == "first_last":
        return ["first_frame", "last_frame"]
    return ["first_frame"] if reference_mode == "first_frame" else []


def _video_reference_limit(adapter: str, reference_mode: str) -> int:
    if adapter == "openai":
        return 1
    if reference_mode == "first_last":
        return 2
    if reference_mode == "multimodal":
        return VIDEO_MULTIMODAL_MAX_REFS
    return VIDEO_MULTIFRAME_MAX_REFS


def _positive_id(value: Any) -> int | None:
    parsed = _int_or_none(value)
    return parsed if parsed is not None and parsed > 0 else None


def compile_cascade(
    doc: CanvasDoc,
    chain: Chain,
    ctx: RunCtx,
    mode: str,
    parallel_limit: Any = None,
    lookups: CompileLookups | None = None,
    rounds: Sequence[int] | None = None,
    targets: Mapping[str, Mapping[str, str]] | None = None,
    pending: Collection[str] = (),
    rng: Callable[[], float] = random.random,
    group_id: str | None = None,
) -> CompiledFlow:
    """把一条执行链按轮次静态展开成一次性 DAG。

    与前端 `compileCascadeRun` 逐段对应：同一份画布文档 + 同一份查表，两端产出
    等价定义。差别只有两处，都是环境决定的——落点不在这里新建（见
    `prepare_target`），凭据在这里按启用状态挑（客户端挑的可能已停用）。
    """
    tables = lookups if lookups is not None else CompileLookups()
    by_id = doc.by_id()
    definition: dict[str, Any] = {"nodes": [], "edges": []}
    edge_keys: set[tuple[str, str]] = set()

    def add_edge(source: str, target: str) -> None:
        if source == target or (source, target) in edge_keys:
            return
        edge_keys.add((source, target))
        definition["edges"].append({"from": source, "to": target})

    node_map: dict[str, dict[str, Any]] = {}
    round_nodes: dict[str, list[str]] = {}
    serial_tail: list[str] = []
    max_node_fanout = 1

    # 默认编全部轮次；失败重试只编失败那一轮，轮号保持原值，槽位与提示词编号才对得上
    round_list = list(rounds) if rounds is not None else list(range(1, ctx.total + 1))
    for round_index in round_list:
        compiled: dict[str, list[str]] = {}
        previous: list[str] = list(serial_tail) if mode == "serial" else []
        for order_index, node_id in enumerate(ctx.order):
            node = by_id.get(node_id)
            if not is_cascade_executable(node):
                continue
            assert node is not None
            prompt = compiled_prompt(doc, node, ctx, round_index, compiled)
            static_prompt = round_prompt(doc, node_id, ctx, round_index)
            direct_sources = _compiled_sources_into(doc, node_id, compiled)
            dependencies = list(
                dict.fromkeys([*previous, *direct_sources, *prompt.dependencies])
            )
            static_refs = cascade_refs(doc, node_id, ctx, round_index)
            static_media = cascade_media_refs(doc, node_id, ctx)
            image_fallback = [{"kind": "image", "asset_id": a} for a in static_refs]
            slot = _round_slot(ctx, round_index)
            # 逐张喂图那一轮的参考图由编排切片定死，不再跟着上游产物走
            sliced_round = (slot is None or slot.slice is not None) and ctx.loop_id is not None
            image_sources: list[str] = [] if sliced_round else direct_sources
            image_ids = artifact_projection(
                image_sources, image_fallback, kinds=["image"], field="asset_id", limit=MAX_REFS
            )
            created: list[str] = []

            def add_node(
                copy_index: int,
                operation: str,
                node_input: dict[str, Any],
                source_context: dict[str, Any],
                *,
                _node: Mapping[str, Any] = node,
                _order_index: int = order_index,
                _round: int = round_index,
                _created: list[str] = created,
                _dependencies: list[str] = dependencies,
            ) -> str:
                flow_id = flow_node_key(_round, _order_index, copy_index)
                definition["nodes"].append(
                    {
                        "id": flow_id,
                        "tool_id": "infinite-canvas",
                        "operation": operation,
                        "input": node_input,
                        "source_context": source_context,
                    }
                )
                for dependency in _dependencies:
                    add_edge(dependency, flow_id)
                _created.append(flow_id)
                node_map[flow_id] = {
                    "canvas_node_id": str(_node["id"]),
                    "target_node_id": js_str(
                        _nullish(source_context.get("node_id"), _node["id"])
                    ),
                    "round": _round,
                    "label": node_label(_node),
                }
                round_nodes.setdefault(str(_round), []).append(flow_id)
                return flow_id

            kind = node.get("type")
            settings = node.get("run_settings") or {}
            if kind == "llm":
                index = slot.index if slot is not None else round_index
                fallback = apply_round_vars(
                    js_str(_nullish(node.get("llm_input"), "")), index, ctx.end_index
                ).strip()
                add_node(
                    0,
                    "chat.general",
                    {
                        "prompt": {"$coalesce": [prompt.value, fallback]},
                        "system_prompt": (
                            js_str(_nullish(node.get("llm_system_prompt"), ""))
                            if node.get("llm_system_enabled") is True
                            else ""
                        ),
                        "messages": [],
                        "image_asset_ids": artifact_projection(
                            image_sources,
                            image_fallback,
                            kinds=["image"],
                            field="asset_id",
                            limit=4,
                        ),
                        "video_media_asset_ids": artifact_projection(
                            direct_sources,
                            static_media,
                            kinds=["video"],
                            field="media_asset_id",
                            limit=3,
                        ),
                        "deployment_id": _nullish(node.get("llm_deployment_id"), None),
                        "temperature": _nullish(node.get("llm_temperature"), 0.7),
                    },
                    _task_context(doc, ctx, node, round_index, None, group_id=group_id),
                )
            elif kind == "modelscope":
                deployment_id = _positive_id(node.get("ms_deployment_id"))
                if deployment_id is None:
                    raise CanvasCompileError(
                        f"「{node_label(node)}」没有可用的 ModelScope 部署"
                    )
                target = prepare_target(doc, node, round_index, "image", targets, pending)
                for copy_index in range(modelscope_count(node)):
                    add_node(
                        copy_index,
                        "image.generate",
                        {
                            "prompt": prompt.value,
                            "deployment_id": deployment_id,
                            "alias": "image-free",
                            "target_key": "free",
                            "style_key": "none",
                            "size": size_param(_nullish(node.get("ms_size"), "1024x1024")),
                            "tier": "1k",
                            "quality": normalize_quality(settings.get("quality")),
                            "n": 1,
                            "options": {
                                **modelscope_job_options(node, []),
                                "ref_asset_ids": artifact_projection(
                                    image_sources,
                                    image_fallback,
                                    kinds=["image"],
                                    field="asset_id",
                                    limit=MODELSCOPE_MAX_REFS,
                                ),
                            },
                        },
                        # 每张副本各自成组，与前端同口径
                        _task_context(doc, ctx, node, round_index, target, group_id=group_id),
                    )
            elif kind == "image":
                target = prepare_target(doc, node, round_index, "image", targets, pending)
                add_node(
                    0,
                    "image.auto",
                    {
                        "prompt": prompt.value,
                        "ref_asset_ids": image_ids,
                        "deployment_id": _nullish(settings.get("deployment_id"), None),
                        "alias": "image-free",
                        "target_key": "free",
                        "style_key": "none",
                        "app_key": "consistent_edit",
                        "size": size_param(settings.get("size")),
                        "tier": "1k",
                        "quality": normalize_quality(settings.get("quality")),
                        "n": 1,
                        "options": {},
                    },
                    _task_context(doc, ctx, node, round_index, target, group_id=group_id),
                )
            elif kind == "midjourney":
                deployment_id = _positive_id(node.get("mj_deployment_id"))
                if deployment_id is None:
                    raise CanvasCompileError(
                        f"「{node_label(node)}」没有可用的 Midjourney 部署"
                    )
                target = prepare_target(doc, node, round_index, "image", targets, pending)
                add_node(
                    0,
                    "midjourney.generate",
                    {
                        "deployment_id": deployment_id,
                        "mode": _nullish(node.get("mj_mode"), "imagine"),
                        "prompt": prompt.value,
                        "size": _nullish(node.get("mj_size"), "1:1"),
                        "version": _nullish(node.get("mj_version"), "8.2"),
                        "speed": _nullish(node.get("mj_speed"), "relax"),
                        "reference_asset_ids": artifact_projection(
                            image_sources,
                            image_fallback,
                            kinds=["image"],
                            field="asset_id",
                            limit=MIDJOURNEY_MAX_REFS,
                        ),
                        "options": {},
                    },
                    _task_context(doc, ctx, node, round_index, target, group_id=group_id),
                )
            elif kind == "video":
                video_settings = node.get("video_settings") or {}
                deployment_id = _positive_id(video_settings.get("deployment_id"))
                if deployment_id is None:
                    raise CanvasCompileError(f"「{node_label(node)}」没有可用的视频部署")
                adapter = resolve_video_adapter(video_settings, tables.deployment_adapters)
                reference_mode = js_str(
                    _nullish(video_settings.get("reference_mode"), "first_frame")
                )
                has_references = bool(
                    image_sources or static_refs or direct_sources or static_media
                )
                target = prepare_target(doc, node, round_index, "video", targets, pending)
                add_node(
                    0,
                    "video.generate",
                    {
                        "deployment_id": deployment_id,
                        "prompt": prompt.value,
                        "duration": _nullish(video_settings.get("duration"), 4),
                        "aspect_ratio": _nullish(video_settings.get("aspect_ratio"), "16:9"),
                        "resolution": normalized_video_resolution(
                            video_settings.get("resolution"),
                            adapter,
                            js_str(_nullish(video_settings.get("model_hint"), "")),
                            reference_mode,
                        ),
                        "references": artifact_projection(
                            image_sources,
                            image_fallback,
                            kinds=["image"],
                            field="video_reference",
                            roles=_video_roles(reference_mode),
                            limit=_video_reference_limit(adapter, reference_mode),
                        ),
                        "media_references": (
                            artifact_projection(
                                direct_sources,
                                static_media,
                                kinds=["video", "audio"],
                                field="video_media_reference",
                                limits={"video": 3, "audio": 3},
                                limit=6,
                            )
                            if adapter == "jimeng"
                            else []
                        ),
                        "options": video_request_options(
                            video_settings, adapter, has_references
                        ),
                    },
                    _task_context(doc, ctx, node, round_index, target, group_id=group_id),
                )
            elif kind == "workflow":
                workflow_id = _int_or_none(node.get("workflow_id"))
                if workflow_id is None:
                    raise CanvasCompileError(f"「{node_label(node)}」没有绑定工作流")
                detail = tables.workflow_details.get(workflow_id)
                if detail is None:
                    raise CanvasCompileError(f"工作流 {workflow_id} 不存在")
                credential_id = pick_workflow_credential(
                    tables.workflow_credentials,
                    detail.get("provider"),
                    node.get("workflow_credential_id"),
                )
                if credential_id is None:
                    raise CanvasCompileError(
                        f"没有可用的 {detail.get('provider')} 工作流凭据"
                    )
                prepared = workflow_run_fields(
                    detail, node, static_media, direct_sources, prompt, static_prompt, rng
                )
                if prepared.missing and not direct_sources:
                    joined = "、".join(prepared.missing)
                    raise CanvasCompileError(f"「{node_label(node)}」缺少必填媒体：{joined}")
                add_node(
                    0,
                    "workflow.run",
                    {
                        "workflow_id": workflow_id,
                        "credential_id": credential_id,
                        "fields": prepared.fields,
                        "use_wallet": node.get("workflow_use_wallet") is True,
                        "instance_type": js_str(
                            _nullish(node.get("workflow_instance_type"), "")
                        ),
                    },
                    _task_context(
                        doc, ctx, node, round_index, None, prepared.context, group_id
                    ),
                )
            if created:
                max_node_fanout = max(max_node_fanout, len(created))
                compiled[node_id] = created
                previous = list(created)
        if mode == "serial":
            serial_tail = list(previous)

    if not definition["nodes"]:
        raise CanvasCompileError("这条链没有可提交的工具节点")
    parallel_tasks = (
        max_node_fanout
        if mode == "serial"
        else min(512, cascade_pool_size(parallel_limit, ctx.total) * max_node_fanout)
    )
    return CompiledFlow(
        definition=narrow_numbers(definition),
        source_context={
            "kind": "canvas_cascade",
            "canvas_id": ctx.canvas_id,
            "start_id": ctx.order[-1] if ctx.order else "",
            "loop_id": ctx.loop_id,
            "mode": mode,
            "total": ctx.total,
            "max_parallel_tasks": parallel_tasks,
            "edge_keys": list(chain.edge_keys),
            "node_map": node_map,
            "round_nodes": round_nodes,
        },
    )


# ---------------------------------------------------------------- 成套编译


def compile_set_plan(
    doc: CanvasDoc,
    canvas_id: int,
    source_id: str,
    plan: Mapping[str, Any],
    slots: Sequence[str],
    group_id: str | None = None,
) -> CompiledFlow:
    """把成套方案冻结成一次性 DAG。

    方案里的 ``intent`` 只在这里起作用：
    - consistent：每步依赖前一步，且前一步的产物排在初始参考图之前；
    - varied：每步只看初始参考图，在服务端并发池里各跑各的。
    """
    by_id = doc.by_id()
    source = by_id.get(source_id)
    if source is None or source.get("type") != "image":
        raise CanvasCompileError("成套出图的源节点已不存在")
    raw_steps = plan.get("steps")
    steps = [
        step
        for step in (raw_steps if isinstance(raw_steps, list) else [])
        if isinstance(step, dict) and _text(step.get("prompt")) != ""
    ]
    if not steps or len(slots) != len(steps):
        raise CanvasCompileError("成套方案与输出槽不匹配")

    settings = source.get("run_settings") or {}
    base_fallback = [
        {"kind": "image", "asset_id": asset_id}
        for asset_id in reference_asset_ids(doc, source_id)
    ]
    consistent = plan.get("intent") != "varied"
    execution_group_id = group_id if group_id is not None else uuid4().hex
    definition: dict[str, Any] = {"nodes": [], "edges": []}
    node_map: dict[str, dict[str, Any]] = {}
    round_nodes: dict[str, list[str]] = {}
    previous_id: str | None = None

    for index, step in enumerate(steps):
        round_index = index + 1
        flow_id = f"set_{round_index}"
        target_id = str(slots[index])
        target = by_id.get(target_id)
        if target is None:
            raise CanvasCompileError(f"第 {round_index} 张的输出槽已不存在")
        artifact_sources = [previous_id] if consistent and previous_id is not None else []
        ordered_references = [
            *(task_result_ref(item) for item in artifact_sources),
            *(dict(item) for item in base_fallback),
        ]
        definition["nodes"].append(
            {
                "id": flow_id,
                "tool_id": "infinite-canvas",
                "operation": "image.auto",
                "input": {
                    "prompt": js_str(step.get("prompt")),
                    # fallback 的语义是「没有上一步产物时才启用」，表达不了旧交互要的
                    # 「上一步产物 + 初始参考」。两者必须进同一个有序 artifact 集合。
                    "ref_asset_ids": {
                        "$artifacts": ordered_references,
                        "kinds": ["image"],
                        "field": "asset_id",
                        "limit": MAX_REFS,
                    },
                    "deployment_id": _nullish(settings.get("deployment_id"), None),
                    "alias": "image-free",
                    "target_key": "free",
                    "style_key": "none",
                    "app_key": "consistent_edit",
                    "size": size_param(settings.get("size")),
                    "tier": "1k",
                    "quality": normalize_quality(settings.get("quality")),
                    "n": 1,
                    "options": {},
                },
                "source_context": {
                    "canvas_id": canvas_id,
                    "node_id": target_id,
                    "source_node_id": source_id,
                    "execution_group_id": execution_group_id,
                    "set_plan_step_id": step.get("id"),
                    "set_plan_round": round_index,
                    "set_plan_total": len(steps),
                    "planned_node": deepcopy(target),
                    "pending_target": True,
                },
            }
        )
        if consistent and previous_id is not None:
            definition["edges"].append({"from": previous_id, "to": flow_id})
        node_map[flow_id] = {
            "canvas_node_id": target_id,
            "target_node_id": target_id,
            "round": round_index,
            "label": js_str(step.get("title")) or f"第 {round_index} 张",
        }
        round_nodes[str(round_index)] = [flow_id]
        previous_id = flow_id

    return CompiledFlow(
        definition=narrow_numbers(definition),
        source_context={
            "kind": "canvas_set",
            "canvas_id": canvas_id,
            "start_id": source_id,
            "loop_id": None,
            "mode": "serial" if consistent else "parallel",
            "total": len(steps),
            "max_parallel_tasks": 1 if consistent else cascade_pool_size(None, len(steps)),
            "edge_keys": [conn_key(source_id, str(slot), "flow") for slot in slots],
            "node_map": node_map,
            "round_nodes": round_nodes,
            "set_plan": {
                "goal": js_str(plan.get("goal")),
                "intent": plan.get("intent"),
                "step_ids": [step.get("id") for step in steps],
            },
        },
    )

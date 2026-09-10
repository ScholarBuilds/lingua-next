"""创作工具 DAG：定义校验、输入映射、checkpoint 与节点调度。

节点语义分五种 ``kind``：``tool`` 调一次工具能力，``map`` 按列表展开成 N 个实例，
``subflow`` 起一条子运行，``input``/``output`` 定义运行的入参与产出。条件、重试、
超时、失败策略与人工输入挂起都挂在节点上，run 的终态因此多出 ``partial``，
非终态多出 ``waiting_input``。
"""

from __future__ import annotations

import copy
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import jsonschema
from croniter import croniter
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.models import (
    StudioFlow,
    StudioFlowInterrupt,
    StudioFlowRun,
    StudioFlowTrigger,
    StudioTask,
)
from domain.studio_tasks import (
    TERMINAL_STATUSES,
    StudioTaskError,
    request_cancel,
    transition,
)
from domain.tool_execution import (
    QueueLike,
    ToolExecutionError,
    enqueue_task,
    parse_tool_operation_input,
    require_operation,
    start_tool_operation,
)
from domain.tool_plugins import require_tool_operation

FLOW_ACTIVE_STATUSES = frozenset({"queued", "running", "recovering"})
FLOW_TERMINAL_STATUSES = frozenset({"succeeded", "partial", "failed", "cancelled"})
# 挂起等人不是终态，但也不需要轮询：恢复端点会重新入队 tick
FLOW_WAITING_STATUS = "waiting_input"
FLOW_CANCELLABLE_STATUSES = FLOW_ACTIVE_STATUSES | {FLOW_WAITING_STATUS}
NODE_SUCCESS_STATUSES = frozenset({"succeeded", "partial"})
NODE_ACTIVE_STATUSES = frozenset({"queued", "submitting", "running", "recovering"})
NODE_SKIPPED_STATUS = "skipped"
NODE_WAITING_STATUS = "waiting_input"
NODE_FAILURE_STATUSES = frozenset({"failed", "cancelled"})
NODE_SETTLED_STATUSES = (
    NODE_SUCCESS_STATUSES | NODE_FAILURE_STATUSES | {NODE_SKIPPED_STATUS}
)
NODE_KINDS = ("tool", "map", "subflow", "input", "output")
ON_FAILURE_POLICIES = ("fail_run", "skip_downstream", "continue")
TRIGGER_KINDS = ("cron", "task_terminal")
DEDUPLICATED_OPERATIONS = frozenset({"image.auto", "image.edit", "image.generate"})
# 一个 map 节点最多展开多少实例；再多就该拆 flow，而不是把一次 tick 撑爆
MAX_MAP_FANOUT = 500
RUN_ONLY_CONTEXT_KEYS = frozenset(
    {
        "edge_keys",
        "max_parallel_tasks",
        "node_map",
        "round_nodes",
    }
)
# 子工作流与 flow.resume 用来找回包装任务的 key，写在 run.source_context 里
TOOL_TASK_CONTEXT_KEY = "tool_task_id"
# 子运行结束后回灌父运行时用的 key
PARENT_NODE_CONTEXT_KEY = "parent_flow_node_id"
# 子工作流包装任务挂在这个工具身份下；它不进插件目录，只用于任务中心的展示与取消
FLOW_TOOL_ID = "flow-engine"


def flow_tick_job_id(run_id: str, *, marker: str | None = None) -> str:
    """一条运行的调度 tick 统一用这个 job id，重复触发在 arq 侧直接去重。

    ``marker`` 留给同一条运行的再次入口（人工恢复、子运行回灌）：arq 在
    ``keep_result`` 期内还留着上一次的结果键，不换后缀第二次入队会被静默丢弃。
    """
    base = f"studio-flow-tick:{run_id}"
    return base if marker is None else f"{base}:{marker}"


class StudioFlowError(ValueError):
    def __init__(self, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


class FlowRetrySpec(BaseModel):
    model_config = {"extra": "forbid"}

    max: int = Field(default=0, ge=0, le=10)
    backoff_ms: int = Field(default=0, ge=0, le=600_000)


class FlowNodeSpec(BaseModel):
    model_config = {"extra": "forbid", "populate_by_name": True}

    # map 模板节点的 id 由展开时生成，其余场景必填
    id: str | None = Field(default=None, min_length=1, max_length=96, pattern=r"^[A-Za-z0-9_.-]+$")
    kind: Literal["tool", "map", "subflow", "input", "output"] = "tool"
    tool_id: str | None = Field(default=None, min_length=1, max_length=64)
    operation: str | None = Field(default=None, min_length=1, max_length=64)
    input: dict[str, Any] = Field(default_factory=dict)
    source_context: dict[str, Any] = Field(default_factory=dict)
    # 条件表达式，求值为假时节点判 skipped，下游把它当作已满足
    when: Any = None
    on_failure: Literal["fail_run", "skip_downstream", "continue"] = "fail_run"
    retry: FlowRetrySpec | None = None
    timeout_s: int | None = Field(default=None, ge=1, le=86_400)
    # kind=map
    over: Any = None
    template: FlowNodeSpec | None = None
    # kind=subflow
    flow_id: int | None = Field(default=None, ge=1)
    inputs: dict[str, Any] | None = None
    # kind=input / kind=output
    name: str | None = Field(default=None, min_length=1, max_length=64)
    json_schema: dict[str, Any] | None = Field(default=None, alias="schema")
    value: Any = None


class FlowEdgeSpec(BaseModel):
    model_config = {"extra": "forbid", "populate_by_name": True}

    source: str = Field(alias="from", min_length=1, max_length=96)
    target: str = Field(alias="to", min_length=1, max_length=96)


class FlowDefinition(BaseModel):
    model_config = {"extra": "forbid"}

    # 主画布可把最多 999 轮冻结成一份运行快照。这里只设防止
    # 异常请求撑爆 JSON 校验的物理上限，不改变画布的产品级轮数语义。
    nodes: list[FlowNodeSpec] = Field(min_length=1, max_length=5000)
    edges: list[FlowEdgeSpec] = Field(default_factory=list, max_length=20000)


@dataclass(frozen=True)
class FlowAdvance:
    run: StudioFlowRun
    started_task_ids: tuple[str, ...]
    active_task_ids: tuple[str, ...]
    needs_poll: bool
    # 本轮新到 succeeded/partial 的节点；worker 据此只把增量产物投影到画布，不重扫整份 checkpoint
    completed_node_ids: tuple[str, ...] = ()


def _now() -> datetime:
    return datetime.now(UTC)


def _node_references(value: Any, *, allow_item: bool = False) -> set[str]:
    """走一遍表达式，顺带校验语法并收集它引用了哪些上游节点。

    ``allow_item`` 只在 map 模板里为真：``$item`` / ``$index`` 是展开期字面量，
    别的位置写了就是错的（运行期没有"当前元素"这个概念）。
    """
    refs: set[str] = set()
    if isinstance(value, list):
        for item in value:
            refs.update(_node_references(item, allow_item=allow_item))
        return refs
    if not isinstance(value, dict):
        return refs
    if "$item" in value or "$index" in value:
        if not allow_item:
            raise StudioFlowError("$item/$index 只能出现在 map 节点的 template 里")
        if "$item" in value and (set(value) != {"$item"} or not isinstance(value["$item"], str)):
            raise StudioFlowError("$item 引用只允许一个字符串路径")
        if "$index" in value and set(value) != {"$index"}:
            raise StudioFlowError("$index 引用不接受其它字段")
        return refs
    if "$node" in value:
        if not set(value).issubset({"$node", "path"}) or not isinstance(value.get("$node"), str):
            raise StudioFlowError("$node 引用只允许 $node/path 字段")
        if "path" in value and not isinstance(value["path"], str):
            raise StudioFlowError("$node.path 必须是字符串")
        refs.add(value["$node"])
        return refs
    if "$input" in value:
        if set(value) != {"$input"} or not isinstance(value["$input"], str):
            raise StudioFlowError("$input 引用只允许一个字符串路径")
        return refs
    if "$incoming" in value:
        if set(value) != {"$incoming"} or not isinstance(value["$incoming"], str):
            raise StudioFlowError("$incoming 引用只允许一个字符串路径")
        return refs
    if "$concat" in value:
        if not set(value).issubset({"$concat", "separator"}) or not isinstance(
            value.get("$concat"), list
        ):
            raise StudioFlowError("$concat 只允许 $concat/separator 字段")
        if "separator" in value and not isinstance(value["separator"], str):
            raise StudioFlowError("$concat.separator 必须是字符串")
        return _node_references(value["$concat"], allow_item=allow_item)
    if "$coalesce" in value:
        if set(value) != {"$coalesce"} or not isinstance(value.get("$coalesce"), list):
            raise StudioFlowError("$coalesce 只允许一个数组字段")
        return _node_references(value["$coalesce"], allow_item=allow_item)
    if "$replace" in value:
        if set(value) != {"$replace", "values"} or not isinstance(value.get("values"), dict):
            raise StudioFlowError("$replace 需要 $replace/values 字段")
        if not all(
            isinstance(key, str) and isinstance(item, str) for key, item in value["values"].items()
        ):
            raise StudioFlowError("$replace.values 必须是字符串映射")
        return _node_references(value["$replace"], allow_item=allow_item)
    if "$artifacts" in value:
        allowed = {
            "$artifacts",
            "fallback",
            "kinds",
            "field",
            "limit",
            "scalar",
            "default",
            "offset",
            "limits",
            "roles",
            "fallback_mode",
        }
        if not set(value).issubset(allowed) or not isinstance(value.get("$artifacts"), list):
            raise StudioFlowError("$artifacts 引用字段不合法")
        kinds = value.get("kinds")
        if kinds is not None and (
            not isinstance(kinds, list) or not all(isinstance(item, str) for item in kinds)
        ):
            raise StudioFlowError("$artifacts.kinds 必须是字符串数组")
        fields = {
            "item",
            "asset_id",
            "media_asset_id",
            "ref",
            "typed_ref",
            "video_reference",
            "video_media_reference",
        }
        if value.get("field", "item") not in fields:
            raise StudioFlowError("$artifacts.field 不支持")
        if "limit" in value and (
            not isinstance(value["limit"], int)
            or isinstance(value["limit"], bool)
            or value["limit"] < 1
        ):
            raise StudioFlowError("$artifacts.limit 必须是正整数")
        if "scalar" in value and not isinstance(value["scalar"], bool):
            raise StudioFlowError("$artifacts.scalar 必须是布尔值")
        if "offset" in value and (
            not isinstance(value["offset"], int)
            or isinstance(value["offset"], bool)
            or value["offset"] < 0
        ):
            raise StudioFlowError("$artifacts.offset 必须是非负整数")
        limits = value.get("limits")
        if limits is not None and (
            not isinstance(limits, dict)
            or not all(
                isinstance(kind, str)
                and isinstance(limit, int)
                and not isinstance(limit, bool)
                and limit >= 0
                for kind, limit in limits.items()
            )
        ):
            raise StudioFlowError("$artifacts.limits 必须是类型到非负整数的映射")
        roles = value.get("roles")
        if roles is not None and (
            not isinstance(roles, list)
            or not all(role in {"first_frame", "last_frame", "reference_image"} for role in roles)
        ):
            raise StudioFlowError("$artifacts.roles 包含不支持的视频参考角色")
        if value.get("fallback_mode", "empty-filter") not in {
            "empty-filter",
            "empty-source",
        }:
            raise StudioFlowError("$artifacts.fallback_mode 不支持")
        refs.update(_node_references(value["$artifacts"], allow_item=allow_item))
        refs.update(_node_references(value.get("fallback"), allow_item=allow_item))
        return refs
    for item in value.values():
        refs.update(_node_references(item, allow_item=allow_item))
    return refs


# 每种 kind 的必填字段与不该出现的字段；键名用模型属性名，报错时换成对外别名
_KIND_FIELDS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "tool": (
        ("tool_id", "operation"),
        ("over", "template", "flow_id", "inputs", "name", "json_schema", "value"),
    ),
    "map": (
        ("over", "template"),
        ("tool_id", "operation", "flow_id", "inputs", "name", "json_schema", "value", "input"),
    ),
    "subflow": (
        ("flow_id",),
        ("tool_id", "operation", "over", "template", "name", "json_schema", "value", "input"),
    ),
    "input": (
        ("name",),
        ("tool_id", "operation", "over", "template", "flow_id", "inputs", "input"),
    ),
    "output": (
        ("name", "value"),
        ("tool_id", "operation", "over", "template", "flow_id", "inputs", "json_schema", "input"),
    ),
}
_FIELD_ALIASES = {"json_schema": "schema"}


def _is_blank(value: Any) -> bool:
    return value is None or value == {} or value == []


def _validate_node_kind(node: FlowNodeSpec, *, label: str) -> None:
    required, forbidden = _KIND_FIELDS[node.kind]
    for field_name in required:
        if _is_blank(getattr(node, field_name)):
            alias = _FIELD_ALIASES.get(field_name, field_name)
            raise StudioFlowError(f"{label}：kind={node.kind} 缺少必填字段 {alias}")
    for field_name in forbidden:
        if not _is_blank(getattr(node, field_name)):
            alias = _FIELD_ALIASES.get(field_name, field_name)
            raise StudioFlowError(f"{label}：kind={node.kind} 不支持字段 {alias}")
    if node.kind == "tool":
        try:
            require_tool_operation(str(node.tool_id), str(node.operation))
        except ValueError as exc:
            raise StudioFlowError(f"{label}：{exc}") from exc
    if node.kind == "map":
        template = node.template
        assert template is not None  # 必填校验已经挡过
        if template.kind not in {"tool", "subflow"}:
            raise StudioFlowError(f"{label}：map 模板只能是 tool 或 subflow 节点")
        if template.id is not None and template.id == node.id:
            raise StudioFlowError(f"{label}：map 模板不能沿用 map 节点自己的 id")
        _validate_node_kind(template, label=f"{label} 的 map 模板")
    # subflow 指向的 flow_id 是否存在留到运行时查：定义可以先于目标工作流保存


def _node_expressions(node: FlowNodeSpec) -> list[tuple[Any, bool]]:
    """节点里所有要走解析器的表达式，第二项表示是否允许 ``$item``。"""
    expressions: list[tuple[Any, bool]] = [(node.when, False)]
    if node.kind == "tool":
        expressions.append((node.input, False))
    elif node.kind == "map":
        expressions.append((node.over, False))
        template = node.template
        if template is not None:
            expressions.append((template.when, True))
            expressions.append(
                (template.input, True) if template.kind == "tool" else (template.inputs, True)
            )
    elif node.kind == "subflow":
        expressions.append((node.inputs, False))
    elif node.kind == "output":
        expressions.append((node.value, False))
    # kind=input 的 value 是字面默认值，不参与表达式解析
    return expressions


def normalize_definition(raw: dict[str, Any]) -> dict[str, Any]:
    """校验节点语义、边、无环性和节点结果引用，返回稳定 JSON。"""
    try:
        definition = FlowDefinition.model_validate(raw)
    except ValidationError as exc:
        raise StudioFlowError(f"DAG 定义不合法：{exc.errors(include_context=False)}") from exc

    if any(node.id is None for node in definition.nodes):
        raise StudioFlowError("节点 id 必填，只有 map 模板可以留空")
    ids = [str(node.id) for node in definition.nodes]
    if len(set(ids)) != len(ids):
        raise StudioFlowError("节点 id 不能重复")
    node_ids = set(ids)
    declared_names: dict[str, set[str]] = {"input": set(), "output": set()}
    for node in definition.nodes:
        _validate_node_kind(node, label=f"节点 {node.id}")
        if node.kind in declared_names:
            name = str(node.name)
            if name in declared_names[node.kind]:
                raise StudioFlowError(f"{node.kind} 节点的 name 重复：{name}")
            declared_names[node.kind].add(name)

    pairs: set[tuple[str, str]] = set()
    incoming: dict[str, set[str]] = {node_id: set() for node_id in ids}
    outgoing: dict[str, set[str]] = {node_id: set() for node_id in ids}
    for edge in definition.edges:
        if edge.source not in node_ids or edge.target not in node_ids:
            raise StudioFlowError(f"连线指向不存在的节点：{edge.source} -> {edge.target}")
        if edge.source == edge.target:
            raise StudioFlowError(f"节点不能连向自己：{edge.source}")
        pair = (edge.source, edge.target)
        if pair in pairs:
            raise StudioFlowError(f"连线重复：{edge.source} -> {edge.target}")
        pairs.add(pair)
        incoming[edge.target].add(edge.source)
        outgoing[edge.source].add(edge.target)

    ready = [node_id for node_id in ids if not incoming[node_id]]
    visited: list[str] = []
    remaining = {node_id: set(values) for node_id, values in incoming.items()}
    while ready:
        current = ready.pop(0)
        visited.append(current)
        for target in ids:
            if current not in remaining[target]:
                continue
            remaining[target].remove(current)
            if not remaining[target] and target not in visited and target not in ready:
                ready.append(target)
    if len(visited) != len(ids):
        cyclic = [node_id for node_id in ids if node_id not in visited]
        raise StudioFlowError(f"DAG 存在环：{', '.join(cyclic)}")

    for node in definition.nodes:
        node_id = str(node.id)
        references: set[str] = set()
        uses_incoming = False
        for expression, allow_item in _node_expressions(node):
            references.update(_node_references(expression, allow_item=allow_item))
            uses_incoming = uses_incoming or _uses_incoming(expression)
        for source in references:
            if source not in node_ids:
                raise StudioFlowError(f"节点 {node_id} 引用不存在的节点：{source}")
            if source not in incoming[node_id]:
                raise StudioFlowError(f"节点 {node_id} 引用 {source} 的结果时必须建立直接连线")
        if uses_incoming and not incoming[node_id]:
            raise StudioFlowError(f"节点 {node_id} 使用 $incoming 时至少要有一条入边")

    return definition.model_dump(by_alias=True, mode="json")


def _checkpoint(definition: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": 1,
        "nodes": {
            str(node["id"]): {
                "status": "pending",
                "task_id": None,
                "attempt": 0,
                "result": None,
                "error": None,
            }
            for node in definition["nodes"]
        },
    }


def flow_view(row: StudioFlow, *, detail: bool = False) -> dict[str, Any]:
    definition = row.definition or {"nodes": [], "edges": []}
    result: dict[str, Any] = {
        "id": row.id,
        "title": row.title,
        "description": row.description,
        "version": row.version,
        "enabled": row.enabled,
        "node_count": len(definition.get("nodes") or []),
        "edge_count": len(definition.get("edges") or []),
        "input_schema": row.input_schema,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
    if detail:
        result["definition"] = definition
    return result


def flow_run_view(row: StudioFlowRun) -> dict[str, Any]:
    checkpoint = row.checkpoint or {"nodes": {}}
    nodes = checkpoint.get("nodes") or {}
    completed = sum(
        1
        for value in nodes.values()
        if isinstance(value, dict) and value.get("status") in NODE_SUCCESS_STATUSES
    )
    return {
        "id": row.id,
        "flow_id": row.flow_id,
        "parent_run_id": row.parent_run_id,
        "flow_version": row.flow_version,
        "status": row.status,
        "error": row.error,
        "inputs": row.inputs,
        "outputs": row.outputs,
        "waiting_node_id": row.waiting_node_id,
        "source_context": row.source_context,
        "checkpoint": checkpoint,
        "progress": (completed / len(nodes) * 100) if nodes else 0.0,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "started_at": row.started_at.isoformat() if row.started_at else None,
        "heartbeat_at": row.heartbeat_at.isoformat() if row.heartbeat_at else None,
        "finished_at": row.finished_at.isoformat() if row.finished_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


async def create_flow(
    session: AsyncSession,
    *,
    title: str,
    description: str | None,
    definition: dict[str, Any],
) -> StudioFlow:
    normalized_title = title.strip()
    if not normalized_title:
        raise StudioFlowError("标题不能为空")
    row = StudioFlow(
        title=normalized_title,
        description=description.strip() if description else None,
        definition=normalize_definition(definition),
        version=1,
        enabled=True,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def update_flow(
    session: AsyncSession,
    row: StudioFlow,
    *,
    base_version: int,
    title: str,
    description: str | None,
    definition: dict[str, Any],
    enabled: bool,
) -> StudioFlow:
    if row.version != base_version:
        raise StudioFlowError("工作流已被其他页面修改，请刷新后重试", status=409)
    normalized_title = title.strip()
    if not normalized_title:
        raise StudioFlowError("标题不能为空")
    row.title = normalized_title
    row.description = description.strip() if description else None
    row.definition = normalize_definition(definition)
    row.enabled = enabled
    row.version += 1
    await session.commit()
    await session.refresh(row)
    return row


_JSON_TYPES: tuple[tuple[type, str], ...] = (
    (bool, "boolean"),
    (int, "integer"),
    (float, "number"),
    (str, "string"),
    (list, "array"),
    (dict, "object"),
)


def _json_type_of(value: Any) -> str:
    for python_type, json_type in _JSON_TYPES:
        if isinstance(value, python_type):
            return json_type
    return "string"


def derive_input_schema(
    definition: dict[str, Any],
    *,
    sample_inputs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """由 input 节点派生运行入参 schema；没有 input 节点时按一次真实入参兜底。

    画布级联冻结出来的运行没有 input 节点，但它的 inputs 就是这条流程要什么的
    最好证据——固化成模板时按它生成一份宽松 schema，比留空更有用。
    """
    properties: dict[str, Any] = {}
    required: list[str] = []
    for node in definition.get("nodes") or []:
        if str(node.get("kind") or "tool") != "input":
            continue
        name = str(node.get("name") or node.get("id"))
        schema = copy.deepcopy(node.get("schema")) or {}
        if node.get("value") is not None:
            schema.setdefault("default", copy.deepcopy(node["value"]))
        else:
            required.append(name)
        properties[name] = schema
    if not properties:
        for key, value in (sample_inputs or {}).items():
            properties[str(key)] = {"type": _json_type_of(value)}
    if not properties:
        return {}
    return {
        "type": "object",
        "properties": properties,
        "required": sorted(set(required)),
        "additionalProperties": True,
    }


def validate_flow_inputs(schema: dict[str, Any] | None, inputs: dict[str, Any]) -> None:
    """按 input_schema 校验运行入参；schema 为空表示不校验。"""
    if not isinstance(schema, dict) or not schema:
        return
    try:
        jsonschema.validate(inputs, schema)
    except jsonschema.ValidationError as exc:
        raise StudioFlowError(f"运行入参不符合 input_schema：{exc.message}", status=422) from exc
    except jsonschema.SchemaError as exc:
        raise StudioFlowError(f"input_schema 本身不合法：{exc.message}") from exc


def flow_schema_view(row: StudioFlow) -> dict[str, Any]:
    """给编辑器与外部调用方看的入参/产出合同。"""
    definition = row.definition or {"nodes": [], "edges": []}
    schema = row.input_schema or derive_input_schema(definition)
    inputs = [
        {
            "name": str(node.get("name") or node.get("id")),
            "schema": node.get("schema") or {},
            "default": node.get("value"),
            "required": node.get("value") is None,
        }
        for node in definition.get("nodes") or []
        if str(node.get("kind") or "tool") == "input"
    ]
    outputs = [
        str(node.get("name") or node.get("id"))
        for node in definition.get("nodes") or []
        if str(node.get("kind") or "tool") == "output"
    ]
    return {
        "flow_id": row.id,
        "version": row.version,
        "input_schema": schema,
        "inputs": inputs,
        "outputs": outputs,
    }


async def promote_run_to_flow(
    session: AsyncSession,
    run: StudioFlowRun,
    *,
    title: str | None = None,
    description: str | None = None,
) -> StudioFlow:
    """把一次跑通的运行快照固化成可复用的工作流模板。"""
    definition = normalize_definition(copy.deepcopy(run.definition_snapshot))
    normalized_title = (title or "").strip() or f"运行 {run.id[:8]} 固化的模板"
    schema = derive_input_schema(definition, sample_inputs=run.inputs or {})
    row = StudioFlow(
        title=normalized_title[:160],
        description=(description or "").strip() or None,
        definition=definition,
        input_schema=schema or None,
        version=1,
        enabled=True,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def list_flow_runs_updated_since(
    session: AsyncSession,
    *,
    since: datetime,
    limit: int = 200,
) -> list[StudioFlowRun]:
    """自 ``since`` 起有过写入的运行，按 updated_at 升序；供 SSE 推整快照用。"""
    stmt = (
        select(StudioFlowRun)
        .where(StudioFlowRun.updated_at >= since)
        .order_by(StudioFlowRun.updated_at, StudioFlowRun.id)
        .limit(max(1, min(limit, 500)))
    )
    return list((await session.execute(stmt)).scalars())


def new_flow_run(
    flow: StudioFlow,
    *,
    inputs: dict[str, Any],
    source_context: dict[str, Any] | None = None,
    parent_run_id: str | None = None,
    mission_id: str | None = None,
) -> StudioFlowRun:
    definition = normalize_definition(copy.deepcopy(flow.definition))
    return StudioFlowRun(
        id=uuid.uuid4().hex,
        flow_id=flow.id,
        parent_run_id=parent_run_id,
        mission_id=mission_id,
        flow_version=flow.version,
        definition_snapshot=definition,
        inputs=copy.deepcopy(inputs),
        source_context=copy.deepcopy(source_context) if source_context else None,
        checkpoint=_checkpoint(definition),
        status="queued",
    )


def new_inline_flow_run(
    definition: dict[str, Any],
    *,
    inputs: dict[str, Any],
    source_context: dict[str, Any] | None = None,
    parent_run_id: str | None = None,
    mission_id: str | None = None,
) -> StudioFlowRun:
    """创建不依赖可编辑 ``StudioFlow`` 的一次性 DAG 快照。

    主画布级联与稍后的工具组合都可以把当次运行语义冻结在这里；
    它们不需要先制造一条用户可见的永久工作流定义。
    """
    normalized = normalize_definition(copy.deepcopy(definition))
    return StudioFlowRun(
        id=uuid.uuid4().hex,
        flow_id=None,
        parent_run_id=parent_run_id,
        mission_id=mission_id,
        flow_version=1,
        definition_snapshot=normalized,
        inputs=copy.deepcopy(inputs),
        source_context=copy.deepcopy(source_context) if source_context else None,
        checkpoint=_checkpoint(normalized),
        status="queued",
    )


def retry_flow_run(row: StudioFlowRun) -> StudioFlowRun:
    definition = normalize_definition(copy.deepcopy(row.definition_snapshot))
    return StudioFlowRun(
        id=uuid.uuid4().hex,
        flow_id=row.flow_id,
        parent_run_id=row.id,
        mission_id=row.mission_id,
        flow_version=row.flow_version,
        definition_snapshot=definition,
        inputs=copy.deepcopy(row.inputs or {}),
        source_context=copy.deepcopy(row.source_context) if row.source_context else None,
        checkpoint=_checkpoint(definition),
        status="queued",
    )


def resume_flow_run(row: StudioFlowRun) -> StudioFlowRun:
    """从原 checkpoint 继续未完成部分，不重跑已成功节点。

    已在跑的旁路任务保留 task_id，新运行会重新收割它们的真实终态；
    失败或已取消节点回到 pending，其下游与尚未调度轮次自然继续。
    """
    definition = normalize_definition(copy.deepcopy(row.definition_snapshot))
    checkpoint = copy.deepcopy(row.checkpoint or _checkpoint(definition))
    states = checkpoint.get("nodes")
    if not isinstance(states, dict):
        checkpoint = _checkpoint(definition)
        states = checkpoint["nodes"]
    for node in definition["nodes"]:
        node_id = str(node["id"])
        state = states.get(node_id)
        if not isinstance(state, dict):
            states[node_id] = _checkpoint({"nodes": [node], "edges": []})["nodes"][node_id]
            continue
        # 被 skip_downstream 连坐的节点也要回 pending（它们带失败原因），
        # 而 when 判假跳过的节点没有原因，重跑时仍然该跳过
        connected_skip = state.get("status") == NODE_SKIPPED_STATUS and state.get("error")
        if state.get("status") in {"failed", "cancelled"} or connected_skip:
            state.update({"status": "pending", "task_id": None, "result": None, "error": None})
            for key in ("request_key", "settled", "retry_after", "last_error"):
                state.pop(key, None)
    checkpoint["version"] = 1
    return StudioFlowRun(
        id=uuid.uuid4().hex,
        flow_id=row.flow_id,
        parent_run_id=row.id,
        mission_id=row.mission_id,
        flow_version=row.flow_version,
        definition_snapshot=definition,
        inputs=copy.deepcopy(row.inputs or {}),
        source_context=copy.deepcopy(row.source_context) if row.source_context else None,
        checkpoint=checkpoint,
        status="queued",
    )


def _node_spec_of(run: StudioFlowRun, node_id: str) -> dict[str, Any] | None:
    for node in (run.definition_snapshot or {}).get("nodes") or []:
        if str(node.get("id")) == node_id:
            return node
    return None


async def resume_flow_input(
    session: AsyncSession,
    run: StudioFlowRun,
    *,
    node_id: str,
    resume_value: Any,
) -> StudioFlowRun:
    """把人工输入填回挂起节点，并让这条运行回到可调度状态。

    与旧管线的 interrupt 一样：worker 绝不挂起等人，恢复只负责改状态 + 入队新 tick。
    """
    checkpoint = copy.deepcopy(run.checkpoint or {})
    states = checkpoint.get("nodes")
    if not isinstance(states, dict) or node_id not in states:
        raise StudioFlowError(f"运行里没有这个节点：{node_id}", status=404)
    state = states[node_id]
    if not isinstance(state, dict) or state.get("status") != NODE_WAITING_STATUS:
        raise StudioFlowError(f"节点 {node_id} 没有在等待人工输入", status=409)
    node = _node_spec_of(run, node_id) or {}
    name = str(node.get("name") or node_id)
    schema = node.get("schema")
    if isinstance(schema, dict) and schema:
        try:
            jsonschema.validate(resume_value, schema)
        except jsonschema.ValidationError as exc:
            raise StudioFlowError(
                f"人工输入不符合节点 {node_id} 的 schema：{exc.message}", status=422
            ) from exc
    inputs = copy.deepcopy(run.inputs or {})
    inputs[name] = copy.deepcopy(resume_value)
    state.update(
        {
            "status": "succeeded",
            "result": {"name": name, "value": copy.deepcopy(resume_value)},
            "error": None,
        }
    )
    run.inputs = inputs
    run.checkpoint = checkpoint
    run.waiting_node_id = None
    run.finished_at = None
    run.error = None
    run.status = "queued"
    pending = list(
        (
            await session.execute(
                select(StudioFlowInterrupt).where(
                    StudioFlowInterrupt.run_id == run.id,
                    StudioFlowInterrupt.node_id == node_id,
                    StudioFlowInterrupt.status == "waiting",
                )
            )
        ).scalars()
    )
    resolved_at = _now()
    for row in pending:
        row.status = "resolved"
        row.resume_value = {"value": copy.deepcopy(resume_value)}
        row.resolved_at = resolved_at
    await session.commit()
    return run


async def list_flow_interrupts(
    session: AsyncSession,
    run_id: str,
    *,
    status: str | None = "waiting",
) -> list[StudioFlowInterrupt]:
    stmt = select(StudioFlowInterrupt).where(StudioFlowInterrupt.run_id == run_id)
    if status is not None:
        stmt = stmt.where(StudioFlowInterrupt.status == status)
    return list((await session.execute(stmt.order_by(StudioFlowInterrupt.id))).scalars())


def interrupt_view(row: StudioFlowInterrupt) -> dict[str, Any]:
    return {
        "id": row.id,
        "run_id": row.run_id,
        "node_id": row.node_id,
        "kind": row.kind,
        "payload": row.payload,
        "status": row.status,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "resolved_at": row.resolved_at.isoformat() if row.resolved_at else None,
    }


# ---- 触发器 -----------------------------------------------------------------


def trigger_view(row: StudioFlowTrigger) -> dict[str, Any]:
    return {
        "id": row.id,
        "flow_id": row.flow_id,
        "kind": row.kind,
        "cron": row.cron,
        "task_type": row.task_type,
        "statuses": row.statuses,
        "inputs": row.inputs,
        "enabled": row.enabled,
        "last_fired_at": row.last_fired_at.isoformat() if row.last_fired_at else None,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


async def create_trigger(
    session: AsyncSession,
    *,
    flow_id: int,
    kind: str,
    cron: str | None = None,
    task_type: str | None = None,
    statuses: list[str] | None = None,
    inputs: dict[str, Any] | None = None,
    enabled: bool = True,
) -> StudioFlowTrigger:
    normalized_kind = (kind or "").strip().lower()
    if normalized_kind not in TRIGGER_KINDS:
        raise StudioFlowError(f"未知触发器类型：{kind}")
    flow = await session.get(StudioFlow, flow_id)
    if flow is None:
        raise StudioFlowError("DAG 定义不存在", status=404)
    expression = (cron or "").strip() or None
    wanted_type = (task_type or "").strip() or None
    wanted_statuses = [str(item) for item in statuses or []]
    if normalized_kind == "cron":
        if not expression or not croniter.is_valid(expression):
            raise StudioFlowError(f"cron 表达式不合法：{cron}")
        wanted_type = None
        wanted_statuses = []
    else:
        if not wanted_type:
            raise StudioFlowError("task_terminal 触发器必须指定 task_type")
        unknown = [item for item in wanted_statuses if item not in TERMINAL_STATUSES]
        if unknown:
            raise StudioFlowError(f"触发状态必须是任务终态：{unknown}")
        expression = None
    row = StudioFlowTrigger(
        flow_id=flow.id,
        kind=normalized_kind,
        cron=expression,
        task_type=wanted_type,
        statuses=wanted_statuses or None,
        inputs=copy.deepcopy(inputs) if inputs else None,
        enabled=enabled,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def list_triggers(session: AsyncSession, flow_id: int) -> list[StudioFlowTrigger]:
    stmt = (
        select(StudioFlowTrigger)
        .where(StudioFlowTrigger.flow_id == flow_id)
        .order_by(StudioFlowTrigger.id)
    )
    return list((await session.execute(stmt)).scalars())


async def delete_trigger(session: AsyncSession, *, flow_id: int, trigger_id: int) -> None:
    row = await session.get(StudioFlowTrigger, trigger_id)
    if row is None or row.flow_id != flow_id:
        raise StudioFlowError("触发器不存在", status=404)
    await session.delete(row)
    await session.commit()


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


async def due_cron_triggers(
    session: AsyncSession,
    *,
    now: datetime | None = None,
) -> list[StudioFlowTrigger]:
    """到点的 cron 触发器：上次触发（没有就按创建时间）之后的下一个点已经过了。"""
    moment = now or _now()
    rows = list(
        (
            await session.execute(
                select(StudioFlowTrigger).where(
                    StudioFlowTrigger.kind == "cron",
                    StudioFlowTrigger.enabled.is_(True),
                )
            )
        ).scalars()
    )
    due: list[StudioFlowTrigger] = []
    for row in rows:
        base = _as_utc(row.last_fired_at) or _as_utc(row.created_at) or moment
        try:
            following = croniter(str(row.cron or ""), base).get_next(datetime)
        except (ValueError, KeyError):
            continue
        if (_as_utc(following) or moment) <= moment:
            due.append(row)
    return due


async def fire_trigger(
    session: AsyncSession,
    queue: QueueLike,
    trigger: StudioFlowTrigger,
    *,
    extra_inputs: dict[str, Any] | None = None,
    now: datetime | None = None,
) -> StudioFlowRun:
    """按触发器建一条运行并入队；触发器自带的 inputs 压过调用方补的上下文。"""
    flow = await session.get(StudioFlow, trigger.flow_id)
    if flow is None or not flow.enabled:
        raise StudioFlowError("触发器指向的 DAG 不可用", status=409)
    inputs = {**(extra_inputs or {}), **(trigger.inputs or {})}
    validate_flow_inputs(flow.input_schema, inputs)
    run = new_flow_run(
        flow,
        inputs=inputs,
        source_context={
            "kind": "trigger",
            "trigger_id": trigger.id,
            "trigger_kind": trigger.kind,
        },
    )
    session.add(run)
    trigger.last_fired_at = now or _now()
    await session.commit()
    await queue.enqueue_job("run_studio_flow", run.id, _job_id=flow_tick_job_id(run.id))
    return run


async def fire_task_terminal_triggers(
    session: AsyncSession,
    queue: QueueLike,
    task: StudioTask,
) -> list[str]:
    """任务落终态时匹配 task_terminal 触发器，返回新建的运行 id。"""
    if task.status not in TERMINAL_STATUSES:
        return []
    rows = list(
        (
            await session.execute(
                select(StudioFlowTrigger).where(
                    StudioFlowTrigger.kind == "task_terminal",
                    StudioFlowTrigger.enabled.is_(True),
                    StudioFlowTrigger.task_type == task.task_type,
                )
            )
        ).scalars()
    )
    fired: list[str] = []
    for row in rows:
        wanted = [str(item) for item in row.statuses or []]
        if wanted and task.status not in wanted:
            continue
        run = await fire_trigger(
            session,
            queue,
            row,
            extra_inputs={"task_id": task.id, "task_result": copy.deepcopy(task.result)},
        )
        fired.append(run.id)
    return fired


def _deduplication_key(tool_id: str, operation: str, body: BaseModel) -> str | None:
    """稳定标识可安全复用的模型请求，不把画布落点混进签名。"""
    if operation not in DEDUPLICATED_OPERATIONS:
        return None
    return json.dumps(
        {
            "tool_id": tool_id,
            "operation": operation,
            "body": body.model_dump(mode="json"),
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _read_path(value: Any, path: str, *, label: str) -> Any:
    current = value
    if path == "":
        return copy.deepcopy(current)
    for segment in path.split("."):
        if isinstance(current, dict) and segment in current:
            current = current[segment]
            continue
        if isinstance(current, list) and segment.isdigit():
            index = int(segment)
            if 0 <= index < len(current):
                current = current[index]
                continue
        raise StudioFlowError(f"{label} 路径不存在：{path}")
    return copy.deepcopy(current)


def _uses_incoming(value: Any) -> bool:
    if isinstance(value, list):
        return any(_uses_incoming(item) for item in value)
    if not isinstance(value, dict):
        return False
    if "$incoming" in value:
        return True
    return any(_uses_incoming(item) for item in value.values())


def _artifact_items(value: Any) -> list[dict[str, Any]]:
    """把各工具已有的结果形状折叠成统一媒体条目。

    这是 DAG 边界的读视图，不会回写 ``StudioTask.result``，因此旧任务、
    旧 API 和审计快照的序列化格式保持不变。
    """
    if isinstance(value, list):
        out: list[dict[str, Any]] = []
        for item in value:
            out.extend(_artifact_items(item))
        return out
    if not isinstance(value, dict):
        return []
    raw_items = value.get("items")
    if isinstance(raw_items, list):
        out = []
        for raw in raw_items:
            if isinstance(raw, dict):
                out.append(copy.deepcopy(raw))
        return out
    out = []
    for raw_id in value.get("asset_ids") or []:
        try:
            asset_id = int(raw_id)
        except (TypeError, ValueError):
            continue
        if asset_id > 0:
            out.append({"kind": "image", "asset_id": asset_id})
    for raw_id in value.get("media_asset_ids") or []:
        try:
            media_id = int(raw_id)
        except (TypeError, ValueError):
            continue
        if media_id > 0:
            out.append({"kind": str(value.get("kind") or "file"), "media_asset_id": media_id})
    if not out and value.get("asset_id") is not None:
        try:
            asset_id = int(value["asset_id"])
        except (TypeError, ValueError):
            asset_id = 0
        if asset_id > 0:
            out.append({"kind": "image", "asset_id": asset_id})
    if not out and value.get("media_asset_id") is not None:
        try:
            media_id = int(value["media_asset_id"])
        except (TypeError, ValueError):
            media_id = 0
        if media_id > 0:
            out.append({"kind": str(value.get("kind") or "file"), "media_asset_id": media_id})
    return out


def _artifact_key(item: dict[str, Any]) -> tuple[str, str]:
    kind = str(item.get("kind") or "")
    for field in ("asset_id", "media_asset_id", "url"):
        value = item.get(field)
        if value not in (None, ""):
            return kind, f"{field}:{value}"
    return kind, repr(sorted(item.items()))


def _artifact_value(item: dict[str, Any], field: str) -> Any:
    kind = str(item.get("kind") or "")
    if field == "item":
        return copy.deepcopy(item)
    if field == "asset_id":
        return item.get("asset_id") if kind == "image" else None
    if field == "media_asset_id":
        return item.get("media_asset_id") if kind != "image" else None
    if field == "ref":
        if kind == "image" and item.get("asset_id") is not None:
            return f"asset:{int(item['asset_id'])}"
        if kind != "image" and item.get("media_asset_id") is not None:
            return f"media:{int(item['media_asset_id'])}"
        return None
    if field == "typed_ref":
        ref = _artifact_value(item, "ref")
        return None if ref is None else {"kind": kind, "ref": ref}
    if field == "video_reference":
        asset_id = item.get("asset_id") if kind == "image" else None
        return None if asset_id is None else {"asset_id": int(asset_id)}
    if field == "video_media_reference":
        media_id = item.get("media_asset_id") if kind in {"video", "audio"} else None
        return None if media_id is None else {"media_asset_id": int(media_id), "kind": kind}
    raise StudioFlowError(f"未知媒体投影字段：{field}")


def resolve_node_input(
    value: Any,
    *,
    inputs: dict[str, Any],
    checkpoint_nodes: dict[str, Any],
    incoming_node_ids: list[str] | tuple[str, ...] = (),
) -> Any:
    if isinstance(value, list):
        return [
            resolve_node_input(
                item,
                inputs=inputs,
                checkpoint_nodes=checkpoint_nodes,
                incoming_node_ids=incoming_node_ids,
            )
            for item in value
        ]
    if not isinstance(value, dict):
        return copy.deepcopy(value)
    if set(value) == {"$input"}:
        path = str(value["$input"])
        return _read_path(inputs, path, label="运行输入")
    if set(value) == {"$incoming"}:
        path = str(value["$incoming"])
        aggregated: list[Any] = []
        for node_id in incoming_node_ids:
            state = checkpoint_nodes.get(node_id)
            if not isinstance(state, dict) or state.get("status") not in NODE_SUCCESS_STATUSES:
                raise StudioFlowError(f"上游节点尚未成功：{node_id}")
            resolved = _read_path(
                state.get("result"),
                path,
                label=f"节点 {node_id} 结果",
            )
            if isinstance(resolved, list):
                aggregated.extend(resolved)
            else:
                aggregated.append(resolved)
        return aggregated
    if "$concat" in value and set(value).issubset({"$concat", "separator"}):
        resolved = resolve_node_input(
            value["$concat"],
            inputs=inputs,
            checkpoint_nodes=checkpoint_nodes,
            incoming_node_ids=incoming_node_ids,
        )
        parts: list[str] = []
        for item in resolved:
            values = item if isinstance(item, list) else [item]
            for part in values:
                text = str(part or "").strip()
                if text and text not in parts:
                    parts.append(text)
        return str(value.get("separator", "\n")).join(parts)
    if set(value) == {"$coalesce"}:
        for candidate in value["$coalesce"]:
            resolved = resolve_node_input(
                candidate,
                inputs=inputs,
                checkpoint_nodes=checkpoint_nodes,
                incoming_node_ids=incoming_node_ids,
            )
            if resolved not in (None, "", [], {}):
                return resolved
        return None
    if set(value) == {"$replace", "values"}:
        resolved = resolve_node_input(
            value["$replace"],
            inputs=inputs,
            checkpoint_nodes=checkpoint_nodes,
            incoming_node_ids=incoming_node_ids,
        )
        text = str(resolved or "")
        for source, target in value["values"].items():
            text = text.replace(source, target)
        return text
    if "$artifacts" in value:
        sources = resolve_node_input(
            value["$artifacts"],
            inputs=inputs,
            checkpoint_nodes=checkpoint_nodes,
            incoming_node_ids=incoming_node_ids,
        )
        items = _artifact_items(sources)
        source_was_empty = not items
        kinds = {str(item) for item in value.get("kinds") or []}
        if kinds:
            items = [item for item in items if str(item.get("kind") or "") in kinds]
        use_fallback = (
            source_was_empty if value.get("fallback_mode") == "empty-source" else not items
        )
        if use_fallback and "fallback" in value:
            fallback = resolve_node_input(
                value["fallback"],
                inputs=inputs,
                checkpoint_nodes=checkpoint_nodes,
                incoming_node_ids=incoming_node_ids,
            )
            items = _artifact_items(fallback)
            if kinds:
                items = [item for item in items if str(item.get("kind") or "") in kinds]
        unique: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        kind_counts: dict[str, int] = {}
        kind_limits = {str(kind): int(limit) for kind, limit in (value.get("limits") or {}).items()}
        for item in items:
            key = _artifact_key(item)
            if key in seen:
                continue
            kind = str(item.get("kind") or "")
            if kind in kind_limits and kind_counts.get(kind, 0) >= kind_limits[kind]:
                continue
            seen.add(key)
            kind_counts[kind] = kind_counts.get(kind, 0) + 1
            unique.append(item)
        offset = int(value.get("offset") or 0)
        limit = int(value.get("limit") or len(unique) or 1)
        field = str(value.get("field") or "item")
        projected = [
            projected
            for item in unique[offset : offset + limit]
            if (projected := _artifact_value(item, field)) is not None
        ]
        if field == "video_reference":
            roles = [str(role) for role in value.get("roles") or []]
            for index, item in enumerate(projected):
                item["role"] = roles[index] if index < len(roles) else "reference_image"
        if value.get("scalar") is True:
            return copy.deepcopy(projected[0] if projected else value.get("default"))
        return projected
    if "$node" in value and set(value).issubset({"$node", "path"}):
        node_id = str(value["$node"])
        state = checkpoint_nodes.get(node_id)
        if not isinstance(state, dict) or state.get("status") not in NODE_SUCCESS_STATUSES:
            raise StudioFlowError(f"上游节点尚未成功：{node_id}")
        return _read_path(
            state.get("result"),
            str(value.get("path") or ""),
            label=f"节点 {node_id} 结果",
        )
    return {
        key: resolve_node_input(
            item,
            inputs=inputs,
            checkpoint_nodes=checkpoint_nodes,
            incoming_node_ids=incoming_node_ids,
        )
        for key, item in value.items()
    }


def _succeeded_node_ids(checkpoint: Any) -> frozenset[str]:
    nodes = checkpoint.get("nodes") if isinstance(checkpoint, dict) else None
    if not isinstance(nodes, dict):
        return frozenset()
    return frozenset(
        str(node_id)
        for node_id, state in nodes.items()
        if isinstance(state, dict) and state.get("status") in NODE_SUCCESS_STATUSES
    )


def _newly_succeeded(before: frozenset[str], states: dict[str, Any]) -> tuple[str, ...]:
    return tuple(
        node_id
        for node_id, state in states.items()
        if isinstance(state, dict)
        and state.get("status") in NODE_SUCCESS_STATUSES
        and node_id not in before
    )


def _incoming(definition: dict[str, Any]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {str(node["id"]): [] for node in definition["nodes"]}
    for edge in definition["edges"]:
        source = str(edge["from"])
        target = str(edge["to"])
        if source not in result[target]:
            result[target].append(source)
    return result


def _outgoing(definition: dict[str, Any]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {str(node["id"]): [] for node in definition["nodes"]}
    for edge in definition["edges"]:
        source = str(edge["from"])
        target = str(edge["to"])
        if target not in result.setdefault(source, []):
            result[source].append(target)
    return result


def _kind(node: dict[str, Any] | None) -> str:
    return str((node or {}).get("kind") or "tool")


def _failure_policy(node: dict[str, Any] | None) -> str:
    policy = str((node or {}).get("on_failure") or "fail_run")
    return policy if policy in ON_FAILURE_POLICIES else "fail_run"


def _retry_budget(node: dict[str, Any] | None) -> tuple[int, int]:
    retry = (node or {}).get("retry")
    if not isinstance(retry, dict):
        return 0, 0
    return max(0, int(retry.get("max") or 0)), max(0, int(retry.get("backoff_ms") or 0))


def _parse_moment(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC)


def _blank_state() -> dict[str, Any]:
    return {"status": "pending", "task_id": None, "attempt": 0, "result": None, "error": None}


def _ensure_states(definition: dict[str, Any], states: dict[str, Any]) -> None:
    """map 展开出来的实例节点、以及老快照缺的节点，补一份初始状态。"""
    for node in definition["nodes"]:
        node_id = str(node["id"])
        if not isinstance(states.get(node_id), dict):
            states[node_id] = _blank_state()


def _dependency_met(
    states: dict[str, Any],
    node_specs: dict[str, Any],
    source: str,
) -> bool:
    """上游是否算"已满足"：成功、被跳过，或按 continue 策略吞掉失败的都算。"""
    state = states.get(source)
    status = state.get("status") if isinstance(state, dict) else None
    if status in NODE_SUCCESS_STATUSES or status == NODE_SKIPPED_STATUS:
        return True
    return status in NODE_FAILURE_STATUSES and _failure_policy(node_specs.get(source)) == "continue"


def _skip_descendants(
    definition: dict[str, Any],
    states: dict[str, Any],
    root: str,
    *,
    reason: str,
) -> None:
    outgoing = _outgoing(definition)
    pending = list(outgoing.get(root, ()))
    seen: set[str] = set()
    while pending:
        node_id = pending.pop(0)
        if node_id in seen:
            continue
        seen.add(node_id)
        state = states.get(node_id)
        if not isinstance(state, dict) or state.get("status") != "pending":
            continue
        state.update({"status": NODE_SKIPPED_STATUS, "task_id": None, "error": reason})
        pending.extend(outgoing.get(node_id, ()))


def _when_met(
    node: dict[str, Any],
    *,
    inputs: dict[str, Any],
    states: dict[str, Any],
    incoming_node_ids: list[str],
) -> bool:
    if node.get("when") is None:
        return True
    value = resolve_node_input(
        node["when"],
        inputs=inputs,
        checkpoint_nodes=states,
        incoming_node_ids=incoming_node_ids,
    )
    return bool(value)


def _fill_template(value: Any, item: Any, index: int) -> Any:
    """把模板里的 ``$item`` / ``$index`` 换成展开时的字面量。"""
    if isinstance(value, list):
        return [_fill_template(one, item, index) for one in value]
    if not isinstance(value, dict):
        return value
    if set(value) == {"$item"}:
        return _read_path(item, str(value["$item"]), label="map 元素")
    if set(value) == {"$index"}:
        return index
    return {key: _fill_template(one, item, index) for key, one in value.items()}


def _instantiate_map(
    definition: dict[str, Any],
    node: dict[str, Any],
    items: list[Any],
) -> list[str]:
    """把模板实例化成 ``{node}.{index}``，实例接管 map 的入边并回连到 map 节点。

    重复调用幂等：已经存在的实例节点和边都不会再加一遍。
    """
    map_id = str(node["id"])
    template = node["template"]
    node_ids = {str(item["id"]) for item in definition["nodes"]}
    edges = {(str(edge["from"]), str(edge["to"])) for edge in definition["edges"]}
    sources = [str(edge["from"]) for edge in definition["edges"] if str(edge["to"]) == map_id]
    instance_ids: list[str] = []
    for index, item in enumerate(items):
        instance_id = f"{map_id}.{index}"
        instance_ids.append(instance_id)
        if instance_id not in node_ids:
            instance = _fill_template(copy.deepcopy(template), item, index)
            instance["id"] = instance_id
            definition["nodes"].append(instance)
            node_ids.add(instance_id)
        for source in [*sources, instance_id]:
            target = map_id if source == instance_id else instance_id
            if (source, target) not in edges:
                definition["edges"].append({"from": source, "to": target})
                edges.add((source, target))
    return instance_ids


def _aggregate_map(state: dict[str, Any], states: dict[str, Any]) -> None:
    """map 节点自身产出实例结果的聚合：``items`` 走统一媒体条目，``results`` 保留原样。"""
    instances = [str(item) for item in state.get("instances") or []]
    results: list[Any] = []
    items: list[dict[str, Any]] = []
    failures = 0
    for instance_id in instances:
        inner = states.get(instance_id)
        status = inner.get("status") if isinstance(inner, dict) else None
        if status in NODE_SUCCESS_STATUSES:
            results.append(copy.deepcopy((inner or {}).get("result")))
            items.extend(_artifact_items((inner or {}).get("result")))
        elif status in NODE_FAILURE_STATUSES:
            failures += 1
    state.update(
        {
            "status": "partial" if failures else "succeeded",
            "result": {"count": len(instances), "results": results, "items": items},
            "error": f"{failures} 个实例失败" if failures else None,
        }
    )


_MISSING = object()


def _input_node_value(run: StudioFlowRun, node: dict[str, Any]) -> Any:
    name = str(node.get("name") or node.get("id"))
    inputs = run.inputs or {}
    if name in inputs:
        return copy.deepcopy(inputs[name])
    if node.get("value") is not None:
        return copy.deepcopy(node["value"])
    return _MISSING


async def _open_interrupt(
    session: AsyncSession,
    run: StudioFlowRun,
    node_id: str,
    node: dict[str, Any],
) -> None:
    """写一条等人工输入的挂起点；同一节点已有 waiting 记录时不重复写。"""
    existing = (
        await session.execute(
            select(StudioFlowInterrupt).where(
                StudioFlowInterrupt.run_id == run.id,
                StudioFlowInterrupt.node_id == node_id,
                StudioFlowInterrupt.status == "waiting",
            )
        )
    ).scalars().first()
    if existing is not None:
        return
    session.add(
        StudioFlowInterrupt(
            run_id=run.id,
            node_id=node_id,
            kind="input",
            payload={
                "name": str(node.get("name") or node_id),
                "schema": node.get("schema") or {},
            },
            status="waiting",
        )
    )


async def _start_subflow(
    session: AsyncSession,
    queue: QueueLike,
    run: StudioFlowRun,
    node: dict[str, Any],
    states: dict[str, Any],
    incoming_node_ids: list[str],
) -> tuple[StudioTask, str]:
    """按 flow.run 能力起一条子运行；父节点靠包装任务跟踪它的终态。"""
    node_id = str(node["id"])
    resolved = resolve_node_input(
        node.get("inputs") or {},
        inputs=run.inputs or {},
        checkpoint_nodes=states,
        incoming_node_ids=incoming_node_ids,
    )
    if not isinstance(resolved, dict):
        raise StudioFlowError(f"节点 {node_id} 的 subflow 入参必须是对象")
    spec = require_operation("flow.run")
    body = spec.input.model_validate(
        {"flow_id": int(node["flow_id"]), "inputs": resolved, "parent_run_id": run.id}
    )
    run_context = {
        key: value
        for key, value in dict(run.source_context or {}).items()
        if key not in RUN_ONLY_CONTEXT_KEYS
    }
    result = await spec.prepare(
        session,
        tool_id=FLOW_TOOL_ID,
        body=body,
        parent_task_id=None,
        batch_id=run.id,
        source_route=f"/studio/flows/runs/{run.id}",
        source_context={
            **run_context,
            **dict(node.get("source_context") or {}),
            "flow_run_id": run.id,
            "flow_node_id": node_id,
        },
    )
    child_run_id = str((result.task.invocation or {}).get("run_id") or "")
    await session.commit()
    try:
        await queue.enqueue_job(
            "run_studio_flow",
            child_run_id,
            _job_id=flow_tick_job_id(child_run_id),
        )
    except Exception as exc:
        child = await session.get(StudioFlowRun, child_run_id)
        if child is not None:
            child.status = "failed"
            child.error = f"子工作流入队失败：{type(exc).__name__}: {exc}"
            child.finished_at = _now()
            await session.commit()
        raise StudioFlowError(f"节点 {node_id} 的子工作流入队失败：{exc}") from exc
    return result.task, child_run_id


async def _sync_child_runs(session: AsyncSession, states: dict[str, Any]) -> None:
    """子运行到终态时把 outputs 交回父节点；包装任务没被收口也能兜住。"""
    for state in states.values():
        child_run_id = state.get("child_run_id") if isinstance(state, dict) else None
        if not isinstance(child_run_id, str) or not child_run_id:
            continue
        if state.get("status") in NODE_SETTLED_STATUSES:
            continue
        child = await session.get(StudioFlowRun, child_run_id)
        if child is None or child.status not in FLOW_TERMINAL_STATUSES:
            continue
        state.update(
            {
                "status": child.status,
                "result": {
                    "run_id": child.id,
                    "status": child.status,
                    "outputs": copy.deepcopy(child.outputs or {}),
                },
                "error": child.error,
            }
        )


async def _settle_wrapper_task(
    session: AsyncSession,
    queue: QueueLike,
    run: StudioFlowRun,
) -> None:
    """运行到终态：收口包装任务，并把父运行叫醒去取结果。"""
    context = run.source_context if isinstance(run.source_context, dict) else {}
    task_id = context.get(TOOL_TASK_CONTEXT_KEY)
    if isinstance(task_id, str) and task_id:
        task = await session.get(StudioTask, task_id)
        if task is not None and task.status not in TERMINAL_STATUSES:
            if task.status == "queued":
                transition(task, "running", stage="subflow_running", progress=50)
            transition(
                task,
                run.status,
                stage="subflow_finished",
                result={
                    "run_id": run.id,
                    "status": run.status,
                    "outputs": copy.deepcopy(run.outputs or {}),
                },
                error=run.error,
            )
    parent_run_id = run.parent_run_id
    if not context.get(PARENT_NODE_CONTEXT_KEY) or not parent_run_id:
        return
    try:
        await queue.enqueue_job(
            "run_studio_flow",
            parent_run_id,
            _job_id=flow_tick_job_id(parent_run_id, marker=f"child:{run.id}"),
        )
    except Exception:  # noqa: BLE001 - 父运行本来就在轮询，叫不醒不影响正确性
        return


async def _apply_timeouts(
    session: AsyncSession,
    queue: QueueLike,
    states: dict[str, Any],
    node_specs: dict[str, Any],
    tasks: dict[str, StudioTask],
    now: datetime,
) -> None:
    """超时的节点判失败并向子任务发取消；取消通道不可用时只记原因，不改判定。"""
    for node_id, state in states.items():
        if state.get("status") not in NODE_ACTIVE_STATUSES:
            continue
        timeout = (node_specs.get(node_id) or {}).get("timeout_s")
        if not timeout:
            continue
        started = _parse_moment(state.get("started_at"))
        if started is None or (now - started).total_seconds() <= float(timeout):
            continue
        task = tasks.get(node_id)
        if task is not None and task.status not in TERMINAL_STATUSES:
            try:
                await request_cancel(session, queue, task)  # type: ignore[arg-type]
            except StudioTaskError:
                state["cancel_error"] = "子任务已经结束，无需取消"
            except Exception as exc:  # 取消通道不可用不该改变超时判定，只记原因
                state["cancel_error"] = f"{type(exc).__name__}: {exc}"
        state.update(
            {
                "status": "failed",
                "error": f"TIMEOUT：节点超过 {int(timeout)} 秒仍未结束",
            }
        )


def _settle_failures(
    definition: dict[str, Any],
    states: dict[str, Any],
    node_specs: dict[str, Any],
    now: datetime,
) -> tuple[str, str] | None:
    """按节点策略处理失败：先重试，再按 on_failure 决定跳过下游还是整条失败。"""
    for node_id, state in states.items():
        if state.get("status") not in NODE_FAILURE_STATUSES or state.get("settled"):
            continue
        node = node_specs.get(node_id)
        retry_max, backoff_ms = _retry_budget(node)
        attempt = max(1, int(state.get("attempt") or 0))
        if state.get("status") == "failed" and attempt <= retry_max:
            retired = [str(item) for item in state.get("retried_task_ids") or []]
            if state.get("task_id"):
                retired.append(str(state["task_id"]))
            state.update(
                {
                    "status": "pending",
                    "task_id": None,
                    "result": None,
                    "last_error": state.get("error"),
                    "error": None,
                    "retried_task_ids": retired,
                    "retry_after": (now + timedelta(milliseconds=backoff_ms)).isoformat(),
                }
            )
            state.pop("request_key", None)
            state.pop("started_at", None)
            continue
        policy = _failure_policy(node)
        if policy == "fail_run":
            return node_id, f"节点 {node_id} 失败：{state.get('error') or state.get('status')}"
        state["settled"] = policy
        if policy == "skip_downstream":
            _skip_descendants(
                definition,
                states,
                node_id,
                reason=f"上游节点 {node_id} 失败，按 skip_downstream 跳过",
            )
    return None


def _expand_ready_maps(
    definition: dict[str, Any],
    states: dict[str, Any],
    node_specs: dict[str, Any],
    run: StudioFlowRun,
    incoming: dict[str, list[str]],
) -> bool:
    """依赖就绪的 map 节点先展开成实例；返回是否动过定义快照。"""
    changed = False
    for node in list(definition["nodes"]):
        if _kind(node) != "map":
            continue
        node_id = str(node["id"])
        state = states[node_id]
        if state.get("status") != "pending" or state.get("instances") is not None:
            continue
        if not all(_dependency_met(states, node_specs, source) for source in incoming[node_id]):
            continue
        try:
            if not _when_met(
                node,
                inputs=run.inputs or {},
                states=states,
                incoming_node_ids=incoming[node_id],
            ):
                state.update({"status": NODE_SKIPPED_STATUS, "task_id": None, "error": None})
                changed = True
                continue
            items = resolve_node_input(
                node.get("over"),
                inputs=run.inputs or {},
                checkpoint_nodes=states,
                incoming_node_ids=incoming[node_id],
            )
            if not isinstance(items, list):
                raise StudioFlowError(f"节点 {node_id} 的 over 必须求值成数组")
            if len(items) > MAX_MAP_FANOUT:
                raise StudioFlowError(
                    f"节点 {node_id} 要展开 {len(items)} 个实例，超过上限 {MAX_MAP_FANOUT}"
                )
            state["instances"] = _instantiate_map(definition, node, items)
        except (StudioFlowError, ToolExecutionError, ValueError) as exc:
            state.update({"status": "failed", "error": str(exc)})
        changed = True
    return changed


def lock_run_statement(run_id: str) -> Any:
    """tick 的行锁语句。

    ``skip_locked`` 让抢不到锁的一路直接让开，持锁那一路会把链路走完。SQLite 没有
    行锁，方言会把 FOR UPDATE 整段略掉，本机测试退化成普通查询——所以"锁真的加上了"
    只能按 PostgreSQL 方言编译 SQL 来守。
    """
    return select(StudioFlowRun).where(StudioFlowRun.id == run_id).with_for_update(skip_locked=True)


async def _lock_run(session: AsyncSession, run_id: str) -> StudioFlowRun | None:
    """拿到行锁才 tick：并发触发在 PostgreSQL 上只会有一份调度器写 checkpoint。"""
    return (await session.execute(lock_run_statement(run_id))).scalars().first()


async def _adopt_tasks(
    session: AsyncSession,
    run: StudioFlowRun,
    checkpoint_nodes: dict[str, Any],
) -> dict[str, StudioTask]:
    rows = list(
        (
            await session.execute(
                select(StudioTask)
                .where(StudioTask.batch_id == run.id)
                .order_by(StudioTask.created_at, StudioTask.id)
            )
        ).scalars()
    )
    adopted: dict[str, StudioTask] = {}
    for task in rows:
        context = task.source_context or {}
        node_id = context.get("flow_node_id")
        if not isinstance(node_id, str) or node_id not in checkpoint_nodes:
            continue
        # 重试作废掉的旧任务不能再认回来，否则失败会一轮一轮复活
        if task.id in (checkpoint_nodes[node_id].get("retried_task_ids") or []):
            continue
        adopted[node_id] = task
    for node_id, task in adopted.items():
        state = checkpoint_nodes[node_id]
        if not state.get("task_id"):
            state["task_id"] = task.id
            state["attempt"] = max(1, int(state.get("attempt") or 0))
    return adopted


async def advance_flow_run(
    session: AsyncSession,
    queue: QueueLike,
    run_id: str,
) -> FlowAdvance:
    """执行一次非阻塞调度 tick：收割节点、启动 ready 节点、写 checkpoint。"""
    run = await session.get(StudioFlowRun, run_id)
    if run is None:
        raise StudioFlowError(f"DAG 运行不存在：{run_id}", status=404)
    if run.status in FLOW_TERMINAL_STATUSES:
        return FlowAdvance(run, (), (), False)
    if await _lock_run(session, run_id) is None:
        # 另一路 tick 正持有行锁，让它把这一轮走完
        return FlowAdvance(run, (), (), False)

    now = _now()
    recovering = run.status == "recovering"
    definition = normalize_definition(copy.deepcopy(run.definition_snapshot))
    succeeded_before = _succeeded_node_ids(run.checkpoint)
    checkpoint = copy.deepcopy(run.checkpoint or _checkpoint(definition))
    states: dict[str, Any] = checkpoint.setdefault("nodes", {})
    _ensure_states(definition, states)
    node_specs = {str(node["id"]): node for node in definition["nodes"]}

    tasks = await _adopt_tasks(session, run, states)
    task_ids = [
        str(state["task_id"])
        for state in states.values()
        if isinstance(state, dict) and state.get("task_id")
    ]
    if task_ids:
        tasks_by_id = {
            task.id: task
            for task in (
                await session.execute(select(StudioTask).where(StudioTask.id.in_(task_ids)))
            ).scalars()
        }
        # 多个等价图片节点可以共享同一个模型任务。不能只按任务自身记录的
        # flow_node_id 回填，否则别名节点会永远停在 queued。
        for node_id, state in states.items():
            task = tasks_by_id.get(str(state.get("task_id") or ""))
            if task is None:
                continue
            tasks[node_id] = task
            state["status"] = task.status
            state["result"] = copy.deepcopy(task.result)
            state["error"] = task.error

    await _sync_child_runs(session, states)

    if recovering:
        for task in {task.id: task for task in tasks.values()}.values():
            if task.status == "queued":
                flow_node_id = str((task.source_context or {}).get("flow_node_id") or "")
                await enqueue_task(
                    queue,
                    task,
                    _job_id=f"studio-flow-node:{run.id}:{flow_node_id}",
                )

    await _apply_timeouts(session, queue, states, node_specs, tasks, now)

    fail_now = _settle_failures(definition, states, node_specs, now)
    if fail_now is not None:
        node_id, message = fail_now
        run.status = "failed"
        run.error = message
        run.checkpoint = checkpoint
        run.heartbeat_at = now
        run.finished_at = now
        await _settle_wrapper_task(session, queue, run)
        await session.commit()
        return FlowAdvance(
            run, (), (), False, completed_node_ids=_newly_succeeded(succeeded_before, states)
        )

    incoming = _incoming(definition)
    if _expand_ready_maps(definition, states, node_specs, run, incoming):
        run.definition_snapshot = copy.deepcopy(definition)
        node_specs = {str(node["id"]): node for node in definition["nodes"]}
        _ensure_states(definition, states)
        incoming = _incoming(definition)

    outputs = dict(run.outputs or {})
    started: list[str] = []
    waiting_nodes: list[str] = []
    retry_pending = False
    failed_run: tuple[str, str] | None = None
    active_before = len(
        {task.id for task in tasks.values() if task.status not in TERMINAL_STATUSES}
    )
    reusable_requests: dict[str, str] = {}
    for node_id, state in states.items():
        request_key = state.get("request_key")
        if (
            isinstance(request_key, str)
            and state.get("status") in NODE_ACTIVE_STATUSES | NODE_SUCCESS_STATUSES
        ):
            reusable_requests.setdefault(request_key, node_id)
    raw_limit = (run.source_context or {}).get("max_parallel_tasks")
    max_parallel = (
        max(1, min(int(raw_limit), 512))
        if isinstance(raw_limit, int) and not isinstance(raw_limit, bool)
        else None
    )
    for node in definition["nodes"]:
        node_id = str(node["id"])
        state = states[node_id]
        status = state.get("status")
        if status == NODE_WAITING_STATUS:
            waiting_nodes.append(node_id)
            continue
        if status != "pending":
            continue
        retry_after = _parse_moment(state.get("retry_after"))
        if retry_after is not None and retry_after > now:
            retry_pending = True
            continue
        if not all(_dependency_met(states, node_specs, source) for source in incoming[node_id]):
            continue
        kind = _kind(node)
        if (
            kind in {"tool", "subflow"}
            and max_parallel is not None
            and active_before + len(started) >= max_parallel
        ):
            continue
        try:
            if not _when_met(
                node,
                inputs=run.inputs or {},
                states=states,
                incoming_node_ids=incoming[node_id],
            ):
                state.update(
                    {
                        "status": NODE_SKIPPED_STATUS,
                        "task_id": None,
                        "result": None,
                        "error": None,
                    }
                )
                continue
            state.pop("retry_after", None)
            if kind == "input":
                value = _input_node_value(run, node)
                if value is _MISSING:
                    state.update({"status": NODE_WAITING_STATUS, "error": None})
                    await _open_interrupt(session, run, node_id, node)
                    waiting_nodes.append(node_id)
                    continue
                state.update(
                    {
                        "status": "succeeded",
                        "result": {"name": str(node.get("name") or node_id), "value": value},
                        "error": None,
                    }
                )
                continue
            if kind == "output":
                value = resolve_node_input(
                    node.get("value"),
                    inputs=run.inputs or {},
                    checkpoint_nodes=states,
                    incoming_node_ids=incoming[node_id],
                )
                name = str(node.get("name") or node_id)
                outputs[name] = value
                state.update(
                    {"status": "succeeded", "result": {"name": name, "value": value}, "error": None}
                )
                continue
            if kind == "map":
                _aggregate_map(state, states)
                continue
            if kind == "subflow":
                task, child_run_id = await _start_subflow(
                    session, queue, run, node, states, incoming[node_id]
                )
                tasks[node_id] = task
                state.update(
                    {
                        "status": task.status,
                        "task_id": task.id,
                        "child_run_id": child_run_id,
                        "attempt": int(state.get("attempt") or 0) + 1,
                        "started_at": now.isoformat(),
                        "result": None,
                        "error": None,
                    }
                )
                started.append(task.id)
                continue

            resolved = resolve_node_input(
                node.get("input") or {},
                inputs=run.inputs or {},
                checkpoint_nodes=states,
                incoming_node_ids=incoming[node_id],
            )
            if not isinstance(resolved, dict):
                raise StudioFlowError(f"节点 {node_id} 的顶层输入必须是对象")
            tool_id = str(node["tool_id"])
            operation = str(node["operation"])
            body = parse_tool_operation_input(operation, resolved)
            request_key = _deduplication_key(tool_id, operation, body)
            reusable_node_id = (
                reusable_requests.get(request_key) if request_key is not None else None
            )
            if reusable_node_id is not None and reusable_node_id != node_id:
                reusable_state = states[reusable_node_id]
                state.update(
                    {
                        "status": reusable_state.get("status"),
                        "task_id": reusable_state.get("task_id"),
                        "request_key": request_key,
                        "result": copy.deepcopy(reusable_state.get("result")),
                        "error": reusable_state.get("error"),
                    }
                )
                reusable_task = tasks.get(reusable_node_id)
                if reusable_task is not None:
                    tasks[node_id] = reusable_task
                continue
            parent_ids = [
                states[source].get("task_id")
                for source in incoming[node_id]
                if states[source].get("task_id")
            ]
            run_task_context = {
                key: value
                for key, value in dict(run.source_context or {}).items()
                if key not in RUN_ONLY_CONTEXT_KEYS
            }
            context = {
                **run_task_context,
                **dict(node.get("source_context") or {}),
                "flow_run_id": run.id,
                "flow_node_id": node_id,
                "parent_task_ids": [str(task_id) for task_id in parent_ids],
            }
            result = await start_tool_operation(
                session,
                queue,
                tool_id=tool_id,
                operation=operation,
                body=body,
                parent_task_id=str(parent_ids[0]) if len(parent_ids) == 1 else None,
                batch_id=run.id,
                source_route=f"/studio/flows/runs/{run.id}",
                source_context=context,
                job_options={"_job_id": f"studio-flow-node:{run.id}:{node_id}"},
            )
            tasks[node_id] = result.task
            state.update(
                {
                    "status": result.task.status,
                    "task_id": result.task.id,
                    "attempt": int(state.get("attempt") or 0) + 1,
                    "started_at": now.isoformat(),
                    "result": None,
                    "error": None,
                    **({} if request_key is None else {"request_key": request_key}),
                }
            )
            if request_key is not None:
                reusable_requests.setdefault(request_key, node_id)
            started.append(result.task.id)
        except (StudioFlowError, ToolExecutionError, ValueError) as exc:
            state.update({"status": "failed", "error": str(exc)})
            policy = _failure_policy(node)
            if policy == "fail_run":
                failed_run = (node_id, f"节点 {node_id} 启动失败：{exc}")
                break
            state["settled"] = policy
            if policy == "skip_downstream":
                _skip_descendants(
                    definition,
                    states,
                    node_id,
                    reason=f"上游节点 {node_id} 启动失败，按 skip_downstream 跳过",
                )

    active = [task.id for task in tasks.values() if task.status not in TERMINAL_STATUSES]
    if failed_run is not None:
        run.status = "failed"
        run.error = failed_run[1]
        run.finished_at = now
    else:
        statuses = [state.get("status") for state in states.values()]
        if all(status in NODE_SETTLED_STATUSES for status in statuses):
            failures = any(status in NODE_FAILURE_STATUSES for status in statuses)
            run.status = "partial" if failures or "partial" in statuses else "succeeded"
            run.finished_at = now
        elif active or started or retry_pending:
            run.status = "running"
            run.started_at = run.started_at or now
        elif waiting_nodes:
            run.status = FLOW_WAITING_STATUS
        else:
            run.status = "failed"
            run.error = "DAG 没有可运行节点，且仍有未完成节点"
            run.finished_at = now
    run.waiting_node_id = waiting_nodes[0] if waiting_nodes else None
    if outputs:
        run.outputs = outputs
    run.heartbeat_at = now
    run.checkpoint = checkpoint
    if run.status in FLOW_TERMINAL_STATUSES:
        await _settle_wrapper_task(session, queue, run)
    await session.commit()
    return FlowAdvance(
        run,
        tuple(started),
        tuple(dict.fromkeys(active + started)),
        run.status in FLOW_ACTIVE_STATUSES,
        completed_node_ids=_newly_succeeded(succeeded_before, states),
    )

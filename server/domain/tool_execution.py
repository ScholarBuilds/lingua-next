"""工具执行中间件：冻结 manifest，并统一持久任务的 worker 分派。

每个可执行能力（operation）在这里用 ``@tool_operation`` 登记一次：输入合同、
准备函数、worker 分派与任务类型都挂在同一个 ``ToolOperationSpec`` 上。REST 入口、
DAG 节点、任务中心重试和 arq 函数表全都从这张注册表派生，不再各自维护 if-chain。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable, Iterator, Mapping
from copy import deepcopy
from dataclasses import dataclass, field
from functools import cached_property
from types import ModuleType
from typing import Any, Literal, Protocol, TypedDict, TypeVar, cast

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from domain import image_apps, image_defaults, image_prompts, imagegen
from domain.model_catalog import ModelCatalogError, resolve_operation_deployment_id
from domain.models import (
    ImageAsset,
    ImageJob,
    ModelDeployment,
    ProviderCredential,
    StudioFlow,
    StudioFlowRun,
    StudioMediaAsset,
    StudioTask,
    StudioWorkflow,
)
from domain.studio_tasks import new_task, transition
from domain.studio_workflows import PROVIDERS as WORKFLOW_PROVIDERS
from domain.tool_plugins import require_tool_operation, tool_plugin_identity


class QueueLike(Protocol):
    async def enqueue_job(self, *args: Any, **kwargs: Any) -> Any: ...


QueueProvider = QueueLike | Callable[[], Awaitable[QueueLike]]


class ToolExecutionError(ValueError):
    def __init__(self, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


class WorkflowRunParams(BaseModel):
    """工作流运行参数（不含 workflow_id）。

    ``/workflows/{workflow_id}/runs`` 的 workflow_id 走路径参数，请求体直接继承
    这一层；统一入口再补上 workflow_id 组成完整的 ``WorkflowRunInput``。
    """

    model_config = {"extra": "forbid"}

    credential_id: int = Field(ge=1)
    fields: dict[str, object] = Field(default_factory=dict)
    use_wallet: bool = False
    instance_type: Literal["", "plus"] = ""


class WorkflowRunInput(WorkflowRunParams):
    workflow_id: int = Field(ge=1)


class ChatMessageInput(BaseModel):
    model_config = {"extra": "forbid"}

    role: Literal["user", "assistant"]
    content: str = Field(max_length=12_000)


class ChatGeneralInput(BaseModel):
    model_config = {"extra": "forbid"}

    prompt: str = Field(min_length=1, max_length=12_000)
    system_prompt: str = Field(default="", max_length=12_000)
    messages: list[ChatMessageInput] = Field(default_factory=list, max_length=50)
    context: list[str] = Field(default_factory=list, max_length=50)
    image_asset_ids: list[int] = Field(default_factory=list, max_length=20)
    video_media_asset_ids: list[int] = Field(default_factory=list, max_length=3)
    deployment_id: int | None = Field(default=None, ge=1)
    temperature: float | None = Field(default=None, ge=0, le=2)


class VideoReferenceInput(BaseModel):
    model_config = {"extra": "forbid"}

    asset_id: int = Field(ge=1)
    role: Literal["first_frame", "last_frame", "reference_image"] = "first_frame"


class VideoMediaReferenceInput(BaseModel):
    model_config = {"extra": "forbid"}

    media_asset_id: int = Field(ge=1)
    kind: Literal["video", "audio"]


class VideoOptionsInput(BaseModel):
    model_config = {"extra": "forbid"}

    watermark: bool = False
    generate_audio: bool = False
    camera_fixed: bool = False
    # 兼容 F036 之前的任务快照与独立视频页；写入新快照时统一归一成 camera_fixed。
    camerafixed: bool | None = None
    seed: int | None = Field(default=None, ge=-1, le=2**32 - 1)
    # 兼容旧的单参考调用。新调用应通过 references 逐项声明角色。
    reference_role: Literal["first_frame", "last_frame", "reference_image"] | None = None
    multimodal: bool = False


class VideoRunInput(BaseModel):
    model_config = {"extra": "forbid"}

    deployment_id: int = Field(ge=1)
    prompt: str = Field(min_length=1, max_length=4000)
    duration: int = Field(default=4, ge=1, le=60)
    aspect_ratio: str = Field(default="16:9", max_length=16)
    resolution: str = Field(default="720p", max_length=24)
    reference_asset_id: int | None = Field(default=None, ge=1)
    references: list[VideoReferenceInput] = Field(default_factory=list, max_length=20)
    media_references: list[VideoMediaReferenceInput] = Field(default_factory=list, max_length=6)
    options: VideoOptionsInput = Field(default_factory=VideoOptionsInput)


class ImageGenerateInput(BaseModel):
    """生图合同：``prompt`` 非空则直接用它出图，留空则由 ``idea`` / 主体走立意与写词。

    高级参数与 ``/images/jobs`` 的请求体同名同约束；``options`` 留给画布级联这类
    没有逐字段建模的调用方整包透传，同名键以逐字段声明的为准。
    """

    model_config = {"extra": "forbid"}

    prompt: str = Field(default="", max_length=8000)
    idea: str = Field(default="", max_length=800)
    deployment_id: int | None = Field(default=None, ge=1)
    alias: str = Field(default="image-free", min_length=1, max_length=64)
    target_key: str = Field(default="free", min_length=1, max_length=64)
    style_key: str | None = Field(default=None, max_length=64)
    # 留空 = 不指定比例，由立意按画面内容挑一个（FR-451）
    size: str | None = Field(default=None, max_length=32)
    tier: str = Field(default="1k", max_length=16)
    quality: str | None = Field(default=None, max_length=16)
    n: int = Field(default=1, ge=1, le=imagegen.MAX_N)
    # 要画给谁：场景本封面就是 ('wordlist', 12)，自由出图两者为空
    subject_domain: str | None = Field(default=None, max_length=32)
    subject_id: int | None = None
    # 原样透传给上游的高级参数，留空 = 用上游默认
    output_format: Literal["png", "webp", "jpeg"] | None = None
    background: Literal["auto", "transparent", "opaque"] | None = None
    output_compression: int | None = Field(default=None, ge=0, le=100)
    moderation: Literal["auto", "low"] | None = None
    # ModelScope AIGC 异步协议的原生参数，其他 adapter 不传时不受影响
    negative_prompt: str | None = Field(default=None, max_length=2_000)
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)
    steps: int | None = Field(default=None, ge=1, le=100)
    guidance: float | None = Field(default=None, ge=1.5, le=20)
    loras: str | dict[str, float] | None = None
    ref_asset_ids: list[int] = Field(default_factory=list, max_length=10)
    options: dict[str, object] = Field(default_factory=dict)


class UploadRef(BaseModel):
    """已落存储的上传输入：worker 按 ``storage_key`` 读字节，任务结束即删。"""

    model_config = {"extra": "forbid"}

    name: str = Field(min_length=1, max_length=255)
    storage_key: str = Field(min_length=1, max_length=512)


class ImageEditInput(BaseModel):
    """参考图编辑合同。参考图两种给法：``uploads`` 是已落存储的上传字节，
    ``ref_asset_ids`` 直引已入库资产；两路合计至少一张，多图融合要合计两张以上。
    """

    model_config = {"extra": "forbid"}

    prompt: str = Field(min_length=1, max_length=8000)
    ref_asset_ids: list[int] = Field(default_factory=list, max_length=16)
    uploads: list[UploadRef] = Field(default_factory=list, max_length=16)
    mask: UploadRef | None = None
    # 血缘起点（BR-117）；缺省取第一个直引资产
    parent_id: int | None = Field(default=None, ge=1)
    deployment_id: int | None = Field(default=None, ge=1)
    alias: str = Field(default="image-free", min_length=1, max_length=64)
    app_key: str = Field(default="image_to_image", min_length=1, max_length=64)
    size: str | None = Field(default=None, max_length=32)
    quality: str = Field(default=image_defaults.FALLBACK_QUALITY, max_length=16)
    n: int = Field(default=1, ge=1, le=imagegen.MAX_N)


class ImageAutoInput(BaseModel):
    """画布级联的图片能力：有参考时编辑，无参考时生成。

    分支决策在上游任务完成、DAG 解析出实际资产后才能确定，
    不应该由编译画布快照时的旧产物猜测。
    """

    model_config = {"extra": "forbid"}

    prompt: str = Field(min_length=1, max_length=8000)
    ref_asset_ids: list[int] = Field(default_factory=list, max_length=16)
    deployment_id: int | None = Field(default=None, ge=1)
    alias: str = Field(default="image-free", min_length=1, max_length=64)
    target_key: str = Field(default="free", min_length=1, max_length=64)
    style_key: str | None = Field(default=None, max_length=64)
    app_key: str = Field(default="consistent_edit", min_length=1, max_length=64)
    size: str | None = Field(default=None, max_length=32)
    tier: str = Field(default="1k", max_length=16)
    quality: str = Field(default=image_defaults.FALLBACK_QUALITY, max_length=16)
    n: int = Field(default=1, ge=1, le=imagegen.MAX_N)
    options: dict[str, object] = Field(default_factory=dict)


class ImageUpscaleInput(BaseModel):
    model_config = {"extra": "forbid"}

    deployment_id: int = Field(ge=1)
    asset_id: int = Field(ge=1)
    resolution_type: Literal["2k", "4k", "8k"] = "2k"


class MidjourneyGenerateOptions(BaseModel):
    model_config = {"extra": "forbid"}

    quality: Literal["0.25", "0.5", "1", "2"] | None = None
    style: str | None = Field(default=None, max_length=32)
    seed: int | None = Field(default=None, ge=0, le=2**32 - 1)
    negative_prompt: str | None = Field(default=None, max_length=2000)
    stylize: int | None = Field(default=None, ge=0, le=1000)
    chaos: int | None = Field(default=None, ge=0, le=100)
    weird: int | None = Field(default=None, ge=0, le=3000)
    tile: bool | None = None
    niji: bool | None = None
    iw: float | None = Field(default=None, ge=0, le=3)
    raw: bool | None = None
    draft: bool | None = None
    hd: bool | None = None
    stop: int | None = Field(default=None, ge=10, le=100)
    extra: str | None = Field(default=None, max_length=500)
    nsfw_check: bool = False


class MidjourneyGenerateInput(BaseModel):
    model_config = {"extra": "forbid"}

    deployment_id: int = Field(ge=1)
    mode: Literal["imagine", "blend", "edit"] = "imagine"
    prompt: str = Field(default="", max_length=4000)
    size: str = Field(default="1:1", pattern=r"^\d{1,2}:\d{1,2}$")
    version: Literal["8.2", "8.1", "7", "6.1", "5.2", "5.1"] = "8.2"
    speed: Literal["relax", "fast", "turbo"] = "relax"
    reference_asset_ids: list[int] = Field(default_factory=list, max_length=4)
    options: MidjourneyGenerateOptions = Field(default_factory=MidjourneyGenerateOptions)


MidjourneyActionName = Literal[
    "upscale",
    "variation",
    "high_variation",
    "low_variation",
    "reroll",
    "zoom",
    "pan",
    "inpaint",
    "modal",
    "remix_strong",
    "remix_subtle",
]


class MidjourneyActionInput(BaseModel):
    model_config = {"extra": "forbid"}

    deployment_id: int = Field(ge=1)
    task_id: str = Field(min_length=1, max_length=240, pattern=r"^[A-Za-z0-9_.:-]+$")
    action: MidjourneyActionName
    speed: Literal["relax", "fast", "turbo"] = "relax"
    index: int | None = Field(default=None, ge=1, le=4)
    direction: Literal["left", "right", "up", "down"] | None = None
    zoom_ratio: float | None = Field(default=None, gt=1, le=4)
    custom_id: str | None = Field(default=None, max_length=500)
    prompt: str = Field(default="", max_length=4000)
    mask_asset_id: int | None = Field(default=None, ge=1)


ToolOperationInput = (
    ChatGeneralInput
    | WorkflowRunInput
    | VideoRunInput
    | ImageGenerateInput
    | ImageEditInput
    | ImageAutoInput
    | ImageUpscaleInput
    | MidjourneyGenerateInput
    | MidjourneyActionInput
)


@dataclass(frozen=True)
class ToolQueueCall:
    function: str
    args: tuple[Any, ...]
    kwargs: dict[str, Any]


@dataclass(frozen=True)
class ToolExecutionResult:
    task: StudioTask
    image_job_id: int | None = None


# ---- operation 注册表 ----

PrepareFn = Callable[..., Awaitable[ToolExecutionResult]]
QueueFn = Callable[[StudioTask], ToolQueueCall]
PrepareT = TypeVar("PrepareT", bound=PrepareFn)

# 与插件级 resume_policy 同一套词汇：retry 只能重来，provider_task 可凭上游任务 id
# 续轮询，checkpoint 可从断点续跑。
OPERATION_RESUME_POLICIES = frozenset({"retry", "provider_task", "checkpoint"})

_ITEMS_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["items"],
    "properties": {"items": {"type": "array"}},
    "additionalProperties": True,
}


@dataclass(frozen=True)
class ToolOperationSpec:
    """一个可执行能力的全部接线。

    ``task_types`` 为空表示该能力只做分流（如 image.auto），自身不产生任务，
    因此也不需要 worker 函数。
    """

    operation: str
    input: type[BaseModel]
    prepare: PrepareFn
    queue: QueueFn | None
    task_types: frozenset[str]
    resume_policy: str
    worker_function: str | None = None
    output_schema: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.operation or self.operation != self.operation.strip().lower():
            raise ValueError(f"能力名必须是小写且无首尾空白：{self.operation!r}")
        if not (isinstance(self.input, type) and issubclass(self.input, BaseModel)):
            raise ValueError(f"能力 {self.operation} 的输入合同必须是 pydantic 模型")
        if self.resume_policy not in OPERATION_RESUME_POLICIES:
            raise ValueError(f"能力 {self.operation} 的恢复策略未知：{self.resume_policy}")
        if (self.queue is None) != (self.worker_function is None):
            raise ValueError(f"能力 {self.operation} 的 queue 与 worker_function 必须成对给出")
        if self.task_types and self.queue is None:
            raise ValueError(f"能力 {self.operation} 声明了任务类型却没有 worker 分派")

    @cached_property
    def input_schema(self) -> dict[str, Any]:
        return self.input.model_json_schema()

    def contract(self) -> dict[str, Any]:
        return {
            "input_schema": deepcopy(self.input_schema),
            "output_schema": deepcopy(self.output_schema),
            "resume_policy": self.resume_policy,
        }


_OPERATIONS: dict[str, ToolOperationSpec] = {}
_TASK_TYPES: dict[str, ToolOperationSpec] = {}


def register_operation(spec: ToolOperationSpec) -> ToolOperationSpec:
    if spec.operation in _OPERATIONS:
        raise ValueError(f"能力重复注册：{spec.operation}")
    taken = {
        task_type: _TASK_TYPES[task_type].operation
        for task_type in spec.task_types
        if task_type in _TASK_TYPES
    }
    if taken:
        raise ValueError(f"任务类型已被其它能力占用：{taken}")
    _OPERATIONS[spec.operation] = spec
    for task_type in spec.task_types:
        _TASK_TYPES[task_type] = spec
    return spec


def unregister_operation(operation: str) -> None:
    spec = _OPERATIONS.pop(operation.strip().lower(), None)
    if spec is None:
        raise ValueError(f"能力未注册：{operation}")
    for task_type in spec.task_types:
        _TASK_TYPES.pop(task_type, None)


def tool_operation(
    operation: str,
    *,
    input: type[BaseModel],
    resume: str,
    worker: str | None = None,
    queue: QueueFn | None = None,
    task_types: Iterable[str] = (),
    output_schema: dict[str, Any] | None = None,
) -> Callable[[PrepareT], PrepareT]:
    """把 ``_prepare_*`` 登记为能力。

    ``worker`` 是 arq 函数名；默认分派只带任务 id，需要别的参数时传 ``queue``。
    """
    normalized = operation.strip().lower()
    queue_fn = queue
    if queue_fn is None and worker is not None:
        queue_fn = _queue_by_task_id(worker)

    def register(prepare: PrepareT) -> PrepareT:
        register_operation(
            ToolOperationSpec(
                operation=normalized,
                input=input,
                prepare=prepare,
                queue=queue_fn,
                task_types=frozenset(task_types),
                resume_policy=resume,
                worker_function=worker,
                output_schema=dict(output_schema or {}),
            )
        )
        return prepare

    return register


def _queue_by_task_id(function: str) -> QueueFn:
    def queue(task: StudioTask) -> ToolQueueCall:
        return ToolQueueCall(function, (task.id,), {})

    return queue


def _queue_flow_tick(task: StudioTask) -> ToolQueueCall:
    """flow.run / flow.resume 的分派：叫醒那条运行的调度 tick。

    **job id 必须带 marker**：同一条运行会被多次唤醒（外部提交、人工恢复、
    子运行终态回灌），而 arq 在 ``keep_result`` 期内看到同名结果键会**静默丢弃**
    这次入队——不报错、不入队、恢复永远不发生（踩坑索引有记）。
    用任务 id 当 marker，一条任务只叫醒一次，天然唯一。
    """
    from domain.studio_flows import flow_tick_job_id

    run_id = (task.invocation or {}).get("run_id")
    if run_id is None:
        raise ToolExecutionError("工作流任务缺少 run_id，无法恢复")
    return ToolQueueCall(
        "run_studio_flow",
        (str(run_id),),
        {"_job_id": flow_tick_job_id(str(run_id), marker=f"tool:{task.id}")},
    )


def _queue_image_job(task: StudioTask) -> ToolQueueCall:
    """生图走 image_gen 管线，分派参数是 ImageJob id 与重跑范围而不是任务 id。"""
    invocation = dict(task.invocation or {})
    image_job_id = invocation.get("image_job_id")
    if image_job_id is None:
        raise ToolExecutionError("图片任务缺少 image_job_id，无法恢复")
    return ToolQueueCall(
        "generate_image",
        (
            int(image_job_id),
            invocation.get("from_step"),
            invocation.get("config"),
            invocation.get("scope") or "downstream",
        ),
        {},
    )


def get_operation(operation: str) -> ToolOperationSpec | None:
    return _OPERATIONS.get(operation.strip().lower())


def has_operation(operation: str) -> bool:
    return get_operation(operation) is not None


def require_operation(operation: str) -> ToolOperationSpec:
    spec = get_operation(operation)
    if spec is None:
        raise ToolExecutionError(f"能力尚未接入统一执行器：{operation}")
    return spec


def list_operations() -> list[ToolOperationSpec]:
    return [_OPERATIONS[key] for key in sorted(_OPERATIONS)]


def spec_for_task_type(task_type: str) -> ToolOperationSpec | None:
    return _TASK_TYPES.get(task_type)


def operation_contracts(operations: Iterable[str] | None = None) -> dict[str, dict[str, Any]]:
    """跨入口合同视图：input_schema 直接由 pydantic 模型导出，不再手写副本。"""
    keys = (
        sorted(_OPERATIONS)
        if operations is None
        else sorted(key.strip().lower() for key in operations)
    )
    return {key: _OPERATIONS[key].contract() for key in keys if key in _OPERATIONS}


def worker_function_names() -> tuple[str, ...]:
    """注册表声明的 arq 函数名，按注册顺序去重。"""
    names: dict[str, None] = {}
    for spec in _OPERATIONS.values():
        if spec.worker_function is not None:
            names.setdefault(spec.worker_function, None)
    return tuple(names)


def worker_functions(module: ModuleType) -> list[Callable[..., Any]]:
    """把注册表里的函数名解析成 ``module`` 上的真实函数对象，供 WorkerSettings 使用。"""
    resolved: list[Callable[..., Any]] = []
    for name in worker_function_names():
        function = getattr(module, name, None)
        if function is None:
            raise RuntimeError(f"{module.__name__} 缺少注册表声明的 worker 函数：{name}")
        resolved.append(function)
    return resolved


class _OperationInputs(Mapping[str, type[BaseModel]]):
    """``TOOL_OPERATION_INPUTS`` 的实时只读视图，随注册表增删。"""

    def __getitem__(self, key: str) -> type[BaseModel]:
        return _OPERATIONS[key].input

    def __iter__(self) -> Iterator[str]:
        return iter(_OPERATIONS)

    def __len__(self) -> int:
        return len(_OPERATIONS)


TOOL_OPERATION_INPUTS: Mapping[str, type[BaseModel]] = _OperationInputs()


def parse_tool_operation_input(
    operation: str,
    payload: dict[str, Any],
) -> ToolOperationInput:
    """按 manifest 操作名选择唯一的 Pydantic 输入合同。"""
    spec = require_operation(operation)
    try:
        return cast(ToolOperationInput, spec.input.model_validate(payload))
    except ValidationError as exc:
        errors = exc.errors(include_context=False)
        raise ToolExecutionError(f"工具输入不符合合同：{errors}", status=422) from exc


def _runtime_snapshot(tool_id: str, operation: str) -> dict[str, Any]:
    plugin = require_tool_operation(tool_id, operation)
    version, generation = tool_plugin_identity(tool_id)
    return {
        "tool_id": plugin.id,
        "tool_version": version,
        "tool_generation": generation,
        "operation": operation,
        "runtime_kind": plugin.runtime_kind,
        "resume_policy": plugin.resume_policy,
    }


def new_execution_task(
    *,
    tool_id: str,
    operation: str,
    task_type: str,
    invocation: dict[str, Any] | None = None,
    domain: str = "studio",
    parent_task_id: str | None = None,
    batch_id: str | None = None,
    source_route: str | None = None,
    source_context: dict[str, Any] | None = None,
    model_capability: str | None = None,
    deployment_id: int | None = None,
) -> StudioTask:
    """创建带不可变工具插件快照的任务；不在这里提交事务或触发队列。"""
    normalized_operation = operation.strip().lower()
    snapshot = _runtime_snapshot(tool_id, normalized_operation)
    frozen_invocation = dict(invocation or {})
    frozen_invocation["_tool_runtime"] = snapshot
    return new_task(
        tool_id=tool_id,
        task_type=task_type,
        domain=domain,
        parent_task_id=parent_task_id,
        batch_id=batch_id,
        source_route=source_route,
        source_context=source_context,
        capability=model_capability,
        deployment_id=deployment_id,
        invocation=frozen_invocation,
    )


def queue_call_for(task: StudioTask) -> ToolQueueCall:
    """从持久调用快照恢复 worker 分派，不依赖路由或浏览器内存。"""
    spec = spec_for_task_type(task.task_type or "")
    if spec is None or spec.queue is None:
        raise ToolExecutionError(f"任务类型尚未接入统一执行器：{task.task_type}")
    return spec.queue(task)


async def enqueue_task(
    queue: QueueLike,
    task: StudioTask,
    **job_options: Any,
) -> None:
    call = queue_call_for(task)
    await queue.enqueue_job(
        call.function,
        *call.args,
        **{**call.kwargs, **job_options},
    )


async def fail_queue(
    session: AsyncSession,
    task: StudioTask,
    exc: BaseException,
    *,
    label: str = "任务",
) -> str:
    message = f"{label}入队失败：{type(exc).__name__}: {exc}"
    transition(
        task,
        "failed",
        stage="queue",
        error=message,
        retryable=True,
    )
    await session.commit()
    return message


@tool_operation(
    "workflow.run",
    input=WorkflowRunInput,
    worker="run_studio_workflow",
    task_types={f"workflow.{provider}" for provider in WORKFLOW_PROVIDERS},
    resume="provider_task",
    output_schema=_ITEMS_OUTPUT_SCHEMA,
)
async def _prepare_workflow(
    session: AsyncSession,
    *,
    tool_id: str,
    body: WorkflowRunInput,
    parent_task_id: str | None,
    batch_id: str | None,
    source_route: str | None,
    source_context: dict[str, Any] | None,
) -> ToolExecutionResult:
    workflow = await session.get(StudioWorkflow, body.workflow_id)
    if workflow is None:
        raise ToolExecutionError(f"工作流不存在：{body.workflow_id}", status=404)
    if not workflow.enabled:
        raise ToolExecutionError("工作流已停用", status=409)
    credential = await session.get(ProviderCredential, body.credential_id)
    if credential is None or not credential.enabled:
        raise ToolExecutionError("供应商凭据不存在或已停用")
    if credential.kind != "workflow" or credential.provider_type != workflow.provider:
        raise ToolExecutionError(
            f"请选择 {workflow.provider} 工作流凭据，当前为 "
            f"{credential.kind}/{credential.provider_type}"
        )
    if body.use_wallet and workflow.provider != "runninghub":
        raise ToolExecutionError("仅 RunningHub 支持账户余额 Key")
    if body.instance_type and workflow.provider != "runninghub":
        raise ToolExecutionError("仅 RunningHub 支持实例规格")
    task = new_execution_task(
        tool_id=tool_id,
        operation="workflow.run",
        task_type=f"workflow.{workflow.provider}",
        parent_task_id=parent_task_id,
        batch_id=batch_id,
        source_route=source_route,
        source_context={"workflow_id": workflow.id, **dict(source_context or {})},
        invocation={
            "workflow_id": workflow.id,
            "credential_id": credential.id,
            "fields": body.fields,
            "use_wallet": body.use_wallet,
            "instance_type": body.instance_type,
        },
    )
    session.add(task)
    return ToolExecutionResult(task)


@tool_operation(
    "chat.general",
    input=ChatGeneralInput,
    worker="run_studio_chat",
    task_types={"chat.general"},
    resume="retry",
    output_schema={
        "type": "object",
        "required": ["text"],
        "properties": {"text": {"type": "string"}},
        "additionalProperties": False,
    },
)
async def _prepare_chat(
    session: AsyncSession,
    *,
    tool_id: str,
    body: ChatGeneralInput,
    parent_task_id: str | None,
    batch_id: str | None,
    source_route: str | None,
    source_context: dict[str, Any] | None,
) -> ToolExecutionResult:
    image_ids = list(dict.fromkeys(body.image_asset_ids))
    if len(image_ids) != len(body.image_asset_ids):
        raise ToolExecutionError("LLM 参考图不能重复")
    for asset_id in image_ids:
        asset = await session.get(ImageAsset, asset_id)
        if asset is None or not str(asset.mime or "").startswith("image/"):
            raise ToolExecutionError(f"LLM 参考图不存在或不是图片：{asset_id}", status=404)
    video_ids = list(dict.fromkeys(body.video_media_asset_ids))
    if len(video_ids) != len(body.video_media_asset_ids):
        raise ToolExecutionError("LLM 参考视频不能重复")
    for media_id in video_ids:
        media = await session.get(StudioMediaAsset, media_id)
        if media is None or media.kind != "video":
            raise ToolExecutionError(f"LLM 参考视频不存在或不是视频：{media_id}", status=404)
    try:
        deployment_id = await resolve_operation_deployment_id(
            session,
            "chat-general",
            deployment_id=body.deployment_id,
            media_type="chat",
            operation="chat.complete",
        )
    except ModelCatalogError as exc:
        raise ToolExecutionError(str(exc)) from exc
    task = new_execution_task(
        tool_id=tool_id,
        operation="chat.general",
        task_type="chat.general",
        parent_task_id=parent_task_id,
        batch_id=batch_id,
        model_capability="chat-general",
        deployment_id=deployment_id,
        source_route=source_route,
        source_context=source_context,
        invocation={
            "prompt": body.prompt.strip(),
            "system_prompt": body.system_prompt.strip(),
            "messages": [item.model_dump() for item in body.messages],
            "context": body.context,
            "image_asset_ids": image_ids,
            "video_media_asset_ids": video_ids,
            "temperature": body.temperature,
        },
    )
    session.add(task)
    return ToolExecutionResult(task)


@tool_operation(
    "video.generate",
    input=VideoRunInput,
    worker="generate_studio_video",
    task_types={"video.generate"},
    resume="provider_task",
    output_schema=_ITEMS_OUTPUT_SCHEMA,
)
async def _prepare_video(
    session: AsyncSession,
    *,
    tool_id: str,
    body: VideoRunInput,
    parent_task_id: str | None,
    batch_id: str | None,
    source_route: str | None,
    source_context: dict[str, Any] | None,
) -> ToolExecutionResult:
    deployment = await session.get(ModelDeployment, body.deployment_id)
    if deployment is None or not deployment.enabled:
        raise ToolExecutionError("视频模型部署不存在或已停用")
    credential = await session.get(ProviderCredential, deployment.credential_id)
    if (
        credential is None
        or not credential.enabled
        or (credential.kind != "video" and credential.provider_type != "jimeng_cli")
    ):
        raise ToolExecutionError("视频供应商凭据不可用")
    try:
        await resolve_operation_deployment_id(
            session,
            "video-generate",
            deployment_id=deployment.id,
            media_type="video",
            operation="video.generate",
        )
    except ModelCatalogError as exc:
        raise ToolExecutionError(str(exc)) from exc
    if body.reference_asset_id is not None and body.references:
        raise ToolExecutionError("reference_asset_id 与 references 不能同时使用")
    reference_ids = [item.asset_id for item in body.references]
    if len(reference_ids) != len(set(reference_ids)):
        raise ToolExecutionError("视频参考图不能重复")
    for asset_id in [body.reference_asset_id, *reference_ids]:
        if asset_id is None:
            continue
        asset = await session.get(ImageAsset, asset_id)
        if asset is None:
            raise ToolExecutionError(f"参考图资产不存在：{asset_id}")
        if not str(asset.mime or "").startswith("image/"):
            raise ToolExecutionError(f"视频参考必须是图片：{asset_id}")

    references = [item.model_dump() for item in body.references]
    reference_count = len(references) + (1 if body.reference_asset_id is not None else 0)

    media_ids = [item.media_asset_id for item in body.media_references]
    if len(media_ids) != len(set(media_ids)):
        raise ToolExecutionError("视频/音频参考不能重复")
    if body.media_references and deployment.adapter_type not in {"jimeng", "volcengine"}:
        raise ToolExecutionError("视频/音频多模态参考只支持即梦 CLI 或火山方舟")
    media_kinds: list[str] = []
    for item in body.media_references:
        media = await session.get(StudioMediaAsset, item.media_asset_id)
        if media is None or media.status != "active":
            raise ToolExecutionError(f"多媒体参考资产不存在或已归档：{item.media_asset_id}")
        if media.kind != item.kind or media.kind not in {"video", "audio"}:
            raise ToolExecutionError(f"多媒体参考类型不匹配：{item.media_asset_id}")
        media_kinds.append(media.kind)
    if media_kinds.count("video") > 3 or media_kinds.count("audio") > 3:
        raise ToolExecutionError("多模态参考最多 3 个视频和 3 个音频")
    if media_kinds and "video" not in media_kinds and reference_count == 0:
        raise ToolExecutionError("多模态参考不能只使用音频")

    options = body.options.model_dump(exclude_none=True)
    if options.get("multimodal") is False:
        options.pop("multimodal")
    if options.pop("camerafixed", None):
        options["camera_fixed"] = True
    if deployment.adapter_type == "openai":
        unsupported = [
            label
            for key, label in (
                ("watermark", "水印"),
                ("generate_audio", "同步音频"),
                ("camera_fixed", "固定机位"),
            )
            if options.get(key) is True
        ]
        if options.get("seed") is not None:
            unsupported.append("随机种子")
        if unsupported:
            raise ToolExecutionError(f"OpenAI Videos 不支持：{'、'.join(unsupported)}")
        if reference_count > 1:
            raise ToolExecutionError("OpenAI Videos 最多只支持 1 张参考图")
    elif deployment.adapter_type == "volcengine":
        if reference_count > 9:
            raise ToolExecutionError("火山方舟视频最多支持 9 张参考图")
        roles = [item.role for item in body.references]
        if roles.count("first_frame") > 1 or roles.count("last_frame") > 1:
            raise ToolExecutionError("首帧和尾帧参考各最多 1 张")
        if options.get("camera_fixed") is True and (reference_count > 0 or media_kinds):
            raise ToolExecutionError("火山方舟的固定机位不支持参考场景")
    elif deployment.adapter_type == "jimeng":
        if options.get("multimodal") is True and reference_count > 9:
            raise ToolExecutionError("即梦全能参考最多支持 9 张图片")

    task = new_execution_task(
        tool_id=tool_id,
        operation="video.generate",
        task_type="video.generate",
        parent_task_id=parent_task_id,
        batch_id=batch_id,
        model_capability="video-generate",
        deployment_id=deployment.id,
        source_route=source_route,
        source_context=source_context,
        invocation={
            "deployment_id": deployment.id,
            "prompt": body.prompt,
            "duration": body.duration,
            "aspect_ratio": body.aspect_ratio,
            "resolution": body.resolution,
            "reference_asset_id": body.reference_asset_id,
            "references": references,
            "media_references": [item.model_dump() for item in body.media_references],
            "options": options,
        },
    )
    session.add(task)
    return ToolExecutionResult(task)


@tool_operation(
    "midjourney.generate",
    input=MidjourneyGenerateInput,
    worker="generate_midjourney",
    task_types={"midjourney.generate"},
    resume="provider_task",
    output_schema={
        "type": "object",
        "properties": {
            "asset_ids": {"type": "array"},
            "provider_task_id": {"type": "string"},
            "buttons": {"type": "array"},
        },
        "additionalProperties": True,
    },
)
async def _prepare_midjourney_generate(
    session: AsyncSession,
    *,
    tool_id: str,
    body: MidjourneyGenerateInput,
    parent_task_id: str | None,
    batch_id: str | None,
    source_route: str | None,
    source_context: dict[str, Any] | None,
) -> ToolExecutionResult:
    deployment = await session.get(ModelDeployment, body.deployment_id)
    if deployment is None or not deployment.enabled:
        raise ToolExecutionError("Midjourney 模型部署不存在或已停用")
    if deployment.adapter_type != "apimart":
        raise ToolExecutionError("Midjourney 节点只能使用 APIMart adapter")
    if deployment.media_types and "image" not in deployment.media_types:
        raise ToolExecutionError("所选部署没有标记图片能力")
    credential = await session.get(ProviderCredential, deployment.credential_id)
    if credential is None or not credential.enabled or credential.kind not in {"image", "llm"}:
        raise ToolExecutionError("APIMart 图片凭据不可用")
    prompt = body.prompt.strip()
    refs = list(dict.fromkeys(body.reference_asset_ids))
    if len(refs) != len(body.reference_asset_ids):
        raise ToolExecutionError("Midjourney 参考图不能重复")
    if body.mode == "blend" and not 2 <= len(refs) <= 4:
        raise ToolExecutionError("Midjourney 融图需要 2–4 张参考图")
    if body.mode == "edit" and (not prompt or not refs):
        raise ToolExecutionError("Midjourney 编辑需要提示词和至少 1 张参考图")
    if body.mode == "imagine" and not prompt:
        raise ToolExecutionError("Midjourney 生成需要提示词")
    for asset_id in refs:
        asset = await session.get(ImageAsset, asset_id)
        if asset is None:
            raise ToolExecutionError(f"参考图资产不存在：{asset_id}", status=404)
        if not str(asset.mime or "").startswith("image/"):
            raise ToolExecutionError(f"参考资产不是图片：{asset_id}")
    task = new_execution_task(
        tool_id=tool_id,
        operation="midjourney.generate",
        task_type="midjourney.generate",
        parent_task_id=parent_task_id,
        batch_id=batch_id,
        model_capability="midjourney",
        deployment_id=deployment.id,
        source_route=source_route,
        source_context=source_context,
        invocation={
            "deployment_id": deployment.id,
            "mode": body.mode,
            "prompt": prompt,
            "size": body.size,
            "version": body.version,
            "speed": body.speed,
            "reference_asset_ids": refs,
            "options": body.options.model_dump(exclude_none=True),
        },
    )
    session.add(task)
    return ToolExecutionResult(task)


@tool_operation(
    "midjourney.action",
    input=MidjourneyActionInput,
    worker="generate_midjourney",
    task_types={"midjourney.action"},
    resume="provider_task",
    output_schema={
        "type": "object",
        "properties": {
            "asset_ids": {"type": "array"},
            "provider_task_id": {"type": "string"},
            "modal_required": {"type": "boolean"},
        },
        "additionalProperties": True,
    },
)
async def _prepare_midjourney_action(
    session: AsyncSession,
    *,
    tool_id: str,
    body: MidjourneyActionInput,
    parent_task_id: str | None,
    batch_id: str | None,
    source_route: str | None,
    source_context: dict[str, Any] | None,
) -> ToolExecutionResult:
    deployment = await session.get(ModelDeployment, body.deployment_id)
    if deployment is None or not deployment.enabled:
        raise ToolExecutionError("Midjourney 模型部署不存在或已停用")
    if deployment.adapter_type != "apimart":
        raise ToolExecutionError("Midjourney 节点只能使用 APIMart adapter")
    credential = await session.get(ProviderCredential, deployment.credential_id)
    if credential is None or not credential.enabled or credential.kind not in {"image", "llm"}:
        raise ToolExecutionError("APIMart 图片凭据不可用")
    if (
        body.action in {"upscale", "variation", "remix_strong", "remix_subtle"}
        and body.index is None
        and not body.custom_id
    ):
        raise ToolExecutionError(f"{body.action} 需要 1–4 的图片序号或 custom_id")
    if body.action == "zoom" and body.zoom_ratio is None and not body.custom_id:
        raise ToolExecutionError("zoom 需要 1–4 的缩放倍数或 custom_id")
    if body.action == "pan" and body.direction is None and not body.custom_id:
        raise ToolExecutionError("pan 需要方向或 custom_id")
    if body.action == "modal":
        if body.mask_asset_id is None:
            raise ToolExecutionError("局部重绘需要遮罩图")
        if await session.get(ImageAsset, body.mask_asset_id) is None:
            raise ToolExecutionError("遮罩图资产不存在", status=404)
    task = new_execution_task(
        tool_id=tool_id,
        operation="midjourney.action",
        task_type="midjourney.action",
        parent_task_id=parent_task_id,
        batch_id=batch_id,
        model_capability="midjourney",
        deployment_id=deployment.id,
        source_route=source_route,
        source_context=source_context,
        invocation={
            "deployment_id": deployment.id,
            "task_id": body.task_id,
            "action": body.action,
            "speed": body.speed,
            "index": body.index,
            "direction": body.direction,
            "zoom_ratio": body.zoom_ratio,
            "custom_id": body.custom_id,
            "prompt": body.prompt.strip(),
            "mask_asset_id": body.mask_asset_id,
        },
    )
    session.add(task)
    return ToolExecutionResult(task)


@tool_operation(
    "image.generate",
    input=ImageGenerateInput,
    worker="generate_image",
    queue=_queue_image_job,
    # image.rerun 是生图控制台的单步重跑，与首跑共用同一条管线分派
    task_types={"image.generate", "image.rerun"},
    resume="retry",
    output_schema=_ITEMS_OUTPUT_SCHEMA,
)
async def _prepare_image_generate(
    session: AsyncSession,
    *,
    tool_id: str,
    body: ImageGenerateInput,
    parent_task_id: str | None,
    batch_id: str | None,
    source_route: str | None,
    source_context: dict[str, Any] | None,
) -> ToolExecutionResult:
    if body.alias not in imagegen.IMAGE_CAPABILITIES:
        raise ToolExecutionError(f"未知生图能力：{body.alias}")
    try:
        target = image_prompts.get_target(body.target_key)
        # 空 size 是「不指定比例」的正当表达，不回落到用途默认——
        # 回落掉的话立意就没机会挑了，而用途默认对通用出图往往就是个方块
        size = image_prompts.validate_size(body.size) if body.size else None
    except image_prompts.PromptError as exc:
        raise ToolExecutionError(str(exc)) from exc
    quality = body.quality or target.quality
    if quality not in image_prompts.QUALITIES:
        raise ToolExecutionError(f"未知质量档：{quality}")
    for ref_id in body.ref_asset_ids:
        if await session.get(ImageAsset, ref_id) is None:
            raise ToolExecutionError(f"参考资产不存在：{ref_id}", status=404)
    _check_loras(body.loras)
    image_options = _image_options(body)
    try:
        deployment_id = await resolve_operation_deployment_id(
            session,
            body.alias,
            deployment_id=body.deployment_id,
            media_type="image",
            operation="image.generate",
        )
    except ModelCatalogError as exc:
        raise ToolExecutionError(str(exc)) from exc
    task = new_execution_task(
        tool_id=tool_id,
        operation="image.generate",
        task_type="image.generate",
        parent_task_id=parent_task_id,
        batch_id=batch_id,
        model_capability=body.alias,
        deployment_id=deployment_id,
        source_route=source_route,
        source_context=source_context,
        invocation={
            "target_key": body.target_key,
            "idea": body.idea or None,
            "prompt_override": body.prompt or None,
            "style_key": body.style_key,
            "size": size,
            "tier": body.tier,
            "quality": quality,
            "n": body.n,
            "options": image_options,
        },
    )
    job = ImageJob(
        target_key=body.target_key,
        idea=body.idea or None,
        subject_domain=body.subject_domain,
        subject_id=body.subject_id,
        style_key=body.style_key or target.default_style,
        size=size,
        quality=quality,
        n=body.n,
        alias=body.alias,
        # 非空则 worker 跳过立意与写词两步直接用它
        prompt_override=body.prompt or None,
        options={"tier": body.tier, **image_options},
        status="pending",
        studio_task_id=task.id,
    )
    session.add(task)
    # ImageJob 只有 task id，没有 ORM relationship；PostgreSQL 下 SQLAlchemy 不会
    # 据此稳定推导 INSERT 顺序。先落父行，避免 image_job 外键偶发先插导致 500。
    await session.flush([task])
    session.add(job)
    await session.flush([job])
    task.invocation = {**(task.invocation or {}), "image_job_id": job.id}
    return ToolExecutionResult(task, image_job_id=job.id)


def _check_loras(loras: str | dict[str, float] | None) -> None:
    if isinstance(loras, str) and len(loras.strip()) > 240:
        raise ToolExecutionError("LoRA 模型 ID 过长")
    if isinstance(loras, dict):
        if len(loras) > 6:
            raise ToolExecutionError("ModelScope 单次最多使用 6 个 LoRA")
        if any(not key.strip() or weight < 0 or weight > 1 for key, weight in loras.items()):
            raise ToolExecutionError("LoRA ID 不能为空，权重须在 0~1 之间")


def _image_options(body: ImageGenerateInput) -> dict[str, object]:
    """上游高级参数整包：整包透传的 ``options`` 垫底，逐字段声明的值覆盖同名键。"""
    typed: dict[str, object] = {
        "output_format": body.output_format,
        "background": body.background,
        "output_compression": body.output_compression,
        "moderation": body.moderation,
        "negative_prompt": body.negative_prompt,
        "seed": body.seed,
        "steps": body.steps,
        "guidance": body.guidance,
        "loras": body.loras,
        "ref_asset_ids": body.ref_asset_ids or None,
    }
    return {
        **body.options,
        **{key: value for key, value in typed.items() if value is not None},
    }


@tool_operation(
    "image.edit",
    input=ImageEditInput,
    worker="edit_image_task",
    task_types={"image.edit"},
    resume="retry",
    output_schema=_ITEMS_OUTPUT_SCHEMA,
)
async def _prepare_image_edit(
    session: AsyncSession,
    *,
    tool_id: str,
    body: ImageEditInput,
    parent_task_id: str | None,
    batch_id: str | None,
    source_route: str | None,
    source_context: dict[str, Any] | None,
) -> ToolExecutionResult:
    if body.alias not in imagegen.IMAGE_CAPABILITIES:
        raise ToolExecutionError(f"未知生图能力：{body.alias}")
    try:
        app = image_apps.get_app(body.app_key)
    except image_prompts.PromptError as exc:
        raise ToolExecutionError(str(exc)) from exc
    if app.engine != "edit":
        raise ToolExecutionError(f"应用「{app.label}」不是编辑类，不能走编辑入口")
    if app.needs_mask and body.mask is None:
        raise ToolExecutionError(f"应用「{app.label}」需要先涂出要改的区域")
    if body.quality not in image_prompts.QUALITIES:
        raise ToolExecutionError(f"未知质量档：{body.quality}")
    for asset_id in body.ref_asset_ids:
        if await session.get(ImageAsset, asset_id) is None:
            raise ToolExecutionError(f"参考资产不存在：{asset_id}", status=404)
    # 上传与直引合并后再校验数量：多图融合要的是「合计两张以上」，不关心各自从哪条路来
    input_count = len(body.uploads) + len(body.ref_asset_ids)
    if input_count == 0:
        raise ToolExecutionError("至少要一张参考图（上传或 ref_asset_ids）")
    if "images" in app.inputs and input_count < 2:
        raise ToolExecutionError(f"应用「{app.label}」至少要两张图")
    # 血缘不断（BR-117）：没显式指定 parent 时，第一个直引资产就是这次编辑的底图
    parent_id = body.parent_id
    if parent_id is None and body.ref_asset_ids:
        parent_id = body.ref_asset_ids[0]
    try:
        deployment_id = await resolve_operation_deployment_id(
            session,
            body.alias,
            deployment_id=body.deployment_id,
            media_type="image",
            operation="image.edit",
        )
    except ModelCatalogError as exc:
        raise ToolExecutionError(str(exc)) from exc
    task = new_execution_task(
        tool_id=tool_id,
        operation="image.edit",
        task_type="image.edit",
        parent_task_id=parent_task_id,
        batch_id=batch_id,
        model_capability=body.alias,
        deployment_id=deployment_id,
        source_route=source_route,
        source_context=source_context,
        invocation={
            "prompt": body.prompt,
            "alias": body.alias,
            "size": body.size,
            "quality": body.quality,
            "app_key": app.key,
            "parent_id": parent_id,
            "n": body.n,
            "ref_asset_ids": body.ref_asset_ids,
            "uploads": [item.model_dump() for item in body.uploads],
            "mask": body.mask.model_dump() if body.mask is not None else None,
        },
    )
    session.add(task)
    return ToolExecutionResult(task)


class _ImagePrepareCommon(TypedDict):
    """image.auto 分流到生成/编辑时原样透传的关键字参数。"""

    session: AsyncSession
    tool_id: str
    parent_task_id: str | None
    batch_id: str | None
    source_route: str | None
    source_context: dict[str, Any] | None


@tool_operation(
    "image.auto",
    input=ImageAutoInput,
    # 只做分流：落库的任务类型是 image.generate / image.edit，由那两个能力分派
    resume="retry",
    output_schema={
        "type": "object",
        "properties": {"asset_ids": {"type": "array"}},
        "additionalProperties": True,
    },
)
async def _prepare_image_auto(
    session: AsyncSession,
    *,
    tool_id: str,
    body: ImageAutoInput,
    parent_task_id: str | None,
    batch_id: str | None,
    source_route: str | None,
    source_context: dict[str, Any] | None,
) -> ToolExecutionResult:
    refs = list(dict.fromkeys(body.ref_asset_ids))
    if len(refs) != len(body.ref_asset_ids):
        raise ToolExecutionError("图片参考不能重复")
    common: _ImagePrepareCommon = {
        "session": session,
        "tool_id": tool_id,
        "parent_task_id": parent_task_id,
        "batch_id": batch_id,
        "source_route": source_route,
        "source_context": source_context,
    }
    if refs:
        return await _prepare_image_edit(
            **common,
            body=ImageEditInput(
                prompt=body.prompt,
                ref_asset_ids=refs,
                deployment_id=body.deployment_id,
                alias=body.alias,
                app_key=body.app_key,
                # 画布旧语义是参考编辑跟随原图尺寸，不把生成分支的画幅带进来。
                size=None,
                quality=body.quality,
                n=body.n,
            ),
        )
    return await _prepare_image_generate(
        **common,
        body=ImageGenerateInput(
            prompt=body.prompt,
            deployment_id=body.deployment_id,
            alias=body.alias,
            target_key=body.target_key,
            style_key=body.style_key,
            size=body.size,
            tier=body.tier,
            quality=body.quality,
            n=body.n,
            options=body.options,
        ),
    )


@tool_operation(
    "image.upscale",
    input=ImageUpscaleInput,
    worker="upscale_image_task",
    task_types={"image.upscale"},
    resume="retry",
    output_schema={
        "type": "object",
        "required": ["asset_ids"],
        "properties": {"asset_ids": {"type": "array"}},
        "additionalProperties": True,
    },
)
async def _prepare_image_upscale(
    session: AsyncSession,
    *,
    tool_id: str,
    body: ImageUpscaleInput,
    parent_task_id: str | None,
    batch_id: str | None,
    source_route: str | None,
    source_context: dict[str, Any] | None,
) -> ToolExecutionResult:
    asset = await session.get(ImageAsset, body.asset_id)
    if asset is None:
        raise ToolExecutionError(f"参考资产不存在：{body.asset_id}", status=404)
    deployment = await session.get(ModelDeployment, body.deployment_id)
    if deployment is None or not deployment.enabled or deployment.adapter_type != "jimeng":
        raise ToolExecutionError("图片放大必须选择可用的即梦 CLI 图片部署")
    credential = await session.get(ProviderCredential, deployment.credential_id)
    if credential is None or not credential.enabled or credential.provider_type != "jimeng_cli":
        raise ToolExecutionError("即梦 CLI 凭据不可用")
    try:
        deployment_id = await resolve_operation_deployment_id(
            session,
            "image-free",
            deployment_id=deployment.id,
            media_type="image",
            operation="image.upscale",
        )
    except ModelCatalogError as exc:
        raise ToolExecutionError(str(exc)) from exc
    task = new_execution_task(
        tool_id=tool_id,
        operation="image.upscale",
        task_type="image.upscale",
        parent_task_id=parent_task_id,
        batch_id=batch_id,
        model_capability="image-free",
        deployment_id=deployment_id,
        source_route=source_route,
        source_context=source_context,
        invocation={
            "asset_id": asset.id,
            "resolution_type": body.resolution_type,
        },
    )
    session.add(task)
    return ToolExecutionResult(task)


class FlowRunInput(BaseModel):
    """把一条已保存的工作流当作一次能力调用；子工作流节点走的就是这条路。"""

    model_config = {"extra": "forbid"}

    flow_id: int = Field(ge=1)
    inputs: dict[str, Any] = Field(default_factory=dict)
    # 父运行 id：子运行挂上去之后，任务中心与画布都能顺着链路回到发起方
    parent_run_id: str | None = Field(default=None, min_length=1, max_length=36)


class FlowResumeInput(BaseModel):
    """把人工输入填回挂起节点，并让那条运行继续跑。"""

    model_config = {"extra": "forbid"}

    run_id: str = Field(min_length=1, max_length=36)
    node_id: str = Field(min_length=1, max_length=96)
    resume_value: Any = None


@tool_operation(
    "flow.run",
    input=FlowRunInput,
    worker="run_studio_flow",
    queue=_queue_flow_tick,
    task_types={"flow.run"},
    resume="checkpoint",
    output_schema={
        "type": "object",
        "required": ["run_id"],
        "properties": {
            "run_id": {"type": "string"},
            "status": {"type": "string"},
            "outputs": {"type": "object"},
        },
        "additionalProperties": True,
    },
)
async def _prepare_flow_run(
    session: AsyncSession,
    *,
    tool_id: str,
    body: FlowRunInput,
    parent_task_id: str | None,
    batch_id: str | None,
    source_route: str | None,
    source_context: dict[str, Any] | None,
) -> ToolExecutionResult:
    from domain import studio_flows

    flow = await session.get(StudioFlow, body.flow_id)
    if flow is None:
        raise ToolExecutionError(f"工作流不存在：{body.flow_id}", status=404)
    if not flow.enabled:
        raise ToolExecutionError("工作流已停用", status=409)
    context = dict(source_context or {})
    try:
        studio_flows.validate_flow_inputs(flow.input_schema, body.inputs)
        child = studio_flows.new_flow_run(
            flow,
            inputs=body.inputs,
            parent_run_id=body.parent_run_id,
            source_context={"kind": "subflow"},
        )
    except studio_flows.StudioFlowError as exc:
        raise ToolExecutionError(str(exc), status=exc.status) from exc
    task = new_task(
        tool_id=tool_id,
        task_type="flow.run",
        parent_task_id=parent_task_id,
        batch_id=batch_id,
        source_route=source_route,
        source_context={**context, "child_run_id": child.id},
        invocation={
            "flow_id": flow.id,
            "flow_version": flow.version,
            "run_id": child.id,
            "inputs": deepcopy(body.inputs),
        },
    )
    child.source_context = {
        **(child.source_context or {}),
        studio_flows.TOOL_TASK_CONTEXT_KEY: task.id,
        **(
            {studio_flows.PARENT_NODE_CONTEXT_KEY: str(context["flow_node_id"])}
            if context.get("flow_node_id")
            else {}
        ),
    }
    session.add(child)
    session.add(task)
    return ToolExecutionResult(task)


@tool_operation(
    "flow.resume",
    input=FlowResumeInput,
    worker="run_studio_flow",
    queue=_queue_flow_tick,
    task_types={"flow.resume"},
    # 恢复本身是一次瞬时写入：任务建出来就是终态（prepare 里直接 transition 到
    # succeeded），真正的继续由 `resume_flow_input` 内部另起的 tick 完成。
    # 这里仍然声明分派，是为了两件事：① MCP 投影按 task_types 判「调不调得通」，
    # 不声明就永远列不出来；② 万一恢复路径上任务没走到终态，重新入队叫醒这条运行
    # 的 tick 正是该做的事，而不是没人管。
    resume="retry",
    output_schema={
        "type": "object",
        "required": ["run_id", "node_id"],
        "properties": {
            "run_id": {"type": "string"},
            "node_id": {"type": "string"},
        },
        "additionalProperties": True,
    },
)
async def _prepare_flow_resume(
    session: AsyncSession,
    *,
    tool_id: str,
    body: FlowResumeInput,
    parent_task_id: str | None,
    batch_id: str | None,
    source_route: str | None,
    source_context: dict[str, Any] | None,
) -> ToolExecutionResult:
    from domain import studio_flows

    run = await session.get(StudioFlowRun, body.run_id)
    if run is None:
        raise ToolExecutionError(f"DAG 运行不存在：{body.run_id}", status=404)
    try:
        await studio_flows.resume_flow_input(
            session,
            run,
            node_id=body.node_id,
            resume_value=body.resume_value,
        )
    except studio_flows.StudioFlowError as exc:
        raise ToolExecutionError(str(exc), status=exc.status) from exc
    task = new_task(
        tool_id=tool_id,
        task_type="flow.resume",
        parent_task_id=parent_task_id,
        batch_id=batch_id,
        source_route=source_route,
        source_context=dict(source_context or {}),
        invocation={"run_id": run.id, "node_id": body.node_id},
    )
    transition(task, "running", stage="flow_resume")
    transition(
        task,
        "succeeded",
        stage="flow_resumed",
        result={"run_id": run.id, "node_id": body.node_id},
    )
    session.add(task)
    return ToolExecutionResult(task)


async def start_tool_operation(
    session: AsyncSession,
    queue: QueueProvider,
    *,
    tool_id: str,
    operation: str,
    body: ToolOperationInput,
    parent_task_id: str | None = None,
    batch_id: str | None = None,
    source_route: str | None = None,
    source_context: dict[str, Any] | None = None,
    job_options: dict[str, Any] | None = None,
) -> ToolExecutionResult:
    """统一执行入口：校验、建领域任务、提交事务，再投递同一份 worker 快照。"""
    normalized = operation.strip().lower()
    _runtime_snapshot(tool_id, normalized)
    spec = require_operation(normalized)
    if not isinstance(body, spec.input):
        raise ToolExecutionError(f"能力与输入合同不匹配：{normalized}")
    result = await spec.prepare(
        session,
        tool_id=tool_id,
        body=body,
        parent_task_id=parent_task_id,
        batch_id=batch_id,
        source_route=source_route,
        source_context=source_context,
    )

    await session.commit()
    try:
        resolved_queue = await queue() if callable(queue) else queue
        await enqueue_task(resolved_queue, result.task, **dict(job_options or {}))
    except Exception as exc:
        await fail_queue(session, result.task, exc)
        if result.image_job_id is not None:
            image_job = await session.get(ImageJob, result.image_job_id)
            if image_job is not None:
                image_job.status = "failed"
                image_job.error = result.task.error
                await session.commit()
        raise ToolExecutionError(result.task.error or "任务入队失败", status=503) from exc
    await session.refresh(result.task)
    return result

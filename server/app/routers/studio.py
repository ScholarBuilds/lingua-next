"""创作工坊：画布与对话会话的持久化（模块 17 M1，FR-467/FR-470）。

工坊后端只做**编排与持久化**（BR-141）：这里全是 CRUD，出图一律走 /images 的
既有端点。两条与常规 CRUD 不同的约定：

- **内容乐观锁**：PUT 带 base_version，不匹配返回 409 且 body 里带最新全量，
  前端按 BR-145 合并后重存。HTTPException 的 detail 塞不进对象，409 用
  JSONResponse 手工拼。
- **meta 与内容分离**（BR-146）：PATCH …/meta 不刷 updated_at、不动 version，
  否则打个标签就把画布顶到列表最前。
- **删除留痕**：每次保存把消失的节点 id 记进 `deleted_nodes`，409 时按客户端的
  base_version 算出 `buried_nodes` 一并返回，让合并那一方分得清「别人删的」与
  「自己新建的」（判据见 domain/studio.nodes_deleted_after）。
"""

import json
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal
from urllib.parse import quote
from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import delete, func, select, update

from app.queue import get_queue
from app.routers.dict import SessionDep
from domain import (
    canvas_compile,
    canvas_loop,
    canvas_set,
    image_assets,
    image_describe,
    image_prompts,
    llm,
    runninghub_catalog,
    studio,
    studio_asset_storage,
    studio_assets,
    studio_frames,
    studio_gpt,
    studio_media_assets,
    studio_minimax,
    studio_prompts,
    studio_revisions,
    studio_templates,
    studio_tools,
    studio_workflows,
)
from domain.model_invocations import invocation_context
from domain.models import (
    ModelDeployment,
    ProviderCredential,
    StudioCanvas,
    StudioChat,
    StudioGptChat,
    StudioProject,
)
from domain.storage import StorageError
from domain.studio_tasks import task_view
from domain.tool_execution import (
    MidjourneyActionInput as ToolMidjourneyActionInput,
)
from domain.tool_execution import (
    MidjourneyGenerateInput as ToolMidjourneyGenerateInput,
)
from domain.tool_execution import (
    ToolExecutionError,
    parse_tool_operation_input,
    start_tool_operation,
)
from domain.tool_execution import (
    VideoRunInput as ToolVideoInput,
)
from domain.tool_execution import (
    WorkflowRunInput as ToolWorkflowInput,
)
from domain.tool_execution import (
    WorkflowRunParams as ToolWorkflowParams,
)
from domain.tool_plugins import require_tool_operation

router = APIRouter(prefix="/studio", tags=["studio"])

# 回收站保留期。超期条目在列表接口顺手物理清除，不另起定时任务
TRASH_TTL = timedelta(days=30)

# 与本仓其它 SSE 端点同一套：关缓存、关 nginx 缓冲，否则流式会被攒成一坨再吐
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def _now() -> datetime:
    return datetime.now(UTC)


# ---- 画布 ----


DEFAULT_PROJECT_ID = "default"
CANVAS_KINDS = {"classic", "smart"}


class ProjectCreateBody(BaseModel):
    name: str = Field(default="新项目", max_length=60)


class ProjectPatchBody(BaseModel):
    name: str | None = Field(default=None, max_length=60)
    sort: int | None = None


class CanvasCreateBody(BaseModel):
    title: str = Field(default="未命名画布", max_length=80)
    icon: str = Field(default="", max_length=32)
    kind: str = Field(default="smart", pattern="^(classic|smart)$")
    project: str = Field(default=DEFAULT_PROJECT_ID, max_length=48)
    board_x: float | None = None
    board_y: float | None = None


class CanvasSaveBody(BaseModel):
    nodes: list
    connections: list
    viewport: dict | None = None
    settings: dict | None = None
    base_version: int


class CanvasMetaBody(BaseModel):
    title: str | None = Field(default=None, max_length=80)
    icon: str | None = Field(default=None, max_length=32)
    color: str | None = Field(default=None, max_length=16)
    pinned: bool | None = None
    project: str | None = Field(default=None, max_length=48)
    owner: str | None = Field(default=None, max_length=40)
    board_x: float | None = None
    board_y: float | None = None


class CanvasCompileBody(BaseModel):
    """把画布编译成一次性 DAG 的入参。

    `nodes`/`connections` 可选：前端提交前会先在本地预演一遍（那一步会新建输出槽），
    所以带的是它当下的内存快照；定时触发与服务端重跑不带，直接用库里存的画布。
    """

    mode: Literal["cascade", "set"] = "cascade"
    nodes: list | None = None
    connections: list | None = None
    # 级联
    order: list[str] = Field(default_factory=list, max_length=400)
    edge_keys: list[str] = Field(default_factory=list, max_length=4000)
    loop_mode: Literal["serial", "parallel"] = "serial"
    total: int = Field(default=1, ge=1, le=999)
    vars: list[str] = Field(default_factory=list, max_length=200)
    loop_id: str | None = None
    # 下面三个不设范围：越界值由编译器按与前端同一条算式夹逼，422 只会让人白掉回本地
    parallel_limit: int | None = None
    rounds: list[int] | None = Field(default=None, max_length=999)
    loop_start: int | None = None
    image_input: bool = False
    image_batch_size: int | None = None
    retry_refs: dict[str, list[int]] = Field(default_factory=dict)
    retry_media: dict[str, list[dict]] = Field(default_factory=dict)
    #: 画布节点 → 轮次（字符串）→ 落点节点 id，前端预演时算好的
    targets: dict[str, dict[str, str]] = Field(default_factory=dict)
    #: 上面那批落点里这次新建、还没落库的，产物要带 planned_node
    pending_node_ids: list[str] = Field(default_factory=list, max_length=2000)
    start_id: str = Field(default="", max_length=120)
    # 成套
    plan: dict | None = None
    slots: list[str] = Field(default_factory=list, max_length=200)


class CanvasLlmMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=12_000)


class CanvasLlmBody(BaseModel):
    canvas_id: int
    node_id: str = Field(min_length=1, max_length=120)
    message: str = Field(min_length=1, max_length=12_000)
    system_prompt: str = Field(default="", max_length=8_000)
    messages: list[CanvasLlmMessage] = Field(default_factory=list, max_length=40)
    image_asset_ids: list[int] = Field(default_factory=list, max_length=4)
    video_media_asset_ids: list[int] = Field(default_factory=list, max_length=3)
    deployment_id: int | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)


def _project_view(row: StudioProject, canvas_count: int = 0) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "order": row.sort,
        "canvas_count": canvas_count,
        "created_at": row.created_at.isoformat() if row.created_at else "",
        "updated_at": row.updated_at.isoformat() if row.updated_at else "",
    }


async def _ensure_default_project(session) -> StudioProject:
    row = await session.get(StudioProject, DEFAULT_PROJECT_ID)
    if row is None:
        row = StudioProject(id=DEFAULT_PROJECT_ID, name="默认项目", sort=0)
        session.add(row)
        await session.flush()
    return row


async def _get_project(session, project_id: str) -> StudioProject:
    row = await session.get(StudioProject, project_id)
    if row is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    return row


@router.get("/projects")
async def list_projects(session: SessionDep) -> dict:
    await _ensure_default_project(session)
    rows = (
        (
            await session.execute(
                select(StudioProject).order_by(
                    StudioProject.sort.asc(), StudioProject.created_at.asc()
                )
            )
        )
        .scalars()
        .all()
    )
    counts = dict(
        (
            await session.execute(
                select(StudioCanvas.project, func.count(StudioCanvas.id))
                .where(StudioCanvas.deleted_at.is_(None))
                .group_by(StudioCanvas.project)
            )
        ).all()
    )
    await session.commit()
    return {"items": [_project_view(row, int(counts.get(row.id, 0))) for row in rows]}


@router.post("/projects", status_code=201)
async def create_project(body: ProjectCreateBody, session: SessionDep) -> dict:
    await _ensure_default_project(session)
    max_sort = await session.scalar(select(func.max(StudioProject.sort)))
    row = StudioProject(
        id=uuid4().hex,
        name=body.name.strip() or "新项目",
        sort=int(max_sort or 0) + 1,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _project_view(row)


@router.patch("/projects/{project_id}")
async def patch_project(project_id: str, body: ProjectPatchBody, session: SessionDep) -> dict:
    row = await _get_project(session, project_id)
    if body.name is not None:
        row.name = body.name.strip() or row.name or "未命名项目"
    if body.sort is not None:
        row.sort = body.sort
    row.updated_at = _now()
    await session.commit()
    return _project_view(row)


@router.delete("/projects/{project_id}")
async def delete_project(project_id: str, session: SessionDep) -> dict:
    if project_id == DEFAULT_PROJECT_ID:
        raise HTTPException(status_code=400, detail="默认项目不可删除")
    row = await _get_project(session, project_id)
    await _ensure_default_project(session)
    result = await session.execute(
        update(StudioCanvas)
        .where(StudioCanvas.project == project_id)
        .values(project=DEFAULT_PROJECT_ID)
    )
    await session.delete(row)
    await session.commit()
    return {"ok": True, "moved": int(result.rowcount or 0)}


async def _get_canvas(session, canvas_id: int, *, include_trashed: bool = False) -> StudioCanvas:
    row = await session.get(StudioCanvas, canvas_id)
    if row is None or (row.deleted_at is not None and not include_trashed):
        raise HTTPException(status_code=404, detail="画布不存在")
    return row


@router.get("/canvases")
async def list_canvases(session: SessionDep, trashed: int = 0, project: str | None = None) -> dict:
    # 超过保留期的物理清除。放在列表接口而不是定时任务：单用户应用，
    # 打开列表就是唯一稳定的清理时机
    await session.execute(delete(StudioCanvas).where(StudioCanvas.deleted_at < _now() - TRASH_TTL))
    await session.commit()
    query = select(StudioCanvas)
    if trashed:
        query = query.where(StudioCanvas.deleted_at.is_not(None)).order_by(
            StudioCanvas.deleted_at.desc()
        )
    else:
        query = query.where(StudioCanvas.deleted_at.is_(None)).order_by(
            StudioCanvas.pinned.desc(), StudioCanvas.updated_at.desc()
        )
    if project is not None:
        query = query.where(StudioCanvas.project == project)
    rows = (await session.execute(query)).scalars().all()
    return {"items": [studio.canvas_summary_view(r) for r in rows]}


@router.post("/canvases")
async def create_canvas(body: CanvasCreateBody, session: SessionDep) -> dict:
    # 自带一个空节点：空白画布对着一片点阵，用户不知道从哪下手（见 studio.starter_nodes）
    project = body.project.strip() or DEFAULT_PROJECT_ID
    if project == DEFAULT_PROJECT_ID:
        await _ensure_default_project(session)
    else:
        await _get_project(session, project)
    row = StudioCanvas(
        title=body.title or "未命名画布",
        icon=body.icon,
        kind=body.kind,
        project=project,
        board_x=body.board_x,
        board_y=body.board_y,
        nodes=studio.starter_nodes(f"n{uuid4().hex[:12]}"),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)  # server_default 的时间戳要读回来
    return studio.canvas_detail_view(row)


@router.get("/canvases/{canvas_id}")
async def get_canvas(canvas_id: int, session: SessionDep) -> dict:
    row = await _get_canvas(session, canvas_id)
    return studio.canvas_detail_view(row)


@router.put("/canvases/{canvas_id}")
async def save_canvas(canvas_id: int, body: CanvasSaveBody, session: SessionDep):
    row = await _get_canvas(session, canvas_id)
    # 这个客户端读到画布之后才被删掉的节点：它送上来的同 id 节点是旧副本，不是新建
    buried = studio.nodes_deleted_after(row.deleted_nodes, body.base_version)
    try:
        nodes, connections, viewport = studio.normalize_canvas_payload(
            body.nodes, body.connections, body.viewport, drop_ids=buried
        )
    except studio.StudioError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if body.base_version != row.version:
        # 409 要带最新全量给前端做 BR-145 合并；HTTPException 的 detail
        # 只能是字符串，塞不进 canvas 对象，手工拼 JSONResponse
        #
        # buried_nodes 是合并的必需品：前端合并完会以最新 version 重存，那一刻
        # base_version 已经被洗成最新的，服务端再也认不出这批节点是别人删掉的
        # 旧副本。只有 409 这一刻还分得清，名单必须在这里交出去
        return JSONResponse(
            status_code=409,
            content={
                "detail": f"画布已被其它端改过（当前 v{row.version}，你基于 v{body.base_version}）",
                "canvas": studio.canvas_detail_view(row),
                "buried_nodes": sorted(buried),
            },
        )
    next_version = row.version + 1
    # 这次载荷里消失的节点就是这次删掉的，记在新版本上：只有版本更旧的客户端才可能
    # 再把它们送回来，而它们的 base_version 一定小于这个数
    row.deleted_nodes = studio.record_node_deletions(
        row.deleted_nodes,
        before_ids=studio.node_ids(row.nodes),
        after_ids=studio.node_ids(nodes),
        version=next_version,
    )
    row.nodes = nodes
    row.connections = connections
    row.viewport = viewport
    if body.settings is not None:
        row.settings = body.settings
    row.version = next_version
    row.updated_at = _now()
    await session.commit()
    return {"version": row.version, "updated_at": row.updated_at.isoformat()}


@router.patch("/canvases/{canvas_id}/meta")
async def patch_canvas_meta(canvas_id: int, body: CanvasMetaBody, session: SessionDep) -> dict:
    row = await _get_canvas(session, canvas_id)
    if body.project is not None:
        await _get_project(session, body.project)
    for field in (
        "title",
        "icon",
        "color",
        "pinned",
        "project",
        "owner",
        "board_x",
        "board_y",
    ):
        value = getattr(body, field)
        if value is not None:
            setattr(row, field, value)
    # 不刷 updated_at、不动 version（BR-146）
    await session.commit()
    return {"ok": True}


def _dict_list(raw: Any) -> list[dict]:
    return [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []


async def _canvas_compile_lookups(
    session, doc: canvas_compile.CanvasDoc, order: list[str]
) -> canvas_compile.CompileLookups:
    """编译要用的三张表一次查完。凭据只取启用的——停用的挑出来等于提交必失败。"""
    by_id = doc.by_id()
    chain_nodes = [by_id[node_id] for node_id in order if node_id in by_id] or doc.nodes
    details: dict[int, dict] = {}
    for node in chain_nodes:
        if node.get("type") != "workflow":
            continue
        workflow_id = node.get("workflow_id")
        if not isinstance(workflow_id, int) or workflow_id in details:
            continue
        try:
            row = await studio_workflows.get_workflow(session, workflow_id)
        except studio_workflows.StudioWorkflowError:
            continue
        details[workflow_id] = studio_workflows.workflow_view(row, detail=True)

    credentials: list[dict] = []
    adapters: dict[int, str] = {}
    if details:
        stmt = (
            select(ProviderCredential)
            .where(ProviderCredential.kind == "workflow", ProviderCredential.enabled.is_(True))
            .order_by(ProviderCredential.id)
        )
        credentials = [
            {"id": row.id, "provider_type": row.provider_type}
            for row in (await session.execute(stmt)).scalars()
        ]
    if any(node.get("type") == "video" for node in chain_nodes):
        rows = (
            await session.execute(select(ModelDeployment).where(ModelDeployment.enabled.is_(True)))
        ).scalars()
        adapters = {row.id: row.adapter_type for row in rows}
    return canvas_compile.CompileLookups(
        workflow_details=details,
        workflow_credentials=credentials,
        deployment_adapters=adapters,
    )


@router.post("/canvases/{canvas_id}/compile")
async def compile_canvas(canvas_id: int, body: CanvasCompileBody, session: SessionDep) -> dict:
    """画布 → 一次性 DAG。前端提交级联/成套前先走这里，拿到的定义直接进 runInlineFlow。

    编译放服务端有三条硬理由：凭据能不能用只有这边说了算；同一份画布在两台机器上
    必须编出同一份定义；定时触发与服务端重跑根本没有浏览器。
    """
    row = await _get_canvas(session, canvas_id)
    doc = canvas_compile.CanvasDoc(
        nodes=_dict_list(body.nodes if body.nodes is not None else row.nodes),
        connections=_dict_list(
            body.connections if body.connections is not None else row.connections
        ),
        settings=row.settings or {},
    )
    try:
        if body.mode == "set":
            compiled = canvas_compile.compile_set_plan(
                doc, canvas_id, body.start_id, body.plan or {}, body.slots
            )
        else:
            schedule, _start, end_index, _batch = canvas_compile.loop_schedule(
                {
                    "count": body.total,
                    "loop_start": body.loop_start,
                    "image_input": body.image_input,
                    "image_batch_size": body.image_batch_size,
                }
            )
            ctx = canvas_compile.RunCtx(
                canvas_id=canvas_id,
                order=list(body.order),
                total=body.total,
                vars=[value for value in body.vars if value.strip() != ""],
                schedule=schedule,
                end_index=end_index,
                loop_id=body.loop_id,
                retry_refs=dict(body.retry_refs),
                retry_media={key: _dict_list(value) for key, value in body.retry_media.items()},
            )
            compiled = canvas_compile.compile_cascade(
                doc,
                canvas_compile.Chain(list(body.order), list(body.edge_keys)),
                ctx,
                body.loop_mode,
                body.parallel_limit,
                await _canvas_compile_lookups(session, doc, list(body.order)),
                rounds=body.rounds,
                targets=body.targets,
                pending=set(body.pending_node_ids),
            )
    except canvas_compile.CanvasCompileError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    source_context = dict(compiled.source_context)
    # 从链尾发起时前端知道真正的起点，服务端只能猜到 order 的末位
    if body.start_id != "":
        source_context["start_id"] = body.start_id
    return {"definition": compiled.definition, "source_context": source_context}


@router.post("/canvas-llm")
async def run_canvas_llm(body: CanvasLlmBody, session: SessionDep) -> dict:
    await _get_canvas(session, body.canvas_id)
    message = body.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="LLM 输入不能为空")
    messages: list[dict[str, str]] = []
    system = body.system_prompt.strip()
    if system:
        messages.append({"role": "system", "content": system})
    messages.extend(item.model_dump() for item in body.messages)
    if body.image_asset_ids or body.video_media_asset_ids:
        try:
            image_blocks = await studio_gpt.image_blocks(session, body.image_asset_ids)
            video_blocks = await studio_gpt.video_blocks(session, body.video_media_asset_ids)
        except (image_describe.DescribeError, StorageError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        messages.append(
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": message},
                    *image_blocks,
                    *video_blocks,
                ],
            }
        )
    else:
        messages.append({"role": "user", "content": message})
    try:
        with invocation_context(
            source="studio.canvas.llm",
            tool_id="infinite-canvas",
            canvas_id=body.canvas_id,
            node_id=body.node_id,
            source_route=f"/studio/canvas/{body.canvas_id}",
        ):
            text = await llm.complete_text(
                "chat-general",
                messages,
                body.temperature,
                deployment_id=body.deployment_id,
            )
    except llm.LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if not text.strip():
        raise HTTPException(status_code=502, detail="模型返回了空内容")
    return {"text": text}


@router.delete("/canvases/{canvas_id}")
async def trash_canvas(canvas_id: int, session: SessionDep) -> dict:
    row = await _get_canvas(session, canvas_id)
    row.deleted_at = _now()
    await session.commit()
    return {"ok": True}


@router.post("/canvases/{canvas_id}/restore")
async def restore_canvas(canvas_id: int, session: SessionDep) -> dict:
    row = await _get_canvas(session, canvas_id, include_trashed=True)
    row.deleted_at = None
    await session.commit()
    return {"ok": True}


@router.delete("/canvases/{canvas_id}/purge")
async def purge_canvas(canvas_id: int, session: SessionDep) -> dict:
    row = await _get_canvas(session, canvas_id, include_trashed=True)
    await session.delete(row)
    await session.commit()
    return {"ok": True}


# ---- 对话生图 ----


class ChatCreateBody(BaseModel):
    title: str = Field(default="未命名对话", max_length=80)


class ChatSaveBody(BaseModel):
    turns: list
    base_version: int


class ChatMetaBody(BaseModel):
    title: str | None = Field(default=None, max_length=80)
    pinned: bool | None = None


async def _get_chat(session, chat_id: int) -> StudioChat:
    row = await session.get(StudioChat, chat_id)
    if row is None:
        raise HTTPException(status_code=404, detail="对话不存在")
    return row


@router.get("/chats")
async def list_chats(session: SessionDep) -> dict:
    rows = (
        (
            await session.execute(
                select(StudioChat).order_by(StudioChat.pinned.desc(), StudioChat.updated_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return {"items": [studio.chat_summary_view(r) for r in rows]}


@router.post("/chats")
async def create_chat(body: ChatCreateBody, session: SessionDep) -> dict:
    row = StudioChat(title=body.title or "未命名对话")
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return studio.chat_detail_view(row)


@router.get("/chats/{chat_id}")
async def get_chat(chat_id: int, session: SessionDep) -> dict:
    row = await _get_chat(session, chat_id)
    return studio.chat_detail_view(row)


@router.put("/chats/{chat_id}")
async def save_chat(chat_id: int, body: ChatSaveBody, session: SessionDep):
    row = await _get_chat(session, chat_id)
    try:
        turns = studio.normalize_chat_turns(body.turns)
    except studio.StudioError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if body.base_version != row.version:
        return JSONResponse(
            status_code=409,
            content={
                "detail": f"对话已被其它端改过（当前 v{row.version}，你基于 v{body.base_version}）",
                "chat": studio.chat_detail_view(row),
            },
        )
    row.turns = turns
    row.version += 1
    row.updated_at = _now()
    await session.commit()
    return {"version": row.version, "updated_at": row.updated_at.isoformat()}


@router.patch("/chats/{chat_id}/meta")
async def patch_chat_meta(chat_id: int, body: ChatMetaBody, session: SessionDep) -> dict:
    row = await _get_chat(session, chat_id)
    if body.title is not None:
        row.title = body.title
    if body.pinned is not None:
        row.pinned = body.pinned
    await session.commit()
    return {"ok": True}


@router.delete("/chats/{chat_id}")
async def delete_chat(chat_id: int, session: SessionDep) -> dict:
    row = await _get_chat(session, chat_id)
    await session.delete(row)
    await session.commit()
    return {"ok": True}


# ---- 工坊目录（M2 FR-474） ----


@router.get("/catalog")
async def studio_catalog() -> dict:
    """工具的服务端常量：增强强度档与那句实话。

    提示词与文案都归服务端——它们是提示词工程产物，放前端就没法版本化也没法测。
    """
    return studio_tools.catalog_view()


# ---- 素材分组（M2 FR-477） ----


class GroupCreateBody(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    parent_id: int | None = None


class GroupPatchBody(BaseModel):
    name: str | None = Field(default=None, max_length=60)
    parent_id: int | None = None


class AssetMoveBody(BaseModel):
    # 空列表显式拒（min_length=1）：本仓有过「空 keys 当成全都要」跑掉一整批种子的事故，
    # 「一个都没选」和「全选」必须在入口就分开
    asset_ids: list[int] = Field(min_length=1, max_length=200)
    group_id: int | None = None


class AssetTagBody(BaseModel):
    asset_ids: list[int] = Field(min_length=1, max_length=200)


class AssetTagSettingsBody(BaseModel):
    deployment_id: int | None = Field(default=None, gt=0)
    caption_prompt: str = Field(min_length=1, max_length=4000)
    classification_prompt: str = Field(min_length=1, max_length=4000)
    user_prompt: str = Field(min_length=1, max_length=1000)


class AssetStoragePrefixesBody(BaseModel):
    generated: str = Field(min_length=1, max_length=200)
    upload: str = Field(min_length=1, max_length=200)
    local: str = Field(min_length=1, max_length=200)


class AssetStoragePurgeBody(BaseModel):
    asset_ids: list[int] = Field(min_length=1, max_length=200)


class ImportItemBody(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    name: str | None = Field(default=None, max_length=120)


class ImportUrlsBody(BaseModel):
    items: list[ImportItemBody] = Field(min_length=1, max_length=50)
    group_id: int | None = None
    auto_tag: bool = False


def _asset_error(exc: studio_assets.StudioAssetError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=str(exc))


@router.get("/asset-groups")
async def list_asset_groups(session: SessionDep) -> dict:
    return {"items": await studio_assets.list_groups(session)}


@router.post("/asset-groups", status_code=201)
async def create_asset_group(body: GroupCreateBody, session: SessionDep) -> dict:
    try:
        return await studio_assets.create_group(session, name=body.name, parent_id=body.parent_id)
    except studio_assets.StudioAssetError as exc:
        raise _asset_error(exc) from exc


@router.patch("/asset-groups/{group_id}")
async def patch_asset_group(group_id: int, body: GroupPatchBody, session: SessionDep) -> dict:
    # parent_id 要能被显式置 null（挪回顶级），所以「没传」与「传了 null」必须分开，
    # 靠 model_fields_set 判——只看值的话，改个名就会顺手把组挪到顶级
    try:
        return await studio_assets.patch_group(
            session,
            group_id,
            name=body.name,
            parent_id=body.parent_id,
            move_parent="parent_id" in body.model_fields_set,
        )
    except studio_assets.StudioAssetError as exc:
        raise _asset_error(exc) from exc


@router.delete("/asset-groups/{group_id}")
async def delete_asset_group(group_id: int, session: SessionDep) -> dict:
    """删组只解除归属，**不删资产**——图归模块 16 管（BR-140）。"""
    try:
        released = await studio_assets.delete_group(session, group_id)
    except studio_assets.StudioAssetError as exc:
        raise _asset_error(exc) from exc
    return {"ok": True, "released": released}


@router.post("/assets/move")
async def move_assets(body: AssetMoveBody, session: SessionDep) -> dict:
    try:
        moved = await studio_assets.move_assets(session, body.asset_ids, body.group_id)
    except studio_assets.StudioAssetError as exc:
        raise _asset_error(exc) from exc
    return {"moved": moved}


@router.post("/assets/tag")
async def tag_assets(body: AssetTagBody, session: SessionDep) -> dict:
    """同步跑完再返回。逐条独立，一条失败只写它自己的 error（BR-110 原文回报）。"""
    return {"items": await studio_assets.tag_assets(session, body.asset_ids)}


@router.get("/assets/settings")
async def get_asset_settings(session: SessionDep) -> dict:
    """素材反推与分类规则。模型留空时沿用 explain-standard 能力绑定。"""
    return await studio_assets.get_tag_settings(session)


@router.put("/assets/settings")
async def put_asset_settings(body: AssetTagSettingsBody, session: SessionDep) -> dict:
    if body.deployment_id is not None:
        deployment = await session.get(ModelDeployment, body.deployment_id)
        if deployment is None:
            raise HTTPException(status_code=404, detail="模型部署不存在")
        if not deployment.enabled:
            raise HTTPException(status_code=400, detail="所选模型部署已停用")
        if deployment.media_types and "chat" not in deployment.media_types:
            raise HTTPException(status_code=400, detail="所选模型不支持 Chat/视觉描述")
    return await studio_assets.save_tag_settings(session, body.model_dump())


@router.get("/assets/storage")
async def get_asset_storage(session: SessionDep) -> dict:
    """三类逻辑目录、实际占用与可安全物理清理的归档素材。"""
    return await studio_asset_storage.overview(session)


@router.put("/assets/storage-prefixes")
async def put_asset_storage_prefixes(body: AssetStoragePrefixesBody, session: SessionDep) -> dict:
    try:
        prefixes = await image_assets.save_storage_prefixes(session, body.model_dump())
    except image_assets.ImageAssetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"prefixes": prefixes}


@router.post("/assets/storage/purge")
async def purge_asset_storage(body: AssetStoragePurgeBody, session: SessionDep) -> dict:
    try:
        return await studio_asset_storage.purge(session, body.asset_ids)
    except studio_asset_storage.AssetStorageError as exc:
        detail: str | dict = str(exc)
        if exc.blocked:
            detail = {"message": str(exc), "blocked": exc.blocked}
        raise HTTPException(status_code=exc.status, detail=detail) from exc


@router.post("/assets/import-urls")
async def import_urls(body: ImportUrlsBody, session: SessionDep) -> dict:
    try:
        items = await studio_assets.import_urls(
            session,
            [item.model_dump() for item in body.items],
            group_id=body.group_id,
            auto_tag=body.auto_tag,
        )
    except studio_assets.StudioAssetError as exc:
        raise _asset_error(exc) from exc
    return {"items": items}


# ---- 提示词库（M3 FR-478） ----


class PromptGroupCreateBody(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    parent_id: int | None = None


class PromptGroupPatchBody(BaseModel):
    name: str | None = Field(default=None, max_length=60)
    parent_id: int | None = None


class PromptVariableBody(BaseModel):
    """一个模板变量的说明。名字不在这里定——它由正文里的 `{{name}}` 占位派生，
    这份声明只带人写的标签、说明、默认值和是否必填。"""

    name: str = Field(min_length=1, max_length=40)
    label: str = Field(default="", max_length=60)
    description: str = Field(default="", max_length=200)
    default: str = Field(default="", max_length=500)
    required: bool = True


class PromptCreateBody(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=8000)
    negative: str = Field(default="", max_length=4000)
    scene: str = Field(default="", max_length=200)
    group_id: int | None = None
    variables: list[PromptVariableBody] | None = None


class PromptPatchBody(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    body: str | None = Field(default=None, min_length=1, max_length=8000)
    negative: str | None = Field(default=None, max_length=4000)
    scene: str | None = Field(default=None, max_length=200)
    favorite: bool | None = None
    group_id: int | None = None
    variables: list[PromptVariableBody] | None = None
    # 这一次改动的一句话备注，写进版本链。留空就只记时间
    note: str | None = Field(default=None, max_length=200)
    # 内置条目唯一放行的字段：收起来不再出现（可逆）。自建条目不认这个字段——
    # 不想看见自建条目就删掉或挪个分组，不需要第三种状态
    hidden: bool | None = None


class PromptRenderBody(BaseModel):
    values: dict[str, str] = Field(default_factory=dict)


class PromptComposeBody(BaseModel):
    """让 AI 写一条提示词。**产出不入库**，落进编辑器供人改完再存。

    同一个端点服务两种入口：提示词库里的「AI 写一条」（给 intent）、
    各工具提示词框旁的「AI 扩写」（给 draft，mode=expand）。两边各写一份的话，
    同一条链路会出现两套系统提示词与两种产出形状。
    """

    #: 想要什么。扩写时可以留空——原稿本身就说明了要什么
    intent: str = Field(default="", max_length=studio_prompts.MAX_INTENT)
    #: 已有的正向原稿。给了它默认按扩写算
    draft: str = Field(default="", max_length=studio_prompts.MAX_COMPOSE_DRAFT)
    negative: str = Field(default="", max_length=studio_prompts.MAX_COMPOSE_DRAFT)
    mode: Literal["create", "expand", "polish"] = "create"
    #: 正文语种。生图模型对英文提示词普遍更准，默认英文
    language: Literal["en", "zh"] = "en"
    with_negative: bool = True
    #: 要不要让模型在正文里留 {{占位}}。默认不留：多数时候用户要的是一条能直接用的
    with_variables: bool = False
    #: 本轮显式指定部署；留空跟随 chat-general 的能力绑定
    deployment_id: int | None = None


class RevisionPinBody(BaseModel):
    pinned: bool


def _prompt_error(exc: studio_prompts.StudioPromptError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=str(exc))


def _revision_error(exc: studio_revisions.StudioRevisionError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=str(exc))


@router.get("/prompt-groups")
async def list_prompt_groups(session: SessionDep) -> dict:
    return {"items": await studio_prompts.list_groups(session)}


@router.post("/prompt-groups", status_code=201)
async def create_prompt_group(body: PromptGroupCreateBody, session: SessionDep) -> dict:
    try:
        return await studio_prompts.create_group(session, name=body.name, parent_id=body.parent_id)
    except studio_prompts.StudioPromptError as exc:
        raise _prompt_error(exc) from exc


@router.patch("/prompt-groups/{group_id}")
async def patch_prompt_group(
    group_id: int, body: PromptGroupPatchBody, session: SessionDep
) -> dict:
    # parent_id 要能被显式置 null（挪回顶级），「没传」与「传了 null」必须分开，
    # 靠 model_fields_set 判——只看值的话，改个名就会顺手把组挪到顶级
    try:
        return await studio_prompts.patch_group(
            session,
            group_id,
            name=body.name,
            parent_id=body.parent_id,
            move_parent="parent_id" in body.model_fields_set,
        )
    except studio_prompts.StudioPromptError as exc:
        raise _prompt_error(exc) from exc


@router.delete("/prompt-groups/{group_id}")
async def delete_prompt_group(group_id: int, session: SessionDep) -> dict:
    """删组只解除归属，条目退回未归组——与素材分组同一条口径。"""
    try:
        released = await studio_prompts.delete_group(session, group_id)
    except studio_prompts.StudioPromptError as exc:
        raise _prompt_error(exc) from exc
    return {"ok": True, "released": released}


@router.get("/prompts")
async def list_prompts(
    session: SessionDep,
    group_id: int | None = None,
    q: str | None = None,
    favorite: bool | None = None,
    builtin: bool | None = None,
    category: str | None = None,
    include_hidden: bool = False,
) -> dict:
    """`include_hidden` 只给提示词库自己用：别处默认拿不到被隐藏的内置模板，
    否则每个消费方都要记得过滤一次，漏一处隐藏就等于没生效。"""
    items = await studio_prompts.list_prompts(
        session,
        group_id=group_id,
        q=q,
        favorite=favorite,
        builtin=builtin,
        category=category,
        include_hidden=include_hidden,
    )
    return {"items": items, "categories": studio_prompts.category_catalog()}


@router.post("/prompts/compose")
async def compose_prompt(body: PromptComposeBody) -> dict:
    """AI 写一条提示词草稿。**这个端点一个字都不写库**——产出回给前端落编辑器。

    路径放在 `/prompts/compose` 而不是 `/prompts/{id}/…`：它不属于任何一条既有条目，
    新建时根本还没有 id。与 `/prompts/{prompt_id}` 不冲突，因为那条路径的 id 是 int，
    `compose` 解析不成 int 会被 FastAPI 拒掉——但静态路径声明在动态路径之前才稳妥。
    """
    try:
        with invocation_context(
            source="studio.prompt.compose",
            source_route="/studio/prompts",
        ):
            return await studio_prompts.compose_prompt(
                intent=body.intent,
                draft=body.draft,
                negative=body.negative,
                mode=body.mode,
                language=body.language,
                with_negative=body.with_negative,
                with_variables=body.with_variables,
                deployment_id=body.deployment_id,
            )
    except llm.LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except studio_prompts.StudioPromptError as exc:
        raise _prompt_error(exc) from exc


@router.post("/prompts", status_code=201)
async def create_prompt(body: PromptCreateBody, session: SessionDep) -> dict:
    try:
        return await studio_prompts.create_prompt(
            session,
            title=body.title,
            body=body.body,
            negative=body.negative,
            scene=body.scene,
            group_id=body.group_id,
            variables=None if body.variables is None else [v.model_dump() for v in body.variables],
        )
    except studio_prompts.StudioPromptError as exc:
        raise _prompt_error(exc) from exc


@router.patch("/prompts/{prompt_id}")
async def patch_prompt(prompt_id: int, body: PromptPatchBody, session: SessionDep) -> dict:
    """内置条目（负数 id）除了 `hidden` 一律 400，并直说该先 fork。"""
    try:
        return await studio_prompts.patch_prompt(
            session,
            prompt_id,
            title=body.title,
            body=body.body,
            negative=body.negative,
            scene=body.scene,
            favorite=body.favorite,
            group_id=body.group_id,
            move_group="group_id" in body.model_fields_set,
            variables=None if body.variables is None else [v.model_dump() for v in body.variables],
            note=body.note,
            hidden=body.hidden,
        )
    except studio_prompts.StudioPromptError as exc:
        raise _prompt_error(exc) from exc


@router.delete("/prompts/{prompt_id}")
async def delete_prompt(prompt_id: int, session: SessionDep) -> dict:
    try:
        await studio_prompts.delete_prompt(session, prompt_id)
    except studio_prompts.StudioPromptError as exc:
        raise _prompt_error(exc) from exc
    return {"ok": True}


@router.post("/prompts/{prompt_id}/fork", status_code=201)
async def fork_prompt(prompt_id: int, session: SessionDep) -> dict:
    """把内置模板复制成一条可改的自建条目。"""
    try:
        return await studio_prompts.fork_prompt(session, prompt_id)
    except studio_prompts.StudioPromptError as exc:
        raise _prompt_error(exc) from exc


@router.post("/prompts/{prompt_id}/use")
async def use_prompt(prompt_id: int, session: SessionDep) -> dict:
    try:
        used = await studio_prompts.use_prompt(session, prompt_id)
    except studio_prompts.StudioPromptError as exc:
        raise _prompt_error(exc) from exc
    return {"ok": True, "used_count": used}


@router.post("/prompts/{prompt_id}/render")
async def fill_prompt_variables(
    prompt_id: int, body: PromptRenderBody, session: SessionDep
) -> dict:
    """把变量值填进正文。缺必填变量返回 400 并点名是哪几个——
    这一步的意义就是不让 `{{name}}` 原样发到模型那边去。"""
    try:
        return await studio_prompts.render_by_id(session, prompt_id, body.values)
    except studio_prompts.StudioPromptError as exc:
        raise _prompt_error(exc) from exc


@router.get("/prompts/{prompt_id}/revisions")
async def list_prompt_revisions(prompt_id: int, session: SessionDep) -> dict:
    try:
        items = await studio_prompts.list_prompt_revisions(session, prompt_id)
    except studio_prompts.StudioPromptError as exc:
        raise _prompt_error(exc) from exc
    return {"items": items, "keep_recent": studio_revisions.KEEP_RECENT}


@router.post("/prompts/{prompt_id}/revisions/{version}/restore")
async def restore_prompt(prompt_id: int, version: int, session: SessionDep) -> dict:
    try:
        return await studio_prompts.restore_prompt(session, prompt_id, version)
    except studio_prompts.StudioPromptError as exc:
        raise _prompt_error(exc) from exc
    except studio_revisions.StudioRevisionError as exc:
        raise _revision_error(exc) from exc


@router.patch("/prompts/{prompt_id}/revisions/{version}")
async def pin_prompt_revision(
    prompt_id: int, version: int, body: RevisionPinBody, session: SessionDep
) -> dict:
    """标记 / 取消「保留这一版」。标记过的不参与保留窗口的裁剪。"""
    try:
        return await studio_prompts.pin_prompt_revision(session, prompt_id, version, body.pinned)
    except studio_prompts.StudioPromptError as exc:
        raise _prompt_error(exc) from exc
    except studio_revisions.StudioRevisionError as exc:
        raise _revision_error(exc) from exc


# ---- GPT 创作对话（M3 FR-476） ----


class GptChatCreateBody(BaseModel):
    title: str = Field(default="未命名对话", max_length=80)
    system_prompt: str = Field(default="", max_length=4000)


class GptChatMetaBody(BaseModel):
    title: str | None = Field(default=None, max_length=80)
    pinned: bool | None = None
    system_prompt: str | None = Field(default=None, max_length=4000)


class GptSendBody(BaseModel):
    # 只带附件也是源项目的合法互动；文本和附件都空才拒绝。
    text: str = Field(default="", max_length=studio_gpt.MAX_TURN_CHARS)
    # 不带图是常态（纯聊天），所以默认空列表；带了就有张数上限——
    # data URL 是整段塞进请求体的
    image_asset_ids: list[int] = Field(default_factory=list, max_length=studio_gpt.MAX_INPUT_IMAGES)
    media_asset_ids: list[int] = Field(default_factory=list, max_length=studio_gpt.MAX_INPUT_FILES)
    # 源项目的画幅控件是每轮参数；不依赖模型在工具参数里自己猜。
    image_size: str = studio_gpt.DEFAULT_SIZE
    # 本轮显式选择；留空则跟随 chat-general / image-free 能力绑定。
    chat_deployment_id: int | None = Field(default=None, ge=1)
    image_deployment_id: int | None = Field(default=None, ge=1)

    @field_validator("image_size")
    @classmethod
    def validate_image_size(cls, value: str) -> str:
        try:
            return image_prompts.validate_size(value)
        except image_prompts.PromptError as exc:
            raise ValueError(str(exc)) from exc

    @model_validator(mode="after")
    def validate_attachment_count(self):
        count = len(self.image_asset_ids) + len(self.media_asset_ids)
        if not self.text.strip() and count == 0:
            raise ValueError("文本和附件不能同时为空")
        if count > studio_gpt.MAX_INPUT_ATTACHMENTS:
            raise ValueError(f"一轮最多携带 {studio_gpt.MAX_INPUT_ATTACHMENTS} 个附件")
        return self


async def _get_gpt_chat(session, chat_id: int) -> StudioGptChat:
    row = await session.get(StudioGptChat, chat_id)
    if row is None:
        raise HTTPException(status_code=404, detail="对话不存在")
    return row


def _sse(event_type: str, payload: dict) -> str:
    return f"data: {json.dumps({'type': event_type, **payload}, ensure_ascii=False)}\n\n"


@router.get("/gpt-chats")
async def list_gpt_chats(session: SessionDep) -> dict:
    rows = (
        (
            await session.execute(
                select(StudioGptChat).order_by(
                    StudioGptChat.pinned.desc(), StudioGptChat.updated_at.desc()
                )
            )
        )
        .scalars()
        .all()
    )
    return {"items": [studio_gpt.chat_summary_view(r) for r in rows]}


@router.post("/gpt-chats")
async def create_gpt_chat(body: GptChatCreateBody, session: SessionDep) -> dict:
    row = StudioGptChat(title=body.title or "未命名对话", system_prompt=body.system_prompt or "")
    session.add(row)
    await session.commit()
    await session.refresh(row)  # server_default 的时间戳要读回来
    return studio_gpt.chat_detail_view(row)


@router.get("/gpt-chats/{chat_id}")
async def get_gpt_chat(chat_id: int, session: SessionDep) -> dict:
    row = await _get_gpt_chat(session, chat_id)
    return studio_gpt.chat_detail_view(row)


@router.patch("/gpt-chats/{chat_id}/meta")
async def patch_gpt_chat_meta(chat_id: int, body: GptChatMetaBody, session: SessionDep) -> dict:
    row = await _get_gpt_chat(session, chat_id)
    for name in ("title", "pinned", "system_prompt"):
        value = getattr(body, name)
        if value is not None:
            setattr(row, name, value)
    # 不刷 updated_at、不动 version（BR-146）：改个系统提示词不该把会话顶到最前
    await session.commit()
    return {"ok": True}


@router.delete("/gpt-chats/{chat_id}")
async def delete_gpt_chat(chat_id: int, session: SessionDep) -> dict:
    row = await _get_gpt_chat(session, chat_id)
    await session.delete(row)
    await session.commit()
    return {"ok": True}


@router.post("/gpt-chats/{chat_id}/send")
async def send_gpt_turn(chat_id: int, body: GptSendBody, session: SessionDep) -> StreamingResponse:
    """发一轮并流式回读。编排全在 domain/studio_gpt，这里只把事件拍成 SSE 帧。

    失败不走 HTTP 状态码：流一旦开始就没法改状态行了，而这一轮很可能已经出了图。
    所以错误当作 `error` 事件推下去，`done` 里带的是真正落库的那一轮。
    """
    chat = await _get_gpt_chat(session, chat_id)

    async def events() -> AsyncGenerator[str, None]:
        async for event_type, payload in studio_gpt.stream_turn(
            session,
            chat,
            body.text,
            body.image_asset_ids,
            body.media_asset_ids,
            chat_deployment_id=body.chat_deployment_id,
            image_deployment_id=body.image_deployment_id,
            image_size=body.image_size,
        ):
            yield _sse(event_type, payload)

    return StreamingResponse(events(), media_type="text/event-stream", headers=SSE_HEADERS)


# ---- 工作流模板（M4 FR-482） ----


class TemplateSaveBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    note: str = Field(default="", max_length=2000)
    # 空子图存了没意义，入口就拒——存下来只会在列表里占一行「0 个节点」的坑
    nodes: list = Field(min_length=1)
    connections: list = Field(default_factory=list)
    # 资产化入口会把原始图片/视频/音频写进对象存储中的 portable ZIP；普通模板仍可
    # 只存指纹，以保持旧调用的轻量行为。
    include_resources: bool = False


class TemplateRenameBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class TemplateBatchDownloadBody(BaseModel):
    ids: list[Annotated[int, Field(strict=True, ge=1)]] = Field(
        min_length=1,
        max_length=studio_templates.MAX_LIBRARY_DOWNLOADS,
    )


class TemplateApplyBody(BaseModel):
    """导入落点。服务端不知道当前画布上已经有什么（apply 不带画布 id），
    默认把子图整体挪到一个固定落点；前端知道现有节点在哪，可以自己挑。"""

    offset_x: float = studio_templates.APPLY_ORIGIN_X
    offset_y: float = studio_templates.APPLY_ORIGIN_Y


def _template_error(exc: studio_templates.StudioTemplateError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=str(exc))


@router.get("/templates")
async def list_templates(session: SessionDep) -> dict:
    return {"items": await studio_templates.list_templates(session)}


@router.post("/templates", status_code=201)
async def save_template(body: TemplateSaveBody, session: SessionDep) -> dict:
    """把画布上选中的子图存成模板：节点里的 asset_id 换成 sha256，**字节不进库**。"""
    try:
        return await studio_templates.save_template(
            session,
            name=body.name,
            note=body.note,
            nodes=body.nodes,
            connections=body.connections,
            include_resources=body.include_resources,
        )
    except studio_templates.StudioTemplateError as exc:
        raise _template_error(exc) from exc


@router.post("/templates/{template_id}/apply")
async def apply_template(template_id: int, body: TemplateApplyBody, session: SessionDep) -> dict:
    """按 sha256 反查资产：在库就复用，不在库照实标缺失（`rebuilt` 恒 0，BR-110）。"""
    try:
        return await studio_templates.apply_template(
            session, template_id, offset_x=body.offset_x, offset_y=body.offset_y
        )
    except studio_templates.StudioTemplateError as exc:
        raise _template_error(exc) from exc


@router.post("/templates/import", status_code=201)
async def import_template(
    session: SessionDep,
    file: Annotated[UploadFile, File()],
) -> dict:
    from domain import studio_canvas_workflows

    raw = await file.read(studio_canvas_workflows.MAX_IMPORT_BYTES + 1)
    try:
        return await studio_templates.import_template_package(
            session,
            raw=raw,
            filename=file.filename or "workflow.json",
        )
    except studio_templates.StudioTemplateError as exc:
        raise _template_error(exc) from exc


@router.post("/templates/{template_id}/download", response_model=None)
async def download_template(template_id: int, session: SessionDep):
    try:
        data, filename = await studio_templates.template_package(session, template_id)
    except studio_templates.StudioTemplateError as exc:
        raise _template_error(exc) from exc
    headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"}
    return Response(data, media_type="application/zip", headers=headers)


@router.post("/templates/download", response_model=None)
async def download_templates(body: TemplateBatchDownloadBody, session: SessionDep):
    try:
        data = await studio_templates.template_packages_archive(session, body.ids)
    except studio_templates.StudioTemplateError as exc:
        raise _template_error(exc) from exc
    headers = {"Content-Disposition": "attachment; filename*=UTF-8''workflows.zip"}
    return Response(data, media_type="application/zip", headers=headers)


@router.patch("/templates/{template_id}")
async def rename_template(
    template_id: int,
    body: TemplateRenameBody,
    session: SessionDep,
) -> dict:
    try:
        return await studio_templates.rename_template(
            session,
            template_id,
            name=body.name,
        )
    except studio_templates.StudioTemplateError as exc:
        raise _template_error(exc) from exc


@router.delete("/templates/{template_id}")
async def delete_template(template_id: int, session: SessionDep) -> dict:
    try:
        await studio_templates.delete_template(session, template_id)
    except studio_templates.StudioTemplateError as exc:
        raise _template_error(exc) from exc
    return {"ok": True}


# ---- 可执行工作流目录（ST-15） ----


class WorkflowImportBody(BaseModel):
    """裸节点图与导出物走同一个入口。

    `payload` 传导出物整包时，供应商 / 类型 / 输入映射一律以导出物为准；
    `title` 留空就沿用导出物里的名字，所以它这里不设最小长度。
    """

    title: str = Field(default="", max_length=160)
    provider: str = "comfyui"
    kind: str = "workflow"
    payload: dict
    ui_schema: dict | None = None


class WorkflowPatchBody(BaseModel):
    enabled: bool | None = None
    title: str | None = Field(default=None, min_length=1, max_length=160)
    ui_schema: dict | None = None
    note: str | None = Field(default=None, max_length=200)


class WorkflowRunBody(ToolWorkflowParams):
    """workflow_id 来自路径参数，其余字段与统一入口的合同一致。"""

    source_route: str | None = Field(default="/studio/workflows", max_length=512)
    source_context: dict[str, object] | None = None


class RunningHubRemoteBody(BaseModel):
    credential_id: int
    kind: Literal["model", "app", "workflow"]
    source_id: str = Field(min_length=1, max_length=255)
    title: str | None = Field(default=None, max_length=160)
    description: str | None = Field(default=None, max_length=500)
    ui_schema: dict | None = None


class VideoRunBody(ToolVideoInput):
    source_route: str | None = Field(default="/studio/video", max_length=512)
    source_context: dict[str, object] | None = None


class MidjourneyRunBody(ToolMidjourneyGenerateInput):
    source_route: str | None = Field(default="/studio/canvas", max_length=512)
    source_context: dict[str, object] | None = None


class MidjourneyActionBody(ToolMidjourneyActionInput):
    source_route: str | None = Field(default="/studio/canvas", max_length=512)
    source_context: dict[str, object] | None = None


class ToolRunBody(BaseModel):
    operation: str = Field(min_length=1, max_length=64)
    input: dict[str, object]
    source_route: str | None = Field(default=None, max_length=512)
    source_context: dict[str, object] | None = None


class MiniMaxExportClipBody(BaseModel):
    media_asset_id: int = Field(gt=0)
    start: float = Field(default=0, ge=0, le=3600)
    end: float = Field(default=0, ge=0, le=3600)
    duration: float = Field(default=0, ge=0, le=3600)


class MiniMaxExportBody(BaseModel):
    clips: list[MiniMaxExportClipBody] = Field(min_length=1, max_length=100)
    filename: str = Field(default="minimax-timeline.mp4", max_length=160)


def _workflow_error(exc: studio_workflows.StudioWorkflowError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=str(exc))


async def _start_workflow_tool(
    session,
    *,
    tool_id: str,
    body: ToolWorkflowInput,
    source_route: str | None,
    source_context: dict[str, object] | None,
) -> dict:
    try:
        result = await start_tool_operation(
            session,
            get_queue,
            tool_id=tool_id,
            operation="workflow.run",
            body=body,
            source_route=source_route,
            source_context=source_context,
        )
    except ToolExecutionError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    return task_view(result.task)


async def _start_video_tool(
    session,
    *,
    tool_id: str,
    body: ToolVideoInput,
    source_route: str | None,
    source_context: dict[str, object] | None,
) -> dict:
    try:
        result = await start_tool_operation(
            session,
            get_queue,
            tool_id=tool_id,
            operation="video.generate",
            body=body,
            source_route=source_route,
            source_context=source_context,
        )
    except ToolExecutionError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    return task_view(result.task)


@router.post("/tools/{tool_id}/runs", status_code=202)
async def run_tool(
    tool_id: str,
    body: ToolRunBody,
    session: SessionDep,
) -> dict:
    """REST、Agent、画布和工作流节点共用的 schema-first 执行入口。"""
    operation = body.operation.strip().lower()
    try:
        require_tool_operation(tool_id, operation)
        operation_body = parse_tool_operation_input(operation, body.input)
        route_defaults = {
            "midjourney.generate": "/studio/canvas",
            "midjourney.action": "/studio/canvas",
            "workflow.run": "/studio/workflows",
            "video.generate": "/studio/video",
            "image.generate": "/image",
            "image.edit": "/image/image_to_image",
        }
        result = await start_tool_operation(
            session,
            get_queue,
            tool_id=tool_id,
            operation=operation,
            body=operation_body,
            source_route=body.source_route or route_defaults.get(operation),
            source_context=body.source_context,
        )
    except ToolExecutionError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    response = task_view(result.task)
    if result.image_job_id is not None:
        response["image_job_id"] = result.image_job_id
    return response


@router.get("/workflows")
async def list_workflows(
    session: SessionDep,
    provider: str | None = None,
    kind: str | None = None,
    enabled: bool | None = None,
) -> dict:
    try:
        items = await studio_workflows.list_workflows(
            session, provider=provider, kind=kind, enabled=enabled
        )
    except studio_workflows.StudioWorkflowError as exc:
        raise _workflow_error(exc) from exc
    return {"items": items}


@router.get("/runninghub/diagnostics")
async def runninghub_diagnostics(credential_id: int, session: SessionDep) -> dict:
    try:
        _row, config = await runninghub_catalog.credential_config(session, credential_id)
        return await runninghub_catalog.diagnostics(config)
    except studio_workflows.StudioWorkflowError as exc:
        raise _workflow_error(exc) from exc


@router.get("/runninghub/models")
async def runninghub_models(credential_id: int, session: SessionDep) -> dict:
    try:
        _row, config = await runninghub_catalog.credential_config(session, credential_id)
        return {"items": await runninghub_catalog.fetch_models(config)}
    except studio_workflows.StudioWorkflowError as exc:
        raise _workflow_error(exc) from exc


@router.post("/runninghub/remote/preview")
async def preview_runninghub_remote(body: RunningHubRemoteBody, session: SessionDep) -> dict:
    try:
        _row, config = await runninghub_catalog.credential_config(session, body.credential_id)
        return await runninghub_catalog.remote_definition(config, body.kind, body.source_id)
    except studio_workflows.StudioWorkflowError as exc:
        raise _workflow_error(exc) from exc


@router.post("/runninghub/remote/sync")
async def sync_runninghub_remote(body: RunningHubRemoteBody, session: SessionDep) -> dict:
    try:
        _row, config = await runninghub_catalog.credential_config(session, body.credential_id)
        definition = await runninghub_catalog.remote_definition(config, body.kind, body.source_id)
        row = await runninghub_catalog.upsert_remote(
            session,
            definition=definition,
            title=body.title,
            description=body.description,
            ui_schema=body.ui_schema,
        )
    except studio_workflows.StudioWorkflowError as exc:
        raise _workflow_error(exc) from exc
    return studio_workflows.workflow_view(row, detail=True)


@router.get("/workflows/{workflow_id}")
async def get_workflow(workflow_id: int, session: SessionDep) -> dict:
    try:
        row = await studio_workflows.get_workflow(session, workflow_id)
    except studio_workflows.StudioWorkflowError as exc:
        raise _workflow_error(exc) from exc
    return studio_workflows.workflow_view(row, detail=True)


@router.post("/workflows", status_code=201)
async def import_workflow(body: WorkflowImportBody, session: SessionDep) -> dict:
    try:
        row = await studio_workflows.import_workflow(
            session,
            title=body.title,
            provider=body.provider,
            kind=body.kind,
            payload=body.payload,
            ui_schema=body.ui_schema,
        )
    except studio_workflows.StudioWorkflowError as exc:
        raise _workflow_error(exc) from exc
    return studio_workflows.workflow_view(row, detail=True)


@router.patch("/workflows/{workflow_id}")
async def patch_workflow(workflow_id: int, body: WorkflowPatchBody, session: SessionDep) -> dict:
    try:
        row = await studio_workflows.get_workflow(session, workflow_id)
    except studio_workflows.StudioWorkflowError as exc:
        raise _workflow_error(exc) from exc
    definition_fields = {"title", "ui_schema"} & body.model_fields_set
    try:
        row = await studio_workflows.update_workflow(
            session,
            row,
            enabled=body.enabled,
            title=body.title,
            ui_schema=body.ui_schema,
            update_definition=bool(definition_fields),
            note=body.note,
        )
    except studio_workflows.StudioWorkflowError as exc:
        raise _workflow_error(exc) from exc
    return studio_workflows.workflow_view(row, detail=True)


@router.delete("/workflows/{workflow_id}")
async def delete_workflow(workflow_id: int, session: SessionDep) -> dict:
    try:
        row = await studio_workflows.get_workflow(session, workflow_id)
        await studio_workflows.delete_workflow(session, row)
    except studio_workflows.StudioWorkflowError as exc:
        raise _workflow_error(exc) from exc
    return {"ok": True}


@router.post("/workflows/{workflow_id}/export", response_model=None)
async def export_workflow(workflow_id: int, session: SessionDep):
    """导出一份自包含 JSON，同一个导入口能原样吃回去。

    凭据字段与本机绝对路径导出前一律抹掉，抹了哪些逐条写在 `redacted` 里
    ——工作流是拿来发给别人的，这条不能靠用户自己记得先检查一遍。
    """
    try:
        row = await studio_workflows.get_workflow(session, workflow_id)
    except studio_workflows.StudioWorkflowError as exc:
        raise _workflow_error(exc) from exc
    bundle = studio_workflows.build_export(row)
    filename = studio_workflows.export_filename(row)
    data = json.dumps(bundle, ensure_ascii=False, indent=2).encode()
    headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"}
    return Response(data, media_type="application/json", headers=headers)


@router.get("/workflows/{workflow_id}/revisions")
async def list_workflow_revisions(workflow_id: int, session: SessionDep) -> dict:
    try:
        await studio_workflows.get_workflow(session, workflow_id)
        items = await studio_workflows.list_workflow_revisions(session, workflow_id)
    except studio_workflows.StudioWorkflowError as exc:
        raise _workflow_error(exc) from exc
    return {"items": items, "keep_recent": studio_revisions.KEEP_RECENT}


@router.post("/workflows/{workflow_id}/revisions/{version}/restore")
async def restore_workflow(workflow_id: int, version: int, session: SessionDep) -> dict:
    try:
        row = await studio_workflows.get_workflow(session, workflow_id)
        row = await studio_workflows.restore_workflow(session, row, version)
    except studio_workflows.StudioWorkflowError as exc:
        raise _workflow_error(exc) from exc
    except studio_revisions.StudioRevisionError as exc:
        raise _revision_error(exc) from exc
    return studio_workflows.workflow_view(row, detail=True)


@router.patch("/workflows/{workflow_id}/revisions/{version}")
async def pin_workflow_revision(
    workflow_id: int, version: int, body: RevisionPinBody, session: SessionDep
) -> dict:
    try:
        await studio_workflows.get_workflow(session, workflow_id)
        return await studio_workflows.pin_workflow_revision(
            session, workflow_id, version, body.pinned
        )
    except studio_workflows.StudioWorkflowError as exc:
        raise _workflow_error(exc) from exc
    except studio_revisions.StudioRevisionError as exc:
        raise _revision_error(exc) from exc


@router.get("/workflows/{workflow_id}/thumbnail")
async def workflow_thumbnail(workflow_id: int, session: SessionDep) -> FileResponse:
    try:
        row = await studio_workflows.get_workflow(session, workflow_id)
    except studio_workflows.StudioWorkflowError as exc:
        raise _workflow_error(exc) from exc
    path = studio_workflows.thumbnail_path(row)
    if path is None:
        raise HTTPException(status_code=404, detail="工作流没有缩略图")
    return FileResponse(path, media_type="image/jpeg")


@router.post("/workflows/{workflow_id}/runs", status_code=202)
async def run_workflow(
    workflow_id: int,
    body: WorkflowRunBody,
    session: SessionDep,
) -> dict:
    source_context = body.source_context or {}
    return await _start_workflow_tool(
        session,
        tool_id=(
            "infinite-canvas" if source_context.get("canvas_id") is not None else "workflow-center"
        ),
        body=ToolWorkflowInput.model_validate(
            {
                **body.model_dump(exclude={"source_route", "source_context"}),
                "workflow_id": workflow_id,
            }
        ),
        source_route=body.source_route,
        source_context=source_context,
    )


@router.post("/videos/runs", status_code=202)
async def run_video(body: VideoRunBody, session: SessionDep) -> dict:
    return await _start_video_tool(
        session,
        tool_id=(
            "infinite-canvas"
            if body.source_context is not None and body.source_context.get("canvas_id") is not None
            else "video-director"
        ),
        body=ToolVideoInput.model_validate(
            body.model_dump(exclude={"source_route", "source_context"})
        ),
        source_route=body.source_route,
        source_context=body.source_context,
    )


@router.post("/midjourney/runs", status_code=202)
async def run_midjourney(body: MidjourneyRunBody, session: SessionDep) -> dict:
    try:
        result = await start_tool_operation(
            session,
            get_queue,
            tool_id="infinite-canvas",
            operation="midjourney.generate",
            body=ToolMidjourneyGenerateInput.model_validate(
                body.model_dump(exclude={"source_route", "source_context"})
            ),
            source_route=body.source_route,
            source_context=body.source_context,
        )
    except ToolExecutionError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    return task_view(result.task)


@router.post("/midjourney/actions", status_code=202)
async def run_midjourney_action(body: MidjourneyActionBody, session: SessionDep) -> dict:
    try:
        result = await start_tool_operation(
            session,
            get_queue,
            tool_id="infinite-canvas",
            operation="midjourney.action",
            body=ToolMidjourneyActionInput.model_validate(
                body.model_dump(exclude={"source_route", "source_context"})
            ),
            source_route=body.source_route,
            source_context=body.source_context,
        )
    except ToolExecutionError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    return task_view(result.task)


@router.post("/minimax/timeline-export")
async def export_minimax_timeline(
    body: MiniMaxExportBody,
    session: SessionDep,
) -> dict:
    try:
        row = await studio_minimax.export_timeline(
            session,
            clips=[studio_minimax.MiniMaxClip(**clip.model_dump()) for clip in body.clips],
            filename=body.filename,
        )
    except studio_minimax.MiniMaxExportError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    return studio_media_assets.asset_view(row)


# ---- 视频抽帧（M4 FR-483） ----


class FrameExtractBody(BaseModel):
    # source 必填：视频学习库与工坊素材各有一套从 1 开始的 id，只给数字必然抽错片
    source: Literal["library", "studio"]
    video_id: int
    # 空列表与超量都显式拒：一个都没选与随手拖了一串，静默放过任何一种都会
    # 让人以为抽成功了
    at_seconds: list[float] = Field(min_length=1, max_length=studio_frames.MAX_FRAMES)


@router.get("/frames/videos")
async def list_frame_videos(session: SessionDep) -> dict:
    return {"items": await studio_frames.list_videos(session)}


@router.post("/frames/extract")
async def extract_frames(body: FrameExtractBody, session: SessionDep) -> dict:
    """逐帧抽取入库。一帧失败只写它自己的 error，其余照常（结果分 items/failed）。"""
    try:
        return await studio_frames.extract_frames(
            session, body.source, body.video_id, body.at_seconds
        )
    except studio_frames.StudioFrameError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc


# ---- 打标队列（M4 FR-484） ----


class TagJobBody(BaseModel):
    asset_ids: list[int] = Field(min_length=1, max_length=200)


@router.post("/assets/tag-job")
async def start_tag_job(body: TagJobBody) -> dict:
    """入队即返回。同步的 /assets/tag 保留给单张与小批量，一次往返更省事。"""
    return await studio_assets.start_tag_job(body.asset_ids)


@router.get("/assets/tag-job/{job_id}")
async def get_tag_job(job_id: str) -> dict:
    state = await studio_assets.load_tag_job(job_id)
    if state is None:
        # 进度只留一小时。过期不等于打标没成功——标签在 image_asset 行上，
        # 丢的只是这次的进度条
        raise HTTPException(status_code=404, detail=f"打标任务不存在或进度已过期：{job_id}")
    return state


# ---- 循环节点的 AI 编排（FR-465） ----


class LoopPlanBody(BaseModel):
    idea: str = Field(min_length=1, max_length=canvas_loop.MAX_IDEA_CHARS)
    #: 这个循环上游连着几张图。有没有上游图会改变该配什么，所以要带上
    upstream_images: int = Field(default=0, ge=0, le=9999)
    #: 上游已有的提示词，给模型当基底
    upstream_prompt: str = Field(default="", max_length=2000)


@router.post("/canvas/plan-loop")
async def plan_loop(body: LoopPlanBody) -> dict:
    """一句话变成一整套循环配置。只调文本模型，不出图。

    产出是**草稿**：前端把它填进表单让用户改，不直接开跑。
    """
    try:
        return await canvas_loop.plan_loop(
            body.idea,
            upstream_images=body.upstream_images,
            upstream_prompt=body.upstream_prompt,
        )
    except canvas_loop.LoopPlanError as exc:
        # 502 而不是 400：失败的是上游模型，不是用户的请求格式
        raise HTTPException(status_code=502, detail=exc.message) from exc


# ---- 成套出图的 AI 编排（需求见 00.需求文档/.../成套出图节点.md） ----


class SetAnswer(BaseModel):
    """一次问答的结果。`title` 带上是为了让下一轮模型看得懂上下文"""

    id: str = Field(max_length=40)
    title: str = Field(default="", max_length=200)
    #: 单选是字符串，多选是数组，填空是字符串
    answer: str | list[str] = ""


class SetAttachment(BaseModel):
    """输入框上挂的一个附件。只是个引用——正文由服务端按 id 去存储层读。"""

    kind: str = Field(default="file", max_length=16)
    name: str = Field(default="", max_length=255)
    media_asset_id: int | None = None
    asset_id: int | None = None


class SetAskBody(BaseModel):
    idea: str = Field(min_length=1, max_length=canvas_set.MAX_IDEA_CHARS)
    #: 用户按了"再问我几个"。这一轮不许回"够了"
    more: bool = False
    answered: list[SetAnswer] = Field(default_factory=list, max_length=20)
    upstream_images: int = Field(default=0, ge=0, le=9999)
    #: 用哪个模型来问。用户可以在弹窗里选
    alias: str = Field(default=canvas_set.DEFAULT_ALIAS, max_length=80)
    #: 输入框上挂的附件。只传 id 与文件名，**正文由服务端按 id 现抽**——
    #: 让浏览器把一份 pdf 的正文读出来再发回来，等于把同一份字节过两遍网。
    attachments: list[SetAttachment] = Field(default_factory=list, max_length=20)
    #: 用户在问题末尾自己补的一句话
    note: str = Field(default="", max_length=400)
    #: 已经摆在界面上、用户还没答的问题标题。不回传的话模型会换个说法重问
    asked: list[str] = Field(default_factory=list, max_length=40)


async def _attachment_context(session: SessionDep, items: list[SetAttachment]) -> list[dict]:
    """把附件解析成 `[{name, text}]`。图片不在其中——它们走参考图那条路。"""
    out: list[dict] = []
    for item in items:
        if item.kind == "image":
            continue
        if item.media_asset_id is None:
            out.append({"name": item.name, "text": ""})
            continue
        name, text = await studio_media_assets.asset_text(session, item.media_asset_id)
        out.append({"name": name or item.name, "text": text})
    return out


@router.post("/canvas/set/ask")
async def set_ask(body: SetAskBody, session: SessionDep) -> dict:
    """还缺什么信息就问什么。返回一组可点选的问题。"""
    try:
        return await canvas_set.ask(
            body.idea,
            answered=[a.model_dump() for a in body.answered],
            upstream_images=body.upstream_images,
            attachments=await _attachment_context(session, body.attachments),
            note=body.note,
            more=body.more,
            asked=body.asked,
            alias=body.alias,
        )
    except canvas_set.SetPlanError as exc:
        raise HTTPException(status_code=502, detail=exc.message) from exc


class SetDraftBody(SetAskBody):
    #: 用户明确要几张。None = 让模型自己定
    want: int | None = Field(default=None, ge=1, le=canvas_set.MAX_STEPS)


@router.post("/canvas/set/draft")
async def set_draft(body: SetDraftBody, session: SessionDep) -> dict:
    """产出实施方案。只调文本模型，不出图，可以随便重来。"""
    try:
        return await canvas_set.draft(
            body.idea,
            answered=[a.model_dump() for a in body.answered],
            upstream_images=body.upstream_images,
            want=body.want,
            attachments=await _attachment_context(session, body.attachments),
            note=body.note,
            alias=body.alias,
        )
    except canvas_set.SetPlanError as exc:
        raise HTTPException(status_code=502, detail=exc.message) from exc


class SetPatchBody(BaseModel):
    plan: dict
    ops: list[dict] = Field(min_length=1, max_length=200)


@router.post("/canvas/set/patch")
async def set_patch(body: SetPatchBody) -> dict:
    """把改动落到方案上，并告诉前端这一批属于哪一档。

    一档（只改张数、文案）**完全不进模型**——这是「6 张改 12 张不该等二十秒」的落点。
    """
    tier = canvas_set.change_tier(body.ops)
    plan = canvas_set.apply_ops(body.plan, body.ops) if tier == 1 else body.plan
    return {"tier": tier, "plan": plan, "run": canvas_set.to_run_config(plan)}

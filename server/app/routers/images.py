"""生图与视觉资产（模块 16 FR-415~FR-419）。

三类端点：目录（用途与风格预设）、资产库（浏览 / 取图 / 应用）、任务（下单 / 查进度）。

出图本身是慢活（medium 档一张十几秒），一律走 arq 入队 + 轮询，与场景本生成同一
套路（`status_code=202` + job_id）。同步端点只留两个：提示词预览（不花钱）与
「试出一张图」（用户显式点的端到端验证）。
"""

import asyncio
import contextlib
import json
import uuid
from collections.abc import AsyncGenerator
from typing import Annotated, Any, Literal

from fastapi import APIRouter, File, Form, HTTPException, Query, Response, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import Text, and_, func, or_, select
from sqlalchemy.dialects.postgresql import JSONB

from app.media import media_response
from app.queue import get_queue
from app.routers.dict import SessionDep
from domain import (
    image_apps,
    image_assets,
    image_batch,
    image_coach,
    image_defaults,
    image_describe,
    image_pipeline,
    image_prompts,
    image_sizes,
    image_stream,
    image_styles,
    imagegen,
    studio_asset_storage,
)
from domain.model_catalog import ModelCatalogError, bound_deployment_id, resolve_model_route
from domain.models import ImageAsset, ImageJob, PipelineRun, StudioTask
from domain.storage import Storage, StorageError, get_storage
from domain.studio_tasks import transition
from domain.tool_execution import (
    ImageEditInput,
    ImageGenerateInput,
    ToolExecutionError,
    UploadRef,
    enqueue_task,
    new_execution_task,
    start_tool_operation,
)

router = APIRouter(prefix="/images", tags=["images"])


def _job_key(job_id: str) -> str:
    return f"image_job:{job_id}"


async def _model_route(session, alias: str):
    try:
        return await resolve_model_route(session, alias)
    except ModelCatalogError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _tool_input[InputT: BaseModel](model: type[InputT], **fields: Any) -> InputT:
    """把路由层参数装进执行器合同；装不进去按 422 报，与请求体校验同一口径。"""
    try:
        return model(**fields)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors(include_context=False)) from exc


# ---- 目录 ----


OUTPUT_FORMATS = ("png", "webp", "jpeg")
BACKGROUNDS = ("auto", "transparent", "opaque")


@router.get("/catalog")
async def catalog(session: SessionDep) -> dict:
    """控制台开局拉这一份：应用、分类、用途、风格、尺寸档。

    功能格子全部由 `apps` 驱动，前端不硬编码（BR-114）——新增一个应用只在
    `domain/image_apps.py` 加一条记录，这里自动带出去。
    """
    await image_styles.ensure_loaded(session)
    await image_sizes.load_measured(session)
    await image_defaults.load(session)
    return {
        "targets": image_prompts.target_view(),
        "styles": image_prompts.preset_view(),
        "qualities": list(image_prompts.QUALITIES),
        "default_quality": image_defaults.quality(),
        "capabilities": list(imagegen.IMAGE_CAPABILITIES),
        "max_n": imagegen.MAX_N,
        "apps": image_apps.app_view(),
        "categories": image_apps.category_view(),
        "sizes": image_sizes.view(),
        "style_categories": image_prompts.style_category_view(),
        "output_formats": list(OUTPUT_FORMATS),
        "backgrounds": list(BACKGROUNDS),
    }


# ---- 资产库 ----


def _tag_condition(session, tag: str):
    """按 AI 标签筛（命中任一）。

    tags 列是 `JSON().with_variant(JSONB)`，两种方言的落盘形态不同，得分开处理：

    - PostgreSQL 走 JSONB 的包含运算符 `@>`，**但必须先 `cast(JSONB)`**：变体只影响
      建表与绑参，比较器仍是基础 JSON 的，直接 `.contains([tag])` 会编译成
      `tags LIKE '%' || $1::JSONB || '%'`，上线即 `invalid input syntax for type json`。
    - SQLite 存的是 `json.dumps` 的文本（中文按 ensure_ascii 转成了转义序列），
      所以拿同样经 `json.dumps` 的标签做文本匹配，两边才对得上。
    """
    if session.get_bind().dialect.name == "postgresql":
        return ImageAsset.tags.cast(JSONB).contains([tag])
    return ImageAsset.tags.cast(Text).contains(json.dumps(tag))


@router.get("/assets")
async def list_assets(
    session: SessionDep,
    target: str | None = None,
    style: str | None = None,
    source: str | None = None,
    status: str | None = None,
    favorite: bool | None = None,
    subject_domain: str | None = None,
    subject_id: int | None = None,
    app: str | None = None,
    op: str | None = None,
    parent_id: int | None = None,
    q: str | None = None,
    group_id: int | None = None,
    tag: str | None = None,
    untagged: bool | None = None,
    limit: int = Query(default=60, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict:
    stmt = select(ImageAsset)
    count_stmt = select(func.count()).select_from(ImageAsset)
    filters = []
    if target:
        filters.append(ImageAsset.target_key == target)
    if style:
        filters.append(ImageAsset.style_key == style)
    if source:
        filters.append(ImageAsset.source == source)
    if status:
        filters.append(ImageAsset.status == status)
    else:
        # 归档是软删（BR-105），默认不出现在列表里
        filters.append(ImageAsset.status != "archived")
    if favorite is not None:
        filters.append(ImageAsset.favorite.is_(favorite))
    if subject_domain:
        filters.append(ImageAsset.subject_domain == subject_domain)
    if subject_id is not None:
        filters.append(ImageAsset.subject_id == subject_id)
    if op:
        filters.append(ImageAsset.op == op)
    if parent_id is not None:
        filters.append(ImageAsset.parent_id == parent_id)
    if q:
        pattern = f"%{q}%"
        filters.append(
            or_(
                ImageAsset.display_name.ilike(pattern),
                ImageAsset.prompt.ilike(pattern),
                ImageAsset.caption.ilike(pattern),
            )
        )
    if group_id is not None:
        # 0 是「只看没归组的」：分组 id 从 1 起，0 空出来当这个语义，
        # 比再加一个 ungrouped=true 参数少一次前后端对齐
        filters.append(
            ImageAsset.group_id.is_(None) if group_id == 0 else ImageAsset.group_id == group_id
        )
    if tag:
        filters.append(_tag_condition(session, tag))
    if untagged:
        # 未打标看 tagged_at 而不是 tags 是否为空：打标成功但模型没给出标签的图，
        # 与从没打过标是两回事，混在一起会让批量补标反复打同一批
        filters.append(ImageAsset.tagged_at.is_(None))
    if app:
        # 三轮之前的行没有 op，只有 target_key。按应用筛时把这批老图也带上，
        # 否则「按应用看」在历史资产上一条都查不到
        try:
            fallback_target = image_apps.get_app(app).target_key
        except image_prompts.PromptError:
            fallback_target = app
        filters.append(
            or_(
                ImageAsset.op == app,
                and_(ImageAsset.op.is_(None), ImageAsset.target_key == fallback_target),
            )
        )
    for condition in filters:
        stmt = stmt.where(condition)
        count_stmt = count_stmt.where(condition)

    total = (await session.execute(count_stmt)).scalar_one()
    rows = (
        (
            await session.execute(
                stmt.order_by(ImageAsset.created_at.desc()).limit(limit).offset(offset)
            )
        )
        .scalars()
        .all()
    )
    return {
        "total": total,
        "items": [image_assets.asset_view(row) for row in rows],
    }


@router.get("/assets/{asset_id}")
async def get_asset(asset_id: int, session: SessionDep) -> dict:
    row = await session.get(ImageAsset, asset_id)
    if row is None:
        raise HTTPException(status_code=404, detail="资产不存在")
    return image_assets.asset_view(row)


@router.get("/assets/{asset_id}/lineage")
async def asset_lineage(asset_id: int, session: SessionDep) -> dict:
    """编辑链（FR-435 / BR-117）：从根图到它的完整路径 + 它的直接分支。

    必须注册在下面那条 `/{variant}` 之前——那条的 variant 是 Literal，
    `lineage` 不在枚举里会先被它接住然后 422。
    """
    row = await session.get(ImageAsset, asset_id)
    if row is None:
        raise HTTPException(status_code=404, detail="资产不存在")

    chain: list[ImageAsset] = [row]
    seen = {row.id}
    cursor = row
    # 深度设上限：血缘理论上不会成环（parent 永远比自己早），但库是可以被手改的
    while cursor.parent_id is not None and len(chain) < 32:
        parent = await session.get(ImageAsset, cursor.parent_id)
        if parent is None or parent.id in seen:
            break
        seen.add(parent.id)
        chain.append(parent)
        cursor = parent
    chain.reverse()

    children = (
        (
            await session.execute(
                select(ImageAsset)
                .where(ImageAsset.parent_id == asset_id)
                .order_by(ImageAsset.created_at.asc())
            )
        )
        .scalars()
        .all()
    )
    return {
        "chain": [image_assets.asset_view(a) for a in chain],
        "children": [image_assets.asset_view(a) for a in children],
    }


@router.get("/assets/{asset_id}/usage")
async def asset_usage(asset_id: int, session: SessionDep) -> dict:
    """删之前谁在用它：画布节点、编辑链子代、应用目标、共用的存储对象。

    与 `lineage` 同理，必须注册在 `/{variant}` 之前，否则 `usage` 会被那条的
    Literal 枚举接住变成 422。
    """
    row = await session.get(ImageAsset, asset_id)
    if row is None:
        raise HTTPException(status_code=404, detail="资产不存在")
    return await studio_asset_storage.asset_usage(session, row)


class BulkDeleteBody(BaseModel):
    ids: list[int] = Field(default_factory=list, max_length=studio_asset_storage.MAX_BULK_DELETE)
    force: bool = False
    force_ids: list[int] = Field(
        default_factory=list, max_length=studio_asset_storage.MAX_BULK_DELETE
    )


@router.post("/assets/delete-preview")
async def preview_delete_assets(body: BulkDeleteBody, session: SessionDep) -> dict:
    items = []
    for asset_id in dict.fromkeys(body.ids):
        row = await session.get(ImageAsset, asset_id)
        if row is None:
            raise HTTPException(404, f"素材 {asset_id} 不存在，请刷新列表")
        items.append(await studio_asset_storage.asset_usage(session, row))
    return {"items": items}


@router.post("/assets/bulk-delete")
async def bulk_delete_assets(body: BulkDeleteBody, session: SessionDep) -> dict:
    """素材库多选删除：逐个删、逐个回报，一张失败不影响其余。"""
    try:
        return await studio_asset_storage.delete_assets(
            session, body.ids, force=body.force, force_ids=body.force_ids
        )
    except studio_asset_storage.AssetStorageError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc


@router.delete("/assets/{asset_id}")
async def delete_asset(
    asset_id: int,
    session: SessionDep,
    force: Annotated[bool, Query(description="有编辑链子代时强制删除")] = False,
) -> dict:
    """真删（软删是 PATCH status=archived，两条路各管各的）。

    存储对象删不掉不回滚库行：用户要的是这张图从素材库消失，孤儿文件事后能清，
    「删一半又回滚成还在」才是最难收拾的状态。删了什么、留了什么原样报在响应里。
    """
    result = (await studio_asset_storage.delete_assets(session, [asset_id], force=force))[
        "results"
    ][0]
    if not result["deleted"]:
        detail: dict = {"message": result["reason"], "asset_id": asset_id}
        if "children" in result:
            detail |= {"children": result["children"], "child_ids": result["child_ids"]}
        raise HTTPException(status_code=result["status"], detail=detail)
    return result


@router.get("/assets/{asset_id}/{variant}", response_model=None)
async def serve_asset(
    asset_id: int,
    variant: Literal["full", "display", "thumb"],
    session: SessionDep,
) -> Response:
    """发图。URL 带 `?v=` 由调用方拼（`image_assets.asset_url`）——
    媒体响应是一周强缓存，靠 URL 变化失效而不是靠缓存头。"""
    row = await session.get(ImageAsset, asset_id)
    if row is None:
        raise HTTPException(status_code=404, detail="资产不存在")
    return media_response(
        image_assets.variant_key(row, variant),
        media_type=image_assets.variant_mime(row, variant),
        cache_control="public, max-age=604800, immutable",
    )


class AssetPatch(BaseModel):
    display_name: str | None = Field(default=None, max_length=160)
    favorite: bool | None = None
    status: Literal["candidate", "applied", "archived"] | None = None
    # 素材分组（M2）。传 null = 移出分组，所以「没传」与「传了 null」要分开判
    group_id: int | None = None


@router.patch("/assets/{asset_id}")
async def patch_asset(asset_id: int, body: AssetPatch, session: SessionDep) -> dict:
    row = await session.get(ImageAsset, asset_id)
    if row is None:
        raise HTTPException(status_code=404, detail="资产不存在")
    if "display_name" in body.model_fields_set:
        row.display_name = body.display_name.strip() if body.display_name else None
    if body.favorite is not None:
        row.favorite = body.favorite
    if body.status is not None:
        row.status = body.status
    if "group_id" in body.model_fields_set:
        row.group_id = body.group_id
    await session.commit()
    return image_assets.asset_view(row)


class ApplyBody(BaseModel):
    subject_domain: str
    subject_id: int


@router.post("/assets/{asset_id}/apply")
async def apply_asset(asset_id: int, body: ApplyBody, session: SessionDep) -> dict:
    """把已有资产应用到某个目标（FR-416 的「应用为」）。"""
    row = await session.get(ImageAsset, asset_id)
    if row is None:
        raise HTTPException(status_code=404, detail="资产不存在")
    applier = image_pipeline.APPLIERS.get(body.subject_domain)
    if applier is None:
        raise HTTPException(status_code=400, detail=f"未注册的应用目标：{body.subject_domain}")
    await applier(session, body.subject_id, row)
    await image_assets.mark_applied(session, row, body.subject_domain, body.subject_id)
    await session.commit()
    return image_assets.asset_view(row)


# ---- 提示词预览（不花钱） ----


class PreviewBody(BaseModel):
    target_key: str = "free"
    idea: str = Field(default="", max_length=800)
    style_key: str | None = None
    # 留空 = 不指定比例，由立意按画面内容挑一个（FR-451）
    size: str | None = None
    tier: str = "1k"
    subject_domain: str | None = None
    subject_id: int | None = None


@router.post("/preview-prompt")
async def preview_prompt(body: PreviewBody, session: SessionDep) -> dict:
    """立意 + 写词两步，不出图。

    单独暴露是因为这两步几乎不花钱而出图很贵：让用户先看提示词、改完再出图，
    比出一张不满意的图再重来省得多。
    """
    try:
        target = image_prompts.get_target(body.target_key)
    except image_prompts.PromptError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await image_styles.ensure_loaded(session)
    subject = await image_pipeline.load_subject(session, body.subject_domain, body.subject_id)
    # 没钉比例就让立意顺手把画幅也挑了——画幅是画面的一部分，
    # 与其让用户在八个比例里猜哪个配得上自己的想法，不如由想画面的这一步定
    brief = await imagegen.plan_brief(
        target,
        subject,
        body.idea,
        aspects=None if body.size else image_sizes.aspect_choices(),
    )
    size = (
        body.size
        or image_sizes.size_for_aspect(str(brief.get("aspect") or ""), body.tier)
        or target.size
    )
    try:
        prompt, structure = image_prompts.render_prompt(
            target, brief, style_key=body.style_key, size=size
        )
    except image_prompts.PromptError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    picked = image_sizes.classify(size)
    return {
        "prompt": prompt,
        "structure": structure,
        "brief": brief,
        # 比例是立意挑的时候，界面要能说出「AI 选了什么」而不是让人自己去比数字
        "size": size,
        "ratio": picked[0] if picked else None,
        "aspect_chosen": not body.size and picked is not None,
    }


# ---- 生图任务 ----


class JobBody(BaseModel):
    target_key: str = "free"
    idea: str = Field(default="", max_length=800)
    prompt_override: str = Field(default="", max_length=8000)
    style_key: str | None = None
    # 留空 = 不指定比例，由立意按画面内容挑一个（FR-451）
    size: str | None = None
    tier: str = "1k"
    quality: Literal["low", "medium", "high"] | None = None
    n: int = Field(default=1, ge=1, le=imagegen.MAX_N)
    alias: str = "image-free"
    # 画布节点可固定真实模型；留空继续跟随 alias 的全局能力绑定。
    deployment_id: int | None = Field(default=None, ge=1)
    subject_domain: str | None = None
    subject_id: int | None = None
    # 高级参数，原样透传给上游。默认全部留空 = 用上游默认
    output_format: Literal["png", "webp", "jpeg"] | None = None
    background: Literal["auto", "transparent", "opaque"] | None = None
    output_compression: int | None = Field(default=None, ge=0, le=100)
    moderation: Literal["auto", "low"] | None = None
    # ModelScope AIGC 异步协议的原生参数。其他 adapter 不传时不受影响。
    negative_prompt: str | None = Field(default=None, max_length=2_000)
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)
    steps: int | None = Field(default=None, ge=1, le=100)
    guidance: float | None = Field(default=None, ge=1.5, le=20)
    loras: str | dict[str, float] | None = None
    ref_asset_ids: list[int] = Field(default_factory=list, max_length=10)
    # 统一任务中心用来回到原工具/画布节点。旧客户端不传时仍可正常创建任务。
    tool_id: str = Field(default="image-console", min_length=1, max_length=64)
    source_route: str | None = Field(default=None, max_length=512)
    source_context: dict[str, Any] | None = None


@router.post("/jobs", status_code=202)
async def create_job(body: JobBody, session: SessionDep) -> dict:
    """下单出图：请求体映射成 ``ImageGenerateInput``，校验、建 image_job、入队全在执行器。

    进度走管线设施（`/api/pipeline/subjects/image_gen/{id}`），不另建一套轮询——
    这条任务本来就是一条管线运行。
    """
    payload = _tool_input(
        ImageGenerateInput,
        prompt=body.prompt_override,
        idea=body.idea,
        deployment_id=body.deployment_id,
        alias=body.alias,
        target_key=body.target_key,
        style_key=body.style_key,
        size=body.size,
        tier=body.tier,
        quality=body.quality,
        n=body.n,
        subject_domain=body.subject_domain,
        subject_id=body.subject_id,
        output_format=body.output_format,
        background=body.background,
        output_compression=body.output_compression,
        moderation=body.moderation,
        negative_prompt=body.negative_prompt,
        seed=body.seed,
        steps=body.steps,
        guidance=body.guidance,
        loras=body.loras,
        ref_asset_ids=body.ref_asset_ids,
    )
    try:
        result = await start_tool_operation(
            session,
            get_queue,
            tool_id=body.tool_id,
            operation="image.generate",
            body=payload,
            source_route=body.source_route or "/image",
            source_context=body.source_context,
        )
    except ToolExecutionError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    # 旧客户端按这枚令牌认任务；没有消费方读它的状态，只是响应形状的一部分
    queue = await get_queue()
    token = uuid.uuid4().hex
    await queue.set(
        _job_key(token),
        json.dumps(
            {"job_id": token, "image_job_id": result.image_job_id, "status": "running"},
            ensure_ascii=False,
        ),
        ex=3600,
    )
    return {
        "job_id": token,
        "image_job_id": result.image_job_id,
        "studio_task_id": result.task.id,
        "domain": image_pipeline.DOMAIN,
    }


@router.get("/jobs/{image_job_id}")
async def get_job(image_job_id: int, session: SessionDep) -> dict:
    job = await session.get(ImageJob, image_job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    # 这个任务产出的资产 = 由它名下任意一次 run 生成的资产。
    # 按 subject 查是错的：自由出图没有 subject，而同一个 subject 会有多次任务
    run_ids = select(PipelineRun.id).where(
        PipelineRun.domain == image_pipeline.DOMAIN, PipelineRun.subject_id == job.id
    )
    rows = (
        (
            await session.execute(
                select(ImageAsset)
                .where(ImageAsset.run_id.in_(run_ids))
                .order_by(ImageAsset.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return {
        "id": job.id,
        "studio_task_id": job.studio_task_id,
        "target_key": job.target_key,
        "status": job.status,
        "error": job.error,
        "applied_asset_id": job.applied_asset_id,
        "assets": [image_assets.asset_view(r) for r in rows],
    }


class RerunBody(BaseModel):
    from_step: str
    scope: Literal["single", "downstream"] = "downstream"
    config: dict | None = None


@router.post("/jobs/{image_job_id}/rerun", status_code=202)
async def rerun_job(image_job_id: int, body: RerunBody, session: SessionDep) -> dict:
    job = await session.get(ImageJob, image_job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if body.from_step not in image_pipeline.IMAGE_PIPELINE.by_name:
        raise HTTPException(status_code=400, detail=f"未知节点：{body.from_step}")
    parent_task_id = job.studio_task_id
    parent_task = (
        await session.get(StudioTask, parent_task_id) if parent_task_id is not None else None
    )
    task = new_execution_task(
        tool_id="image-console",
        operation="image.generate",
        task_type="image.rerun",
        domain="studio",
        parent_task_id=parent_task_id,
        source_route="/image",
        source_context={"image_job_id": job.id},
        model_capability=job.alias,
        deployment_id=(
            parent_task.deployment_id
            if parent_task is not None
            else await bound_deployment_id(session, job.alias)
        ),
        invocation={
            "image_job_id": job.id,
            "from_step": body.from_step,
            "scope": body.scope,
            "config": body.config,
        },
    )
    session.add(task)
    await session.flush([task])
    job.studio_task_id = task.id
    job.status = "pending"
    job.error = None
    await session.commit()
    try:
        queue = await get_queue()
        await enqueue_task(queue, task)
    except Exception as exc:
        transition(
            task,
            "failed",
            stage="queue",
            error=f"任务入队失败：{type(exc).__name__}: {exc}",
            retryable=True,
        )
        job.status = "failed"
        job.error = task.error
        await session.commit()
        raise HTTPException(status_code=503, detail=task.error) from exc
    return {
        "image_job_id": job.id,
        "studio_task_id": task.id,
        "from_step": body.from_step,
        "scope": body.scope,
    }


# ---- 端到端验证（用户显式点，会真的花一次钱） ----


class TestBody(BaseModel):
    alias: str = "image-free"
    deployment_id: int | None = Field(default=None, gt=0)


@router.post("/test")
async def test_capability(body: TestBody, session: SessionDep) -> dict:
    """试出一张图：能力探测（FR-418）。

    不放进配置中心的「测一下」按钮里自动跑——那个按钮打的是 chat/completions，
    而且一次出图是真花钱的，必须由用户显式触发。
    """
    if body.alias not in imagegen.IMAGE_CAPABILITIES:
        raise HTTPException(status_code=400, detail=f"未知生图能力：{body.alias}")
    try:
        if body.deployment_id is not None:
            from dataclasses import replace

            route = await resolve_model_route(session, body.alias, deployment_id=body.deployment_id)
            if route is None or route.deployment_id != body.deployment_id:
                raise HTTPException(409, "所选模型不可用")
            route = replace(route, fallbacks=(), params={})
        else:
            route = await _model_route(session, body.alias)
        result = await imagegen.render_images(
            "a single small green apple on a plain white background, "
            "flat vector illustration, no text",
            alias=body.alias,
            size="1024x1024",
            quality="low",
            n=1,
            route=route,
        )
    except imagegen.ImageGenError as exc:
        return {"ok": False, "kind": exc.kind, "detail": str(exc)}
    except ModelCatalogError as exc:
        raise HTTPException(409, str(exc)) from exc
    row = await image_assets.ingest_one(
        session,
        result.images[0],
        target_key="free",
        prompt="capability probe",
        alias=body.alias,
        model_reported=result.model_reported,
        size_req="1024x1024",
        quality="low",
        usage=imagegen.usage_with_latency(result),
        source="workbench",
    )
    await session.commit()
    return {
        "ok": True,
        "latency_ms": result.latency_ms,
        "model": result.model_reported,
        "asset": image_assets.asset_view(row),
    }


# ---- 参考图重绘（FR-417） ----


@router.post("/edit", status_code=201)
async def edit_image(
    session: SessionDep,
    prompt: Annotated[str, Form()],
    images: Annotated[list[UploadFile] | None, File()] = None,
    alias: Annotated[str, Form()] = "image-free",
    size: Annotated[str | None, Form()] = None,
    quality: Annotated[str, Form()] = image_defaults.FALLBACK_QUALITY,
    mask: Annotated[UploadFile | None, File()] = None,
    app_key: Annotated[str, Form()] = "image_to_image",
    parent_id: Annotated[int | None, Form()] = None,
    n: Annotated[int, Form()] = 1,
    ref_asset_ids: Annotated[str, Form()] = "",
) -> dict:
    """所有编辑类应用的唯一通路（BR-115）。

    局部重绘 / 消除 / 替换 / 换背景 / 扩图 / 多图融合 / 人像重绘的差别只在
    **蒙版怎么来**与**锁了哪些参数**，都由前端合成好再走这一条，服务端不为每种
    应用各开一个端点。扩图因此在服务端是零改动：前端把原图贴进放大后的透明画布，
    透明区就是蒙版。

    参考图两种给法：`images` 上传文件字节，或 `ref_asset_ids`（逗号分隔的资产 id）
    直引已入库的图——服务端从存储直读，禁止前端下载再上传的绕行（BR-144）。
    """
    if alias not in imagegen.IMAGE_CAPABILITIES:
        raise HTTPException(status_code=400, detail=f"未知生图能力：{alias}")
    try:
        app = image_apps.get_app(app_key)
    except image_prompts.PromptError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if app.engine != "edit":
        raise HTTPException(
            status_code=400, detail=f"应用「{app.label}」不是编辑类，不能走这个端点"
        )
    if app.needs_mask and mask is None:
        raise HTTPException(status_code=400, detail=f"应用「{app.label}」需要先涂出要改的区域")

    try:
        ref_ids = [int(part) for part in ref_asset_ids.split(",") if part.strip()]
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail=f"ref_asset_ids 不是合法的 id 列表：{ref_asset_ids!r}"
        ) from exc
    ref_rows: list[ImageAsset] = []
    for ref_id in ref_ids:
        row = await session.get(ImageAsset, ref_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"参考资产不存在：{ref_id}")
        ref_rows.append(row)

    payloads = [(f.filename or "image.png", await f.read()) for f in images or []]
    storage = get_storage()
    for row in ref_rows:
        try:
            data = await storage.read(row.storage_key)
        except StorageError as exc:
            raise HTTPException(
                status_code=502, detail=f"参考资产 {row.id} 读取失败：{exc}"
            ) from exc
        payloads.append((f"asset-{row.id}.png", data))

    # 上传文件与直引资产合并后再校验数量：多图融合要的是「合计两张以上」，
    # 不关心它们各自从哪条路来
    if not payloads:
        raise HTTPException(status_code=400, detail="至少要一张参考图（上传或 ref_asset_ids）")
    if "images" in app.inputs and len(payloads) < 2:
        raise HTTPException(status_code=400, detail=f"应用「{app.label}」至少要两张图")
    # 血缘不断（BR-117）：没显式指定 parent 时，第一个直引资产就是这次编辑的底图
    if parent_id is None and ref_rows:
        parent_id = ref_rows[0].id

    mask_payload = (mask.filename or "mask.png", await mask.read()) if mask else None
    # 应用锁死的参数不接受前端覆盖：人像的 input_fidelity=high 是能不能用的分水岭，
    # 不是偏好（BR-121）
    fidelity = app.fixed.get("input_fidelity")
    model_prompt = image_apps.prepare_edit_prompt(app, prompt)
    try:
        route = await _model_route(session, alias)
        result = await imagegen.edit_images(
            model_prompt,
            alias=alias,
            images=payloads,
            mask=mask_payload,
            size=size,
            quality=quality,
            n=max(1, min(n, imagegen.MAX_N)),
            input_fidelity=fidelity,
            route=route,
        )
    except (imagegen.ImageGenError, image_prompts.PromptError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    rows = []
    for index, data in enumerate(result.images):
        rows.append(
            await image_assets.ingest_one(
                session,
                data,
                target_key=app.target_key,
                prompt=model_prompt,
                alias=alias,
                model_reported=result.model_reported,
                size_req=size,
                quality=quality,
                n_index=index,
                usage=imagegen.usage_with_latency(result),
                source="edit",
                parent_id=parent_id,
                op=app.key,
            )
        )
    await session.commit()
    return {"items": [image_assets.asset_view(r) for r in rows]}


def _source_context(raw: str) -> dict[str, Any] | None:
    if not raw.strip():
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="source_context 必须是 JSON 对象") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="source_context 必须是 JSON 对象")
    return value


async def _discard_uploads(storage: Storage, keys: list[str]) -> None:
    for key in keys:
        with contextlib.suppress(StorageError):
            await storage.delete(key)


@router.post("/edit-jobs", status_code=202)
async def create_edit_job(
    session: SessionDep,
    prompt: Annotated[str, Form()],
    images: Annotated[list[UploadFile] | None, File()] = None,
    alias: Annotated[str, Form()] = "image-free",
    deployment_id: Annotated[int | None, Form(ge=1)] = None,
    size: Annotated[str | None, Form()] = None,
    quality: Annotated[str, Form()] = image_defaults.FALLBACK_QUALITY,
    mask: Annotated[UploadFile | None, File()] = None,
    app_key: Annotated[str, Form()] = "image_to_image",
    parent_id: Annotated[int | None, Form()] = None,
    n: Annotated[int, Form()] = 1,
    ref_asset_ids: Annotated[str, Form()] = "",
    tool_id: Annotated[str, Form()] = "image-console",
    source_route: Annotated[str | None, Form()] = "/image",
    source_context: Annotated[str, Form()] = "",
) -> dict:
    """参考图编辑的持久化入口；页面离开后仍由 worker 完成。

    这里只做表单到合同的搬运：上传字节先落存储换成 ``UploadRef``，应用、蒙版、
    张数、血缘等规则全在执行器的 image.edit 里，与画布 / 连接器同一份。
    """
    try:
        ref_ids = [int(part) for part in ref_asset_ids.split(",") if part.strip()]
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail=f"ref_asset_ids 不是合法的 id 列表：{ref_asset_ids!r}"
        ) from exc
    context = _source_context(source_context)

    storage = get_storage()
    stored_keys: list[str] = []
    batch = uuid.uuid4().hex

    async def store_upload(upload: UploadFile, slot: str) -> UploadRef:
        key = f"studio-task-inputs/{batch}/{slot}-{uuid.uuid4().hex}.bin"
        await storage.write(key, await upload.read())
        stored_keys.append(key)
        return UploadRef(name=upload.filename or f"{slot}.png", storage_key=key)

    try:
        uploads = [
            await store_upload(upload, f"image-{index}")
            for index, upload in enumerate(images or [])
        ]
        mask_input = await store_upload(mask, "mask") if mask is not None else None
    except StorageError as exc:
        await _discard_uploads(storage, stored_keys)
        raise HTTPException(status_code=502, detail=f"编辑输入保存失败：{exc}") from exc

    keep_inputs = False
    try:
        payload = _tool_input(
            ImageEditInput,
            prompt=prompt,
            ref_asset_ids=ref_ids,
            uploads=uploads,
            mask=mask_input,
            parent_id=parent_id,
            deployment_id=deployment_id,
            alias=alias,
            app_key=app_key,
            size=size,
            quality=quality,
            n=max(1, min(n, imagegen.MAX_N)),
        )
        result = await start_tool_operation(
            session,
            get_queue,
            tool_id=tool_id.strip() or "image-console",
            operation="image.edit",
            body=payload,
            source_route=source_route,
            source_context=context,
        )
        keep_inputs = True
    except ToolExecutionError as exc:
        # 入队失败的任务可重试，worker 重来时还要读这些字节；校验没过则没有任务会来读
        keep_inputs = exc.status == 503
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    finally:
        if not keep_inputs:
            await _discard_uploads(storage, stored_keys)
    return {"studio_task_id": result.task.id}


# ---- 存储统计（FR-420b） ----


@router.get("/stats")
async def stats(session: SessionDep) -> dict:
    """生成图占了多少盘。设置页的存储统计原先只单列 TTS，图片进来会看不出是谁吃的。"""
    total, total_bytes = (
        await session.execute(select(func.count(), func.coalesce(func.sum(ImageAsset.bytes), 0)))
    ).one()
    candidates = (
        await session.execute(select(func.count()).where(ImageAsset.status == "candidate"))
    ).scalar_one()
    return {
        "count": total,
        "mb": round(float(total_bytes) / 1024 / 1024, 2),
        "candidates": candidates,
    }


# ---- 描述词反推与提示词扩写（FR-436 / FR-430） ----


@router.post("/describe")
async def describe(
    image: Annotated[UploadFile, File()],
    mode: Annotated[str, Form()] = "recreate",
) -> dict:
    """传一张图反推提示词。走视觉 LLM，比出图便宜得多，不入资产库。"""
    data = await image.read()
    try:
        return await image_describe.describe_image(
            data, image.content_type or "image/png", mode=mode
        )
    except image_describe.DescribeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _prompt_context(app_key: str, style_key: str | None) -> tuple[image_apps.ImageApp, str]:
    """取应用与画风的中文名，给提示词类的 LLM 调用当上下文。

    画风查不到就报「未指定」而不是编一个名字：解读里说着某个画风、实际没用它，
    比不说更误导。
    """
    try:
        app = image_apps.get_app(app_key)
    except image_prompts.PromptError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    preset = image_prompts.STYLE_PRESETS.get(style_key or app.target.default_style)
    return app, preset.label if preset else "未指定"


class EnhanceBody(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    app_key: str = "text_to_image"
    style_key: str | None = None


@router.post("/enhance-prompt")
async def enhance_prompt(body: EnhanceBody) -> dict:
    """提示词扩写。**只做显式按钮，不做自动优化开关**——静默改写用户输入会让
    「改了词但出图没变」无法归因（§11.2）。"""
    try:
        app = image_apps.get_app(body.app_key)
    except image_prompts.PromptError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    preset = image_prompts.STYLE_PRESETS.get(body.style_key or app.target.default_style)
    try:
        result = await image_describe.enhance_prompt(
            body.text, app_label=app.label, style_hint=preset.hint if preset else ""
        )
    except image_describe.DescribeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"prompt": result["prompt"], "model": result.get("model")}


class ExplainBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=8000)
    app_key: str = "text_to_image"
    style_key: str | None = None
    idea: str = Field(default="", max_length=800)


@router.post("/explain-prompt")
async def explain_prompt(body: ExplainBody) -> dict:
    """把最终英文提示词讲成中文（FR-446）。

    出图之前先看懂会得到什么。返回里的 `missing` 是把中文意图与提示词逐条比对后
    「你说了但提示词里没有」的要点——光看英文提示词看不出这件事，而它恰恰决定了
    出来的图为什么不是想要的那张。
    """
    app, style_label = _prompt_context(body.app_key, body.style_key)
    try:
        return await image_coach.explain_prompt(
            body.prompt,
            app_label=app.label,
            style_label=style_label,
            idea=body.idea,
        )
    except image_coach.DescribeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


class ChatTurnBody(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class ChatPromptBody(BaseModel):
    # 空历史没有可执行的诉求，直接在入口拒掉而不是让模型去猜
    messages: list[ChatTurnBody] = Field(min_length=1, max_length=40)
    prompt: str = Field(min_length=1, max_length=8000)
    app_key: str = "text_to_image"
    style_key: str | None = None


@router.post("/chat-prompt")
async def chat_prompt(body: ChatPromptBody) -> dict:
    """对话式改提示词（FR-447）：用中文说要改什么，拿回改好的英文提示词。

    与扩写的区别是**有来有回**：每轮都拿当前提示词当底稿，可以一句一句收敛。
    这轮只是答疑没改动时 `prompt` 为 null，前端不要覆盖输入框。
    """
    app, style_label = _prompt_context(body.app_key, body.style_key)
    try:
        return await image_coach.chat_prompt(
            [turn.model_dump() for turn in body.messages],
            prompt=body.prompt,
            app_label=app.label,
            style_label=style_label,
        )
    except image_coach.DescribeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


# ---- 流式探测（FR-433） ----


class ProbeBody(BaseModel):
    alias: str = "image-free"


@router.post("/stream-probe")
async def stream_probe(body: ProbeBody, session: SessionDep) -> dict:
    """探测中转是否透传流式。**会真花一次钱**，只在用户显式点击时调。

    探不通就如实报 supported=false，前端退回「状态 + 已跑秒数」。
    不透传时伪造中间帧是明令禁止的（AC-113）。
    """
    if body.alias not in imagegen.IMAGE_CAPABILITIES:
        raise HTTPException(status_code=400, detail=f"未知生图能力：{body.alias}")
    route = await _model_route(session, body.alias)
    return await image_stream.probe(body.alias, route=route)


# ---- 批量策划（FR-437） ----


class PlanBody(BaseModel):
    idea: str = Field(min_length=1, max_length=800)
    app_key: str = "text_to_image"
    max_tasks: int = Field(default=6, ge=1, le=20)


@router.post("/plan-batch")
async def plan_batch(body: PlanBody) -> dict:
    """一句话拆成若干子任务。这一步只调 LLM，不出图、不花生图的钱。"""
    try:
        tasks = await image_batch.plan_tasks(
            body.idea, app_key=body.app_key, max_tasks=body.max_tasks
        )
    except (image_batch.BatchError, image_prompts.PromptError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"tasks": tasks}


class BatchTaskBody(BaseModel):
    label: str = Field(default="", max_length=80)
    prompt_zh: str = Field(min_length=1, max_length=2000)
    ratio: str
    tier: str = "1k"
    n: int = Field(default=1, ge=1, le=imagegen.MAX_N)


class BatchRunBody(BaseModel):
    app_key: str
    tasks: list[BatchTaskBody] = Field(min_length=1, max_length=20)
    alias: str = "image-free"


@router.post("/batch", status_code=202)
async def run_batch(body: BatchRunBody, session: SessionDep) -> dict:
    """批量执行：一条任务建一行 ImageJob 入队，各自是一条 `image_gen` 管线运行。

    不新建调度：模块 12 的管线设施已经能单步重跑、能看日志，批量只是多下几单。
    """
    if body.alias not in imagegen.IMAGE_CAPABILITIES:
        raise HTTPException(status_code=400, detail=f"未知生图能力：{body.alias}")
    try:
        app = image_apps.get_app(body.app_key)
    except image_prompts.PromptError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    queue = await get_queue()
    batch_id = uuid.uuid4().hex
    deployment_id = await bound_deployment_id(session, body.alias)
    jobs: list[dict] = []
    for index, task in enumerate(body.tasks):
        # 应用锁了比例就一律用锁定值，不接受逐条覆盖
        ratio = app.ratio or task.ratio
        try:
            size = image_sizes.resolve(ratio, task.tier)
        except image_prompts.PromptError as exc:
            raise HTTPException(status_code=400, detail=f"第 {index + 1} 条：{exc}") from exc
        studio_task = new_execution_task(
            tool_id="image-console",
            operation="image.generate",
            task_type="image.generate",
            batch_id=batch_id,
            source_route=f"/image/{body.app_key}",
            source_context={"app_key": body.app_key, "batch_index": index},
            model_capability=body.alias,
            deployment_id=deployment_id,
            invocation={
                "target_key": app.target_key,
                "idea": task.prompt_zh,
                "style_key": app.style_key or app.target.default_style,
                "size": size,
                "tier": task.tier,
                "quality": app.target.quality,
                "n": task.n,
            },
        )
        job = ImageJob(
            target_key=app.target_key,
            idea=task.prompt_zh,
            style_key=app.style_key or app.target.default_style,
            size=size,
            quality=app.target.quality,
            n=task.n,
            alias=body.alias,
            status="pending",
            studio_task_id=studio_task.id,
        )
        session.add(studio_task)
        await session.flush([studio_task])
        session.add(job)
        await session.flush()
        studio_task.invocation = {
            **(studio_task.invocation or {}),
            "image_job_id": job.id,
        }
        jobs.append(
            {
                "image_job_id": job.id,
                "studio_task_id": studio_task.id,
                "label": task.label or f"第 {index + 1} 张",
                "job": job,
                "task": studio_task,
            }
        )
    await session.commit()
    for item in jobs:
        try:
            await enqueue_task(queue, item["task"])
        except Exception as exc:
            transition(
                item["task"],
                "failed",
                stage="queue",
                error=f"任务入队失败：{type(exc).__name__}: {exc}",
                retryable=True,
            )
            item["job"].status = "failed"
            item["job"].error = item["task"].error
    await session.commit()
    return {
        "batch_id": batch_id,
        "jobs": [
            {
                "image_job_id": item["image_job_id"],
                "studio_task_id": item["studio_task_id"],
                "label": item["label"],
            }
            for item in jobs
        ],
    }


# ---- 本地修图回存（FR-440 / BR-118） ----


@router.post("/local", status_code=201)
async def save_local(
    session: SessionDep,
    image: Annotated[UploadFile, File()],
    parent_id: Annotated[int | None, Form()] = None,
    op: Annotated[str, Form()] = "retouch",
    note: Annotated[str, Form()] = "",
) -> dict:
    """纯前端修图的产物回存。

    它没调模型也没花钱，所以 `source="local"`——混进用量统计会让成本归因失真。
    但**照常入库**：改完的图和生成的图一样要能被检索、复用、应用到封面。
    """
    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail="上传的图是空的")
    parent = await session.get(ImageAsset, parent_id) if parent_id else None
    try:
        row = await image_assets.ingest_one(
            session,
            data,
            target_key=parent.target_key if parent else "free",
            # 本地修图不产生新提示词，沿用父图的，注明这一环做了什么
            prompt=(parent.prompt if parent else "") or "（本地修图，无提示词）",
            style_key=parent.style_key if parent else None,
            source="local",
            parent_id=parent_id,
            op=op,
        )
    except image_assets.ImageAssetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if note:
        row.brief = {**(row.brief or {}), "local_note": note}
    if row.display_name is None and image.filename:
        row.display_name = image.filename.strip()[:160] or None
    await session.commit()
    return image_assets.asset_view(row)


# ---- 尺寸档位标定（FR-432 / AC-112） ----


class CalibrateBody(BaseModel):
    alias: str = "image-free"
    ratios: list[str] | None = None
    tier: str = "1k"


@router.post("/calibrate")
async def calibrate(body: CalibrateBody, session: SessionDep) -> dict:
    """档位标定：每档实发一张最低质量的图，把**实际返回尺寸**写回档位表。

    照抄官方文档的档位表会踩坑——实测过请求 1536x608 返回 1994x789（§14.1），
    这个中转有自己的取整规则。所以档位表以实测为准。

    **每个档位一次真实调用，会花钱**，所以要显式指定要标哪几个比例。
    """
    if body.alias not in imagegen.IMAGE_CAPABILITIES:
        raise HTTPException(status_code=400, detail=f"未知生图能力：{body.alias}")
    await image_sizes.load_measured(session)
    keys = body.ratios or list(image_sizes.RATIOS)
    if len(keys) > len(image_sizes.RATIOS):
        raise HTTPException(status_code=400, detail="比例列表超出可选范围")

    results: list[dict] = []
    route = await _model_route(session, body.alias)
    for key in keys:
        try:
            size = image_sizes.resolve(key, body.tier)
        except image_prompts.PromptError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        # 画面内容不重要，只看返回尺寸；写成纯色块最省 token 也最快
        prompt = image_prompts.ensure_canvas(
            "A plain flat solid colour field. No subject, no text, no detail.", size
        )
        try:
            result = await imagegen.render_images(
                prompt, alias=body.alias, size=size, quality="low", n=1, route=route
            )
        except imagegen.ImageGenError as exc:
            results.append(
                {
                    "ratio": key,
                    "tier": body.tier,
                    "requested": size,
                    "actual": None,
                    "error": str(exc),
                }
            )
            continue
        probe = image_assets.probe(result.images[0])
        actual = f"{probe.width}x{probe.height}"
        image_sizes.record_measured(key, body.tier, actual)
        results.append(
            {
                "ratio": key,
                "tier": body.tier,
                "requested": size,
                "actual": actual,
                "matched": actual == size,
            }
        )
    # 二十几次真实调用换来的测量，必须落库：只放内存的话重启就没了，
    # 而且 worker 是另一个进程，永远读不到
    await image_sizes.save_measured(session)
    return {
        "results": results,
        "calibrated": True,
        "tiers_effective": image_sizes.tiers_effective(),
    }


# ---- 流式出图（FR-433） ----

# 与 analyze 路由同一套：nginx 不缓冲、浏览器不缓存
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


class StreamBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=8000)
    app_key: str = "text_to_image"
    size: str = "1024x1024"
    quality: Literal["low", "medium", "high"] = image_defaults.FALLBACK_QUALITY  # type: ignore[assignment]
    alias: str = "image-free"
    partial_images: int = Field(default=2, ge=1, le=3)


@router.post("/stream")
async def stream_generate(body: StreamBody, session: SessionDep) -> StreamingResponse:
    """边出边推：每张部分图到了就推给前端，最后一条推落库后的资产。

    为什么不走队列：出图任务平时入队是对的（管线要能重跑、要有日志），但控制台里
    用户就杵在那儿等着看，中间这几帧从 worker 进程绕一圈到浏览器要另建一条推送通道，
    不划算。所以控制台的流式出图在 API 进程里直接跑，队列那条留给管线。

    **上游不透传流式就直接报错**，前端据此退回「状态 + 已跑秒数」。
    这里不做任何静默回退——用户得知道这次走的是哪条路（AC-113）。
    """
    if body.alias not in imagegen.IMAGE_CAPABILITIES:
        raise HTTPException(status_code=400, detail=f"未知生图能力：{body.alias}")
    try:
        app = image_apps.get_app(body.app_key)
        size = image_prompts.validate_size(body.size)
    except image_prompts.PromptError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    prompt = image_prompts.ensure_canvas(body.prompt, size)
    route = await _model_route(session, body.alias)

    async def events() -> AsyncGenerator[str, None]:
        queue: asyncio.Queue[dict | None] = asyncio.Queue()

        async def on_partial(part: image_stream.Partial) -> None:
            await queue.put({"index": part.index, "b64": part.b64, "size": part.size})

        async def run() -> None:
            try:
                result = await image_stream.render_streaming(
                    prompt,
                    alias=body.alias,
                    size=size,
                    quality=body.quality,
                    n=1,
                    partial_images=body.partial_images,
                    on_partial=on_partial,
                    route=route,
                    **app.fixed,
                )
            except imagegen.ImageGenError as exc:
                await queue.put({"__error__": str(exc), "kind": exc.kind})
                return
            rows = []
            for index, data in enumerate(result.images):
                rows.append(
                    await image_assets.ingest_one(
                        session,
                        data,
                        target_key=app.target_key,
                        prompt=prompt,
                        alias=body.alias,
                        model_reported=result.model_reported,
                        size_req=size,
                        quality=body.quality,
                        n_index=index,
                        usage=imagegen.usage_with_latency(result),
                        source="workbench",
                        op=app.key,
                    )
                )
            await session.commit()
            await queue.put(
                {
                    "__done__": [image_assets.asset_view(r) for r in rows],
                    "latency_ms": result.latency_ms,
                }
            )

        task = asyncio.create_task(run())
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                if "__error__" in item:
                    yield _sse("error", {"detail": item["__error__"], "kind": item["kind"]})
                    break
                if "__done__" in item:
                    yield _sse(
                        "done",
                        {"items": item["__done__"], "latency_ms": item["latency_ms"]},
                    )
                    break
                yield _sse("partial", item)
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(events(), media_type="text/event-stream", headers=SSE_HEADERS)


# ---- 自定义画风（FR-442） ----


class StyleBody(BaseModel):
    key: str = Field(min_length=2, max_length=48)
    label: str = Field(min_length=1, max_length=24)
    hint: str = Field(default="", max_length=160)
    category: str = "misc"
    render: str = Field(min_length=1, max_length=2000)
    palette: str = Field(default="", max_length=600)
    lighting: str = Field(default="", max_length=600)
    texture: str = Field(default="", max_length=600)
    avoid: list[str] = Field(default_factory=list, max_length=40)

    def to_draft(self) -> image_styles.StyleDraft:
        return image_styles.StyleDraft(
            key=self.key,
            label=self.label,
            hint=self.hint,
            category=self.category,
            render=self.render,
            palette=self.palette,
            lighting=self.lighting,
            texture=self.texture,
            extra_avoid=tuple(self.avoid),
        )


@router.get("/styles")
async def list_styles(session: SessionDep) -> dict:
    """全部画风：自制 + 导入 + 用户自定义，一次给全。

    自定义那批单独再给一份，前端要靠它区分哪些能编辑删除。
    """
    await image_styles.ensure_loaded(session)
    rows = await image_styles.list_styles(session)
    return {
        "styles": image_prompts.preset_view(),
        "categories": image_prompts.style_category_view(),
        "custom": [image_styles.view(row) for row in rows],
        "allowed_categories": list(image_styles.ALLOWED_CATEGORIES),
        "imported_count": image_prompts.IMPORTED_STYLE_COUNT,
    }


@router.post("/styles", status_code=201)
async def create_style(body: StyleBody, session: SessionDep) -> dict:
    await image_styles.ensure_loaded(session)
    try:
        row = await image_styles.create(session, body.to_draft())
    except image_prompts.PromptError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return image_styles.view(row)


@router.patch("/styles/{key}")
async def update_style(key: str, body: StyleBody, session: SessionDep) -> dict:
    try:
        row = await image_styles.update(session, key, body.to_draft())
    except image_prompts.PromptError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return image_styles.view(row)


@router.delete("/styles/{key}", status_code=204)
async def delete_style(key: str, session: SessionDep) -> Response:
    # 已经用这个风格出过的图不受影响：资产行上存的是当初渲染好的完整提示词，
    # 不是对风格的引用（BR-102）。删风格只影响之后的出图
    try:
        await image_styles.delete(session, key)
    except image_prompts.PromptError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return Response(status_code=204)

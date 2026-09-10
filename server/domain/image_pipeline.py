"""生图管线（模块 16 FR-412）：把 `imagegen` 的四步显式成可观测的节点。

按模块 12 的方式注册一个新域，公共设施（表、路由、画布）零改动（BR-35）。

为什么要有这条管线，而场景本封面又只是**一个**节点：

- 场景本管线已有八个节点，再塞六个变十四个，拓扑图就没法看了。用户在那里关心的
  是"封面出来了没、能不能重生成"，不关心提示词是第几步。
- 而"我要单独生成一张图"时，能单独重跑「写提示词」而复用前面的立意、或者改了
  尺寸只重跑「出图」，是真实有用的。

两条路调的是 `imagegen` 里的同一组函数，不存在第二份实现。
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from domain import (
    artifacts,
    image_assets,
    image_defaults,
    image_describe,
    image_prompts,
    image_sizes,
    image_styles,
    imagegen,
)

# 只为副作用导入：`image_apps` 在导入时把电商/人像/头像那批用途注册进 TARGETS。
# worker 是经 `generate_image` → 这个模块进来的，不在这里导一次的话，它看到的
# TARGETS 里没有那些用途，跑到 `get_target()` 就报「未知生图用途」——而 API 进程
# 因为路由导了 image_apps 一切正常，于是表现为「网页上能下单，任务却在后台失败」。
# 回归测试见 tests/test_image_apps.py::test_worker_import_path_sees_every_app_target
from domain import image_apps as _image_apps  # noqa: F401
from domain.model_catalog import ModelCatalogError, ResolvedModelRoute, resolve_model_route
from domain.models import ImageAsset, ImageJob, StudioTask
from domain.pipeline import (
    DomainAction,
    HealthBucket,
    HelpSection,
    PipelineDef,
    StepSpec,
    SubjectColumn,
    Tunable,
    register_pipeline,
)
from domain.storage import get_storage

logger = logging.getLogger(__name__)

DOMAIN = "image_gen"

_SIZE_OPTIONS = ("1536x608", "1024x1024", "1536x1024", "1024x1536", "1024x576")
_STYLE_OPTIONS = tuple(image_prompts.STYLE_PRESETS)
_STYLE_LABELS = tuple(p.label for p in image_prompts.STYLE_PRESETS.values())


async def _prepare_render_options(
    session: AsyncSession,
    raw_options: dict | None,
    model_route: ResolvedModelRoute | None,
) -> dict:
    """把持久化参考资产转成 ModelScope 原生 ``image_url``，其余参数原样保留。"""
    options = dict(raw_options or {})
    ref_ids = [int(value) for value in options.pop("ref_asset_ids", [])]
    if not ref_ids:
        return options
    if model_route is None or model_route.adapter_type != "modelscope":
        raise imagegen.ImageGenError(
            "binding", "生成任务的参考图输入当前只对 ModelScope adapter 开放"
        )
    encoded: list[str] = []
    storage = get_storage()
    for asset_id in ref_ids:
        asset = await session.get(ImageAsset, asset_id)
        if asset is None:
            raise imagegen.ImageGenError("input", f"参考资产不存在：{asset_id}")
        mime, b64 = image_describe._prepare(
            await storage.read(asset.storage_key), asset.mime
        )
        encoded.append(f"data:{mime};base64,{b64}")
    options["image_url"] = encoded
    return options

IMAGE_STEPS: tuple[StepSpec, ...] = (
    StepSpec(
        name="brief", label="立意", group="ingest",
        tunables=(
            Tunable("idea", "补充说明", "textarea", "",
                    hint="想强调什么、避开什么，中文即可；留空就只按主体信息来"),
        ),
        note="把主体信息交给 AI 想成具体可画的东西：「咖啡馆点单」变成吧台、"
             "意式咖啡机、糕点柜、吊挂菜单板。抽象概念画不出来，这一步就是做这个转换。",
        rerun_hint="会换一套画面构思，后面的提示词与图都跟着变",
        progress_span=(0, 20), deterministic=False, single_ok=True,
    ),
    StepSpec(
        name="prompt", label="写提示词", group="ingest", depends_on=("brief",),
        tunables=(
            Tunable("prompt", "提示词", "textarea", "",
                    hint="留空 = 自动生成。填了就直接用你写的，不再让 AI 改写"),
            Tunable("style", "风格", "select", image_prompts.DEFAULT_STYLE, _STYLE_OPTIONS,
                    option_labels=_STYLE_LABELS),
            # 默认**留空**。写 "1536x608" 的后果是 `pinned_size` 恒为非空，
            # 于是 `aspects=None if pinned_size else …` 把立意挑画幅那条路整个堵死——
            # 代码注释与需求文档都把"不指定时由立意按画面内容挑"当既定行为，
            # 而它从来没有生效过；所有没显式选尺寸的图都被按 2.53:1 超宽幅构图。
            # 那个数当初是给单词卡横幅调的，不该当全局默认。
            Tunable("size", "尺寸", "select", "", ("", *_SIZE_OPTIONS),
                    option_labels=("自动（由立意按画面内容挑）", *_SIZE_OPTIONS)),
        ),
        note="把立意套进七段式骨架，补上风格预设与构图禁区。风格由预设写死而不是"
             "让 AI 每次自由发挥——否则一批图放在一起就是大杂烩。",
        rerun_hint="只重写提示词，立意复用，不额外消耗生图额度",
        progress_span=(20, 35), single_ok=True,
    ),
    StepSpec(
        name="render", label="出图", group="ingest", depends_on=("prompt",),
        tunables=(
            Tunable(
                "quality", "质量", "select",
                image_defaults.FALLBACK_QUALITY, image_defaults.QUALITIES,
                option_labels=("低（草稿）", "中", "高（默认）"),
            ),
            Tunable("n", "张数", "number", 1, hint="按张计费，先出一张不满意再重跑更省"),
        ),
        note="经网关调生图模型。这是整条管线唯一花钱的一步。",
        rerun_hint="重新出图，按张计费；提示词不变时也会得到不同的图",
        progress_span=(35, 85), deterministic=False, single_ok=True,
    ),
    StepSpec(
        name="store", label="入库", group="enrich", depends_on=("render",),
        note="体检（能不能解析、是不是纯色）、派生展示图与缩略图、写进资产库。"
             "候选图全部入库——已经付过费了，丢掉没选中的等于白花钱。",
        rerun_hint="纯本地处理，不消耗额度",
        progress_span=(85, 95), single_ok=True,
    ),
    StepSpec(
        name="apply", label="应用", group="check", depends_on=("store",),
        tunables=(
            Tunable("asset_id", "用哪一张", "number", 0, hint="0 = 用第一张"),
        ),
        note="把选中的图写回目标（比如单词本的封面列）。自由出图没有目标，"
             "这一步会跳过，图仍然留在资产库里可以随时「应用为」。",
        skip_when="自由出图（没有指定目标）时跳过",
        progress_span=(95, 100), artifact_kind="none",
    ),
)

IMAGE_PIPELINE = PipelineDef(
    domain=DOMAIN,
    label="生图",
    subject_table="image_job",
    steps=IMAGE_STEPS,
    columns=(
        SubjectColumn("title", "任务", "text"),
        SubjectColumn("status", "状态", "status", width=96),
        SubjectColumn("images", "出图", "number", "right", 64),
        SubjectColumn("target", "用途", "text", "left", 96),
        SubjectColumn("last_run", "最近运行", "run", "left", 120),
    ),
    health=(
        HealthBucket("ready", "已出图", "ok"),
        HealthBucket("failed", "失败", "err", actionable=True),
        HealthBucket("processing", "生成中", "accent"),
        HealthBucket("pending", "待生成", "muted"),
    ),
    actions=(DomainAction("purge_candidates", "清理未使用的候选图", "normal",
                          confirm="将归档 7 天前未被采用的候选图"),),
    run_kinds=(("generate", "生成"), ("rerun", "重跑")),
    detail_route="/pipeline/image_gen/{id}",
    empty_hint="还没有生图任务，去「生图」写一句话生成第一张",
    help=(
        HelpSection(
            "这条管线在做什么",
            "把一句话变成一张能直接用的图。五步各自可以单独重跑——"
            "提示词不满意就只重跑写提示词那步，立意会原样复用，不多花钱。",
        ),
        HelpSection(
            "五步分别在干什么",
            bullets=(
                "立意：AI 把主题想成具体可画的东西",
                "写提示词：套进固定骨架，补风格与构图禁区；可以自己改写",
                "出图：调模型，整条管线唯一花钱的一步",
                "入库：体检、派生缩略图、进资产库",
                "应用：写回目标的封面列；自由出图会跳过",
            ),
        ),
        HelpSection(
            "为什么风格不让 AI 自由发挥",
            "一批图放在一起要像同一个人画的。主体由 AI 想，画风由预设写死——"
            "这个分工是列表页不变成大杂烩的唯一办法。",
        ),
        HelpSection(
            "改了提示词会重新出图吗",
            "会。改动落进节点配置，输入指纹随之改变，缓存自然不命中。"
            "反过来，你没改任何参数时重跑「出图」也会真跑——你要的就是再来一张。",
        ),
    ),
)

register_pipeline(IMAGE_PIPELINE)


# ---- 主体取数与应用：新落点接生图只需在这里加一条 ----


async def load_wordlist(session: AsyncSession, subject_id: int) -> dict:
    from domain.models import Wordlist

    row = await session.get(Wordlist, subject_id)
    if row is None:
        return {}
    return {
        "title": row.name,
        "description": row.description,
        "category": row.category,
        "cefr": row.cefr,
        "emoji": row.emoji,
    }


async def apply_wordlist_cover(session: AsyncSession, subject_id: int, asset: ImageAsset) -> None:
    from domain.models import Wordlist

    row = await session.get(Wordlist, subject_id)
    if row is None:
        return
    row.cover_key = asset.storage_key


async def load_book(session: AsyncSession, subject_id: int) -> dict:
    from domain.models import Book

    row = await session.get(Book, subject_id)
    if row is None:
        return {}
    return {"title": row.title, "author": row.author}


async def apply_book_cover(session: AsyncSession, subject_id: int, asset: ImageAsset) -> None:
    """书封写另一个 key。

    `parse_book` 会无条件把 epub 内嵌封面写回 `covers/{id}.img`（worker/tasks.py:103），
    用户点一次「重试解析」生成的封面就没了。写 `.ai.img` 两条路互不干扰，
    取封面时优先 AI 图。
    """
    from domain.models import Book
    from domain.storage import get_storage

    row = await session.get(Book, subject_id)
    if row is None:
        return
    data = await get_storage().read(asset.storage_key)
    key = f"covers/{subject_id}.ai.img"
    await image_assets.store_blob(data, key)
    row.cover_key = key


LOADERS = {"wordlist": load_wordlist, "book": load_book}
APPLIERS = {"wordlist": apply_wordlist_cover, "book": apply_book_cover}


async def load_subject(session: AsyncSession, domain: str | None, subject_id: int | None) -> dict:
    if not domain or subject_id is None:
        return {}
    loader = LOADERS.get(domain)
    return await loader(session, subject_id) if loader else {}


# ---- 执行 ----


async def _node(recorder, session, job_id, spec, config, compute, *, wanted, summary=None):
    """节点执行壳：指纹缓存 → 执行 → 落产物。与场景本管线同一套语义。"""
    shas = await artifacts.dep_shas(session, DOMAIN, job_id, spec.depends_on)
    fingerprint = artifacts.input_fingerprint(spec, dep_shas=shas, config=config)
    reusable = await artifacts.cache_hit(session, DOMAIN, job_id, spec.name, fingerprint)
    explicit = wanted is not None and spec.name in wanted
    out_of_scope = wanted is not None and spec.name not in wanted
    if reusable is not None and not explicit and (out_of_scope or spec.cacheable):
        reason = "不在本次重跑范围" if out_of_scope else "输入未变，复用产物"
        await recorder.skip(spec.name, reason)
        return reusable.payload, True

    async with recorder.step(spec.name, config) as handle:
        payload = await compute(handle)
        if spec.artifact_kind != "none":
            handle.produce(
                payload, summary=summary(payload) if callable(summary) else (summary or "")
            )
    return payload, False


async def run_image_job(
    session: AsyncSession,
    job: ImageJob,
    *,
    recorder,
    wanted: set[str] | None = None,
) -> dict:
    """跑完整条生图管线。每个节点产物落库、可单独重跑。"""
    steps = IMAGE_PIPELINE.by_name
    target = image_prompts.get_target(job.target_key)
    subject = await load_subject(session, job.subject_domain, job.subject_id)
    studio_task = (
        await session.get(StudioTask, job.studio_task_id)
        if job.studio_task_id is not None
        else None
    )
    try:
        model_route = await resolve_model_route(
            session,
            job.alias,
            deployment_id=studio_task.deployment_id if studio_task is not None else None,
        )
    except ModelCatalogError as exc:
        raise imagegen.ImageGenError("binding", str(exc)) from exc

    # ① 立意
    # 一律走 chosen：主体行上存的是用户在控制台选的值，不能被 Tunable 静态默认盖掉
    idea = str(recorder.chosen("brief", "idea", job.idea or "") or "")

    # 用户选了「不指定比例」时 job.size 是空的：让立意顺手把画幅也定了。
    # 画幅是画面的一部分（手机整屏就是竖的），交给想画面的这一步比让用户猜更对
    # 档位随 options 走：ImageJob 没有 tier 列，而「不指定比例」时又必须知道
    # 立意挑出来的比例该按哪一档解析成尺寸
    tier = str(recorder.chosen("prompt", "tier", (job.options or {}).get("tier")) or "1k")
    pinned_size = str(recorder.chosen("prompt", "size", job.size) or "").strip()

    async def do_brief(handle):
        result = await imagegen.plan_brief(
            target,
            subject,
            idea,
            aspects=None if pinned_size else image_sizes.aspect_choices(),
        )
        handle.measure(focal=result.get("focal", "")[:80], aspect=result.get("aspect") or "—")
        return result

    brief, _ = await _node(
        recorder, session, job.id, steps["brief"], {"idea": idea}, do_brief,
        wanted=wanted, summary=lambda p: (p.get("focal") or "")[:40],
    )

    # ② 写提示词
    #
    # worker 是独立进程，用户在网页上新建的自定义风格不在它的内存注册表里。
    # 不先补一次，出图就会报「未知风格预设」——网页能下单、后台失败（§14.6 同款坑）
    await image_styles.ensure_loaded(session)
    style_key = str(recorder.chosen("prompt", "style", job.style_key) or target.default_style)
    # 没钉比例就用立意挑的；它答了个不存在的 key 就退回用途默认，不让一个错 key 毁掉整张图
    # 钉了「自动」就到此为止：再去查立意挑的比例等于把"别替我决定"翻译成
    # 某个具体比例，而那正是用户选自动要避开的
    size = (
        pinned_size
        or image_sizes.size_for_aspect(str(brief.get("aspect") or ""), tier)
        or target.size
    )
    override = str(recorder.chosen("prompt", "prompt", job.prompt_override) or "").strip()

    async def do_prompt(handle):
        if override:
            # 补画布：实测上游按提示词里的比例出图而不是按 size 参数，
            # 手写提示词不补的话封面会静默变成错误比例
            text = image_prompts.ensure_canvas(override, size)
            handle.measure(source="手写", chars=len(text))
            return {"prompt": text, "structure": None, "size": size, "style": style_key}
        text, structure = image_prompts.render_prompt(
            target, brief, style_key=style_key, size=size
        )
        handle.measure(source="自动", chars=len(text), style=style_key, size=size)
        return {"prompt": text, "structure": structure, "size": size, "style": style_key}

    prompt_payload, _ = await _node(
        recorder, session, job.id, steps["prompt"],
        {"prompt": override, "style": style_key, "size": size}, do_prompt,
        wanted=wanted,
        summary=lambda p: f"{p.get('style')} · {p.get('size')}",
    )

    # ③ 出图
    quality = str(recorder.chosen("render", "quality", job.quality) or target.quality)
    n = int(recorder.chosen("render", "n", job.n) or 1)

    # 图片字节只活在这个闭包里：产物是 JSONB，塞不进去也不该塞（BR-101）。
    # 出图与入库拆成两个节点是为了可观测，字节在同一次调用内传递即可。
    rendered: list[imagegen.RenderResult] = []

    async def do_render(handle):
        options = await _prepare_render_options(session, job.options, model_route)
        result = await imagegen.render_images(
            prompt_payload["prompt"], alias=job.alias, size=prompt_payload["size"],
            quality=quality, n=n,
            output_format=str(options.pop("output_format", None) or "png"),
            background=options.pop("background", None),
            extra=options,
            route=model_route,
        )
        rendered.append(result)
        handle.measure(
            count=len(result.images), model=result.model_reported, ms=result.latency_ms
        )
        handle.log(f"出图 {len(result.images)} 张，耗时 {result.latency_ms} ms")
        return {
            "count": len(result.images),
            "model": result.model_reported,
            "usage": result.usage,
            "latency_ms": result.latency_ms,
        }

    render_meta, render_reused = await _node(
        recorder, session, job.id, steps["render"], {"quality": quality, "n": n}, do_render,
        wanted=wanted, summary=lambda p: f"{p.get('count')} 张 · {p.get('latency_ms')}ms",
    )

    # ④ 入库
    async def do_store(handle):
        rows = await imagegen.ingest(
            session, rendered[0], target=target, prompt=prompt_payload["prompt"],
            structure=prompt_payload.get("structure"), brief=brief, style_key=style_key,
            alias=job.alias, size=prompt_payload["size"], quality=quality,
            subject_domain=job.subject_domain, subject_id=job.subject_id,
            run_id=recorder.run_id, step="store", source="pipeline",
        )
        await session.flush()
        handle.measure(stored=len(rows))
        return {"asset_ids": [r.id for r in rows]}

    # 出图复用了旧产物就没有字节可入库，此时入库结果也只能跟着复用。
    # 不这么判就会拿着空列表覆盖掉上一轮真实入库的资产 id。
    if render_reused or not rendered:
        stored = await artifacts.current(session, DOMAIN, job.id, "store")
        store_payload = stored.payload if stored else {"asset_ids": []}
        await recorder.skip("store", "出图复用产物，入库结果一并复用")
    else:
        store_payload, _ = await _node(
            recorder, session, job.id, steps["store"], {}, do_store,
            wanted=wanted, summary=lambda p: f"入库 {len(p.get('asset_ids') or [])} 张",
        )

    asset_ids = list(store_payload.get("asset_ids") or [])

    # ⑤ 应用
    picked = int(recorder.cfg("apply", "asset_id", 0) or 0)
    asset_id = picked if picked in asset_ids else (asset_ids[0] if asset_ids else None)
    if not job.subject_domain or asset_id is None:
        await recorder.skip("apply", "自由出图没有应用目标")
    else:
        async with recorder.step("apply", {"asset_id": asset_id}) as handle:
            asset = await session.get(ImageAsset, asset_id)
            applier = APPLIERS.get(job.subject_domain)
            if asset is not None and applier is not None:
                await applier(session, job.subject_id, asset)
                await image_assets.mark_applied(
                    session, asset, job.subject_domain, job.subject_id
                )
                job.applied_asset_id = asset.id
                handle.measure(asset_id=asset.id, target=job.subject_domain)
                handle.log(f"已写回 {job.subject_domain} #{job.subject_id}")
            else:
                handle.log("目标不存在或该用途未注册应用函数，跳过写回")
        await session.commit()

    return {
        "job_id": job.id,
        "asset_ids": asset_ids,
        "applied_asset_id": job.applied_asset_id,
        "render": render_meta,
    }

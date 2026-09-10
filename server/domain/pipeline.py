"""管线节点定义与运行记录（需求 09 v6 FR-64~66/75/76，选型见 ADR-008）。

模型抄 Dagster 的 Run/Step 与 asset `code_version` staleness，重跑范围抄它的
step subset 语义，"重跑时改配置"抄的是它至今未做的 issue #32052。arq 不动，
只负责派活；运行记录由这里落库——arq 的 job 状态是 Redis 键存在与否派生的，
承载不了领域语义。

`PIPELINE_VERSION` 是本模块存在的首要理由：产物是哪版管线跑的必须可查。
v6 的触发故障正是 worker 跑老代码、产出静默降级而系统全无察觉。
"""

import logging
import time
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.models import PipelineRun, PipelineStep, Video, Wordlist

logger = logging.getLogger(__name__)

# 改管线就改这里：与产物上记录的版本不一致即判"陈旧"（FR-66）
PIPELINE_VERSION = "2026.08.18"

# 运行/节点状态取值，与 Dagster 一致
RUN_STATUSES = ("pending", "running", "success", "failed", "cancelled")
STEP_STATUSES = ("pending", "running", "success", "failed", "skipped")

# 重跑范围（FR-75）
SCOPES = ("single", "downstream", "failed")


@dataclass(frozen=True)
class Tunable:
    """节点可调参数（FR-76）：重跑弹窗按此渲染表单，改动落 step.config 可回溯。"""

    name: str
    label: str
    type: str  # text | number | bool | select | textarea
    default: object = None
    options: tuple[str, ...] = ()
    hint: str = ""
    # select 的中文显示名，与 options 一一对应。留空则直接显示 options 的值——
    # 风格预设那种键名（soft-flat / clean-isometric）摆在下拉里没人看得懂
    option_labels: tuple[str, ...] = ()

    def labeled_options(self) -> list[dict]:
        labels = self.option_labels or self.options
        return [
            {"value": value, "label": labels[i] if i < len(labels) else value}
            for i, value in enumerate(self.options)
        ]


@dataclass(frozen=True)
class StepSpec:
    name: str
    label: str
    group: str  # ingest | enrich | check
    depends_on: tuple[str, ...] = ()
    tunables: tuple[Tunable, ...] = ()
    note: str = ""
    # 能否只跑这一步而不动下游。转写/标点/对齐/分句重跑都会重建字幕轨与句层，
    # 而译文与词组就挂在句上，一起被清掉——这类节点只能连着下游跑（实测踩过）。
    single_ok: bool = False
    # 该节点在整体 0-100 进度里占的区间（v10.10 FR-148）。
    # download 按字节、transcribe 按音频段实时回写 video.progress，
    # 前端据此把整体进度换算成"这一步跑到哪了"，不是假的匀速条。
    progress_span: tuple[int, int] = (0, 0)
    # 节点级版本（FR-189）：改这个节点的实现就 +1。全局 PIPELINE_VERSION 太粗——
    # 改一句翻译 prompt 会让全库的下载/转写/对齐一起显示"陈旧"，噪音大到没人看。
    code_version: str = "1"
    # LLM 节点标 False：重跑结果可能不同，UI 明示且默认不级联失效下游（BR-41）
    deterministic: bool = True
    # 声明式暂停点（FR-199）：none | always | on_issues
    pause_after: str = "none"
    # 产物形态：json 进 JSONB，blob 落盘，none 表示该节点不产出可缓存产物
    artifact_kind: str = "json"
    # 输入指纹命中时可否跳过执行（FR-196）
    cacheable: bool = True
    # 重跑这一步会连带影响什么，用人话写，直接显示在重跑按钮旁（FR-252）
    rerun_hint: str = ""
    # 什么情况下这一步会被跳过；为空表示总是执行
    skip_when: str = ""


VIDEO_STEPS: tuple[StepSpec, ...] = (
    StepSpec(
        name="download", label="下载媒体", group="ingest",
        tunables=(
            Tunable("quality", "画质上限", "select", "1080",
                    ("360", "480", "720", "1080", "max")),
        ),
        note="yt-dlp 拉媒体与封面；本地导入的视频跳过此步",
        progress_span=(0, 55),
    ),
    StepSpec(
        name="probe", label="元数据", group="ingest",
        depends_on=("download",), single_ok=True,
        note="标题 / 频道 / 时长 / 封面落库",
        progress_span=(55, 58),
    ),
    StepSpec(
        name="subtitles_fetch", label="抓官方字幕", group="ingest", depends_on=("download",),
        note="官方英文字幕存在则不转写；auto 轨按 ADR-007 判定不可用",
        progress_span=(58, 60),
    ),
    StepSpec(
        name="transcribe", label="语音转写", group="ingest",
        depends_on=("subtitles_fetch",),
        tunables=(
            Tunable("whisper_model", "whisper 模型", "text", None,
                    hint="模型名或本地目录；填模型名会触发 HuggingFace 下载"),
            Tunable("beam_size", "beam size", "number", 5),
            Tunable("condition_on_previous_text", "沿袭前文", "bool", True,
                    hint="关掉快 40% 但实测丢 7.7% 词，别关（ADR-007）"),
        ),
        note="faster-whisper 句级时间戳 + VAD",
        progress_span=(60, 92),
    ),
    StepSpec(
        name="punctuate", label="标点恢复", group="ingest", depends_on=("transcribe",),
        tunables=(
            Tunable("alias", "LLM 别名", "text", "explain-standard"),
            Tunable("force", "强制重跑", "bool", False,
                    hint="绕过「标点密度足够则跳过」的自适应判定"),
        ),
        note="LLM 恢复 + 词序列一致性校验，不过则回退原文",
        progress_span=(92, 94),
    ),
    StepSpec(
        name="align", label="强制对齐", group="ingest", depends_on=("punctuate",),
        tunables=(Tunable("pad_ms", "边界外扩(ms)", "number", 200),),
        note="ctc-forced-aligner 收紧词级时间戳",
        progress_span=(94, 96),
    ),
    StepSpec(
        name="sentences", label="三级分句", group="ingest", depends_on=("align",),
        tunables=(
            Tunable("max_unit_s", "学习句时长上限(秒)", "number", 7.0),
            Tunable("max_unit_chars", "学习句字符上限", "number", 84),
            Tunable("gap_s", "切分停顿阈值(秒)", "number", 0.30),
        ),
        note="cue → 语法句 → 学习句（ADR-007 三级模型）",
        progress_span=(96, 97),
    ),
    StepSpec(
        name="translate", label="中文轨", group="ingest", depends_on=("sentences",),
        tunables=(
            Tunable("engine", "翻译引擎", "select", "auto", ("auto", "llm", "google")),
            Tunable("refresh", "忽略缓存重翻", "bool", False),
            Tunable("override_manual", "覆盖人工修改", "bool", False,
                    hint="默认保留人工改过的译文；勾选后自动结果才会盖过它们"),
        ),
        note="按语法句翻译并带素材语境（避免 the tube → 管子）",
        progress_span=(97, 99),
    ),
    StepSpec(
        name="enrich.summary", label="摘要", group="enrich",
        depends_on=("translate",), single_ok=True,
        progress_span=(99, 99),
    ),
    StepSpec(
        name="enrich.difficulty", label="难度", group="enrich",
        depends_on=("translate",), single_ok=True,
        progress_span=(99, 99),
    ),
    StepSpec(
        name="enrich.phrases", label="词组", group="enrich",
        depends_on=("translate",), single_ok=True,
        progress_span=(99, 99),
    ),
    StepSpec(
        name="enrich.vocab", label="词汇表", group="enrich",
        depends_on=("translate",), single_ok=True,
        progress_span=(99, 100),
    ),
    StepSpec(
        name="verify", label="体检与 AI 校验", group="check", single_ok=True,
        depends_on=(
            "enrich.summary", "enrich.difficulty", "enrich.phrases", "enrich.vocab",
        ),
        tunables=(
            Tunable("ai_review", "跑 AI 校验", "bool", True),
            Tunable("alias", "裁判 LLM 别名", "text", "explain-standard"),
        ),
        note="确定性体检 + LLM 无参考裁判，产出问题清单",
        progress_span=(100, 100),
    ),
)

@dataclass(frozen=True)
class HelpSection:
    """帮助浮层的一节（需求 12 FR-251）：这张图怎么读、节点在干什么。

    由域自己声明，前端只负责渲染——新增域时帮助内容跟着定义走，
    不必回头改公共组件。
    """

    title: str
    body: str = ""
    bullets: tuple[str, ...] = ()


@dataclass(frozen=True)
class SubjectColumn:
    """主体列表的一列（需求 12 FR-235）。

    前端拿到就渲染，不做任何按域分支——这是"新增域不改前端"能成立的前提。
    """

    key: str
    label: str
    kind: str = "text"  # text | number | ratio | status | chips | run | when
    align: str = "left"
    width: int | None = None


@dataclass(frozen=True)
class HealthBucket:
    """健康度分档：每个域自己定义什么算好、什么算要处理（FR-236）。

    视频的"产出不达标"与场景本的"待确认"是完全不同的东西，
    写死一套 ready/degraded/failed 两边都别扭。
    """

    key: str
    label: str
    tone: str = "muted"  # ok | warn | err | accent | muted
    # 计入"待处理"的档位会出现在全局待办条上
    actionable: bool = False


@dataclass(frozen=True)
class DomainAction:
    """域级动作：同一个按钮位，不同域挂不同动作（FR-237）。"""

    key: str
    label: str
    tone: str = "normal"  # primary | normal | danger
    confirm: str | None = None
    # 需要先看预演结果再执行（如全库修复）
    preview: bool = False


@dataclass(frozen=True)
class PipelineDef:
    """一个域的管线定义（FR-188）。

    新增域只需在 PIPELINES 里注册一份，公共设施（表、路由、画布）零改动（BR-35）。
    对齐 Dagster 的 job / Prefect 的 flow：定义在代码里，运行记录才入库。
    """

    domain: str  # 注册键，与 PipelineRun.domain 同值
    label: str
    subject_table: str  # 主体所在表，供级联清理与展示用
    steps: tuple[StepSpec, ...]
    version: str = PIPELINE_VERSION
    # ---- UI 声明（FR-235~238）：前端据此渲染，不硬编码任何域的字段名 ----
    columns: tuple[SubjectColumn, ...] = ()
    health: tuple[HealthBucket, ...] = ()
    actions: tuple[DomainAction, ...] = ()
    run_kinds: tuple[tuple[str, str], ...] = ()  # (值, 显示名)
    # 主体详情的整页路由模板，{id} 占位（FR-239）
    detail_route: str = "/pipeline/{domain}/{id}"
    empty_hint: str = ""  # 该域一个主体都没有时显示什么
    help: tuple[HelpSection, ...] = ()

    @property
    def by_name(self) -> dict[str, StepSpec]:
        return {s.name: s for s in self.steps}

    @property
    def order(self) -> dict[str, int]:
        return {s.name: i for i, s in enumerate(self.steps)}


VIDEO_PIPELINE = PipelineDef(
    domain="video",
    label="视频学习",
    subject_table="video",
    steps=VIDEO_STEPS,
    columns=(
        SubjectColumn("title", "视频", "text"),
        SubjectColumn("status", "状态", "status", width=96),
        SubjectColumn("sentences", "句数", "number", "right", 72),
        SubjectColumn("translated", "译文", "ratio", "right", 96),
        SubjectColumn("issues", "问题", "chips", "left", 88),
        SubjectColumn("last_run", "最近运行", "run", "left", 120),
    ),
    health=(
        HealthBucket("ready", "就绪", "ok"),
        HealthBucket("degraded", "产出不达标", "warn", actionable=True),
        HealthBucket("failed", "失败", "err", actionable=True),
        HealthBucket("processing", "处理中", "accent"),
        HealthBucket("pending", "待处理", "muted"),
    ),
    actions=(
        DomainAction("autofix_all", "一键修复全部", "primary", preview=True),
        DomainAction("verify_all", "重新体检", "normal"),
    ),
    run_kinds=(("ingest", "入库"), ("enrich", "AI 加工"), ("repair", "AI 修复")),
    detail_route="/video/{id}/pipeline",
    empty_hint="还没有视频，去「视频学习」订阅频道或粘贴链接导入",
    help=(
        HelpSection(
            "这张图是一次运行",
            "展示的是某一次运行实际做了什么，不是这条视频的全部历史。"
            "入库是一次全量运行，之后每次重跑、每次体检都是独立的一次，顶部可切换。",
        ),
        HelpSection(
            "为什么有的节点是灰的",
            "灰 + 虚线边表示本次运行没执行它，不是出错。"
            "比如单独「重新体检」的运行只会点亮最后一个节点。"
            "灰节点下方会标注它最近一次真实执行，点开可跳过去看。",
        ),
        HelpSection(
            "节点颜色",
            bullets=(
                "绿点 · 左绿边：本次执行成功",
                "蓝点闪烁：正在执行，页面会自动跟着刷新",
                "红：执行失败，点开节点能看到错误与日志",
                "顶部黄条 + 「陈旧」：产物是旧版管线生成的，建议重跑",
            ),
        ),
        HelpSection(
            "重跑的三种范围",
            bullets=(
                "这一步及后面全部：改了上游，后面的产物必须跟着重建（最常用）",
                "只重算这一步：后面的节点沿用旧产物，会标记为陈旧提醒你看差异",
                "所有失败的：从每个失败处往后补跑",
            ),
        ),
        HelpSection(
            "人工改过的内容不会被覆盖",
            "手动改过的译文会被记住，之后重跑翻译会自动跳过它们。"
            "确实想让 AI 结果盖过去时，在重跑弹窗里勾「覆盖人工修改」。",
        ),
        HelpSection(
            "问题清单与 AI 修复",
            "「问题」里有两类：体检问题由确定性规则查出并指明该重跑哪个节点；"
            "AI 校验问题由大模型逐句挑错。带建议的可直接采纳并写回字幕，"
            "拿不准的转给修复代理用自然语言沟通。",
        ),
    ),
)

PIPELINES: dict[str, PipelineDef] = {"video": VIDEO_PIPELINE}


def get_pipeline(domain: str) -> PipelineDef:
    """按域取管线定义；未知域回落视频管线，避免历史调用点炸掉。"""
    return PIPELINES.get(domain, VIDEO_PIPELINE)


def register_pipeline(definition: PipelineDef) -> None:
    PIPELINES[definition.domain] = definition


# 视频管线的模块级别名：现有调用点（worker/路由）继续可用，逐步迁移到按域取
STEPS: tuple[StepSpec, ...] = VIDEO_STEPS
STEP_BY_NAME: dict[str, StepSpec] = VIDEO_PIPELINE.by_name
STEP_ORDER: dict[str, int] = VIDEO_PIPELINE.order
ENRICH_STEP_NAMES: tuple[str, ...] = tuple(s.name for s in VIDEO_STEPS if s.group == "enrich")


def descendants(name: str, domain: str = "video") -> list[str]:
    """该节点的全部下游（传递闭包），按管线顺序返回。"""
    pipeline = get_pipeline(domain)
    order = pipeline.order
    out: set[str] = set()
    frontier = {name}
    while frontier:
        nxt = {
            s.name
            for s in pipeline.steps
            if set(s.depends_on) & frontier and s.name not in out
        }
        out |= nxt
        frontier = nxt
    return sorted(out, key=lambda n: order[n])


def resolve_scope(
    from_step: str, scope: str, failed: list[str] | None = None, domain: str = "video"
) -> list[str]:
    """(起点, 范围) → 本次要跑的节点名列表（FR-75）。

    single 只重算该节点产物，下游标记陈旧但不执行（FR-202）；downstream 连同
    全部下游；failed 跑所有失败节点及其下游。
    """
    order = get_pipeline(domain).order
    if scope == "failed":
        names: set[str] = set()
        for step in failed or []:
            names.add(step)
            names.update(descendants(step, domain))
        return sorted(names, key=lambda n: order[n])
    if scope == "single":
        return [from_step]
    return [from_step, *descendants(from_step, domain)]


def spec_view(spec: StepSpec) -> dict:
    return {
        "name": spec.name,
        "label": spec.label,
        "group": spec.group,
        "depends_on": list(spec.depends_on),
        "note": spec.note,
        "single_ok": spec.single_ok,
        "progress_span": list(spec.progress_span),
        "rerun_hint": spec.rerun_hint,
        "skip_when": spec.skip_when,
        "code_version": spec.code_version,
        "deterministic": spec.deterministic,
        "pause_after": spec.pause_after,
        "cacheable": spec.cacheable,
        "tunables": [
            {
                "name": t.name, "label": t.label, "type": t.type,
                "default": t.default, "options": list(t.options), "hint": t.hint,
                "choices": t.labeled_options(),
            }
            for t in spec.tunables
        ],
    }


def catalog(domain: str = "video") -> list[dict]:
    """节点目录：前端画 DAG 与渲染重跑表单的唯一事实源。"""
    return [spec_view(s) for s in get_pipeline(domain).steps]


def pipeline_catalog() -> list[dict]:
    """全部已注册管线：管线中心按域分区的数据源（FR-214）。"""
    return [
        {
            "domain": p.domain,
            "label": p.label,
            "subject_table": p.subject_table,
            "version": p.version,
            "steps": [spec_view(s) for s in p.steps],
        }
        for p in PIPELINES.values()
    ]


# 未收口的 run 状态：节点行还会变，SSE 每轮都要重看
LIVE_RUN_STATUSES = ("pending", "running")


def _bind_time(value: datetime) -> datetime:
    """带时区的参数先换算到 UTC：SQLite 存的是无时区 UTC 串，直接绑定会按本地偏移比错。"""
    return value.astimezone(UTC) if value.tzinfo is not None else value


async def list_pipeline_runs_updated_since(
    session: AsyncSession,
    *,
    since: datetime,
    limit: int = 200,
) -> list[PipelineRun]:
    """自 ``since`` 起新建或收口的运行，加上所有未收口的运行；供 SSE 推 pipeline 帧。

    ``PipelineRun`` 没有 updated_at：run 行只在开始与结束时写，中途的变化全落在
    ``PipelineStep`` 上。按节点时间列扫窗口要全表看 pipeline_step，这里换个便宜的
    口径——活跃 run 才会有节点在变（走 ``ix_pipeline_run_status`` 索引，量级是个位数），
    每轮全量取回交给快照去重；收口那一刻靠 finished_at 落进窗口补上最后一帧。
    """
    bound = _bind_time(since)
    stmt = (
        select(PipelineRun)
        .where(
            or_(
                PipelineRun.status.in_(LIVE_RUN_STATUSES),
                PipelineRun.created_at >= bound,
                PipelineRun.started_at >= bound,
                PipelineRun.finished_at >= bound,
            )
        )
        .order_by(PipelineRun.id)
        .limit(max(1, min(limit, 500)))
    )
    return list((await session.execute(stmt)).scalars())


def _run_progress(spec: PipelineDef, steps: Sequence[PipelineStep]) -> int:
    """按节点 progress_span 折算整体进度；管线没声明区间时按步数比例。"""
    by_name = spec.by_name
    best = 0
    spanned = False
    for step in steps:
        step_spec = by_name.get(step.name)
        if step_spec is None or step_spec.progress_span == (0, 0):
            continue
        spanned = True
        low, high = step_spec.progress_span
        if step.status in ("success", "skipped"):
            best = max(best, high)
        elif step.status in ("running", "failed"):
            best = max(best, low)
    if spanned:
        return best
    done = sum(1 for step in steps if step.status in ("success", "skipped"))
    return round(done / max(len(spec.steps), 1) * 100)


def pipeline_run_view(
    run: PipelineRun,
    steps: Sequence[PipelineStep],
    *,
    title: str | None = None,
    subject_progress: int | None = None,
) -> dict:
    """SSE pipeline 帧正文：单条 run 快照，字段对齐 /api/pipeline/stream 的 ActiveItem。

    在 ActiveItem 之上多带 run 的谱系字段（kind/trigger/from_step/scope/parent_run_id）
    与节点摘要 ``steps``；``status`` 是 **run 状态**（pending|running|success|failed|
    cancelled），是否还在跑看 ``live``。同名步骤多次 attempt 只留最新一次。
    """
    spec = get_pipeline(run.domain)
    latest: dict[str, PipelineStep] = {}
    for step in sorted(steps, key=lambda s: (s.ordinal, s.attempt, s.id or 0)):
        latest[step.name] = step
    ordered = sorted(latest.values(), key=lambda s: (s.ordinal, s.name))
    running = next((s for s in ordered if s.status == "running"), None)
    failed = [s.name for s in ordered if s.status == "failed"]
    done = sum(1 for s in ordered if s.status in ("success", "skipped"))
    live = run.status in LIVE_RUN_STATUSES
    if run.status == "success":
        progress = 100
    elif live and subject_progress is not None:
        # 视频域的 download/transcribe 会实时回写 Video.progress，比按节点折算细
        progress = max(0, min(int(subject_progress), 100))
    else:
        progress = _run_progress(spec, ordered)
    running_spec = spec.by_name.get(running.name) if running else None
    return {
        "run_id": run.id,
        "domain": run.domain,
        "subject_id": run.subject_id,
        # ActiveItem 的主体列就叫 video_id（非视频域填 subject_id），保持同名好复用类型
        "video_id": run.subject_id,
        "kind": run.kind,
        "trigger": run.trigger,
        "status": run.status,
        "live": live,
        "title": title or f"#{run.subject_id}",
        "progress": progress,
        "error": run.error,
        "error_kind": next(
            (s.error_kind for s in ordered if s.status == "failed" and s.error_kind), None
        ),
        "parent_run_id": run.parent_run_id,
        "from_step": run.from_step,
        "scope": run.scope,
        "code_version": run.code_version,
        "current_step": running.name if running else None,
        "current_label": (
            running_spec.label if running_spec else (running.name if running else None)
        ),
        "failed_steps": failed,
        "done_steps": done,
        "total_steps": len(spec.steps),
        "steps": [
            {
                "name": s.name,
                "label": spec.by_name[s.name].label if s.name in spec.by_name else s.name,
                "status": s.status,
                "ordinal": s.ordinal,
                "attempt": s.attempt,
                "duration_ms": s.duration_ms,
                "error_kind": s.error_kind,
            }
            for s in ordered
        ],
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
    }


async def pipeline_run_snapshots(
    session: AsyncSession, runs: Sequence[PipelineRun]
) -> list[dict]:
    """批量组装 run 快照：一次取回节点行与主体标题，逐条喂给 :func:`pipeline_run_view`。"""
    if not runs:
        return []
    step_rows = list(
        (
            await session.execute(
                select(PipelineStep).where(PipelineStep.run_id.in_([r.id for r in runs]))
            )
        ).scalars()
    )
    steps_by_run: dict[int, list[PipelineStep]] = {}
    for step in step_rows:
        steps_by_run.setdefault(step.run_id, []).append(step)
    titles: dict[tuple[str, int], str] = {}
    video_progress: dict[int, int] = {}
    video_ids = [r.subject_id for r in runs if r.domain == "video"]
    deck_ids = [r.subject_id for r in runs if r.domain == "scenario_deck"]
    if video_ids:
        for vid, vtitle, title_zh, progress in (
            await session.execute(
                select(Video.id, Video.title, Video.title_zh, Video.progress).where(
                    Video.id.in_(video_ids)
                )
            )
        ).all():
            titles[("video", vid)] = title_zh or vtitle or f"视频 {vid}"
            video_progress[vid] = progress or 0
    if deck_ids:
        for wid, name, emoji in (
            await session.execute(
                select(Wordlist.id, Wordlist.name, Wordlist.emoji).where(
                    Wordlist.id.in_(deck_ids)
                )
            )
        ).all():
            titles[("scenario_deck", wid)] = f"{emoji or '📘'} {name}"
    return [
        pipeline_run_view(
            run,
            steps_by_run.get(run.id, []),
            title=titles.get((run.domain, run.subject_id)),
            subject_progress=(
                video_progress.get(run.subject_id) if run.domain == "video" else None
            ),
        )
        for run in runs
    ]


@dataclass
class StepHandle:
    """节点执行期的收集器：metrics 记做了什么，config 记用了什么。"""

    name: str
    config: dict = field(default_factory=dict)
    metrics: dict = field(default_factory=dict)
    lines: list[str] = field(default_factory=list)
    # 节点产物（FR-195）：不设则用 metrics 兜底，够判断"上游变没变"
    artifact: object = None
    # 产物内容指纹，下游据此判断是否真的需要重跑；不设则由 payload 计算
    content_key: str | None = None
    summary: str | None = None

    def produce(self, payload: object, *, key: str | None = None, summary: str = "") -> None:
        """声明本节点的产物。

        视频管线的真实产物落在领域表（subtitle_cue / subtitle_sentence），
        这里存的是摘要与内容指纹——用途是判断上游变没变，不是复制一份数据。
        """
        self.artifact = payload
        if key is not None:
            self.content_key = key
        if summary:
            self.summary = summary

    def log(self, message: str) -> None:
        stamp = datetime.now(UTC).strftime("%H:%M:%S")
        self.lines.append(f"{stamp} {message}")
        logger.info("[%s] %s", self.name, message)

    def measure(self, **values: object) -> None:
        self.metrics.update({k: v for k, v in values.items() if v is not None})


class PipelineRecorder:
    """一次运行的记录器：每个 with 块自动落 started/finished/status/error/metrics。

    每次写库都开独立 session——worker 里长事务会把连接占死，而节点动辄几分钟。
    """

    def __init__(self, run_id: int, subject_id: int, session_factory,
                 config_override: dict | None = None, domain: str = "video") -> None:
        self.run_id = run_id
        self.subject_id = subject_id
        self.domain = domain
        # 视频域调用点仍读 recorder.video_id，保留为别名避免大范围改写
        self.video_id = subject_id
        self._sf = session_factory
        self.overrides = config_override or {}
        self.failed: list[str] = []
        self.succeeded: list[str] = []

    @property
    def spec(self) -> PipelineDef:
        return get_pipeline(self.domain)

    @classmethod
    async def start(
        cls, session_factory, subject_id: int, *, kind: str = "ingest",
        trigger: str = "user", from_step: str | None = None, scope: str | None = None,
        config_override: dict | None = None, parent_run_id: int | None = None,
        domain: str = "video",
    ) -> "PipelineRecorder":
        async with session_factory() as session:
            run = PipelineRun(
                domain=domain,
                subject_id=subject_id,
                # video_id 只在视频域填，其它域为空（级联删除专用，FR-192）
                video_id=subject_id if domain == "video" else None,
                kind=kind, trigger=trigger, status="running",
                from_step=from_step, scope=scope, config_override=config_override or None,
                code_version=PIPELINE_VERSION, parent_run_id=parent_run_id,
                started_at=datetime.now(UTC),
            )
            session.add(run)
            await session.commit()
            await session.refresh(run)
        return cls(run.id, subject_id, session_factory, config_override, domain)

    def cfg(self, step_name: str, key: str, default: object = None) -> object:
        """取该节点的配置覆盖，没有就用 Tunable 默认值，再没有用调用方给的。

        给「主体行上没有这个参数」的域用——视频域的节点参数只活在重跑表单里，
        Tunable 默认就是唯一的兜底。主体行上存着用户选择的域要用 `chosen()`。
        """
        override = self.override(step_name, key)
        if override is not None:
            return override
        spec = self.spec.by_name.get(step_name)
        if spec is not None:
            for tunable in spec.tunables:
                if tunable.name == key and tunable.default is not None:
                    return tunable.default
        return default

    def override(self, step_name: str, key: str) -> object | None:
        """只取本次重跑的显式覆盖，没有返回 None。"""
        value = (self.overrides.get(step_name) or {}).get(key)
        return None if value is None or value == "" else value

    def chosen(self, step_name: str, key: str, stored: object = None) -> object:
        """节点参数：**重跑时的显式覆盖 > 主体上存着的用户选择 > Tunable 默认值**。

        > [!danger] 与 `cfg()` 的差别就在中间那一层，而这一层曾经漏掉过
        >
        > 生图的主体行 `image_job` 本身就记着用户在控制台选的尺寸、风格、质量、张数。
        > 用 `cfg()` 取的话，Tunable 的静态默认值排在主体之前，用户选什么都会被
        > `soft-flat` / `1536x608` 盖掉——**任务行里存的是对的，出的图却不是**，
        > 而且两边都不报错。实测过一次：选了 4K 16:9 + 剪影摄影风，出来的是
        > 1994x789 的柔和扁平插画。
        """
        override = self.override(step_name, key)
        if override is not None:
            return override
        if stored is not None and stored != "":
            return stored
        spec = self.spec.by_name.get(step_name)
        if spec is not None:
            for tunable in spec.tunables:
                if tunable.name == key and tunable.default is not None:
                    return tunable.default
        return None

    async def _write(self, name: str, **fields) -> None:
        async with self._sf() as session:
            row = (
                await session.execute(
                    select(PipelineStep)
                    .where(PipelineStep.run_id == self.run_id, PipelineStep.name == name)
                    .order_by(PipelineStep.attempt.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            if row is None:
                row = PipelineStep(
                    run_id=self.run_id, name=name,
                    ordinal=self.spec.order.get(name, 99),
                    code_version=PIPELINE_VERSION,
                )
                session.add(row)
            for key, value in fields.items():
                setattr(row, key, value)
            await session.commit()

    @asynccontextmanager
    async def step(self, name: str, config: dict | None = None) -> AsyncIterator[StepHandle]:
        handle = StepHandle(name=name, config=dict(config or {}))
        await self._write(name, status="running", started_at=datetime.now(UTC),
                          error=None, error_kind=None)
        started = time.monotonic()
        try:
            yield handle
        except Exception as exc:
            from domain.video_source import classify_download_error

            self.failed.append(name)
            await self._write(
                name, status="failed", finished_at=datetime.now(UTC),
                duration_ms=int((time.monotonic() - started) * 1000),
                error=f"{type(exc).__name__}: {exc}"[:2000],
                error_kind=classify_download_error(str(exc)),
                metrics=handle.metrics or None, config=handle.config or None,
                logs="\n".join(handle.lines)[:8000] or None,
            )
            raise
        self.succeeded.append(name)
        await self._write(
            name, status="success", finished_at=datetime.now(UTC),
            duration_ms=int((time.monotonic() - started) * 1000),
            metrics=handle.metrics or None, config=handle.config or None,
            logs="\n".join(handle.lines)[:8000] or None,
        )
        await self._record_artifact(handle)

    async def _record_artifact(self, handle: "StepHandle") -> None:
        """落节点产物（FR-195）。产物层是分步重跑的前提，失败不该拖垮主流程。"""
        spec = self.spec.by_name.get(handle.name)
        if spec is None or spec.artifact_kind == "none":
            return
        payload = handle.artifact if handle.artifact is not None else (handle.metrics or {})
        if not payload:
            return
        from domain import artifacts

        try:
            async with self._sf() as session:
                shas = await artifacts.dep_shas(
                    session, self.domain, self.subject_id, spec.depends_on
                )
                await artifacts.record(
                    session,
                    domain=self.domain,
                    subject_id=self.subject_id,
                    step=handle.name,
                    payload=payload,
                    input_fp=artifacts.input_fingerprint(
                        spec, dep_shas=shas, config=handle.config
                    ),
                    run_id=self.run_id,
                    code_version=spec.code_version,
                    summary=handle.summary,
                    content_key=handle.content_key,
                )
                await session.commit()
        except Exception as exc:  # noqa: BLE001
            logger.warning("[%s] 产物落库失败：%s", handle.name, exc)

    async def skip(self, name: str, reason: str) -> None:
        await self._write(
            name, status="skipped", finished_at=datetime.now(UTC),
            logs=f"跳过：{reason}", metrics=None,
        )

    async def finish(self, status: str, error: str | None = None) -> None:
        async with self._sf() as session:
            run = await session.get(PipelineRun, self.run_id)
            if run is not None:
                run.status = status
                run.finished_at = datetime.now(UTC)
                run.error = (error or None) and error[:2000]
                await session.commit()

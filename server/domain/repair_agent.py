"""AI 修复代理（需求 09 v7 FR-85~90，选型见 ADR-008 增补）。

PydanticAI 单代理 + 有界工具箱：把自然语言的问题描述翻译成受控领域操作的调用
序列。**绝不生成任意代码/SQL 进生产**（BR-27）——每个工具都是项目里已验证的
领域函数，全参数校验、全审计（repair_action）、失败可重试。

模型走能力名（默认 `repair-agent`，配置中心可绑定与 fallback），
换更强模型重试 = 新会话携带原上下文（FR-89）。

高危操作（整片重转写、删字幕轨）走确认门（BR-25）：工具不直接执行，把动作挂到
session.pending_action，用户确认后由下一轮代理执行。
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field

from pydantic_ai import Agent, RunContext
from pydantic_ai.messages import ModelMessage, ModelMessagesTypeAdapter, ModelResponse
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.settings import ModelSettings

from domain import gateway
from domain.model_invocations import ModelInvocationSpan
from domain.model_runtime import PreparedChatRoute
from domain.models import RepairAction, RepairSession, SubtitleIssue, SubtitleSentence
from domain.pipeline import STEP_BY_NAME, resolve_scope

logger = logging.getLogger(__name__)

DEFAULT_ALIAS = "repair-agent"
FALLBACK_ALIAS = "explain-standard"  # repair-agent 未在配置中心绑定时的回退

# 高危工具动作，跑之前要用户确认一次（BR-25）。**两类原因必须分开说**——
# 拿「开销大」的文案去描述会删数据的操作，等于给了错的说明，比不说更坏。

#: 开销高：整片重下载 / 重转写，十几分钟 CPU 起步
COSTLY_STEPS = ("download", "transcribe")

#: 破坏性：重建句层的第一句就是 `delete(SubtitleSentence)`（worker/tasks.py），
#: 而 study_unit_state（已学✓/收藏/旗标/听写成绩）与 shadow_recording
#: （录音 + 逐词比对 + AI 点评）都是 ondelete=CASCADE，一次重跑把用户攒下的
#: 学习痕迹一起删光，不可撤销，磁盘上的录音还会变成孤儿。
#: 重跑 scope 是 downstream，所以句层**上游**的 punctuate/align 同样连带重建。
#: 现在 `build_sentence_layer` 会按归一化词序列把这些记录迁到新句（domain.sentence_migration，
#: 实测落点命中 99.8%），门仍然要留：译文与词组照样清空，迁不过去的那部分照样丢。
#: 确认文案还是按「全丢」写的，偏保守——真要改口径，`confirm_reason` 与其单测一起改。
DESTRUCTIVE_STEPS = ("punctuate", "align", "sentences")

RISKY_STEPS = COSTLY_STEPS + DESTRUCTIVE_STEPS


def confirm_reason(from_step: str) -> str:
    """确认卡上告诉用户「为什么要拦这一下」。破坏性的要点名会丢什么。"""
    label = STEP_BY_NAME[from_step].label
    if from_step in DESTRUCTIVE_STEPS:
        # 文案随迁移上线改过口径：以前是「一并删除且无法恢复」，那在
        # sentence_migration 落地后已经不成立（实测 99.8% 能迁回新句）。
        # **说重了同样是错的说明**——用户会以为动不得，从此不敢调断句。
        # 但门要留着：迁移是尽力而为，译文与词组确实会清空。
        return (
            f"「{label}」会重建句层：译文与词组会清空需要重新生成；"
            "已标的「听懂了 ✓」、收藏、听写成绩与跟读录音会尽量迁到新句上，"
            "迁不过去的会列进问题清单"
        )
    return f"「{label}」是高开销操作（整片重新处理，以分钟计）"

_SYSTEM = """你是英语学习平台的字幕管线修复专家。用户会用口语描述视频字幕的问题
（转写错词、断句不准、句子切得太碎或黏成一团、译文不对、噪声残留等），你的职责：

1. **先看清再动手**：用 inspect_video / list_sentences / get_step_info 查证问题
   是否属实、波及范围多大。不确定用户指哪句时，报出候选句让用户确认。
2. **小问题就地修**：个别句子的错词/断句用 edit_sentence / merge_sentences /
   split_sentence 修；不要为两三句话重跑整条管线。
   **重复句、纯口水句用 mark_noise 移出学习链路**（软删除，标了就不再出现在字幕
   列表、播放序列与校验里，误判可撤销）；不要试图靠合并/改写去消除重复，
   也不要因为"没有删除工具"就说修不了。
3. **系统性问题重跑对应节点**：大面积断句碎/黏 → rerun_pipeline(sentences, 调阈值)；
   标点缺失 → rerun_pipeline(punctuate, force=true)；译文整体不对 →
   rerun_pipeline(translate, refresh=true)。参数含义见工具描述。
4. **修完必须验证**：所有修改完成后调 run_verify，把前后指标对比讲给用户
   （句数、超限数、译文覆盖、体检结论）。
5. **诚实**：工具箱解决不了的（比如需要重训模型、音频本身有问题），直说原因，
   并建议用户换更强的模型重试或人工处理。绝不假装修好了。

规则：
- 回复用中文，简洁直接；动手前用一句话说明你要做什么，不需要用户批准（高危操作
  系统会自动拦下要求确认，你无需自己判断）。
- 修改英文原文会自动清空该句译文与词组，属预期行为，验证阶段会重新补齐。
- 一次回复里可以连续调用多个工具；把相关修改攒在一起做完再 run_verify。"""


@dataclass
class RepairDeps:
    """代理运行期依赖：会话上下文 + 工具执行所需的一切。"""

    session_id: int
    video_id: int
    step_name: str | None
    session_factory: object  # SessionFactory，避免顶层循环导入
    ctx: dict = field(default_factory=dict)  # arq ctx（含 redis），传给管线任务
    confirmed_action: dict | None = None  # 用户已确认的高危动作（本轮可直接执行）


class LoggedRepairModel(OpenAIChatModel):
    """PydanticAI 的上游边界：Agent 每一次模型请求都单独记账。"""

    def __init__(self, alias: str, route: PreparedChatRoute) -> None:
        self._capability = alias
        self._runtime_route = route
        super().__init__(
            route.snapshot.model,
            provider=OpenAIProvider(
                base_url=route.snapshot.base_url,
                api_key=route.secrets.get("api_key") or "not-required",
                http_client=gateway.http_client(180.0, route.snapshot.base_url),
            ),
        )

    async def request(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
    ) -> ModelResponse:
        route = self._runtime_route.snapshot
        span = await ModelInvocationSpan(
            plugin_id=route.plugin_id,
            plugin_version=route.plugin_version,
            plugin_generation=route.plugin_generation,
            runtime_generation=route.runtime_generation,
            operation="chat.complete",
            model=route.model,
            capability=self._capability,
            deployment_id=route.deployment_id,
            request={
                "messages": ModelMessagesTypeAdapter.dump_python(messages, mode="json"),
                "tools": [
                    getattr(tool, "name", type(tool).__name__)
                    for tool in model_request_parameters.function_tools
                ],
                "route": route.view(),
            },
        ).start()
        try:
            response = await super().request(
                messages,
                model_settings,
                model_request_parameters,
            )
        except asyncio.CancelledError as exc:
            await span.fail(exc, status="cancelled")
            raise
        except BaseException as exc:
            await span.fail(exc)
            raise
        await span.succeed(
            model=response.model_name or route.model,
            response={
                "text": response.text,
                "part_types": [type(part).__name__ for part in response.parts],
                "finish_reason": response.finish_reason,
            },
            usage=dict(vars(response.usage)),
            provider_request_id=response.provider_response_id,
        )
        return response


def build_model(alias: str, route: PreparedChatRoute) -> OpenAIChatModel:
    return LoggedRepairModel(alias, route)


async def _audit(deps: RepairDeps, tool: str, args: dict, coro) -> dict:
    """工具执行的统一外壳：落审计行、计时、异常转结构化错误（FR-88）。"""
    async with deps.session_factory() as session:
        action = RepairAction(session_id=deps.session_id, tool=tool, args=args or None)
        session.add(action)
        await session.commit()
        await session.refresh(action)
        action_id = action.id
    started = time.monotonic()
    try:
        result = await coro
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"[:800]
        async with deps.session_factory() as session:
            row = await session.get(RepairAction, action_id)
            if row is not None:
                row.status = "failed"
                row.error = message
                row.duration_ms = int((time.monotonic() - started) * 1000)
                await session.commit()
        logger.warning("修复工具 %s 失败：%s", tool, message)
        return {"ok": False, "error": message}
    async with deps.session_factory() as session:
        row = await session.get(RepairAction, action_id)
        if row is not None:
            row.status = "success"
            row.result = result if isinstance(result, dict) else {"value": result}
            row.duration_ms = int((time.monotonic() - started) * 1000)
            await session.commit()
    return {"ok": True, **(result if isinstance(result, dict) else {"value": result})}


def build_agent(alias: str, route: PreparedChatRoute) -> Agent[RepairDeps, str]:
    agent: Agent[RepairDeps, str] = Agent(
        build_model(alias, route),
        deps_type=RepairDeps,
        system_prompt=_SYSTEM,
        model_settings=ModelSettings(temperature=0.2),
        retries=1,
    )

    @agent.tool
    async def inspect_video(ctx: RunContext[RepairDeps]) -> dict:
        """体检当前视频：句数、超限数、译文覆盖、对齐引擎、未决问题清单等。"""
        from domain.pipeline_health import inspect

        async def run() -> dict:
            async with ctx.deps.session_factory() as session:
                report = await inspect(session, ctx.deps.video_id)
                issues = (await session.execute(_issues_stmt(ctx.deps.video_id))).scalars().all()
            return {
                "gate": report["gate"],
                "metrics": report["metrics"],
                "health_issues": report["issues"],
                "open_issues": [
                    {
                        "id": i.id,
                        "sentence_id": i.sentence_id,
                        "kind": i.kind,
                        "severity": i.severity,
                        "detail": i.detail,
                        "suggestion": i.suggestion,
                    }
                    for i in issues
                ][:30],
            }

        return await _audit(ctx.deps, "inspect_video", {}, run())

    @agent.tool
    async def list_sentences(
        ctx: RunContext[RepairDeps], start_ordinal: int = 0, count: int = 30
    ) -> dict:
        """按序号段读语法句（含 id、时间、英文、译文），用于定位用户说的句子。"""

        async def run() -> dict:
            from sqlalchemy import select

            from domain.models import SubtitleTrack

            async with ctx.deps.session_factory() as session:
                track = (
                    (
                        await session.execute(
                            select(SubtitleTrack).where(
                                SubtitleTrack.video_id == ctx.deps.video_id,
                                SubtitleTrack.kind.in_(("whisper", "official")),
                            )
                        )
                    )
                    .scalars()
                    .first()
                )
                if track is None:
                    return {"sentences": [], "note": "无英文字幕轨"}
                rows = (
                    (
                        await session.execute(
                            select(SubtitleSentence)
                            .where(
                                SubtitleSentence.track_id == track.id,
                                SubtitleSentence.ordinal >= start_ordinal,
                            )
                            .order_by(SubtitleSentence.ordinal)
                            .limit(max(1, min(count, 60)))
                        )
                    )
                    .scalars()
                    .all()
                )
            return {
                "track_id": track.id,
                "sentences": [
                    {
                        "id": r.id,
                        "ordinal": r.ordinal,
                        "start_s": round(r.start_ms / 1000, 1),
                        "text": r.text,
                        "text_zh": r.text_zh,
                        "chars": len(r.text),
                        "is_noise": r.is_noise,
                    }
                    for r in rows
                ],
            }

        return await _audit(
            ctx.deps,
            "list_sentences",
            {"start_ordinal": start_ordinal, "count": count},
            run(),
        )

    @agent.tool
    async def get_step_info(ctx: RunContext[RepairDeps], step: str) -> dict:
        """看最近一次运行中某节点的 metrics 与 config（如 punctuate 的通过率）。"""

        async def run() -> dict:
            from sqlalchemy import select

            from domain.models import PipelineRun, PipelineStep

            async with ctx.deps.session_factory() as session:
                row = (
                    (
                        await session.execute(
                            select(PipelineStep)
                            .join(PipelineRun, PipelineRun.id == PipelineStep.run_id)
                            .where(
                                PipelineRun.video_id == ctx.deps.video_id,
                                PipelineStep.name == step,
                                PipelineStep.status.in_(("success", "failed")),
                            )
                            .order_by(PipelineStep.id.desc())
                            .limit(1)
                        )
                    )
                    .scalars()
                    .first()
                )
            if row is None:
                return {"note": f"没有 {step} 的执行记录"}
            return {
                "status": row.status,
                "metrics": row.metrics or {},
                "config": row.config or {},
                "error": row.error,
            }

        return await _audit(ctx.deps, "get_step_info", {"step": step}, run())

    @agent.tool
    async def edit_sentence(
        ctx: RunContext[RepairDeps],
        sentence_id: int,
        text: str | None = None,
        text_zh: str | None = None,
    ) -> dict:
        """改一句的英文原文和/或中文译文。改英文会自动重建学习句并清译文词组。"""
        from domain.sentence_ops import rewrite_sentence

        async def run() -> dict:
            async with ctx.deps.session_factory() as session:
                out = await rewrite_sentence(session, sentence_id, text, text_zh)
                await session.commit()
                return out

        return await _audit(
            ctx.deps,
            "edit_sentence",
            {"sentence_id": sentence_id, "text": text, "text_zh": text_zh},
            run(),
        )

    @agent.tool
    async def merge_sentences(ctx: RunContext[RepairDeps], first_id: int, second_id: int) -> dict:
        """把相邻两句合并成一句（用户说"这两句其实是一句话"时用）。"""
        from domain import sentence_ops

        async def run() -> dict:
            async with ctx.deps.session_factory() as session:
                out = await sentence_ops.merge_sentences(session, first_id, second_id)
                await session.commit()
                return out

        return await _audit(
            ctx.deps,
            "merge_sentences",
            {"first_id": first_id, "second_id": second_id},
            run(),
        )

    @agent.tool
    async def mark_noise(ctx: RunContext[RepairDeps], sentence_id: int, noise: bool = True) -> dict:
        """把一句移出学习链路 / 撤销（用户说"这句是重复的""这句是垃圾"时用）。

        软删除而非真删：标记后字幕列表、播放序列、AI 校验、陪读都不再出现它，
        体检的句数统计也不计入；误判了把 noise 设回 False 即可恢复。
        重复转写句、纯口水句用这个，不要试图靠合并或改写去消除。
        """
        from domain import sentence_ops

        async def run() -> dict:
            async with ctx.deps.session_factory() as session:
                out = await sentence_ops.mark_noise(session, sentence_id, noise)
                await session.commit()
                return out

        return await _audit(
            ctx.deps,
            "mark_noise",
            {"sentence_id": sentence_id, "noise": noise},
            run(),
        )

    @agent.tool
    async def split_sentence(
        ctx: RunContext[RepairDeps], sentence_id: int, second_part_starts_with: str
    ) -> dict:
        """把一句拆成两句：给出第二句开头的原文文字（须与句中文字完全一致）。"""
        from domain import sentence_ops

        async def run() -> dict:
            async with ctx.deps.session_factory() as session:
                out = await sentence_ops.split_sentence(
                    session, sentence_id, second_part_starts_with
                )
                await session.commit()
                return out

        return await _audit(
            ctx.deps,
            "split_sentence",
            {"sentence_id": sentence_id, "at": second_part_starts_with},
            run(),
        )

    @agent.tool
    async def resegment_sentence(ctx: RunContext[RepairDeps], sentence_id: int) -> dict:
        """把一句按其自身标点重新分成多句。超长黏连句的标准修法：
        先 edit_sentence 把标点补进原文，再调本工具一次切开。"""
        from domain import sentence_ops

        async def run() -> dict:
            async with ctx.deps.session_factory() as session:
                out = await sentence_ops.resegment_sentence(session, sentence_id)
                await session.commit()
                return out

        return await _audit(
            ctx.deps,
            "resegment_sentence",
            {"sentence_id": sentence_id},
            run(),
        )

    @agent.tool
    async def rerun_pipeline(
        ctx: RunContext[RepairDeps], from_step: str, config: dict | None = None
    ) -> dict:
        """从指定节点重跑管线（含全部下游，同步等待完成）。

        节点与常用参数：punctuate {force:true 强制标点恢复, alias 换恢复模型}；
        sentences {max_unit_s, max_unit_chars, gap_s 切分阈值}；
        translate {refresh:true 忽略缓存整轨重翻, engine}；
        transcribe {whisper_model}（高危：整片重转写，需用户确认）；
        punctuate / align / sentences（高危：会重建句层，连同已学✓、收藏、
        听写成绩与跟读录音一起删除，需用户确认）。
        """
        if from_step not in STEP_BY_NAME:
            return {"ok": False, "error": f"未知节点 {from_step}"}

        # 高危确认门（BR-25）：挂起动作等用户点确认，本轮如实告知用户
        risky = from_step in RISKY_STEPS
        confirmed = (
            ctx.deps.confirmed_action is not None
            and ctx.deps.confirmed_action.get("tool") == "rerun_pipeline"
            and ctx.deps.confirmed_action.get("args", {}).get("from_step") == from_step
        )
        if risky and not confirmed:
            async with ctx.deps.session_factory() as session:
                row = await session.get(RepairSession, ctx.deps.session_id)
                if row is not None:
                    row.pending_action = {
                        "tool": "rerun_pipeline",
                        "args": {"from_step": from_step, "config": config or {}},
                        "reason": confirm_reason(from_step),
                    }
                    await session.commit()
            return {
                "ok": False,
                "pending_confirm": True,
                "message": "该操作开销大，已提交给用户确认；请告知用户点确认后你会继续。",
            }

        async def run() -> dict:
            from worker.tasks import run_pipeline

            out = await run_pipeline(
                ctx.deps.ctx,
                ctx.deps.video_id,
                from_step=from_step,
                scope="downstream",
                config_override={from_step: config} if config else None,
                trigger="agent",
            )
            return {"run_id": out.get("run_id"), "steps": resolve_scope(from_step, "downstream")}

        return await _audit(
            ctx.deps,
            "rerun_pipeline",
            {"from_step": from_step, "config": config or {}},
            run(),
        )

    @agent.tool
    async def resolve_issues(
        ctx: RunContext[RepairDeps], issue_ids: list[int], accept: bool
    ) -> dict:
        """批量采纳（accept=true，写回建议文本）或忽略校验问题清单里的条目。"""

        async def run() -> dict:
            from domain.analysis import content_key

            applied = 0
            async with ctx.deps.session_factory() as session:
                for issue_id in issue_ids[:50]:
                    issue = await session.get(SubtitleIssue, issue_id)
                    if issue is None:
                        continue
                    if accept and issue.sentence_id and issue.suggestion:
                        row = await session.get(SubtitleSentence, issue.sentence_id)
                        if row is not None:
                            if issue.kind == "translation_mismatch":
                                row.text_zh = issue.suggestion
                            else:
                                row.text = issue.suggestion
                                row.content_hash = content_key(row.text)
                                row.text_zh = None
                            applied += 1
                    issue.state = "accepted" if accept else "dismissed"
                await session.commit()
            return {"processed": len(issue_ids), "applied": applied}

        return await _audit(
            ctx.deps,
            "resolve_issues",
            {"issue_ids": issue_ids, "accept": accept},
            run(),
        )

    @agent.tool
    async def run_verify(ctx: RunContext[RepairDeps]) -> dict:
        """跑确定性体检回归（修复完成后必须调用），返回最新指标与门禁结论。

        **只做确定性体检，不重跑 LLM 裁判**（v10.7 FR-145）：裁判是非确定性的，
        每修完一轮就重判一次，必然又冒出一批新问题——用户刚清完的清单转眼又是满屏，
        「永远处理不完」就是这么来的。要重新过一遍 AI 校验，由用户在页面上显式点
        「重新体检」，那是他的决定不是修复流程的副作用。
        """

        async def run() -> dict:
            from worker.tasks import run_pipeline

            out = await run_pipeline(
                ctx.deps.ctx,
                ctx.deps.video_id,
                from_step="verify",
                scope="single",
                trigger="agent",
                config_override={"verify": {"ai_review": False}},
            )
            from domain.pipeline_health import inspect

            async with ctx.deps.session_factory() as session:
                report = await inspect(session, ctx.deps.video_id)
            return {
                "run_id": out.get("run_id"),
                "gate": report["gate"],
                "metrics": report["metrics"],
                "remaining_issues": report["issues"],
                "note": "本次只做确定性体检，未重跑 AI 裁判（避免刚修完又冒一批新问题）",
            }

        return await _audit(ctx.deps, "run_verify", {}, run())

    return agent


def _issues_stmt(video_id: int):
    from sqlalchemy import select

    return (
        select(SubtitleIssue)
        .where(SubtitleIssue.video_id == video_id, SubtitleIssue.state == "open")
        .order_by(SubtitleIssue.id)
    )

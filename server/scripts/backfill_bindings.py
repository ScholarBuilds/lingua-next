"""把 LLM / 生图能力绑定回填到直连部署（需求 17 调研 §2.8 V6 · §5.4）。

历史上绑定的 deployment_id 会是 NULL，或指着一条 adapter 已经没有插件的旧部署
（早年网关时代留下的行），运行时必失败。回填只认「adapter 有插件在」的部署：

- 同凭据、同上游模型、adapter 有对应插件且启用的部署已存在 → 直接挂上
- 没有 → 按凭据 provider_type 推断直连 adapter（OpenAI 兼容家族含 DeepSeek 官方
  → openai），新建一条 discovered=False 的部署再挂
- 推断不出（provider_type 没有插件认领、凭据停用等） → 跳过并报告，不动它

用法（server 目录）::

    uv run python scripts/backfill_bindings.py            # 只打印计划，不写库
    uv run python scripts/backfill_bindings.py --apply    # 写库并记一条审计

幂等：已挂部署的绑定不进计划，重复 --apply 没有副作用。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import unicodedata
from dataclasses import dataclass, replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import SessionFactory
from domain.credentials import IMAGE_CAPABILITIES, LLM_CAPABILITIES
from domain.model_plugins import adapter_for_provider, has_model_plugin
from domain.models import CapabilityBinding, ConfigAudit, ModelDeployment, ProviderCredential

MODEL_CAPABILITIES = (*LLM_CAPABILITIES, *IMAGE_CAPABILITIES)

ACTION_LINK = "link"
ACTION_CREATE = "create"
ACTION_SKIP = "skip"


@dataclass(frozen=True)
class PlanItem:
    capability: str
    credential_id: int | None
    credential_name: str
    provider_type: str
    target: str
    action: str
    adapter_type: str | None = None
    deployment_id: int | None = None
    note: str = ""


def capability_operation(capability: str) -> str:
    return "image.generate" if capability in IMAGE_CAPABILITIES else "chat.complete"


def capability_media_types(capability: str) -> list[str]:
    """与 sync_cached_models 同口径：小写媒体类型列表，生图能力 image，其余 chat。"""
    return ["image" if capability in IMAGE_CAPABILITIES else "chat"]


def direct_adapter_for(provider_type: str, capability: str) -> str | None:
    """按凭据类型推断直连 adapter；推断不出时返回 None。"""
    adapter = adapter_for_provider(
        provider_type,
        fallback="",
        operation=capability_operation(capability),
    )
    return adapter or None


def _plan_one(
    binding: CapabilityBinding,
    creds: dict[int, ProviderCredential],
    deployments: list[ModelDeployment],
) -> PlanItem:
    cred = creds.get(binding.credential_id) if binding.credential_id is not None else None
    base = PlanItem(
        capability=binding.capability,
        credential_id=binding.credential_id,
        credential_name=cred.name if cred else "-",
        provider_type=cred.provider_type if cred else "-",
        target=binding.target or "",
        action=ACTION_SKIP,
    )
    if cred is None:
        return replace(base, note="凭据不存在")
    if not binding.target:
        return replace(base, note="绑定没有 target")
    if not cred.enabled:
        return replace(base, note="凭据已停用")
    adapter = direct_adapter_for(cred.provider_type, binding.capability)
    direct = [
        row
        for row in deployments
        if row.credential_id == cred.id
        and row.upstream_model_id == binding.target
        and has_model_plugin(row.adapter_type)
    ]
    # 推断出的 adapter 优先，其次按 id 取最早的那条
    usable = sorted((row for row in direct if row.enabled), key=lambda r: (r.adapter_type != adapter, r.id))
    if usable:
        return replace(
            base,
            action=ACTION_LINK,
            adapter_type=usable[0].adapter_type,
            deployment_id=usable[0].id,
            note="复用已有直连部署",
        )
    if direct:
        return replace(base, note=f"直连部署 #{direct[0].id} 已停用")
    if adapter is None:
        return replace(base, note=f"provider_type={cred.provider_type} 推断不出直连 adapter")
    return replace(
        base,
        action=ACTION_CREATE,
        adapter_type=adapter,
        note=f"新建部署 media_types={capability_media_types(binding.capability)}",
    )


async def plan_backfill(session: AsyncSession) -> list[PlanItem]:
    """只读：列出每条待回填绑定准备怎么处理。"""
    bindings = list(
        (
            await session.execute(
                select(CapabilityBinding).where(
                    CapabilityBinding.capability.in_(MODEL_CAPABILITIES),
                    CapabilityBinding.deployment_id.is_(None),
                )
            )
        ).scalars()
    )
    creds = {c.id: c for c in (await session.execute(select(ProviderCredential))).scalars()}
    deployments = list((await session.execute(select(ModelDeployment))).scalars())
    order = {cap: i for i, cap in enumerate(MODEL_CAPABILITIES)}
    bindings.sort(key=lambda b: order.get(b.capability, 99))
    return [_plan_one(binding, creds, deployments) for binding in bindings]


async def apply_backfill(session: AsyncSession, plan: list[PlanItem]) -> list[PlanItem]:
    """按计划写库（调用方负责 commit）；返回带上新部署 id 的计划。"""
    created: dict[tuple[int, str, str], ModelDeployment] = {}
    applied: list[PlanItem] = []
    for item in plan:
        if item.action == ACTION_SKIP:
            applied.append(item)
            continue
        binding = (
            await session.execute(
                select(CapabilityBinding).where(CapabilityBinding.capability == item.capability)
            )
        ).scalar_one()
        if item.action == ACTION_CREATE:
            assert item.credential_id is not None and item.adapter_type is not None
            key = (item.credential_id, item.target, item.adapter_type)
            row = created.get(key)
            if row is None:
                row = ModelDeployment(
                    credential_id=item.credential_id,
                    upstream_model_id=item.target,
                    adapter_type=item.adapter_type,
                    media_types=capability_media_types(item.capability),
                    discovered=False,
                )
                session.add(row)
                await session.flush()
                created[key] = row
            deployment_id = row.id
        else:
            deployment_id = item.deployment_id
        binding.deployment_id = deployment_id
        applied.append(replace(item, deployment_id=deployment_id))
    touched = [i for i in applied if i.action != ACTION_SKIP]
    if touched:
        summary = "绑定回填到直连部署：" + "、".join(
            f"{i.capability}→#{i.deployment_id}({i.adapter_type})" for i in touched
        )
        session.add(ConfigAudit(action="binding.backfill", summary=summary))
    await session.flush()
    return applied


def _width(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in text)


def _pad(text: str, width: int) -> str:
    return text + " " * max(0, width - _width(text))


def render_plan(plan: list[PlanItem]) -> str:
    headers = ("capability", "credential", "provider_type", "target", "action", "adapter", "deployment", "note")
    rows = [
        (
            item.capability,
            f"#{item.credential_id} {item.credential_name}" if item.credential_id else "-",
            item.provider_type,
            item.target or "-",
            item.action,
            item.adapter_type or "-",
            f"#{item.deployment_id}" if item.deployment_id is not None else "-",
            item.note,
        )
        for item in plan
    ]
    widths = [max(_width(h), *(_width(r[i]) for r in rows)) for i, h in enumerate(headers)]
    lines = [
        "  ".join(_pad(h, widths[i]) for i, h in enumerate(headers)),
        "  ".join("-" * w for w in widths),
    ]
    lines.extend("  ".join(_pad(cell, widths[i]) for i, cell in enumerate(row)) for row in rows)
    return "\n".join(lines)


async def run(apply: bool) -> int:
    async with SessionFactory() as session:
        plan = await plan_backfill(session)
        if not plan:
            print("没有需要回填的绑定：LLM / 生图能力的 deployment_id 都已挂好")
            return 0
        if apply:
            plan = await apply_backfill(session, plan)
            await session.commit()
        print(render_plan(plan))
        counts = {
            action: sum(1 for item in plan if item.action == action)
            for action in (ACTION_LINK, ACTION_CREATE, ACTION_SKIP)
        }
        print(
            f"\n共 {len(plan)} 条：复用 {counts[ACTION_LINK]}，新建 {counts[ACTION_CREATE]}，"
            f"跳过 {counts[ACTION_SKIP]}"
        )
        print("已写库并记审计 binding.backfill" if apply else "dry-run：未写库，确认无误后加 --apply 提交")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="把 LLM / 生图能力绑定回填到直连部署")
    parser.add_argument("--apply", action="store_true", help="真正写库；默认只打印计划")
    args = parser.parse_args(argv)
    return asyncio.run(run(apply=args.apply))


if __name__ == "__main__":
    sys.exit(main())

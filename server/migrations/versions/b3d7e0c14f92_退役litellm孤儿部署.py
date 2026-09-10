"""退役 LiteLLM 孤儿部署

网关降为「显式选它才用」之后，库里 28 条 ``adapter_type='litellm'`` 的部署一条绑定
都没挂上，却照样出现在「已登记模型」列表里，把一半列表变成噪音。

这里不删行：历史还得看得见，且 `credential_id + upstream_model_id + adapter_type`
的唯一约束保证重跑幂等。做法是置 ``enabled=false`` 并在 ``protocol_options`` 里
盖一个 ``retired='retired_litellm'`` 的戳，downgrade 只认这个戳回滚。

**跑之前自己再查一次**：能力绑定的 deployment_id 或 fallback 里只要还有一条指向
litellm 部署，就中止并报错——把用户正在用的链路悄悄停掉比留着噪音严重得多。

Revision ID: b3d7e0c14f92
Revises: a1f47c0b93de
Create Date: 2026-08-22

"""

import json
from collections.abc import Iterable

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "b3d7e0c14f92"
down_revision = "a1f47c0b93de"
branch_labels = None
depends_on = None

RETIRED_MARK = "retired_litellm"

_JSON = sa.JSON().with_variant(JSONB(), "postgresql")

deployment = sa.table(
    "model_deployment",
    sa.column("id", sa.Integer),
    sa.column("adapter_type", sa.String),
    sa.column("enabled", sa.Boolean),
    sa.column("protocol_options", _JSON),
)
binding = sa.table(
    "capability_binding",
    sa.column("capability", sa.String),
    sa.column("deployment_id", sa.Integer),
    sa.column("fallback", _JSON),
)


def _fallback_deployment_ids(raw: object) -> Iterable[int]:
    """fallback 是 [{deployment_id|credential_id, ...}]；SQLite 上可能是字符串。"""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return
    if not isinstance(raw, list):
        return
    for item in raw:
        if isinstance(item, dict) and isinstance(item.get("deployment_id"), int):
            yield item["deployment_id"]


def _options(raw: object) -> dict:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {}
    return dict(raw) if isinstance(raw, dict) else {}


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.select(deployment.c.id, deployment.c.protocol_options).where(
            deployment.c.adapter_type == "litellm"
        )
    ).all()
    if not rows:
        return
    targets = {row.id: _options(row.protocol_options) for row in rows}

    referenced: set[int] = set()
    for bind_row in conn.execute(
        sa.select(binding.c.capability, binding.c.deployment_id, binding.c.fallback)
    ).all():
        if bind_row.deployment_id in targets:
            referenced.add(bind_row.deployment_id)
        referenced.update(set(_fallback_deployment_ids(bind_row.fallback)) & targets.keys())
    if referenced:
        raise RuntimeError(
            "还有能力绑定指向 litellm 部署，拒绝退役："
            f"{sorted(referenced)}。先把这些能力改绑直连部署再跑迁移。"
        )

    for deployment_id, options in targets.items():
        if options.get("retired") == RETIRED_MARK:
            continue
        conn.execute(
            sa.update(deployment)
            .where(deployment.c.id == deployment_id)
            .values(enabled=False, protocol_options={**options, "retired": RETIRED_MARK})
        )


def downgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.select(deployment.c.id, deployment.c.protocol_options).where(
            deployment.c.adapter_type == "litellm"
        )
    ).all()
    for row in rows:
        options = _options(row.protocol_options)
        if options.get("retired") != RETIRED_MARK:
            continue
        options.pop("retired", None)
        # 空字典要还原成 SQL NULL：JSON 列上直接给 None 存的是 JSON null，
        # 与迁移前的 NULL 不是一回事，下次 upgrade 的幂等判断会受影响
        conn.execute(
            sa.update(deployment)
            .where(deployment.c.id == row.id)
            .values(enabled=True, protocol_options=options if options else sa.null())
        )

"""提示词模板变量 · 提示词与工作流版本链

三件事：

1. `studio_prompt` 加 `variables`（模板变量声明）与 `version`。
2. `studio_workflow` 加 `version`。
3. 新建 `studio_revision`：提示词与工作流共用的版本快照链。

**已有数据的填充是安全的**：`variables` 给空数组——变量名单本来就以正文里的
`{{name}}` 占位为准，这一列只存人写的说明，空着不影响渲染；`version` 一律填 1，
再给每条既有记录补一版「迁移前的内容」快照，这样历史面板不会是空的，
第一次编辑之后也能回滚回迁移前的样子。

跑之前自查表在不在、列有没有加过（重复跑不报错），缺表直接中止。

Revision ID: c7e1a95b40df
Revises: b3d7e0c14f92
Create Date: 2026-08-23

"""

import json
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c7e1a95b40df"
down_revision: str | None = "b3d7e0c14f92"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSONB = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")

BACKFILL_NOTE = "迁移前的内容"

prompt = sa.table(
    "studio_prompt",
    sa.column("id", sa.Integer),
    sa.column("title", sa.String),
    sa.column("body", sa.Text),
    sa.column("negative", sa.Text),
    sa.column("scene", sa.String),
)
workflow = sa.table(
    "studio_workflow",
    sa.column("id", sa.Integer),
    sa.column("title", sa.String),
    sa.column("provider", sa.String),
    sa.column("kind", sa.String),
    sa.column("payload", JSONB),
    sa.column("ui_schema", JSONB),
    sa.column("content_hash", sa.String),
)
revision_table = sa.table(
    "studio_revision",
    sa.column("entity_type", sa.String),
    sa.column("entity_id", sa.Integer),
    sa.column("version", sa.Integer),
    sa.column("snapshot", JSONB),
    sa.column("note", sa.String),
    sa.column("pinned", sa.Boolean),
)


def _json(raw: object) -> Any:
    """SQLite 上 JSON 列读回来可能是字符串，两种方言都要能吃。"""
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            return None
    return raw


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    tables = set(inspector.get_table_names())
    missing = {"studio_prompt", "studio_workflow"} - tables
    if missing:
        raise RuntimeError(f"缺少前置表，拒绝迁移：{sorted(missing)}")

    prompt_columns = {column["name"] for column in inspector.get_columns("studio_prompt")}
    if "variables" not in prompt_columns:
        op.add_column(
            "studio_prompt",
            sa.Column("variables", JSONB, nullable=False, server_default=sa.text("'[]'")),
        )
    if "version" not in prompt_columns:
        op.add_column(
            "studio_prompt",
            sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        )

    workflow_columns = {column["name"] for column in inspector.get_columns("studio_workflow")}
    if "version" not in workflow_columns:
        op.add_column(
            "studio_workflow",
            sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        )

    if "studio_revision" not in tables:
        op.create_table(
            "studio_revision",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("entity_type", sa.String(length=24), nullable=False),
            sa.Column("entity_id", sa.Integer(), nullable=False),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("snapshot", JSONB, nullable=False),
            sa.Column("note", sa.String(length=200), nullable=False, server_default=""),
            sa.Column(
                "pinned", sa.Boolean(), nullable=False, server_default=sa.false()
            ),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "entity_type", "entity_id", "version", name="uq_studio_revision_version"
            ),
        )
        op.create_index(
            op.f("ix_studio_revision_entity_type"), "studio_revision", ["entity_type"]
        )
        op.create_index(
            op.f("ix_studio_revision_entity_id"), "studio_revision", ["entity_id"]
        )
        op.create_index(
            "ix_studio_revision_entity",
            "studio_revision",
            ["entity_type", "entity_id", "version"],
        )

    _backfill(conn)


def _backfill(conn: sa.Connection) -> None:
    """给既有条目补第一版快照。已经有版本链的实体跳过，重复跑不会撞唯一约束。"""
    taken = {
        (row.entity_type, row.entity_id)
        for row in conn.execute(
            sa.select(revision_table.c.entity_type, revision_table.c.entity_id)
        ).all()
    }

    rows = []
    for item in conn.execute(
        sa.select(
            prompt.c.id, prompt.c.title, prompt.c.body, prompt.c.negative, prompt.c.scene
        )
    ).all():
        if ("prompt", item.id) in taken:
            continue
        rows.append(
            {
                "entity_type": "prompt",
                "entity_id": item.id,
                "version": 1,
                "snapshot": {
                    "title": item.title,
                    "body": item.body,
                    "negative": item.negative or "",
                    "scene": item.scene or "",
                    "variables": [],
                },
                "note": BACKFILL_NOTE,
                "pinned": False,
            }
        )

    for item in conn.execute(
        sa.select(
            workflow.c.id,
            workflow.c.title,
            workflow.c.provider,
            workflow.c.kind,
            workflow.c.payload,
            workflow.c.ui_schema,
            workflow.c.content_hash,
        )
    ).all():
        if ("workflow", item.id) in taken:
            continue
        rows.append(
            {
                "entity_type": "workflow",
                "entity_id": item.id,
                "version": 1,
                "snapshot": {
                    "title": item.title,
                    "provider": item.provider,
                    "kind": item.kind,
                    "payload": _json(item.payload) or {},
                    "ui_schema": _json(item.ui_schema),
                    "content_hash": item.content_hash,
                },
                "note": BACKFILL_NOTE,
                "pinned": False,
            }
        )

    if rows:
        conn.execute(sa.insert(revision_table), rows)


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    tables = set(inspector.get_table_names())
    if "studio_revision" in tables:
        op.drop_index("ix_studio_revision_entity", table_name="studio_revision")
        op.drop_index(op.f("ix_studio_revision_entity_id"), table_name="studio_revision")
        op.drop_index(op.f("ix_studio_revision_entity_type"), table_name="studio_revision")
        op.drop_table("studio_revision")
    if "studio_workflow" in tables:
        columns = {column["name"] for column in inspector.get_columns("studio_workflow")}
        if "version" in columns:
            op.drop_column("studio_workflow", "version")
    if "studio_prompt" in tables:
        columns = {column["name"] for column in inspector.get_columns("studio_prompt")}
        if "version" in columns:
            op.drop_column("studio_prompt", "version")
        if "variables" in columns:
            op.drop_column("studio_prompt", "variables")

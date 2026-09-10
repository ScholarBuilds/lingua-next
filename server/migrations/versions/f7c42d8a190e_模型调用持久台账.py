"""模型调用持久台账

Revision ID: f7c42d8a190e
Revises: e4a91c7d2b60
Create Date: 2026-08-21 14:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f7c42d8a190e"
down_revision: str | None = "e4a91c7d2b60"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSONB = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.create_table(
        "model_invocation",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("plugin_id", sa.String(length=64), nullable=False),
        sa.Column("plugin_version", sa.String(length=64), nullable=True),
        sa.Column("plugin_generation", sa.Integer(), nullable=True),
        sa.Column("operation", sa.String(length=64), nullable=False),
        sa.Column("capability", sa.String(length=64), nullable=True),
        sa.Column("deployment_id", sa.Integer(), nullable=True),
        sa.Column("task_id", sa.String(length=36), nullable=True),
        sa.Column("source", sa.String(length=128), nullable=True),
        sa.Column("request", JSONB, nullable=True),
        sa.Column("response", JSONB, nullable=True),
        sa.Column("provider_request_id", sa.String(length=255), nullable=True),
        sa.Column("model", sa.String(length=255), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("usage", JSONB, nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("error_type", sa.String(length=128), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("context", JSONB, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["deployment_id"], ["model_deployment.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["task_id"], ["studio_task.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    for name in (
        "capability",
        "created_at",
        "deployment_id",
        "model",
        "operation",
        "plugin_id",
        "provider_request_id",
        "source",
        "status",
        "task_id",
    ):
        op.create_index(
            op.f(f"ix_model_invocation_{name}"),
            "model_invocation",
            [name],
            unique=False,
        )


def downgrade() -> None:
    for name in reversed(
        (
            "capability",
            "created_at",
            "deployment_id",
            "model",
            "operation",
            "plugin_id",
            "provider_request_id",
            "source",
            "status",
            "task_id",
        )
    ):
        op.drop_index(op.f(f"ix_model_invocation_{name}"), table_name="model_invocation")
    op.drop_table("model_invocation")

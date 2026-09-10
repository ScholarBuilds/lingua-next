"""创作模型目录与统一任务

Revision ID: a6b9f4e2c1d0
Revises: 7c2ef4a91b05
Create Date: 2026-08-20 14:20:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a6b9f4e2c1d0"
down_revision: str | None = "7c2ef4a91b05"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


JSONB = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.create_table(
        "model_deployment",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("credential_id", sa.Integer(), nullable=False),
        sa.Column("upstream_model_id", sa.String(length=255), nullable=False),
        sa.Column("display_name", sa.String(length=160), nullable=True),
        sa.Column("adapter_type", sa.String(length=32), nullable=False),
        sa.Column("media_types", JSONB, nullable=False),
        sa.Column("protocol_options", JSONB, nullable=True),
        sa.Column("discovered", sa.Boolean(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("sort", sa.Integer(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            server_default=sa.text("now()"), nullable=False,
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True),
            server_default=sa.text("now()"), nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["credential_id"], ["provider_credential.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "credential_id", "upstream_model_id", "adapter_type",
            name="uq_model_deployment_target",
        ),
    )
    op.create_index(
        op.f("ix_model_deployment_credential_id"),
        "model_deployment", ["credential_id"], unique=False,
    )
    op.create_index(
        op.f("ix_model_deployment_enabled"),
        "model_deployment", ["enabled"], unique=False,
    )

    op.add_column(
        "capability_binding", sa.Column("deployment_id", sa.Integer(), nullable=True)
    )
    op.create_foreign_key(
        "fk_capability_binding_deployment_id",
        "capability_binding", "model_deployment",
        ["deployment_id"], ["id"], ondelete="SET NULL",
    )
    op.create_index(
        op.f("ix_capability_binding_deployment_id"),
        "capability_binding", ["deployment_id"], unique=False,
    )

    op.create_table(
        "studio_task",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("domain", sa.String(length=32), nullable=False),
        sa.Column("tool_id", sa.String(length=64), nullable=False),
        sa.Column("task_type", sa.String(length=64), nullable=False),
        sa.Column("parent_task_id", sa.String(length=36), nullable=True),
        sa.Column("batch_id", sa.String(length=36), nullable=True),
        sa.Column("source_route", sa.String(length=512), nullable=True),
        sa.Column("source_context", JSONB, nullable=True),
        sa.Column("capability", sa.String(length=64), nullable=True),
        sa.Column("deployment_id", sa.Integer(), nullable=True),
        sa.Column("invocation", JSONB, nullable=True),
        sa.Column("provider_task_id", sa.String(length=255), nullable=True),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("stage", sa.String(length=96), nullable=True),
        sa.Column("progress", sa.Float(), nullable=False),
        sa.Column("result", JSONB, nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("retryable", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            server_default=sa.text("now()"), nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True),
            server_default=sa.text("now()"), nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["deployment_id"], ["model_deployment.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["parent_task_id"], ["studio_task.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    for name in (
        "batch_id", "created_at", "deployment_id", "domain", "parent_task_id",
        "provider_task_id", "status", "task_type", "tool_id",
    ):
        op.create_index(
            op.f(f"ix_studio_task_{name}"), "studio_task", [name], unique=False
        )

    op.add_column(
        "image_job", sa.Column("studio_task_id", sa.String(length=36), nullable=True)
    )
    op.create_foreign_key(
        "fk_image_job_studio_task_id",
        "image_job", "studio_task", ["studio_task_id"], ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        op.f("ix_image_job_studio_task_id"),
        "image_job", ["studio_task_id"], unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_image_job_studio_task_id"), table_name="image_job")
    op.drop_constraint("fk_image_job_studio_task_id", "image_job", type_="foreignkey")
    op.drop_column("image_job", "studio_task_id")

    for name in reversed((
        "batch_id", "created_at", "deployment_id", "domain", "parent_task_id",
        "provider_task_id", "status", "task_type", "tool_id",
    )):
        op.drop_index(op.f(f"ix_studio_task_{name}"), table_name="studio_task")
    op.drop_table("studio_task")

    op.drop_index(
        op.f("ix_capability_binding_deployment_id"), table_name="capability_binding"
    )
    op.drop_constraint(
        "fk_capability_binding_deployment_id", "capability_binding", type_="foreignkey"
    )
    op.drop_column("capability_binding", "deployment_id")

    op.drop_index(op.f("ix_model_deployment_enabled"), table_name="model_deployment")
    op.drop_index(
        op.f("ix_model_deployment_credential_id"), table_name="model_deployment"
    )
    op.drop_table("model_deployment")

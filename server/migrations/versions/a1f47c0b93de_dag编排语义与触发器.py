"""DAG 编排语义与触发器

Revision ID: a1f47c0b93de
Revises: c4d2e9f1a7b3
Create Date: 2026-08-22 21:40:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a1f47c0b93de"
down_revision: str | None = "c4d2e9f1a7b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSONB = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.add_column("studio_flow", sa.Column("input_schema", JSONB, nullable=True))
    op.add_column("studio_flow_run", sa.Column("outputs", JSONB, nullable=True))
    op.add_column(
        "studio_flow_run", sa.Column("waiting_node_id", sa.String(length=96), nullable=True)
    )

    op.create_table(
        "studio_flow_interrupt",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("node_id", sa.String(length=96), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("payload", JSONB, nullable=True),
        sa.Column("resume_value", JSONB, nullable=True),
        sa.Column("status", sa.String(length=12), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["run_id"], ["studio_flow_run.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_studio_flow_interrupt_run_id"),
        "studio_flow_interrupt",
        ["run_id"],
        unique=False,
    )
    op.create_index(
        "ix_studio_flow_interrupt_run",
        "studio_flow_interrupt",
        ["run_id", "status"],
        unique=False,
    )

    op.create_table(
        "studio_flow_trigger",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("flow_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column("cron", sa.String(length=120), nullable=True),
        sa.Column("task_type", sa.String(length=64), nullable=True),
        sa.Column("statuses", JSONB, nullable=True),
        sa.Column("inputs", JSONB, nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("last_fired_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["flow_id"], ["studio_flow.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    for name in ("enabled", "flow_id", "kind", "task_type"):
        op.create_index(
            op.f(f"ix_studio_flow_trigger_{name}"),
            "studio_flow_trigger",
            [name],
            unique=False,
        )


def downgrade() -> None:
    for name in reversed(("enabled", "flow_id", "kind", "task_type")):
        op.drop_index(op.f(f"ix_studio_flow_trigger_{name}"), table_name="studio_flow_trigger")
    op.drop_table("studio_flow_trigger")
    op.drop_index("ix_studio_flow_interrupt_run", table_name="studio_flow_interrupt")
    op.drop_index(
        op.f("ix_studio_flow_interrupt_run_id"), table_name="studio_flow_interrupt"
    )
    op.drop_table("studio_flow_interrupt")
    op.drop_column("studio_flow_run", "waiting_node_id")
    op.drop_column("studio_flow_run", "outputs")
    op.drop_column("studio_flow", "input_schema")

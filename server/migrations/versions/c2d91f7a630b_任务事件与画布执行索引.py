"""任务事件与画布执行索引

Revision ID: c2d91f7a630b
Revises: f7c42d8a190e
Create Date: 2026-08-21 15:30:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c2d91f7a630b"
down_revision: str | None = "f7c42d8a190e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSONB = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.add_column("studio_task", sa.Column("canvas_id", sa.Integer(), nullable=True))
    op.add_column("studio_task", sa.Column("node_id", sa.String(length=128), nullable=True))
    op.add_column(
        "studio_task", sa.Column("execution_group_id", sa.String(length=36), nullable=True)
    )
    op.add_column(
        "studio_task",
        sa.Column("event_seq", sa.Integer(), server_default="0", nullable=False),
    )
    for name in ("canvas_id", "execution_group_id", "node_id"):
        op.create_index(
            op.f(f"ix_studio_task_{name}"),
            "studio_task",
            [name],
            unique=False,
        )

    op.execute(
        """
        UPDATE studio_task
        SET canvas_id = CASE
                WHEN source_context->>'canvas_id' ~ '^[0-9]+$'
                THEN (source_context->>'canvas_id')::integer
                ELSE NULL
            END,
            node_id = NULLIF(source_context->>'node_id', ''),
            execution_group_id = COALESCE(
                NULLIF(source_context->>'execution_group_id', ''),
                batch_id
            )
        WHERE source_context IS NOT NULL
        """
    )

    op.create_table(
        "studio_task_event",
        sa.Column("global_cursor", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("task_id", sa.String(length=36), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("stage", sa.String(length=96), nullable=True),
        sa.Column("progress", sa.Float(), nullable=True),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("payload", JSONB, nullable=True),
        sa.Column("canvas_id", sa.Integer(), nullable=True),
        sa.Column("node_id", sa.String(length=128), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["task_id"], ["studio_task.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("global_cursor"),
        sa.UniqueConstraint("task_id", "seq", name="uq_studio_task_event_seq"),
    )
    for name in (
        "canvas_id",
        "created_at",
        "event_type",
        "node_id",
        "status",
        "task_id",
    ):
        op.create_index(
            op.f(f"ix_studio_task_event_{name}"),
            "studio_task_event",
            [name],
            unique=False,
        )


def downgrade() -> None:
    for name in reversed(("canvas_id", "created_at", "event_type", "node_id", "status", "task_id")):
        op.drop_index(op.f(f"ix_studio_task_event_{name}"), table_name="studio_task_event")
    op.drop_table("studio_task_event")
    for name in reversed(("canvas_id", "execution_group_id", "node_id")):
        op.drop_index(op.f(f"ix_studio_task_{name}"), table_name="studio_task")
    op.drop_column("studio_task", "event_seq")
    op.drop_column("studio_task", "execution_group_id")
    op.drop_column("studio_task", "node_id")
    op.drop_column("studio_task", "canvas_id")

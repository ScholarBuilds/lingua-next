"""电脑操控会话与步骤表（CR-007 模块 21）

Revision ID: b6c7d8e9f0a1
Revises: a5b6c7d8e9f0
Create Date: 2026-09-02 20:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b6c7d8e9f0a1"
down_revision: str | None = "a5b6c7d8e9f0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "computer_session",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("goal", sa.Text(), nullable=False),
        sa.Column("start_url", sa.String(length=2048), nullable=True),
        sa.Column("scope", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("status_detail", sa.Text(), nullable=True),
        sa.Column("plan", JSON, nullable=True),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("step_count", sa.Integer(), nullable=False),
        sa.Column("max_steps", sa.Integer(), nullable=False),
        sa.Column("max_minutes", sa.Integer(), nullable=False),
        sa.Column("current_url", sa.String(length=2048), nullable=True),
        sa.Column("capability", sa.String(length=32), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_computer_session_status"), "computer_session", ["status"])
    op.create_table(
        "computer_step",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column("args", JSON, nullable=True),
        sa.Column("result", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("screenshot_key", sa.String(length=512), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["computer_session.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_computer_step_session_id"), "computer_step", ["session_id"])


def downgrade() -> None:
    op.drop_index(op.f("ix_computer_step_session_id"), table_name="computer_step")
    op.drop_table("computer_step")
    op.drop_index(op.f("ix_computer_session_status"), table_name="computer_session")
    op.drop_table("computer_session")

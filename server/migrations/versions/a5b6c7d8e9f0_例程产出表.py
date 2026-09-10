"""例程产出表 routine_run（CR-007 模块 20）

Revision ID: a5b6c7d8e9f0
Revises: f3c4d5e6a7b8
Create Date: 2026-09-02 16:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a5b6c7d8e9f0"
down_revision: str | None = "f3c4d5e6a7b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "routine_run",
        sa.Column("id", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), autoincrement=True, nullable=False),
        sa.Column("key", sa.String(length=32), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("payload", sa.JSON().with_variant(postgresql.JSONB(), "postgresql"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_routine_run_key"), "routine_run", ["key"])
    op.create_index(op.f("ix_routine_run_created_at"), "routine_run", ["created_at"])


def downgrade() -> None:
    op.drop_index(op.f("ix_routine_run_created_at"), table_name="routine_run")
    op.drop_index(op.f("ix_routine_run_key"), table_name="routine_run")
    op.drop_table("routine_run")

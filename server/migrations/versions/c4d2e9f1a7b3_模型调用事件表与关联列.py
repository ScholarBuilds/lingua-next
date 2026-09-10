"""模型调用事件表与关联列

Revision ID: c4d2e9f1a7b3
Revises: bdb5d1f72a49
Create Date: 2026-08-22 20:10:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c4d2e9f1a7b3"
down_revision: str | None = "bdb5d1f72a49"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSONB = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")

# 从 JSON context 升格出来的可过滤列：(列名, 类型)
_CONTEXT_COLUMNS = (
    ("canvas_id", sa.Integer()),
    ("node_id", sa.String(length=128)),
    ("flow_run_id", sa.String(length=36)),
    ("tool_id", sa.String(length=64)),
)


def upgrade() -> None:
    for name, column_type in _CONTEXT_COLUMNS:
        op.add_column("model_invocation", sa.Column(name, column_type, nullable=True))
        op.create_index(op.f(f"ix_model_invocation_{name}"), "model_invocation", [name])

    op.create_table(
        "model_invocation_event",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("invocation_id", sa.String(length=36), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(length=32), nullable=False),
        sa.Column(
            "time",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("data", JSONB, nullable=True),
        sa.ForeignKeyConstraint(["invocation_id"], ["model_invocation.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("invocation_id", "seq", name="uq_model_invocation_event_seq"),
    )
    op.create_index(
        op.f("ix_model_invocation_event_invocation_id"),
        "model_invocation_event",
        ["invocation_id"],
    )
    op.create_index(op.f("ix_model_invocation_event_type"), "model_invocation_event", ["type"])


def downgrade() -> None:
    op.drop_index(op.f("ix_model_invocation_event_type"), table_name="model_invocation_event")
    op.drop_index(
        op.f("ix_model_invocation_event_invocation_id"), table_name="model_invocation_event"
    )
    op.drop_table("model_invocation_event")
    for name, _column_type in reversed(_CONTEXT_COLUMNS):
        op.drop_index(op.f(f"ix_model_invocation_{name}"), table_name="model_invocation")
        op.drop_column("model_invocation", name)

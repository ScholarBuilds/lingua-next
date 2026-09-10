"""模型调用尝试与用量列

Revision ID: bdb5d1f72a49
Revises: a7ca6aab9702
Create Date: 2026-08-22 18:02:11.493812
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "bdb5d1f72a49"
down_revision: str | None = "a7ca6aab9702"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TOKEN_COLUMNS = (
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
)


def upgrade() -> None:
    # 重试 / fallback 链：后续尝试指回首个尝试；根行被删时只断链不级联
    op.add_column(
        "model_invocation",
        sa.Column(
            "parent_invocation_id",
            sa.String(length=36),
            sa.ForeignKey(
                "model_invocation.id",
                name="fk_model_invocation_parent",
                ondelete="SET NULL",
            ),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_model_invocation_parent_invocation_id",
        "model_invocation",
        ["parent_invocation_id"],
    )
    op.add_column(
        "model_invocation",
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="1"),
    )
    for name in _TOKEN_COLUMNS:
        op.add_column("model_invocation", sa.Column(name, sa.Integer(), nullable=True))


def downgrade() -> None:
    for name in reversed(_TOKEN_COLUMNS):
        op.drop_column("model_invocation", name)
    op.drop_column("model_invocation", "attempt")
    op.drop_index("ix_model_invocation_parent_invocation_id", table_name="model_invocation")
    op.drop_constraint("fk_model_invocation_parent", "model_invocation", type_="foreignkey")
    op.drop_column("model_invocation", "parent_invocation_id")

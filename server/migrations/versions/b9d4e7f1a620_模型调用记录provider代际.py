"""模型调用记录 Provider 运行时代际

Revision ID: b9d4e7f1a620
Revises: e7b4c2d9a610
Create Date: 2026-08-22 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b9d4e7f1a620"
down_revision: str | None = "e7b4c2d9a610"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "model_invocation",
        sa.Column("runtime_generation", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("model_invocation", "runtime_generation")

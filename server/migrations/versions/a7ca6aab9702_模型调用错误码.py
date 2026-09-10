"""模型调用错误码

Revision ID: a7ca6aab9702
Revises: b9d4e7f1a620
Create Date: 2026-08-22 11:26:49.963622
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7ca6aab9702"
down_revision: str | None = "b9d4e7f1a620"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "model_invocation",
        sa.Column("error_code", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("model_invocation", "error_code")

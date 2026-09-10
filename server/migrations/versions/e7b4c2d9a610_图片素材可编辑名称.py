"""图片素材可编辑名称

Revision ID: e7b4c2d9a610
Revises: d6a0b3f9c412
Create Date: 2026-08-22 16:10:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e7b4c2d9a610"
down_revision: str | None = "d6a0b3f9c412"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("image_asset", sa.Column("display_name", sa.String(length=160)))


def downgrade() -> None:
    op.drop_column("image_asset", "display_name")

"""创作素材共享文件夹

Revision ID: d6a0b3f9c412
Revises: c5f9a2e8b301
Create Date: 2026-08-22 15:20:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d6a0b3f9c412"
down_revision: str | None = "c5f9a2e8b301"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "studio_shared_folder",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("rel_path", sa.String(length=512), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("rel_path"),
    )


def downgrade() -> None:
    op.drop_table("studio_shared_folder")

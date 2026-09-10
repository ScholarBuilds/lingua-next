"""统一多媒体资产哈希唯一索引

Revision ID: f1a6b2c8d9e0
Revises: e3b7c9d4a211
Create Date: 2026-08-21 18:45:00
"""

from collections.abc import Sequence

from alembic import op

revision: str = "f1a6b2c8d9e0"
down_revision: str | None = "e3b7c9d4a211"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """用单个唯一索引替代同列上的唯一约束与普通索引。"""
    op.drop_constraint(
        "studio_media_asset_sha256_key",
        "studio_media_asset",
        type_="unique",
    )
    op.drop_index(
        op.f("ix_studio_media_asset_sha256"),
        table_name="studio_media_asset",
    )
    op.create_index(
        op.f("ix_studio_media_asset_sha256"),
        "studio_media_asset",
        ["sha256"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_studio_media_asset_sha256"),
        table_name="studio_media_asset",
    )
    op.create_index(
        op.f("ix_studio_media_asset_sha256"),
        "studio_media_asset",
        ["sha256"],
        unique=False,
    )
    op.create_unique_constraint(
        "studio_media_asset_sha256_key",
        "studio_media_asset",
        ["sha256"],
    )

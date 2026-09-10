"""创作多媒体资产表

Revision ID: e4a91c7d2b60
Revises: c81e4f2a9b7d
Create Date: 2026-08-20 21:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e4a91c7d2b60"
down_revision: str | None = "c81e4f2a9b7d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


JSONB = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.create_table(
        "studio_media_asset",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("mime", sa.String(length=128), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("storage_key", sa.String(length=512), nullable=False),
        sa.Column("poster_key", sa.String(length=512), nullable=True),
        sa.Column("bytes", sa.BigInteger(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("source_task_id", sa.String(length=36), nullable=True),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("details", JSONB, nullable=True),
        sa.Column("parent_id", sa.Integer(), nullable=True),
        sa.Column("group_id", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("favorite", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["source_task_id"], ["studio_task.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["parent_id"], ["studio_media_asset.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["group_id"], ["studio_asset_group.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("sha256"),
        sa.UniqueConstraint("storage_key"),
    )
    for name in (
        "created_at",
        "group_id",
        "kind",
        "parent_id",
        "sha256",
        "source_task_id",
        "status",
    ):
        op.create_index(
            op.f(f"ix_studio_media_asset_{name}"),
            "studio_media_asset",
            [name],
            unique=False,
        )


def downgrade() -> None:
    for name in reversed((
        "created_at",
        "group_id",
        "kind",
        "parent_id",
        "sha256",
        "source_task_id",
        "status",
    )):
        op.drop_index(
            op.f(f"ix_studio_media_asset_{name}"),
            table_name="studio_media_asset",
        )
    op.drop_table("studio_media_asset")

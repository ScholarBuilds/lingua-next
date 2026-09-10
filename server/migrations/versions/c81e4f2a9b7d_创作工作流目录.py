"""创作工作流目录

Revision ID: c81e4f2a9b7d
Revises: a6b9f4e2c1d0
Create Date: 2026-08-20 15:40:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c81e4f2a9b7d"
down_revision: str | None = "a6b9f4e2c1d0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


JSONB = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.create_table(
        "studio_workflow",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("key", sa.String(length=160), nullable=False),
        sa.Column("title", sa.String(length=160), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("source", sa.String(length=24), nullable=False),
        sa.Column("source_id", sa.String(length=255), nullable=True),
        sa.Column("payload", JSONB, nullable=False),
        sa.Column("ui_schema", JSONB, nullable=True),
        sa.Column("thumbnail_key", sa.String(length=512), nullable=True),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("key"),
    )
    for name in ("enabled", "kind", "provider", "source"):
        op.create_index(
            op.f(f"ix_studio_workflow_{name}"),
            "studio_workflow",
            [name],
            unique=False,
        )


def downgrade() -> None:
    for name in reversed(("enabled", "kind", "provider", "source")):
        op.drop_index(op.f(f"ix_studio_workflow_{name}"), table_name="studio_workflow")
    op.drop_table("studio_workflow")

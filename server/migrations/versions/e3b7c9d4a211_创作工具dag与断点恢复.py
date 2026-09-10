"""创作工具 DAG 与断点恢复

Revision ID: e3b7c9d4a211
Revises: d8a43f2c190b
Create Date: 2026-08-21 18:10:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e3b7c9d4a211"
down_revision: str | None = "d8a43f2c190b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSONB = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.create_table(
        "studio_flow",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=160), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("definition", JSONB, nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
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
    )
    op.create_index(
        op.f("ix_studio_flow_enabled"), "studio_flow", ["enabled"], unique=False
    )

    op.create_table(
        "studio_flow_run",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("flow_id", sa.Integer(), nullable=True),
        sa.Column("parent_run_id", sa.String(length=36), nullable=True),
        sa.Column("flow_version", sa.Integer(), nullable=False),
        sa.Column("definition_snapshot", JSONB, nullable=False),
        sa.Column("inputs", JSONB, nullable=False),
        sa.Column("source_context", JSONB, nullable=True),
        sa.Column("checkpoint", JSONB, nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["flow_id"], ["studio_flow.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["parent_run_id"], ["studio_flow_run.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    for name in ("created_at", "flow_id", "parent_run_id", "status"):
        op.create_index(
            op.f(f"ix_studio_flow_run_{name}"),
            "studio_flow_run",
            [name],
            unique=False,
        )


def downgrade() -> None:
    for name in reversed(("created_at", "flow_id", "parent_run_id", "status")):
        op.drop_index(op.f(f"ix_studio_flow_run_{name}"), table_name="studio_flow_run")
    op.drop_table("studio_flow_run")
    op.drop_index(op.f("ix_studio_flow_enabled"), table_name="studio_flow")
    op.drop_table("studio_flow")

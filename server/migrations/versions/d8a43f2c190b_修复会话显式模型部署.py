"""修复会话显式模型部署

Revision ID: d8a43f2c190b
Revises: c2d91f7a630b
Create Date: 2026-08-21 16:35:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d8a43f2c190b"
down_revision: str | None = "c2d91f7a630b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "repair_session",
        sa.Column("model_deployment_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_repair_session_model_deployment_id_model_deployment",
        "repair_session",
        "model_deployment",
        ["model_deployment_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        op.f("ix_repair_session_model_deployment_id"),
        "repair_session",
        ["model_deployment_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_repair_session_model_deployment_id"),
        table_name="repair_session",
    )
    op.drop_constraint(
        "fk_repair_session_model_deployment_id_model_deployment",
        "repair_session",
        type_="foreignkey",
    )
    op.drop_column("repair_session", "model_deployment_id")

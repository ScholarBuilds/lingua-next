"""凭据访问台账（CR-007 模块 19）

Revision ID: e7a1b2c3d4f5
Revises: d3f1a7c2e9b4
Create Date: 2026-09-02 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e7a1b2c3d4f5"
down_revision: str | None = "d3f1a7c2e9b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "credential_access",
        sa.Column("id", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), autoincrement=True, nullable=False),
        sa.Column("credential_id", sa.Integer(), nullable=True),
        sa.Column("credential_name", sa.String(length=128), nullable=False),
        sa.Column("mode", sa.String(length=16), nullable=False),
        sa.Column("field", sa.String(length=64), nullable=True),
        sa.Column("purpose", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["credential_id"], ["provider_credential.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_credential_access_credential_id"), "credential_access", ["credential_id"])
    op.create_index(op.f("ix_credential_access_created_at"), "credential_access", ["created_at"])


def downgrade() -> None:
    op.drop_index(op.f("ix_credential_access_created_at"), table_name="credential_access")
    op.drop_index(op.f("ix_credential_access_credential_id"), table_name="credential_access")
    op.drop_table("credential_access")

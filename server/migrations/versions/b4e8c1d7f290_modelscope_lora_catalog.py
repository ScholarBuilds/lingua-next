"""ModelScope LoRA 可复用目录

Revision ID: b4e8c1d7f290
Revises: a2c4e6f8b0d1
Create Date: 2026-08-22 12:30:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b4e8c1d7f290"
down_revision: str | None = "a2c4e6f8b0d1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "modelscope_lora",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("credential_id", sa.Integer(), nullable=False),
        sa.Column("lora_id", sa.String(length=255), nullable=False),
        sa.Column("display_name", sa.String(length=160), nullable=True),
        sa.Column("target_model", sa.String(length=255), nullable=False),
        sa.Column("default_strength", sa.Float(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("note", sa.String(length=300), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["credential_id"],
            ["provider_credential.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "credential_id",
            "target_model",
            "lora_id",
            name="uq_modelscope_lora_target",
        ),
    )
    op.create_index(
        op.f("ix_modelscope_lora_credential_id"),
        "modelscope_lora",
        ["credential_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_modelscope_lora_target_model"),
        "modelscope_lora",
        ["target_model"],
        unique=False,
    )
    op.create_index(
        op.f("ix_modelscope_lora_enabled"),
        "modelscope_lora",
        ["enabled"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_modelscope_lora_enabled"), table_name="modelscope_lora")
    op.drop_index(op.f("ix_modelscope_lora_target_model"), table_name="modelscope_lora")
    op.drop_index(op.f("ix_modelscope_lora_credential_id"), table_name="modelscope_lora")
    op.drop_table("modelscope_lora")

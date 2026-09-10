"""讲义划词批注

新表 `grammar_doc_annotation`：讲义仍是磁盘上的 .md，只有批注进库。
锚点存的是「选区文本 + 前后各 32 字符」而不是纯偏移——讲义允许 AI 改写后写回，
偏移会整体错位，落点由读取时按当前正文现算（app/routers/grammar_docs.relocate）。

Revision ID: 666b61f47e6a
Revises: f2a9c47b1d63
Create Date: 2026-08-24
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "666b61f47e6a"
down_revision: str | None = "f2a9c47b1d63"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSONB = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.create_table(
        "grammar_doc_annotation",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("doc_path", sa.String(length=400), nullable=False),
        sa.Column("quote", sa.Text(), nullable=False),
        sa.Column("prefix", sa.Text(), nullable=False),
        sa.Column("suffix", sa.Text(), nullable=False),
        sa.Column("start_hint", sa.Integer(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("color", sa.String(length=16), nullable=False),
        sa.Column("ai_kind", sa.String(length=16), nullable=True),
        sa.Column("ai_result", JSONB, nullable=True),
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
        op.f("ix_grammar_doc_annotation_doc_path"),
        "grammar_doc_annotation",
        ["doc_path"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_grammar_doc_annotation_doc_path"), table_name="grammar_doc_annotation"
    )
    op.drop_table("grammar_doc_annotation")

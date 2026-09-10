"""按词的场景归属与虚拟本封面

新表 `word_scene`：考纲本按场景学所需的素材（场景归属 + AI 例句），**按词**存。
八本考纲词次合计 38,855，去重后只有 14,942（重叠率 62%），按本存等于同一句例句
生成存储六遍还会不一致；按词存之后考纲本继续保持虚拟，读取时 LEFT JOIN 即可。

新表 `deck_cover`：按 deck key 寻址的封面（FR-420a）。生词本与八个考纲本没有
wordlist 行，`wordlist.cover_key` 那条路走不通，这里按 key 存，真实本不动。

Revision ID: a1c9e3f7b204
Revises: 666b61f47e6a
Create Date: 2026-08-25
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a1c9e3f7b204"
down_revision: str | None = "666b61f47e6a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "word_scene",
        sa.Column("word", sa.String(length=128), nullable=False),
        sa.Column("scene", sa.String(length=48), nullable=False),
        sa.Column("track", sa.String(length=8), nullable=False),
        sa.Column("root", sa.String(length=32), nullable=True),
        sa.Column("example_en", sa.Text(), nullable=True),
        sa.Column("example_zh", sa.Text(), nullable=True),
        sa.Column("model", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.PrimaryKeyConstraint("word"),
    )
    # 按场景取词是主查询（学习时「这个场景里有哪些词」），必须走索引
    op.create_index("ix_word_scene_scene", "word_scene", ["scene"])

    op.create_table(
        "deck_cover",
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("storage_key", sa.String(length=512), nullable=False),
        sa.Column("asset_id", sa.Integer(), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.PrimaryKeyConstraint("key"),
    )


def downgrade() -> None:
    op.drop_table("deck_cover")
    op.drop_index("ix_word_scene_scene", table_name="word_scene")
    op.drop_table("word_scene")

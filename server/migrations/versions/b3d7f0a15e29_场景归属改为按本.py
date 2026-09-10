"""场景归属改为按本

新表 `deck_scene`（主键 deck+word）：某一本里某个词归哪个场景。
`word_scene` 只留例句（词的属性，跨本共用一句）。

原因：把场景做成按词的全局属性，等于让第一本冻结分法、又被后面的大本打碎。
实测中考跑完是 30 组 / 中位 60 词，八本跑完变成 143 组 / 中位 6 词，
只有 30/143 还在 18~95 区间；`family` 词根轨全库 0 个（后面的本沿用已有表，
从没机会提自己的词根族，GRE 也没有）。
「一本分成多少组」是本的属性，不是词的属性。

旧数据搬过去当种子（八本各自按 tag 取自己的词），随后按本重跑分类覆盖。

Revision ID: b3d7f0a15e29
Revises: a1c9e3f7b204
Create Date: 2026-08-25
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b3d7f0a15e29"
down_revision: str | None = "a1c9e3f7b204"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TAGS = ("zk", "gk", "cet4", "cet6", "ky", "toefl", "ielts", "gre")


def upgrade() -> None:
    op.create_table(
        "deck_scene",
        sa.Column("deck", sa.String(length=32), nullable=False),
        sa.Column("word", sa.String(length=128), nullable=False),
        sa.Column("scene", sa.String(length=48), nullable=False),
        sa.Column("track", sa.String(length=8), nullable=False),
        sa.Column("root", sa.String(length=32), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.PrimaryKeyConstraint("deck", "word"),
    )
    op.create_index("ix_deck_scene_scene", "deck_scene", ["deck", "scene"])

    # 旧的全局归属搬过去，八本各按 tag 取自己的词——重跑分类前先有个能用的种子
    for tag in TAGS:
        op.execute(
            f"""
            INSERT INTO deck_scene (deck, word, scene, track, root)
            SELECT '{tag}', w.word, w.scene, w.track, w.root
            FROM word_scene w JOIN dict_entry d ON d.word = w.word
            WHERE w.scene IS NOT NULL AND d.tag ~ '(^| ){tag}( |$)'
            ON CONFLICT DO NOTHING
            """
        )

    op.drop_index("ix_word_scene_scene", table_name="word_scene")
    op.drop_column("word_scene", "scene")
    op.drop_column("word_scene", "track")
    op.drop_column("word_scene", "root")


def downgrade() -> None:
    op.add_column("word_scene", sa.Column("root", sa.String(length=32), nullable=True))
    op.add_column("word_scene", sa.Column("track", sa.String(length=8), nullable=True))
    op.add_column("word_scene", sa.Column("scene", sa.String(length=48), nullable=True))
    op.create_index("ix_word_scene_scene", "word_scene", ["scene"])
    op.execute(
        """
        UPDATE word_scene w SET scene = s.scene, track = s.track, root = s.root
        FROM deck_scene s WHERE s.word = w.word
        """
    )
    op.drop_index("ix_deck_scene_scene", table_name="deck_scene")
    op.drop_table("deck_scene")

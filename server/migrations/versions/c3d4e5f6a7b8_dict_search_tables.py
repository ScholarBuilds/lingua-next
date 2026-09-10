"""查词侧表：联想 / 汉英反查 / 同义关系（FR-508~510）。

三张表都是 seed 脚本从 dict_entry 与 WordNet 算出来的导出物，不建外键，整表可重建。
`lc` / `gloss` 在 PostgreSQL 上用 COLLATE "C"，前缀范围谓词才能走 btree。
"""

import sqlalchemy as sa
from alembic import op

revision = "c3d4e5f6a7b8"
down_revision = "b2c3d4e5f6a7"
branch_labels = None
depends_on = None

_LC = sa.String(160).with_variant(sa.String(160, collation="C"), "postgresql")
_GLOSS = sa.String(64).with_variant(sa.String(64, collation="C"), "postgresql")


def upgrade():
    op.create_table(
        "dict_head",
        sa.Column("word", sa.String(128), primary_key=True),
        sa.Column("lc", _LC, nullable=False),
        sa.Column("tier", sa.SmallInteger(), nullable=False),
        sa.Column("frq_rank", sa.Integer(), nullable=True),
        sa.Column("lemma", sa.String(128), nullable=True),
        sa.Column("proper", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("brief", sa.String(24), nullable=True),
        sa.Column("tags", sa.String(64), nullable=True),
        sa.Column("phonetic", sa.String(64), nullable=True),
    )
    op.create_index("ix_dict_head_lc", "dict_head", ["lc"])
    op.create_index("ix_dict_head_tier_frq", "dict_head", ["tier", "frq_rank"])

    op.create_table(
        "dict_gloss",
        sa.Column("gloss", _GLOSS, primary_key=True),
        sa.Column("word", sa.String(128), primary_key=True),
        sa.Column("tier", sa.SmallInteger(), nullable=False),
        sa.Column("sense_idx", sa.SmallInteger(), nullable=False),
        sa.Column("pos", sa.String(8), nullable=True),
        sa.Column("frq_rank", sa.Integer(), nullable=True),
    )
    op.create_index("ix_dict_gloss_gloss", "dict_gloss", ["gloss"])

    op.create_table(
        "dict_related",
        sa.Column("word", sa.String(128), primary_key=True),
        sa.Column("kind", sa.String(8), primary_key=True),
        sa.Column("related", sa.String(128), primary_key=True),
        sa.Column("rank", sa.SmallInteger(), nullable=False),
    )
    op.create_index("ix_dict_related_word", "dict_related", ["word", "kind", "rank"])


def downgrade():
    op.drop_index("ix_dict_related_word", table_name="dict_related")
    op.drop_table("dict_related")
    op.drop_index("ix_dict_gloss_gloss", table_name="dict_gloss")
    op.drop_table("dict_gloss")
    op.drop_index("ix_dict_head_tier_frq", table_name="dict_head")
    op.drop_index("ix_dict_head_lc", table_name="dict_head")
    op.drop_table("dict_head")

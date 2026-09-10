"""中文反查的学习者层覆盖索引。"""

from alembic import op

revision = "d0e1f2a3b4c5"
down_revision = "c9d0e1f2a3b4"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index("ix_dict_gloss_learner_cover", "dict_gloss", ["tier", "sense_idx", "frq_rank", "gloss", "word", "pos"])


def downgrade():
    op.drop_index("ix_dict_gloss_learner_cover", table_name="dict_gloss")

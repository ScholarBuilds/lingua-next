"""中文反查的学习者层覆盖索引。"""

from alembic import op
from sqlalchemy import inspect

revision = "d0e1f2a3b4c5"
down_revision = "c9d0e1f2a3b4"
branch_labels = None
depends_on = None


def upgrade():
    columns = ["tier", "sense_idx", "frq_rank", "gloss", "word", "pos"]
    # Desktop baselines can already contain the current model's index while
    # carrying an older revision stamp. Verify its definition before reusing it.
    existing = next(
        (
            index
            for index in inspect(op.get_bind()).get_indexes("dict_gloss")
            if index["name"] == "ix_dict_gloss_learner_cover"
        ),
        None,
    )
    if existing is not None:
        if existing["column_names"] != columns or existing.get("unique"):
            raise RuntimeError("Existing dictionary covering index has an unexpected definition")
        return
    op.create_index("ix_dict_gloss_learner_cover", "dict_gloss", columns)


def downgrade():
    op.drop_index("ix_dict_gloss_learner_cover", table_name="dict_gloss")

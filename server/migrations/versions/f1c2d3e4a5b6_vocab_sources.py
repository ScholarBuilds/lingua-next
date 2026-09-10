"""生词来源与幂等收藏。"""

import sqlalchemy as sa
from alembic import op

revision = "f1c2d3e4a5b6"
down_revision = "f0a1b2c3d4e5"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "vocab_occurrence",
        sa.Column("source_kind", sa.String(16), server_default="manual", nullable=False),
    )
    op.add_column("vocab_occurrence", sa.Column("source_label", sa.String(160)))
    op.add_column(
        "vocab_occurrence",
        sa.Column("source_locator", sa.JSON(), server_default="{}", nullable=False),
    )
    op.add_column("vocab_occurrence", sa.Column("source_fingerprint", sa.String(64)))
    op.execute(
        "UPDATE vocab_occurrence SET source_kind = CASE "
        "WHEN video_id IS NOT NULL THEN 'video' "
        "WHEN article_id IS NOT NULL THEN 'reader' ELSE 'manual' END"
    )
    op.execute(
        "UPDATE vocab_occurrence "
        "SET source_fingerprint = 'legacy:' || CAST(id AS VARCHAR)"
    )
    with op.batch_alter_table("vocab_occurrence") as batch:
        batch.alter_column("source_fingerprint", existing_type=sa.String(64), nullable=False)
        batch.create_unique_constraint(
            "uq_vocab_occurrence_source", ["vocab_id", "source_fingerprint"]
        )


def downgrade():
    with op.batch_alter_table("vocab_occurrence") as batch:
        batch.drop_constraint("uq_vocab_occurrence_source", type_="unique")
        batch.drop_column("source_fingerprint")
        batch.drop_column("source_locator")
        batch.drop_column("source_label")
        batch.drop_column("source_kind")

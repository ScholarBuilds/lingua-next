"""场景条目的个人笔记与并发版本。"""

import sqlalchemy as sa
from alembic import op

revision = "a7b8c9d0e1f2"
down_revision = "f6a7b8c9d0e1"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "scene_study_note",
        sa.Column("user_id", sa.String(36), primary_key=True),
        sa.Column("entry_key", sa.String(160), primary_key=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
    )


def downgrade():
    op.drop_table("scene_study_note")

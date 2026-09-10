"""学习提交回执与场景版本。"""

import sqlalchemy as sa
from alembic import op

revision = "d4e5f6a7b8c9"
down_revision = "c3d4e5f6a7b8"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "deck_scene_state", sa.Column("version", sa.Integer(), nullable=False, server_default="0")
    )
    op.add_column("deck_scene_state", sa.Column("run_id", sa.String(36)))
    op.create_table(
        "learning_receipt",
        sa.Column("user_id", sa.String(36), primary_key=True),
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("scope", sa.String(256), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("response", sa.JSON(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )


def downgrade():
    op.drop_table("learning_receipt")
    op.drop_column("deck_scene_state", "run_id")
    op.drop_column("deck_scene_state", "version")

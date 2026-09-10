"""按词钉死的发音音色。"""

import sqlalchemy as sa
from alembic import op

revision = "a1b2c3d4e5f6"
down_revision = "f2d3e4f5a6b7"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "word_voice",
        sa.Column("word", sa.String(64), primary_key=True),
        sa.Column("voice", sa.String(128), nullable=False),
        sa.Column("rate", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )


def downgrade():
    op.drop_table("word_voice")
